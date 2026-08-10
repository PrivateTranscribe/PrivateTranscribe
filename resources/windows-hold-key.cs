// Windows hold-key helper for PrivateTranscribe.
//
// Presses a key combination, holds it, and releases it. Used to drive a voice
// app's "push to mute" keybind for the length of a dictation, so the user is
// muted in Discord (or Teams, Zoom, Slack) while PrivateTranscribe listens.
//
// Usage:
//   windows-hold-key.exe --key=Ctrl+Shift+M [--max-ms=120000]
//
// The key goes down at startup. It is released when any of these happens,
// whichever comes first:
//   - stdin closes, which is what happens the instant PrivateTranscribe exits
//   - a line "release" arrives on stdin
//   - --max-ms elapses
//   - the process is shut down gracefully and the runtime runs ProcessExit
//
// A hard kill (TerminateProcess) runs none of that, so `--release-only` sends
// the key-up half on its own. PrivateTranscribe calls it at startup to clear
// any key a previous crash left logically held.
//
// That layering is the whole point of this being a separate long-lived process
// rather than two fire-and-forget calls. SendInput writes to the global input
// state, so a key pressed by one process stays logically down until something
// releases it. A crashed helper that had sent only the keydown would leave the
// user's keyboard stuck. Every exit path here ends in a keyup.
//
// Why hold-to-mute rather than a mute toggle: a toggle would need us to know
// the app's current mute state, and getting that wrong means unmuting someone
// who thought they were muted. Holding is stateless, so the user ends up
// exactly where they started no matter what happened in between.
//
// Built by scripts/build-windows-hold-key.js with the in-box .NET Framework
// compiler, so contributors need no extra toolchain.

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

internal static class WindowsHoldKey
{
    private const int DefaultMaxHoldMs = 120000;
    private const int MinMaxHoldMs = 1000;

    private const int InputKeyboard = 1;
    private const uint KeyEventKeyUp = 0x0002;
    private const uint KeyEventExtendedKey = 0x0001;

    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct INPUTUNION
    {
        [FieldOffset(0)]
        public KEYBDINPUT ki;
        // Pad the union out to the size of the largest member (MOUSEINPUT on
        // x64) so the marshalled struct size matches what SendInput expects.
        [FieldOffset(0)]
        private Padding pad;
    }

    [StructLayout(LayoutKind.Sequential, Size = 32)]
    private struct Padding
    {
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT
    {
        public int type;
        public INPUTUNION u;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    // Keys that live on the extended part of the keyboard and need the
    // extended-key flag for applications that read scan codes.
    private static readonly HashSet<Keys> ExtendedKeys = new HashSet<Keys>
    {
        Keys.RControlKey, Keys.RMenu, Keys.Insert, Keys.Delete, Keys.Home, Keys.End,
        Keys.PageUp, Keys.PageDown, Keys.Left, Keys.Right, Keys.Up, Keys.Down,
        Keys.NumLock, Keys.PrintScreen, Keys.Divide,
    };

    private static readonly object SendLock = new object();
    private static List<Keys> heldKeys;
    private static bool released;

    // -----------------------------------------------------------------------
    // Key parsing
    // -----------------------------------------------------------------------

    private static bool TryParseKeyToken(string token, out Keys key)
    {
        key = Keys.None;
        if (string.IsNullOrEmpty(token))
        {
            return false;
        }

        string normalized = token.Trim();

        switch (normalized.ToLowerInvariant())
        {
            case "ctrl":
            case "control":
            case "commandorcontrol":
                key = Keys.ControlKey;
                return true;
            case "shift":
                key = Keys.ShiftKey;
                return true;
            case "alt":
                key = Keys.Menu;
                return true;
            case "win":
            case "super":
            case "meta":
                key = Keys.LWin;
                return true;
            case "space":
                key = Keys.Space;
                return true;
        }

        // Bare digits parse as the D-prefixed members of the Keys enum.
        if (normalized.Length == 1 && normalized[0] >= '0' && normalized[0] <= '9')
        {
            normalized = "D" + normalized;
        }

        try
        {
            key = (Keys)Enum.Parse(typeof(Keys), normalized, true);
            return key != Keys.None;
        }
        catch (Exception)
        {
            return false;
        }
    }

    /// Parses "Ctrl+Shift+M" into the key sequence to press, modifiers first so
    /// they are already down when the main key arrives.
    private static List<Keys> ParseCombination(string combination)
    {
        var result = new List<Keys>();
        if (string.IsNullOrEmpty(combination))
        {
            return result;
        }

        string[] parts = combination.Split('+');
        for (int i = 0; i < parts.Length; i++)
        {
            Keys key;
            if (!TryParseKeyToken(parts[i], out key))
            {
                return new List<Keys>();
            }
            if (!result.Contains(key))
            {
                result.Add(key);
            }
        }
        return result;
    }

    // -----------------------------------------------------------------------
    // Input
    // -----------------------------------------------------------------------

    private static bool SendKeyEvent(Keys key, bool keyUp)
    {
        var input = new INPUT();
        input.type = InputKeyboard;
        input.u.ki.wVk = (ushort)key;
        input.u.ki.wScan = 0;
        input.u.ki.dwFlags = keyUp ? KeyEventKeyUp : 0;
        if (ExtendedKeys.Contains(key))
        {
            input.u.ki.dwFlags |= KeyEventExtendedKey;
        }
        input.u.ki.time = 0;
        input.u.ki.dwExtraInfo = IntPtr.Zero;

        var inputs = new INPUT[] { input };
        return SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT))) == 1;
    }

    private static void PressAll(List<Keys> keys)
    {
        for (int i = 0; i < keys.Count; i++)
        {
            SendKeyEvent(keys[i], false);
        }
    }

    /// Releases in reverse order so modifiers come up last, which is what a
    /// real keyboard does and what applications expect.
    private static void ReleaseAll()
    {
        lock (SendLock)
        {
            if (released || heldKeys == null)
            {
                return;
            }
            released = true;
            for (int i = heldKeys.Count - 1; i >= 0; i--)
            {
                SendKeyEvent(heldKeys[i], true);
            }
        }
    }

    // -----------------------------------------------------------------------
    // Entry point
    // -----------------------------------------------------------------------

    private static bool HasFlag(string[] args, string flag)
    {
        for (int i = 0; i < args.Length; i++)
        {
            if (string.Equals(args[i], flag, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }
        return false;
    }

    private static string GetOption(string[] args, string prefix)
    {
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i].StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            {
                return args[i].Substring(prefix.Length);
            }
        }
        return null;
    }

    public static int Main(string[] args)
    {
        string combination = GetOption(args, "--key=");
        if (string.IsNullOrEmpty(combination))
        {
            Console.Error.WriteLine("windows-hold-key: --key= is required");
            return 2;
        }

        var keys = ParseCombination(combination);
        if (keys.Count == 0)
        {
            Console.Error.WriteLine("windows-hold-key: could not parse key combination");
            return 3;
        }

        int maxHoldMs = DefaultMaxHoldMs;
        string rawMax = GetOption(args, "--max-ms=");
        if (!string.IsNullOrEmpty(rawMax))
        {
            int parsed;
            if (int.TryParse(rawMax, NumberStyles.Integer, CultureInfo.InvariantCulture, out parsed))
            {
                maxHoldMs = parsed < MinMaxHoldMs ? MinMaxHoldMs : parsed;
            }
        }

        heldKeys = keys;

        // Recovery mode: send only the key-up half. PrivateTranscribe runs this
        // at startup for the configured combination, because a helper killed
        // outright (TerminateProcess, task manager, power loss mid-dictation)
        // never gets to run its own release, and a modifier left logically down
        // would corrupt every keystroke the user typed afterwards. Sending a
        // key-up for a key that is already up is harmless.
        if (HasFlag(args, "--release-only"))
        {
            ReleaseAll();
            return 0;
        }

        // The ordinary exit paths. These cover a graceful shutdown; a hard kill
        // is what --release-only exists to clean up after.
        AppDomain.CurrentDomain.ProcessExit += delegate { ReleaseAll(); };
        Console.CancelKeyPress += delegate { ReleaseAll(); };

        PressAll(keys);
        Console.Out.WriteLine("held");
        Console.Out.Flush();

        // The hold ends at whichever comes first: the parent closing stdin,
        // an explicit release, or the safety timeout.
        var done = new ManualResetEvent(false);

        var reader = new Thread(delegate ()
        {
            try
            {
                while (true)
                {
                    string line = Console.In.ReadLine();
                    if (line == null)
                    {
                        break; // stdin closed: the parent is gone
                    }
                    if (line.Trim().Equals("release", StringComparison.OrdinalIgnoreCase))
                    {
                        break;
                    }
                }
            }
            catch (Exception)
            {
                // Treat any stdin failure as "release now".
            }
            done.Set();
        });
        reader.IsBackground = true;
        reader.Start();

        done.WaitOne(maxHoldMs);

        ReleaseAll();
        return 0;
    }
}
