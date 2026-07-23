import { readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

const TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
  [".woff2", "font/woff2"]
]);

function badRequest(response) {
  response.writeHead(400, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  response.end("Bad Request");
}

function notFound(response) {
  response.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  response.end("Not Found");
}

function decodePathname(pathname) {
  let decoded = pathname;
  for (;;) {
    const next = decodeURIComponent(decoded);
    if (next === decoded) return next;
    decoded = next;
  }
}

function isApiPath(pathname) {
  return pathname === "/api/admin/v1" || pathname.startsWith("/api/admin/v1/");
}

function isSafePath(pathname) {
  return pathname.startsWith("/") && !pathname.includes("\0") && !pathname.split(/[\\/]/).includes("..");
}

function isInside(root, candidate) {
  const difference = relative(root, candidate);
  return difference === "" || (difference !== ".." && !difference.startsWith(`..${sep}`) && !isAbsolute(difference));
}

async function fileInsideRoot(path, realRoot) {
  try {
    const realFile = await realpath(path);
    return isInside(realRoot, realFile) && (await stat(realFile)).isFile() ? realFile : null;
  } catch {
    return null;
  }
}

export function createStaticHandler({ distDir }) {
  const root = resolve(distDir);
  const realRoot = realpath(root).catch(() => null);

  return async function staticHandler(request, response) {
    const rawPathname = String(request.url || "/").split("?", 1)[0];
    let pathname;
    try {
      pathname = decodePathname(rawPathname);
    } catch {
      badRequest(response);
      return true;
    }

    if (!isSafePath(pathname)) {
      badRequest(response);
      return true;
    }
    if (isApiPath(pathname)) return false;
    if (pathname === "/healthz") {
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8"
      });
      response.end(request.method === "HEAD" ? undefined : '{"ok":true}');
      return true;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { allow: "GET, HEAD", "cache-control": "no-store" });
      response.end();
      return true;
    }

    const requested = resolve(root, `.${pathname}`);
    if (requested !== root && !requested.startsWith(`${root}${sep}`)) {
      badRequest(response);
      return true;
    }
    const physicalRoot = await realRoot;
    if (!physicalRoot) {
      notFound(response);
      return true;
    }
    const requestedFile = await fileInsideRoot(requested, physicalRoot);
    const file = requestedFile || (pathname.startsWith("/assets/") ? null : await fileInsideRoot(resolve(root, "index.html"), physicalRoot));
    if (!file) {
      notFound(response);
      return true;
    }

    let body;
    if (request.method === "GET") {
      try {
        body = await readFile(file);
      } catch {
        notFound(response);
        return true;
      }
    }
    const isAsset = file.startsWith(`${physicalRoot}${sep}assets${sep}`);
    response.writeHead(200, {
      "cache-control": isAsset ? "public, max-age=31536000, immutable" : "no-store",
      "content-type": TYPES.get(extname(file).toLowerCase()) || "application/octet-stream"
    });
    response.end(body);
    return true;
  };
}
