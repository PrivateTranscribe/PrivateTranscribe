/**
 * Windows Key + Mouse Listener for Push-to-Talk
 *
 * Uses Windows Low-Level Keyboard/Mouse Hooks to detect key/button up/down events.
 * Accepts a compound hotkey string as command line argument.
 * Examples:
 *   `
 *   F8
 *   CommandOrControl+F11
 *   Control+Shift             (modifiers only: see HandleModifierOnlyEvent)
 *   Mouse4
 *   Mouse5
 *   Ctrl+Mouse4
 *
 * Outputs to stdout:
 *   READY
 *   KEY_DOWN
 *   KEY_UP
 *   KEY_CANCEL  the press that sent KEY_DOWN turned out to be part of another
 *               shortcut. Drop it if it has not started anything. KEY_UP still
 *               follows when the keys are released.
 *
 * Exit codes:
 *   0  stopped
 *   1  a hook could not be installed
 *   2  the hotkey names a key this listener does not know. It exits rather than
 *      watching nothing, so the app keeps its global shortcut as the fallback.
 *
 * Test seam:
 *   windows-key-listener.exe --simulate "CommandOrControl+Space"
 * installs no hooks and never reads the real keyboard. It prints READY and then
 * replays scripted events from stdin through the exact same decision functions
 * the live hook and timer use, so tests exercise the compiled logic without
 * touching the user's machine:
 *   DOWN <key> <timeMs> [scan=0x<code>]   a key event the hook sees
 *   UP <key> <timeMs> [scan=0x<code>]
 *   TICK <timeMs>                         time passes with no key event
 *   QUIT, or EOF                          stop
 * Simulate mode also keeps the key state GetAsyncKeyState would report, built
 * from the same events, so the live sample is tested without reading it.
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

// A hotkey of modifiers only, such as Control+Shift, has no trigger key.
static BOOL g_modifierOnly = FALSE;

// Simulate mode: driven from stdin, no hooks installed, real keyboard never read.
static BOOL g_simulateMode = FALSE;

// What GetAsyncKeyState would report in simulate mode, kept from the scripted events.
static BOOL g_simKeyDown[256];

#define EXIT_BAD_HOTKEY 2

/*
 * How long every modifier of a modifier-only hotkey must be held, with no other
 * key, before it sends KEY_DOWN.
 *
 * Control+Shift is also the start of Ctrl+Shift+T, Ctrl+Shift+Arrow and the
 * paste chord this app injects. Firing the moment the modifiers are down started
 * a recording, or toggled one, on every such shortcut. People reach the third key
 * of a shortcut well within this window. Releasing the modifiers sooner, with
 * nothing else pressed, is still a tap. The app adds its own 150 ms hold
 * threshold on top, and a key arriving in that time sends KEY_CANCEL, so a hold
 * starts recording 400 ms after the modifiers are down.
 */
#define MODIFIER_ONLY_START_DELAY_MS 250

// AltGr reaches the hook as a fake left Ctrl with this scan code, then right Alt.
// It is not Control: on a Nordic or German layout it types @ $ { [ ] } | and €.
#define ALTGR_FAKE_CTRL_SCAN 0x21D

// Modifier-only hotkey state. Pending: every modifier is down and the start delay
// is running. Spoiled: another key went down with them, so this press belongs to
// another shortcut and stays silent until its modifiers are released.
static BOOL g_chordPending = FALSE;
static DWORD g_chordStartTime = 0;
static BOOL g_chordSpoiled = FALSE;
static BOOL g_cancelSent = FALSE;
static UINT_PTR g_chordTimer = 0;

// AltGr's fake left Ctrl is down. The system counts it as held, so the live
// sample of left Ctrl means nothing while it is.
static BOOL g_altGrCtrlDown = FALSE;

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

// The system's key state now, as GetAsyncKeyState gives it. Simulate mode answers
// from the scripted events instead and never reads the real keyboard.
static BOOL IsKeyDownNow(int vk) {
    if (g_simulateMode) return vk > 0 && vk < 256 && g_simKeyDown[vk];
    return (GetAsyncKeyState(vk) & 0x8000) != 0;
}

// Tracked state OR a live sample. The live sample covers modifiers already held
// before the hook was installed.
static BOOL IsModifierHeld(BOOL tracked, int vkLeft, int vkRight) {
    if (tracked) return TRUE;
    return IsKeyDownNow(vkLeft) || IsKeyDownNow(vkRight);
}

static BOOL IsCtrlHeld(void) {
    if (g_ctrlPhysDown) return TRUE;
    if (IsKeyDownNow(VK_RCONTROL)) return TRUE;
    // Left Ctrl with right Alt is AltGr, also when it was down before the hook was.
    return IsKeyDownNow(VK_LCONTROL) && !g_altGrCtrlDown && !IsKeyDownNow(VK_RMENU);
}

static BOOL AreModifiersPressed(void) {
    if (g_requireCtrl && !IsCtrlHeld()) return FALSE;
    if (g_requireAlt && !IsModifierHeld(g_altPhysDown, VK_LMENU, VK_RMENU)) return FALSE;
    if (g_requireShift && !IsModifierHeld(g_shiftPhysDown, VK_LSHIFT, VK_RSHIFT)) return FALSE;
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

static BOOL IsAnyRequiredModifierHeld(void) {
    if (g_requireCtrl && IsCtrlHeld()) return TRUE;
    if (g_requireAlt && IsModifierHeld(g_altPhysDown, VK_LMENU, VK_RMENU)) return TRUE;
    if (g_requireShift && IsModifierHeld(g_shiftPhysDown, VK_LSHIFT, VK_RSHIFT)) return TRUE;
    if (g_requireWin && IsModifierHeld(g_winPhysDown, VK_LWIN, VK_RWIN)) return TRUE;
    return FALSE;
}

static void EmitDown(void) {
    if (!g_isDown) {
        g_isDown = TRUE;
        g_cancelSent = FALSE;
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

static void EmitCancel(void) {
    if (g_isDown && !g_cancelSent) {
        g_cancelSent = TRUE;
        printf("KEY_CANCEL\n");
        fflush(stdout);
    }
}

static void StopChordTimer(void) {
    g_chordPending = FALSE;
    if (g_chordTimer) {
        KillTimer(NULL, g_chordTimer);
        g_chordTimer = 0;
    }
}

static void FirePendingChord(void) {
    if (!g_chordPending) return;
    StopChordTimer();
    EmitDown();
}

// The live start delay. The timer runs on the hook thread's message loop, so it
// never races the hook.
static VOID CALLBACK ChordTimerProc(HWND hwnd, UINT msg, UINT_PTR id, DWORD time) {
    (void)hwnd;
    (void)msg;
    (void)id;
    (void)time;
    FirePendingChord();
}

static void StartChordTimer(DWORD timeMs) {
    g_chordPending = TRUE;
    g_chordStartTime = timeMs;
    if (!g_simulateMode) {
        g_chordTimer = SetTimer(NULL, 0, MODIFIER_ONLY_START_DELAY_MS, ChordTimerProc);
    }
}

// Fires a pending chord whose delay has run out by timeMs. Simulate mode keeps
// time only through this; live, the timer usually gets there first.
static void AdvanceTime(DWORD timeMs) {
    if (g_chordPending && (DWORD)(timeMs - g_chordStartTime) >= MODIFIER_ONLY_START_DELAY_MS) {
        FirePendingChord();
    }
}

static BOOL ParseNumber(const char* text, int base, long* out) {
    char* end = NULL;
    long value;
    if (*text == '\0') return FALSE;
    value = strtol(text, &end, base);
    if (end == text || *end != '\0') return FALSE;
    *out = value;
    return TRUE;
}

typedef struct {
    const char* name;
    DWORD vk;
} KeyName;

/*
 * Every key name the hotkey picker (src/components/ui/HotkeyInput.tsx) can save,
 * plus the Electron accelerator names and aliases older settings may hold.
 * Letters and digits are their own VK codes and need no entry.
 *
 * A name missing here is an error, never a guess. The listener used to fall back
 * to atoi(), which turned Up, Enter, PrintScreen, num0 and the media keys into
 * VK 0, and then watched nothing or only the modifiers in front of the key.
 */
static const KeyName g_keyNames[] = {
    { "F1", VK_F1 },   { "F2", VK_F2 },   { "F3", VK_F3 },   { "F4", VK_F4 },
    { "F5", VK_F5 },   { "F6", VK_F6 },   { "F7", VK_F7 },   { "F8", VK_F8 },
    { "F9", VK_F9 },   { "F10", VK_F10 }, { "F11", VK_F11 }, { "F12", VK_F12 },
    { "F13", VK_F13 }, { "F14", VK_F14 }, { "F15", VK_F15 }, { "F16", VK_F16 },
    { "F17", VK_F17 }, { "F18", VK_F18 }, { "F19", VK_F19 }, { "F20", VK_F20 },
    { "F21", VK_F21 }, { "F22", VK_F22 }, { "F23", VK_F23 }, { "F24", VK_F24 },

    { "Space", VK_SPACE },
    { "Tab", VK_TAB },
    { "Enter", VK_RETURN }, // numpad Enter arrives as VK_RETURN too
    { "Return", VK_RETURN },
    { "Escape", VK_ESCAPE },
    { "Esc", VK_ESCAPE },
    { "Backspace", VK_BACK },
    { "Delete", VK_DELETE },
    { "Insert", VK_INSERT },
    { "Home", VK_HOME },
    { "End", VK_END },
    { "PageUp", VK_PRIOR },
    { "PageDown", VK_NEXT },
    { "Up", VK_UP },
    { "Down", VK_DOWN },
    { "Left", VK_LEFT },
    { "Right", VK_RIGHT },

    { "Pause", VK_PAUSE },
    { "PrintScreen", VK_SNAPSHOT },
    { "ScrollLock", VK_SCROLL },
    { "NumLock", VK_NUMLOCK },
    { "CapsLock", VK_CAPITAL },

    // Numpad, by Electron's accelerator names. With Num Lock off Windows reports
    // the digit keys as the navigation keys printed on them, so num1 arrives as End.
    { "num0", VK_NUMPAD0 }, { "num1", VK_NUMPAD1 }, { "num2", VK_NUMPAD2 },
    { "num3", VK_NUMPAD3 }, { "num4", VK_NUMPAD4 }, { "num5", VK_NUMPAD5 },
    { "num6", VK_NUMPAD6 }, { "num7", VK_NUMPAD7 }, { "num8", VK_NUMPAD8 },
    { "num9", VK_NUMPAD9 },
    { "numadd", VK_ADD },
    { "numsub", VK_SUBTRACT },
    { "nummult", VK_MULTIPLY },
    { "numdiv", VK_DIVIDE },
    { "numdec", VK_DECIMAL },

    { "MediaPlayPause", VK_MEDIA_PLAY_PAUSE },
    { "MediaStop", VK_MEDIA_STOP },
    { "MediaNextTrack", VK_MEDIA_NEXT_TRACK },
    { "MediaPreviousTrack", VK_MEDIA_PREV_TRACK },
    { "VolumeUp", VK_VOLUME_UP },
    { "VolumeDown", VK_VOLUME_DOWN },
    { "VolumeMute", VK_VOLUME_MUTE },

    // Punctuation, by its US-layout character. Backquote, the key left of 1, is
    // what the app sends for both ` and the Nordic ½.
    { "`", VK_OEM_3 },
    { "Backquote", VK_OEM_3 },
    { "-", VK_OEM_MINUS },
    { "Minus", VK_OEM_MINUS },
    { "=", VK_OEM_PLUS },
    { "Equal", VK_OEM_PLUS },
    { "Plus", VK_OEM_PLUS },
    { "[", VK_OEM_4 },
    { "]", VK_OEM_6 },
    { "\\", VK_OEM_5 },
    { ";", VK_OEM_1 },
    { "'", VK_OEM_7 },
    { ",", VK_OEM_COMMA },
    { ".", VK_OEM_PERIOD },
    { "/", VK_OEM_2 },
};

// Resolves one keyboard key name. FALSE means it is not a key this listener knows.
static BOOL ParseKeyName(const char* name, DWORD* vkOut) {
    size_t i;
    long value = 0;
    BOOL isNumber;

    for (i = 0; i < sizeof(g_keyNames) / sizeof(g_keyNames[0]); i++) {
        if (_stricmp(name, g_keyNames[i].name) == 0) {
            *vkOut = g_keyNames[i].vk;
            return TRUE;
        }
    }

    if (strlen(name) == 1) {
        char c = name[0];
        if (c >= 'a' && c <= 'z') c = (char)(c - 'a' + 'A');
        if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) {
            *vkOut = (DWORD)c;
            return TRUE;
        }
        return FALSE;
    }

    // A raw VK code in hex (0xA3) or decimal. Agent Mode names the side-specific
    // modifiers this way.
    if (name[0] == '0' && (name[1] == 'x' || name[1] == 'X')) {
        isNumber = ParseNumber(name + 2, 16, &value);
    } else {
        isNumber = ParseNumber(name, 10, &value);
    }
    if (isNumber && value > 0 && value < 0xFF) {
        *vkOut = (DWORD)value;
        return TRUE;
    }

    return FALSE;
}

// Mouse4 and Mouse5 are the side buttons, the only mouse buttons this listener watches.
static BOOL ParseMouseButton(const char* name, DWORD* xbuttonOut) {
    if (_stricmp(name, "Mouse4") == 0 || _stricmp(name, "XButton1") == 0) {
        *xbuttonOut = XBUTTON1;
        return TRUE;
    }
    if (_stricmp(name, "Mouse5") == 0 || _stricmp(name, "XButton2") == 0) {
        *xbuttonOut = XBUTTON2;
        return TRUE;
    }
    return FALSE;
}

/*
 * Reads the hotkey into the globals above. Returns FALSE, after saying why on
 * stderr, when any part of it is not a key or modifier this listener knows.
 */
static BOOL ParseCompoundHotkey(const char* hotkey) {
    char buffer[256];
    char* part;
    BOOL hasKey = FALSE;

    g_requireCtrl = FALSE;
    g_requireAlt = FALSE;
    g_requireShift = FALSE;
    g_requireWin = FALSE;
    g_isMouseButton = FALSE;
    g_targetXButton = 0;
    g_targetVk = 0;
    g_modifierOnly = FALSE;

    if (strlen(hotkey) >= sizeof(buffer)) {
        fprintf(stderr, "Error: hotkey is too long\n");
        return FALSE;
    }
    strcpy(buffer, hotkey);

    // Split by hand: strtok skips empty parts, which would read "Ctrl+" as Ctrl.
    part = buffer;
    for (;;) {
        char* plus = strchr(part, '+');
        char* name;
        char* end;

        if (plus) *plus = '\0';
        name = part;
        while (*name == ' ') name++;
        end = name + strlen(name);
        while (end > name && end[-1] == ' ') *--end = '\0';

        if (*name == '\0') {
            fprintf(stderr, "Error: empty key in hotkey '%s'\n", hotkey);
            return FALSE;
        }

        if (_stricmp(name, "CommandOrControl") == 0 ||
            _stricmp(name, "Control") == 0 ||
            _stricmp(name, "Ctrl") == 0 ||
            _stricmp(name, "CmdOrCtrl") == 0) {
            g_requireCtrl = TRUE;
        } else if (_stricmp(name, "Alt") == 0 || _stricmp(name, "Option") == 0) {
            g_requireAlt = TRUE;
        } else if (_stricmp(name, "Shift") == 0) {
            g_requireShift = TRUE;
        } else if (_stricmp(name, "Super") == 0 ||
                   _stricmp(name, "Meta") == 0 ||
                   _stricmp(name, "Win") == 0 ||
                   _stricmp(name, "Command") == 0 ||
                   _stricmp(name, "Cmd") == 0) {
            // Windows key (VK_LWIN/VK_RWIN)
            g_requireWin = TRUE;
        } else if (hasKey) {
            fprintf(stderr, "Error: hotkey '%s' names more than one key\n", hotkey);
            return FALSE;
        } else if (ParseMouseButton(name, &g_targetXButton)) {
            g_isMouseButton = TRUE;
            hasKey = TRUE;
        } else if (ParseKeyName(name, &g_targetVk)) {
            hasKey = TRUE;
        } else {
            fprintf(stderr, "Error: unknown key '%s' in hotkey '%s'\n", name, hotkey);
            return FALSE;
        }

        if (!plus) break;
        part = plus + 1;
    }

    // Every part was a modifier, and an empty hotkey failed above, so at least one is required.
    g_modifierOnly = !hasKey;
    return TRUE;
}

/*
 * A modifier-only hotkey, such as Control+Shift. Its modifiers can be pressed in
 * any order and with either side's key.
 *
 * Every one of them held for MODIFIER_ONLY_START_DELAY_MS with no other key sends
 * KEY_DOWN, and releasing one sends KEY_UP. Releasing one sooner is a tap, sent as
 * KEY_DOWN and KEY_UP together. Any other key going down while one of them is held
 * makes the press part of another shortcut: nothing is sent, or KEY_CANCEL if
 * KEY_DOWN already was. That includes the Ctrl+Shift+V this app injects to paste
 * into a terminal.
 */
static void HandleModifierOnlyEvent(DWORD vkCode, BOOL isKeyDown, DWORD timeMs) {
    BOOL isRequired = IsRequiredModifierVk(vkCode);

    if (isKeyDown && !isRequired) {
        if (g_chordPending || g_isDown || IsAnyRequiredModifierHeld()) {
            g_chordSpoiled = TRUE;
            StopChordTimer();
            EmitCancel();
        }
        return;
    }

    if (isKeyDown) {
        // Auto-repeat of a held modifier arrives as more key-downs and changes nothing.
        if (!g_chordSpoiled && !g_chordPending && !g_isDown && AreModifiersPressed()) {
            StartChordTimer(timeMs);
        }
        return;
    }

    if (isRequired) {
        if (g_chordPending) {
            StopChordTimer();
            EmitDown();
        }
        EmitUp();
    }
}

/*
 * The whole keyboard decision, in one place. The live hook and the --simulate
 * loop both call this, so a test drives the exact compiled logic.
 *
 * timeMs is the event timestamp (KBDLLHOOKSTRUCT::time), milliseconds since boot.
 */
static void HandleKeyboardEvent(DWORD vkCode, BOOL isKeyDown, DWORD timeMs, DWORD scanCode) {
    if (vkCode == VK_LCONTROL && scanCode == ALTGR_FAKE_CTRL_SCAN) {
        g_altGrCtrlDown = isKeyDown;
        return;
    }

    AdvanceTime(timeMs);

    // A shortcut's modifiers are all released, so the next press starts clean.
    if (g_chordSpoiled && !IsAnyRequiredModifierHeld()) {
        g_chordSpoiled = FALSE;
    }

    TrackModifierState(vkCode, isKeyDown);

    if (g_modifierOnly) {
        HandleModifierOnlyEvent(vkCode, isKeyDown, timeMs);
        return;
    }

    // If a required modifier was released while we're held down, emit up.
    if (g_isDown && !isKeyDown && IsRequiredModifierVk(vkCode)) {
        EmitUp();
    }

    // The trigger key is handled first and exclusively: a raw VK trigger such as
    // 0xA3 (right Ctrl) is itself a modifier, and it must never also be treated
    // as "a required modifier arriving late".
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
            HandleKeyboardEvent(kbd->vkCode, isKeyDown, kbd->time, kbd->scanCode);
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
        char* option;
        BOOL isKeyDown;
        DWORD vkCode = 0;
        long timeMs = 0;
        long scanCode = 0;
        BOOL badOption = FALSE;
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

        if (verb != NULL && _stricmp(verb, "TICK") == 0) {
            if (keyToken == NULL || strtok(NULL, " \t") != NULL ||
                !ParseNumber(keyToken, 10, &timeMs)) {
                fprintf(stderr, "ERR %s\n", original);
                fflush(stderr);
                continue;
            }
            AdvanceTime((DWORD)timeMs);
            continue;
        }

        timeToken = strtok(NULL, " \t");
        while ((option = strtok(NULL, " \t")) != NULL) {
            if (_strnicmp(option, "scan=0x", 7) != 0 || !ParseNumber(option + 7, 16, &scanCode)) {
                badOption = TRUE;
            }
        }

        if (verb == NULL || keyToken == NULL || timeToken == NULL || badOption) {
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

        HandleKeyboardEvent(vkCode, isKeyDown, (DWORD)timeMs, (DWORD)scanCode);
        // After the event, as the system updates its key state only once the hook returns.
        if (vkCode < 256) g_simKeyDown[vkCode] = isKeyDown;
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
        fprintf(stderr, "  %s Control+Shift            (modifiers only)\n", argv[0]);
        fprintf(stderr, "  %s Ctrl+Mouse4              (modifier + mouse)\n", argv[0]);
        fprintf(stderr, "  %s --simulate Ctrl+Space    (stdin-driven test mode)\n", argv[0]);
        return 1;
    }

    hotkey = argv[hotkeyArg];
    if (!ParseCompoundHotkey(hotkey)) {
        return EXIT_BAD_HOTKEY;
    }

    fprintf(stderr, "Listening for: %s (mouse=%d, VK=0x%02X, modifierOnly=%d, Ctrl=%d, Alt=%d, Shift=%d, Win=%d)\n",
            hotkey, g_isMouseButton, g_targetVk, g_modifierOnly, g_requireCtrl, g_requireAlt,
            g_requireShift, g_requireWin);

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
