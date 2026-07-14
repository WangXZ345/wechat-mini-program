import { computed, ref } from "vue";
import { defineStore } from "pinia";
import { env } from "@/config/env";
import { toApiError } from "@/services/http/api-error";
import { CursorSyncClient } from "@/services/realtime/cursor-sync";
import { transport } from "@/services/transport";
import type { SyncConnectionStatus, SyncEvent } from "@/types/realtime";
import { useAuthStore } from "./auth";

const client = new CursorSyncClient(transport);
const BASE_INTERVAL_MS = 2_000;
const HIDDEN_INTERVAL_MS = 8_000;
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];
const INITIAL_CURSOR = transport.mode === "mock" ? "0" : "";

export const useRealtimeStore = defineStore("realtime", () => {
  const status = ref<SyncConnectionStatus>("connecting");
  const cursor = ref(INITIAL_CURSOR);
  const lastSyncedAt = ref<string | null>(null);
  const retryCount = ref(0);
  const lastEventCount = ref(0);
  const dataUpdated = ref(false);
  const running = ref(false);
  let timer: number | null = null;
  let updatePulse: number | null = null;
  let syncing = false;

  const label = computed(() => {
    if (dataUpdated.value) return "数据已更新";
    const labels: Record<SyncConnectionStatus, string> = {
      connecting: "正在连接",
      catching_up: "正在同步",
      synced: "已同步",
      offline: "连接中断",
      reconnecting: "正在重新连接"
    };
    return labels[status.value];
  });

  const isHealthy = computed(() => status.value === "synced" || status.value === "catching_up");

  function storageKey(): string {
    const auth = useAuthStore();
    return `admin-web.sync-cursor.${env.appEnv}.${auth.profile?.role || "anonymous"}`;
  }

  function schedule(delay: number): void {
    if (!running.value || env.realtimeMode === "off") return;
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(() => void syncNow(), delay);
  }

  function publish(events: SyncEvent[]): void {
    if (!events.length) return;
    dataUpdated.value = true;
    lastEventCount.value = events.length;
    window.dispatchEvent(new CustomEvent("admin-web:sync-events", { detail: { events } }));
    if (updatePulse) window.clearTimeout(updatePulse);
    updatePulse = window.setTimeout(() => {
      dataUpdated.value = false;
    }, 2_200);
  }

  async function syncNow(): Promise<void> {
    if (!running.value || syncing || env.realtimeMode === "off") return;
    if (!navigator.onLine) {
      status.value = "offline";
      schedule(BACKOFF_MS[Math.min(retryCount.value, BACKOFF_MS.length - 1)] || 30_000);
      return;
    }
    syncing = true;
    status.value = retryCount.value ? "reconnecting" : cursor.value === INITIAL_CURSOR ? "connecting" : "catching_up";
    try {
      const result = await client.catchUp(cursor.value);
      cursor.value = result.cursor;
      window.sessionStorage.setItem(storageKey(), cursor.value);
      lastSyncedAt.value = result.serverTime;
      retryCount.value = 0;
      status.value = "synced";
      publish(result.events);
      schedule(document.hidden ? HIDDEN_INTERVAL_MS : BASE_INTERVAL_MS);
    } catch (reason) {
      const apiError = toApiError(reason);
      if (apiError.code === "INVALID_SYNC_CURSOR") {
        cursor.value = INITIAL_CURSOR;
        window.sessionStorage.removeItem(storageKey());
        retryCount.value = 0;
        status.value = "connecting";
        schedule(0);
        return;
      }
      retryCount.value += 1;
      status.value = navigator.onLine ? "reconnecting" : "offline";
      schedule(BACKOFF_MS[Math.min(retryCount.value - 1, BACKOFF_MS.length - 1)] || 30_000);
    } finally {
      syncing = false;
    }
  }

  function start(): void {
    if (running.value || env.realtimeMode === "off") return;
    running.value = true;
    cursor.value = window.sessionStorage.getItem(storageKey()) || INITIAL_CURSOR;
    status.value = navigator.onLine ? "connecting" : "offline";
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    document.addEventListener("visibilitychange", handleVisibility);
    void syncNow();
  }

  function stop(): void {
    running.value = false;
    if (timer) window.clearTimeout(timer);
    if (updatePulse) window.clearTimeout(updatePulse);
    timer = null;
    updatePulse = null;
    window.removeEventListener("online", handleOnline);
    window.removeEventListener("offline", handleOffline);
    document.removeEventListener("visibilitychange", handleVisibility);
  }

  function handleOnline(): void {
    status.value = "reconnecting";
    void syncNow();
  }

  function handleOffline(): void {
    status.value = "offline";
  }

  function handleVisibility(): void {
    if (!document.hidden) void syncNow();
  }

  return {
    status,
    label,
    isHealthy,
    cursor,
    lastSyncedAt,
    retryCount,
    lastEventCount,
    dataUpdated,
    running,
    start,
    stop,
    syncNow
  };
});
