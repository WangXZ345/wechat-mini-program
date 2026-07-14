export type SyncConnectionStatus =
  | "connecting"
  | "catching_up"
  | "synced"
  | "offline"
  | "reconnecting";

export interface SyncEvent {
  eventId: string;
  eventType: string;
  entityType: string;
  entityId: string;
  action: string;
  version: number;
  changedFields: string[];
  sourceClient: "miniprogram" | "admin_web" | "mock";
  createdAt: string;
  cursor?: string;
}

export interface SyncBatch {
  events: SyncEvent[];
  nextCursor: string;
  hasMore: boolean;
  serverTime: string;
}
