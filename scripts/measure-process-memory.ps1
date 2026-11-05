param(
  [Parameter(Mandatory=$true)][string]$PidFile,
  [Parameter(Mandatory=$true)][string]$StopFile,
  [Parameter(Mandatory=$true)][int]$OwnerPid
)
$ErrorActionPreference = 'Stop'
$began = [Diagnostics.Stopwatch]::StartNew()
[Console]::WriteLine('{"ready":true}')
while (-not (Test-Path -LiteralPath $StopFile)) {
  if ($began.Elapsed.TotalSeconds -gt 180 -or -not (Get-Process -Id $OwnerPid -ErrorAction SilentlyContinue)) { break }
  $ownedIds = @()
  if (Test-Path -LiteralPath $PidFile) {
    $ownedIds = @(Get-Content -LiteralPath $PidFile | Where-Object { $_ -match '^\d+$' } | ForEach-Object { [int]$_ })
  }
  $items = @()
  foreach ($ownedId in $ownedIds) {
    $item = Get-Process -Id $ownedId -ErrorAction SilentlyContinue
    if ($item) {
      try { $items += @{id=$item.Id; workingSetBytes=$item.WorkingSet64; peakWorkingSetBytes=$item.PeakWorkingSet64} } catch {}
    }
  }
  [Console]::WriteLine((ConvertTo-Json -Compress -Depth 4 -InputObject @{seconds=$began.Elapsed.TotalSeconds; processes=$items}))
  Start-Sleep -Milliseconds 50
}
