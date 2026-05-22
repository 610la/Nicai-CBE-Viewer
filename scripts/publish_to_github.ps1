param(
  [switch]$CheckOnly
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
Set-Location -LiteralPath $RepoRoot

function Require-Git {
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw "Git is not installed or is not in PATH. Install Git for Windows first."
  }
}

function Run-Git {
  param([string[]]$GitArgs)
  Write-Host ""
  Write-Host ("git " + ($GitArgs -join " ")) -ForegroundColor Cyan
  & git @GitArgs
  if ($LASTEXITCODE -ne 0) {
    throw "Git command failed: git $($GitArgs -join ' ')"
  }
}

function Git-Text {
  param([string[]]$GitArgs)
  $text = & git @GitArgs 2>$null
  if ($LASTEXITCODE -ne 0) {
    return ""
  }
  return (($text | Out-String).Trim())
}

function Assert-NoForbiddenFiles {
  $root = (Resolve-Path -LiteralPath $RepoRoot).Path
  $forbidden = Get-ChildItem -LiteralPath $root -Recurse -Force -File |
    Where-Object {
      $full = $_.FullName
      $rel = [System.IO.Path]::GetRelativePath($root, $full).Replace("\", "/")
      if ($rel.StartsWith("cbe file/") -or $rel.StartsWith("nicai system files/")) { return $false }
      if ($full -match "\\.git\\") { return $false }
      if ($full -match "\\out[^\\]*\\") { return $true }
      if ($full -match "\\nicai\\") { return $true }
      return $_.Name -match "\.(CBE|cbe|sav|dat|idx|rs1|rs2|rs3|log|png|jpg|jpeg|gif)$"
    } |
    Select-Object -First 20

  if ($forbidden) {
    Write-Host "Found files that should not be uploaded:" -ForegroundColor Red
    foreach ($file in $forbidden) {
      Write-Host (" - " + $file.FullName)
    }
    throw "Stop: remove these files or update .gitignore before publishing."
  }
}

function Ensure-GitIdentity {
  $name = Git-Text @("config", "user.name")
  $email = Git-Text @("config", "user.email")

  if (-not $name) {
    $name = Read-Host "Git author name"
    if (-not $name) { throw "Git author name is required." }
    Run-Git @("config", "user.name", $name)
  }

  if (-not $email) {
    $email = Read-Host "Git author email"
    if (-not $email) { throw "Git author email is required." }
    Run-Git @("config", "user.email", $email)
  }
}

function Ensure-Remote {
  $origin = Git-Text @("remote", "get-url", "origin")
  if ($origin) {
    Write-Host ""
    Write-Host "Existing origin: $origin"
    $answer = Read-Host "Use this origin? [Y/n]"
    if ($answer -match "^[Nn]") {
      $origin = ""
    }
  }

  if (-not $origin) {
    Write-Host ""
    Write-Host "Create an empty GitHub repo first, then paste its URL here."
    Write-Host "Example HTTPS: https://github.com/YOUR_NAME/YOUR_REPO.git"
    Write-Host "Example SSH:   git@github.com:YOUR_NAME/YOUR_REPO.git"
    $origin = Read-Host "GitHub repository URL"
    if (-not $origin) { throw "GitHub repository URL is required." }

    $existing = Git-Text @("remote")
    if (($existing -split "\r?\n") -contains "origin") {
      Run-Git @("remote", "set-url", "origin", $origin)
    } else {
      Run-Git @("remote", "add", "origin", $origin)
    }
  }
}

try {
  Require-Git
  Write-Host "Repository folder: $RepoRoot" -ForegroundColor Green
  Assert-NoForbiddenFiles

  if ($CheckOnly) {
    Write-Host "Check passed. No forbidden publish files were found." -ForegroundColor Green
    exit 0
  }

  if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot ".git"))) {
    Run-Git @("init", "-b", "main")
  }

  Ensure-GitIdentity

  $branch = Git-Text @("branch", "--show-current")
  if (-not $branch) {
    $branch = "main"
    Run-Git @("checkout", "-B", $branch)
  }

  Run-Git @("add", ".")
  $status = Git-Text @("status", "--short")
  if ($status) {
    Write-Host ""
    Write-Host "Files to commit:"
    Write-Host $status
    $message = Read-Host "Commit message [Initial CBE emulator research toolkit]"
    if (-not $message) {
      $message = "Initial CBE emulator research toolkit"
    }
    Run-Git @("commit", "-m", $message)
  } else {
    Write-Host "No local changes to commit."
  }

  Ensure-Remote
  Run-Git @("push", "-u", "origin", $branch)

  Write-Host ""
  Write-Host "Done. The repository was pushed to GitHub." -ForegroundColor Green
} catch {
  Write-Host ""
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
}
