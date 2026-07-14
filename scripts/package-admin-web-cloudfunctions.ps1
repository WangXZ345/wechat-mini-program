[CmdletBinding()]
param(
  [Parameter()]
  [string]$RepositoryRoot = (Split-Path -Parent $PSScriptRoot),

  [Parameter(Mandatory = $true)]
  [string]$OutputDirectory
)

$ErrorActionPreference = "Stop"

function Assert-File([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Required file not found: $Path"
  }
}

function Assert-TimeoutConfig([string]$Path, [int]$ExpectedTimeout) {
  Assert-File $Path
  try {
    $config = Get-Content -Raw -Encoding UTF8 -LiteralPath $Path | ConvertFrom-Json
  } catch {
    throw "Invalid cloud function config: $Path"
  }
  if (-not ($config.PSObject.Properties.Name -contains "timeout") -or [int]$config.timeout -ne $ExpectedTimeout) {
    throw "Cloud function timeout must be $ExpectedTimeout seconds: $Path"
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

$root = [System.IO.Path]::GetFullPath($RepositoryRoot)
$output = [System.IO.Path]::GetFullPath($OutputDirectory)
$dashboardSource = Join-Path $root "cloudfunctions\adminDashboard"
$apiSource = Join-Path $root "cloudfunctions\adminWebApi"
$authSource = Join-Path $root "cloudfunctions\adminWebAuth"
$batchTagsSource = Join-Path $root "cloudfunctions\batchUpdateProductTags"
$cancelSource = Join-Path $root "cloudfunctions\cancelOrder"
$cleanupSource = Join-Path $root "cloudfunctions\cleanupSyncEvents"
$ordersSource = Join-Path $root "cloudfunctions\getOrders"
$syncReaderSource = Join-Path $root "cloudfunctions\getSyncEvents"
$unsoldSource = Join-Path $root "cloudfunctions\getUnsoldProducts"
$manageProductSource = Join-Path $root "cloudfunctions\manageProduct"
$priceSource = Join-Path $root "cloudfunctions\updateProductPrice"
$warningSource = Join-Path $root "cloudfunctions\updateProductWarningStock"
$reviewSource = Join-Path $root "cloudfunctions\adminReviewOrder"
$shipmentGroupsSource = Join-Path $root "cloudfunctions\shipmentGroups"
$adminListAccountsSource = Join-Path $root "cloudfunctions\adminListCustomerAccounts"
$adminAccountDetailSource = Join-Path $root "cloudfunctions\adminGetCustomerAccountDetail"
$dashboardConfig = Join-Path $dashboardSource "config.json"
$apiConfig = Join-Path $apiSource "config.json"
$canonicalSecurity = Join-Path $authSource "security.js"
$canonicalPermissions = Join-Path $root "cloudfunctions\common\permissions.js"
$canonicalInventoryWarningService = Join-Path $root "cloudfunctions\common\services\inventoryWarningService.js"
$canonicalProductPriceService = Join-Path $root "cloudfunctions\common\services\productPriceService.js"
$canonicalProductStatusService = Join-Path $root "cloudfunctions\common\services\productStatusService.js"
$canonicalProductTagService = Join-Path $root "cloudfunctions\common\services\productTagService.js"
$canonicalProductWriteService = Join-Path $root "cloudfunctions\common\services\productWriteService.js"
$canonicalInventoryMutationService = Join-Path $root "cloudfunctions\common\services\inventoryMutationService.js"
$canonicalProductAnalyticsQueryService = Join-Path $root "cloudfunctions\common\services\productAnalyticsQueryService.js"
$canonicalOrderQueryService = Join-Path $root "cloudfunctions\common\services\orderQueryService.js"
$canonicalOrderReviewService = Join-Path $root "cloudfunctions\common\services\orderReviewService.js"
$canonicalShipmentQueryService = Join-Path $root "cloudfunctions\common\services\shipmentQueryService.js"
$canonicalAccountQueryService = Join-Path $root "cloudfunctions\common\services\accountQueryService.js"
$canonicalPaymentQueryService = Join-Path $root "cloudfunctions\common\services\paymentQueryService.js"
$canonicalIdempotency = Join-Path $root "cloudfunctions\common\idempotency.js"
$canonicalRecommend = Join-Path $root "cloudfunctions\common\recommend.js"
$canonicalStockAlert = Join-Path $root "cloudfunctions\_utils\stockAlert.js"
$canonicalSyncEvents = Join-Path $root "cloudfunctions\common\syncEvents.js"

Assert-File (Join-Path $dashboardSource "index.js")
Assert-File (Join-Path $apiSource "index.js")
Assert-File (Join-Path $authSource "index.js")
Assert-File (Join-Path $batchTagsSource "index.js")
Assert-File (Join-Path $cancelSource "index.js")
Assert-File (Join-Path $cleanupSource "index.js")
Assert-File (Join-Path $ordersSource "index.js")
Assert-File (Join-Path $syncReaderSource "index.js")
Assert-File (Join-Path $unsoldSource "index.js")
Assert-File (Join-Path $manageProductSource "index.js")
Assert-File (Join-Path $priceSource "index.js")
Assert-File (Join-Path $warningSource "index.js")
Assert-File (Join-Path $reviewSource "index.js")
Assert-File (Join-Path $shipmentGroupsSource "index.js")
Assert-File (Join-Path $adminListAccountsSource "index.js")
Assert-File (Join-Path $adminAccountDetailSource "index.js")
Assert-TimeoutConfig $dashboardConfig 60
Assert-TimeoutConfig $apiConfig 60
Assert-TimeoutConfig (Join-Path $cancelSource "config.json") 20
Assert-File $canonicalSecurity
Assert-File $canonicalPermissions
Assert-File $canonicalInventoryWarningService
Assert-File $canonicalProductPriceService
Assert-File $canonicalProductStatusService
Assert-File $canonicalProductTagService
Assert-File $canonicalProductWriteService
Assert-File $canonicalInventoryMutationService
Assert-File $canonicalProductAnalyticsQueryService
Assert-File $canonicalOrderQueryService
Assert-File $canonicalOrderReviewService
Assert-File $canonicalShipmentQueryService
Assert-File $canonicalAccountQueryService
Assert-File $canonicalPaymentQueryService
Assert-File $canonicalIdempotency
Assert-File $canonicalRecommend
Assert-File $canonicalStockAlert
Assert-File $canonicalSyncEvents

if (Test-Path -LiteralPath $output) {
  if ((Get-ChildItem -LiteralPath $output -Force | Measure-Object).Count -gt 0) {
    throw "Output directory must be empty: $output"
  }
} else {
  New-Item -ItemType Directory -Path $output | Out-Null
}

$dashboardTarget = Join-Path $output "adminDashboard"
$apiTarget = Join-Path $output "adminWebApi"
$authTarget = Join-Path $output "adminWebAuth"
$batchTagsTarget = Join-Path $output "batchUpdateProductTags"
$cancelTarget = Join-Path $output "cancelOrder"
$cleanupTarget = Join-Path $output "cleanupSyncEvents"
$ordersTarget = Join-Path $output "getOrders"
$syncReaderTarget = Join-Path $output "getSyncEvents"
$unsoldTarget = Join-Path $output "getUnsoldProducts"
$manageProductTarget = Join-Path $output "manageProduct"
$priceTarget = Join-Path $output "updateProductPrice"
$warningTarget = Join-Path $output "updateProductWarningStock"
$reviewTarget = Join-Path $output "adminReviewOrder"
$shipmentGroupsTarget = Join-Path $output "shipmentGroups"
$adminListAccountsTarget = Join-Path $output "adminListCustomerAccounts"
$adminAccountDetailTarget = Join-Path $output "adminGetCustomerAccountDetail"
Copy-SourceTree $dashboardSource $dashboardTarget
Copy-SourceTree $apiSource $apiTarget
Copy-SourceTree $authSource $authTarget
Copy-SourceTree $batchTagsSource $batchTagsTarget
Copy-SourceTree $cancelSource $cancelTarget
Copy-SourceTree $cleanupSource $cleanupTarget
Copy-SourceTree $ordersSource $ordersTarget
Copy-SourceTree $syncReaderSource $syncReaderTarget
Copy-SourceTree $unsoldSource $unsoldTarget
Copy-SourceTree $manageProductSource $manageProductTarget
Copy-SourceTree $priceSource $priceTarget
Copy-SourceTree $warningSource $warningTarget
Copy-SourceTree $reviewSource $reviewTarget
Copy-SourceTree $shipmentGroupsSource $shipmentGroupsTarget
Copy-SourceTree $adminListAccountsSource $adminListAccountsTarget
Copy-SourceTree $adminAccountDetailSource $adminAccountDetailTarget

Copy-Item -LiteralPath $canonicalSecurity -Destination (Join-Path $apiTarget "security.js") -Force
Copy-Item -LiteralPath $canonicalPermissions -Destination (Join-Path $dashboardTarget "permissions.js") -Force
Copy-Item -LiteralPath $canonicalPermissions -Destination (Join-Path $apiTarget "permissions.js") -Force
Copy-Item -LiteralPath $canonicalPermissions -Destination (Join-Path $authTarget "permissions.js") -Force
Copy-Item -LiteralPath $canonicalPermissions -Destination (Join-Path $batchTagsTarget "permissions.js") -Force
Copy-Item -LiteralPath $canonicalPermissions -Destination (Join-Path $cancelTarget "permissions.js") -Force
Copy-Item -LiteralPath $canonicalPermissions -Destination (Join-Path $ordersTarget "permissions.js") -Force
Copy-Item -LiteralPath $canonicalPermissions -Destination (Join-Path $unsoldTarget "permissions.js") -Force
Copy-Item -LiteralPath $canonicalPermissions -Destination (Join-Path $manageProductTarget "permissions.js") -Force
Copy-Item -LiteralPath $canonicalPermissions -Destination (Join-Path $priceTarget "permissions.js") -Force
Copy-Item -LiteralPath $canonicalPermissions -Destination (Join-Path $warningTarget "permissions.js") -Force
Copy-Item -LiteralPath $canonicalPermissions -Destination (Join-Path $reviewTarget "permissions.js") -Force
Copy-Item -LiteralPath $canonicalInventoryWarningService -Destination (Join-Path $apiTarget "lib\inventoryWarningService.js") -Force
Copy-Item -LiteralPath $canonicalProductPriceService -Destination (Join-Path $apiTarget "lib\productPriceService.js") -Force
Copy-Item -LiteralPath $canonicalProductStatusService -Destination (Join-Path $apiTarget "lib\productStatusService.js") -Force
Copy-Item -LiteralPath $canonicalProductTagService -Destination (Join-Path $apiTarget "lib\productTagService.js") -Force
Copy-Item -LiteralPath $canonicalProductTagService -Destination (Join-Path $batchTagsTarget "productTagService.js") -Force
Copy-Item -LiteralPath $canonicalProductWriteService -Destination (Join-Path $apiTarget "lib\productWriteService.js") -Force
Copy-Item -LiteralPath $canonicalProductWriteService -Destination (Join-Path $manageProductTarget "productWriteService.js") -Force
Copy-Item -LiteralPath $canonicalInventoryMutationService -Destination (Join-Path $apiTarget "lib\inventoryMutationService.js") -Force
Copy-Item -LiteralPath $canonicalInventoryMutationService -Destination (Join-Path $cancelTarget "inventoryMutationService.js") -Force
Copy-Item -LiteralPath $canonicalInventoryMutationService -Destination (Join-Path $manageProductTarget "inventoryMutationService.js") -Force
Copy-Item -LiteralPath $canonicalInventoryMutationService -Destination (Join-Path $unsoldTarget "inventoryMutationService.js") -Force
Copy-Item -LiteralPath $canonicalInventoryMutationService -Destination (Join-Path $reviewTarget "inventoryMutationService.js") -Force
Copy-Item -LiteralPath $canonicalProductStatusService -Destination (Join-Path $unsoldTarget "productStatusService.js") -Force
Copy-Item -LiteralPath $canonicalProductStatusService -Destination (Join-Path $manageProductTarget "productStatusService.js") -Force
Copy-Item -LiteralPath $canonicalProductAnalyticsQueryService -Destination (Join-Path $dashboardTarget "productAnalyticsQueryService.js") -Force
Copy-Item -LiteralPath $canonicalProductAnalyticsQueryService -Destination (Join-Path $apiTarget "lib\productAnalyticsQueryService.js") -Force
Copy-Item -LiteralPath $canonicalOrderQueryService -Destination (Join-Path $apiTarget "lib\orderQueryService.js") -Force
Copy-Item -LiteralPath $canonicalOrderQueryService -Destination (Join-Path $ordersTarget "orderQueryService.js") -Force
Copy-Item -LiteralPath $canonicalOrderReviewService -Destination (Join-Path $apiTarget "lib\orderReviewService.js") -Force
Copy-Item -LiteralPath $canonicalOrderReviewService -Destination (Join-Path $reviewTarget "orderReviewService.js") -Force
Copy-Item -LiteralPath $canonicalShipmentQueryService -Destination (Join-Path $apiTarget "lib\shipmentQueryService.js") -Force
Copy-Item -LiteralPath $canonicalShipmentQueryService -Destination (Join-Path $shipmentGroupsTarget "shipmentQueryService.js") -Force
Copy-Item -LiteralPath $canonicalAccountQueryService -Destination (Join-Path $apiTarget "lib\accountQueryService.js") -Force
Copy-Item -LiteralPath $canonicalAccountQueryService -Destination (Join-Path $adminListAccountsTarget "accountQueryService.js") -Force
Copy-Item -LiteralPath $canonicalAccountQueryService -Destination (Join-Path $adminAccountDetailTarget "accountQueryService.js") -Force
Copy-Item -LiteralPath $canonicalPaymentQueryService -Destination (Join-Path $apiTarget "lib\paymentQueryService.js") -Force
Copy-Item -LiteralPath $canonicalIdempotency -Destination (Join-Path $apiTarget "lib\idempotency.js") -Force
Copy-Item -LiteralPath $canonicalIdempotency -Destination (Join-Path $batchTagsTarget "idempotency.js") -Force
Copy-Item -LiteralPath $canonicalIdempotency -Destination (Join-Path $unsoldTarget "idempotency.js") -Force
Copy-Item -LiteralPath $canonicalIdempotency -Destination (Join-Path $manageProductTarget "idempotency.js") -Force
Copy-Item -LiteralPath $canonicalIdempotency -Destination (Join-Path $reviewTarget "common\idempotency.js") -Force
Copy-Item -LiteralPath $canonicalStockAlert -Destination (Join-Path $apiTarget "lib\stockAlert.js") -Force
Copy-Item -LiteralPath $canonicalStockAlert -Destination (Join-Path $manageProductTarget "stockAlert.js") -Force
Copy-Item -LiteralPath $canonicalStockAlert -Destination (Join-Path $cancelTarget "stockAlert.js") -Force
Copy-Item -LiteralPath $canonicalStockAlert -Destination (Join-Path $unsoldTarget "stockAlert.js") -Force
Copy-Item -LiteralPath $canonicalProductPriceService -Destination (Join-Path $priceTarget "productPriceService.js") -Force
Copy-Item -LiteralPath $canonicalIdempotency -Destination (Join-Path $priceTarget "idempotency.js") -Force
Copy-Item -LiteralPath $canonicalInventoryWarningService -Destination (Join-Path $warningTarget "inventoryWarningService.js") -Force
Copy-Item -LiteralPath $canonicalIdempotency -Destination (Join-Path $warningTarget "idempotency.js") -Force
Copy-Item -LiteralPath $canonicalStockAlert -Destination (Join-Path $warningTarget "stockAlert.js") -Force
Copy-Item -LiteralPath $canonicalRecommend -Destination (Join-Path $manageProductTarget "recommend.js") -Force
Copy-Item -LiteralPath $canonicalRecommend -Destination (Join-Path $manageProductTarget "common\recommend.js") -Force
Copy-Item -LiteralPath $canonicalSyncEvents -Destination (Join-Path $apiTarget "lib\syncEvents.js") -Force
Copy-Item -LiteralPath $canonicalSyncEvents -Destination (Join-Path $syncReaderTarget "common\syncEvents.js") -Force
Copy-Item -LiteralPath $canonicalSyncEvents -Destination (Join-Path $reviewTarget "common\syncEvents.js") -Force

$securitySourceHash = (Get-FileHash -LiteralPath $canonicalSecurity -Algorithm SHA256).Hash
$securityApiHash = (Get-FileHash -LiteralPath (Join-Path $apiTarget "security.js") -Algorithm SHA256).Hash
$securityAuthHash = (Get-FileHash -LiteralPath (Join-Path $authTarget "security.js") -Algorithm SHA256).Hash
$permissionsSourceHash = (Get-FileHash -LiteralPath $canonicalPermissions -Algorithm SHA256).Hash
$permissionsDashboardHash = (Get-FileHash -LiteralPath (Join-Path $dashboardTarget "permissions.js") -Algorithm SHA256).Hash
$permissionsApiHash = (Get-FileHash -LiteralPath (Join-Path $apiTarget "permissions.js") -Algorithm SHA256).Hash
$permissionsAuthHash = (Get-FileHash -LiteralPath (Join-Path $authTarget "permissions.js") -Algorithm SHA256).Hash
$permissionsBatchTagsHash = (Get-FileHash -LiteralPath (Join-Path $batchTagsTarget "permissions.js") -Algorithm SHA256).Hash
$permissionsCancelHash = (Get-FileHash -LiteralPath (Join-Path $cancelTarget "permissions.js") -Algorithm SHA256).Hash
$permissionsOrdersHash = (Get-FileHash -LiteralPath (Join-Path $ordersTarget "permissions.js") -Algorithm SHA256).Hash
$permissionsUnsoldHash = (Get-FileHash -LiteralPath (Join-Path $unsoldTarget "permissions.js") -Algorithm SHA256).Hash
$permissionsManageProductHash = (Get-FileHash -LiteralPath (Join-Path $manageProductTarget "permissions.js") -Algorithm SHA256).Hash
$permissionsPriceHash = (Get-FileHash -LiteralPath (Join-Path $priceTarget "permissions.js") -Algorithm SHA256).Hash
$permissionsWarningHash = (Get-FileHash -LiteralPath (Join-Path $warningTarget "permissions.js") -Algorithm SHA256).Hash
$permissionsReviewHash = (Get-FileHash -LiteralPath (Join-Path $reviewTarget "permissions.js") -Algorithm SHA256).Hash
$inventoryWarningSourceHash = (Get-FileHash -LiteralPath $canonicalInventoryWarningService -Algorithm SHA256).Hash
$inventoryWarningApiHash = (Get-FileHash -LiteralPath (Join-Path $apiTarget "lib\inventoryWarningService.js") -Algorithm SHA256).Hash
$inventoryWarningLegacyHash = (Get-FileHash -LiteralPath (Join-Path $warningTarget "inventoryWarningService.js") -Algorithm SHA256).Hash
$productPriceSourceHash = (Get-FileHash -LiteralPath $canonicalProductPriceService -Algorithm SHA256).Hash
$productPriceApiHash = (Get-FileHash -LiteralPath (Join-Path $apiTarget "lib\productPriceService.js") -Algorithm SHA256).Hash
$productPriceLegacyHash = (Get-FileHash -LiteralPath (Join-Path $priceTarget "productPriceService.js") -Algorithm SHA256).Hash
$productStatusSourceHash = (Get-FileHash -LiteralPath $canonicalProductStatusService -Algorithm SHA256).Hash
$productStatusApiHash = (Get-FileHash -LiteralPath (Join-Path $apiTarget "lib\productStatusService.js") -Algorithm SHA256).Hash
$productStatusUnsoldHash = (Get-FileHash -LiteralPath (Join-Path $unsoldTarget "productStatusService.js") -Algorithm SHA256).Hash
$productStatusManageProductHash = (Get-FileHash -LiteralPath (Join-Path $manageProductTarget "productStatusService.js") -Algorithm SHA256).Hash
$productTagSourceHash = (Get-FileHash -LiteralPath $canonicalProductTagService -Algorithm SHA256).Hash
$productTagApiHash = (Get-FileHash -LiteralPath (Join-Path $apiTarget "lib\productTagService.js") -Algorithm SHA256).Hash
$productTagLegacyHash = (Get-FileHash -LiteralPath (Join-Path $batchTagsTarget "productTagService.js") -Algorithm SHA256).Hash
$productWriteSourceHash = (Get-FileHash -LiteralPath $canonicalProductWriteService -Algorithm SHA256).Hash
$productWriteApiHash = (Get-FileHash -LiteralPath (Join-Path $apiTarget "lib\productWriteService.js") -Algorithm SHA256).Hash
$productWriteManageProductHash = (Get-FileHash -LiteralPath (Join-Path $manageProductTarget "productWriteService.js") -Algorithm SHA256).Hash
$inventoryMutationSourceHash = (Get-FileHash -LiteralPath $canonicalInventoryMutationService -Algorithm SHA256).Hash
$inventoryMutationApiHash = (Get-FileHash -LiteralPath (Join-Path $apiTarget "lib\inventoryMutationService.js") -Algorithm SHA256).Hash
$inventoryMutationCancelHash = (Get-FileHash -LiteralPath (Join-Path $cancelTarget "inventoryMutationService.js") -Algorithm SHA256).Hash
$inventoryMutationManageProductHash = (Get-FileHash -LiteralPath (Join-Path $manageProductTarget "inventoryMutationService.js") -Algorithm SHA256).Hash
$inventoryMutationUnsoldHash = (Get-FileHash -LiteralPath (Join-Path $unsoldTarget "inventoryMutationService.js") -Algorithm SHA256).Hash
$inventoryMutationReviewHash = (Get-FileHash -LiteralPath (Join-Path $reviewTarget "inventoryMutationService.js") -Algorithm SHA256).Hash
$productAnalyticsQueryServiceSourceHash = (Get-FileHash -LiteralPath $canonicalProductAnalyticsQueryService -Algorithm SHA256).Hash
$productAnalyticsQueryServiceDashboardHash = (Get-FileHash -LiteralPath (Join-Path $dashboardTarget "productAnalyticsQueryService.js") -Algorithm SHA256).Hash
$productAnalyticsQueryServiceApiHash = (Get-FileHash -LiteralPath (Join-Path $apiTarget "lib\productAnalyticsQueryService.js") -Algorithm SHA256).Hash
$orderQueryServiceSourceHash = (Get-FileHash -LiteralPath $canonicalOrderQueryService -Algorithm SHA256).Hash
$orderQueryServiceApiHash = (Get-FileHash -LiteralPath (Join-Path $apiTarget "lib\orderQueryService.js") -Algorithm SHA256).Hash
$orderQueryServiceLegacyHash = (Get-FileHash -LiteralPath (Join-Path $ordersTarget "orderQueryService.js") -Algorithm SHA256).Hash
$orderReviewServiceSourceHash = (Get-FileHash -LiteralPath $canonicalOrderReviewService -Algorithm SHA256).Hash
$orderReviewServiceApiHash = (Get-FileHash -LiteralPath (Join-Path $apiTarget "lib\orderReviewService.js") -Algorithm SHA256).Hash
$orderReviewServiceLegacyHash = (Get-FileHash -LiteralPath (Join-Path $reviewTarget "orderReviewService.js") -Algorithm SHA256).Hash
$shipmentQueryServiceSourceHash = (Get-FileHash -LiteralPath $canonicalShipmentQueryService -Algorithm SHA256).Hash
$shipmentQueryServiceApiHash = (Get-FileHash -LiteralPath (Join-Path $apiTarget "lib\shipmentQueryService.js") -Algorithm SHA256).Hash
$shipmentQueryServiceLegacyHash = (Get-FileHash -LiteralPath (Join-Path $shipmentGroupsTarget "shipmentQueryService.js") -Algorithm SHA256).Hash
$accountQueryServiceSourceHash = (Get-FileHash -LiteralPath $canonicalAccountQueryService -Algorithm SHA256).Hash
$accountQueryServiceApiHash = (Get-FileHash -LiteralPath (Join-Path $apiTarget "lib\accountQueryService.js") -Algorithm SHA256).Hash
$accountQueryServiceListHash = (Get-FileHash -LiteralPath (Join-Path $adminListAccountsTarget "accountQueryService.js") -Algorithm SHA256).Hash
$accountQueryServiceDetailHash = (Get-FileHash -LiteralPath (Join-Path $adminAccountDetailTarget "accountQueryService.js") -Algorithm SHA256).Hash
$paymentQueryServiceSourceHash = (Get-FileHash -LiteralPath $canonicalPaymentQueryService -Algorithm SHA256).Hash
$paymentQueryServiceApiHash = (Get-FileHash -LiteralPath (Join-Path $apiTarget "lib\paymentQueryService.js") -Algorithm SHA256).Hash
$idempotencySourceHash = (Get-FileHash -LiteralPath $canonicalIdempotency -Algorithm SHA256).Hash
$idempotencyApiHash = (Get-FileHash -LiteralPath (Join-Path $apiTarget "lib\idempotency.js") -Algorithm SHA256).Hash
$idempotencyBatchTagsHash = (Get-FileHash -LiteralPath (Join-Path $batchTagsTarget "idempotency.js") -Algorithm SHA256).Hash
$idempotencyUnsoldHash = (Get-FileHash -LiteralPath (Join-Path $unsoldTarget "idempotency.js") -Algorithm SHA256).Hash
$idempotencyManageProductHash = (Get-FileHash -LiteralPath (Join-Path $manageProductTarget "idempotency.js") -Algorithm SHA256).Hash
$idempotencyPriceHash = (Get-FileHash -LiteralPath (Join-Path $priceTarget "idempotency.js") -Algorithm SHA256).Hash
$idempotencyLegacyHash = (Get-FileHash -LiteralPath (Join-Path $warningTarget "idempotency.js") -Algorithm SHA256).Hash
$idempotencyReviewHash = (Get-FileHash -LiteralPath (Join-Path $reviewTarget "common\idempotency.js") -Algorithm SHA256).Hash
$stockAlertSourceHash = (Get-FileHash -LiteralPath $canonicalStockAlert -Algorithm SHA256).Hash
$stockAlertApiHash = (Get-FileHash -LiteralPath (Join-Path $apiTarget "lib\stockAlert.js") -Algorithm SHA256).Hash
$stockAlertManageProductHash = (Get-FileHash -LiteralPath (Join-Path $manageProductTarget "stockAlert.js") -Algorithm SHA256).Hash
$stockAlertCancelHash = (Get-FileHash -LiteralPath (Join-Path $cancelTarget "stockAlert.js") -Algorithm SHA256).Hash
$stockAlertUnsoldHash = (Get-FileHash -LiteralPath (Join-Path $unsoldTarget "stockAlert.js") -Algorithm SHA256).Hash
$stockAlertLegacyHash = (Get-FileHash -LiteralPath (Join-Path $warningTarget "stockAlert.js") -Algorithm SHA256).Hash
$recommendSourceHash = (Get-FileHash -LiteralPath $canonicalRecommend -Algorithm SHA256).Hash
$recommendManageProductHash = (Get-FileHash -LiteralPath (Join-Path $manageProductTarget "recommend.js") -Algorithm SHA256).Hash
$recommendManageProductCommonHash = (Get-FileHash -LiteralPath (Join-Path $manageProductTarget "common\recommend.js") -Algorithm SHA256).Hash
$syncEventsSourceHash = (Get-FileHash -LiteralPath $canonicalSyncEvents -Algorithm SHA256).Hash
$syncEventsApiHash = (Get-FileHash -LiteralPath (Join-Path $apiTarget "lib\syncEvents.js") -Algorithm SHA256).Hash
$syncEventsReaderHash = (Get-FileHash -LiteralPath (Join-Path $syncReaderTarget "common\syncEvents.js") -Algorithm SHA256).Hash
$syncEventsReviewHash = (Get-FileHash -LiteralPath (Join-Path $reviewTarget "common\syncEvents.js") -Algorithm SHA256).Hash
$dashboardConfigHash = (Get-FileHash -LiteralPath $dashboardConfig -Algorithm SHA256).Hash
$apiConfigHash = (Get-FileHash -LiteralPath $apiConfig -Algorithm SHA256).Hash

if ($securitySourceHash -ne $securityApiHash -or $securitySourceHash -ne $securityAuthHash) {
  throw "Canonical admin auth security hash verification failed"
}
if ($permissionsSourceHash -ne $permissionsDashboardHash -or $permissionsSourceHash -ne $permissionsApiHash -or $permissionsSourceHash -ne $permissionsAuthHash -or $permissionsSourceHash -ne $permissionsBatchTagsHash -or $permissionsSourceHash -ne $permissionsCancelHash -or $permissionsSourceHash -ne $permissionsOrdersHash -or $permissionsSourceHash -ne $permissionsUnsoldHash -or $permissionsSourceHash -ne $permissionsManageProductHash -or $permissionsSourceHash -ne $permissionsPriceHash -or $permissionsSourceHash -ne $permissionsWarningHash -or $permissionsSourceHash -ne $permissionsReviewHash) {
  throw "Canonical permission hash verification failed"
}
if ($inventoryWarningSourceHash -ne $inventoryWarningApiHash -or $inventoryWarningSourceHash -ne $inventoryWarningLegacyHash) {
  throw "Canonical inventory warning service hash verification failed"
}
if ($productPriceSourceHash -ne $productPriceApiHash -or $productPriceSourceHash -ne $productPriceLegacyHash) {
  throw "Canonical product price service hash verification failed"
}
if ($productStatusSourceHash -ne $productStatusApiHash -or $productStatusSourceHash -ne $productStatusUnsoldHash -or $productStatusSourceHash -ne $productStatusManageProductHash) {
  throw "Canonical product status service hash verification failed"
}
if ($productTagSourceHash -ne $productTagApiHash -or $productTagSourceHash -ne $productTagLegacyHash) {
  throw "Canonical product tag service hash verification failed"
}
if ($productWriteSourceHash -ne $productWriteApiHash -or $productWriteSourceHash -ne $productWriteManageProductHash) {
  throw "Canonical product write service hash verification failed"
}
if ($inventoryMutationSourceHash -ne $inventoryMutationApiHash -or $inventoryMutationSourceHash -ne $inventoryMutationCancelHash -or $inventoryMutationSourceHash -ne $inventoryMutationManageProductHash -or $inventoryMutationSourceHash -ne $inventoryMutationUnsoldHash -or $inventoryMutationSourceHash -ne $inventoryMutationReviewHash) {
  throw "Canonical inventory mutation service hash verification failed"
}
if ($productAnalyticsQueryServiceSourceHash -ne $productAnalyticsQueryServiceDashboardHash -or $productAnalyticsQueryServiceSourceHash -ne $productAnalyticsQueryServiceApiHash) {
  throw "Canonical product analytics query service hash verification failed"
}
if ($orderQueryServiceSourceHash -ne $orderQueryServiceApiHash -or $orderQueryServiceSourceHash -ne $orderQueryServiceLegacyHash) {
  throw "Canonical order query service hash verification failed"
}
if ($orderReviewServiceSourceHash -ne $orderReviewServiceApiHash -or $orderReviewServiceSourceHash -ne $orderReviewServiceLegacyHash) {
  throw "Canonical order review service hash verification failed"
}
if ($shipmentQueryServiceSourceHash -ne $shipmentQueryServiceApiHash -or $shipmentQueryServiceSourceHash -ne $shipmentQueryServiceLegacyHash) {
  throw "Canonical shipment query service hash verification failed"
}
if ($accountQueryServiceSourceHash -ne $accountQueryServiceApiHash -or $accountQueryServiceSourceHash -ne $accountQueryServiceListHash -or $accountQueryServiceSourceHash -ne $accountQueryServiceDetailHash) {
  throw "Canonical account query service hash verification failed"
}
if ($paymentQueryServiceSourceHash -ne $paymentQueryServiceApiHash) {
  throw "Canonical payment query service hash verification failed"
}
if ($idempotencySourceHash -ne $idempotencyApiHash -or $idempotencySourceHash -ne $idempotencyBatchTagsHash -or $idempotencySourceHash -ne $idempotencyUnsoldHash -or $idempotencySourceHash -ne $idempotencyManageProductHash -or $idempotencySourceHash -ne $idempotencyPriceHash -or $idempotencySourceHash -ne $idempotencyLegacyHash -or $idempotencySourceHash -ne $idempotencyReviewHash) {
  throw "Canonical idempotency helper hash verification failed"
}
if ($stockAlertSourceHash -ne $stockAlertApiHash -or $stockAlertSourceHash -ne $stockAlertManageProductHash -or $stockAlertSourceHash -ne $stockAlertCancelHash -or $stockAlertSourceHash -ne $stockAlertUnsoldHash -or $stockAlertSourceHash -ne $stockAlertLegacyHash) {
  throw "Canonical stock alert helper hash verification failed"
}
if ($recommendSourceHash -ne $recommendManageProductHash -or $recommendSourceHash -ne $recommendManageProductCommonHash) {
  throw "Canonical product recommendation helper hash verification failed"
}
if ($syncEventsSourceHash -ne $syncEventsApiHash -or $syncEventsSourceHash -ne $syncEventsReaderHash -or $syncEventsSourceHash -ne $syncEventsReviewHash) {
  throw "Canonical sync events helper hash verification failed"
}

$manifest = [ordered]@{
  createdAt = (Get-Date).ToUniversalTime().ToString("o")
  sourceRoot = $root
  functions = @("adminDashboard", "adminGetCustomerAccountDetail", "adminListCustomerAccounts", "adminReviewOrder", "adminWebApi", "adminWebAuth", "batchUpdateProductTags", "cancelOrder", "cleanupSyncEvents", "getOrders", "getSyncEvents", "getUnsoldProducts", "manageProduct", "shipmentGroups", "updateProductPrice", "updateProductWarningStock")
  canonicalSecuritySha256 = $securitySourceHash
  canonicalPermissionsSha256 = $permissionsSourceHash
  canonicalInventoryWarningServiceSha256 = $inventoryWarningSourceHash
  canonicalProductPriceServiceSha256 = $productPriceSourceHash
  canonicalProductStatusServiceSha256 = $productStatusSourceHash
  canonicalProductTagServiceSha256 = $productTagSourceHash
  canonicalProductWriteServiceSha256 = $productWriteSourceHash
  canonicalInventoryMutationServiceSha256 = $inventoryMutationSourceHash
  canonicalProductAnalyticsQueryServiceSha256 = $productAnalyticsQueryServiceSourceHash
  canonicalOrderQueryServiceSha256 = $orderQueryServiceSourceHash
  canonicalOrderReviewServiceSha256 = $orderReviewServiceSourceHash
  canonicalShipmentQueryServiceSha256 = $shipmentQueryServiceSourceHash
  canonicalAccountQueryServiceSha256 = $accountQueryServiceSourceHash
  canonicalPaymentQueryServiceSha256 = $paymentQueryServiceSourceHash
  canonicalIdempotencySha256 = $idempotencySourceHash
  canonicalRecommendSha256 = $recommendSourceHash
  canonicalStockAlertSha256 = $stockAlertSourceHash
  canonicalSyncEventsSha256 = $syncEventsSourceHash
  analyticsTimeoutSeconds = 60
  adminDashboardConfigSha256 = $dashboardConfigHash
  adminWebApiConfigSha256 = $apiConfigHash
  uploadPerformed = $false
}
$manifestPath = Join-Path $output "package-manifest.json"
$manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $manifestPath -Encoding UTF8

[PSCustomObject]@{
  OutputDirectory = $output
  Manifest = $manifestPath
  SecurityHashVerified = $true
  PermissionsHashVerified = $true
  InventoryWarningServiceHashVerified = $true
  ProductPriceServiceHashVerified = $true
  ProductStatusServiceHashVerified = $true
  ProductTagServiceHashVerified = $true
  ProductWriteServiceHashVerified = $true
  InventoryMutationServiceHashVerified = $true
  ProductAnalyticsQueryServiceHashVerified = $true
  OrderQueryServiceHashVerified = $true
  ShipmentQueryServiceHashVerified = $true
  AccountQueryServiceHashVerified = $true
  PaymentQueryServiceHashVerified = $true
  IdempotencyHashVerified = $true
  RecommendHashVerified = $true
  StockAlertHashVerified = $true
  SyncEventsHashVerified = $true
  AnalyticsTimeoutVerified = $true
  UploadPerformed = $false
}
