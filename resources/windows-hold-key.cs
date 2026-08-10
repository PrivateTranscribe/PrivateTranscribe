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

    private const int InputMouse = 0;
    private const int InputKeyboard = 1;
    private const uint KeyEventKeyUp = 0x0002;
    private const uint KeyEventExtendedKey = 0x0001;

    // Mouse buttons are worth supporting because they are a common push-to-talk
    // and push-to-mute binding, and they travel through SendInput as MOUSEINPUT
    // rather than KEYBDINPUT.
    private const uint MouseEventMiddleDown = 0x0020;
    private const uint MouseEventMiddleUp = 0x0040;
    private const uint MouseEventXDown = 0x0080;
    private const uint MouseEventXUp = 0x0100;
    private const uint XButton1 = 0x0001;
    private const uint XButton2 = 0x0002;

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
    private struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct INPUTUNION
    {
        [FieldOffset(0)]
        public MOUSEINPUT mi;
        [FieldOffset(0)]
        public KEYBDINPUT ki;
        // Pad the union out to the size of the largest member so the marshalled
        // struct size matches what SendInput expects.
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

    /// One element of a combination: either a keyboard key or a mouse button.
    private sealed class HeldInput
    {
        public bool IsMouse;
        public Keys Key;        // keyboard only
        public uint DownFlag;   // mouse only
        public uint UpFlag;     // mouse only
        public uint MouseData;  // mouse only, identifies which X button
    }

    private static readonly object SendLock = new object();
    private static List<HeldInput> heldKeys;
    private static bool released;

    // -----------------------------------------------------------------------
    // Key parsing
    // -----------------------------------------------------------------------

    private static HeldInput MakeMouse(uint downFlag, uint upFlag, uint mouseData)
    {
        var input = new HeldInput();
        input.IsMouse = true;
        input.DownFlag = downFlag;
        input.UpFlag = upFlag;
        input.MouseData = mouseData;
        return input;
    }

    private static bool TryParseKeyToken(string token, out HeldInput input)
    {
        input = null;
        Keys key = Keys.None;
        if (string.IsNullOrEmpty(token))
        {
            return false;
        }

        string normalized = token.Trim();

        // Mouse button names follow the same numbering Discord uses in its own
        // keybind list, so what the user sees in both apps lines up.
        switch (normalized.ToLowerInvariant().Replace(" ", ""))
        {
            case "mouse3":
            case "middlemouse":
                input = MakeMouse(MouseEventMiddleDown, MouseEventMiddleUp, 0);
                return true;
            case "mouse4":
                input = MakeMouse(MouseEventXDown, MouseEventXUp, XButton1);
                return true;
            case "mouse5":
                input = MakeMouse(MouseEventXDown, MouseEventXUp, XButton2);
                return true;
        }

        switch (normalized.ToLowerInvariant())
        {
            case "ctrl":
            case "control":
            case "commandorcontrol":
                key = Keys.ControlKey;
                break;
            case "shift":
                key = Keys.ShiftKey;
                break;
            case "alt":
                key = Keys.Menu;
                break;
            case "win":
            case "super":
            case "meta":
                key = Keys.LWin;
                break;
            case "space":
                key = Keys.Space;
                break;

            // Names the hotkey picker emits that the Keys enum does not know.
            // Without these the fallback Enum.Parse below throws, the helper
            // exits before pressing anything, and the user dictates unmuted.
            // The picker's names come from KeyboardEvent.code, which identifies
            // a physical key position, and the Oem* members are position-based
            // too, so the pairing holds on non-US layouts.
            case "esc":
                key = Keys.Escape;
                break;
            case "backspace":
                key = Keys.Back;
                break;
            case "scrolllock":
                key = Keys.Scroll;
                break;
            case "num0":
                key = Keys.NumPad0;
                break;
            case "num1":
                key = Keys.NumPad1;
                break;
            case "num2":
                key = Keys.NumPad2;
                break;
            case "num3":
                key = Keys.NumPad3;
                break;
            case "num4":
                key = Keys.NumPad4;
                break;
            case "num5":
                key = Keys.NumPad5;
                break;
            case "num6":
                key = Keys.NumPad6;
                break;
            case "num7":
                key = Keys.NumPad7;
                break;
            case "num8":
                key = Keys.NumPad8;
                break;
            case "num9":
                key = Keys.NumPad9;
                break;
            case "numadd":
                key = Keys.Add;
                break;
            case "numsub":
                key = Keys.Subtract;
                break;
            case "nummult":
                key = Keys.Multiply;
                break;
            case "numdiv":
                key = Keys.Divide;
                break;
            case "numdec":
                key = Keys.Decimal;
                break;
            case "`":
                key = Keys.Oemtilde;
                break;
            case "-":
                key = Keys.OemMinus;
                break;
            case "=":
                key = Keys.Oemplus;
                break;
            case "[":
                key = Keys.OemOpenBrackets;
                break;
            case "]":
                key = Keys.OemCloseBrackets;
                break;
            case "\\":
                key = Keys.OemPipe;
                break;
            case ";":
                key = Keys.OemSemicolon;
                break;
            case "'":
                key = Keys.OemQuotes;
                break;
            case ",":
                key = Keys.Oemcomma;
                break;
            case ".":
                key = Keys.OemPeriod;
                break;
            case "/":
                key = Keys.OemQuestion;
                break;
        }

        if (key == Keys.None)
        {
            // Bare digits parse as the D-prefixed members of the Keys enum.
            if (normalized.Length == 1 && normalized[0] >= '0' && normalized[0] <= '9')
            {
                normalized = "D" + normalized;
            }

            try
            {
                key = (Keys)Enum.Parse(typeof(Keys), normalized, true);
            }
            catch (Exception)
            {
                return false;
            }
        }

        if (key == Keys.None)
        {
            return false;
        }

        input = new HeldInput();
        input.IsMouse = false;
        input.Key = key;
        return true;
    }

    /// Parses "Ctrl+Shift+M" into the key sequence to press, modifiers first so
    /// they are already down when the main key arrives.
    private static List<HeldInput> ParseCombination(string combination)
    {
        var result = new List<HeldInput>();
        if (string.IsNullOrEmpty(combination))
        {
            return result;
        }

        string[] parts = combination.Split('+');
        for (int i = 0; i < parts.Length; i++)
        {
            HeldInput parsed;
            if (!TryParseKeyToken(parts[i], out parsed))
            {
                return new List<HeldInput>();
            }
            result.Add(parsed);
        }
        return result;
    }

    // -----------------------------------------------------------------------
    // Input
    // -----------------------------------------------------------------------

    private static bool SendKeyEvent(HeldInput held, bool keyUp)
    {
        var input = new INPUT();

        if (held.IsMouse)
        {
            input.type = InputMouse;
            input.u.mi.dx = 0;
            input.u.mi.dy = 0;
            input.u.mi.mouseData = held.MouseData;
            input.u.mi.dwFlags = keyUp ? held.UpFlag : held.DownFlag;
            input.u.mi.time = 0;
            input.u.mi.dwExtraInfo = IntPtr.Zero;
        }
        else
        {
            input.type = InputKeyboard;
            input.u.ki.wVk = (ushort)held.Key;
            input.u.ki.wScan = 0;
            input.u.ki.dwFlags = keyUp ? KeyEventKeyUp : 0;
            if (ExtendedKeys.Contains(held.Key))
            {
                input.u.ki.dwFlags |= KeyEventExtendedKey;
            }
            input.u.ki.time = 0;
            input.u.ki.dwExtraInfo = IntPtr.Zero;
        }

        var inputs = new INPUT[] { input };
        return SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT))) == 1;
    }

    private static void PressAll(List<HeldInput> keys)
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
