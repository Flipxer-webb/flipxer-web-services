param(
  [string]$QueuePath = ".sonar-agent/work-queue.json"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$queueFile = Resolve-Path -Path $QueuePath
$queue = Get-Content -Raw $queueFile | ConvertFrom-Json

$summary = @($queue.items |
  Group-Object status |
  ForEach-Object {
    [pscustomobject]@{
      status = $_.Name
      count = $_.Count
      uncoveredLines = ($_.Group | Measure-Object uncoveredLines -Sum).Sum
    }
  } |
  Sort-Object status)

$inProgressByAgent = @($queue.items |
  Where-Object { $_.status -eq "in_progress" } |
  Group-Object claimedBy |
  ForEach-Object {
    [pscustomobject]@{
      agentId = $_.Name
      count = $_.Count
      uncoveredLines = ($_.Group | Measure-Object uncoveredLines -Sum).Sum
    }
  } |
  Sort-Object uncoveredLines -Descending)

[pscustomobject]@{
  projectKey = $queue.projectKey
  generatedAtUtc = [DateTime]::UtcNow.ToString("o")
  summary = $summary
  inProgressByAgent = $inProgressByAgent
} | ConvertTo-Json -Depth 8
