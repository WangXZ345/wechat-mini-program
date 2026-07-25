import { describe, expect, it } from "vitest";
import { CursorSyncClient } from "./cursor-sync";
import type { SyncBatch } from "@/types/realtime";

describe("CursorSyncClient", () => {
  it("catches up paginated events in order", async () => {
    const batches: SyncBatch[] = [
      {
        events: [{ eventId: "e1", eventType: "product.updated", entityType: "product", entityId: "p1", action: "updated", version: 1, changedFields: ["name"], sourceClient: "mock", createdAt: "2026-07-11T00:00:00.000Z", cursor: "1" }],
        nextCursor: "1",
        hasMore: true,
        serverTime: "2026-07-11T00:00:01.000Z"
      },
      {
        events: [{ eventId: "e2", eventType: "inventory.changed", entityType: "inventory", entityId: "p1", action: "changed", version: 2, changedFields: ["stock"], sourceClient: "mock", createdAt: "2026-07-11T00:00:02.000Z", cursor: "2" }],
        nextCursor: "2",
        hasMore: false,
        serverTime: "2026-07-11T00:00:03.000Z"
      }
    ];
    const source = { catchUp: async () => batches.shift()! };
    const result = await new CursorSyncClient(source).catchUp("0");
    expect(result.events.map((event) => event.eventId)).toEqual(["e1", "e2"]);
    expect(result.cursor).toBe("2");
  });

  it("keeps automatic order-review events readable as system activity", async () => {
    const batch: SyncBatch = {
      events: [{
        eventId: "auto_order_state:opaque",
        eventType: "order.status_changed",
        entityType: "order",
        entityId: "order-1",
        action: "manual_review_required",
        version: 3,
        changedFields: ["status", "updatedAt", "version"],
        actorType: "system",
        sourceClient: "system",
        createdAt: "2026-07-23T08:00:00.000Z"
      }],
      nextCursor: "v3.opaque",
      hasMore: false,
      serverTime: "2026-07-23T08:00:01.000Z"
    };
    const result = await new CursorSyncClient({
      catchUp: async () => batch
    }).catchUp();

    expect(result.events).toEqual(batch.events);
    expect(result.events[0]).toMatchObject({
      eventType: "order.status_changed",
      action: "manual_review_required",
      actorType: "system",
      sourceClient: "system"
    });
  });
});
