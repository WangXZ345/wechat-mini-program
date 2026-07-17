const ALL_PERMISSIONS = [
  "order:view",
  "order:review",
  "order:reject",
  "order:edit_remark",
  "order:export",
  "order:view_sensitive",
  "order:ship",
  "payment:view_screenshot",
  "payment:confirm",
  "payment:update_status",
  "payment:export",
  "payment:config",
  "payment_method:view",
  "payment_method:create",
  "payment_method:update",
  "payment_method:disable",
  "payment_method:delete",
  "payment_method:upload_qrcode",
  "payment_method:view_sensitive",
  "payment:wechat_pay_config",
  "after_sale:view",
  "after_sale:review",
  "after_sale:receive_return",
  "after_sale:inspect",
  "after_sale:update",
  "after_sale:complete",
  "after_sale:cancel",
  "refund:view",
  "refund:create",
  "refund:process",
  "refund:wechat_pay",
  "refund:export",
  "refund:view_sensitive",
  "shipment:view",
  "shipment:merge",
  "shipment:update",
  "shipment:ship",
  "shipment:cancel",
  "shipment:complete",
  "shipment:export",
  "shipment:view_address_full",
  "shipment:view_address_masked",
  "customer:view_basic",
  "customer:view_account",
  "customer:edit_remark",
  "customer:export_account",
  "customer:view_phone_masked",
  "customer:view_phone_full",
  "customer:search_by_phone",
  "customer:update_phone_admin",
  "customer:view_phone_log",
  "customer:view_address_masked",
  "customer:view_address_full",
  "customer:export_address",
  "customer:manage_address_admin",
  "product:view",
  "product:create",
  "product:update",
  "product:delete",
  "product:update_price",
  "product:update_status",
  "product:tag:view",
  "product:tag:update",
  "product:tag:batch_update",
  "product:analytics:view",
  "home_recommend:view",
  "home_recommend:manage",
  "inventory:view",
  "inventory:update",
  "inventory:import",
  "inventory:view_log",
  "inventory:set_warning",
  "dashboard:view_basic",
  "dashboard:view_sales",
  "dashboard:view_finance",
  "dashboard:view_inventory",
  "dashboard:view_product",
  "admin:view",
  "admin:create",
  "admin:update_role",
  "admin:disable",
  "operation_log:view",
  "system:settings",
  "system:payment_methods"
];

const ROLE_NAMES = {
  super_admin: "超级管理员",
  customer_service: "客服",
  finance: "财务",
  procurement: "采购"
};

const ROLE_DESCRIPTIONS = {
  super_admin: "拥有全部后台权限，可以管理管理员、角色和系统配置。",
  customer_service: "负责订单沟通、客户基础信息和订单/客户备注。",
  finance: "负责付款确认、账款、对账和财务导出。",
  procurement: "负责商品基础资料、库存、库存导入和库存预警。"
};

const ROLE_PERMISSIONS = {
  super_admin: ALL_PERMISSIONS.slice(),
  customer_service: [
    "dashboard:view_basic",
    "order:view",
    "order:review",
    "order:reject",
    "order:edit_remark",
    "order:ship",
    "after_sale:view",
    "after_sale:review",
    "after_sale:receive_return",
    "after_sale:inspect",
    "after_sale:update",
    "after_sale:complete",
    "shipment:view",
    "shipment:merge",
    "shipment:update",
    "shipment:ship",
    "shipment:cancel",
    "shipment:complete",
    "shipment:view_address_masked",
    "customer:view_basic",
    "customer:edit_remark",
    "customer:view_phone_masked",
    "customer:search_by_phone",
    "customer:view_address_masked",
    "product:tag:view"
  ],
  finance: [
    "dashboard:view_basic",
    "dashboard:view_sales",
    "dashboard:view_finance",
    "order:view",
    "shipment:view",
    "shipment:view_address_masked",
    "payment:view_screenshot",
    "payment:confirm",
    "payment:update_status",
    "payment:export",
    "payment:config",
    "payment_method:view",
    "payment_method:create",
    "payment_method:update",
    "payment_method:disable",
    "payment_method:delete",
    "payment_method:upload_qrcode",
    "payment_method:view_sensitive",
    "after_sale:view",
    "refund:view",
    "refund:create",
    "refund:process",
    "refund:export",
    "refund:view_sensitive",
    "refund:wechat_pay",
    "customer:view_basic",
    "customer:view_account",
    "customer:export_account",
    "customer:view_phone_masked",
    "customer:view_phone_full",
    "customer:search_by_phone",
    "customer:view_address_masked",
    "customer:view_address_full",
    "customer:export_address",
    "order:export"
  ],
  procurement: [
    "dashboard:view_basic",
    "dashboard:view_inventory",
  "dashboard:view_product",
    "product:view",
    "product:create",
    "product:update",
    "product:update_price",
    "product:update_status",
    "product:tag:view",
    "product:tag:update",
    "product:tag:batch_update",
  "product:analytics:view",
    "home_recommend:view",
    "home_recommend:manage",
    "inventory:view",
    "inventory:update",
    "inventory:import",
    "inventory:view_log",
    "inventory:set_warning"
  ]
};

const ROLE_ASSIGNABLE_PERMISSIONS = {
  customer_service: [
    "dashboard:view_product",
    "product:analytics:view"
  ],
  finance: [
    "dashboard:view_product",
    "product:analytics:view"
  ]
};
function uniquePermissions(permissions) {
  const allowed = new Set(ALL_PERMISSIONS);
  return Array.from(new Set((permissions || []).filter((item) => allowed.has(item))));
}

function filterPermissionsForRole(role, permissions) {
  const list = uniquePermissions(permissions);

  // 对所有非 super_admin 角色进行权限边界限制
  if (role === "super_admin") return list;

  // 其他角色必须在预定义的角色权限范围内
  const allowed = new Set(uniquePermissions((ROLE_PERMISSIONS[role] || []).concat(ROLE_ASSIGNABLE_PERMISSIONS[role] || [])));
  return list.filter((permission) => allowed.has(permission));
}

function permissionsForRole(role) {
  return filterPermissionsForRole(role, ROLE_PERMISSIONS[role] || []);
}

module.exports = {
  ALL_PERMISSIONS,
  ROLE_NAMES,
  ROLE_DESCRIPTIONS,
  ROLE_PERMISSIONS,
  ROLE_ASSIGNABLE_PERMISSIONS,
  filterPermissionsForRole,
  permissionsForRole,
  uniquePermissions
};

