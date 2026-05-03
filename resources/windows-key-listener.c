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
 * Compile with (MSVC):
 *   cl /O2 windows-key-listener.c /Fe:windows-key-listener.exe user32.lib
 * Or with MinGW:
 *   gcc -O2 windows-key-listener.c -o windows-key-listener.exe -luser32
 */

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

static BOOL AreModifiersPressed(void) {
    if (g_requireCtrl && !(GetAsyncKeyState(VK_CONTROL) & 0x8000)) return FALSE;
    if (g_requireAlt && !(GetAsyncKeyState(VK_MENU) & 0x8000)) return FALSE;
    if (g_requireShift && !(GetAsyncKeyState(VK_SHIFT) & 0x8000)) return FALSE;
    return TRUE;
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
                   _stricmp(token, "Command") == 0 ||
                   _stricmp(token, "Cmd") == 0) {
            // For our purposes, treat Win/Cmd as Ctrl on Windows
            g_requireCtrl = TRUE;
        } else {
            mainKeyVk = ParseKeyCode(token);
        }

        token = strtok(NULL, "+");
    }

    return mainKeyVk;
}

static LRESULT CALLBACK LowLevelKeyboardProc(int nCode, WPARAM wParam, LPARAM lParam) {
    if (nCode == HC_ACTION && !g_isMouseButton) {
        KBDLLHOOKSTRUCT* kbd = (KBDLLHOOKSTRUCT*)lParam;
        BOOL isKeyDown = (wParam == WM_KEYDOWN || wParam == WM_SYSKEYDOWN);
        BOOL isKeyUp = (wParam == WM_KEYUP || wParam == WM_SYSKEYUP);

        // If a required modifier was released while we're held down, emit up.
        if (g_isDown && isKeyUp) {
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

        if (kbd->vkCode == g_targetVk) {
            if (isKeyDown) {
                if (AreModifiersPressed()) {
                    EmitDown();
                }
            } else if (isKeyUp) {
                EmitUp();
            }
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
    if (argc < 2) {
        fprintf(stderr, "Usage: %s <hotkey>\n", argv[0]);
        fprintf(stderr, "Examples:\n");
        fprintf(stderr, "  %s `                        (backtick)\n", argv[0]);
        fprintf(stderr, "  %s F8                       (function key F1-F12)\n", argv[0]);
        fprintf(stderr, "  %s F13                      (extended function key F13-F24)\n", argv[0]);
        fprintf(stderr, "  %s Mouse4                   (side button back)\n", argv[0]);
        fprintf(stderr, "  %s Mouse5                   (side button forward)\n", argv[0]);
        fprintf(stderr, "  %s CommandOrControl+F11     (with modifier)\n", argv[0]);
        fprintf(stderr, "  %s Ctrl+Mouse4              (modifier + mouse)\n", argv[0]);
        return 1;
    }

    const char* hotkey = argv[1];
    g_targetVk = ParseCompoundHotkey(hotkey);

    if (!g_isMouseButton && g_targetVk == 0) {
        fprintf(stderr, "Error: Invalid hotkey '%s'\n", hotkey);
        return 1;
    }

    fprintf(stderr, "Listening for: %s (mouse=%d, VK=0x%02X, Ctrl=%d, Alt=%d, Shift=%d)\n",
            hotkey, g_isMouseButton, g_targetVk, g_requireCtrl, g_requireAlt, g_requireShift);

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
