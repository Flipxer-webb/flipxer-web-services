[CmdletBinding()]
param(
    [string]$OutputPath = ".\\_artifacts\\aikido-backend-opengrep-local.json"
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\\..")).Path
Set-Location $repoRoot

$openGrepExe = Join-Path $env:LOCALAPPDATA "aikido-mcp\\pyopengrep-venv\\Scripts\\pyopengrep.exe"
if (-not (Test-Path $openGrepExe)) {
    throw "OpenGrep executable not found at '$openGrepExe'. Repair the local Aikido/OpenGrep runtime first."
}

$ruleDirectories = @(
    (Join-Path $env:LOCALAPPDATA "aikido-mcp\\opengrep_rules\\rules"),
    (Join-Path $env:LOCALAPPDATA "aikido-mcp\\opengrep_rules\\rules_new")
) | Where-Object { Test-Path $_ }

if ($ruleDirectories.Count -eq 0) {
    throw "No OpenGrep rule directories were found under '$env:LOCALAPPDATA\\aikido-mcp\\opengrep_rules'."
}

$scanTargets = @(
    "src",
    "prisma",
    "scripts/supported"
)

$excludePaths = @(
    "/*.js",
    "/*.cjs",
    "/*.ts",
    "/Dockerfile",
    "**/__tests__/**",
    "**/*.spec.ts",
    "**/*.spec.js",
    "**/*.test.ts",
    "**/*.test.js",
    "test/**",
    "test_scripts/**",
    "coverage/**",
    "dist/**",
    "prisma/scripts/**",
    "scripts/incident-archive/**"
)

$excludeRules = @(
    "AIK_ts_node_nosqli_injection"
)

$postFilterRuleSuffixes = @(
    "AIK_ts_node_nosqli_injection"
)

$postFilterPathPatterns = @(
    "(^|/)coverage/",
    "(^|/)__tests__/",
    "\.spec\.(ts|js)$",
    "\.test\.(ts|js)$",
    "^test/",
    "^test_scripts/",
    "^prisma/scripts/",
    "^scripts/incident-archive/",
    "^[^/]+\.(js|cjs|ts)$"
)

$resolvedOutputPath = if ([System.IO.Path]::IsPathRooted($OutputPath)) {
    $OutputPath
} else {
    Join-Path $repoRoot $OutputPath
}

$outputDirectory = Split-Path -Parent $resolvedOutputPath
if ($outputDirectory -and -not (Test-Path $outputDirectory)) {
    New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
}

$rawOutputPath = [System.IO.Path]::ChangeExtension(
    [System.IO.Path]::GetTempFileName(),
    ".json"
)

function ShouldIgnoreResult($result) {
    $ruleId = [string]$result.check_id
    foreach ($ruleSuffix in $postFilterRuleSuffixes) {
        if ($ruleId.EndsWith($ruleSuffix)) {
            return $true
        }
    }

    $normalizedPath = ([string]$result.path).Replace("\\", "/")
    foreach ($pathPattern in $postFilterPathPatterns) {
        if ($normalizedPath -match $pathPattern) {
            return $true
        }
    }

    return $false
}

$arguments = @(
    "scan",
    "--json",
    "--output",
    $rawOutputPath
)

foreach ($ruleDirectory in $ruleDirectories) {
    $arguments += @("--config", $ruleDirectory)
}

foreach ($excludeRule in $excludeRules) {
    $arguments += @("--exclude-rule", $excludeRule)
}

foreach ($excludePath in $excludePaths) {
    $arguments += @("--exclude", $excludePath)
}

$arguments += $scanTargets

Write-Host "Running local OpenGrep triage profile..."
$previousPythonUtf8 = $env:PYTHONUTF8
$previousPythonIoEncoding = $env:PYTHONIOENCODING
$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"

try {
    & $openGrepExe @arguments
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }

    $scanReport = Get-Content $rawOutputPath -Raw | ConvertFrom-Json
    $filteredResults = @(
        $scanReport.results | Where-Object { -not (ShouldIgnoreResult $_) }
    )
    $ignoredCount = @($scanReport.results).Count - $filteredResults.Count
    $scanReport.results = $filteredResults
    $scanReport | ConvertTo-Json -Depth 100 | Set-Content -Path $resolvedOutputPath -Encoding utf8
} finally {
    Remove-Item $rawOutputPath -ErrorAction SilentlyContinue

    if ($null -ne $previousPythonUtf8) {
        $env:PYTHONUTF8 = $previousPythonUtf8
    } else {
        Remove-Item Env:PYTHONUTF8 -ErrorAction SilentlyContinue
    }

    if ($null -ne $previousPythonIoEncoding) {
        $env:PYTHONIOENCODING = $previousPythonIoEncoding
    } else {
        Remove-Item Env:PYTHONIOENCODING -ErrorAction SilentlyContinue
    }
}

Write-Host "OpenGrep results written to $resolvedOutputPath ($($filteredResults.Count) findings kept, $ignoredCount ignored by the local profile)"