param([string]$Executable = "$env:LOCALAPPDATA\Programs\SLU Studio\SLU Studio.exe", [switch]$Inspect, [switch]$Source, [string]$Report)
# Runs on scripts/quiet-desktop.mjs's private desktop. No global mouse, keyboard or clipboard.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,WindowsBase,System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class EditorWindows {
  [DllImport("user32.dll")] public static extern IntPtr GetThreadDesktop(uint tid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr h, int index, StringBuilder buffer, int length, out int needed);
  public static string Desktop() { int n; var b=new StringBuilder(256); if (!GetUserObjectInformation(GetThreadDesktop(GetCurrentThreadId()),2,b,b.Capacity*2,out n)) throw new Exception("Cannot identify desktop"); return b.ToString(); }
  public delegate bool EnumProc(IntPtr hwnd, IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumDesktopWindows(IntPtr desktop, EnumProc callback, IntPtr p);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd,StringBuilder buffer,int max);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  public static IntPtr Find(uint target,string cls) {IntPtr result=IntPtr.Zero;EnumDesktopWindows(GetThreadDesktop(GetCurrentThreadId()),delegate(IntPtr w, IntPtr p){uint id;GetWindowThreadProcessId(w,out id);var b=new StringBuilder(200);GetClassName(w,b,200);if(id==target&&b.ToString()==cls&&IsWindowVisible(w)){result=w;return false;}return true;},IntPtr.Zero);return result;}
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern bool PostMessage(IntPtr hwnd,uint msg,IntPtr w,IntPtr l);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr hwnd,uint msg,IntPtr w,string text);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd,IntPtr dc,uint flags);
}
'@
if ([EditorWindows]::Desktop() -notmatch '^SLU-QA-[0-9a-f]{32}$') { throw 'Only run via the isolated Windows desktop launcher.' }
$caseDir = [IO.Directory]::CreateDirectory((Join-Path (Get-Location) ('.test-artifacts\desktop-edit\' + [Guid]::NewGuid().ToString('N')))).FullName
$env:SLU_USER_DATA = Join-Path $caseDir 'profile'
Remove-Item Env:SLU_TEST_BACKGROUND -ErrorAction SilentlyContinue
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
# The normal visible editor and its dialogs exist only on this private desktop.
$start = New-Object Diagnostics.ProcessStartInfo
$start.FileName = (Resolve-Path -LiteralPath $Executable).Path
$start.UseShellExecute = $false
$start.Arguments = '--mute-audio'
if($Source){$start.Arguments += ' "' + (Get-Location).Path + '"'}
$editorProcess = [Diagnostics.Process]::Start($start)
$treeScope = [Windows.Automation.TreeScope]::Descendants
$all = [Windows.Automation.Condition]::TrueCondition
function Wait-For([scriptblock]$Action,[string]$Description,[int]$Seconds=20) {
  $timer=[Diagnostics.Stopwatch]::StartNew()
  do { $found=& $Action; if($found){return $found}; Start-Sleep -Milliseconds 150 } while($timer.Elapsed.TotalSeconds -lt $Seconds)
  throw "Timeout: $Description"
}
function Window-Of([string]$Class) {
  $w=[EditorWindows]::Find($editorProcess.Id,$Class)
  if($w -ne [IntPtr]::Zero){return [Windows.Automation.AutomationElement]::FromHandle($w)}
}
function By-Property($Parent,$Property,$Value) {
  $condition=[Windows.Automation.PropertyCondition]::new($Property,$Value)
  $Parent.FindFirst($treeScope,$condition)
}
function Get-Control([string]$Name,$Parent=$window) {
  By-Property $Parent ([Windows.Automation.AutomationElement]::NameProperty) $Name
}
function Control([string]$Name,$Parent=$window){
  Wait-For { Get-Control $Name $Parent } $Name
}
function Invoke-Control($Element) {
  Write-Output ('Activate ' + $Element.Current.Name) | Out-Host
  $pattern=$null
  if($Element.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)){$pattern.Invoke();return}
  if($Element.TryGetCurrentPattern([Windows.Automation.TogglePattern]::Pattern,[ref]$pattern)){$pattern.Toggle();return}
  if($Element.TryGetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern,[ref]$pattern)){$pattern.Select();return}
  if($Element.TryGetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern,[ref]$pattern)){$pattern.Expand();return}
  throw ('Control has no activation pattern: ' + $Element.Current.Name)
}
function Press([string]$Name,$Parent=$window) { Invoke-Control (Control $Name $Parent) }
function Type-Value($Element,[string]$Text) {
  Write-Output ('Fill ' + $Element.Current.Name) | Out-Host
  $Element.SetFocus()
  $Element.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).SetValue($Text)
}
function Key([int]$VirtualKey) {
  $hwnd=[IntPtr]$window.Current.NativeWindowHandle
  [void][EditorWindows]::PostMessage($hwnd,0x0100,[IntPtr]$VirtualKey,[IntPtr]1)
  [void][EditorWindows]::PostMessage($hwnd,0x0101,[IntPtr]$VirtualKey,[IntPtr](-1073741823))
}
function Seek([string]$Timecode) {
  $field=Control '현재 시간'
  Type-Value $field $Timecode
  Key 13
  Wait-For { (Get-Control '현재 시간').GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).Current.Value -eq $Timecode -and -not (Get-Control '현재 시간').Current.HasKeyboardFocus } "Seek $Timecode" | Out-Null
}
function Choose-Mp4 {
  $select=Control '내보내기 형식'
  $select.SetFocus()
  Key 36
  Key 40
  Wait-For { $select.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).Current.Value -like 'MP4*' } 'MP4 format' | Out-Null
}
function By-ButtonPrefix([string]$Prefix,$Parent=$window){
  Wait-For {
    $type=[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::Button)
    $Parent.FindAll($treeScope,$type) | Where-Object {$_.Current.Name.StartsWith($Prefix)} | Select-Object -First 1
  } $Prefix
}
function Find-Aurora([string]$Query,[string]$Start){
  Invoke-Control (By-ButtonPrefix '클립 찾기')
  $find=Control '타임라인 클립 찾기'
  $combo=By-Property $find ([Windows.Automation.AutomationElement]::ControlTypeProperty) ([Windows.Automation.ControlType]::ComboBox)
  if(-not $combo){$combo=By-Property $find ([Windows.Automation.AutomationElement]::ControlTypeProperty) ([Windows.Automation.ControlType]::Edit)}
  Type-Value $combo $Query

  $result=Wait-For {
    $buttons=$find.FindAll($treeScope,$all) | Where-Object {$_.Current.Name -like ("*Aurora*"+$Start)}
    $buttons | Select-Object -First 1
  } 'matching clip with requested start'
  Invoke-Control $result
  Wait-For { -not (Get-Control '타임라인 클립 찾기') -and (Get-Control '클립 이름').GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).Current.Value -eq '01 - Aurora motion.mp4' } 'selected search result' | Out-Null
}
function Dump-Tree($Parent,[string]$File) {
  $rows=@(foreach($e in $Parent.FindAll($treeScope,$all)){try{[PSCustomObject]@{name=$e.Current.Name;type=$e.Current.ControlType.ProgrammaticName;id=$e.Current.AutomationId;class=$e.Current.ClassName;enabled=$e.Current.IsEnabled;offscreen=$e.Current.IsOffscreen;patterns=@($e.GetSupportedPatterns() | ForEach-Object {$_.ProgrammaticName})}}catch{}})
  $rows | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $caseDir $File) -Encoding UTF8
}
function Snapshot([string]$Name){
  $r=$window.Current.BoundingRectangle
  $bitmap=[Drawing.Bitmap]::new([int]$r.Width,[int]$r.Height)
  $g=[Drawing.Graphics]::FromImage($bitmap)
  $dc=$g.GetHdc()
  try { if(-not [EditorWindows]::PrintWindow([IntPtr]$window.Current.NativeWindowHandle,$dc,2)){throw 'Window capture failed'} }
  finally {$g.ReleaseHdc($dc);$g.Dispose()}
  try {$bitmap.Save((Join-Path $caseDir ($Name+'.png')),[Drawing.Imaging.ImageFormat]::Png)} finally {$bitmap.Dispose()}
}
function File-Dialog([string]$File){
  $dialog=Wait-For {Window-Of '#32770'} 'native file dialog'
  $filename=Wait-For { $dialog.FindAll($treeScope,$all) | Where-Object {$_.Current.ClassName -eq 'Edit' -and $_.Current.AutomationId -in '1148','1001'} | Select-Object -Last 1 } 'File name edit'
  if ([EditorWindows]::SendMessage([IntPtr]$filename.Current.NativeWindowHandle,0x000c,[IntPtr]::Zero,$File) -eq [IntPtr]::Zero){throw 'Cannot fill native filename field'}
  $accept=$dialog.FindAll($treeScope,$all) | Where-Object {$_.Current.ClassName -eq 'Button' -and $_.Current.AutomationId -eq '1'} | Select-Object -First 1
  if(-not $accept -or -not [EditorWindows]::PostMessage([IntPtr]$accept.Current.NativeWindowHandle,0x00f5,[IntPtr]::Zero,[IntPtr]::Zero)){throw 'Cannot press native file dialog confirmation button'}
  Wait-For { -not (Window-Of '#32770') } 'file dialog accepted' | Out-Null
}
Write-Output "ARTIFACTS $caseDir"
try {
  $window=Wait-For {Window-Of 'Chrome_WidgetWin_1'} 'editor window'
  Control '가져오기' | Out-Null
  $projectVersion=([regex]::Match($window.Current.Name,'v(\d+\.\d+\.\d+)')).Groups[1].Value
  if($Inspect){Dump-Tree $window 'initial.json';Snapshot 'initial'}
  Press '가져오기'
  File-Dialog ((Resolve-Path -LiteralPath 'examples/01 - Aurora motion.mp4').Path)
  Press '01 - Aurora motion.mp4 소스 열기'
  Press '끝에 추가'
  if($Inspect){Dump-Tree $window 'timeline.json';Snapshot 'timeline'}
  if($Inspect){Write-Output 'Imported and inserted media via the real Windows dialog';exit 0}
  Press '프로그램'
  Seek '00:00:05:00'
  Press '플레이헤드에서 분할 (Ctrl+B)'
  Press '텍스트' (Control '편집 도구')
  Press '텍스트 추가'
  $caption='SLU EDIT TEST'
  Type-Value (Control '텍스트 내용') 'SLU EDIT DRAFT'
  Press '자막' (Control '편집 도구')
  Press '찾아 바꾸기'
  Type-Value (Control '찾을 자막 내용') 'DRAFT'
  Type-Value (Control '바꿀 자막 내용') 'TEST'
  Press '전체 바꾸기'
  Press '프로그램'
  $saved=Join-Path $caseDir 'cut.sluproj'
  Press '프로젝트 저장 (Ctrl+S)'
  File-Dialog $saved
  Wait-For {Test-Path -LiteralPath $saved} 'saved project' | Out-Null
  $project=Get-Content -LiteralPath $saved -Raw -Encoding UTF8 | ConvertFrom-Json
  $video=@($project.clips | Where-Object mediaId | Sort-Object start)
  $text=@($project.clips | Where-Object {$_.text -eq $caption})
  if($video.Count -ne 2 -or $video[0].start -ne 0 -or $video[0].duration -ne 5 -or $video[1].start -ne 5 -or $text.Count -ne 1 -or $text[0].start -ne 5){throw 'Saved cut or caption does not match edit'}
  Find-Aurora 'Aurora' '00:00:05:00'
  Press '색상' (Control '속성 패널')
  Press '따뜻하게' (Control '속성 패널')
  Press '색 보정 복사'
  Find-Aurora '00:00:00:00' '00:00:00:00'
  Press '색 보정 붙여넣기'
  Press '오디오' (Control '속성 패널')
  Press '선택 클립 음량 맞추기'
  $gain=Wait-For {
    $sliders=[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::Slider)
    (Control '속성 패널').FindAll($treeScope,$sliders) | Where-Object {$_.Current.Name -eq '게인'} | Select-Object -First 1
  } 'gain slider'
  Wait-For { [Math]::Abs($gain.GetCurrentPattern([Windows.Automation.RangeValuePattern]::Pattern).Current.Value) -gt .01 } 'measured gain applied' 60 | Out-Null
  Press '작업 패널 닫기'
  Press '프로젝트 저장 (Ctrl+S)'
  Wait-For {
    $project=Get-Content -LiteralPath $saved -Raw -Encoding UTF8 | ConvertFrom-Json
    @($project.clips | Where-Object {$_.preset -eq 'warm'}).Count -eq 2 -and [Math]::Abs($project.clips[0].volume-1) -gt .001
  } 'saved color and loudness changes' | Out-Null
  # Restore neutral colors for comparison to the original frame in the decode check.
  foreach($edit in 1..3){Press '실행 취소 (Ctrl+Z)'}
  Press '프로젝트 저장 (Ctrl+S)'
  Wait-For {
    $project=Get-Content -LiteralPath $saved -Raw -Encoding UTF8 | ConvertFrom-Json
    @($project.clips | Where-Object {$_.preset -eq 'warm'}).Count -eq 0 -and $project.clips[0].volume -eq 1
  } 'undo restores original grade and volume' | Out-Null
  $output=Join-Path $caseDir 'finished.mp4'
  Press '내보내기'
  Choose-Mp4
  Press '내보내기 시작'
  File-Dialog $output
  Wait-For { $value=Get-Control '내보낸 파일 경로';$value -and $value.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).Current.Value -eq $output } 'rendered MP4' 240 | Out-Null
  Press '작업 패널 닫기'
  Press '프로젝트'
  Invoke-Control (By-ButtonPrefix '새 프로젝트')
  Press '가져오기'
  File-Dialog $output
  Press 'finished.mp4 타임라인에 추가'
  Press '프로그램'
  Seek '00:00:06:00'
  Start-Sleep -Milliseconds 1100
  Snapshot 'finished'
  $proof=[ordered]@{passed=$true;version=$projectVersion;project=$saved;output=$output;screenshot=(Join-Path $caseDir 'finished.png');checks=@('native-import','two-cuts-at-frame-150','caption-at-five','caption-replace','save-project','find-later-duplicate','color-copy-paste','match-measured-gain','undo-three-edits','render-mp4','reimport-output','capture-at-six')}
  $proof['checkedAt']=[DateTime]::UtcNow.ToString('o')
  $proof['executable']=$start.FileName
  $proof['scope']=if($Source){'development Windows UI'}else{'installed Windows UI'}
  if(-not $Source){
    $asar=Join-Path (Split-Path $start.FileName) 'resources/app.asar'
    $stream=[IO.File]::OpenRead($asar)
    $sha=[Security.Cryptography.SHA256]::Create()
    try {$proof['appAsarSha256']=[BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-','').ToLowerInvariant()}
    finally {$sha.Dispose();$stream.Dispose()}
    $proof['buildReceiptId']=(Get-Content -Raw -Encoding UTF8 'dist-electron/build-receipt.json' | ConvertFrom-Json).contentId
  }
  $json=$proof | ConvertTo-Json
  $json | Set-Content -LiteralPath (Join-Path $caseDir 'result.json') -Encoding utf8
  if($Report){$json | Set-Content -LiteralPath $Report -Encoding utf8}
  Write-Output $json
} catch {
  Write-Output $_.ScriptStackTrace
  if($window){try{Dump-Tree $window 'failure-tree.json';Snapshot 'failure'}catch{}}
  if(Window-Of '#32770'){Write-Output 'A native file dialog was still open.'}
  throw
} finally { $editorProcess.Dispose() }
