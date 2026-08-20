// ConsoleWatchdog.exe
//
// Safety net for any remaining path that could create a visible console
// window inside the DeepSeek Harness process tree (e.g. a third-party MCP
// server spawning powershell/cmd without hiding), and hides Windows Terminal
// takeover windows whose title names a path under the app directory.
// Polls every ~25 ms.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class ConsoleWatchdog
{
    private delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumProc cb, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int max);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("kernel32.dll")]
    private static extern IntPtr CreateToolhelp32Snapshot(uint dwFlags, uint th32ProcessID);

    [DllImport("kernel32.dll")]
    private static extern bool Process32First(IntPtr hSnapshot, ref PROCESSENTRY32 lppe);

    [DllImport("kernel32.dll")]
    private static extern bool Process32Next(IntPtr hSnapshot, ref PROCESSENTRY32 lppe);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentProcessId();

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct PROCESSENTRY32
    {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szExeFile;
    }

    private const uint TH32CS_SNAPPROCESS = 0x00000002;
    private const int SW_HIDE = 0;
    private static readonly Dictionary<uint, uint> Parents = new Dictionary<uint, uint>();

    private static void Snapshot()
    {
        Parents.Clear();
        IntPtr snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snap == IntPtr.Zero) return;
        try
        {
            var entry = new PROCESSENTRY32();
            entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
            if (Process32First(snap, ref entry))
            {
                do
                {
                    Parents[entry.th32ProcessID] = entry.th32ParentProcessID;
                } while (Process32Next(snap, ref entry));
            }
        }
        finally
        {
            CloseHandle(snap);
        }
    }

    private static bool InTree(uint pid, uint root)
    {
        uint current = pid;
        for (int i = 0; i < 64 && current != 0; i++)
        {
            if (current == root) return true;
            uint parent;
            if (!Parents.TryGetValue(current, out parent)) return false;
            current = parent;
        }
        return false;
    }

    private static int Main(string[] args)
    {
        uint root;
        if (args.Length == 0 || !uint.TryParse(args[0], out root) || root == 0) return 1;
        string appDir = args.Length > 1 ? args[1] : "";
        if (appDir.Length > 0) appDir = appDir.Replace('/', '\\').ToLowerInvariant();
        DateTime lastSnapshot = DateTime.MinValue;
        // Record the Windows Terminal processes that already exist when the
        // app starts; any CASCADIA window owned by a NEW Windows Terminal
        // process is a console takeover by this app and gets hidden.
        Snapshot();
        var initialWt = new HashSet<uint>();
        foreach (var pair in Parents)
        {
            if (pair.Key == 0) continue;
            string exe = "";
            try { exe = System.Diagnostics.Process.GetProcessById((int)pair.Key).ProcessName; } catch { }
            if (exe.Equals("WindowsTerminal", StringComparison.OrdinalIgnoreCase)) initialWt.Add(pair.Key);
        }
        while (true)
        {
            if ((DateTime.UtcNow - lastSnapshot).TotalMilliseconds >= 300)
            {
                Snapshot();
                lastSnapshot = DateTime.UtcNow;
            }
            EnumWindows(delegate (IntPtr hWnd, IntPtr lParam)
            {
                if (!IsWindowVisible(hWnd)) return true;
                var cls = new StringBuilder(128);
                GetClassName(hWnd, cls, 128);
                string className = cls.ToString();
                bool isConsoleWindow =
                    className.IndexOf("ConsoleWindowClass", StringComparison.OrdinalIgnoreCase) >= 0 ||
                    className.IndexOf("CASCADIA", StringComparison.OrdinalIgnoreCase) >= 0 ||
                    className.IndexOf("conhost", StringComparison.OrdinalIgnoreCase) >= 0;
                if (!isConsoleWindow) return true;
                uint pid;
                GetWindowThreadProcessId(hWnd, out pid);
                bool inTree = pid != 0 && pid != GetCurrentProcessId() && InTree(pid, root);
                bool titleMatchesApp = false;
                bool newTerminalWindow = false;
                if (!inTree)
                {
                    if (appDir.Length > 0)
                    {
                        var title = new StringBuilder(512);
                        GetWindowText(hWnd, title, 512);
                        titleMatchesApp = title.ToString().ToLowerInvariant().IndexOf(appDir, StringComparison.Ordinal) >= 0;
                    }
                    if (!titleMatchesApp &&
                        className.IndexOf("CASCADIA", StringComparison.OrdinalIgnoreCase) >= 0 &&
                        pid != 0 && !initialWt.Contains(pid))
                    {
                        newTerminalWindow = true;
                    }
                }
                if (inTree || titleMatchesApp || newTerminalWindow)
                {
                    ShowWindow(hWnd, SW_HIDE);
                }
                return true;
            }, IntPtr.Zero);
            Thread.Sleep(25);
        }
    }
}
