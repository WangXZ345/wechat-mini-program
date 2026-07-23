import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadGatewayConfig } from "./config.mjs";
import { createAdminWebServer } from "./server.mjs";

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

export function startAdminWebGateway(config, dependencies = {}) {
  const host = dependencies.host || "0.0.0.0";
  const runtime = dependencies.runtime || process;
  const server = dependencies.server || createAdminWebServer(config);
  const shutdownTimeoutMs = dependencies.shutdownTimeoutMs
    ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  let forceTimer;
  let shuttingDown = false;
  let started = false;

  const signalHandlers = new Map();
  const removeRuntimeListeners = () => {
    for (const [signal, handler] of signalHandlers) {
      runtime.removeListener(signal, handler);
    }
    signalHandlers.clear();
  };
  const completeShutdown = (error, exitCode) => {
    if (forceTimer) clearTimeout(forceTimer);
    forceTimer = undefined;
    removeRuntimeListeners();
    if (error) {
      runtime.stderr.write("admin-web gateway shutdown failed.\n");
      runtime.exitCode = 1;
      return;
    }
    runtime.exitCode = exitCode;
  };
  const shutdown = (exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      server.close((error) => completeShutdown(error, exitCode));
      server.closeIdleConnections?.();
      forceTimer = setTimeout(() => {
        server.closeAllConnections?.();
      }, shutdownTimeoutMs);
      forceTimer.unref?.();
    } catch {
      completeShutdown(new Error("server close failed"), exitCode);
    }
  };
  const onServerError = () => {
    runtime.stderr.write(
      started
        ? "admin-web gateway server error.\n"
        : "admin-web gateway failed to listen.\n"
    );
    runtime.exitCode = 1;
    if (server.listening) shutdown(1);
    else removeRuntimeListeners();
  };

  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = () => shutdown(0);
    signalHandlers.set(signal, handler);
    runtime.on(signal, handler);
  }
  server.once("error", onServerError);
  server.listen(config.port, host, () => {
    started = true;
    runtime.stdout.write(`admin-web gateway listening on ${config.port}\n`);
  });
  return server;
}

function main() {
  let config;
  try {
    config = loadGatewayConfig();
  } catch {
    process.stderr.write("admin-web gateway configuration failed.\n");
    process.exitCode = 1;
    return;
  }
  startAdminWebGateway(config);
}

if (
  process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main();
}
