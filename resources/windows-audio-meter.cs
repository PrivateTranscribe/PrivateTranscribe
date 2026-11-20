// Windows playback meter for PrivateTranscribe's agent narrator.
//
// Reports how loud the named apps are playing right now, so the narrator can
// wait for a pause in a voice call before it speaks: talking over a friend on
// Discord is exactly what it must not do.
//
//   windows-audio-meter.exe --apps=discord,ms-teams,zoom [--poll=50]
//
// Output is one JSON object per poll on stdout:
//
//   {"peak":0.0123,"sessions":1}
//
// peak is the highest meter reading, 0 to 1, across every playback session the
// named apps hold on every active output device. sessions counts those
// sessions; 0 means none of the apps has any playback open.
//
// Only the process id and the executable base name are read, as in
// windows-mic-watch. Session display names and window titles are never read.
//
// Sessions are looked up once a second and their meters read on every poll. A
// fresh enumerator per poll, as windows-mic-watch builds one, costs more than a
// 50 ms meter poll should.
//
// The helper exits when its stdin closes, so it can never outlive
// PrivateTranscribe.
//
// Built by scripts/build-windows-audio-meter.js with the in-box .NET Framework
// compiler, so contributors need no extra toolchain.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Threading;

internal static class WindowsAudioMeter
{
    private const int DefaultPollMs = 50;
    private const int MinPollMs = 20;
    private const int MaxPollMs = 1000;
    private const int RefreshMs = 1000;

    // MMDeviceEnumerator data flow / state constants (mmdeviceapi.h)
    private const int ERender = 0;
    private const int DeviceStateActive = 0x1;

    // -----------------------------------------------------------------------
    // COM interop, as declared in windows-mic-watch.cs, plus the meter.
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

    [ComImport, Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioMeterInformation
    {
        [PreserveSig]
        int GetPeakValue(out float peak);
        [PreserveSig]
        int GetMeteringChannelCount(out int channelCount);
        [PreserveSig]
        int GetChannelsPeakValues(int channelCount, [Out] float[] peakValues);
        [PreserveSig]
        int QueryHardwareSupport(out int hardwareSupportMask);
    }

    // -----------------------------------------------------------------------
    // Finding the named apps' sessions
    // -----------------------------------------------------------------------

    private static readonly Dictionary<int, string> NameCache = new Dictionary<int, string>();

    private static List<IAudioMeterInformation> FindMeters(HashSet<string> apps)
    {
        var meters = new List<IAudioMeterInformation>();
        IMMDeviceEnumerator deviceEnumerator;
        try
        {
            deviceEnumerator = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
        }
        catch (Exception)
        {
            return meters;
        }

        IMMDeviceCollection devices;
        int deviceCount;
        if (deviceEnumerator.EnumAudioEndpoints(ERender, DeviceStateActive, out devices) != 0 ||
            devices == null || devices.GetCount(out deviceCount) != 0)
        {
            return meters;
        }

        for (int i = 0; i < deviceCount; i++)
        {
            IMMDevice device;
            if (devices.Item(i, out device) != 0 || device == null)
            {
                continue;
            }
            try
            {
                CollectDeviceMeters(device, apps, meters);
            }
            catch (Exception)
            {
                // One bad endpoint must not hide the others.
            }
        }
        return meters;
    }

    private static void CollectDeviceMeters(IMMDevice device, HashSet<string> apps,
        List<IAudioMeterInformation> meters)
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
        IAudioSessionEnumerator sessions;
        int sessionCount;
        if (manager == null || manager.GetSessionEnumerator(out sessions) != 0 || sessions == null ||
            sessions.GetCount(out sessionCount) != 0)
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
            int pid;
            // S_OK from IsSystemSoundsSession means it is the system sounds session.
            if (control2 == null || control2.IsSystemSoundsSession() == 0 ||
                control2.GetProcessId(out pid) != 0 || pid <= 0)
            {
                continue;
            }
            string name = ResolveProcessName(pid);
            if (name == null || !apps.Contains(name.ToLowerInvariant()))
            {
                continue;
            }
            var meter = control as IAudioMeterInformation;
            if (meter != null)
            {
                meters.Add(meter);
            }
        }
    }

    private static string ResolveProcessName(int pid)
    {
        string cached;
        if (NameCache.TryGetValue(pid, out cached))
        {
            return cached;
        }
        string name = null;
        try
        {
            using (var process = Process.GetProcessById(pid))
            {
                name = process.ProcessName;
            }
        }
        catch (Exception)
        {
            // Exited between enumeration and lookup, or out of reach. Not one
            // of the apps either way.
        }
        if (NameCache.Count > 512)
        {
            NameCache.Clear();
        }
        NameCache[pid] = name;
        return name;
    }

    private static void Release(List<IAudioMeterInformation> meters)
    {
        foreach (var meter in meters)
        {
            try
            {
                Marshal.ReleaseComObject(meter);
            }
            catch (Exception)
            {
                // Already gone.
            }
        }
        meters.Clear();
    }

    // -----------------------------------------------------------------------
    // Entry point
    // -----------------------------------------------------------------------

    private static string ArgValue(string[] args, string name)
    {
        string prefix = "--" + name + "=";
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i].StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            {
                return args[i].Substring(prefix.Length);
            }
        }
        return null;
    }

    private static HashSet<string> ParseApps(string[] args)
    {
        var apps = new HashSet<string>();
        string raw = ArgValue(args, "apps") ?? "";
        foreach (string part in raw.Split(','))
        {
            string app = part.Trim().ToLowerInvariant();
            if (app.EndsWith(".exe", StringComparison.Ordinal))
            {
                app = app.Substring(0, app.Length - 4);
            }
            if (app.Length > 0)
            {
                apps.Add(app);
            }
        }
        return apps;
    }

    private static int ParsePollMs(string[] args)
    {
        int parsed;
        string raw = ArgValue(args, "poll");
        if (raw == null || !int.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out parsed))
        {
            return DefaultPollMs;
        }
        return Math.Max(MinPollMs, Math.Min(MaxPollMs, parsed));
    }

    public static int Main(string[] args)
    {
        // Flushed per line, so the narrator sees each reading as it is taken.
        var output = new System.IO.StreamWriter(Console.OpenStandardOutput());
        output.AutoFlush = true;
        Console.SetOut(output);

        var apps = ParseApps(args);
        int pollMs = ParsePollMs(args);

        // The parent holds our stdin open for as long as it wants readings.
        var stdinWatch = new Thread(() =>
        {
            try
            {
                while (Console.In.ReadLine() != null)
                {
                }
            }
            catch (Exception)
            {
                // A broken pipe means the same as a closed one.
            }
            Environment.Exit(0);
        });
        stdinWatch.IsBackground = true;
        stdinWatch.Start();

        var meters = new List<IAudioMeterInformation>();
        var refreshed = DateTime.MinValue;
        while (true)
        {
            try
            {
                if ((DateTime.UtcNow - refreshed).TotalMilliseconds >= RefreshMs)
                {
                    Release(meters);
                    meters = FindMeters(apps);
                    refreshed = DateTime.UtcNow;
                }
                float peak = 0f;
                int live = 0;
                foreach (var meter in meters)
                {
                    float value;
                    if (meter.GetPeakValue(out value) != 0)
                    {
                        continue;
                    }
                    live++;
                    if (value > peak)
                    {
                        peak = value;
                    }
                }
                Console.WriteLine("{\"peak\":" + peak.ToString("0.0000", CultureInfo.InvariantCulture) +
                    ",\"sessions\":" + live.ToString(CultureInfo.InvariantCulture) + "}");
            }
            catch (Exception)
            {
                // A session that went away mid-read: look the sessions up again.
                refreshed = DateTime.MinValue;
            }
            Thread.Sleep(pollMs);
        }
    }
}
