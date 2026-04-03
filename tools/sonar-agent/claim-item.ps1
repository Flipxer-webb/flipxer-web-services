param(
  [Parameter(Mandatory = $true)]
  [string]$AgentId,

  [Parameter(Mandatory = $true)]
  [int]$ItemId,

  [int]$LeaseMinutes = 120,

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
  $now = [DateTime]::UtcNow

  foreach ($item in $queue.items) {
    if ($item.status -eq "in_progress" -and $item.claimExpiresAtUtc) {
      $expiry = [DateTime]::Parse($item.claimExpiresAtUtc).ToUniversalTime()
      if ($expiry -le $now) {
        $item.status = "pending"
        $item.claimedBy = $null
        $item.claimedAtUtc = $null
        $item.claimExpiresAtUtc = $null
      }
    }
  }

  $target = $queue.items | Where-Object { [int]$_.id -eq $ItemId } | Select-Object -First 1

  if (-not $target) {
    throw "Item $ItemId not found in queue."
  }

  if ($target.status -eq "done") {
    throw "Item $ItemId is already done."
  }

  if ($target.status -eq "in_progress") {
    throw "Item $ItemId is already claimed by '$($target.claimedBy)' until $($target.claimExpiresAtUtc)."
  }

  $target.status = "in_progress"
  $target.claimedBy = $AgentId
  $target.claimedAtUtc = $now.ToString("o")
  $target.claimExpiresAtUtc = $now.AddMinutes($LeaseMinutes).ToString("o")

  $queue | ConvertTo-Json -Depth 10 | Set-Content -Path $queueFile -Encoding UTF8

  [pscustomobject]@{
    claimed = $true
    item = $target
  } | ConvertTo-Json -Depth 10
}
finally {
  if ($lockStream) {
    $lockStream.Dispose()
  }
}
