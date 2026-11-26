# enumerate.ps1 - PowerShell launcher for enumerate.ts: counts every solution of a Sudoku with one resident solver session.
# Works in Windows PowerShell 5.1 and PowerShell 7+. Run it from the lab folder or anywhere.
#
# Usage:
#   .\examples\sudoku\enumerate.ps1                                   # puzzle-few.txt in this folder (33 solutions)
#   .\examples\sudoku\enumerate.ps1 examples\sudoku\puzzle.txt    # a puzzle from a file (that one has exactly 1)
#   .\examples\sudoku\enumerate.ps1 --print --max 3                   # print the first 3 solutions as grids
#   .\examples\sudoku\enumerate.ps1 --fresh                           # same, but without a session (slower; for comparison)
#   Get-Content examples\sudoku\puzzle-few.txt | .\examples\sudoku\enumerate.ps1   # puzzle from the pipeline
#
# Options: --max N (default 1000), --print, --fresh. Puzzle format as in sudoku.ps1.
# Exit code: 0 finished (or stopped at --max), 2 bad input, 1 solver trouble.
$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'enumerate.ts'

# Forward pipeline input to bun's stdin ("-" tells enumerate.ts to read it).
if ($MyInvocation.ExpectingInput) {
    $a = if ($args.Count -eq 0) { @('-') } else { $args }
    $input | & bun $script @a
} else {
    & bun $script @args
}
exit $LASTEXITCODE
