using System;
using System.Diagnostics;
using System.Reflection;
using System.Threading;

// Runs the production observation wrapper without reading the desktop,
// changing the clipboard, or sending keys.
internal static class PasteDeadlineProbe
{
    [STAThread]
    private static int Main()
    {
        MethodInfo method = typeof(WindowsFastPaste)
            .GetMethod("ObserveWithDeadline", BindingFlags.NonPublic | BindingFlags.Static)
            .MakeGenericMethod(typeof(string));
        Func<Func<string>, int, string> observe = (read, timeout) =>
            (string)method.Invoke(null, new object[] { read, timeout, ApartmentState.MTA });

        string apartment = observe(() => Thread.CurrentThread.GetApartmentState().ToString(), 1000);
        if (apartment != "MTA") throw new Exception("Observation did not run in MTA");
        if (observe(() => "readable", 1000) != "readable") throw new Exception("Lost result");
        if (observe(() => { throw new Exception("unavailable provider"); }, 1000) != null)
            throw new Exception("Provider error was not contained");

        Stopwatch watch = Stopwatch.StartNew();
        string hung = observe(() => { Thread.Sleep(10000); return "late"; }, 50);
        if (hung != null || watch.ElapsedMilliseconds > 1000)
            throw new Exception("Hung provider blocked delivery");

        MethodInfo clipboardMethod = typeof(WindowsFastPaste)
            .GetMethod("ReadClipboardWithDeadline", BindingFlags.NonPublic | BindingFlags.Static);
        Func<Func<string>, string> clipboard = read =>
            (string)clipboardMethod.Invoke(null, new object[] { read });
        if (clipboard(() => Thread.CurrentThread.GetApartmentState().ToString()) != "STA")
            throw new Exception("Clipboard did not run in STA");
        if (clipboard(() => "test text") != "test text")
            throw new Exception("Lost clipboard observation");
        if (clipboard(() => { throw new Exception("locked clipboard"); }) != string.Empty)
            throw new Exception("Clipboard error prevented delivery");
        watch.Restart();
        if (clipboard(() => { Thread.Sleep(10000); return "late clipboard"; }) != string.Empty
            || watch.ElapsedMilliseconds > 1000)
            throw new Exception("Hung clipboard blocked delivery");
        Console.Write("deadline-ok");
        return 0; // The timed-out worker must not keep this process alive.
    }
}
