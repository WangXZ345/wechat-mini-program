"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const security = require("../security");
const api = require("../index");

const csrf = "csrf-order-note-token";
function auth(permissions = ["order:edit_remark"]) { return { principal: { id: "admin-1", role: "customer_service", status: "active", isActive: true, permissions }, rawAdmin: { _id: "admin-1", openid: "private-openid" }, session: { csrfTokenHash: security.tokenHash(csrf, "p".repeat(32)) } }; }
function request(body = { id: "order-1", content: "跟进备注", expectedVersion: 3 }) { return { route: { action: "mutate", resource: "orders", mutationAction: "remark" }, body, headers: { "x-admin-csrf": csrf, "idempotency-key": "note-route-key-1" }, http: true, requestId: "request-note-route" }; }

test("orders/remark strict route validates, derives actor, and returns the note mutation envelope", async () => {
  assert.equal(typeof api._test.normalizeOrderNoteMutation, "function");
  const normalized = api._test.normalizeOrderNoteMutation(request());
  assert.deepEqual(normalized.input, { orderId: "order-1", content: "跟进备注", expectedVersion: 3 });
  assert.deepEqual(api._test.normalizeOrderNoteMutation(request({ id: "order-1", content: `  ${"x".repeat(500)}  `, expectedVersion: 0 })).input, { orderId: "order-1", content: "x".repeat(500), expectedVersion: 0 });
  for (const body of [{ id: "order-1", content: "", expectedVersion: 3 }, { id: "order-1", content: `  ${"x".repeat(501)}  `, expectedVersion: 3 }, { id: "order-1", content: "ok", expectedVersion: 3, unexpected: true }, { id: "order-1", content: "ok", expectedVersion: "3" }]) {
    assert.throws(() => api._test.normalizeOrderNoteMutation(request(body)));
  }
  const output = await api._test.dispatch(request(), auth(), { tokenPepper: "p".repeat(32) }, { orderNoteService: { async appendNote(command) { assert.equal(command.actor.openid, "private-openid"); return { note: { id: "note-1", content: "跟进备注", authorId: "admin-1", authorRole: "customer_service", authorName: "", createdAt: "2026-08-15T00:00:00.000Z" }, version: 4, updatedAt: "2026-08-15T00:00:00.000Z", changed: true, reused: false }; } } });
  assert.deepEqual(output, { affected: 1, item: { id: "order-1", note: { id: "note-1", content: "跟进备注", authorId: "admin-1", authorRole: "customer_service", authorName: "", createdAt: "2026-08-15T00:00:00.000Z" }, version: 4, updatedAt: "2026-08-15T00:00:00.000Z" }, message: "订单内部备注已保存", requestId: "request-note-route" });
});

test("orders/remark admits super_admin and wildcard permission while mapping service failures safely", async () => {
  const service = { async appendNote() { throw Object.assign(new Error("private transport detail"), { code: "UNEXPECTED" }); } };
  for (const permissions of [[], ["*"]]) {
    const principal = permissions.length ? auth(permissions) : auth([]);
    if (!permissions.length) principal.principal.role = "super_admin";
    await assert.rejects(
      () => api._test.dispatch(request(), principal, { tokenPepper: "p".repeat(32) }, { orderNoteService: service }),
      (reason) => reason.code === "ORDER_NOTE_FAILED" && reason.statusCode === 502 && !reason.message.includes("private")
    );
  }
});

test("orders/remark checks permission and csrf before service", async () => {
  let calls = 0;
  const dependencies = { orderNoteService: { async appendNote() { calls += 1; } } };
  await assert.rejects(() => api._test.dispatch(request(), auth([]), { tokenPepper: "p".repeat(32) }, dependencies), (reason) => reason.code === "FORBIDDEN");
  await assert.rejects(() => api._test.dispatch({ ...request(), headers: { "x-admin-csrf": "bad", "idempotency-key": "note-route-key-1" } }, auth(), { tokenPepper: "p".repeat(32) }, dependencies), (reason) => reason.code === "CSRF_VALIDATION_FAILED");
  assert.equal(calls, 0);
});

test("orders/remark supplies a bounded admin display name but never treats openid as a name", async () => {
  const received = [];
  const service = {
    async appendNote(command) {
      received.push(command.actor);
      return { note: { id: `note-${received.length}`, content: command.input.content, authorId: command.actor.id, authorRole: command.actor.role, authorName: command.actor.name || "", createdAt: "2026-08-15T00:00:00.000Z" }, version: 4, updatedAt: "2026-08-15T00:00:00.000Z", changed: true, reused: false };
    }
  };
  const named = auth();
  named.rawAdmin.name = "  安全客服  ";
  await api._test.dispatch(request(), named, { tokenPepper: "p".repeat(32) }, { orderNoteService: service });
  const unnamed = auth();
  await api._test.dispatch(request(), unnamed, { tokenPepper: "p".repeat(32) }, { orderNoteService: service });
  assert.equal(received[0].name, "安全客服");
  assert.equal(received[1].name, "");
  assert.equal(received.some((actor) => actor.name === "private-openid"), false);
});
