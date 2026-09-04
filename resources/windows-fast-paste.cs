// Windows fast paste helper for PrivateTranscribe.
//
// Detects the foreground window, decides whether it is a terminal emulator, and
// sends the matching paste chord with Win32 SendInput:
//   - Ctrl+V        for ordinary applications
//   - Ctrl+Shift+V  for terminal emulators (Windows Terminal, conhost, mintty, ...)
//
// Detection uses the window class name first and the owning executable name as a
// fallback for Electron-based terminals, which all share Chrome_WidgetWin_1.
// Only the class name and executable name are read. The window title is
// deliberately never read: titles routinely contain document names, URLs, and
// other user content that this helper has no reason to see.
//
// Terminal class/executable lists adapted from OpenWhispr's windows-fast-paste.c
// (MIT License, Copyright (c) 2024 OpenWhispr Team).
//
// Built by scripts/build-windows-fast-paste.js with the in-box .NET Framework
// compiler, so contributors need no extra toolchain. It is a plain compiled
// executable rather than an inline PowerShell script because dynamically
// evaluated PowerShell is submitted to AMSI and triggered antivirus heuristics.

using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;
using System.Windows.Forms;

internal static class WindowsFastPaste
{
    private sealed class AccessibleTextSnapshot
    {
        public string Text;
        public int[] RuntimeId;
    }

    private static readonly string[] TerminalWindowClasses =
    {
        "ConsoleWindowClass",
        "CASCADIA_HOSTING_WINDOW_CLASS",
        "mintty",
        "VirtualConsoleClass",
        "PuTTY",
        "Alacritty",
        "org.wezfurlong.wezterm",
        "Hyper",
        "TMobaXterm",
        "kitty",
    };

    // Electron-based terminals share Chrome_WidgetWin_1 with every other Electron
    // app, so they are matched on the executable name instead.
    private static readonly string[] TerminalExecutables =
    {
        "termius",
        "tabby",
        "wave",
        "rio",
        "warp",
        "wezterm-gui",
    };

    private const int VkLShift = 0xA0;
    private const int VkRShift = 0xA1;
    private const int VkLControl = 0xA2;
    private const int VkRControl = 0xA3;
    private const int VkLMenu = 0xA4;
    private const int VkRMenu = 0xA5;
    private const int VkLWin = 0x5B;
    private const int VkRWin = 0x5C;
    private const int VkV = 0x56;

    // Modifiers the user may still be holding from the dictation hotkey. Any of
    // them left down would turn Ctrl+V into Ctrl+Alt+V (or similar) and the paste
    // would silently do nothing.
    private static readonly ushort[] ModifierKeys =
    {
        VkLControl, VkRControl,
        VkLShift, VkRShift,
        VkLMenu, VkRMenu,
        VkLWin, VkRWin,
    };

    [STAThread]
    private static int Main(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        bool detectOnly = Array.IndexOf(args, "--detect-only") >= 0;

        IntPtr window = GetForegroundWindow();
        if (window == IntPtr.Zero)
        {
            Console.Error.Write("no foreground window");
            return 2;
        }

        string windowClass = ReadWindowClass(window);
        string processName = ReadProcessName(window);
        bool isTerminal = IsTerminalWindowClass(windowClass) || IsTerminalExecutable(processName);

        if (detectOnly)
        {
            WriteResult(false, false, isTerminal, windowClass, processName);
            return 0;
        }

        string clipboardText = ReadClipboardText();
        AccessibleTextSnapshot textBefore = ReadFocusedAccessibleText();

        // Give the foreground window a moment to settle after the hotkey release.
        Thread.Sleep(10);

        ushort[] heldModifiers = ReleaseHeldModifiers();
        bool sent = SendPasteChord(isTerminal);
        RestoreHeldModifiers(heldModifiers);

        if (!sent)
        {
            Console.Error.Write("SendInput failed with error " + Marshal.GetLastWin32Error());
            return 1;
        }

        bool confirmed = ConfirmAccessibleInsertion(textBefore, clipboardText);
        WriteResult(confirmed, true, isTerminal, windowClass, processName);
        return 0;
    }

    private static void WriteResult(
        bool pasted,
        bool dispatched,
        bool isTerminal,
        string windowClass,
        string processName)
    {
        Console.Write(
            "{\"pasted\":" + (pasted ? "true" : "false") +
            ",\"dispatched\":" + (dispatched ? "true" : "false") +
            ",\"isTerminal\":" + (isTerminal ? "true" : "false") +
            ",\"windowClass\":\"" + EscapeJson(windowClass) +
            "\",\"processName\":\"" + EscapeJson(processName) +
            "\",\"chord\":\"" + (isTerminal ? "ctrl+shift+v" : "ctrl+v") + "\"}");
    }

    // SendInput success proves only that Windows accepted the key events. Report
    // insertion only when the focused accessible text changes and contains the
    // clipboard text. Captured content stays in this process and is never
    // written to stdout, stderr, logs, analytics, or disk.
    private static bool ConfirmAccessibleInsertion(
        AccessibleTextSnapshot textBefore,
        string clipboardText)
    {
        if (textBefore == null || string.IsNullOrEmpty(clipboardText))
        {
            return false;
        }

        string normalizedBefore = NormalizeNewlines(textBefore.Text);
        string normalizedClipboard = NormalizeNewlines(clipboardText);
        int occurrencesBefore = CountOccurrences(normalizedBefore, normalizedClipboard);
        for (int attempt = 0; attempt < 12; attempt++)
        {
            Thread.Sleep(25);
            AccessibleTextSnapshot textAfter = ReadFocusedAccessibleText();
            if (textAfter == null || !SameRuntimeId(textBefore.RuntimeId, textAfter.RuntimeId))
            {
                continue;
            }

            string normalizedAfter = NormalizeNewlines(textAfter.Text);
            if (!string.Equals(normalizedAfter, normalizedBefore, StringComparison.Ordinal) &&
                CountOccurrences(normalizedAfter, normalizedClipboard) > occurrencesBefore)
            {
                return true;
            }
        }
        return false;
    }

    private static string ReadClipboardText()
    {
        try
        {
            return Clipboard.ContainsText(TextDataFormat.UnicodeText)
                ? Clipboard.GetText(TextDataFormat.UnicodeText)
                : string.Empty;
        }
        catch
        {
            return string.Empty;
        }
    }

    private static AccessibleTextSnapshot ReadFocusedAccessibleText()
    {
        try
        {
            AutomationElement focused = AutomationElement.FocusedElement;
            if (focused == null)
            {
                return null;
            }

            int[] runtimeId = focused.GetRuntimeId();
            if (runtimeId == null || runtimeId.Length == 0)
            {
                return null;
            }

            object pattern;

            // TextPattern is tried first because it is the only one that means
            // the same thing everywhere. Chromium also exposes ValuePattern on a
            // Document element, but there the value is the document URL, not the
            // text, so a contenteditable composer (Claude Desktop, Slack, Notion)
            // read the same before and after every paste and insertion was never
            // confirmed. Where both exist on a plain input they agree.
            if (focused.TryGetCurrentPattern(TextPattern.Pattern, out pattern))
            {
                // Bound the local read rather than retaining an arbitrary document.
                // Missing evidence is a safe false negative: the caller preserves
                // the transcript in history and on the clipboard.
                return new AccessibleTextSnapshot
                {
                    Text = ((TextPattern)pattern).DocumentRange.GetText(131072) ?? string.Empty,
                    RuntimeId = runtimeId,
                };
            }

            if (focused.TryGetCurrentPattern(ValuePattern.Pattern, out pattern))
            {
                return new AccessibleTextSnapshot
                {
                    Text = ((ValuePattern)pattern).Current.Value ?? string.Empty,
                    RuntimeId = runtimeId,
                };
            }
        }
        catch
        {
            // Elevated, protected, or non-accessible targets remain unconfirmed.
        }
        return null;
    }

    private static bool SameRuntimeId(int[] left, int[] right)
    {
        if (left == null || right == null || left.Length != right.Length)
        {
            return false;
        }
        for (int index = 0; index < left.Length; index++)
        {
            if (left[index] != right[index])
            {
                return false;
            }
        }
        return true;
    }

    private static string NormalizeNewlines(string value)
    {
        return (value ?? string.Empty).Replace("\r\n", "\n").Replace("\r", "\n");
    }

    private static int CountOccurrences(string value, string candidate)
    {
        if (string.IsNullOrEmpty(value) || string.IsNullOrEmpty(candidate))
        {
            return 0;
        }

        int count = 0;
        int offset = 0;
        while ((offset = value.IndexOf(candidate, offset, StringComparison.Ordinal)) >= 0)
        {
            count++;
            offset += candidate.Length;
        }
        return count;
    }

    private static string ReadWindowClass(IntPtr window)
    {
        StringBuilder buffer = new StringBuilder(256);
        int length = GetClassName(window, buffer, buffer.Capacity);
        return length > 0 ? buffer.ToString() : string.Empty;
    }

    private static string ReadProcessName(IntPtr window)
    {
        try
        {
            uint processId;
            GetWindowThreadProcessId(window, out processId);
            if (processId == 0)
            {
                return string.Empty;
            }

            return Process.GetProcessById((int)processId).ProcessName ?? string.Empty;
        }
        catch
        {
            // Reading the owner of an elevated or exiting window can fail. The
            // window class check above is enough on its own.
            return string.Empty;
        }
    }

    private static bool IsTerminalWindowClass(string windowClass)
    {
        if (string.IsNullOrEmpty(windowClass))
        {
            return false;
        }

        foreach (string candidate in TerminalWindowClasses)
        {
            if (string.Equals(windowClass, candidate, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }
        return false;
    }

    private static bool IsTerminalExecutable(string processName)
    {
        if (string.IsNullOrEmpty(processName))
        {
            return false;
        }

        foreach (string candidate in TerminalExecutables)
        {
            if (string.Equals(processName, candidate, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }
        return false;
    }

    private static ushort[] ReleaseHeldModifiers()
    {
        System.Collections.Generic.List<ushort> held = new System.Collections.Generic.List<ushort>();
        foreach (ushort key in ModifierKeys)
        {
            if ((GetAsyncKeyState(key) & 0x8000) != 0)
            {
                held.Add(key);
            }
        }

        if (held.Count == 0)
        {
            return new ushort[0];
        }

        INPUT[] inputs = new INPUT[held.Count];
        for (int index = 0; index < held.Count; index++)
        {
            inputs[index] = KeyInput(held[index], KeyEventKeyUp);
        }
        SendInputs(inputs);
        return held.ToArray();
    }

    private static void RestoreHeldModifiers(ushort[] heldModifiers)
    {
        if (heldModifiers.Length == 0)
        {
            return;
        }

        INPUT[] inputs = new INPUT[heldModifiers.Length];
        for (int index = 0; index < heldModifiers.Length; index++)
        {
            inputs[index] = KeyInput(heldModifiers[index], 0);
        }
        SendInputs(inputs);
    }

    private static bool SendPasteChord(bool isTerminal)
    {
        INPUT[] inputs = isTerminal
            ? new[]
            {
                KeyInput(VkLControl, 0),
                KeyInput(VkLShift, 0),
                KeyInput(VkV, 0),
                KeyInput(VkV, KeyEventKeyUp),
                KeyInput(VkLShift, KeyEventKeyUp),
                KeyInput(VkLControl, KeyEventKeyUp),
            }
            : new[]
            {
                KeyInput(VkLControl, 0),
                KeyInput(VkV, 0),
                KeyInput(VkV, KeyEventKeyUp),
                KeyInput(VkLControl, KeyEventKeyUp),
            };

        return SendInputs(inputs);
    }

    private static bool SendInputs(INPUT[] inputs)
    {
        uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
        return sent == (uint)inputs.Length;
    }

    private static INPUT KeyInput(ushort virtualKey, uint flags)
    {
        INPUT input = new INPUT();
        input.type = InputKeyboard;
        input.union.keyboard.wVk = virtualKey;
        input.union.keyboard.wScan = (ushort)MapVirtualKey(virtualKey, MapVkToVsc);
        input.union.keyboard.dwFlags = flags;
        input.union.keyboard.time = 0;
        input.union.keyboard.dwExtraInfo = IntPtr.Zero;
        return input;
    }

    private static string EscapeJson(string value)
    {
        if (string.IsNullOrEmpty(value))
        {
            return string.Empty;
        }

        StringBuilder result = new StringBuilder(value.Length);
        foreach (char character in value)
        {
            switch (character)
            {
                case '\\': result.Append("\\\\"); break;
                case '"': result.Append("\\\""); break;
                case '\b': result.Append("\\b"); break;
                case '\f': result.Append("\\f"); break;
                case '\n': result.Append("\\n"); break;
                case '\r': result.Append("\\r"); break;
                case '\t': result.Append("\\t"); break;
                default:
                    if (character < 0x20)
                    {
                        result.Append("\\u").Append(((int)character).ToString("x4"));
                    }
                    else
                    {
                        result.Append(character);
                    }
                    break;
            }
        }
        return result.ToString();
    }

    private const uint InputKeyboard = 1;
    private const uint KeyEventKeyUp = 0x0002;
    private const uint MapVkToVsc = 0x00;

    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct HARDWAREINPUT
    {
        public uint uMsg;
        public ushort wParamL;
        public ushort wParamH;
    }

    // The union must be laid out over the largest member (MOUSEINPUT) or SendInput
    // rejects the wrong structure size.
    [StructLayout(LayoutKind.Explicit)]
    private struct INPUTUNION
    {
        [FieldOffset(0)] public MOUSEINPUT mouse;
        [FieldOffset(0)] public KEYBDINPUT keyboard;
        [FieldOffset(0)] public HARDWAREINPUT hardware;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT
    {
        public uint type;
        public INPUTUNION union;
    }

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int vKey);

    [DllImport("user32.dll")]
    private static extern uint MapVirtualKey(uint uCode, uint uMapType);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
}
