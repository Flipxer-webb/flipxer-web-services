# Database Backup Script for Windows
# Usage: .\scripts\backup-database.ps1

$ErrorActionPreference = "Stop"

# Load environment variables from .env
if (Test-Path .env) {
    Get-Content .env | ForEach-Object {
        if ($_ -match '^([^#][^=]+)=(.*)$') {
            [Environment]::SetEnvironmentVariable($matches[1], $matches[2], "Process")
        }
    }
}

$Timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$BackupDir = ".\backups"
$BackupFile = "$BackupDir\backup_$Timestamp.sql"

# Create backup directory if it doesn't exist
if (-not (Test-Path $BackupDir)) {
    New-Item -ItemType Directory -Path $BackupDir | Out-Null
}

Write-Host "🔄 Starting database backup..." -ForegroundColor Cyan

$DatabaseUrl = $env:DATABASE_URL

# Use pg_dump to create backup
pg_dump $DatabaseUrl | Out-File -FilePath $BackupFile -Encoding UTF8

Write-Host "✅ Backup created: $BackupFile" -ForegroundColor Green

# Compress backup
Compress-Archive -Path $BackupFile -DestinationPath "$BackupFile.zip" -Force
Remove-Item $BackupFile

Write-Host "✅ Compressed backup: $BackupFile.zip" -ForegroundColor Green

$Size = (Get-Item "$BackupFile.zip").Length / 1MB
Write-Host "📊 Backup size: $([math]::Round($Size, 2)) MB" -ForegroundColor Yellow
