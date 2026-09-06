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
            (string)method.Invoke(null, new object[] { read, timeout });

        string apartment = observe(() => Thread.CurrentThread.GetApartmentState().ToString(), 1000);
        if (apartment != "MTA") throw new Exception("Observation did not run in MTA");
        if (observe(() => "readable", 1000) != "readable") throw new Exception("Lost result");
        if (observe(() => { throw new Exception("unavailable provider"); }, 1000) != null)
            throw new Exception("Provider error was not contained");

        Stopwatch watch = Stopwatch.StartNew();
        string hung = observe(() => { Thread.Sleep(10000); return "late"; }, 50);
        if (hung != null || watch.ElapsedMilliseconds > 1000)
            throw new Exception("Hung provider blocked delivery");
        Console.Write("deadline-ok");
        return 0; // The timed-out worker must not keep this process alive.
    }
}
