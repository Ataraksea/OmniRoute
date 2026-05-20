/**
 * Copy .next/standalone into app/ for local CLI (bin/omniroute.mjs serve).
 * Mirrors the critical post-build steps from prepublish.ts.
 */

import fs from "node:fs";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const HASH_RE = /(['"\\])([a-z@][a-z0-9@./_-]+?-[0-9a-f]{16}(?:\/[^'"\\]+)?)\1/g;

function walkJsFiles(dir, visitor) {
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    try {
      const st = statSync(full);
      if (st.isDirectory()) {
        walkJsFiles(full, visitor);
        continue;
      }
      if (!entry.endsWith(".js")) continue;
      visitor(full);
    } catch {
      /* skip unreadable */
    }
  }
}

function stripHashedExternals(serverDir, log) {
  if (!existsSync(serverDir)) return { patchedFiles: 0, patchedMatches: 0 };

  let patchedFiles = 0;
  let patchedMatches = 0;

  walkJsFiles(serverDir, (filePath) => {
    const src = readFileSync(filePath, "utf8");
    let count = 0;
    const patched = src.replace(HASH_RE, (_, q, name) => {
      const base = name.replace(/-[0-9a-f]{16}(?=\/|$)/, "");
      count++;
      return `${q}${base}${q}`;
    });
    if (count > 0) {
      writeFileSync(filePath, patched);
      patchedFiles++;
      patchedMatches += count;
    }
  });

  if (patchedMatches > 0) {
    log.log(
      `[publish-standalone-app] Hash-strip: patched ${patchedMatches} hashed require() in ${patchedFiles} file(s)`
    );
  }

  return { patchedFiles, patchedMatches };
}

function sanitizeBuildMachinePaths(appDir, buildRoot, log) {
  const buildRootNorm = buildRoot.replace(/\\/g, "/");
  const targets = [join(appDir, "server.js"), join(appDir, ".next", "required-server-files.json")];
  let sanitisedCount = 0;

  for (const filePath of targets) {
    if (!existsSync(filePath)) continue;
    let content = readFileSync(filePath, "utf8");
    const escaped = buildRootNorm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(escaped, "g");
    const matches = content.match(re);
    if (matches) {
      content = content.replace(re, ".");
      writeFileSync(filePath, content);
      sanitisedCount += matches.length;
    }
  }

  if (sanitisedCount > 0) {
    log.log(`[publish-standalone-app] Sanitised ${sanitisedCount} hardcoded path reference(s)`);
  }
}

/**
 * @param {string} rootDir - Repository root
 * @param {{ log?: Console }} [options]
 * @returns {{ appDir: string; serverJs: string }}
 */
export function publishStandaloneToApp(rootDir, options = {}) {
  const log = options.log ?? console;
  const standaloneDir = join(rootDir, ".next", "standalone");
  const appDir = join(rootDir, "app");
  const serverJs = join(standaloneDir, "server.js");

  if (!existsSync(serverJs)) {
    throw new Error(`Standalone build not found at ${standaloneDir}. Run npm run build first.`);
  }

  log.log("[publish-standalone-app] Copying standalone output to app/...");
  if (existsSync(appDir)) {
    fs.rmSync(appDir, { recursive: true, force: true });
  }
  mkdirSync(appDir, { recursive: true });
  cpSync(standaloneDir, appDir, { recursive: true });

  const standaloneWsSrc = join(rootDir, "scripts", "dev", "standalone-server-ws.mjs");
  const responsesWsProxySrc = join(rootDir, "scripts", "dev", "responses-ws-proxy.mjs");
  if (existsSync(standaloneWsSrc) && existsSync(responsesWsProxySrc)) {
    log.log("[publish-standalone-app] Adding Responses WebSocket standalone wrapper...");
    cpSync(standaloneWsSrc, join(appDir, "server-ws.mjs"));
    writeFileSync(
      join(appDir, "responses-ws-proxy.mjs"),
      'export * from "../scripts/dev/responses-ws-proxy.mjs";\n'
    );
  }

  const staticChunksSrc = join(rootDir, ".next", "server", "chunks");
  const staticChunksDest = join(appDir, ".next", "server", "chunks");
  if (existsSync(staticChunksSrc)) {
    log.log("[publish-standalone-app] Patching missing Turbopack server chunks...");
    mkdirSync(staticChunksDest, { recursive: true });
    cpSync(staticChunksSrc, staticChunksDest, { recursive: true, force: true });
  }

  sanitizeBuildMachinePaths(appDir, rootDir, log);
  stripHashedExternals(join(appDir, ".next", "server"), log);

  log.log(`[publish-standalone-app] Ready: ${join(appDir, "server.js")}`);
  return { appDir, serverJs: join(appDir, "server.js") };
}
