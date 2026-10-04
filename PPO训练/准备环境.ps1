$ErrorActionPreference = 'Stop'

$trainingRoot = $PSScriptRoot
$runtimeRoot = Join-Path $trainingRoot '.runtime'
$nodeFile = Join-Path $runtimeRoot 'node\node.exe'
$pnpmFile = Join-Path $runtimeRoot 'pnpm\bin\pnpm.mjs'
$venvPython = Join-Path $runtimeRoot 'python\Scripts\python.exe'

New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null

if (-not (Test-Path -LiteralPath $nodeFile) -or -not (Test-Path -LiteralPath $pnpmFile)) {
    # This computer's Codex runtime already contains Node and pnpm. Make a
    # project-local copy so a double-click does not depend on Codex's PATH.
    $codexNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node'
    $sourceNode = Join-Path $codexNode 'bin\node.exe'
    $sourcePnpm = Join-Path $codexNode 'node_modules\pnpm'
    if (-not (Test-Path -LiteralPath $sourceNode) -or -not (Test-Path -LiteralPath $sourcePnpm)) {
        throw "Cannot provision project-local Node/pnpm. Expected $sourceNode and $sourcePnpm."
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $nodeFile) | Out-Null
    Copy-Item -LiteralPath $sourceNode -Destination $nodeFile -Force
    if (-not (Test-Path -LiteralPath $pnpmFile)) {
        Copy-Item -LiteralPath $sourcePnpm -Destination (Join-Path $runtimeRoot 'pnpm') -Recurse -Force
    }
}

$pythonCandidates = @('D:\Python\python.exe')
$fromPath = Get-Command python.exe -ErrorAction SilentlyContinue
if ($fromPath) { $pythonCandidates += $fromPath.Source }
$systemPython = $pythonCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $systemPython -and -not (Test-Path -LiteralPath $venvPython)) {
    throw 'Python is missing. Install Python 3.12 with CUDA PyTorch, then rerun this launcher.'
}
if (-not (Test-Path -LiteralPath $venvPython)) {
    Write-Host 'Preparing project-local Python environment...'
    & $systemPython -m venv --system-site-packages (Join-Path $runtimeRoot 'python')
    if ($LASTEXITCODE -ne 0) { throw 'Creating the Python environment failed.' }
}

$env:PATH = "$(Split-Path -Parent $nodeFile);$env:PATH"
& $nodeFile $pnpmFile --version | Out-Host
if ($LASTEXITCODE -ne 0) { throw 'The project-local pnpm installation is incomplete.' }
& $venvPython -c 'import torch; print(torch.__version__, torch.cuda.is_available())'
if ($LASTEXITCODE -ne 0) { throw 'PyTorch is not available in the project-local Python environment.' }
Write-Host 'PPO environment ready.'
