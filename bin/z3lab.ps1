# z3lab.ps1 - PowerShell launcher for z3lab.ts (needs bun and z3). Works in Windows PowerShell 5.1 and PowerShell 7+.
# Usage: z3lab solve examples\sat-basic.smt2      (see `z3lab help`)
$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'z3lab.ts'

# Forward pipeline input (e.g. `Get-Content X.smt2 | z3lab solve`) to bun's stdin.
if ($MyInvocation.ExpectingInput) {
    $input | & bun $script @args
} else {
    & bun $script @args
}
exit $LASTEXITCODE
