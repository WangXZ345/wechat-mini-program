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
  const runtimeStage = dockerfile.split(/^FROM node:20-alpine AS runtime$/m)[1];

  assert.match(dockerfile, /^FROM node:20-alpine AS build$/m);
  assert.match(dockerfile, /^COPY package\.json package-lock\.json \.\/$/m);
  assert.match(dockerfile, /RUN npm ci/);
  assert.match(dockerfile, /RUN npm run test:gateway && npm run build/);
  assert.match(dockerfile, /^FROM node:20-alpine AS runtime$/m);
  assert.match(dockerfile, /COPY --from=build --chown=node:node \/app\/dist \.\/dist/);
  assert.ok(runtimeStage, "missing runtime stage");
  for (const module of [
    "config.mjs",
    "static-handler.mjs",
    "proxy-handler.mjs",
    "server.mjs",
    "index.mjs",
  ]) {
    assert.match(
      runtimeStage,
      new RegExp(`^COPY --from=build --chown=node:node /app/server/${module} /app/server/${module}$`, "m"),
    );
  }
  assert.doesNotMatch(
    runtimeStage,
    /^COPY --from=build --chown=node:node \/app\/server\s+(?:\.\/)?server\/?$/m,
  );
  assert.doesNotMatch(runtimeStage, /\.test\.mjs|container-contract\.test\.mjs/);
  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerfile, /^EXPOSE 8080$/m);
  assert.match(
    dockerfile,
    /CMD node -e "fetch\('http:\/\/127\.0\.0\.1:8080\/healthz'\)/,
  );
  assert.doesNotMatch(dockerfile, /\bwget\b/);
  assert.match(dockerfile, /CMD \["node", "server\/index\.mjs"\]/);
});

test("container build context excludes local, generated, and secret-bearing files", async () => {
  const dockerignore = await readAdminWebFile(".dockerignore");
  const ignoredEntries = new Set(dockerignore.split(/\r?\n/));

  for (const entry of [
    ".git",
    ".env",
    ".env.*.local",
    ".env.*",
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
  assert.ok(ignoredEntries.has("!.env.test"), "must retain the public .env.test file");
});

test("ZSpace Compose uses public configuration and mounts the action secret read-only", async () => {
  const [compose, envExample] = await Promise.all([
    readAdminWebFile("docker-compose.zspace.yml"),
    readAdminWebFile("zspace.env.example"),
  ]);

  assert.match(compose, /^services:\n {2}admin-web:\n/m);
  assert.match(compose, /^ {4}restart: unless-stopped$/m);
  assert.match(compose, /^ {6}- "18080:8080"$/m);
  assert.match(compose, /^ {6}ADMIN_WEB_PUBLIC_ORIGIN: \$\{ADMIN_WEB_PUBLIC_ORIGIN\}$/m);
  assert.match(compose, /^ {6}ADMIN_WEB_BFF_TARGET: \$\{ADMIN_WEB_BFF_TARGET\}$/m);
  assert.match(compose, /^ {6}ADMIN_WEB_ACTION_SECRET_FILE: \/run\/secrets\/admin_web_action_secret$/m);
  assert.match(
    compose,
    /^ {4}secrets:\n {6}- source: admin_web_action_secret\n {8}target: admin_web_action_secret\n {8}mode: 0444$/m,
  );
  assert.match(
    compose,
    /^secrets:\n {2}admin_web_action_secret:\n {4}file: \.\/secrets\/admin_web_action_secret$/m,
  );
  assert.match(compose, /^ {4}read_only: true$/m);
  assert.match(compose, /^ {4}tmpfs:\n {6}- \/tmp$/m);
  assert.match(compose, /^ {4}security_opt:\n {6}- no-new-privileges:true$/m);
  assert.match(compose, /^ {4}cap_drop:\n {6}- ALL$/m);
  assert.match(
    compose,
    /^ {6}test: \["CMD", "node", "-e", "fetch\('http:\/\/127\.0\.0\.1:8080\/healthz'\)/m,
  );
  assert.doesNotMatch(compose, /^ {4}volumes:/m);
  assert.doesNotMatch(compose, /^\s*ADMIN_WEB_ACTION_SECRET:\s*/m);
  assert.doesNotMatch(compose, /\bwget\b/);
  assert.match(envExample, /ADMIN_WEB_PUBLIC_ORIGIN=https:\/\/bootstrap\.invalid/);
  assert.match(envExample, new RegExp(`ADMIN_WEB_BFF_TARGET=${expectedBffTarget.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}`));
});
