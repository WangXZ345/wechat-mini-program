"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createCleanupCore } = require("./cleanupCore");

function database(initial) {
  const records = new Map(initial.map((record) => [record._id, structuredClone(record)]));
  function collection() {
    return {
      doc(id) {
        return {
          async get() {
            return { data: records.has(id) ? structuredClone(records.get(id)) : null };
          },
          async update({ data }) {
            records.set(id, { ...records.get(id), ...structuredClone(data), _id: id });
          },
          async remove() {
            records.delete(id);
          }
        };
      }
    };
  }
  return {
    serverDate: () => new Date("2026-08-09T00:00:00.000Z"),
    collection,
    async runTransaction(executor) {
      return executor({ collection });
    },
    replace(record) {
      records.set(record._id, structuredClone(record));
    },
    snapshot(id) {
      return records.has(id) ? structuredClone(records.get(id)) : null;
    }
  };
}

const cutoff = new Date("2026-08-08T23:30:00.000Z");

function processing(overrides = {}) {
  return {
    _id: "idem-1",
    status: "processing",
    executionLeaseDigest: "lease-a",
    executionAttempt: 1,
    lockedAt: new Date("2026-08-08T23:00:00.000Z"),
    updatedAt: new Date("2026-08-08T23:00:00.000Z"),
    createdAt: new Date("2026-08-08T23:00:00.000Z"),
    ...overrides
  };
}

test("cleanup cannot overwrite a success committed after its stale query", async () => {
  const candidate = processing();
  const db = database([candidate]);
  db.replace({ ...candidate, status: "success", finishedAt: new Date("2026-08-08T23:31:00.000Z") });
  const core = createCleanupCore({ db });

  assert.equal(await core.markExpired([candidate], "TIMEOUT", "timeout", cutoff), 0);
  assert.equal(db.snapshot("idem-1").status, "success");
});

test("cleanup compares lease, attempt, status, and cutoff inside the transaction", async () => {
  const candidate = processing();
  const db = database([candidate]);
  const core = createCleanupCore({ db });

  db.replace(processing({ executionLeaseDigest: "lease-b", executionAttempt: 2 }));
  assert.equal(await core.markExpired([candidate], "TIMEOUT", "timeout", cutoff), 0);
  assert.equal(db.snapshot("idem-1").status, "processing");

  const current = processing({ executionLeaseDigest: "lease-b", executionAttempt: 2 });
  assert.equal(await core.markExpired([current], "TIMEOUT", "timeout", cutoff), 1);
  assert.equal(db.snapshot("idem-1").status, "expired");
});

test("cleanup removal cannot delete a record that became processing after the query", async () => {
  const candidate = processing({ status: "expired", expiresAt: new Date("2026-08-08T22:00:00.000Z") });
  const db = database([candidate]);
  db.replace(processing({ executionLeaseDigest: "lease-b", executionAttempt: 2 }));
  const core = createCleanupCore({ db });

  assert.equal(await core.removeExpired([candidate], new Date("2026-08-09T00:00:00.000Z")), 0);
  assert.equal(db.snapshot("idem-1").status, "processing");
});
