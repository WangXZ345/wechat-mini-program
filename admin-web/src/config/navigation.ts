import type { AccessRule } from "./access";

export type NavigationGroup = "总览" | "商品库存" | "订单履约" | "财务" | "售后" | "管理";

export interface NavigationEntry {
  key: string;
  name: string;
  path: string;
  title: string;
  group: NavigationGroup;
  icon: string;
  access: AccessRule;
  sensitive?: boolean;
  menu?: boolean;
  resource?: string;
}

export const navigationEntries: NavigationEntry[] = [
  { key: "dashboard", name: "dashboard", path: "/dashboard", title: "工作台", group: "总览", icon: "layout-dashboard", access: { permissionsAny: ["dashboard:view_basic"] } },
  { key: "products", name: "products", path: "/products", title: "商品管理", group: "商品库存", icon: "package", access: { permissionsAny: ["product:view"] }, resource: "products" },
  { key: "inventory", name: "inventory", path: "/inventory", title: "库存管理", group: "商品库存", icon: "warehouse", access: { permissionsAny: ["inventory:view"] }, resource: "inventory" },
  { key: "inventory-alerts", name: "inventory-alerts", path: "/inventory/alerts", title: "库存预警", group: "商品库存", icon: "triangle-alert", access: { permissionsAny: ["inventory:view", "inventory:set_warning"] }, resource: "inventory-alerts" },
  { key: "quote-import", name: "quote-import", path: "/imports/quotes", title: "报价导入", group: "商品库存", icon: "file-up", access: { permissionsAny: ["inventory:import"] } },
  { key: "inventory-import", name: "inventory-import", path: "/imports/inventory", title: "库存导入", group: "商品库存", icon: "sheet", access: { permissionsAny: ["inventory:import"] } },
  { key: "product-analytics", name: "product-analytics", path: "/analytics/products", title: "商品分析", group: "商品库存", icon: "chart-no-axes-combined", access: { roles: ["procurement", "super_admin"], permissionsAny: ["product:analytics:view"] } },
  { key: "orders", name: "orders", path: "/orders", title: "订单管理", group: "订单履约", icon: "clipboard-list", access: { permissionsAny: ["order:view"] }, resource: "orders" },
  { key: "shipments", name: "shipments", path: "/shipments", title: "发货管理", group: "订单履约", icon: "truck", access: { permissionsAny: ["shipment:view"] }, resource: "shipments" },
  { key: "payments", name: "payments", path: "/payments", title: "付款审核", group: "财务", icon: "badge-check", access: { permissionsAny: ["payment:confirm", "payment:view_screenshot"] }, sensitive: true, resource: "payments" },
  { key: "accounts", name: "accounts", path: "/accounts", title: "客户账款", group: "财务", icon: "landmark", access: { permissionsAny: ["customer:view_account"] }, sensitive: true, resource: "accounts" },
  { key: "after-sales", name: "after-sales", path: "/after-sales", title: "售后审核", group: "售后", icon: "rotate-ccw", access: { permissionsAny: ["after_sale:view"] }, resource: "after-sales" },
  { key: "refunds", name: "refunds", path: "/refunds", title: "退款处理", group: "售后", icon: "circle-dollar-sign", access: { permissionsAny: ["refund:view"] }, sensitive: true, resource: "refunds" },
  { key: "admins", name: "admins", path: "/admins", title: "管理员", group: "管理", icon: "shield-check", access: { permissionsAny: ["admin:view"] }, sensitive: true, resource: "admins" },
  { key: "audit", name: "audit", path: "/audit", title: "操作日志", group: "管理", icon: "scroll-text", access: { permissionsAny: ["operation_log:view"] }, resource: "audit" },
  { key: "settings", name: "settings", path: "/settings", title: "系统设置", group: "管理", icon: "settings", access: { permissionsAny: ["system:settings"] }, sensitive: true }
];

export const navigationGroups: NavigationGroup[] = ["总览", "商品库存", "订单履约", "财务", "售后", "管理"];
