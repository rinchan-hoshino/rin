$ErrorActionPreference = "Stop"

$mode = "install"
$channel = "stable"
$branch = ""
$version = ""
$gitSelector = ""
$explicitChannel = ""
$expectGitSelector = $false

function Is-Flag([string]$Value, [string]$Name) {
  return $Value -ieq "-$Name" -or $Value -ieq "--$Name"
}

function Read-OptionValue([string[]]$Values, [ref]$Index, [string]$DisplayName) {
  if ($Index.Value + 1 -ge $Values.Count) { throw "missing value for $DisplayName" }
  $Value = $Values[$Index.Value + 1]
  if (-not $Value -or $Value.StartsWith("-")) { throw "missing value for $DisplayName" }
  $Index.Value += 1
  return $Value
}

function Looks-Like-Git-Ref([string]$Value) {
  return $Value -match "^(refs/|v[0-9]|.*[~^:].*)" -or $Value -match "^[0-9a-fA-F]{7,40}$"
}

function Set-Channel([string]$Requested) {
  if ($script:explicitChannel -and $script:explicitChannel -ne $Requested) {
    throw "cannot combine conflicting release channel selectors"
  }
  $script:channel = $Requested
  $script:explicitChannel = $Requested
}

function Show-Usage {
  @"
Usage: install.ps1 [--stable] [--beta] [--nightly] [--git [main|deadbeef]] [legacy flags]

Defaults to the stable release channel.
--beta installs the current weekly beta candidate.
--nightly installs the current nightly build.
--git main or --git deadbeef selects a branch or ref directly.
Legacy flags such as --branch/--version remain supported.
"@ | Write-Host
}

function Parse-Args([string[]]$Values) {
  for ($i = 0; $i -lt $Values.Count; $i++) {
    $arg = $Values[$i]
    if (Is-Flag $arg "mode") {
      $script:mode = (Read-OptionValue $Values ([ref]$i) "--mode").ToLowerInvariant()
      if ($script:mode -notin @("install", "update")) { throw "invalid mode: $script:mode" }
      continue
    }
    if (Is-Flag $arg "stable") { Set-Channel "stable"; $script:expectGitSelector = $false; continue }
    if (Is-Flag $arg "beta") { Set-Channel "beta"; $script:expectGitSelector = $false; continue }
    if (Is-Flag $arg "nightly") { Set-Channel "nightly"; $script:expectGitSelector = $false; continue }
    if (Is-Flag $arg "git") { Set-Channel "git"; $script:expectGitSelector = $true; continue }
    if (Is-Flag $arg "branch") {
      $script:branch = Read-OptionValue $Values ([ref]$i) "--branch"
      $script:expectGitSelector = $false
      continue
    }
    if (Is-Flag $arg "version") {
      $script:version = Read-OptionValue $Values ([ref]$i) "--version"
      $script:expectGitSelector = $false
      continue
    }
    if ((Is-Flag $arg "h") -or (Is-Flag $arg "help")) {
      Show-Usage
      exit 0
    }
    if ($script:expectGitSelector -and -not $script:gitSelector -and -not $arg.StartsWith("-")) {
      $script:gitSelector = $arg
      $script:expectGitSelector = $false
      continue
    }
    if ($script:channel -in @("stable", "beta", "nightly")) {
      throw "$script:channel does not support a flag selector"
    }
    throw "unknown argument: $arg"
  }

  if (-not $script:branch -and -not $script:version -and $script:gitSelector) {
    if (Looks-Like-Git-Ref $script:gitSelector) {
      $script:version = $script:gitSelector
    } else {
      $script:branch = $script:gitSelector
    }
  }

  if ($script:branch -and $script:version) { throw "cannot combine --branch and --version" }
  if ($script:channel -eq "stable" -and $script:branch) { throw "stable does not support --branch" }
  if ($script:channel -eq "beta" -and ($script:branch -or $script:version)) { throw "beta does not support explicit selectors" }
  if ($script:channel -eq "nightly" -and ($script:branch -or $script:version)) { throw "nightly does not support explicit selectors" }
}

Parse-Args @($args | ForEach-Object { [string]$_ })

if ($mode -eq "update") {
  $workPrefix = "rin-update"
  $fetchLabel = "Fetching updater source"
  $prepLabel = "Preparing updater source"
  $buildLabel = "Building updater"
  $launchLabel = "Launching updater..."
  $nodeError = "rin updater requires Node.js >= 22.19.0"
} else {
  $workPrefix = "rin-install"
  $fetchLabel = "Fetching installer source"
  $prepLabel = "Preparing installer source"
  $buildLabel = "Building installer"
  $launchLabel = "Launching installer..."
  $nodeError = "rin installer requires Node.js >= 22.19.0"
}
$minimumNodeVersion = [version]"22.19.0"

$repoUrl = if ($env:RIN_INSTALL_REPO_URL) { $env:RIN_INSTALL_REPO_URL } else { "https://github.com/rinchanai/rin" }
$bootstrapBranch = if ($env:RIN_BOOTSTRAP_BRANCH) { $env:RIN_BOOTSTRAP_BRANCH } else { "bootstrap" }
$cacheBase = if ($env:XDG_CACHE_HOME) { $env:XDG_CACHE_HOME } elseif ($env:TEMP) { $env:TEMP } else { [System.IO.Path]::GetTempPath() }
$tempBase = if ($env:TEMP) { $env:TEMP } else { Join-Path $cacheBase "rin-install" }
New-Item -ItemType Directory -Force -Path $tempBase | Out-Null
$workDir = Join-Path $tempBase ("{0}.{1}" -f $workPrefix, [System.Guid]::NewGuid().ToString("N"))
$archive = Join-Path $workDir "rin.tar.gz"
$srcDir = Join-Path $workDir "src"
$manifestPath = Join-Path $workDir "release-manifest.json"
$releaseFile = Join-Path $workDir "release.json"
New-Item -ItemType Directory -Force -Path $workDir | Out-Null

function Say([string]$Message) {
  Write-Host $Message
}

function Assert-NodeVersion {
  try {
    $rawVersion = (& node -p "process.versions.node" 2>$null | Select-Object -First 1)
  } catch {
    throw $script:nodeError
  }
  if ($LASTEXITCODE -ne 0 -or -not $rawVersion) { throw $script:nodeError }
  try {
    $currentVersion = [version]($rawVersion -replace "^v", "")
  } catch {
    throw $script:nodeError
  }
  if ($currentVersion -lt $script:minimumNodeVersion) { throw $script:nodeError }
}

function Invoke-WithSpinner([string]$Label, [scriptblock]$Action) {
  $frames = @("-", "|", "/", "|")
  $job = Start-Job -ScriptBlock $Action
  $index = 0
  try {
    while ($job.State -eq "Running") {
      if (-not [Console]::IsOutputRedirected) {
        Write-Host -NoNewline ("`r{0} {1}" -f $frames[$index], $Label)
      }
      $index = ($index + 1) % $frames.Count
      Start-Sleep -Milliseconds 100
    }
    Receive-Job -Job $job -Wait -ErrorAction Stop | Out-Null
    if (-not [Console]::IsOutputRedirected) {
      Write-Host ("`rOK {0}        " -f $Label)
    }
  } catch {
    if (-not [Console]::IsOutputRedirected) {
      Write-Host ("`rERR {0}        " -f $Label)
    }
    throw
  } finally {
    Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
  }
}

function Url-Encode-Path([string]$Value) {
  (($Value -split "/") | ForEach-Object { [System.Uri]::EscapeDataString($_) }) -join "/"
}

function Get-Property($Object, [string]$Name) {
  if ($null -eq $Object) { return $null }
  return $Object.PSObject.Properties[$Name].Value
}

function Resolve-Release {
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  $packageName = if ($env:RIN_NPM_PACKAGE) { $env:RIN_NPM_PACKAGE } elseif ($manifest.packageName) { [string]$manifest.packageName } else { "@rinchanai20260422/rin" }
  $releaseRepoUrl = if ($manifest.repoUrl) { [string]$manifest.repoUrl } else { $repoUrl }
  $releaseRepoUrl = $releaseRepoUrl -replace "\.git$", ""
  $fileBase = ($packageName -split "/")[-1]
  $buildNpmTarballUrl = { param($releaseVersion) "https://registry.npmjs.org/$([System.Uri]::EscapeDataString($packageName))/-/$fileBase-$releaseVersion.tgz" }
  $buildRefArchiveUrl = { param($ref) "$releaseRepoUrl/archive/$(Url-Encode-Path $ref).tar.gz" }
  $buildBranchArchiveUrl = { param($name) "$releaseRepoUrl/archive/refs/heads/$(Url-Encode-Path $name).tar.gz" }

  if ($channel -eq "stable") {
    if ($branch) { throw "rin_stable_branch_not_supported" }
    $stable = $manifest.stable
    $resolvedVersion = if ($version) { $version } elseif ($stable.version) { [string]$stable.version } else { "0.0.0" }
    $entry = if ($version -and (Get-Property $stable "versions")) { Get-Property $stable.versions $version } else { $null }
    return [pscustomobject]@{
      PackageName = $packageName
      Channel = "stable"
      ArchiveUrl = if ($entry -and $entry.archiveUrl) { [string]$entry.archiveUrl } elseif ($stable.archiveUrl) { [string]$stable.archiveUrl } else { & $buildNpmTarballUrl $resolvedVersion }
      Version = $resolvedVersion
      Branch = "stable"
      Ref = if ($entry -and $entry.ref) { [string]$entry.ref } elseif ($stable.ref) { [string]$stable.ref } elseif ($version) { $version } else { $resolvedVersion }
      SourceLabel = if ($version) { "stable version $resolvedVersion" } else { "stable $resolvedVersion" }
    }
  }
  if ($channel -eq "beta") {
    $beta = $manifest.beta
    $resolvedRef = if ($beta.ref) { [string]$beta.ref } else { "main" }
    $resolvedVersion = if ($beta.version) { [string]$beta.version } else { "0.1.0-beta.0" }
    return [pscustomobject]@{
      PackageName = $packageName
      Channel = "beta"
      ArchiveUrl = if ($beta.archiveUrl) { [string]$beta.archiveUrl } else { & $buildRefArchiveUrl $resolvedRef }
      Version = $resolvedVersion
      Branch = "beta"
      Ref = $resolvedRef
      SourceLabel = "beta $resolvedVersion"
    }
  }
  if ($channel -eq "nightly") {
    $nightly = $manifest.nightly
    $train = $manifest.train
    $resolvedBranch = if ($nightly.branch) { [string]$nightly.branch } elseif ($train.nightlyBranch) { [string]$train.nightlyBranch } else { "main" }
    $resolvedRef = if ($nightly.ref) { [string]$nightly.ref } else { $resolvedBranch }
    $resolvedVersion = if ($nightly.version) { [string]$nightly.version } else { "0.1.0-nightly.0" }
    return [pscustomobject]@{
      PackageName = $packageName
      Channel = "nightly"
      ArchiveUrl = if ($nightly.archiveUrl) { [string]$nightly.archiveUrl } elseif ($nightly.ref) { & $buildRefArchiveUrl $resolvedRef } else { & $buildBranchArchiveUrl $resolvedBranch }
      Version = $resolvedVersion
      Branch = $resolvedBranch
      Ref = $resolvedRef
      SourceLabel = "nightly $resolvedVersion"
    }
  }

  $git = $manifest.git
  $resolvedBranch = if ($branch) { $branch } elseif ($git.defaultBranch) { [string]$git.defaultBranch } else { "main" }
  $resolvedRef = if ($version) { $version } else { $resolvedBranch }
  return [pscustomobject]@{
    PackageName = $packageName
    Channel = "git"
    ArchiveUrl = if ($version) { & $buildRefArchiveUrl $resolvedRef } else { & $buildBranchArchiveUrl $resolvedBranch }
    Version = $resolvedRef
    Branch = $resolvedBranch
    Ref = $resolvedRef
    SourceLabel = if ($version) { "git ref $resolvedRef" } else { "git branch $resolvedRef" }
  }
}

function Write-Release-Handoff($Release) {
  $Release | ConvertTo-Json -Compress | Set-Content -LiteralPath $script:releaseFile -Encoding UTF8
}

try {
  Assert-NodeVersion
  Invoke-WithSpinner "Fetching release manifest" {
    $rawBase = ($using:repoUrl -replace "^https://github.com/", "https://raw.githubusercontent.com/") -replace "\.git$", ""
    $primaryUrl = "$rawBase/$using:bootstrapBranch/release-manifest.json"
    $fallbackUrl = "$rawBase/main/release-manifest.json"
    try {
      Invoke-WebRequest -UseBasicParsing -Uri $primaryUrl -OutFile $using:manifestPath
    } catch {
      Invoke-WebRequest -UseBasicParsing -Uri $fallbackUrl -OutFile $using:manifestPath
    }
  }
  $release = Resolve-Release
  Write-Release-Handoff $release

  if ($release.Channel -eq "stable") {
    Say $launchLabel
    $installArgs = @("exec", "--yes", "--package", "$($release.PackageName)@$($release.Version)", "--", "rin-install")
    $installArgs += @("--release-file", $releaseFile)
    if ($mode -eq "update") { $installArgs += "--update" }
    npm @installArgs
    exit $LASTEXITCODE
  }

  $releaseArchiveUrl = $release.ArchiveUrl
  Invoke-WithSpinner $fetchLabel {
    Invoke-WebRequest -UseBasicParsing -Uri $using:releaseArchiveUrl -OutFile $using:archive
  }
  New-Item -ItemType Directory -Force -Path $srcDir | Out-Null
  Invoke-WithSpinner $prepLabel {
    tar -xzf $using:archive -C $using:srcDir --strip-components=1
    if ($LASTEXITCODE -ne 0) { throw "tar failed with exit code $LASTEXITCODE" }
  }
  Push-Location $srcDir
  try {
    if (Test-Path -LiteralPath "package-lock.json") {
      Invoke-WithSpinner "Installing dependencies" {
        Set-Location $using:srcDir
        npm ci --no-fund --no-audit
        if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE" }
      }
    } else {
      Invoke-WithSpinner "Installing dependencies" {
        Set-Location $using:srcDir
        npm install --no-fund --no-audit
        if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }
      }
    }
    Invoke-WithSpinner $buildLabel {
      Set-Location $using:srcDir
      npm run build
      if ($LASTEXITCODE -ne 0) { throw "npm run build failed with exit code $LASTEXITCODE" }
    }
    Say $launchLabel
    $installerArgs = @("dist/app/rin-install/main.js", "--release-file", $releaseFile)
    if ($mode -eq "update") { $installerArgs += "--update" }
    node @installerArgs
    exit $LASTEXITCODE
  } finally {
    Pop-Location
  }
} finally {
  Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue
}
