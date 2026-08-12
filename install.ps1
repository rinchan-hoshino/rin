$ErrorActionPreference = "Stop"
$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { "" }
$mode = if ($env:RIN_BOOTSTRAP_WRAPPER_MODE) { $env:RIN_BOOTSTRAP_WRAPPER_MODE } else { "install" }
$localBootstrapScript = if ($scriptDir) { Join-Path $scriptDir "scripts/bootstrap-entrypoint.ps1" } else { "" }

function Build-BootstrapArgs([object[]]$RawArgs) {
  $result = @()
  foreach ($arg in $RawArgs) {
    if ($null -ne $arg) { $result += [string]$arg }
  }
  return $result
}

$bootstrapArgs = @(Build-BootstrapArgs $args)

if ($localBootstrapScript -and (Test-Path -LiteralPath $localBootstrapScript)) {
  & $localBootstrapScript "--mode" $mode @bootstrapArgs
  exit $LASTEXITCODE
}

$repoUrl = if ($env:RIN_INSTALL_REPO_URL) { $env:RIN_INSTALL_REPO_URL } else { "https://github.com/rinchan-hoshino/rin" }
$defaultBootstrapBranch = "main"
$bootstrapBranch = if ($env:RIN_BOOTSTRAP_BRANCH) { $env:RIN_BOOTSTRAP_BRANCH } else { $defaultBootstrapBranch }
$rawBase = ($repoUrl -replace "^https://github.com/", "https://raw.githubusercontent.com/") -replace "\.git$", ""
$bootstrapScriptUrl = if ($env:RIN_BOOTSTRAP_SCRIPT_URL) { $env:RIN_BOOTSTRAP_SCRIPT_URL } else { "$rawBase/$bootstrapBranch/scripts/bootstrap-entrypoint.ps1" }
$cacheBase = if ($env:XDG_CACHE_HOME) { $env:XDG_CACHE_HOME } elseif ($env:TEMP) { $env:TEMP } else { [System.IO.Path]::GetTempPath() }
$tempBase = if ($env:RIN_INSTALL_TMPDIR) { $env:RIN_INSTALL_TMPDIR } else { Join-Path $cacheBase "rin-install" }
New-Item -ItemType Directory -Force -Path $tempBase | Out-Null
$bootstrapScript = Join-Path $tempBase ("bootstrap-entrypoint.{0}.ps1" -f ([System.Guid]::NewGuid().ToString("N")))

function Fetch-File([string]$Url, [string]$OutFile) {
  Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $OutFile
}

try {
  Fetch-File $bootstrapScriptUrl $bootstrapScript

  & $bootstrapScript "--mode" $mode @bootstrapArgs
  exit $LASTEXITCODE
} finally {
  Remove-Item -LiteralPath $bootstrapScript -Force -ErrorAction SilentlyContinue
}
