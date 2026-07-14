const analyticsModule = require("./productAnalyticsQueryService");

const ANALYTICS_PERMISSIONS = Object.freeze([
  "product:analytics:view",
  "dashboard:view_product"
]);

function forbidden() {
  throw new analyticsModule.ProductAnalyticsError("FORBIDDEN", "无权访问商品分析", 403);
}

function createProductAnalytics(options = {}) {
  const service = options.service || analyticsModule.createProductAnalyticsQueryService({
    db: options.db,
    command: options.command || options._,
    repository: options.repository,
    limits: options.limits,
    now: options.now
  });
  const auth = options.auth || (
    options.requireAdmin && options.hasPermission ? null : require("./auth")
  );
  const requireAdmin = options.requireAdmin || auth.requireAdmin;
  const hasPermission = options.hasPermission || auth.hasPermission;

  return async function getProductAnalytics(event = {}) {
    const admin = await requireAdmin();
    if (!admin || admin.status === "disabled" || admin.isActive === false) forbidden();
    if (!ANALYTICS_PERMISSIONS.some((permission) => hasPermission(admin, permission))) forbidden();
    return service.getProductDetail(event);
  };
}

module.exports = {
  ANALYTICS_PERMISSIONS,
  createProductAnalytics
};
