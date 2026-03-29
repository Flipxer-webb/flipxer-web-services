param(
  [Parameter(Mandatory = $true)]
  [string]$AgentId,

  [Parameter(Mandatory = $true)]
  [int]$ItemId,

  [string]$Reason,

  [string]$QueuePath = ".sonar-agent/work-queue.json",

  [string]$LockPath = ".sonar-agent/work-queue.lock",

  [int]$LockTimeoutSeconds = 20
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Open-ExclusiveFileLock {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,
    [int]$TimeoutSeconds = 20
  )

  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  while ($sw.Elapsed.TotalSeconds -lt $TimeoutSeconds) {
    try {
      return [System.IO.File]::Open($Path, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    }
    catch {
      Start-Sleep -Milliseconds 250
    }
  }

  throw "Could not acquire queue lock within $TimeoutSeconds seconds: $Path"
}

$queueFile = Resolve-Path -Path $QueuePath
$lockFile = Join-Path (Split-Path -Parent $queueFile) (Split-Path -Leaf $LockPath)
$lockStream = $null

try {
  $lockStream = Open-ExclusiveFileLock -Path $lockFile -TimeoutSeconds $LockTimeoutSeconds

  $queue = Get-Content -Raw $queueFile | ConvertFrom-Json
  $item = $queue.items | Where-Object { [int]$_.id -eq $ItemId } | Select-Object -First 1

  if (-not $item) {
    throw "Item $ItemId not found in queue."
  }

  if ($item.status -ne "in_progress") {
    throw "Item $ItemId is not in progress. Current status: $($item.status)"
  }

  if ($item.claimedBy -ne $AgentId) {
    throw "Item $ItemId is claimed by '$($item.claimedBy)', not '$AgentId'."
  }

  $item.status = "pending"
  $item.claimedBy = $null
  $item.claimedAtUtc = $null
  $item.claimExpiresAtUtc = $null
  if ($Reason) {
    $item.notes = "Released by {0}: {1}" -f $AgentId, $Reason
  }

  $queue | ConvertTo-Json -Depth 10 | Set-Content -Path $queueFile -Encoding UTF8

  [pscustomobject]@{
    released = $true
    item = $item
  } | ConvertTo-Json -Depth 10
}
finally {
  if ($lockStream) {
    $lockStream.Dispose()
  }
}
