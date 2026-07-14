<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElButton, ElDropdown, ElDropdownItem, ElDropdownMenu, ElTag, ElTooltip } from "element-plus";
import {
  BadgeCheck,
  ChartNoAxesCombined,
  ChevronDown,
  CircleDollarSign,
  ClipboardList,
  FileUp,
  Landmark,
  LayoutDashboard,
  LogOut,
  Menu,
  Package,
  PanelLeftClose,
  PanelLeftOpen,
  RotateCcw,
  ScrollText,
  Settings,
  Sheet,
  ShieldCheck,
  TriangleAlert,
  Truck,
  Warehouse
} from "lucide-vue-next";
import SyncStatus from "@/components/SyncStatus.vue";
import { hasAccess } from "@/config/access";
import { dataEnvironmentLabel, env, useMockTransport } from "@/config/env";
import { navigationEntries, navigationGroups } from "@/config/navigation";
import { useAppStore } from "@/stores/app";
import { useAuthStore } from "@/stores/auth";
import { useRealtimeStore } from "@/stores/realtime";

const route = useRoute();
const router = useRouter();
const app = useAppStore();
const auth = useAuthStore();
const realtime = useRealtimeStore();

const icons: Record<string, typeof Menu> = {
  "layout-dashboard": LayoutDashboard,
  package: Package,
  warehouse: Warehouse,
  "triangle-alert": TriangleAlert,
  "file-up": FileUp,
  sheet: Sheet,
  "chart-no-axes-combined": ChartNoAxesCombined,
  "clipboard-list": ClipboardList,
  truck: Truck,
  "badge-check": BadgeCheck,
  landmark: Landmark,
  "rotate-ccw": RotateCcw,
  "circle-dollar-sign": CircleDollarSign,
  "shield-check": ShieldCheck,
  "scroll-text": ScrollText,
  settings: Settings
};

const groupedMenus = computed(() => navigationGroups.map((group) => ({
  group,
  items: navigationEntries.filter((item) => item.group === group && item.menu !== false && hasAccess(auth.profile, item.access))
})).filter((entry) => entry.items.length));

function logout(): void {
  realtime.stop();
  const revocation = auth.logout();
  void router.replace({ name: "login" }).catch(() => undefined);
  void revocation;
}

function onDropdown(command: string): void {
  if (command === "logout") void logout();
}

onMounted(() => {
  app.syncViewport();
  window.addEventListener("resize", app.syncViewport);
  realtime.start();
});

onBeforeUnmount(() => {
  window.removeEventListener("resize", app.syncViewport);
  realtime.stop();
});
</script>

<template>
  <div class="admin-layout" :class="{ 'is-collapsed': app.sidebarCollapsed }">
    <aside class="sidebar">
      <div class="brand" :title="app.sidebarCollapsed ? '美妆订货管理' : undefined">
        <div class="brand__mark">美</div>
        <div v-if="!app.sidebarCollapsed" class="brand__text">
          <strong>美妆管理</strong>
          <span>WHOLESALE OPS</span>
        </div>
      </div>

      <nav class="sidebar__nav" aria-label="后台导航">
        <section v-for="group in groupedMenus" :key="group.group" class="nav-group">
          <div v-if="!app.sidebarCollapsed" class="nav-group__label">{{ group.group }}</div>
          <router-link
            v-for="item in group.items"
            :key="item.key"
            :to="item.path"
            class="nav-item"
            :class="{ active: route.path === item.path || (item.path !== '/dashboard' && route.path.startsWith(`${item.path}/`)) }"
            :title="app.sidebarCollapsed ? item.title : undefined"
          >
            <component :is="icons[item.icon] || Menu" :size="18" />
            <span v-if="!app.sidebarCollapsed">{{ item.title }}</span>
          </router-link>
        </section>
      </nav>

      <div v-if="!app.sidebarCollapsed" class="sidebar__footer">
        <span>{{ env.release }}</span>
        <span>管理后台</span>
      </div>
    </aside>

    <div class="admin-layout__main">
      <header class="topbar">
        <el-tooltip :content="app.sidebarCollapsed ? '展开侧栏' : '收起侧栏'" placement="bottom">
          <el-button class="icon-button" text circle @click="app.toggleSidebar">
            <component :is="app.sidebarCollapsed ? PanelLeftOpen : PanelLeftClose" :size="20" />
            <span class="sr-only">切换侧栏</span>
          </el-button>
        </el-tooltip>
        <div class="topbar__path">
          <span>运营后台</span>
          <strong>{{ route.meta.title }}</strong>
        </div>
        <div class="topbar__spacer" />
        <el-tag class="environment-tag" :type="useMockTransport ? 'warning' : 'info'" effect="plain" size="small">{{ dataEnvironmentLabel }}</el-tag>
        <sync-status />
        <div class="topbar__divider" />
        <el-dropdown trigger="click" @command="onDropdown">
          <button class="account-button" type="button">
            <span class="account-button__avatar">{{ auth.profile?.displayName.slice(-2) }}</span>
            <span class="account-button__text">
              <strong>{{ auth.profile?.displayName }}</strong>
              <small>{{ auth.profile?.roleName }}</small>
            </span>
            <chevron-down :size="15" />
          </button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="logout">
                <log-out :size="16" />
                退出登录
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </header>

      <div v-if="useMockTransport" class="demo-strip">
        本地演示环境 · 所有记录均为虚构掩码数据，不会写入小程序或业务数据库
      </div>

      <main class="admin-content">
        <router-view v-slot="{ Component }">
          <transition name="page" mode="out-in">
            <component :is="Component" />
          </transition>
        </router-view>
      </main>
    </div>
  </div>
</template>

<style scoped>
.admin-layout {
  --current-sidebar-width: 240px;
  min-height: 100vh;
  background: var(--color-bg);
}

.admin-layout.is-collapsed {
  --current-sidebar-width: 72px;
}

.sidebar {
  position: fixed;
  z-index: 20;
  inset: 0 auto 0 0;
  display: flex;
  width: var(--current-sidebar-width);
  flex-direction: column;
  color: #fff;
  background: var(--color-sidebar);
  transition: width var(--transition-fast);
}

.brand {
  display: flex;
  height: 64px;
  flex: 0 0 64px;
  align-items: center;
  gap: 10px;
  padding: 0 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.09);
}

.brand__mark {
  display: grid;
  width: 36px;
  height: 36px;
  flex: 0 0 36px;
  place-items: center;
  border: 1px solid rgba(255, 255, 255, 0.3);
  border-radius: 6px;
  color: #1f1a15;
  background: #d6bd98;
  font-family: Georgia, serif;
  font-size: 20px;
  font-weight: 700;
}

.brand__text {
  min-width: 0;
}

.brand__text strong,
.brand__text span {
  display: block;
  white-space: nowrap;
}

.brand__text strong {
  font-size: 15px;
}

.brand__text span {
  margin-top: 2px;
  color: var(--color-sidebar-muted);
  font-size: 9px;
}

.sidebar__nav {
  flex: 1;
  padding: 12px 10px 24px;
  overflow-x: hidden;
  overflow-y: auto;
}

.nav-group + .nav-group {
  margin-top: 13px;
}

.nav-group__label {
  padding: 0 10px 6px;
  color: #8f887f;
  font-size: 11px;
  line-height: 18px;
}

.nav-item {
  position: relative;
  display: flex;
  height: 38px;
  align-items: center;
  gap: 11px;
  padding: 0 11px;
  border-radius: 6px;
  color: #c8c1b8;
  transition: color var(--transition-fast), background var(--transition-fast);
}

.nav-item + .nav-item {
  margin-top: 2px;
}

.nav-item:hover {
  color: #fff;
  background: rgba(255, 255, 255, 0.07);
}

.nav-item.active {
  color: var(--color-sidebar-active);
  background: rgba(185, 156, 116, 0.22);
}

.nav-item.active::before {
  position: absolute;
  width: 3px;
  border-radius: 0 2px 2px 0;
  background: #d6bd98;
  content: "";
  inset: 8px auto 8px -10px;
}

.is-collapsed .brand,
.is-collapsed .nav-item {
  justify-content: center;
}

.is-collapsed .nav-item {
  padding: 0;
}

.sidebar__footer {
  display: flex;
  justify-content: space-between;
  padding: 12px 18px;
  color: #8f887f;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  font-size: 10px;
}

.admin-layout__main {
  min-height: 100vh;
  margin-left: var(--current-sidebar-width);
  transition: margin-left var(--transition-fast);
}

.topbar {
  position: sticky;
  z-index: 15;
  top: 0;
  display: flex;
  height: var(--topbar-height);
  align-items: center;
  gap: 12px;
  padding: 0 20px;
  border-bottom: 1px solid var(--color-border);
  background: rgba(255, 255, 255, 0.96);
  backdrop-filter: blur(10px);
}

.icon-button {
  width: 36px;
  height: 36px;
}

.topbar__path {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--color-text-muted);
  font-size: 13px;
}

.topbar__path strong {
  color: var(--color-text);
  font-size: 14px;
}

.topbar__path span::after {
  margin-left: 8px;
  color: #b6aea5;
  content: "/";
}

.topbar__spacer {
  flex: 1;
}

.topbar__divider {
  width: 1px;
  height: 24px;
  background: var(--color-border);
}

.account-button {
  display: flex;
  height: 44px;
  align-items: center;
  gap: 8px;
  padding: 0 4px;
  border: 0;
  color: inherit;
  background: transparent;
  cursor: pointer;
}

.account-button__avatar {
  display: grid;
  width: 32px;
  height: 32px;
  place-items: center;
  border-radius: 50%;
  color: #fff;
  background: #496575;
  font-size: 12px;
  font-weight: 700;
}

.account-button__text {
  display: flex;
  min-width: 94px;
  flex-direction: column;
  align-items: flex-start;
}

.account-button__text strong {
  max-width: 120px;
  overflow: hidden;
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.account-button__text small {
  color: var(--color-text-muted);
  font-size: 11px;
}

.demo-strip {
  display: flex;
  min-height: 28px;
  align-items: center;
  justify-content: center;
  padding: 5px 16px;
  color: #74511f;
  border-bottom: 1px solid #ead4ac;
  background: #fff5df;
  font-size: 12px;
  line-height: 18px;
  text-align: center;
}

.admin-content {
  min-height: calc(100vh - var(--topbar-height));
}

.page-enter-active,
.page-leave-active {
  transition: opacity 120ms ease, transform 120ms ease;
}

.page-enter-from,
.page-leave-to {
  opacity: 0;
  transform: translateY(2px);
}

@media (max-width: 1180px) {
  .account-button__text,
  .topbar__path span {
    display: none;
  }
}

@media (max-width: 640px) {
  .admin-layout,
  .admin-layout.is-collapsed {
    --current-sidebar-width: 56px;
  }

  .brand {
    padding: 0 10px;
  }

  .brand__mark {
    width: 34px;
    height: 34px;
    flex-basis: 34px;
  }

  .sidebar__nav {
    padding-inline: 6px;
  }

  .topbar {
    gap: 7px;
    padding: 0 10px;
  }

  .environment-tag,
  .topbar__divider,
  .topbar :deep(.sync-status) {
    display: none;
  }

  .account-button__avatar {
    width: 30px;
    height: 30px;
  }

  .demo-strip {
    padding-inline: 10px;
    font-size: 11px;
  }
}
</style>
