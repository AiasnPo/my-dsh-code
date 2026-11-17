#Requires -Version 5.1
<#
  One-shot publisher for dsh-ctx-meter.

  Usage (from anywhere):
    pwsh -File scripts\publish.ps1 -User <your-github-username>

  Optional:
    -Repo    dsh-ctx-meter      target repository name
    -Message "..."              commit message
    -NoPush                     commit only, skip `git push`

  What it does:
    1. locates git.exe (PATH, standard install dirs, GitHub Desktop bundle)
    2. replaces the github.com/USER/ placeholders in package.json
    3. git init (branch main) + local user.name/user.email fallback
    4. git add -A + commit (skipped when nothing to commit)
    5. remote origin -> https://github.com/<User>/<Repo>.git
    6. git push -u origin main
#>
param(
  [Parameter(Mandatory = $true)][string]$User,
  [string]$Repo = "dsh-ctx-meter",
  [string]$Message = "feat: dsh-ctx-meter v1.0.0 - per-session context accounting, stale detection, purge & slim",
  [switch]$NoPush
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

function Find-Git {
  if ($env:DSH_PUBLISH_GIT -and (Test-Path $env:DSH_PUBLISH_GIT)) { return $env:DSH_PUBLISH_GIT }
  $candidates = @(
    "C:\Program Files\Git\cmd\git.exe",
    "C:\Program Files (x86)\Git\cmd\git.exe",
    "$env:LOCALAPPDATA\Programs\Git\cmd\git.exe",
    "D:\Program Files\Git\cmd\git.exe"
  )
  $bundles = @(
    "$env:LOCALAPPDATA\GitHubDesktop",
    "$env:LOCALAPPDATA\Programs\GitHub Desktop",
    "C:\Program Files\GitHub Desktop",
    "D:\Program Files\GitHub Desktop"
  )
  foreach ($dir in $bundles) {
    if (Test-Path $dir) {
      $hit = Get-ChildItem $dir -Filter git.exe -Recurse -ErrorAction SilentlyContinue |
        Select-Object -First 1 -ExpandProperty FullName
      if ($hit) { $candidates += $hit }
    }
  }
  $onPath = (Get-Command git -ErrorAction SilentlyContinue).Source
  if ($onPath) { return $onPath }
  foreach ($c in $candidates) { if ($c -and (Test-Path $c)) { return $c } }
  return $null
}

$git = Find-Git
if (-not $git) {
  Write-Host "[dsh-ctx] git.exe not found." -ForegroundColor Red
  Write-Host "  Install one of:"
  Write-Host "    - Git for Windows  https://git-scm.com/download/win"
  Write-Host "    - GitHub Desktop  https://desktop.github.com"
  Write-Host "  Then run this script again."
  Write-Host "  Already installed? Pass the exe path explicitly:"
  Write-Host "    `$env:DSH_PUBLISH_GIT='C:\path\to\git.exe'"
  exit 1
}
Write-Host "[dsh-ctx] git: $git" -ForegroundColor DarkGray

# 1) fill placeholders
$pkgPath = Join-Path $root "package.json"
$pkg = [System.IO.File]::ReadAllText($pkgPath)
if ($pkg -match 'github\.com/USER/') {
  $pkg = $pkg -replace 'github\.com/USER/', "github.com/$User/"
  [System.IO.File]::WriteAllText($pkgPath, $pkg, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "[dsh-ctx] package.json: USER -> $User" -ForegroundColor Green
}

# 2) init
if (-not (Test-Path (Join-Path $root ".git"))) {
  & $git init | Out-Null
  & $git symbolic-ref HEAD refs/heads/main
  Write-Host "[dsh-ctx] git init (branch main)" -ForegroundColor Green
}

# 3) identity fallback (repo-local only)
if (-not (& $git config user.name)) { & $git config user.name $User }
if (-not (& $git config user.email)) { & $git config user.email "$User@users.noreply.github.com" }

# 4) stage + commit
& $git add -A
& $git diff --cached --quiet
if ($LASTEXITCODE -ne 0) {
  & $git commit -m $Message | Out-Null
  Write-Host "[dsh-ctx] committed" -ForegroundColor Green
} else {
  Write-Host "[dsh-ctx] nothing new to commit" -ForegroundColor Yellow
}

# 5) remote
$url = "https://github.com/$User/$Repo.git"
$existing = & $git remote
if ($existing -contains "origin") {
  & $git remote set-url origin $url
} else {
  & $git remote add origin $url
}
Write-Host "[dsh-ctx] origin -> $url" -ForegroundColor Green

# 6) push
if ($NoPush) {
  Write-Host "[dsh-ctx] -NoPush given, stop before push." -ForegroundColor Yellow
  exit 0
}
& $git push -u origin main
if ($LASTEXITCODE -ne 0) {
  Write-Host "[dsh-ctx] push failed. Check the repo exists and you are signed in." -ForegroundColor Red
  exit $LASTEXITCODE
}
Write-Host "[dsh-ctx] done: https://github.com/$User/$Repo" -ForegroundColor Green
