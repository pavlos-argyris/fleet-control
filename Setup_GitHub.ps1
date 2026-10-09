param([string]$Repository = 'fleet-control', [string]$Owner = '')
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if ($Repository -notmatch '^[A-Za-z0-9._-]+$') { throw 'Invalid repository name.' }
if (-not (Get-Command git -ErrorAction SilentlyContinue) -or -not (Get-Command gh -ErrorAction SilentlyContinue)) { throw 'Install Git for Windows and GitHub CLI, then run this script again.' }
gh auth status
if ($LASTEXITCODE -ne 0) { gh auth login; if ($LASTEXITCODE -ne 0) { throw 'GitHub login was not completed.' } }
if (-not $Owner) { $Owner = (gh api user --jq '.login').Trim(); if ($LASTEXITCODE -ne 0) { throw 'Cannot identify the GitHub account.' } }
if ($Owner -notmatch '^[A-Za-z0-9-]+$') { throw 'Invalid GitHub owner.' }
$FullName = "$Owner/$Repository"
$Private = gh repo view $FullName --json isPrivate --jq '.isPrivate' 2>$null
if ($LASTEXITCODE -eq 0) {
  if ($Private.Trim() -ne 'true') { throw 'Use a private repository.' }
} else {
  gh repo create $FullName --private
  if ($LASTEXITCODE -ne 0) { throw 'The private repository could not be created.' }
}
gh auth setup-git
if ($LASTEXITCODE -ne 0) { throw 'Git authentication could not be configured.' }
$Remote = git remote get-url origin 2>$null
if ($LASTEXITCODE -eq 0) {
  if ($Remote -notmatch ([regex]::Escape($FullName) + '(\.git)?$')) { throw 'The existing origin points to a different project.' }
} else { git remote add origin "https://github.com/$FullName.git" }
git config core.filemode false
git push -u origin main
if ($LASTEXITCODE -ne 0) { throw 'Upload failed. Source remains available locally; do not force-push.' }
git push origin baseline-client-5.36.7-server-2.0.12 source-v5.37.0-server-v2.1.0
if ($LASTEXITCODE -ne 0) { throw 'History tags could not be uploaded.' }
Write-Host "Full source uploaded to https://github.com/$FullName. Configure the settings in docs/GITHUB_OTA_SETUP_GR.md before publishing."
