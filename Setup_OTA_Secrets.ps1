param([string]$AccountId = '')
$ErrorActionPreference = 'Stop'
if (-not (Get-Command node -ErrorAction SilentlyContinue) -or -not (Get-Command gh -ErrorAction SilentlyContinue)) {
  throw 'Install Node.js 22+ and GitHub CLI, reopen PowerShell, and run this script again.'
}
if (-not $AccountId) { $AccountId = Read-Host 'Cloudflare Account ID (32 hexadecimal characters)' }
if ($AccountId -notmatch '^[a-fA-F0-9]{32}$') { throw 'Invalid Cloudflare Account ID.' }
$FleetToken = Read-Host 'Cloudflare API token (hidden input; paste here, not in the chat)' -AsSecureString
$FleetPointer = [IntPtr]::Zero
$FleetPayload = $null
$FleetPreviousEncoding = $OutputEncoding
try {
  $FleetPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($FleetToken)
  $FleetPayload = @{
    accountId = $AccountId
    apiToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($FleetPointer)
  } | ConvertTo-Json -Compress
  $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  # The token travels through stdin, never through command-line arguments.
  $FleetPayload | node (Join-Path $PSScriptRoot 'scripts/setup-ota-secrets.mjs')
  if ($LASTEXITCODE -ne 0) { throw 'OTA setup did not complete. Follow the message above and rerun; no update was published.' }
} finally {
  if ($FleetPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($FleetPointer) }
  $FleetPayload = $null
  $FleetToken.Dispose()
  $OutputEncoding = $FleetPreviousEncoding
}
