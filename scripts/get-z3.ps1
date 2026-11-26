# get-z3.ps1 - download the official Windows z3 release into lib\z3 (bin\z3.exe + libz3.dll).
# Usage (PowerShell, from anywhere):  .\scripts\get-z3.ps1
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$lab  = Split-Path -Parent $PSScriptRoot
$dest = Join-Path $lab 'lib\z3'

$rel   = Invoke-RestMethod -Uri 'https://api.github.com/repos/Z3Prover/z3/releases/latest' -Headers @{ 'User-Agent' = 'z3-lab' }
$asset = $rel.assets | Where-Object { $_.name -match 'x64-win\.zip$' } | Select-Object -First 1
if (-not $asset) { throw "no x64-win.zip asset in release $($rel.tag_name)" }
Write-Host "downloading $($asset.name) ($($rel.tag_name))"

$tmp = Join-Path ([IO.Path]::GetTempPath()) ('z3-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
    $zip = Join-Path $tmp $asset.name
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zip -UseBasicParsing
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    $top = Get-ChildItem -Path $tmp -Directory | Select-Object -First 1
    if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
    New-Item -ItemType Directory -Path (Split-Path $dest) -Force | Out-Null
    Move-Item -Path $top.FullName -Destination $dest
} finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
& (Join-Path $dest 'bin\z3.exe') --version
