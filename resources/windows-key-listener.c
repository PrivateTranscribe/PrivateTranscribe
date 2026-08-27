/**
 * Windows Key + Mouse Listener for Push-to-Talk
 *
 * Uses Windows Low-Level Keyboard/Mouse Hooks to detect key/button up/down events.
 * Accepts a compound hotkey string as command line argument.
 * Examples:
 *   `
 *   F8
 *   CommandOrControl+F11
 *   Mouse4
 *   Mouse5
 *   Ctrl+Mouse4
 *
 * Outputs to stdout:
 *   READY
 *   KEY_DOWN
 *   KEY_UP
 *
 * Test seam:
 *   windows-key-listener.exe --simulate "CommandOrControl+Space"
 * installs no hooks and never reads the real keyboard. It prints READY and then
 * replays scripted events from stdin (`DOWN <key> <timeMs>` / `UP <key> <timeMs>`,
 * `QUIT` or EOF to stop) through the exact same decision function the live hook
 * uses, so tests exercise the compiled logic without touching the user's machine.
 *
 * Compile with (MSVC):
 *   cl /O2 windows-key-listener.c /Fe:windows-key-listener.exe user32.lib
 * Or with MinGW:
 *   gcc -O2 windows-key-listener.c -o windows-key-listener.exe -luser32
 */

#define _CRT_SECURE_NO_WARNINGS
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static HHOOK g_keyboardHook = NULL;
static HHOOK g_mouseHook = NULL;

static DWORD g_targetVk = 0;
static BOOL g_isDown = FALSE;

// Mouse targets
static BOOL g_isMouseButton = FALSE;
static DWORD g_targetXButton = 0; // 1 = XBUTTON1 (Mouse4), 2 = XBUTTON2 (Mouse5)

// Modifier requirements
static BOOL g_requireCtrl = FALSE;
static BOOL g_requireAlt = FALSE;
static BOOL g_requireShift = FALSE;
static BOOL g_requireWin = FALSE;

// Simulate mode: driven from stdin, no hooks installed, real keyboard never read.
static BOOL g_simulateMode = FALSE;

/*
 * How long after the trigger key goes down a required modifier may still arrive
 * and count as "pressed together".
 *
 * A human aiming for Ctrl+Space does not hit both keys on the same millisecond;
 * either one can land first, typically within a few tens of milliseconds. Without
 * this window the press is simply dropped whenever the trigger wins the race.
 *
 * The window is bounded on purpose: holding the bare trigger key for a while and
 * only then reaching for the modifier is a different intent (the user was typing)
 * and must NOT fire the hotkey.
 */
#define MODIFIER_GRACE_MS 150

// Physical key state rebuilt from the hook's own event stream. GetAsyncKeyState is
// sampled at the instant an event is processed and can lag a simultaneous press,
// which is exactly the race this listener has to survive.
static BOOL g_triggerPhysDown = FALSE;
static DWORD g_triggerDownTime = 0;

// One flag per modifier family. Low-level hooks deliver the side-specific VKs
// (VK_LCONTROL / VK_RCONTROL, ...), so any variant going down sets the family and
// any variant going up clears it - matching the existing modifier-release logic,
// which already treats a release of either side as ending the press.
static BOOL g_ctrlPhysDown = FALSE;
static BOOL g_altPhysDown = FALSE;
static BOOL g_shiftPhysDown = FALSE;
static BOOL g_winPhysDown = FALSE;

// Tracked state OR a live sample. The live sample covers modifiers already held
// before the hook was installed; in simulate mode it must never be consulted.
static BOOL IsModifierHeld(BOOL tracked, int vkPrimary, int vkSecondary) {
    if (tracked) return TRUE;
    if (g_simulateMode) return FALSE;
    if (GetAsyncKeyState(vkPrimary) & 0x8000) return TRUE;
    if (vkSecondary && (GetAsyncKeyState(vkSecondary) & 0x8000)) return TRUE;
    return FALSE;
}

static BOOL AreModifiersPressed(void) {
    if (g_requireCtrl && !IsModifierHeld(g_ctrlPhysDown, VK_CONTROL, 0)) return FALSE;
    if (g_requireAlt && !IsModifierHeld(g_altPhysDown, VK_MENU, 0)) return FALSE;
    if (g_requireShift && !IsModifierHeld(g_shiftPhysDown, VK_SHIFT, 0)) return FALSE;
    if (g_requireWin && !IsModifierHeld(g_winPhysDown, VK_LWIN, VK_RWIN)) return FALSE;
    return TRUE;
}

static BOOL IsCtrlVk(DWORD vk) {
    return vk == VK_CONTROL || vk == VK_LCONTROL || vk == VK_RCONTROL;
}

static BOOL IsAltVk(DWORD vk) {
    return vk == VK_MENU || vk == VK_LMENU || vk == VK_RMENU;
}

static BOOL IsShiftVk(DWORD vk) {
    return vk == VK_SHIFT || vk == VK_LSHIFT || vk == VK_RSHIFT;
}

static BOOL IsWinVk(DWORD vk) {
    return vk == VK_LWIN || vk == VK_RWIN;
}

// Update the tracked physical modifier state from every keyboard event, whether or
// not the modifier is part of the configured hotkey. Cheap, and it keeps the
// picture complete when the hotkey changes shape.
static void TrackModifierState(DWORD vk, BOOL isKeyDown) {
    if (IsCtrlVk(vk)) g_ctrlPhysDown = isKeyDown;
    else if (IsAltVk(vk)) g_altPhysDown = isKeyDown;
    else if (IsShiftVk(vk)) g_shiftPhysDown = isKeyDown;
    else if (IsWinVk(vk)) g_winPhysDown = isKeyDown;
}

static BOOL IsRequiredModifierVk(DWORD vk) {
    if (g_requireCtrl && IsCtrlVk(vk)) return TRUE;
    if (g_requireAlt && IsAltVk(vk)) return TRUE;
    if (g_requireShift && IsShiftVk(vk)) return TRUE;
    if (g_requireWin && IsWinVk(vk)) return TRUE;
    return FALSE;
}

static void EmitDown(void) {
    if (!g_isDown) {
        g_isDown = TRUE;
        printf("KEY_DOWN\n");
        fflush(stdout);
    }
}

static void EmitUp(void) {
    if (g_isDown) {
        g_isDown = FALSE;
        printf("KEY_UP\n");
        fflush(stdout);
    }
}

// Returns VK code; may also set g_isMouseButton for Mouse4/Mouse5.
static DWORD ParseKeyCode(const char* keyName) {
    // Mouse buttons (side buttons)
    if (_stricmp(keyName, "Mouse4") == 0 || _stricmp(keyName, "XButton1") == 0) {
        g_isMouseButton = TRUE;
        g_targetXButton = XBUTTON1;
        return 0;
    }
    if (_stricmp(keyName, "Mouse5") == 0 || _stricmp(keyName, "XButton2") == 0) {
        g_isMouseButton = TRUE;
        g_targetXButton = XBUTTON2;
        return 0;
    }

    // Function keys (F1-F12)
    if (_stricmp(keyName, "F1") == 0) return VK_F1;
    if (_stricmp(keyName, "F2") == 0) return VK_F2;
    if (_stricmp(keyName, "F3") == 0) return VK_F3;
    if (_stricmp(keyName, "F4") == 0) return VK_F4;
    if (_stricmp(keyName, "F5") == 0) return VK_F5;
    if (_stricmp(keyName, "F6") == 0) return VK_F6;
    if (_stricmp(keyName, "F7") == 0) return VK_F7;
    if (_stricmp(keyName, "F8") == 0) return VK_F8;
    if (_stricmp(keyName, "F9") == 0) return VK_F9;
    if (_stricmp(keyName, "F10") == 0) return VK_F10;
    if (_stricmp(keyName, "F11") == 0) return VK_F11;
    if (_stricmp(keyName, "F12") == 0) return VK_F12;

    // Extended function keys (F13-F24)
    if (_stricmp(keyName, "F13") == 0) return VK_F13;
    if (_stricmp(keyName, "F14") == 0) return VK_F14;
    if (_stricmp(keyName, "F15") == 0) return VK_F15;
    if (_stricmp(keyName, "F16") == 0) return VK_F16;
    if (_stricmp(keyName, "F17") == 0) return VK_F17;
    if (_stricmp(keyName, "F18") == 0) return VK_F18;
    if (_stricmp(keyName, "F19") == 0) return VK_F19;
    if (_stricmp(keyName, "F20") == 0) return VK_F20;
    if (_stricmp(keyName, "F21") == 0) return VK_F21;
    if (_stricmp(keyName, "F22") == 0) return VK_F22;
    if (_stricmp(keyName, "F23") == 0) return VK_F23;
    if (_stricmp(keyName, "F24") == 0) return VK_F24;

    // Special keys
    if (_stricmp(keyName, "Pause") == 0) return VK_PAUSE;
    if (_stricmp(keyName, "ScrollLock") == 0) return VK_SCROLL;
    if (_stricmp(keyName, "Insert") == 0) return VK_INSERT;
    if (_stricmp(keyName, "Home") == 0) return VK_HOME;
    if (_stricmp(keyName, "End") == 0) return VK_END;
    if (_stricmp(keyName, "PageUp") == 0) return VK_PRIOR;
    if (_stricmp(keyName, "PageDown") == 0) return VK_NEXT;
    if (_stricmp(keyName, "Space") == 0) return VK_SPACE;
    if (_stricmp(keyName, "Escape") == 0 || _stricmp(keyName, "Esc") == 0) return VK_ESCAPE;
    if (_stricmp(keyName, "Tab") == 0) return VK_TAB;
    if (_stricmp(keyName, "CapsLock") == 0) return VK_CAPITAL;
    if (_stricmp(keyName, "NumLock") == 0) return VK_NUMLOCK;

    // Backtick/tilde - default hotkey
    if (strcmp(keyName, "`") == 0 || _stricmp(keyName, "Backquote") == 0) return VK_OEM_3;

    // Punctuation
    if (strcmp(keyName, "-") == 0 || _stricmp(keyName, "Minus") == 0) return VK_OEM_MINUS;
    if (strcmp(keyName, "=") == 0 || _stricmp(keyName, "Equal") == 0) return VK_OEM_PLUS;
    if (strcmp(keyName, "[") == 0) return VK_OEM_4;
    if (strcmp(keyName, "]") == 0) return VK_OEM_6;
    if (strcmp(keyName, "\\") == 0) return VK_OEM_5;
    if (strcmp(keyName, ";") == 0) return VK_OEM_1;
    if (strcmp(keyName, "'") == 0) return VK_OEM_7;
    if (strcmp(keyName, ",") == 0) return VK_OEM_COMMA;
    if (strcmp(keyName, ".") == 0) return VK_OEM_PERIOD;
    if (strcmp(keyName, "/") == 0) return VK_OEM_2;

    // Single letter/number
    if (strlen(keyName) == 1) {
        char c = keyName[0];
        if (c >= 'a' && c <= 'z') return (DWORD)(c - 'a' + 'A');
        if (c >= 'A' && c <= 'Z') return (DWORD)c;
        if (c >= '0' && c <= '9') return (DWORD)c;
    }

    // Hex or decimal VK code
    if (keyName[0] == '0' && (keyName[1] == 'x' || keyName[1] == 'X')) {
        return (DWORD)strtol(keyName, NULL, 16);
    }

    return (DWORD)atoi(keyName);
}

static DWORD ParseCompoundHotkey(const char* hotkey) {
    char buffer[256];
    strncpy(buffer, hotkey, sizeof(buffer) - 1);
    buffer[sizeof(buffer) - 1] = '\0';

    // Reset
    g_requireCtrl = FALSE;
    g_requireAlt = FALSE;
    g_requireShift = FALSE;
    g_requireWin = FALSE;
    g_isMouseButton = FALSE;
    g_targetXButton = 0;

    DWORD mainKeyVk = 0;
    char* token = strtok(buffer, "+");

    while (token != NULL) {
        while (*token == ' ') token++;
        char* end = token + strlen(token) - 1;
        while (end > token && *end == ' ') *end-- = '\0';

        if (_stricmp(token, "CommandOrControl") == 0 ||
            _stricmp(token, "Control") == 0 ||
            _stricmp(token, "Ctrl") == 0 ||
            _stricmp(token, "CmdOrCtrl") == 0) {
            g_requireCtrl = TRUE;
        } else if (_stricmp(token, "Alt") == 0 || _stricmp(token, "Option") == 0) {
            g_requireAlt = TRUE;
        } else if (_stricmp(token, "Shift") == 0) {
            g_requireShift = TRUE;
        } else if (_stricmp(token, "Super") == 0 ||
                   _stricmp(token, "Meta") == 0 ||
                   _stricmp(token, "Win") == 0 ||
                   _stricmp(token, "Command") == 0 ||
                   _stricmp(token, "Cmd") == 0) {
            // Windows key (VK_LWIN/VK_RWIN)
            g_requireWin = TRUE;
        } else {
            mainKeyVk = ParseKeyCode(token);
        }

        token = strtok(NULL, "+");
    }

    return mainKeyVk;
}

/*
 * The whole keyboard decision, in one place. The live hook and the --simulate
 * loop both call this, so a test drives the exact compiled logic.
 *
 * timeMs is the event timestamp (KBDLLHOOKSTRUCT::time), milliseconds since boot.
 */
static void HandleKeyboardEvent(DWORD vkCode, BOOL isKeyDown, DWORD timeMs) {
    TrackModifierState(vkCode, isKeyDown);

    // If a required modifier was released while we're held down, emit up.
    if (g_isDown && !isKeyDown && IsRequiredModifierVk(vkCode)) {
        EmitUp();
    }

    // The trigger key is handled first and exclusively: for a modifier-only combo
    // (e.g. Control+Super) the trigger VK is itself a modifier, and it must never
    // also be treated as "a required modifier arriving late".
    if (vkCode == g_targetVk) {
        if (isKeyDown) {
            // Low-level hooks deliver auto-repeat as plain repeated WM_KEYDOWN with
            // no repeat flag. Only the up->down transition starts the grace window;
            // repeats must not extend it.
            if (!g_triggerPhysDown) {
                g_triggerPhysDown = TRUE;
                g_triggerDownTime = timeMs;
            }
            if (AreModifiersPressed()) {
                EmitDown();
            }
        } else {
            g_triggerPhysDown = FALSE;
            EmitUp();
        }
        return;
    }

    // Re-arm: the trigger key already went down but the modifier had not registered
    // yet. Unsigned subtraction so the ~49.7 day wrap of the tick count is handled.
    if (isKeyDown && !g_isDown && g_triggerPhysDown && IsRequiredModifierVk(vkCode)) {
        if ((DWORD)(timeMs - g_triggerDownTime) <= MODIFIER_GRACE_MS && AreModifiersPressed()) {
            EmitDown();
        }
    }
}

static LRESULT CALLBACK LowLevelKeyboardProc(int nCode, WPARAM wParam, LPARAM lParam) {
    if (nCode == HC_ACTION && !g_isMouseButton) {
        KBDLLHOOKSTRUCT* kbd = (KBDLLHOOKSTRUCT*)lParam;
        BOOL isKeyDown = (wParam == WM_KEYDOWN || wParam == WM_SYSKEYDOWN);
        BOOL isKeyUp = (wParam == WM_KEYUP || wParam == WM_SYSKEYUP);

        if (isKeyDown || isKeyUp) {
            HandleKeyboardEvent(kbd->vkCode, isKeyDown, kbd->time);
        }
    }

    return CallNextHookEx(g_keyboardHook, nCode, wParam, lParam);
}

// Monitor keyboard events even when mouse button is the target - needed to detect modifier releases
static LRESULT CALLBACK LowLevelKeyboardProcForMouse(int nCode, WPARAM wParam, LPARAM lParam) {
    if (nCode == HC_ACTION && g_isMouseButton && g_isDown) {
        KBDLLHOOKSTRUCT* kbd = (KBDLLHOOKSTRUCT*)lParam;
        BOOL isKeyUp = (wParam == WM_KEYUP || wParam == WM_SYSKEYUP);

        if (isKeyUp) {
            BOOL modifierReleased = FALSE;
            if (g_requireCtrl && (kbd->vkCode == VK_CONTROL || kbd->vkCode == VK_LCONTROL || kbd->vkCode == VK_RCONTROL)) {
                modifierReleased = TRUE;
            }
            if (g_requireAlt && (kbd->vkCode == VK_MENU || kbd->vkCode == VK_LMENU || kbd->vkCode == VK_RMENU)) {
                modifierReleased = TRUE;
            }
            if (g_requireShift && (kbd->vkCode == VK_SHIFT || kbd->vkCode == VK_LSHIFT || kbd->vkCode == VK_RSHIFT)) {
                modifierReleased = TRUE;
            }
            if (modifierReleased) {
                EmitUp();
            }
        }
    }

    return CallNextHookEx(g_keyboardHook, nCode, wParam, lParam);
}

static LRESULT CALLBACK LowLevelMouseProc(int nCode, WPARAM wParam, LPARAM lParam) {
    if (nCode == HC_ACTION && g_isMouseButton) {
        MSLLHOOKSTRUCT* ms = (MSLLHOOKSTRUCT*)lParam;

        BOOL isButtonDown = FALSE;
        BOOL isButtonUp = FALSE;

        if (wParam == WM_XBUTTONDOWN) {
            WORD xbtn = HIWORD(ms->mouseData);
            if (xbtn == g_targetXButton) isButtonDown = TRUE;
        } else if (wParam == WM_XBUTTONUP) {
            WORD xbtn = HIWORD(ms->mouseData);
            if (xbtn == g_targetXButton) isButtonUp = TRUE;
        }

        if (isButtonDown) {
            if (AreModifiersPressed()) {
                EmitDown();
            }
        } else if (isButtonUp) {
            EmitUp();
        }
    }

    return CallNextHookEx(g_mouseHook, nCode, wParam, lParam);
}

// --- Simulate mode --------------------------------------------------------

static BOOL ParseNumber(const char* text, int base, long* out) {
    char* end = NULL;
    long value;
    if (*text == '\0') return FALSE;
    value = strtol(text, &end, base);
    if (end == text || *end != '\0') return FALSE;
    *out = value;
    return TRUE;
}

// Accepts the side-specific modifier names the tests script with, plus a raw VK
// code in hex (0xA2) or decimal.
static BOOL ParseSimulateKey(const char* name, DWORD* out) {
    long value = 0;

    if (_stricmp(name, "LCTRL") == 0) { *out = VK_LCONTROL; return TRUE; }
    if (_stricmp(name, "RCTRL") == 0) { *out = VK_RCONTROL; return TRUE; }
    if (_stricmp(name, "LSHIFT") == 0) { *out = VK_LSHIFT; return TRUE; }
    if (_stricmp(name, "RSHIFT") == 0) { *out = VK_RSHIFT; return TRUE; }
    if (_stricmp(name, "LALT") == 0) { *out = VK_LMENU; return TRUE; }
    if (_stricmp(name, "RALT") == 0) { *out = VK_RMENU; return TRUE; }
    if (_stricmp(name, "LWIN") == 0) { *out = VK_LWIN; return TRUE; }
    if (_stricmp(name, "RWIN") == 0) { *out = VK_RWIN; return TRUE; }
    if (_stricmp(name, "SPACE") == 0) { *out = VK_SPACE; return TRUE; }

    if (name[0] == '0' && (name[1] == 'x' || name[1] == 'X')) {
        if (!ParseNumber(name + 2, 16, &value)) return FALSE;
        *out = (DWORD)value;
        return TRUE;
    }

    if (!ParseNumber(name, 10, &value)) return FALSE;
    *out = (DWORD)value;
    return TRUE;
}

static int RunSimulateLoop(void) {
    char line[512];
    char original[512];

    printf("READY\n");
    fflush(stdout);

    while (fgets(line, sizeof(line), stdin) != NULL) {
        char* verb;
        char* keyToken;
        char* timeToken;
        BOOL isKeyDown;
        DWORD vkCode = 0;
        long timeMs = 0;
        size_t len = strlen(line);

        while (len > 0 && (line[len - 1] == '\n' || line[len - 1] == '\r' ||
                           line[len - 1] == ' ' || line[len - 1] == '\t')) {
            line[--len] = '\0';
        }
        if (len == 0) continue;

        strncpy(original, line, sizeof(original) - 1);
        original[sizeof(original) - 1] = '\0';

        if (_stricmp(line, "QUIT") == 0) break;

        verb = strtok(line, " \t");
        keyToken = strtok(NULL, " \t");
        timeToken = strtok(NULL, " \t");

        if (verb == NULL || keyToken == NULL || timeToken == NULL) {
            fprintf(stderr, "ERR %s\n", original);
            fflush(stderr);
            continue;
        }

        if (_stricmp(verb, "DOWN") == 0) {
            isKeyDown = TRUE;
        } else if (_stricmp(verb, "UP") == 0) {
            isKeyDown = FALSE;
        } else {
            fprintf(stderr, "ERR %s\n", original);
            fflush(stderr);
            continue;
        }

        if (!ParseSimulateKey(keyToken, &vkCode) || !ParseNumber(timeToken, 10, &timeMs)) {
            fprintf(stderr, "ERR %s\n", original);
            fflush(stderr);
            continue;
        }

        HandleKeyboardEvent(vkCode, isKeyDown, (DWORD)timeMs);
    }

    return 0;
}

static BOOL WINAPI ConsoleHandler(DWORD signal) {
    if (signal == CTRL_C_EVENT || signal == CTRL_BREAK_EVENT || signal == CTRL_CLOSE_EVENT) {
        if (g_keyboardHook) {
            UnhookWindowsHookEx(g_keyboardHook);
            g_keyboardHook = NULL;
        }
        if (g_mouseHook) {
            UnhookWindowsHookEx(g_mouseHook);
            g_mouseHook = NULL;
        }
        ExitProcess(0);
    }
    return TRUE;
}

int main(int argc, char* argv[]) {
    int hotkeyArg = 1;
    const char* hotkey;

    if (argc >= 2 && strcmp(argv[1], "--simulate") == 0) {
        g_simulateMode = TRUE;
        hotkeyArg = 2;
    }

    if (argc < hotkeyArg + 1) {
        fprintf(stderr, "Usage: %s [--simulate] <hotkey>\n", argv[0]);
        fprintf(stderr, "Examples:\n");
        fprintf(stderr, "  %s `                        (backtick)\n", argv[0]);
        fprintf(stderr, "  %s F8                       (function key F1-F12)\n", argv[0]);
        fprintf(stderr, "  %s F13                      (extended function key F13-F24)\n", argv[0]);
        fprintf(stderr, "  %s Mouse4                   (side button back)\n", argv[0]);
        fprintf(stderr, "  %s Mouse5                   (side button forward)\n", argv[0]);
        fprintf(stderr, "  %s CommandOrControl+F11     (with modifier)\n", argv[0]);
        fprintf(stderr, "  %s Ctrl+Mouse4              (modifier + mouse)\n", argv[0]);
        fprintf(stderr, "  %s --simulate Ctrl+Space    (stdin-driven test mode)\n", argv[0]);
        return 1;
    }

    hotkey = argv[hotkeyArg];
    g_targetVk = ParseCompoundHotkey(hotkey);

    if (!g_isMouseButton && g_targetVk == 0) {
        // Modifier-only combo (e.g. Control+Super): use the Win key as trigger
        // if Win is required, otherwise Ctrl, Alt, Shift in that order.
        if (g_requireWin) {
            g_targetVk = VK_LWIN;
            g_requireWin = FALSE; // Win key IS the trigger, not a modifier check
        } else if (g_requireCtrl) {
            g_targetVk = VK_CONTROL;
            g_requireCtrl = FALSE;
        } else if (g_requireAlt) {
            g_targetVk = VK_MENU;
            g_requireAlt = FALSE;
        } else if (g_requireShift) {
            g_targetVk = VK_SHIFT;
            g_requireShift = FALSE;
        } else {
            fprintf(stderr, "Error: Invalid hotkey '%s'\n", hotkey);
            return 1;
        }
    }

    fprintf(stderr, "Listening for: %s (mouse=%d, VK=0x%02X, Ctrl=%d, Alt=%d, Shift=%d, Win=%d)\n",
            hotkey, g_isMouseButton, g_targetVk, g_requireCtrl, g_requireAlt, g_requireShift, g_requireWin);

    // Simulate mode installs no hooks and never samples the real keyboard.
    if (g_simulateMode) {
        return RunSimulateLoop();
    }

    SetConsoleCtrlHandler(ConsoleHandler, TRUE);

    if (g_isMouseButton) {
        // Install mouse hook to monitor mouse button events
        g_mouseHook = SetWindowsHookEx(WH_MOUSE_LL, LowLevelMouseProc, NULL, 0);
        if (!g_mouseHook) {
            fprintf(stderr, "Error: Failed to install mouse hook (error %lu)\n", GetLastError());
            return 1;
        }

        // If modifiers are required, also install keyboard hook to monitor modifier releases.
        // Without this, compound mouse hotkeys like Ctrl+Mouse5 can get stuck recording if
        // the modifier is released before the mouse button.
        if (g_requireCtrl || g_requireAlt || g_requireShift) {
            g_keyboardHook = SetWindowsHookEx(WH_KEYBOARD_LL, LowLevelKeyboardProcForMouse, NULL, 0);
            if (!g_keyboardHook) {
                fprintf(stderr,
                        "Error: Failed to install keyboard hook for modifier monitoring (error %lu)\n",
                        GetLastError());
                UnhookWindowsHookEx(g_mouseHook);
                g_mouseHook = NULL;
                return 1;
            }
        }
    } else {
        g_keyboardHook = SetWindowsHookEx(WH_KEYBOARD_LL, LowLevelKeyboardProc, NULL, 0);
        if (!g_keyboardHook) {
            fprintf(stderr, "Error: Failed to install keyboard hook (error %lu)\n", GetLastError());
            return 1;
        }
    }

    printf("READY\n");
    fflush(stdout);

    MSG msg;
    while (GetMessage(&msg, NULL, 0, 0) > 0) {
        TranslateMessage(&msg);
        DispatchMessage(&msg);
    }

    if (g_keyboardHook) UnhookWindowsHookEx(g_keyboardHook);
    if (g_mouseHook) UnhookWindowsHookEx(g_mouseHook);
    return 0;
}
