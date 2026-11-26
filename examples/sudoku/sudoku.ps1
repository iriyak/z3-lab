# sudoku.ps1 - PowerShell launcher for sudoku.ts (needs bun; z3 comes from lib\z3, see scripts\get-z3.ps1).
# Works in Windows PowerShell 5.1 and PowerShell 7+. Run it from the lab folder or anywhere.
#
# Usage:
#   .\examples\sudoku\sudoku.ps1                              # built-in example puzzle (the Wikipedia one)
#   .\examples\sudoku\sudoku.ps1 examples\sudoku\puzzle.txt  # puzzle from a file (a sample is in this folder)
#   Get-Content examples\sudoku\puzzle.txt | .\examples\sudoku\sudoku.ps1   # puzzle from the pipeline
#
# Puzzle: 81 cells row by row. 1-9 are givens; "." "0" "_" "*" are blanks.
# Spaces, "|" and "---+---" lines are ignored, so a pretty-printed grid can be pasted as is.
# Prints the solution grid, then "unique solution" or another solution if there is one.
# Exit code: 0 solved, 10 no solution, 2 bad input.
$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'sudoku.ts'

# Forward pipeline input to bun's stdin ("-" tells sudoku.ts to read it).
if ($MyInvocation.ExpectingInput) {
    $a = if ($args.Count -eq 0) { @('-') } else { $args }
    $input | & bun $script @a
} else {
    & bun $script @args
}
exit $LASTEXITCODE
