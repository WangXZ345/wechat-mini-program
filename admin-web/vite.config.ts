import { fileURLToPath, URL } from "node:url";
import vue from "@vitejs/plugin-vue";
import ElementPlus from "unplugin-element-plus/vite";
import { defineConfig, loadEnv, type Plugin } from "vite";
import { normalizeApiBaseUrl, type AdminWebAppEnvironment } from "./src/config/bff-url";
import { resolveDevProxyConfiguration } from "./vite-security";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));
const sourceRoot = fileURLToPath(new URL("./src", import.meta.url));

function normalizeDataMode(value: string | undefined): "real" | "mock" {
  const mode = value || "real";
  if (mode !== "real" && mode !== "mock") throw new Error("VITE_DATA_MODE must be real or mock.");
  return mode;
}

function normalizeAppEnvironment(value: string | undefined): AdminWebAppEnvironment {
  const appEnv = value || "test";
  if (!["local", "test", "staging", "production"].includes(appEnv)) {
    throw new Error("VITE_APP_ENV must be local, test, staging, or production.");
  }
  return appEnv as AdminWebAppEnvironment;
}

function unavailableBffPlugin(enabled: boolean, apiPath: string): Plugin {
  return {
    name: "admin-web-bff-unavailable",
    apply: "serve",
    configureServer(server) {
      if (!enabled) return;
      server.middlewares.use((request, response, next) => {
        const path = (request.url || "").split("?", 1)[0] || "";
        if (path !== apiPath && !path.startsWith(`${apiPath}/`)) {
          next();
          return;
        }

        const code = "BFF_PROXY_NOT_CONFIGURED";
        const message = "未配置测试 BFF 连接";
        const requestId = `dev-bff-${Date.now().toString(36)}`;
        const serverTime = new Date().toISOString();
        response.statusCode = 503;
        response.setHeader("content-type", "application/json; charset=utf-8");
        response.setHeader("cache-control", "no-store");
        response.end(JSON.stringify({
          ok: false,
          code,
          message,
          requestId,
          serverTime,
          error: { code, message, requestId },
          meta: { requestId, serverTime }
        }));
      });
    }
  };
}

export default defineConfig(({ command, mode }) => {
  const loaded = loadEnv(mode, projectRoot, "");
  const dataMode = normalizeDataMode(loaded.VITE_DATA_MODE);
  const appEnv = normalizeAppEnvironment(loaded.VITE_APP_ENV);
  const rawApiBaseUrl = loaded.VITE_API_BASE_URL?.trim() || "";
  const normalizedApiBase = rawApiBaseUrl ? normalizeApiBaseUrl(rawApiBaseUrl, appEnv) : null;
  const apiBaseUrl = normalizedApiBase?.value || "";
  const cloudbaseEnvId = loaded.VITE_CLOUDBASE_ENV_ID?.trim() || "";
  const realtimeMode = loaded.VITE_REALTIME_MODE?.trim() || "polling";

  if (dataMode === "real" && (!apiBaseUrl || !cloudbaseEnvId)) {
    throw new Error("Real data mode requires VITE_CLOUDBASE_ENV_ID and VITE_API_BASE_URL.");
  }
  if (dataMode === "real" && realtimeMode === "mock") {
    throw new Error("Real data mode cannot use VITE_REALTIME_MODE=mock.");
  }

  const sameOriginApi = normalizedApiBase?.sameOrigin === true;
  const apiPath = sameOriginApi ? apiBaseUrl : "/api/admin/v1";
  const proxyConfiguration = command === "serve" && sameOriginApi
    ? resolveDevProxyConfiguration({
      ADMIN_WEB_BFF_PROXY_TARGET: process.env.ADMIN_WEB_BFF_PROXY_TARGET || loaded.ADMIN_WEB_BFF_PROXY_TARGET,
      ADMIN_WEB_BFF_PROXY_ORIGIN: process.env.ADMIN_WEB_BFF_PROXY_ORIGIN || loaded.ADMIN_WEB_BFF_PROXY_ORIGIN,
      ADMIN_WEB_ACTION_SECRET: process.env.ADMIN_WEB_ACTION_SECRET || loaded.ADMIN_WEB_ACTION_SECRET
    }, appEnv)
    : null;
  const devProxyMissing = command === "serve" && dataMode === "real" && sameOriginApi && !proxyConfiguration;
  const selectedTransport = fileURLToPath(new URL(
    dataMode === "mock"
      ? "./src/services/transport/selected-mock.ts"
      : "./src/services/transport/selected-real.ts",
    import.meta.url
  ));
  const realImportPreview = fileURLToPath(new URL(
    "./src/services/transport/selected-import-preview-real.ts",
    import.meta.url
  ));

  return {
    plugins: [
      vue(),
      ElementPlus({ useSource: false }),
      unavailableBffPlugin(devProxyMissing, apiPath)
    ],
    define: {
      __ADMIN_WEB_DEV_BFF_PROXY_MISSING__: JSON.stringify(devProxyMissing)
    },
    resolve: {
      alias: [
        ...(dataMode === "real"
          ? [{ find: "./mock-import-preview", replacement: realImportPreview }]
          : []),
        { find: "virtual:admin-selected-transport", replacement: selectedTransport },
        { find: "@", replacement: sourceRoot }
      ]
    },
    build: {
      sourcemap: false,
      target: "es2022",
      chunkSizeWarningLimit: 750,
      rollupOptions: {
        output: {
          manualChunks: {
            vue: ["vue", "vue-router", "pinia"],
            charts: ["echarts", "vue-echarts"]
          }
        }
      }
    },
    server: {
      host: "127.0.0.1",
      port: 4173,
      strictPort: true,
      ...(proxyConfiguration ? {
        proxy: {
          [apiPath]: {
            target: proxyConfiguration.target,
            changeOrigin: true,
            secure: true,
            headers: {
              Origin: proxyConfiguration.origin,
              "X-Admin-Action-Secret": proxyConfiguration.actionSecret
            }
          }
        }
      } : {})
    }
  };
});
