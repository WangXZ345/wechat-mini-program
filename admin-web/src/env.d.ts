/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_ENV?: string;
  readonly VITE_DATA_MODE?: "real" | "mock";
  readonly VITE_CLOUDBASE_ENV_ID?: string;
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_REQUEST_TIMEOUT_MS?: string;
  readonly VITE_REALTIME_MODE?: string;
  readonly VITE_RELEASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare const __ADMIN_WEB_DEV_BFF_PROXY_MISSING__: boolean;

declare module "virtual:admin-selected-transport" {
  import type { AdminTransport } from "@/types/api";
  import type { LoginDemoConfig } from "@/services/transport/selected-types";

  export function createSelectedTransport(): AdminTransport;
  export const selectedLoginDemo: LoginDemoConfig | null;
}
