// A fake voice call for the narrator's room check (narrator-room.live.ts).
//
// Compiled by the spec into a temp folder as discord.exe, so the narrator's
// meter takes it for Discord. It plays a quiet hum that talks and pauses on a
// fixed pattern, on an output device of its own choosing, and reports what it
// plays and what its own session volume is, so the spec can see when the
// narrator turned it down and put it back.
//
//   discord.exe --device=other|default|<name part> --pattern=4000:0.06,1500:0
//
// --device=other picks an active output that is not the default one (a
// headset's Chat output), and the default one when there is no other.
//
// Output, one JSON object per line on stdout:
//   {"event":"device","name":"...","isDefault":false}
//   {"event":"segment","at":<unix ms>,"level":0.06}  when a segment is heard
//   {"event":"volume","at":<unix ms>,"volume":1.000} when its session volume changes
//
// Exits when stdin closes, or after --seconds (default 600).

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Threading;

internal static class FakeVoiceCall
{
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    private class MMDeviceEnumerator { }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDeviceEnumerator
    {
        [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
        [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
    }

    [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDeviceCollection
    {
        [PreserveSig] int GetCount(out int count);
        [PreserveSig] int Item(int index, out IMMDevice device);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDevice
    {
        [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object instance);
        [PreserveSig] int OpenPropertyStore(int access, out IPropertyStore store);
        [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PropertyKey { public Guid fmtid; public int pid; }

    [StructLayout(LayoutKind.Sequential)]
    private struct PropVariant { public ushort vt; public ushort r1; public ushort r2; public ushort r3; public IntPtr p; public IntPtr p2; }

    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IPropertyStore
    {
        [PreserveSig] int GetCount(out int count);
        [PreserveSig] int GetAt(int index, out PropertyKey key);
        [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant value);
    }

    [ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioClient
    {
        [PreserveSig] int Initialize(int shareMode, int streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr sessionGuid);
        [PreserveSig] int GetBufferSize(out uint frames);
        [PreserveSig] int GetStreamLatency(out long latency);
        [PreserveSig] int GetCurrentPadding(out uint frames);
        [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);
        [PreserveSig] int GetMixFormat(out IntPtr format);
        [PreserveSig] int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
        [PreserveSig] int Start();
        [PreserveSig] int Stop();
        [PreserveSig] int Reset();
        [PreserveSig] int SetEventHandle(IntPtr handle);
        [PreserveSig] int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }

    [ComImport, Guid("F294ACFC-3146-4483-A7BF-ADDCA7C260E2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioRenderClient
    {
        [PreserveSig] int GetBuffer(uint frames, out IntPtr data);
        [PreserveSig] int ReleaseBuffer(uint frames, int flags);
    }

    [ComImport, Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface ISimpleAudioVolume
    {
        [PreserveSig] int SetMasterVolume(float level, IntPtr context);
        [PreserveSig] int GetMasterVolume(out float level);
    }

    private static readonly Guid FloatSubtype = new Guid("00000003-0000-0010-8000-00aa00389b71");

    private static string Arg(string[] args, string name, string fallback)
    {
        string prefix = "--" + name + "=";
        foreach (string arg in args)
        {
            if (arg.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) return arg.Substring(prefix.Length);
        }
        return fallback;
    }

    private static long Now()
    {
        return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
    }

    private static string Q(string text)
    {
        return "\"" + text.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
    }

    private static string Name(IMMDevice device)
    {
        IPropertyStore store;
        if (device.OpenPropertyStore(0, out store) != 0 || store == null) return "?";
        var key = new PropertyKey { fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), pid = 14 };
        PropVariant value;
        if (store.GetValue(ref key, out value) != 0 || value.vt != 31) return "?";
        return Marshal.PtrToStringUni(value.p);
    }

    private static IMMDevice PickDevice(string wanted, out bool isDefault)
    {
        var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
        IMMDevice fallback;
        Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(0, 1, out fallback));
        string defaultId;
        fallback.GetId(out defaultId);
        isDefault = true;
        if (wanted == "default") return fallback;
        IMMDeviceCollection devices;
        int count;
        Marshal.ThrowExceptionForHR(enumerator.EnumAudioEndpoints(0, 1, out devices));
        devices.GetCount(out count);
        for (int i = 0; i < count; i++)
        {
            IMMDevice device;
            if (devices.Item(i, out device) != 0) continue;
            string id;
            device.GetId(out id);
            bool match = wanted == "other"
                ? id != defaultId
                : Name(device).IndexOf(wanted, StringComparison.OrdinalIgnoreCase) >= 0;
            if (!match) continue;
            isDefault = id == defaultId;
            return device;
        }
        return fallback;
    }

    private static List<KeyValuePair<int, float>> ParsePattern(string raw)
    {
        var pattern = new List<KeyValuePair<int, float>>();
        foreach (string part in raw.Split(','))
        {
            string[] pair = part.Split(':');
            pattern.Add(new KeyValuePair<int, float>(
                int.Parse(pair[0], CultureInfo.InvariantCulture),
                float.Parse(pair[1], CultureInfo.InvariantCulture)));
        }
        return pattern;
    }

    private static int Main(string[] args)
    {
        var output = new System.IO.StreamWriter(Console.OpenStandardOutput());
        output.AutoFlush = true;
        Console.SetOut(output);

        var pattern = ParsePattern(Arg(args, "pattern", "4000:0.06,1500:0,3000:0.06,6000:0"));
        int seconds = int.Parse(Arg(args, "seconds", "600"), CultureInfo.InvariantCulture);

        var stdinWatch = new Thread(() =>
        {
            try { while (Console.In.ReadLine() != null) { } } catch (Exception) { }
            Environment.Exit(0);
        });
        stdinWatch.IsBackground = true;
        stdinWatch.Start();

        bool isDefault;
        var device = PickDevice(Arg(args, "device", "other"), out isDefault);
        Console.WriteLine("{\"event\":\"device\",\"name\":" + Q(Name(device)) + ",\"isDefault\":" + (isDefault ? "true" : "false") + "}");

        var clientIid = typeof(IAudioClient).GUID;
        object clientObject;
        Marshal.ThrowExceptionForHR(device.Activate(ref clientIid, 23, IntPtr.Zero, out clientObject));
        var client = (IAudioClient)clientObject;
        IntPtr format;
        Marshal.ThrowExceptionForHR(client.GetMixFormat(out format));
        int tag = (ushort)Marshal.ReadInt16(format, 0);
        int channels = Marshal.ReadInt16(format, 2);
        int rate = Marshal.ReadInt32(format, 4);
        int bits = Marshal.ReadInt16(format, 14);
        bool isFloat = tag == 3;
        if (tag == 0xFFFE)
        {
            var subtype = new byte[16];
            Marshal.Copy(new IntPtr(format.ToInt64() + 24), subtype, 0, 16);
            isFloat = new Guid(subtype) == FloatSubtype;
        }
        if (!(isFloat && bits == 32) && !(!isFloat && bits == 16))
        {
            Console.Error.WriteLine("Unsupported mix format: tag " + tag + ", " + bits + " bits");
            return 2;
        }
        // 100 ms of buffer: little enough that "heard at" stays close to "written at".
        Marshal.ThrowExceptionForHR(client.Initialize(0, 0, 1000000, 0, format, IntPtr.Zero));
        uint bufferFrames;
        client.GetBufferSize(out bufferFrames);
        var renderIid = typeof(IAudioRenderClient).GUID;
        object renderObject;
        Marshal.ThrowExceptionForHR(client.GetService(ref renderIid, out renderObject));
        var render = (IAudioRenderClient)renderObject;
        var volumeIid = typeof(ISimpleAudioVolume).GUID;
        object volumeObject;
        Marshal.ThrowExceptionForHR(client.GetService(ref volumeIid, out volumeObject));
        var volume = (ISimpleAudioVolume)volumeObject;

        long frame = 0;
        int segment = -1;
        long segmentEnd = 0;
        float level = 0f;
        float lastVolume = -1f;
        long stopAt = Now() + seconds * 1000L;
        var samples = new float[bufferFrames * channels];
        var shorts = new short[bufferFrames * channels];
        Marshal.ThrowExceptionForHR(client.Start());
        while (Now() < stopAt)
        {
            float current;
            if (volume.GetMasterVolume(out current) == 0 && Math.Abs(current - lastVolume) > 0.001f)
            {
                lastVolume = current;
                Console.WriteLine("{\"event\":\"volume\",\"at\":" + Now() + ",\"volume\":" + current.ToString("0.000", CultureInfo.InvariantCulture) + "}");
            }
            uint padding;
            client.GetCurrentPadding(out padding);
            uint free = bufferFrames - padding;
            if (free > 0)
            {
                IntPtr data;
                Marshal.ThrowExceptionForHR(render.GetBuffer(free, out data));
                long writtenAt = Now();
                for (uint i = 0; i < free; i++, frame++)
                {
                    if (frame >= segmentEnd)
                    {
                        segment = (segment + 1) % pattern.Count;
                        level = pattern[segment].Value;
                        segmentEnd = frame + (long)pattern[segment].Key * rate / 1000;
                        long heardAt = writtenAt + (padding + i) * 1000L / rate;
                        Console.WriteLine("{\"event\":\"segment\",\"at\":" + heardAt + ",\"level\":" + level.ToString("0.000", CultureInfo.InvariantCulture) + "}");
                    }
                    // Two tones, so it sounds like a hum rather than a test beep.
                    double t = (double)frame / rate;
                    float sample = (float)(level * (0.6 * Math.Sin(2 * Math.PI * 180 * t) + 0.4 * Math.Sin(2 * Math.PI * 270 * t)));
                    for (int c = 0; c < channels; c++)
                    {
                        samples[i * channels + c] = sample;
                        shorts[i * channels + c] = (short)(sample * 32767);
                    }
                }
                if (isFloat) Marshal.Copy(samples, 0, data, (int)free * channels);
                else Marshal.Copy(shorts, 0, data, (int)free * channels);
                render.ReleaseBuffer(free, 0);
            }
            Thread.Sleep(10);
        }
        client.Stop();
        return 0;
    }
}
