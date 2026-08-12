param(
  [Alias("Mode")]
  [string]$RequestedMode = "",
  [Parameter(ValueFromRemainingArguments = $true)]
  [object[]]$RemainingArgs = @()
)

$ErrorActionPreference = "Stop"

$mode = "install"
$channel = "stable"
$branch = ""
$version = ""
$gitSelector = ""
$explicitChannel = ""
$expectGitSelector = $false
$quickRun = $false

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
Usage: install.ps1 [--quick-run] [--stable] [--beta] [--nightly] [--git [main|deadbeef]] [legacy flags]

Install defaults to the stable release channel.
--quick-run fetches the selected channel, prepares the current user's config, and launches the TUI without installing an app release or daemon.
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
      if ($script:mode -ne "install") { throw "invalid mode: $script:mode" }
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
    if (Is-Flag $arg "quick-run") {
      $script:quickRun = $true
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
    if ($arg -ieq "install") {
      $script:mode = $arg.ToLowerInvariant()
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

$parseArgs = @($RemainingArgs | ForEach-Object { [string]$_ })
if ($RequestedMode) {
  if ($RequestedMode -ieq "-mode" -or $RequestedMode -ieq "--mode") {
    $parseArgs = @([string]$RequestedMode) + $parseArgs
  } else {
    $mode = $RequestedMode.ToLowerInvariant()
  }
}
Parse-Args $parseArgs
if ($mode -ne "install") { throw "invalid mode: $mode" }

$workPrefix = "rin-install"
$fetchLabel = "Fetching installer source"
$prepLabel = "Preparing installer source"
$buildLabel = "Building installer"
$launchLabel = "Launching installer..."
$logName = "install.log"
$nodeError = "rin installer requires Node.js >= 22.19.0"
if ($quickRun) { $launchLabel = "Launching Rin quick run..." }
$minimumNodeVersion = [version]"22.19.0"
$managedNpmVersion = "10.9.3"
$managedNpmSha512 = "e84875bb943e908557780f1eee5d9cfc7a67145730ae4b77ef10ccba30f96ded6096859af69ea3dc5b2fde60725d79aa247cbed9c12544c30bf28a4d4fbc4825"

$repoUrl = if ($env:RIN_INSTALL_REPO_URL) { $env:RIN_INSTALL_REPO_URL } else { "https://github.com/rinchan-hoshino/rin" }
$bootstrapBranch = if ($env:RIN_BOOTSTRAP_BRANCH) { $env:RIN_BOOTSTRAP_BRANCH } else { "bootstrap" }
$cacheBase = if ($env:XDG_CACHE_HOME) { $env:XDG_CACHE_HOME } elseif ($env:TEMP) { $env:TEMP } else { [System.IO.Path]::GetTempPath() }
$tempBase = if ($env:TEMP) { $env:TEMP } else { Join-Path $cacheBase "rin-install" }
New-Item -ItemType Directory -Force -Path $tempBase | Out-Null
$workDir = Join-Path $tempBase ("{0}.{1}" -f $workPrefix, [System.Guid]::NewGuid().ToString("N"))
$archive = Join-Path $workDir "rin.tar.gz"
$srcDir = Join-Path $workDir "src"
$manifestPath = Join-Path $workDir "release-manifest.json"
$releaseFile = Join-Path $workDir "release.json"
$logFile = Join-Path $workDir $logName
$bootstrapFailed = $false
New-Item -ItemType Directory -Force -Path $workDir | Out-Null
New-Item -ItemType File -Force -Path $logFile | Out-Null

function Say([string]$Message) {
  Write-Host $Message
}

function Add-BootstrapLog($Items) {
  foreach ($item in @($Items)) {
    if ($null -eq $item) { continue }
    $text = ($item | Out-String -Width 240).TrimEnd()
    if ($text) { Add-Content -LiteralPath $script:logFile -Encoding UTF8 -Value $text }
  }
}

function Show-RecentBootstrapLog {
  if ((Test-Path -LiteralPath $script:logFile) -and ((Get-Item -LiteralPath $script:logFile).Length -gt 0)) {
    Say "Command failed; recent log:"
    Get-Content -LiteralPath $script:logFile -Tail 80 | ForEach-Object { Write-Host $_ }
  } else {
    Say "Command failed; no step output captured."
  }
  Say "Full bootstrap log: $script:logFile"
}

function Assert-NodeVersion {
  try {
    $nodeVersionOutput = & node -p "process.versions.node" 2>$null
    $nodeExitCode = $LASTEXITCODE
    $rawVersion = @($nodeVersionOutput | Select-Object -First 1)[0]
  } catch {
    throw $script:nodeError
  }
  if ($nodeExitCode -ne 0 -or -not $rawVersion) { throw $script:nodeError }
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
  $reportedFailure = $false
  try {
    while ($job.State -eq "Running") {
      if (-not [Console]::IsOutputRedirected) {
        Write-Host -NoNewline ("`r{0} {1}" -f $frames[$index], $Label)
      }
      $index = ($index + 1) % $frames.Count
      Start-Sleep -Milliseconds 100
    }
    $jobOutput = @()
    try {
      $jobOutput = @(Receive-Job -Job $job -Wait *>&1)
    } catch {
      $jobOutput = @($_)
    }
    Add-BootstrapLog $jobOutput
    if ($job.State -eq "Failed") {
      if (-not [Console]::IsOutputRedirected) {
        Write-Host ("`rERR {0}        " -f $Label)
      }
      $reportedFailure = $true
      Show-RecentBootstrapLog
      $reason = @(
        $job.ChildJobs |
          ForEach-Object { $_.JobStateInfo.Reason } |
          Where-Object { $_ }
      )[0]
      if ($reason) { throw ([string]$reason) }
      throw "background job failed"
    }
    if (-not [Console]::IsOutputRedirected) {
      Write-Host ("`rOK {0}        " -f $Label)
    }
  } catch {
    if ((-not $reportedFailure) -and (-not [Console]::IsOutputRedirected)) {
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

function Get-GitHubCodeloadRepoPath([string]$RepoUrl) {
  $normalized = ([string]$RepoUrl).Trim() -replace "\.git$", "" -replace "/+$", ""
  if ($normalized -match "^git@github\.com:([^/]+)/([^/]+)$") {
    return "$([System.Uri]::EscapeDataString($Matches[1]))/$([System.Uri]::EscapeDataString($Matches[2]))"
  }
  if ($normalized -match "^https?://github\.com/([^/]+)/([^/]+)$") {
    return "$([System.Uri]::EscapeDataString($Matches[1]))/$([System.Uri]::EscapeDataString($Matches[2]))"
  }
  return ""
}

function Get-Property($Object, [string]$Name) {
  if ($null -eq $Object) { return $null }
  return $Object.PSObject.Properties[$Name].Value
}

function Is-Git-Hash([string]$Value) {
  return ([string]$Value).Trim() -match "^[0-9a-fA-F]{7,40}$"
}

function Get-GitHubRepoParts([string]$RepoUrl) {
  $normalized = ([string]$RepoUrl).Trim() -replace "\.git$", "" -replace "/+$", ""
  if ($normalized -match "^git@github\.com:([^/]+)/([^/]+)$") {
    return @($Matches[1], $Matches[2])
  }
  if ($normalized -match "^https?://github\.com/([^/]+)/([^/]+)$") {
    return @($Matches[1], $Matches[2])
  }
  return @()
}

function Resolve-Git-Commit([string]$RepoUrl, [string]$Selector, [string]$BranchSelector) {
  $normalizedSelector = if ($Selector) { $Selector.Trim() } elseif ($BranchSelector) { $BranchSelector.Trim() } else { "HEAD" }
  if ($normalizedSelector -match "^[0-9a-fA-F]{40}$") { return $normalizedSelector }
  $selectors = if ($BranchSelector) { @("refs/heads/$BranchSelector", $BranchSelector) } else { @($normalizedSelector) }
  foreach ($item in $selectors) {
    try {
      $raw = & git ls-remote $RepoUrl $item 2>$null
      $hash = ([string](@($raw | Select-Object -First 1)[0]) -split "\s+")[0]
      if ($hash -match "^[0-9a-fA-F]{40}$") { return $hash }
    } catch {}
  }
  $parts = Get-GitHubRepoParts $RepoUrl
  if ($parts.Count -ge 2) {
    try {
      $owner = [System.Uri]::EscapeDataString($parts[0])
      $repo = [System.Uri]::EscapeDataString($parts[1])
      $selector = [System.Uri]::EscapeDataString($normalizedSelector)
      $response = Invoke-RestMethod -UseBasicParsing -Uri "https://api.github.com/repos/$owner/$repo/commits/$selector"
      $sha = [string]$response.sha
      if ($sha -match "^[0-9a-fA-F]{40}$") { return $sha }
    } catch {}
  }
  if (Is-Git-Hash $normalizedSelector) { return $normalizedSelector }
  throw "rin_git_ref_not_resolved:$normalizedSelector"
}

function Resolve-Release {
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  $packageName = if ($manifest.packageName) { [string]$manifest.packageName } else { "@hoshinorin/rin" }
  $releaseRepoUrl = if ($manifest.repoUrl) { [string]$manifest.repoUrl } else { $repoUrl }
  $releaseRepoUrl = $releaseRepoUrl -replace "\.git$", "" -replace "/+$", ""
  $fileBase = ($packageName -split "/")[-1]
  $githubCodeloadRepo = Get-GitHubCodeloadRepoPath $releaseRepoUrl
  $buildNpmTarballUrl = { param($releaseVersion) "https://registry.npmjs.org/$([System.Uri]::EscapeDataString($packageName))/-/$fileBase-$releaseVersion.tgz" }
  $buildRefArchiveUrl = { param($ref) if ($githubCodeloadRepo) { "https://codeload.github.com/$githubCodeloadRepo/tar.gz/$(Url-Encode-Path $ref)" } else { "$releaseRepoUrl/archive/$(Url-Encode-Path $ref).tar.gz" } }
  $buildBranchArchiveUrl = { param($name) & $buildRefArchiveUrl "refs/heads/$name" }

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
  $selector = if ($version) { $version } else { $resolvedBranch }
  $resolvedRef = Resolve-Git-Commit $releaseRepoUrl $selector $(if ($version) { "" } else { $resolvedBranch })
  $shortRef = $resolvedRef.Substring(0, [Math]::Min(12, $resolvedRef.Length))
  return [pscustomobject]@{
    PackageName = $packageName
    Channel = "git"
    ArchiveUrl = & $buildRefArchiveUrl $resolvedRef
    Version = $shortRef
    Branch = $resolvedBranch
    Ref = $resolvedRef
    SourceLabel = "git $resolvedBranch @ $shortRef"
  }
}

function Write-Release-Handoff($Release) {
  [pscustomobject]@{
    channel = [string]$Release.Channel
    archiveUrl = [string]$Release.ArchiveUrl
    version = [string]$Release.Version
    branch = [string]$Release.Branch
    ref = [string]$Release.Ref
    sourceLabel = [string]$Release.SourceLabel
  } | ConvertTo-Json -Compress | Set-Content -LiteralPath $script:releaseFile -Encoding UTF8
}

function Provision-SourceManagedNode {
  $sourceNode = (Get-Command node -ErrorAction Stop).Source
  $sourceNodeRoot = Split-Path -Parent $sourceNode
  $sourceNpmRoot = Join-Path $sourceNodeRoot "node_modules/npm"

  $managedRoot = Join-Path $script:srcDir "runtime/node/current"
  $managedNode = Join-Path $managedRoot "node.exe"
  $managedNpmRoot = Join-Path $managedRoot "node_modules/npm"
  $managedNpmCli = Join-Path $managedNpmRoot "bin/npm-cli.js"
  $managedNodeExists = Test-Path -LiteralPath $managedNode -PathType Leaf
  $copiedSourceNode = $false
  if (-not $managedNodeExists) {
    Remove-Item -LiteralPath $managedRoot -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path $managedRoot | Out-Null
    Copy-Item -LiteralPath $sourceNode -Destination $managedNode -Force
    $copiedSourceNode = $true
  }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $managedNpmRoot) | Out-Null
  if ($copiedSourceNode -and (Test-Path -LiteralPath (Join-Path $sourceNpmRoot "bin/npm-cli.js"))) {
    Copy-Item -LiteralPath $sourceNpmRoot -Destination $managedNpmRoot -Recurse -Force
  }

  $previousPath = $env:PATH
  $previousNodePath = $env:NODE_PATH
  $managedNpmValid = $false
  try {
    $env:PATH = $managedRoot
    $env:NODE_PATH = ""
    if (Test-Path -LiteralPath $managedNpmCli) {
      & $managedNode $managedNpmCli --version *> $null
      $managedNpmValid = $LASTEXITCODE -eq 0
    }
  } finally {
    $env:PATH = $previousPath
    $env:NODE_PATH = $previousNodePath
  }

  if (-not $managedNpmValid) {
    Remove-Item -LiteralPath $managedNpmRoot -Recurse -Force -ErrorAction SilentlyContinue
    $npmCacheDir = Join-Path $script:cacheBase "rin/node-toolchain"
    $npmArchive = Join-Path $npmCacheDir "npm-$script:managedNpmVersion.tgz"
    New-Item -ItemType Directory -Force -Path $npmCacheDir | Out-Null
    $archiveValid = $false
    if (Test-Path -LiteralPath $npmArchive) {
      $archiveHash = (Get-FileHash -LiteralPath $npmArchive -Algorithm SHA512).Hash.ToLowerInvariant()
      $archiveValid = $archiveHash -eq $script:managedNpmSha512
      if (-not $archiveValid) {
        Remove-Item -LiteralPath $npmArchive -Force -ErrorAction SilentlyContinue
      }
    }
    if (-not $archiveValid) {
      $temporaryArchive = "$npmArchive.$PID.tmp"
      try {
        Invoke-WebRequest -UseBasicParsing -Uri "https://registry.npmjs.org/npm/-/npm-$script:managedNpmVersion.tgz" -OutFile $temporaryArchive
        $archiveHash = (Get-FileHash -LiteralPath $temporaryArchive -Algorithm SHA512).Hash.ToLowerInvariant()
        if ($archiveHash -ne $script:managedNpmSha512) {
          throw "rin managed npm checksum mismatch"
        }
        Move-Item -LiteralPath $temporaryArchive -Destination $npmArchive -Force
      } finally {
        Remove-Item -LiteralPath $temporaryArchive -Force -ErrorAction SilentlyContinue
      }
    }
    $npmExtract = Join-Path $script:workDir "managed-npm"
    Remove-Item -LiteralPath $npmExtract -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path $npmExtract | Out-Null
    tar -xzf $npmArchive -C $npmExtract
    if ($LASTEXITCODE -ne 0) { throw "managed npm extraction failed with exit code $LASTEXITCODE" }
    Copy-Item -LiteralPath (Join-Path $npmExtract "package") -Destination $managedNpmRoot -Recurse -Force
  }

  @"
@ECHO off
"%~dp0\node.exe" "%~dp0\node_modules\npm\bin\npm-cli.js" %*
"@ | Set-Content -LiteralPath (Join-Path $managedRoot "npm.cmd") -Encoding ASCII
  @"
@ECHO off
"%~dp0\node.exe" "%~dp0\node_modules\npm\bin\npx-cli.js" %*
"@ | Set-Content -LiteralPath (Join-Path $managedRoot "npx.cmd") -Encoding ASCII

  $previousPath = $env:PATH
  $previousNodePath = $env:NODE_PATH
  try {
    $env:PATH = $managedRoot
    $env:NODE_PATH = ""
    & $managedNode $managedNpmCli --version *> $null
    if ($LASTEXITCODE -ne 0) { throw "rin managed node runtime is missing a self-contained npm" }
  } finally {
    $env:PATH = $previousPath
    $env:NODE_PATH = $previousNodePath
  }
  return [pscustomobject]@{
    Root = $managedRoot
    Node = $managedNode
    NpmCli = $managedNpmCli
  }
}

try {
  Assert-NodeVersion
  Invoke-WithSpinner "Fetching release manifest" {
    $rawBase = ($using:repoUrl -replace "^https://github.com/", "https://raw.githubusercontent.com/") -replace "\.git$", ""
    $manifestUrl = "$rawBase/$using:bootstrapBranch/release-manifest.json"
    Invoke-WebRequest -UseBasicParsing -Uri $manifestUrl -OutFile $using:manifestPath
  }
  $release = Resolve-Release
  Write-Release-Handoff $release

  $releaseArchiveUrl = $release.ArchiveUrl
  Invoke-WithSpinner $fetchLabel {
    Invoke-WebRequest -UseBasicParsing -Uri $using:releaseArchiveUrl -OutFile $using:archive
  }
  New-Item -ItemType Directory -Force -Path $srcDir | Out-Null
  Invoke-WithSpinner $prepLabel {
    tar -xzf $using:archive -C $using:srcDir --strip-components=1
    if ($LASTEXITCODE -ne 0) { throw "tar failed with exit code $LASTEXITCODE" }
  }
  $managedToolchain = Provision-SourceManagedNode
  $managedNode = $managedToolchain.Node
  $managedNpmCli = $managedToolchain.NpmCli
  $env:PATH = "$($managedToolchain.Root);$env:PATH"
  $env:NODE_PATH = ""
  Push-Location $srcDir
  try {
    if ($release.Channel -eq "stable") {
      Invoke-WithSpinner "Installing dependencies" {
        Set-Location $using:srcDir
        $packagePath = Join-Path $using:srcDir "package.json"
        $packageJson = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
        if ($packageJson.scripts -and ($packageJson.scripts.PSObject.Properties.Name -contains "prepare")) {
          $packageJson.scripts.PSObject.Properties.Remove("prepare")
          if ($packageJson.scripts.PSObject.Properties.Name -contains "prepare") {
            throw "rin stable bootstrap could not remove the package prepare script"
          }
          $packageJson | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $packagePath -Encoding UTF8
        }
        & $using:managedNode $using:managedNpmCli install --omit=dev --no-fund --no-audit
        if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }
      }
    } elseif (Test-Path -LiteralPath "package-lock.json") {
      Invoke-WithSpinner "Installing dependencies" {
        Set-Location $using:srcDir
        & $using:managedNode $using:managedNpmCli ci --no-fund --no-audit
        if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE" }
      }
    } else {
      Invoke-WithSpinner "Installing dependencies" {
        Set-Location $using:srcDir
        & $using:managedNode $using:managedNpmCli install --no-fund --no-audit
        if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }
      }
    }
    if ($release.Channel -ne "stable") {
      Invoke-WithSpinner $buildLabel {
        Set-Location $using:srcDir
        & $using:managedNode $using:managedNpmCli run build
        if ($LASTEXITCODE -ne 0) { throw "npm run build failed with exit code $LASTEXITCODE" }
      }
      Invoke-WithSpinner "Pruning dependencies" {
        Set-Location $using:srcDir
        & $using:managedNode $using:managedNpmCli prune --omit=dev --no-fund --no-audit
        if ($LASTEXITCODE -ne 0) { throw "npm prune failed with exit code $LASTEXITCODE" }
      }
    }
    Invoke-WithSpinner "Verifying native dependencies" {
      Set-Location $using:srcDir
      & $using:managedNode -e "const Database=require('better-sqlite3');const db=new Database(':memory:');db.prepare('select 1').get();db.close();"
      if ($LASTEXITCODE -ne 0) { throw "native dependency verification failed with exit code $LASTEXITCODE" }
    }
    Say $launchLabel
    $installerArgs = @("dist/app/rin-install/main.js", "--release-file", $releaseFile)
    if ($quickRun) { $installerArgs += "--quick-run" }
    & $managedNode @installerArgs
    exit $LASTEXITCODE
  } finally {
    Pop-Location
  }
} catch {
  $script:bootstrapFailed = $true
  $message = ($_.Exception.Message | Out-String -Width 240).Trim()
  if ($message) {
    Say "ERROR: $message"
  } else {
    Say "ERROR: Rin bootstrap failed"
  }
  exit 1
} finally {
  if ($script:bootstrapFailed) {
    Say "Rin bootstrap debug directory preserved: $workDir"
  } else {
    Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}
