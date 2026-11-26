# satlib-all.ps1 - run the larger SATLIB uniform random 3-SAT sets one after another and keep a log.
# Works in Windows PowerShell 5.1 and PowerShell 7+. Run it from anywhere; it works inside the lab folder.
#
# Usage:
#   .\experiments\satlib-all.ps1                              # uf/uuf 75, 125, 150, 175, 200, 225, 250 (about 100 files each), exe backend
#   .\experiments\satlib-all.ps1 -Sets uf150-645,uuf150-645   # only these sets
#   .\experiments\satlib-all.ps1 -Backend wasm -Timeout 120   # other backend / per-file limit in seconds
#
# A set that is not under work\satlib-<name> yet is downloaded from SATLIB and unpacked there (work\ is not in git).
# Each set is run with experiments\satlib.ts; the output goes to the console and is appended to work\satlib-results.txt.
# A failing set (download problem, mismatch, timeout) does not stop the rest. Sets run from small to large.
# Why exe by default: on the heavy sets (uuf250, about 10-16 s per file) it was faster than wasm; the start-up cost does not matter there.
param(
    [string]$Backend = 'exe',
    [int]$Timeout = 300,
    [string[]]$Sets
)
$lab = Split-Path -Parent $PSScriptRoot
Set-Location $lab
if (-not $Sets) {
    $Sets = @()
    foreach ($v in '75-325', '125-538', '150-645', '175-753', '200-860', '225-960', '250-1065') { $Sets += "uf$v"; $Sets += "uuf$v" }
}
New-Item -ItemType Directory -Force -Path (Join-Path $lab 'work') | Out-Null
$log = Join-Path $lab 'work\satlib-results.txt'
$base = 'https://www.cs.ubc.ca/~hoos/SATLIB/Benchmarks/SAT/RND3SAT'

foreach ($n in $Sets) {
    $dir = Join-Path $lab "work\satlib-$n"
    $have = (Test-Path $dir) -and (@(Get-ChildItem $dir -Recurse -Filter *.cnf -ErrorAction SilentlyContinue).Count -gt 0)
    if (-not $have) {
        try {
            New-Item -ItemType Directory -Force -Path $dir | Out-Null
            $tgz = Join-Path $dir "$n.tar.gz"
            Invoke-WebRequest "$base/$n.tar.gz" -OutFile $tgz
            tar -xzf $tgz -C $dir
        } catch {
            "=== $n : download failed: $($_.Exception.Message)" | Tee-Object -FilePath $log -Append
            continue
        }
    }
    "=== $n ($Backend, timeout ${Timeout}s) started $(Get-Date -Format s)" | Tee-Object -FilePath $log -Append
    & bun (Join-Path $lab 'experiments\satlib.ts') $dir --backend $Backend --timeout $Timeout 2>&1 | Tee-Object -FilePath $log -Append
    "=== $n finished $(Get-Date -Format s), exit code $LASTEXITCODE" | Tee-Object -FilePath $log -Append
}
"All done. Log: $log"
