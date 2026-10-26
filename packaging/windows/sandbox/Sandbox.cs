// versum-sandbox.exe — the Windows job sandbox for versum-node (v0.4.0). No administrator, no driver, no WSL.
//
// Built on the release runner with the C# compiler that ships inside every Windows 10/11
// (%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe); it needs nothing but .NET Framework 4.x, which
// is part of the operating system. Single file, ~30 KB.
//
//   versum-sandbox.exe probe
//       Creates and deletes a throw-away AppContainer profile; prints {"appcontainer":true} or the error.
//   versum-sandbox.exe grant-read --dir <path>
//       Gives "ALL APPLICATION PACKAGES" read+execute on a tree (the Python runtime), once, inheritable.
//   versum-sandbox.exe run --name <profile> --dir <jobDir> --memory-mb N --cpu-cores N --timeout-s N --meta <file> -- <exe> <args…>
//       1. CreateAppContainerProfile(name) with ZERO capabilities → a SID that may touch only what is granted to it.
//          No capability = no network of any kind (not even loopback), no user files, no other processes.
//       2. Grants that SID full control of <jobDir> (inheritable: in/, out/, tmp/ and every file already there).
//       3. A Job Object: JobMemoryLimit = N MB, ActiveProcessLimit = 64, CPU hard cap = cores / machine cores,
//          KILL_ON_JOB_CLOSE (if this helper dies, everything inside dies with it), DIE_ON_UNHANDLED_EXCEPTION.
//       4. CreateProcess with PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES (the AppContainer), CREATE_SUSPENDED,
//          the helper's own environment (the node built it: nothing of the user's), cwd = <jobDir>, stdin/stdout/
//          stderr inherited from the helper (the node reads them). Assigned to the job, then resumed.
//       5. Waits. Every second it writes <meta> = {"cpu_seconds","peak_memory_mb","processes"} from the job's
//          accounting. At --timeout-s it terminates the job (exit 124). Exits with the child's exit code.
//       6. Deletes nothing itself: the node calls `delete --name` after the directory is wiped.
//   versum-sandbox.exe run --mode jobobject … (0.4.6 — GPU jobs only, and only when the AppContainer probe said `blocked`)
//       The same Job Object around a process started with a RESTRICTED TOKEN instead of an AppContainer:
//       CreateRestrictedToken(DISABLE_MAX_PRIVILEGE, restricting SID = RESTRICTED S-1-5-12) — the process may touch only
//       objects whose DACL grants RESTRICTED (Windows and System32 do by default; grant-read adds it to the Python tree and
//       the package folders; the job directory gets it; the user's profile does not) — lowered to LOW integrity (no write to
//       anything labelled medium);
//       the job directory is labelled Low and granted to RESTRICTED. A restricted token still has a network stack, so
//       `firewall-block` (below, administrator, once) blocks the embedded interpreter outbound. What this mode gives
//       up against the AppContainer is the object namespace isolation; what it may give back is the driver's door.
//   versum-sandbox.exe firewall-block --exe <python.exe>     (administrator) outbound block rule for the interpreter, idempotent
//   versum-sandbox.exe firewall-status --exe <python.exe>    {"blocked":true|false}
//   versum-sandbox.exe delete --name <profile>
//       DeleteAppContainerProfile — the SID is gone, the ACL entries on the (already deleted) directory with it.
//   versum-sandbox.exe cleanup --list <file>
//       Deletes every profile named in the file (one per line) — the uninstaller's call.
//
// Everything it prints about itself goes to stderr prefixed "[sandbox]" so the node can tell it from the job's
// own stderr. The job's output passes through untouched.
using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;

static class Native
{
    [DllImport("userenv.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern int CreateAppContainerProfile(string pszAppContainerName, string pszDisplayName, string pszDescription, IntPtr pCapabilities, uint dwCapabilityCount, out IntPtr ppSidAppContainerSid);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern int DeriveAppContainerSidFromAppContainerName(string pszAppContainerName, out IntPtr ppsidAppContainerSid);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern int DeleteAppContainerProfile(string pszAppContainerName);
    [DllImport("advapi32.dll")]
    public static extern IntPtr FreeSid(IntPtr pSid);

    [StructLayout(LayoutKind.Sequential)]
    public struct SECURITY_CAPABILITIES { public IntPtr AppContainerSid; public IntPtr Capabilities; public uint CapabilityCount; public uint Reserved; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFO
    {
        public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

    public const int STARTF_USESTDHANDLES = 0x100;
    public const int STD_INPUT_HANDLE = -10, STD_OUTPUT_HANDLE = -11, STD_ERROR_HANDLE = -12;
    public const uint EXTENDED_STARTUPINFO_PRESENT = 0x80000, CREATE_SUSPENDED = 0x4, CREATE_UNICODE_ENVIRONMENT = 0x400, CREATE_NO_WINDOW = 0x8000000, CREATE_BREAKAWAY_FROM_JOB = 0x1000000;
    public static readonly IntPtr PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES = (IntPtr)0x20009;

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool InitializeProcThreadAttributeList(IntPtr lpAttributeList, int dwAttributeCount, int dwFlags, ref IntPtr lpSize);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool UpdateProcThreadAttribute(IntPtr lpAttributeList, uint dwFlags, IntPtr attribute, IntPtr lpValue, IntPtr cbSize, IntPtr lpPreviousValue, IntPtr lpReturnSize);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern void DeleteProcThreadAttributeList(IntPtr lpAttributeList);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CreateProcess(string lpApplicationName, StringBuilder lpCommandLine, IntPtr lpProcessAttributes, IntPtr lpThreadAttributes, bool bInheritHandles, uint dwCreationFlags, IntPtr lpEnvironment, string lpCurrentDirectory, ref STARTUPINFOEX lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr GetStdHandle(int nStdHandle);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetHandleInformation(IntPtr hObject, uint dwMask, uint dwFlags);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint ResumeThread(IntPtr hThread);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr hObject);

    // job objects
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetInformationJobObject(IntPtr hJob, int JobObjectInfoClass, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool QueryInformationJobObject(IntPtr hJob, int JobObjectInfoClass, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength, out uint lpReturnLength);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool TerminateJobObject(IntPtr hJob, uint uExitCode);

    // 0.4.6 restricted token
    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern bool OpenProcessToken(IntPtr ProcessHandle, uint DesiredAccess, out IntPtr TokenHandle);
    [DllImport("kernel32.dll")]
    public static extern IntPtr GetCurrentProcess();
    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern bool CreateRestrictedToken(IntPtr ExistingTokenHandle, uint Flags, uint DisableSidCount, IntPtr SidsToDisable, uint DeletePrivilegeCount, IntPtr PrivilegesToDelete, uint RestrictedSidCount, IntPtr SidsToRestrict, out IntPtr NewTokenHandle);
    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern bool SetTokenInformation(IntPtr TokenHandle, int TokenInformationClass, IntPtr TokenInformation, uint TokenInformationLength);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool ConvertStringSidToSid(string StringSid, out IntPtr ptrSid);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CreateProcessAsUser(IntPtr hToken, string lpApplicationName, StringBuilder lpCommandLine, IntPtr lpProcessAttributes, IntPtr lpThreadAttributes, bool bInheritHandles, uint dwCreationFlags, IntPtr lpEnvironment, string lpCurrentDirectory, ref STARTUPINFOEX lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);
    [DllImport("kernel32.dll")]
    public static extern IntPtr LocalFree(IntPtr hMem);
    public const uint TOKEN_ALL_ACCESS = 0xF01FF, DISABLE_MAX_PRIVILEGE = 0x1, SE_GROUP_INTEGRITY = 0x20;
    public const int TokenIntegrityLevel = 25;
    [StructLayout(LayoutKind.Sequential)]
    public struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }

    public const int JobObjectBasicAccountingInformation = 1, JobObjectExtendedLimitInformation = 9, JobObjectCpuRateControlInformation = 15;
    public const uint JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 0x8, JOB_OBJECT_LIMIT_JOB_MEMORY = 0x200, JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION = 0x400, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    public const uint JOB_OBJECT_CPU_RATE_CONTROL_ENABLE = 0x1, JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP = 0x4;

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct IO_COUNTERS { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_CPU_RATE_CONTROL_INFORMATION { public uint ControlFlags; public uint CpuRate; }
    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
    {
        public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
    }
}

static class Program
{
    static void Say(string s) { try { Console.Error.WriteLine("[sandbox] " + s); } catch { } }
    static string Json(string s) { return "\"" + s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", " ").Replace("\n", " ") + "\""; }

    static int Main(string[] args)
    {
        try
        {
            if (args.Length == 0) { Console.Error.WriteLine("usage: versum-sandbox probe | grant-read --dir D | run [--mode appcontainer|jobobject] --name N --dir D --memory-mb M --cpu-cores C --timeout-s T --meta F -- exe args… | firewall-block --exe P | firewall-status --exe P | delete --name N | cleanup --list F"); return 2; }
            switch (args[0])
            {
                case "probe": return Probe();
                case "grant-read": return GrantRead(Opt(args, "--dir"));
                case "run": return Run(args);
                case "firewall-block": return Firewall(Opt(args, "--exe"), true);
                case "firewall-status": return Firewall(Opt(args, "--exe"), false);
                case "delete": return Delete(Opt(args, "--name"));
                case "cleanup": return Cleanup(Opt(args, "--list"));
                default: Console.Error.WriteLine("unknown command " + args[0]); return 2;
            }
        }
        catch (Exception e) { Say("fatal: " + e.Message); return 3; }
    }

    static string Opt(string[] args, string name)
    {
        for (int i = 1; i + 1 < args.Length; i++) { if (args[i] == "--") break; if (args[i] == name) return args[i + 1]; }
        throw new ArgumentException(name + " is required");
    }
    static string OptOr(string[] args, string name, string dflt)
    {
        for (int i = 1; i + 1 < args.Length; i++) { if (args[i] == "--") break; if (args[i] == name) return args[i + 1]; }
        return dflt;
    }

    // ── 0.4.6: the outbound firewall rule for the embedded interpreter (restricted-token mode has a network stack) ──
    const string RULE = "versum-node: no network for the job interpreter";
    static bool IsAdmin() { try { return new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator); } catch { return false; } }
    static string Netsh(string argsLine, out int code)
    {
        var psi = new System.Diagnostics.ProcessStartInfo("netsh", argsLine) { UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true };
        using (var p = System.Diagnostics.Process.Start(psi)) { string o = p.StandardOutput.ReadToEnd() + p.StandardError.ReadToEnd(); p.WaitForExit(60000); code = p.ExitCode; return o; }
    }
    static int Firewall(string exe, bool add)
    {
        string full = Path.GetFullPath(exe);
        int code;
        string show = Netsh("advfirewall firewall show rule name=\"" + RULE + "\" verbose", out code);
        bool present = code == 0 && show.IndexOf(full, StringComparison.OrdinalIgnoreCase) >= 0 && show.IndexOf("Block", StringComparison.OrdinalIgnoreCase) >= 0;
        if (!add) { Console.Out.WriteLine("{\"blocked\":" + (present ? "true" : "false") + ",\"rule\":" + Json(RULE) + ",\"exe\":" + Json(full) + "}"); return present ? 0 : 1; }
        if (present) { Console.Out.WriteLine("{\"blocked\":true,\"changed\":false}"); return 0; }
        if (!IsAdmin()) { Console.Out.WriteLine("{\"blocked\":false,\"error\":\"administrator rights are needed once to add the firewall rule\"}"); return 5; }
        Netsh("advfirewall firewall delete rule name=\"" + RULE + "\"", out code);   // a stale rule for an older path
        string outp = Netsh("advfirewall firewall add rule name=\"" + RULE + "\" dir=out action=block program=\"" + full + "\" enable=yes profile=any", out code);
        if (code != 0) { Console.Out.WriteLine("{\"blocked\":false,\"error\":" + Json(outp.Trim()) + "}"); return 1; }
        Say("firewall: outbound traffic of " + full + " is blocked (" + RULE + ")");
        Console.Out.WriteLine("{\"blocked\":true,\"changed\":true}");
        return 0;
    }

    // ── 0.4.6: the restricted, low-integrity token (restricting SID: RESTRICTED) ──
    static IntPtr RestrictedToken()
    {
        IntPtr tok;
        if (!Native.OpenProcessToken(Native.GetCurrentProcess(), Native.TOKEN_ALL_ACCESS, out tok)) throw new Win32Exception(Marshal.GetLastWin32Error(), "OpenProcessToken failed (win32 " + Marshal.GetLastWin32Error() + ")");
        // restricting SIDs: RESTRICTED only. An app-package SID (S-1-15-2-1) is refused by CreateRestrictedToken (seen on CI:
        // ERROR_INVALID_PARAMETER), so grant-read gives the Python tree RESTRICTED read+execute beside ALL APPLICATION PACKAGES;
        // Windows and System32 grant RESTRICTED by default, the user's profile does not.
        IntPtr sidRestricted;
        if (!Native.ConvertStringSidToSid("S-1-5-12", out sidRestricted)) throw new Win32Exception();
        var arr = new Native.SID_AND_ATTRIBUTES[] { new Native.SID_AND_ATTRIBUTES { Sid = sidRestricted, Attributes = 0 } };
        int one = Marshal.SizeOf(typeof(Native.SID_AND_ATTRIBUTES));
        IntPtr p = Marshal.AllocHGlobal(one * arr.Length);
        for (int i = 0; i < arr.Length; i++) Marshal.StructureToPtr(arr[i], (IntPtr)((long)p + i * one), false);
        IntPtr restricted;
        bool ok = Native.CreateRestrictedToken(tok, Native.DISABLE_MAX_PRIVILEGE, 0, IntPtr.Zero, 0, IntPtr.Zero, (uint)arr.Length, p, out restricted);
        int err = Marshal.GetLastWin32Error();
        Marshal.FreeHGlobal(p); Native.LocalFree(sidRestricted); Native.CloseHandle(tok);
        if (!ok) throw new Win32Exception(err, "CreateRestrictedToken failed (win32 " + err + ": " + new Win32Exception(err).Message + ")");
        // low integrity: S-1-16-4096
        IntPtr low;
        if (!Native.ConvertStringSidToSid("S-1-16-4096", out low)) throw new Win32Exception();
        var label = new Native.SID_AND_ATTRIBUTES { Sid = low, Attributes = Native.SE_GROUP_INTEGRITY };
        IntPtr lp = Marshal.AllocHGlobal(one);
        Marshal.StructureToPtr(label, lp, false);
        ok = Native.SetTokenInformation(restricted, Native.TokenIntegrityLevel, lp, (uint)one);
        err = Marshal.GetLastWin32Error();
        Marshal.FreeHGlobal(lp); Native.LocalFree(low);
        if (!ok) throw new Win32Exception(err, "SetTokenInformation(TokenIntegrityLevel) failed (win32 " + err + ")");
        return restricted;
    }
    static void LabelLow(string dir)
    {
        // a low-integrity process may write only into objects labelled Low: icacls ships with every Windows
        var psi = new System.Diagnostics.ProcessStartInfo("icacls", "\"" + dir + "\" /setintegritylevel (OI)(CI)L") { UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true };
        using (var pr = System.Diagnostics.Process.Start(psi)) { string o = pr.StandardOutput.ReadToEnd() + pr.StandardError.ReadToEnd(); pr.WaitForExit(60000); if (pr.ExitCode != 0) throw new Exception("icacls /setintegritylevel failed: " + o.Trim()); }
    }

    // ── the AppContainer SID (created, or derived when the profile already exists) ──
    static IntPtr ProfileSid(string name, bool create)
    {
        IntPtr sid;
        if (create)
        {
            int hr = Native.CreateAppContainerProfile(name, name, "versum-node job sandbox", IntPtr.Zero, 0, out sid);
            if (hr == 0) return sid;
            // 0x800700B7 = HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS): a previous run of this attempt; reuse the profile
            if ((uint)hr != 0x800700B7) throw new Win32Exception(hr, "CreateAppContainerProfile failed: 0x" + hr.ToString("X8"));
        }
        int hr2 = Native.DeriveAppContainerSidFromAppContainerName(name, out sid);
        if (hr2 != 0) throw new Win32Exception(hr2, "DeriveAppContainerSidFromAppContainerName failed: 0x" + hr2.ToString("X8"));
        return sid;
    }

    static int Probe()
    {
        string name = "versum-probe-" + Guid.NewGuid().ToString("N");
        try
        {
            IntPtr sid = ProfileSid(name, true);
            string s = new SecurityIdentifier(sid).Value;
            Native.FreeSid(sid);
            Native.DeleteAppContainerProfile(name);
            Console.Out.WriteLine("{\"appcontainer\":true,\"sid\":" + Json(s) + "}");
            return 0;
        }
        catch (Exception e) { Console.Out.WriteLine("{\"appcontainer\":false,\"error\":" + Json(e.Message) + "}"); return 1; }
    }

    static int GrantRead(string dir)
    {
        // S-1-15-2-1 = ALL APPLICATION PACKAGES: every AppContainer may read and execute this tree (the Python runtime)
        // 0.4.6: and RESTRICTED (S-1-5-12), so the restricted-token mode's interpreter can read the same tree
        var di = new DirectoryInfo(dir);
        if (!di.Exists) throw new DirectoryNotFoundException(dir);
        var acl = di.GetAccessControl();
        foreach (var s in new[] { "S-1-15-2-1", "S-1-5-12" })
            acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(s), FileSystemRights.ReadAndExecute | FileSystemRights.Synchronize, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        di.SetAccessControl(acl);   // propagates the inheritable entries to everything already inside
        Say("granted ALL APPLICATION PACKAGES and RESTRICTED read+execute on " + dir);
        return 0;
    }

    static int Delete(string name)
    {
        int hr = Native.DeleteAppContainerProfile(name);
        if (hr != 0) { Say("DeleteAppContainerProfile " + name + ": 0x" + hr.ToString("X8")); return 1; }
        return 0;
    }

    static int Cleanup(string list)
    {
        if (!File.Exists(list)) return 0;
        int n = 0;
        foreach (var line in File.ReadAllLines(list)) { var name = line.Trim(); if (name.StartsWith("versum-job-")) { Native.DeleteAppContainerProfile(name); n++; } }
        try { File.Delete(list); } catch { }
        Say("deleted " + n + " profile(s)");
        return 0;
    }

    static string Quote(string a)
    {
        // the Windows command-line convention CreateProcess/CommandLineToArgvW agrees on
        if (a.Length > 0 && a.IndexOfAny(new[] { ' ', '\t', '"', '\n' }) < 0) return a;
        var sb = new StringBuilder("\"");
        int bs = 0;
        foreach (char c in a)
        {
            if (c == '\\') { bs++; continue; }
            if (c == '"') { sb.Append('\\', bs * 2 + 1).Append('"'); bs = 0; continue; }
            sb.Append('\\', bs).Append(c); bs = 0;
        }
        sb.Append('\\', bs * 2).Append('"');
        return sb.ToString();
    }

    static IntPtr EnvironmentBlock()
    {
        // this process's environment, as the node built it; sorted, Unicode, double-NUL terminated
        var keys = new List<string>();
        var env = Environment.GetEnvironmentVariables();
        foreach (DictionaryEntry e in env) keys.Add((string)e.Key);
        keys.Sort(StringComparer.OrdinalIgnoreCase);
        var sb = new StringBuilder();
        foreach (var k in keys) sb.Append(k).Append('=').Append((string)env[k]).Append('\0');
        sb.Append('\0');
        return Marshal.StringToHGlobalUni(sb.ToString());
    }

    static int Run(string[] args)
    {
        string name = Opt(args, "--name"), dir = Opt(args, "--dir"), metaFile = Opt(args, "--meta"), mode = OptOr(args, "--mode", "appcontainer");
        if (mode != "appcontainer" && mode != "jobobject") throw new ArgumentException("--mode must be appcontainer or jobobject");
        int memoryMb = int.Parse(Opt(args, "--memory-mb")), cores = int.Parse(Opt(args, "--cpu-cores")), timeoutS = int.Parse(Opt(args, "--timeout-s"));
        int dash = Array.IndexOf(args, "--");
        if (dash < 0 || dash + 1 >= args.Length) throw new ArgumentException("-- <exe> <args…> is required");
        var cmd = new string[args.Length - dash - 1];
        Array.Copy(args, dash + 1, cmd, 0, cmd.Length);
        if (!Directory.Exists(dir)) throw new DirectoryNotFoundException(dir);

        // 1 — the identity: an AppContainer profile, or (0.4.6, --mode jobobject) a restricted low-integrity token
        IntPtr sid = IntPtr.Zero, token = IntPtr.Zero;
        SecurityIdentifier sidObj;
        if (mode == "appcontainer")
        {
            sid = ProfileSid(name, true);
            sidObj = new SecurityIdentifier(sid);
            Say("AppContainer " + name + " = " + sidObj.Value + " (no capabilities)");
        }
        else
        {
            token = RestrictedToken();
            sidObj = new SecurityIdentifier("S-1-5-12");   // RESTRICTED: what the job directory is granted to
            Say("restricted token: restricting SID RESTRICTED, low integrity, no privileges");
        }

        // 2 — the one place it may write
        var di = new DirectoryInfo(dir);
        var acl = di.GetAccessControl();
        acl.AddAccessRule(new FileSystemAccessRule(sidObj, FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        di.SetAccessControl(acl);
        if (mode == "jobobject") LabelLow(dir);

        // 3 — the job object
        IntPtr job = Native.CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Win32Exception();
        var ext = new Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        ext.BasicLimitInformation.LimitFlags = Native.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | Native.JOB_OBJECT_LIMIT_JOB_MEMORY | Native.JOB_OBJECT_LIMIT_ACTIVE_PROCESS | Native.JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
        ext.BasicLimitInformation.ActiveProcessLimit = 64;
        ext.JobMemoryLimit = (UIntPtr)((ulong)memoryMb * 1024UL * 1024UL);
        SetJob(job, Native.JobObjectExtendedLimitInformation, ext);
        int machineCores = Math.Max(1, Environment.ProcessorCount);
        uint rate = (uint)Math.Max(100, Math.Min(10000, (long)cores * 10000L / machineCores));   // in 1/100 of a percent of all cores
        var cpu = new Native.JOBOBJECT_CPU_RATE_CONTROL_INFORMATION { ControlFlags = Native.JOB_OBJECT_CPU_RATE_CONTROL_ENABLE | Native.JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP, CpuRate = rate };
        try { SetJob(job, Native.JobObjectCpuRateControlInformation, cpu); } catch (Exception e) { Say("cpu rate cap not applied: " + e.Message); }
        Say("job object: memory " + memoryMb + " MB, cpu " + cores + "/" + machineCores + " cores (" + (rate / 100.0) + "%), 64 processes, kill on close");

        // 4 — the process
        IntPtr scPtr = IntPtr.Zero, list = IntPtr.Zero;
        if (mode == "appcontainer")
        {
            var sc = new Native.SECURITY_CAPABILITIES { AppContainerSid = sid, Capabilities = IntPtr.Zero, CapabilityCount = 0, Reserved = 0 };
            scPtr = Marshal.AllocHGlobal(Marshal.SizeOf(sc));
            Marshal.StructureToPtr(sc, scPtr, false);
            IntPtr size = IntPtr.Zero;
            Native.InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
            list = Marshal.AllocHGlobal(size);
            if (!Native.InitializeProcThreadAttributeList(list, 1, 0, ref size)) throw new Win32Exception();
            if (!Native.UpdateProcThreadAttribute(list, 0, Native.PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, scPtr, (IntPtr)Marshal.SizeOf(sc), IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception();
        }

        var siex = new Native.STARTUPINFOEX();
        siex.StartupInfo.cb = mode == "appcontainer" ? Marshal.SizeOf(siex) : Marshal.SizeOf(typeof(Native.STARTUPINFO));
        siex.StartupInfo.dwFlags = Native.STARTF_USESTDHANDLES;
        siex.StartupInfo.hStdInput = Native.GetStdHandle(Native.STD_INPUT_HANDLE);
        siex.StartupInfo.hStdOutput = Native.GetStdHandle(Native.STD_OUTPUT_HANDLE);
        siex.StartupInfo.hStdError = Native.GetStdHandle(Native.STD_ERROR_HANDLE);
        foreach (var h in new[] { siex.StartupInfo.hStdInput, siex.StartupInfo.hStdOutput, siex.StartupInfo.hStdError }) if (h != IntPtr.Zero && h != (IntPtr)(-1)) Native.SetHandleInformation(h, 1 /*HANDLE_FLAG_INHERIT*/, 1);
        siex.lpAttributeList = list;

        var cl = new StringBuilder();
        foreach (var a in cmd) { if (cl.Length > 0) cl.Append(' '); cl.Append(Quote(a)); }
        IntPtr envBlock = EnvironmentBlock();
        Native.PROCESS_INFORMATION pi;
        uint flags = Native.CREATE_SUSPENDED | Native.CREATE_UNICODE_ENVIRONMENT | Native.CREATE_NO_WINDOW | (mode == "appcontainer" ? Native.EXTENDED_STARTUPINFO_PRESENT : 0);
        bool ok = mode == "appcontainer"
            ? Native.CreateProcess(null, cl, IntPtr.Zero, IntPtr.Zero, true, flags, envBlock, dir, ref siex, out pi)
            : Native.CreateProcessAsUser(token, null, cl, IntPtr.Zero, IntPtr.Zero, true, flags, envBlock, dir, ref siex, out pi);
        if (!ok)
        {
            int err = Marshal.GetLastWin32Error();
            // a process already inside a job may not be able to nest: retry with breakaway (the node's own job, if any)
            if (err == 5 /*ERROR_ACCESS_DENIED*/) ok = mode == "appcontainer"
                ? Native.CreateProcess(null, cl, IntPtr.Zero, IntPtr.Zero, true, flags | Native.CREATE_BREAKAWAY_FROM_JOB, envBlock, dir, ref siex, out pi)
                : Native.CreateProcessAsUser(token, null, cl, IntPtr.Zero, IntPtr.Zero, true, flags | Native.CREATE_BREAKAWAY_FROM_JOB, envBlock, dir, ref siex, out pi);
            int err2 = Marshal.GetLastWin32Error();
            if (!ok) throw new Win32Exception(err2, (mode == "appcontainer" ? "CreateProcess in AppContainer failed" : "CreateProcessAsUser with the restricted token failed") + " (win32 " + err2 + ": " + new Win32Exception(err2).Message + ")");
        }
        if (!Native.AssignProcessToJobObject(job, pi.hProcess)) { int err = Marshal.GetLastWin32Error(); Native.TerminateJobObject(job, 1); throw new Win32Exception(err, "AssignProcessToJobObject failed"); }
        Native.ResumeThread(pi.hThread);
        Native.CloseHandle(pi.hThread);
        Say("started pid " + pi.dwProcessId + " in " + dir);

        // 5 — wait, account, enforce the time limit
        var t0 = DateTime.UtcNow;
        uint exit = 1;
        bool timedOut = false;
        while (true)
        {
            uint w = Native.WaitForSingleObject(pi.hProcess, 1000);
            WriteMeta(job, metaFile);
            if (w == 0) break;   // WAIT_OBJECT_0
            if ((DateTime.UtcNow - t0).TotalSeconds > timeoutS) { timedOut = true; Say("time limit " + timeoutS + " s — terminating the job"); Native.TerminateJobObject(job, 124); Native.WaitForSingleObject(pi.hProcess, 5000); break; }
        }
        Native.GetExitCodeProcess(pi.hProcess, out exit);
        // the first process may have exited while children still run: the job dies with this helper (kill on close)
        Native.TerminateJobObject(job, 137);
        WriteMeta(job, metaFile);
        Say("exit " + exit + (timedOut ? " (time limit)" : "") + " after " + Math.Round((DateTime.UtcNow - t0).TotalSeconds, 1) + " s");
        Native.CloseHandle(pi.hProcess);
        Native.CloseHandle(job);
        if (list != IntPtr.Zero) { Native.DeleteProcThreadAttributeList(list); Marshal.FreeHGlobal(list); }
        if (scPtr != IntPtr.Zero) Marshal.FreeHGlobal(scPtr);
        Marshal.FreeHGlobal(envBlock);
        if (sid != IntPtr.Zero) Native.FreeSid(sid);
        if (token != IntPtr.Zero) Native.CloseHandle(token);
        return timedOut ? 124 : (int)exit;
    }

    static void SetJob<T>(IntPtr job, int cls, T info) where T : struct
    {
        int len = Marshal.SizeOf(info);
        IntPtr p = Marshal.AllocHGlobal(len);
        try { Marshal.StructureToPtr(info, p, false); if (!Native.SetInformationJobObject(job, cls, p, (uint)len)) throw new Win32Exception(Marshal.GetLastWin32Error(), "SetInformationJobObject(" + cls + ") failed"); }
        finally { Marshal.FreeHGlobal(p); }
    }

    static void WriteMeta(IntPtr job, string metaFile)
    {
        try
        {
            var acc = new Native.JOBOBJECT_BASIC_ACCOUNTING_INFORMATION();
            int len = Marshal.SizeOf(acc);
            IntPtr p = Marshal.AllocHGlobal(len);
            uint ret;
            double cpu = 0; uint active = 0, total = 0;
            if (Native.QueryInformationJobObject(job, Native.JobObjectBasicAccountingInformation, p, (uint)len, out ret)) { acc = (Native.JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)Marshal.PtrToStructure(p, typeof(Native.JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)); cpu = (acc.TotalUserTime + acc.TotalKernelTime) / 1e7; active = acc.ActiveProcesses; total = acc.TotalProcesses; }
            Marshal.FreeHGlobal(p);
            var ext = new Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            int len2 = Marshal.SizeOf(ext);
            IntPtr p2 = Marshal.AllocHGlobal(len2);
            double peakMb = 0;
            if (Native.QueryInformationJobObject(job, Native.JobObjectExtendedLimitInformation, p2, (uint)len2, out ret)) { ext = (Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION)Marshal.PtrToStructure(p2, typeof(Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION)); peakMb = (double)(ulong)ext.PeakJobMemoryUsed / 1048576.0; }
            Marshal.FreeHGlobal(p2);
            string json = "{\"cpu_seconds\":" + cpu.ToString("F3", System.Globalization.CultureInfo.InvariantCulture) + ",\"peak_memory_mb\":" + peakMb.ToString("F1", System.Globalization.CultureInfo.InvariantCulture) + ",\"processes\":" + active + ",\"total_processes\":" + total + "}";
            string tmp = metaFile + ".tmp";
            File.WriteAllText(tmp, json);
            if (File.Exists(metaFile)) File.Replace(tmp, metaFile, null); else File.Move(tmp, metaFile);
        }
        catch { }
    }
}
