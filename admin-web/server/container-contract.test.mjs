import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const adminWebDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const expectedBffTarget =
  "https://cloud1-d7g4mbc5r2fac4a77-1440838049.ap-shanghai.app.tcloudbase.com";

async function readAdminWebFile(name) {
  return readFile(path.join(adminWebDir, name), "utf8");
}

test("container package builds the real gateway into a non-root runtime image", async () => {
  const dockerfile = await readAdminWebFile("Dockerfile");

  assert.match(dockerfile, /^FROM node:20-alpine AS build$/m);
  assert.match(dockerfile, /RUN npm ci/);
  assert.match(dockerfile, /RUN npm run test:gateway && npm run build/);
  assert.match(dockerfile, /^FROM node:20-alpine AS runtime$/m);
  assert.match(dockerfile, /COPY --from=build --chown=node:node \/app\/dist \.\/dist/);
  assert.match(dockerfile, /COPY --from=build --chown=node:node \/app\/server \.\/server/);
  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerfile, /^EXPOSE 8080$/m);
  assert.match(dockerfile, /http:\/\/127\.0\.0\.1:8080\/healthz/);
  assert.match(dockerfile, /CMD \["node", "server\/index\.mjs"\]/);
});

test("container build context excludes local, generated, and secret-bearing files", async () => {
  const dockerignore = await readAdminWebFile(".dockerignore");
  const ignoredEntries = new Set(dockerignore.split(/\r?\n/));

  for (const entry of [
    ".git",
    ".env",
    ".env.*.local",
    "node_modules",
    "dist",
    "coverage",
    "playwright-report",
    "test-results",
    ".tooling",
    "*.log",
    "secrets",
    "docker-compose*.local.yml",
  ]) {
    assert.ok(ignoredEntries.has(entry), `missing .dockerignore entry: ${entry}`);
  }
  assert.doesNotMatch(dockerignore, /^\.env\.test$/m);
});

test("ZSpace Compose uses public configuration and mounts the action secret read-only", async () => {
  const [compose, envExample] = await Promise.all([
    readAdminWebFile("docker-compose.zspace.yml"),
    readAdminWebFile("zspace.env.example"),
  ]);

  assert.match(compose, /^\s{4}restart: unless-stopped$/m);
  assert.match(compose, /- "18080:8080"/);
  assert.match(compose, /ADMIN_WEB_PUBLIC_ORIGIN: \$\{ADMIN_WEB_PUBLIC_ORIGIN\}/);
  assert.match(compose, /ADMIN_WEB_BFF_TARGET: \$\{ADMIN_WEB_BFF_TARGET\}/);
  assert.match(compose, /ADMIN_WEB_ACTION_SECRET_FILE: \/run\/secrets\/admin_web_action_secret/);
  assert.match(compose, /\.\/secrets\/admin_web_action_secret:\/run\/secrets\/admin_web_action_secret:ro/);
  assert.doesNotMatch(compose, /^\s*ADMIN_WEB_ACTION_SECRET:\s*/m);
  assert.match(envExample, /ADMIN_WEB_PUBLIC_ORIGIN=https:\/\/bootstrap\.invalid/);
  assert.match(envExample, new RegExp(`ADMIN_WEB_BFF_TARGET=${expectedBffTarget.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}`));
});
