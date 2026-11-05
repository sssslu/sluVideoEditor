param(
    [string]$Spec,
    [switch]$ValidateOnly
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)

# Windows PowerShell 5.1, x64. The environment is inherited from the adapter.
# Never serialize environment values into the request, protocol, or logs.
# https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-createdesktopw
# https://learn.microsoft.com/windows/win32/api/processthreadsapi/ns-processthreadsapi-startupinfow
# https://learn.microsoft.com/windows/win32/procthread/job-objects
$source = @'
using System;
using System.Collections.Concurrent;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

public static class QuietDesktopLauncher
{
    const uint KillOnJobClose = 0x2000;
    const uint CreateSuspended = 0x00000004;
    const uint CreateUnicodeEnvironment = 0x00000400;
    const uint ExtendedStartupInfo = 0x00080000;
    const uint CreateNoWindow = 0x08000000;
    const uint Synchronize = 0x00100000;
    const uint QueryLimitedInformation = 0x1000;
    const uint WaitTimeout = 258;
    static readonly IntPtr InvalidHandle = new IntPtr(-1);
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

    [StructLayout(LayoutKind.Sequential)]
    struct SecurityAttributes
    {
        public int Length;
        public IntPtr Descriptor;
        [MarshalAs(UnmanagedType.Bool)] public bool InheritHandle;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct StartupInfo
    {
        public int Size;
        public string Reserved, Desktop, Title;
        public uint X, Y, XSize, YSize, XCountChars, YCountChars, FillAttribute, Flags;
        public ushort ShowWindow, ReservedBytes;
        public IntPtr ReservedData, StandardInput, StandardOutput, StandardError;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct StartupInfoEx { public StartupInfo Startup; public IntPtr Attributes; }
    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInformation { public IntPtr Process, Thread; public uint ProcessId, ThreadId; }
    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits
    {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters { public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimits
    {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct JobAccounting
    {
        public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
        public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateDesktopW(string name, IntPtr device, IntPtr mode, uint flags, uint access, IntPtr security);
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll", SetLastError = true)]
    static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool GetUserObjectInformationW(IntPtr handle, int index, StringBuilder value, uint bytes, out uint needed);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObjectW(IntPtr security, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits limits, uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out JobAccounting information, uint length, IntPtr returnedLength);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool belongs);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")]
    static extern uint SetErrorMode(uint mode);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SecurityAttributes security, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateFileW(string file, uint access, uint share, ref SecurityAttributes security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr bytes);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returnedSize);
    [DllImport("kernel32.dll")]
    static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcessW(string application, StringBuilder commandLine, IntPtr processSecurity, IntPtr threadSecurity,
        bool inheritHandles, uint flags, IntPtr environment, string directory, ref StartupInfoEx startup, out ProcessInformation process);

    static void Require(bool success, string operation)
    {
        if (!success) throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
    }
    static void Close(ref IntPtr handle)
    {
        if (handle != IntPtr.Zero && handle != InvalidHandle) CloseHandle(handle);
        handle = IntPtr.Zero;
    }
    static bool HasExited(IntPtr process)
    {
        uint state = WaitForSingleObject(process, 0);
        if (state == 0) return true;
        if (state == WaitTimeout) return false;
        throw new Win32Exception(Marshal.GetLastWin32Error(), "WaitForSingleObject");
    }
    static void Emit(object value)
    {
        Console.Out.WriteLine(Json.Serialize(value));
        Console.Out.Flush();
    }
    public static string QuoteArgument(string value)
    {
        if (value == null || value.IndexOf('\0') >= 0) throw new ArgumentException("Arguments must be strings without NUL");
        StringBuilder output = new StringBuilder("\"");
        int slashes = 0;
        foreach (char character in value)
        {
            if (character == '\\') { slashes++; continue; }
            output.Append('\\', character == '"' ? slashes * 2 + 1 : slashes);
            output.Append(character);
            slashes = 0;
        }
        output.Append('\\', slashes * 2);
        return output.Append('"').ToString();
    }
    static string AbsolutePath(string value)
    {
        if (String.IsNullOrWhiteSpace(value) || value.IndexOf('\0') >= 0) throw new ArgumentException("An absolute path is required");
        bool driveRooted = value.Length >= 3 && Char.IsLetter(value[0]) && value[1] == ':' && (value[2] == '\\' || value[2] == '/');
        if (!driveRooted && !value.StartsWith("\\\\", StringComparison.Ordinal)) throw new ArgumentException("A fully qualified path is required");
        return Path.GetFullPath(value);
    }
    sealed class StopState
    {
        string reason;
        public string Reason { get { return Interlocked.CompareExchange(ref reason, null, null); } }
        public void Request(string value) { Interlocked.CompareExchange(ref reason, value, null); }
    }
    sealed class Capture : IDisposable
    {
        public IntPtr WriteHandle;
        readonly FileStream input, output;
        readonly StopState stop;
        readonly long maximumBytes;
        readonly Thread thread;
        public long Bytes;
        public Exception Failure;
        public Capture(string file, long maximumBytes, StopState stop)
        {
            this.maximumBytes = maximumBytes;
            this.stop = stop;
            IntPtr read = IntPtr.Zero;
            try
            {
                output = new FileStream(file, FileMode.CreateNew, FileAccess.Write, FileShare.Read);
                SecurityAttributes security = new SecurityAttributes { Length = Marshal.SizeOf(typeof(SecurityAttributes)), InheritHandle = true };
                Require(CreatePipe(out read, out WriteHandle, ref security, 65536), "CreatePipe");
                Require(SetHandleInformation(read, 1, 0), "Clear pipe-read inheritance");
                input = new FileStream(new SafeFileHandle(read, true), FileAccess.Read, 4096, false);
                read = IntPtr.Zero;
                thread = new Thread(Pump);
                thread.IsBackground = true;
                thread.Start();
            }
            catch
            {
                Close(ref read); Close(ref WriteHandle);
                if (input != null) input.Dispose();
                if (output != null) output.Dispose();
                throw;
            }
        }
        void Pump()
        {
            try
            {
                byte[] bytes = new byte[4096];
                int count;
                while ((count = input.Read(bytes, 0, bytes.Length)) > 0)
                {
                    int accepted = (int)Math.Min(count, maximumBytes - Bytes);
                    if (accepted > 0) { output.Write(bytes, 0, accepted); Interlocked.Add(ref Bytes, accepted); }
                    if (accepted != count) { stop.Request("output-limit"); break; }
                }
            }
            catch (Exception error) { Failure = error; stop.Request("capture-error"); }
            finally
            {
                try { output.Dispose(); }
                catch (Exception error) { Failure = error; stop.Request("capture-error"); }
                try { input.Dispose(); }
                catch (Exception error) { Failure = error; stop.Request("capture-error"); }
            }
        }
        public void CloseWriter() { Close(ref WriteHandle); }
        public void Dispose()
        {
            CloseWriter();
            if (thread != null && !thread.Join(2000)) throw new IOException("Output pipe did not close after job termination");
        }
    }
    static IntPtr CreatePrivateDesktop(string name)
    {
        IntPtr desktop = IntPtr.Zero;
        int error = 0;
        Exception failure = null;
        // CreateDesktop may associate its calling thread. This short-lived
        // thread ends before the owner later calls CloseDesktop.
        Thread creator = new Thread(delegate()
        {
            try
            {
                desktop = CreateDesktopW(name, IntPtr.Zero, IntPtr.Zero, 0, 0x00C3, IntPtr.Zero);
                if (desktop == IntPtr.Zero) error = Marshal.GetLastWin32Error();
            }
            catch (Exception exception) { failure = exception; }
        });
        creator.Start(); creator.Join();
        if (failure != null) throw new InvalidOperationException("Create desktop thread failed", failure);
        if (desktop == IntPtr.Zero) throw new Win32Exception(error, "CreateDesktopW");
        return desktop;
    }
    static uint ActiveProcesses(IntPtr job)
    {
        JobAccounting accounting;
        Require(QueryInformationJobObject(job, 1, out accounting, (uint)Marshal.SizeOf(typeof(JobAccounting)), IntPtr.Zero), "Query job accounting");
        return accounting.ActiveProcesses;
    }
    static void VerifyProcess(string line, IntPtr job)
    {
        var command = Json.Deserialize<System.Collections.Generic.Dictionary<string, object>>(line);
        if (command == null || !command.ContainsKey("command") || !Object.Equals(command["command"], "verify-process") || !command.ContainsKey("requestId") || !command.ContainsKey("pid")) throw new ArgumentException("Invalid control command");
        if (!(command["requestId"] is string) && !(command["requestId"] is int)) throw new ArgumentException("Invalid requestId");
        if (!(command["pid"] is int) || (int)command["pid"] <= 0) throw new ArgumentException("Invalid process ID");
        int pid = (int)command["pid"];
        bool belongs = false;
        IntPtr process = OpenProcess(QueryLimitedInformation, false, (uint)pid);
        if (process != IntPtr.Zero)
        {
            try { Require(IsProcessInJob(process, job, out belongs), "IsProcessInJob"); }
            finally { Close(ref process); }
        }
        Emit(new { @event = "process", requestId = command["requestId"], pid = pid, inJob = belongs });
    }

    public static void Run(string executable, string[] arguments, string directory, int parentPid, string stdoutPath, string stderrPath, int timeoutMs, long maxLogBytes)
    {
        if (IntPtr.Size != 8) throw new PlatformNotSupportedException("The launcher requires x64 Windows PowerShell");
        executable = AbsolutePath(executable); directory = AbsolutePath(directory);
        stdoutPath = AbsolutePath(stdoutPath); stderrPath = AbsolutePath(stderrPath);
        if (!File.Exists(executable) || !Directory.Exists(directory)) throw new ArgumentException("Executable or working directory is missing");
        if (String.Equals(stdoutPath, stderrPath, StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("Output logs must be separate");
        if (parentPid <= 0 || parentPid == Process.GetCurrentProcess().Id) throw new ArgumentException("A distinct adapter parent PID is required");
        if (timeoutMs < 1000 || timeoutMs > 3600000 || maxLogBytes < 4096 || maxLogBytes > 67108864) throw new ArgumentException("Invalid time or log limit");
        StringBuilder commandLine = new StringBuilder(QuoteArgument(executable));
        foreach (string argument in arguments) commandLine.Append(' ').Append(QuoteArgument(argument));
        if (commandLine.Length >= 32767) throw new ArgumentException("Windows command line is too long");
        // This process-wide setting belongs only to the helper. Children inherit
        // it, so critical-file/GP-fault reporting cannot open an OS error prompt.
        SetErrorMode(0x8003);

        IntPtr parent = IntPtr.Zero, desktop = IntPtr.Zero, job = IntPtr.Zero, input = IntPtr.Zero;
        IntPtr attributes = IntPtr.Zero, handleList = IntPtr.Zero, jobList = IntPtr.Zero;
        bool attributesReady = false, resumed = false;
        ProcessInformation process = new ProcessInformation();
        Capture stdout = null, stderr = null;
        StopState stop = new StopState();
        try
        {
            parent = OpenProcess(Synchronize, false, (uint)parentPid);
            Require(parent != IntPtr.Zero, "Open adapter parent");
            if (HasExited(parent)) throw new InvalidOperationException("Adapter parent has exited");
            string desktopName = "SLU-QA-" + Guid.NewGuid().ToString("N");
            StringBuilder station = new StringBuilder(256); uint needed;
            Require(GetUserObjectInformationW(GetProcessWindowStation(), 2, station, 512, out needed), "Read window-station name");
            desktop = CreatePrivateDesktop(desktopName);
            string desktopPath = station.ToString() + "\\" + desktopName;
            job = CreateJobObjectW(IntPtr.Zero, null);
            Require(job != IntPtr.Zero, "CreateJobObjectW");
            ExtendedLimits limits = new ExtendedLimits(); limits.Basic.Flags = KillOnJobClose;
            Require(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))), "Set kill-on-close job limit");
            stdout = new Capture(stdoutPath, maxLogBytes, stop);
            stderr = new Capture(stderrPath, maxLogBytes, stop);
            SecurityAttributes security = new SecurityAttributes { Length = Marshal.SizeOf(typeof(SecurityAttributes)), InheritHandle = true };
            input = CreateFileW("NUL", 0x80000000, 3, ref security, 3, 0, IntPtr.Zero);
            Require(input != InvalidHandle, "Open child NUL input");
            IntPtr bytes = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref bytes);
            if (bytes == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Size process attribute list");
            attributes = Marshal.AllocHGlobal(bytes);
            Require(InitializeProcThreadAttributeList(attributes, 2, 0, ref bytes), "Initialize process attribute list");
            attributesReady = true;
            handleList = Marshal.AllocHGlobal(3 * IntPtr.Size);
            Marshal.WriteIntPtr(handleList, 0, input);
            Marshal.WriteIntPtr(handleList, IntPtr.Size, stdout.WriteHandle);
            Marshal.WriteIntPtr(handleList, 2 * IntPtr.Size, stderr.WriteHandle);
            Require(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20002), handleList, new IntPtr(3 * IntPtr.Size), IntPtr.Zero, IntPtr.Zero), "Restrict inherited handles");
            // Windows 10+ assigns this job during CreateProcess itself. Even
            // killing this helper immediately cannot strand an unassigned child.
            jobList = Marshal.AllocHGlobal(IntPtr.Size);
            Marshal.WriteIntPtr(jobList, job);
            Require(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x2000D), jobList, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero), "Set atomic process job assignment");
            StartupInfoEx startup = new StartupInfoEx();
            startup.Startup.Size = Marshal.SizeOf(typeof(StartupInfoEx));
            startup.Startup.Desktop = desktopPath;
            startup.Startup.Flags = 0x00000181; // USESTDHANDLES, USESHOWWINDOW, FORCEOFFFEEDBACK
            startup.Startup.ShowWindow = 0;
            startup.Startup.StandardInput = input;
            startup.Startup.StandardOutput = stdout.WriteHandle;
            startup.Startup.StandardError = stderr.WriteHandle;
            startup.Attributes = attributes;
            // No shell and no environment file. The adapter's exact environment
            // is already inherited by this helper. Job/desktop handles are not inherited.
            Require(CreateProcessW(executable, commandLine, IntPtr.Zero, IntPtr.Zero, true,
                CreateSuspended | CreateUnicodeEnvironment | ExtendedStartupInfo | CreateNoWindow,
                IntPtr.Zero, directory, ref startup, out process), "CreateProcessW on private desktop");
            stdout.CloseWriter(); stderr.CloseWriter(); Close(ref input);
            bool assigned;
            Require(IsProcessInJob(process.Process, job, out assigned), "Verify suspended process job");
            if (!assigned) throw new InvalidOperationException("Suspended process was not assigned to the owned job");
            if (HasExited(parent)) throw new InvalidOperationException("Adapter parent exited before resume");
            Require(ResumeThread(process.Thread) != UInt32.MaxValue, "Resume owned process");
            resumed = true; Close(ref process.Thread);
            Emit(new { @event = "started", pid = process.ProcessId, desktopName = desktopName, desktopPath = desktopPath, jobKillOnClose = true });

            ConcurrentQueue<string> commands = new ConcurrentQueue<string>();
            Thread reader = new Thread(delegate()
            {
                try
                {
                    string line;
                    while ((line = Console.In.ReadLine()) != null)
                    {
                        if (line == "stop") { stop.Request("stop"); return; }
                        if (line.Length > 16384 || commands.Count >= 16) { stop.Request("invalid-control"); return; }
                        commands.Enqueue(line);
                    }
                    stop.Request("stdin-eof");
                }
                catch { stop.Request("stdin-error"); }
            });
            reader.IsBackground = true; reader.Start();
            Stopwatch lifetime = Stopwatch.StartNew();
            bool reportedExit = false;
            while (stop.Reason == null)
            {
                if (HasExited(parent)) { stop.Request("parent-exit"); break; }
                if (lifetime.ElapsedMilliseconds >= timeoutMs) { stop.Request("timeout"); break; }
                string control;
                while (commands.TryDequeue(out control)) VerifyProcess(control, job);
                if (!reportedExit && HasExited(process.Process))
                {
                    uint exitCode; Require(GetExitCodeProcess(process.Process, out exitCode), "Read root exit code");
                    reportedExit = true;
                    Emit(new { @event = "exited", pid = process.ProcessId, exitCode = exitCode });
                }
                Thread.Sleep(50);
            }
            Require(TerminateJobObject(job, 130), "Terminate owned process tree");
            Stopwatch ending = Stopwatch.StartNew();
            while (ActiveProcesses(job) != 0 && ending.ElapsedMilliseconds < 5000) Thread.Sleep(25);
            uint remaining = ActiveProcesses(job);
            if (remaining != 0) throw new IOException("Owned job still has active processes after termination");
            stdout.Dispose(); stderr.Dispose();
            if (stdout.Failure != null || stderr.Failure != null) throw new IOException("Output capture failed", stdout.Failure ?? stderr.Failure);
            Emit(new { @event = "stopped", reason = stop.Reason, jobRemainingProcesses = remaining, stdoutBytes = stdout.Bytes, stderrBytes = stderr.Bytes });
        }
        finally
        {
            // The owned job closes even on protocol errors. A suspended child
            // that failed startup is also explicitly terminated before cleanup.
            if (process.Process != IntPtr.Zero && !resumed) TerminateProcess(process.Process, 1);
            if (job != IntPtr.Zero) TerminateJobObject(job, 130);
            Close(ref job);
            Close(ref input);
            Close(ref process.Thread); Close(ref process.Process); Close(ref parent);
            if (attributesReady) DeleteProcThreadAttributeList(attributes);
            if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
            if (handleList != IntPtr.Zero) Marshal.FreeHGlobal(handleList);
            if (jobList != IntPtr.Zero) Marshal.FreeHGlobal(jobList);
            try { if (stdout != null) stdout.Dispose(); }
            finally
            {
                try { if (stderr != null) stderr.Dispose(); }
                finally { if (desktop != IntPtr.Zero) Require(CloseDesktop(desktop), "Close private desktop"); }
            }
        }
    }
    public static object ValidateOnly()
    {
        if (IntPtr.Size != 8) throw new PlatformNotSupportedException("x64 Windows PowerShell is required");
        if (Marshal.SizeOf(typeof(StartupInfoEx)) != 112 || Marshal.SizeOf(typeof(ExtendedLimits)) != 144 || Marshal.SizeOf(typeof(JobAccounting)) != 48) throw new InvalidOperationException("Unexpected Win32 structure layout");
        string[] inputs = { "", "plain", "two words", "a\"b", "C:\\path\\", "a\\\"b", "\uD55C\uAE00 \uACBD\uB85C\\\uB05D\\" };
        string[] expected = { "\"\"", "\"plain\"", "\"two words\"", "\"a\\\"b\"", "\"C:\\path\\\\\"", "\"a\\\\\\\"b\"", "\"\uD55C\uAE00 \uACBD\uB85C\\\uB05D\\\\\"" };
        for (int index = 0; index < inputs.Length; index++) if (QuoteArgument(inputs[index]) != expected[index]) throw new InvalidOperationException("Argument quoting fixture failed");
        bool rejected = false;
        try { QuoteArgument("a\0b"); } catch (ArgumentException) { rejected = true; }
        if (!rejected) throw new InvalidOperationException("NUL argument was accepted");
        return new { @event = "validated", pointerSize = IntPtr.Size, quotingCases = inputs.Length, unicode = inputs[6], startupInfoExBytes = 112, extendedLimitsBytes = 144, nativeApiCalls = 0 };
    }
}
'@

try {
    if ([IntPtr]::Size -ne 8 -or $PSVersionTable.PSEdition -ne 'Desktop') { throw 'Use x64 Windows PowerShell 5.1' }
    Add-Type -TypeDefinition $source -ReferencedAssemblies 'System.dll','System.Core.dll','System.Web.Extensions.dll' -ErrorAction Stop
    if ($ValidateOnly) {
        [Console]::Out.WriteLine(([QuietDesktopLauncher]::ValidateOnly() | ConvertTo-Json -Compress))
        exit 0
    }
    if ([string]::IsNullOrWhiteSpace($Spec)) { throw 'A JSON request path is required' }
    $requestFile = Get-Item -LiteralPath $Spec
    if ($requestFile.Length -gt 1048576) { throw 'Request file is too large' }
    $request = [System.IO.File]::ReadAllText($requestFile.FullName, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    if ($null -ne $request.env) { throw 'Pass the environment through the helper process, never through a JSON file' }
    if ($request.args -isnot [Array]) { throw 'args must be an array' }
    foreach ($argument in $request.args) { if ($argument -isnot [string]) { throw 'Every argument must be a string' } }
    foreach ($name in @('executable','cwd','stdoutPath','stderrPath')) {
        if ($request.$name -isnot [string]) { throw "$name must be a string" }
    }
    if ($request.parentPid -isnot [int] -or $request.parentPid -le 0) { throw 'parentPid must be a positive integer' }
    $timeoutMs = 300000
    $maxLogBytes = 8388608
    if ($null -ne $request.timeoutMs) { $timeoutMs = [int]$request.timeoutMs }
    if ($null -ne $request.maxLogBytes) { $maxLogBytes = [long]$request.maxLogBytes }
    [QuietDesktopLauncher]::Run($request.executable, [string[]]$request.args, $request.cwd, $request.parentPid, $request.stdoutPath, $request.stderrPath, $timeoutMs, $maxLogBytes)
    exit 0
}
catch {
    [Console]::Out.WriteLine((@{ event = 'error'; message = $_.Exception.ToString() } | ConvertTo-Json -Compress))
    exit 1
}
