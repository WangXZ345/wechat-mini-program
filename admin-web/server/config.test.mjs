import assert from "node:assert/strict";
import test from "node:test";
import { loadGatewayConfig } from "./config.mjs";

const baseEnv = {
  PORT: "8080",
  ADMIN_WEB_DIST_DIR: "/app/dist",
  ADMIN_WEB_PUBLIC_ORIGIN: "https://example.zconnect.cn",
  ADMIN_WEB_BFF_TARGET: "https://cloud1-d7g4mbc5r2fac4a77-1440838049.ap-shanghai.app.tcloudbase.com",
  ADMIN_WEB_ACTION_SECRET_FILE: "/run/secrets/admin_web_action_secret",
  ADMIN_WEB_UPSTREAM_TIMEOUT_MS: "55000"
};

test("loads a normalized production gateway configuration", () => {
  const config = loadGatewayConfig(baseEnv, () => `${"s".repeat(32)}\n`);
  assert.equal(config.port, 8080);
  assert.equal(config.publicOrigin, "https://example.zconnect.cn");
  assert.equal(config.upstream.origin, baseEnv.ADMIN_WEB_BFF_TARGET);
  assert.equal(config.actionSecret, "s".repeat(32));
  assert.equal(config.upstreamTimeoutMs, 55000);
});

for (const value of [
  "https://production.example.com",
  "https://third-party.example.com",
  `${baseEnv.ADMIN_WEB_BFF_TARGET}/unexpected-path`
]) {
  test(`rejects a BFF target outside the exact test gateway contract: ${value}`, () => {
    assert.throws(
      () => loadGatewayConfig({ ...baseEnv, ADMIN_WEB_BFF_TARGET: value }, () => "s".repeat(32)),
      /ADMIN_WEB_BFF_TARGET/
    );
  });
}

for (const value of [
  "http://example.zconnect.cn",
  "https://user:pass@example.zconnect.cn",
  "https://example.zconnect.cn/path",
  "https://example.zconnect.cn?x=1",
  "https://example.zconnect.cn#x"
]) {
  test(`rejects invalid public origin ${value}`, () => {
    assert.throws(
      () => loadGatewayConfig({ ...baseEnv, ADMIN_WEB_PUBLIC_ORIGIN: value }, () => "s".repeat(32)),
      /ADMIN_WEB_PUBLIC_ORIGIN/
    );
  });
}

test("rejects missing or short action secret", () => {
  assert.throws(() => loadGatewayConfig(baseEnv, () => "short"), /action secret/i);
});

for (const controlCharacter of ["\t", "\v", "\x7f"]) {
  test(`rejects action secrets containing control character ${JSON.stringify(controlCharacter)}`, () => {
    const secret = `${"s".repeat(16)}${controlCharacter}${"s".repeat(16)}`;
    assert.throws(() => loadGatewayConfig(baseEnv, () => secret), /action secret/i);
  });
}
