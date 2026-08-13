// Windows microphone capture-session watcher for PrivateTranscribe.
//
// Reports which processes currently hold a capture (microphone) audio session
// and whether that session is actively streaming. PrivateTranscribe uses this
// to tell whether you are actually in a voice call before it touches anything:
// muting Discord while you are only reading text chat would be worse than not
// having the feature at all.
//
// Output is one JSON object per line on stdout, emitted on startup and again
// whenever the set of active capture sessions changes:
//
//   {"sessions":[{"pid":1234,"name":"Discord","active":true}]}
//
// Only the process id, the executable base name, and the session state are
// read. Session display names and window titles are deliberately never
// reported: they routinely contain document names and other user content this
// helper has no reason to see.
//
// Why polling rather than IAudioSessionNotification: Microsoft documents that
// a session enumerator "might not be aware of the new sessions that are
// reported through IAudioSessionNotification", so an app relying on the
// enumerator alone can miss sessions. Rather than run both an enumerator and a
// COM callback and reconcile them, this helper builds a fresh enumerator on
// every poll, which observes new sessions by construction. A one second poll
// is far cheaper than the class of COM callback lifetime bugs it avoids.
//
// Built by scripts/build-windows-mic-watch.js with the in-box .NET Framework
// compiler, so contributors need no extra toolchain.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class WindowsMicWatch
{
    private const int DefaultPollMs = 1000;
    private const int MinPollMs = 250;

    // MMDeviceEnumerator data flow / state constants (mmdeviceapi.h)
    private const int ECapture = 1;
    private const int DeviceStateActive = 0x1;

    // AudioSessionState (audiosessiontypes.h)
    private const int AudioSessionStateActive = 1;

    private sealed class SessionInfo
    {
        public int Pid;
        public string Name;
        public bool Active;
    }

    // -----------------------------------------------------------------------
    // COM interop
    // -----------------------------------------------------------------------

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    private class MMDeviceEnumerator
    {
    }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDeviceEnumerator
    {
        [PreserveSig]
        int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
        [PreserveSig]
        int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
        // Remaining methods are unused but must be declared to keep the vtable
        // layout correct if they are ever added.
    }

    [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDeviceCollection
    {
        [PreserveSig]
        int GetCount(out int count);
        [PreserveSig]
        int Item(int index, out IMMDevice device);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDevice
    {
        [PreserveSig]
        int Activate(ref Guid iid, int clsCtx, IntPtr activationParams,
            [MarshalAs(UnmanagedType.IUnknown)] out object instance);
    }

    [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioSessionManager2
    {
        // IAudioSessionManager
        [PreserveSig]
        int GetAudioSessionControl(IntPtr sessionGuid, int streamFlags, out IntPtr sessionControl);
        [PreserveSig]
        int GetSimpleAudioVolume(IntPtr sessionGuid, int streamFlags, out IntPtr audioVolume);
        // IAudioSessionManager2
        [PreserveSig]
        int GetSessionEnumerator(out IAudioSessionEnumerator sessionEnum);
    }

    [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioSessionEnumerator
    {
        [PreserveSig]
        int GetCount(out int count);
        [PreserveSig]
        int GetSession(int index, out IAudioSessionControl session);
    }

    [ComImport, Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioSessionControl
    {
        [PreserveSig]
        int GetState(out int state);
        // The remaining IAudioSessionControl methods are intentionally not
        // declared. Everything else this helper needs comes from
        // IAudioSessionControl2, which it obtains by QueryInterface.
    }

    [ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioSessionControl2
    {
        // IAudioSessionControl
        [PreserveSig]
        int GetState(out int state);
        [PreserveSig]
        int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string displayName);
        [PreserveSig]
        int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string value, ref Guid eventContext);
        [PreserveSig]
        int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string iconPath);
        [PreserveSig]
        int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string value, ref Guid eventContext);
        [PreserveSig]
        int GetGroupingParam(out Guid groupingParam);
        [PreserveSig]
        int SetGroupingParam(ref Guid oldValue, ref Guid eventContext);
        [PreserveSig]
        int RegisterAudioSessionNotification(IntPtr newNotifications);
        [PreserveSig]
        int UnregisterAudioSessionNotification(IntPtr newNotifications);
        // IAudioSessionControl2
        [PreserveSig]
        int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string retVal);
        [PreserveSig]
        int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string retVal);
        [PreserveSig]
        int GetProcessId(out int retVal);
        [PreserveSig]
        int IsSystemSoundsSession();
        [PreserveSig]
        int SetDuckingPreference(bool optOut);
    }

    // -----------------------------------------------------------------------
    // Enumeration
    // -----------------------------------------------------------------------

    private static List<SessionInfo> ReadCaptureSessions()
    {
        var results = new List<SessionInfo>();
        IMMDeviceEnumerator deviceEnumerator = null;

        try
        {
            deviceEnumerator = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
        }
        catch (Exception)
        {
            // No audio subsystem available. Report an empty set rather than
            // dying: an absent watcher must never take dictation down with it.
            return results;
        }

        IMMDeviceCollection devices;
        if (deviceEnumerator.EnumAudioEndpoints(ECapture, DeviceStateActive, out devices) != 0 ||
            devices == null)
        {
            return results;
        }

        int deviceCount;
        if (devices.GetCount(out deviceCount) != 0)
        {
            return results;
        }

        var seenPids = new HashSet<int>();

        for (int i = 0; i < deviceCount; i++)
        {
            IMMDevice device;
            if (devices.Item(i, out device) != 0 || device == null)
            {
                continue;
            }

            try
            {
                CollectDeviceSessions(device, results, seenPids);
            }
            catch (Exception)
            {
                // One bad endpoint must not hide the others.
            }
        }

        return results;
    }

    private static void CollectDeviceSessions(IMMDevice device, List<SessionInfo> results,
        HashSet<int> seenPids)
    {
        var managerIid = typeof(IAudioSessionManager2).GUID;
        object managerObject;

        // CLSCTX_ALL
        if (device.Activate(ref managerIid, 23, IntPtr.Zero, out managerObject) != 0 ||
            managerObject == null)
        {
            return;
        }

        var manager = managerObject as IAudioSessionManager2;
        if (manager == null)
        {
            return;
        }

        IAudioSessionEnumerator sessions;
        if (manager.GetSessionEnumerator(out sessions) != 0 || sessions == null)
        {
            return;
        }

        int sessionCount;
        if (sessions.GetCount(out sessionCount) != 0)
        {
            return;
        }

        for (int i = 0; i < sessionCount; i++)
        {
            IAudioSessionControl control;
            if (sessions.GetSession(i, out control) != 0 || control == null)
            {
                continue;
            }

            var control2 = control as IAudioSessionControl2;
            if (control2 == null)
            {
                continue;
            }

            // S_OK means this is the system sounds session, which never
            // represents a voice app.
            if (control2.IsSystemSoundsSession() == 0)
            {
                continue;
            }

            int pid;
            if (control2.GetProcessId(out pid) != 0 || pid <= 0)
            {
                continue;
            }

            int state;
            if (control2.GetState(out state) != 0)
            {
                continue;
            }

            bool active = state == AudioSessionStateActive;

            // A process can hold more than one capture session, for example one
            // per input device. Collapse them, treating the process as active
            // if any of its sessions is streaming.
            if (seenPids.Contains(pid))
            {
                for (int j = 0; j < results.Count; j++)
                {
                    if (results[j].Pid == pid && active)
                    {
                        results[j].Active = true;
                    }
                }
                continue;
            }

            string name = ResolveProcessName(pid);
            if (name == null)
            {
                continue;
            }

            seenPids.Add(pid);
            var info = new SessionInfo();
            info.Pid = pid;
            info.Name = name;
            info.Active = active;
            results.Add(info);
        }
    }

    private static string ResolveProcessName(int pid)
    {
        try
        {
            using (var process = Process.GetProcessById(pid))
            {
                return process.ProcessName;
            }
        }
        catch (Exception)
        {
            // The process exited between enumeration and lookup, or is running
            // at a privilege level we cannot inspect. Either way it is not a
            // voice app we can act on.
            return null;
        }
    }

    // -----------------------------------------------------------------------
    // Output
    // -----------------------------------------------------------------------

    private static string EscapeJson(string value)
    {
        var builder = new StringBuilder(value.Length + 8);
        for (int i = 0; i < value.Length; i++)
        {
            char c = value[i];
            switch (c)
            {
                case '"':
                    builder.Append("\\\"");
                    break;
                case '\\':
                    builder.Append("\\\\");
                    break;
                case '\b':
                    builder.Append("\\b");
                    break;
                case '\f':
                    builder.Append("\\f");
                    break;
                case '\n':
                    builder.Append("\\n");
                    break;
                case '\r':
                    builder.Append("\\r");
                    break;
                case '\t':
                    builder.Append("\\t");
                    break;
                default:
                    if (c < ' ' || c > '~')
                    {
                        builder.Append("\\u");
                        builder.Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                    }
                    else
                    {
                        builder.Append(c);
                    }
                    break;
            }
        }
        return builder.ToString();
    }

    private static string Render(List<SessionInfo> sessions)
    {
        var builder = new StringBuilder();
        builder.Append("{\"sessions\":[");
        for (int i = 0; i < sessions.Count; i++)
        {
            if (i > 0)
            {
                builder.Append(',');
            }
            builder.Append("{\"pid\":");
            builder.Append(sessions[i].Pid.ToString(CultureInfo.InvariantCulture));
            builder.Append(",\"name\":\"");
            builder.Append(EscapeJson(sessions[i].Name));
            builder.Append("\",\"active\":");
            builder.Append(sessions[i].Active ? "true" : "false");
            builder.Append('}');
        }
        builder.Append("]}");
        return builder.ToString();
    }

    // -----------------------------------------------------------------------
    // Diagnostics
    // -----------------------------------------------------------------------

    private static void Diagnose()
    {
        IMMDeviceEnumerator deviceEnumerator;
        try
        {
            deviceEnumerator = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
        }
        catch (Exception ex)
        {
            Console.WriteLine("MMDeviceEnumerator failed: " + ex.Message);
            return;
        }

        IMMDeviceCollection devices;
        int hr = deviceEnumerator.EnumAudioEndpoints(ECapture, DeviceStateActive, out devices);
        Console.WriteLine("EnumAudioEndpoints hr=0x" + hr.ToString("x8", CultureInfo.InvariantCulture));
        if (hr != 0 || devices == null)
        {
            return;
        }

        int deviceCount;
        hr = devices.GetCount(out deviceCount);
        Console.WriteLine("capture endpoints: " + deviceCount.ToString(CultureInfo.InvariantCulture));

        for (int i = 0; i < deviceCount; i++)
        {
            IMMDevice device;
            if (devices.Item(i, out device) != 0 || device == null)
            {
                Console.WriteLine("  endpoint " + i + ": could not open");
                continue;
            }

            var managerIid = typeof(IAudioSessionManager2).GUID;
            object managerObject;
            hr = device.Activate(ref managerIid, 23, IntPtr.Zero, out managerObject);
            if (hr != 0 || managerObject == null)
            {
                Console.WriteLine("  endpoint " + i + ": Activate hr=0x" +
                    hr.ToString("x8", CultureInfo.InvariantCulture));
                continue;
            }

            var manager = (IAudioSessionManager2)managerObject;
            IAudioSessionEnumerator sessions;
            hr = manager.GetSessionEnumerator(out sessions);
            if (hr != 0 || sessions == null)
            {
                Console.WriteLine("  endpoint " + i + ": GetSessionEnumerator hr=0x" +
                    hr.ToString("x8", CultureInfo.InvariantCulture));
                continue;
            }

            int sessionCount;
            sessions.GetCount(out sessionCount);
            Console.WriteLine("  endpoint " + i + ": " + sessionCount + " session(s)");

            for (int j = 0; j < sessionCount; j++)
            {
                IAudioSessionControl control;
                if (sessions.GetSession(j, out control) != 0 || control == null)
                {
                    continue;
                }
                var control2 = control as IAudioSessionControl2;
                if (control2 == null)
                {
                    Console.WriteLine("    session " + j + ": no IAudioSessionControl2");
                    continue;
                }
                int pid = 0;
                control2.GetProcessId(out pid);
                int state = -1;
                control2.GetState(out state);
                int sysSounds = control2.IsSystemSoundsSession();
                string name = ResolveProcessName(pid);
                Console.WriteLine("    session " + j + ": pid=" + pid + " name=" +
                    (name == null ? "<unknown>" : name) + " state=" + state +
                    " systemSounds=" + (sysSounds == 0 ? "yes" : "no"));
            }
        }
    }

    // -----------------------------------------------------------------------
    // Entry point
    // -----------------------------------------------------------------------

    private static int ParsePollMs(string[] args)
    {
        for (int i = 0; i < args.Length; i++)
        {
            if (!args[i].StartsWith("--poll=", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }
            int parsed;
            if (int.TryParse(args[i].Substring(7), NumberStyles.Integer,
                    CultureInfo.InvariantCulture, out parsed))
            {
                return parsed < MinPollMs ? MinPollMs : parsed;
            }
        }
        return DefaultPollMs;
    }

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

    public static int Main(string[] args)
    {
        // Line-buffered so the parent sees each change immediately rather than
        // when a 4 KB buffer happens to fill.
        var output = new System.IO.StreamWriter(Console.OpenStandardOutput());
        output.AutoFlush = true;
        Console.SetOut(output);

        if (HasFlag(args, "--debug"))
        {
            // Prints the raw endpoint and session walk. Used to tell "found no
            // capture endpoints" apart from "found endpoints with no sessions",
            // which are very different problems on a user's machine.
            Diagnose();
            return 0;
        }

        if (HasFlag(args, "--once"))
        {
            Console.WriteLine(Render(ReadCaptureSessions()));
            return 0;
        }

        int pollMs = ParsePollMs(args);
        string previous = null;

        while (true)
        {
            string current;
            try
            {
                current = Render(ReadCaptureSessions());
            }
            catch (Exception)
            {
                // Never let a transient COM failure kill the watcher. The next
                // poll will report the real state.
                Thread.Sleep(pollMs);
                continue;
            }

            if (!string.Equals(current, previous, StringComparison.Ordinal))
            {
                Console.WriteLine(current);
                previous = current;
            }

            // Exit quietly when the parent closes our stdout, so the helper can
            // never outlive PrivateTranscribe.
            if (Console.Out == null)
            {
                return 0;
            }

            Thread.Sleep(pollMs);
        }
    }
}
