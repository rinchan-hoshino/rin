$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$rinNodeVersion = '24.18.0'
$rinNodeBase = "https://nodejs.org/download/release/v$rinNodeVersion"
$rinInstallHome = if ($env:RIN_HOME) { $env:RIN_HOME } else { Join-Path $env:LOCALAPPDATA 'Rin' }

function Test-Node24 {
  $nodeCommand = Get-Command node -CommandType Application -ErrorAction SilentlyContinue
  if (-not $nodeCommand) { return $false }
  $nodePath = & $nodeCommand.Source -p 'process.execPath'
  if ($LASTEXITCODE -ne 0 -or $nodePath.StartsWith((Join-Path $env:USERPROFILE '.rin') + '\', [StringComparison]::OrdinalIgnoreCase)) { return $false }
  & $nodeCommand.Source -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)'
  return $LASTEXITCODE -eq 0
}

$rinNeedGit = -not [bool](Get-Command git -ErrorAction SilentlyContinue)
$rinNeedNode = -not (Test-Node24)
if ($rinNeedGit -or $rinNeedNode) {
  Write-Host 'Rin needs to install missing prerequisites before continuing:'
  if ($rinNeedGit) { Write-Host '  - Git, using Windows Package Manager (winget)' }
  if ($rinNeedNode) { Write-Host "  - Node.js v$rinNodeVersion, downloaded from nodejs.org into $rinInstallHome\runtime" }
  $answer = Read-Host 'Continue? [y/N]'
  if ($answer -notmatch '^(?i:y|yes)$') { throw 'Installation cancelled.' }
}

if ($rinNeedGit) {
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if (-not $winget) { throw 'Windows Package Manager (winget) is required to install Git. Install App Installer, then retry.' }
  & $winget.Source install --id Git.Git --exact --source winget --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) { throw "winget could not install Git (exit $LASTEXITCODE)." }
  $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:PATH = @($machinePath, $userPath) -join ';'
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'Git was installed but is not available yet. Open a new terminal and run this installer again.' }
}

function Install-ManagedNode {
  $architecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
  $arch = switch ($architecture) {
    'X64' { 'x64' }
    'Arm64' { 'arm64' }
    default { throw "Unsupported Windows architecture for Node.js: $architecture" }
  }
  $archive = "node-v$rinNodeVersion-win-$arch.zip"
  $runtime = Join-Path $rinInstallHome 'runtime'
  $target = Join-Path $runtime "node-v$rinNodeVersion"
  New-Item -ItemType Directory -Path $runtime -Force | Out-Null
  if (Test-Path $target) {
    if (-not (Test-Path (Join-Path $target 'node.exe'))) { throw "The managed Node.js directory exists but is incomplete: $target" }
  } else {
    $stage = Join-Path $runtime ('.node-install-' + [guid]::NewGuid())
    try {
      New-Item -ItemType Directory -Path $stage | Out-Null
      $archivePath = Join-Path $stage $archive
      $sumsPath = Join-Path $stage 'SHASUMS256.txt'
      [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
      Invoke-WebRequest -UseBasicParsing -Uri "$rinNodeBase/$archive" -OutFile $archivePath
      Invoke-WebRequest -UseBasicParsing -Uri "$rinNodeBase/SHASUMS256.txt" -OutFile $sumsPath
      $entries = @(Get-Content -LiteralPath $sumsPath | Where-Object { $_ -match ('^[A-Fa-f0-9]{64}\s+' + [regex]::Escape($archive) + '$') })
      if ($entries.Count -ne 1) { throw 'Node.js checksum entry is missing or ambiguous.' }
      $expected = ($entries[0] -split '\s+')[0].ToLowerInvariant()
      $actual = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($actual -ne $expected) { throw 'Node.js archive checksum verification failed.' }
      Expand-Archive -LiteralPath $archivePath -DestinationPath $stage
      $extracted = Join-Path $stage "node-v$rinNodeVersion-win-$arch"
      if (-not (Test-Path (Join-Path $extracted 'node.exe'))) { throw 'Verified Node.js archive has an unexpected layout.' }
      Move-Item -LiteralPath $extracted -Destination $target
    } finally {
      if (Test-Path $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
    }
  }
  $env:PATH = "$target;$env:PATH"
}

if (-not (Test-Node24)) { Install-ManagedNode }
if (-not (Test-Node24)) { throw 'Node.js 24 could not be prepared.' }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'Git installation did not complete. Run this installer again.' }

if ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot 'src/install/bootstrap.mjs'))) {
  & node (Join-Path $PSScriptRoot 'src/install/bootstrap.mjs')
  if ($LASTEXITCODE -ne 0) { throw "Rin installation failed (exit $LASTEXITCODE)." }
  return
}

$rinBootstrapDir = Join-Path ([IO.Path]::GetTempPath()) ('rin-install-' + [guid]::NewGuid())
try {
  & git clone --depth 1 --branch main 'https://github.com/rinchan-hoshino/rin.git' $rinBootstrapDir
  if ($LASTEXITCODE -ne 0) { throw "Could not clone Rin (exit $LASTEXITCODE)." }
  & node (Join-Path $rinBootstrapDir 'src/install/bootstrap.mjs')
  if ($LASTEXITCODE -ne 0) { throw "Rin installation failed (exit $LASTEXITCODE)." }
} finally {
  if (Test-Path $rinBootstrapDir) { Remove-Item -LiteralPath $rinBootstrapDir -Recurse -Force }
}
