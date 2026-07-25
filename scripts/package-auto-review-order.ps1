[CmdletBinding()]
param(
  [Parameter()]
  [string]$RepositoryRoot = "",

  [Parameter()]
  [string]$OutputDirectory = ""
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($RepositoryRoot)) {
  $RepositoryRoot = Split-Path -Parent $PSScriptRoot
}

function Assert-File([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Required file not found: $Path"
  }
}

function Copy-SourceTree([string]$Source, [string]$Destination) {
  if (Test-Path -LiteralPath $Destination) {
    throw "Destination already exists; choose an empty output directory: $Destination"
  }
  New-Item -ItemType Directory -Path $Destination | Out-Null
  Get-ChildItem -LiteralPath $Source -Force | ForEach-Object {
    if ($_.PSIsContainer) {
      if ($_.Name -notin @("node_modules", "test", "tests", "__tests__")) {
        Copy-SourceTree $_.FullName (Join-Path $Destination $_.Name)
      }
    } elseif (-not $_.Name.EndsWith(".tmp") -and $_.Name -notmatch '\.(test|spec)\.js$') {
      Copy-Item -LiteralPath $_.FullName -Destination $Destination
    }
  }
}

function Assert-NoForbiddenPackageFiles([string]$PackageRoot) {
  $forbidden = @()
  $prefix = $PackageRoot.TrimEnd("\", "/") + [System.IO.Path]::DirectorySeparatorChar
  Get-ChildItem -LiteralPath $PackageRoot -File -Recurse -Force | ForEach-Object {
    $relative = $_.FullName.Substring($prefix.Length).Replace("\", "/")
    $name = $_.Name
    $forbiddenByName = (
      $name -match '(?i)^\.env(?:\.|$)' -or
      $name -match '(?i)credentials?' -or
      $name -match '(?i)(?:customer.*export|export.*customer)' -or
      $name -match '(?i)\.(?:pem|key|p12|pfx)$' -or
      $name -match '(?i)^(?:id_rsa|id_ed25519)$' -or
      $relative -match '(?i)(^|/)\.superpowers(/|$)' -or
      $name -match '(?i)^review[-_.].*\.(?:diff|patch|txt|md)$'
    )
    $containsPrivateKey = $false
    if (-not $forbiddenByName -and $_.Length -le 5MB) {
      try {
        $containsPrivateKey = (Get-Content -Raw -Encoding UTF8 -LiteralPath $_.FullName) -match 'BEGIN .*PRIVATE KEY'
      } catch {
        $containsPrivateKey = $false
      }
    }
    if ($forbiddenByName -or $containsPrivateKey) {
      $forbidden += $relative
    }
  }
  if ($forbidden.Count -gt 0) {
    throw "Forbidden files found in deployment candidate: $($forbidden -join ', ')"
  }
}

$root = [System.IO.Path]::GetFullPath($RepositoryRoot)
$source = Join-Path $root "cloudfunctions\autoReviewOrder"
$canonicalInventoryMutationService = Join-Path $root "cloudfunctions\common\services\inventoryMutationService.js"
$canonicalOrderApprovalService = Join-Path $root "cloudfunctions\common\services\orderApprovalService.js"
$canonicalOrderStatusPolicy = Join-Path $root "cloudfunctions\common\orderStatusPolicy.js"
$canonicalSyncEvents = Join-Path $root "cloudfunctions\common\syncEvents.js"
$canonicalStockAlert = Join-Path $root "cloudfunctions\_utils\stockAlert.js"

Assert-File (Join-Path $source "index.js")
Assert-File (Join-Path $source "handler.js")
Assert-File (Join-Path $source "package.json")
Assert-File $canonicalInventoryMutationService
Assert-File $canonicalOrderApprovalService
Assert-File $canonicalOrderStatusPolicy
Assert-File $canonicalSyncEvents
Assert-File $canonicalStockAlert

if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
  $candidateRoot = Join-Path $root ".codex-cloudfunction-deploy"
  New-Item -ItemType Directory -Force -Path $candidateRoot | Out-Null
  $candidateName = "auto-review-order-guarded-$((Get-Date).ToString('yyyyMMdd-HHmmss'))"
  $OutputDirectory = Join-Path $candidateRoot $candidateName
  $suffix = 1
  while (Test-Path -LiteralPath $OutputDirectory) {
    $OutputDirectory = Join-Path $candidateRoot "$candidateName-$suffix"
    $suffix += 1
  }
}

$output = [System.IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $output) {
  if ((Get-ChildItem -LiteralPath $output -Force | Measure-Object).Count -gt 0) {
    throw "Output directory must be empty: $output"
  }
} else {
  New-Item -ItemType Directory -Path $output | Out-Null
}

$target = Join-Path $output "autoReviewOrder"
Copy-SourceTree $source $target
Copy-Item -LiteralPath $canonicalInventoryMutationService -Destination (Join-Path $target "inventoryMutationService.js") -Force
Copy-Item -LiteralPath $canonicalOrderApprovalService -Destination (Join-Path $target "orderApprovalService.js") -Force
Copy-Item -LiteralPath $canonicalOrderStatusPolicy -Destination (Join-Path $target "orderStatusPolicy.js") -Force
Copy-Item -LiteralPath $canonicalSyncEvents -Destination (Join-Path $target "syncEvents.js") -Force
Copy-Item -LiteralPath $canonicalStockAlert -Destination (Join-Path $target "stockAlert.js") -Force

$inventorySourceHash = (Get-FileHash -LiteralPath $canonicalInventoryMutationService -Algorithm SHA256).Hash
$inventoryTargetHash = (Get-FileHash -LiteralPath (Join-Path $target "inventoryMutationService.js") -Algorithm SHA256).Hash
$approvalSourceHash = (Get-FileHash -LiteralPath $canonicalOrderApprovalService -Algorithm SHA256).Hash
$approvalTargetHash = (Get-FileHash -LiteralPath (Join-Path $target "orderApprovalService.js") -Algorithm SHA256).Hash
$orderStatusPolicySourceHash = (Get-FileHash -LiteralPath $canonicalOrderStatusPolicy -Algorithm SHA256).Hash
$orderStatusPolicyTargetHash = (Get-FileHash -LiteralPath (Join-Path $target "orderStatusPolicy.js") -Algorithm SHA256).Hash
$syncEventsSourceHash = (Get-FileHash -LiteralPath $canonicalSyncEvents -Algorithm SHA256).Hash
$syncEventsTargetHash = (Get-FileHash -LiteralPath (Join-Path $target "syncEvents.js") -Algorithm SHA256).Hash
$stockAlertSourceHash = (Get-FileHash -LiteralPath $canonicalStockAlert -Algorithm SHA256).Hash
$stockAlertTargetHash = (Get-FileHash -LiteralPath (Join-Path $target "stockAlert.js") -Algorithm SHA256).Hash

if ($inventorySourceHash -ne $inventoryTargetHash -or
    $approvalSourceHash -ne $approvalTargetHash -or
    $orderStatusPolicySourceHash -ne $orderStatusPolicyTargetHash -or
    $syncEventsSourceHash -ne $syncEventsTargetHash -or
    $stockAlertSourceHash -ne $stockAlertTargetHash) {
  throw "Canonical auto-review dependency hash verification failed"
}

Assert-NoForbiddenPackageFiles $output

$manifest = [ordered]@{
  createdAt = (Get-Date).ToUniversalTime().ToString("o")
  sourceRoot = $root
  functions = @("autoReviewOrder")
  canonicalInventoryMutationServiceSha256 = $inventorySourceHash
  canonicalOrderApprovalServiceSha256 = $approvalSourceHash
  canonicalOrderStatusPolicySha256 = $orderStatusPolicySourceHash
  canonicalSyncEventsSha256 = $syncEventsSourceHash
  canonicalStockAlertSha256 = $stockAlertSourceHash
  forbiddenFileCount = 0
  uploadPerformed = $false
}
$manifestPath = Join-Path $output "package-manifest.json"
$manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $manifestPath -Encoding UTF8

[PSCustomObject]@{
  OutputDirectory = $output
  Manifest = $manifestPath
  InventoryMutationServiceHashVerified = $true
  OrderApprovalServiceHashVerified = $true
  OrderStatusPolicyHashVerified = $true
  SyncEventsHashVerified = $true
  StockAlertHashVerified = $true
  ForbiddenFileCount = 0
  UploadPerformed = $false
}
