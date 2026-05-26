$env:RIN_BOOTSTRAP_WRAPPER_MODE = "update"
$scriptPath = Join-Path $PSScriptRoot "install.ps1"
& $scriptPath @args
exit $LASTEXITCODE
