$ErrorActionPreference = 'Stop'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Rin needs Node.js 24 or newer with npm. Install the official Node.js 24+ package, then run this installer again.' }
$major = [int]((node -p "process.versions.node").Split('.')[0])
if ($major -lt 24) { throw 'Rin needs Node.js 24 or newer with npm. Upgrade Node.js, then run this installer again.' }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'Rin needs Git. Install Git, then run this installer again.' }
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
node (Join-Path $root 'src/install/bootstrap.mjs')
