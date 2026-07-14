import { createRouter, createWebHistory, type RouteRecordRaw } from "vue-router";
import { hasAccess } from "@/config/access";
import { navigationEntries } from "@/config/navigation";
import AdminLayout from "@/layouts/AdminLayout.vue";
import { useAuthStore } from "@/stores/auth";

const operationsRoutes = navigationEntries
  .filter((entry) => entry.resource)
  .map<RouteRecordRaw>((entry) => ({
    path: entry.path.slice(1),
    name: entry.name,
    component: () => import("@/modules/resources/OperationsView.vue"),
    meta: {
      title: entry.title,
      requiresAuth: true,
      access: entry.access,
      sensitive: entry.sensitive,
      resource: entry.resource
    }
  }));

const routes: RouteRecordRaw[] = [
  {
    path: "/login",
    name: "login",
    component: () => import("@/modules/auth/LoginView.vue"),
    meta: { title: "管理员登录" }
  },
  {
    path: "/",
    component: AdminLayout,
    meta: { requiresAuth: true },
    children: [
      { path: "", redirect: "/dashboard" },
      {
        path: "dashboard",
        name: "dashboard",
        component: () => import("@/modules/dashboard/DashboardView.vue"),
        meta: { title: "工作台", requiresAuth: true, access: navigationEntries.find((entry) => entry.key === "dashboard")?.access }
      },
      ...operationsRoutes,
      {
        path: "imports/quotes",
        name: "quote-import",
        component: () => import("@/modules/imports/ImportView.vue"),
        props: { mode: "quotes" },
        meta: { title: "报价导入", requiresAuth: true, access: navigationEntries.find((entry) => entry.key === "quote-import")?.access }
      },
      {
        path: "imports/inventory",
        name: "inventory-import",
        component: () => import("@/modules/imports/ImportView.vue"),
        props: { mode: "inventory" },
        meta: { title: "库存导入", requiresAuth: true, access: navigationEntries.find((entry) => entry.key === "inventory-import")?.access }
      },
      {
        path: "analytics/products",
        name: "product-analytics",
        component: () => import("@/modules/analytics/ProductAnalyticsView.vue"),
        meta: { title: "商品分析", requiresAuth: true, access: navigationEntries.find((entry) => entry.key === "product-analytics")?.access }
      },
      {
        path: "settings",
        name: "settings",
        component: () => import("@/modules/settings/SettingsView.vue"),
        meta: { title: "系统设置", requiresAuth: true, sensitive: true, access: navigationEntries.find((entry) => entry.key === "settings")?.access }
      },
      {
        path: "products/:id",
        name: "product-detail",
        component: () => import("@/modules/resources/ResourceDetailView.vue"),
        props: { resource: "products" },
        meta: { title: "商品详情", requiresAuth: true, access: { permissionsAny: ["product:view"] } }
      },
      {
        path: "orders/:id",
        name: "order-detail",
        component: () => import("@/modules/orders/OrderDetailView.vue"),
        meta: { title: "订单详情", requiresAuth: true, access: { permissionsAny: ["order:view"] } }
      },
      {
        path: "shipments/:id",
        name: "shipment-detail",
        component: () => import("@/modules/shipments/ShipmentDetailView.vue"),
        meta: { title: "合并发货单详情", requiresAuth: true, access: { permissionsAny: ["shipment:view"] } }
      },
      {
        path: "accounts/:id",
        name: "account-detail",
        component: () => import("@/modules/accounts/AccountDetailView.vue"),
        meta: { title: "客户账款详情", requiresAuth: true, sensitive: true, access: { permissionsAny: ["customer:view_account"] } }
      },
      {
        path: "403",
        name: "forbidden",
        component: () => import("@/modules/resources/ForbiddenView.vue"),
        meta: { title: "无权访问", requiresAuth: true }
      },
      {
        path: ":pathMatch(.*)*",
        name: "not-found",
        component: () => import("@/modules/resources/NotFoundView.vue"),
        meta: { title: "页面不存在", requiresAuth: true }
      }
    ]
  }
];

export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
  scrollBehavior: () => ({ top: 0 })
});

function safeRedirect(value: unknown): string {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") ? value : "/dashboard";
}

router.beforeEach(async (to) => {
  const auth = useAuthStore();
  await auth.bootstrap();

  if (to.name === "login") {
    return auth.isAuthenticated ? safeRedirect(to.query.redirect) : true;
  }
  if (to.meta.requiresAuth && !auth.isAuthenticated) {
    return { name: "login", query: { redirect: to.fullPath } };
  }
  if (to.meta.access && !hasAccess(auth.profile, to.meta.access)) {
    return to.name === "forbidden" ? true : { name: "forbidden", query: { from: to.fullPath } };
  }
  return true;
});

router.afterEach((to) => {
  document.title = to.meta.title ? `${to.meta.title} | 订货管理后台` : "订货管理后台";
});
