import type { AdminTransport } from "@/types/api";
import type { SyncBatch, SyncEvent } from "@/types/realtime";

export interface SyncTransport {
  catchUp(cursor?: string): Promise<SyncBatch>;
}

export class CursorSyncClient {
  constructor(private readonly source: Pick<AdminTransport, "catchUp">) {}

  async catchUp(cursor?: string): Promise<{ events: SyncEvent[]; cursor: string; serverTime: string }> {
    const events: SyncEvent[] = [];
    let current = cursor;
    let serverTime = new Date().toISOString();
    for (let page = 0; page < 10; page += 1) {
      const batch = await this.source.catchUp(current);
      events.push(...batch.events);
      current = batch.nextCursor;
      serverTime = batch.serverTime;
      if (!batch.hasMore) break;
    }
    return { events, cursor: current || cursor || "", serverTime };
  }
}
