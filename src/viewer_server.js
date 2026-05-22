const fs = require("fs");
const fsp = require("fs/promises");
const http = require("http");
const path = require("path");
const { analyzeMapFile } = require("./cbe_maptrace");
const { createInitialState, frameFromState, stepState } = require("./cbe_emulator");
const { buildRuntimeScene, buildRuntimeSceneFromCore } = require("./cbe_runtime");
const { buildResourceProfile } = require("./cbe_profile");
const { CbeRuntimeCore } = require("./cbe_runtime_core");
const { summarizeBuffer, summarizeFile } = require("./cbe_struct");
const { buildTrueRuntime } = require("./cbe_true_runtime");
const { DEFAULT_INPUT: DEFAULT_CBE_INPUT } = require("./cbe_unpack");
const { buildWireProbe } = require("./cbe_xse_wire_probe");

const ROOT = process.cwd();
const VIEWER_DIR = path.join(ROOT, "viewer");
const DEFAULT_BATCH_DIR = path.join(ROOT, "out_batch");
const XSE_READER_SERVICE_JSON = path.join(ROOT, "out_godwar_xsereader", "xse_reader_service_trace.json");
const XSE_VM_GATE_JSON = path.join(ROOT, "out_godwar_xsevmgate", "xse_vm_gate_probe.json");
const PORT = Number(process.env.PORT || 4173);
const runtimeCoreCache = new Map();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".gif": "image/gif",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

function send(res, status, body, type = "text/plain; charset=utf-8") {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(status, {
    "Content-Type": type,
    "Content-Length": data.length,
    "Cache-Control": "no-store",
  });
  res.end(data);
}

function sendJson(res, value) {
  send(res, 200, JSON.stringify(value), "application/json; charset=utf-8");
}

function safeInside(base, target) {
  const rel = path.relative(base, target);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function cleanRel(rel) {
  return String(rel || "").replace(/\\/g, "/").replace(/^\/+/, "");
}

function asUrlPath(file) {
  return file.split(path.sep).join("/");
}

function resolveManifestOutput(root, output) {
  const literal = path.resolve(output || "");
  const normalized = String(output || "").replace(/\\/g, "/");
  const escapedRootName = path.basename(root).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const markers = [
    new RegExp(`/${escapedRootName}/`, "i"),
    /\/out_batch\/[^/]+\//i,
  ];
  for (const marker of markers) {
    const match = normalized.match(marker);
    if (!match) continue;
    const suffix = normalized.slice(match.index + match[0].length).split("/");
    const candidate = path.join(root, ...suffix);
    if (fs.existsSync(candidate)) return candidate;
  }
  return literal;
}

async function readJson(file) {
  return JSON.parse(await fsp.readFile(file, "utf8"));
}

async function fileExists(file) {
  try {
    await fsp.access(file);
    return true;
  } catch {
    return false;
  }
}

function extOf(name) {
  const ext = path.extname(name || "").toLowerCase();
  return ext || "(none)";
}

function rawCbeNameFromRel(rel) {
  return path.basename(cleanRel(rel)).replace(/^[0-9]{4}_/, "");
}

function getRuntimeCore(input) {
  const resolved = path.resolve(input || DEFAULT_CBE_INPUT);
  const cached = runtimeCoreCache.get(resolved);
  if (cached) return cached;
  const core = new CbeRuntimeCore({ input: resolved });
  runtimeCoreCache.set(resolved, core);
  return core;
}

function defaultCoreScene(core) {
  const firstScene = core.listResources({ ext: ".sce", limit: 1 })[0] || null;
  if (!firstScene) throw new Error("Raw CBE has no .sce scene resource");
  return firstScene.rel || firstScene.name;
}

function gameNameFromBatchItem(item) {
  if (item?.output) return path.basename(item.output);
  return path.basename(item?.file || "unknown", path.extname(item?.file || ""));
}

function resolveBatchGameRoot(batchDir, item) {
  const gameName = gameNameFromBatchItem(item);
  const localRoot = path.join(batchDir, gameName);
  if (fs.existsSync(path.join(localRoot, "manifest.json"))) return localRoot;
  return item.output || localRoot;
}

function classify(ext) {
  if ([".gif", ".png", ".jpg", ".jpeg", ".bmp", ".webp"].includes(ext)) return "image";
  if ([".sce", ".map", ".actor", ".xse", ".dat", ".sav"].includes(ext)) return "data";
  if ([".txt", ".ini", ".json", ".xml", ".csv"].includes(ext)) return "text";
  return "other";
}

function parseActions(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildEmulatorResponse(runtime, actions, schema = "nicai.cbe.emulatorResponse.v1") {
  let state = createInitialState(runtime);
  const frames = [{ state, frame: frameFromState(runtime, state) }];
  for (const action of actions) {
    state = stepState(runtime, state, { action });
    frames.push({ action, state, frame: frameFromState(runtime, state) });
  }
  return {
    schema,
    runtime,
    state,
    frame: frameFromState(runtime, state),
    frames,
  };
}

function publicEntry(gameName, gameRoot, file) {
  const output = resolveManifestOutput(gameRoot, file.output);
  const rel = asUrlPath(path.relative(gameRoot, output));
  const ext = extOf(file.name);
  return {
    game: gameName,
    section: file.section,
    index: file.index,
    name: file.name,
    rel,
    ext,
    kind: classify(ext),
    rawSize: file.rawSize || file.size || 0,
    writtenSize: file.writtenSize || file.rawSize || file.size || 0,
    offset: file.offset,
    end: file.end,
    note: file.note || "",
    skipped: file.skipped || "",
  };
}

async function buildIndex(batchDir = DEFAULT_BATCH_DIR) {
  const batchManifest = path.join(batchDir, "batch_manifest.json");
  const batch = await readJson(batchManifest);
  const games = [];

  for (const item of batch) {
    const gameName = gameNameFromBatchItem(item);
    const gameRoot = resolveBatchGameRoot(batchDir, item);
    const record = {
      name: gameName,
      source: item.file,
      output: gameRoot,
      sections: item.sections || 0,
      error: item.error || "",
      files: [],
      extCounts: {},
      kindCounts: {},
      totalBytes: 0,
    };

    const manifestPath = path.join(gameRoot, "manifest.json");
    if (!item.error && await fileExists(manifestPath)) {
      const manifest = await readJson(manifestPath);
      record.sections = manifest.sections.length;
      record.files = manifest.files
        .filter((file) => file.output && !file.skipped)
        .map((file) => publicEntry(gameName, gameRoot, file));
      for (const file of record.files) {
        record.extCounts[file.ext] = (record.extCounts[file.ext] || 0) + 1;
        record.kindCounts[file.kind] = (record.kindCounts[file.kind] || 0) + 1;
        record.totalBytes += file.writtenSize || 0;
      }
      const profile = buildResourceProfile(record.files.map((file) => ({
        name: file.name,
        size: file.rawSize || file.writtenSize || 0,
        offsetHex: file.offset || "",
      })));
      record.profile = {
        capabilities: profile.capabilities,
        flags: profile.flags,
        structuralCounts: profile.structuralCounts,
      };
    }
    games.push(record);
  }

  return {
    root: batchDir,
    generatedAt: new Date().toISOString(),
    games,
  };
}

async function getGameRecord(game) {
  const batch = await readJson(path.join(DEFAULT_BATCH_DIR, "batch_manifest.json"));
  const item = batch.find((entry) => gameNameFromBatchItem(entry) === game);
  if (!item || item.error) throw new Error("Unknown game");

  const root = path.resolve(resolveBatchGameRoot(DEFAULT_BATCH_DIR, item));
  const manifestPath = path.join(root, "manifest.json");
  const manifest = await readJson(manifestPath);
  const files = manifest.files
    .filter((file) => file.output && !file.skipped)
    .map((file) => publicEntry(game, root, file));
  return { item, root, files };
}

async function resolveAsset(game, rel) {
  const { root } = await getGameRecord(game);
  const file = path.resolve(root, cleanRel(rel));
  if (!safeInside(root, file)) throw new Error("Invalid asset path");
  return file;
}

async function resolveAssetWithGame(game, rel) {
  const record = await getGameRecord(game);
  const file = path.resolve(record.root, cleanRel(rel));
  if (!safeInside(record.root, file)) throw new Error("Invalid asset path");
  return { ...record, file };
}

async function serveStatic(reqPath, res) {
  const rel = reqPath === "/" ? "index.html" : cleanRel(reqPath);
  const file = path.resolve(VIEWER_DIR, rel);
  if (!safeInside(VIEWER_DIR, file) && file !== path.join(VIEWER_DIR, "index.html")) {
    send(res, 403, "Forbidden");
    return;
  }
  try {
    const data = await fsp.readFile(file);
    send(res, 200, data, MIME[path.extname(file).toLowerCase()] || "application/octet-stream");
  } catch {
    send(res, 404, "Not found");
  }
}

async function handle(req, res) {
  const parsed = new URL(req.url, "http://127.0.0.1");
  try {
    if (parsed.pathname === "/api/index") {
      sendJson(res, await buildIndex());
      return;
    }

    if (parsed.pathname === "/api/cbe-core") {
      let input = parsed.searchParams.get("input") || undefined;
      if (!input && parsed.searchParams.get("game")) {
        input = (await getGameRecord(parsed.searchParams.get("game"))).item.file;
      }
      const core = getRuntimeCore(input);
      const limit = Math.max(1, Math.min(Number(parsed.searchParams.get("limit") || 80), 500));
      sendJson(res, {
        schema: "nicai.cbe.viewerRuntimeCore.v1",
        generatedAt: new Date().toISOString(),
        source: core.sourceSummary(),
        provider35c4: core.providerObservationSummary(),
        resources: core.listResources({
          ext: parsed.searchParams.get("ext") || "",
          kind: parsed.searchParams.get("kind") || "",
          search: parsed.searchParams.get("search") || "",
          limit,
        }),
      });
      return;
    }

    if (parsed.pathname === "/asset") {
      const file = await resolveAsset(parsed.searchParams.get("game"), parsed.searchParams.get("rel"));
      const data = await fsp.readFile(file);
      send(res, 200, data, MIME[path.extname(file).toLowerCase()] || "application/octet-stream");
      return;
    }

    if (parsed.pathname === "/cbe-asset") {
      const core = getRuntimeCore(parsed.searchParams.get("input") || undefined);
      const name = parsed.searchParams.get("name") || parsed.searchParams.get("rel");
      const entry = core.findResource(name);
      if (!entry) throw new Error(`Raw CBE asset not found: ${name || ""}`);
      const resource = core.readResource(entry, { raw: parsed.searchParams.get("raw") === "1" });
      send(res, 200, resource.fixed, MIME[path.extname(entry.name).toLowerCase()] || "application/octet-stream");
      return;
    }

    if (parsed.pathname === "/api/cbe-bytes") {
      const core = getRuntimeCore(parsed.searchParams.get("input") || undefined);
      const name = parsed.searchParams.get("name") || parsed.searchParams.get("rel");
      const entry = core.findResource(name);
      if (!entry) throw new Error(`Raw CBE resource not found: ${name || ""}`);
      const resource = core.readResource(entry, { raw: parsed.searchParams.get("raw") === "1" });
      const limit = Math.max(1, Math.min(Number(parsed.searchParams.get("limit") || 8192), 262144));
      const bytes = resource.fixed.subarray(0, limit);
      sendJson(res, {
        schema: "nicai.cbe.viewerCoreBytes.v1",
        source: "CbeRuntimeCore.readResource",
        resource: {
          name: resource.name,
          rel: resource.rel,
          ext: resource.ext,
          kind: resource.kind,
          rawSize: resource.rawSize,
          fixedSize: resource.fixed.length,
          fixupNote: resource.fixupNote,
        },
        bytes: Array.from(bytes),
        size: resource.fixed.length,
      });
      return;
    }

    if (parsed.pathname === "/api/cbe-struct") {
      const core = getRuntimeCore(parsed.searchParams.get("input") || undefined);
      const name = parsed.searchParams.get("name") || parsed.searchParams.get("rel");
      const entry = core.findResource(name);
      if (!entry) throw new Error(`Raw CBE resource not found: ${name || ""}`);
      const resource = core.readResource(entry, { raw: parsed.searchParams.get("raw") === "1" });
      sendJson(res, summarizeBuffer(resource.name, resource.fixed, {
        catalog: core.catalog,
        source: "raw-cbe-core",
      }));
      return;
    }

    if (parsed.pathname === "/api/cbe-runtime") {
      let input = parsed.searchParams.get("input") || undefined;
      const game = parsed.searchParams.get("game") || "";
      if (!input && game) {
        input = (await getGameRecord(game)).item.file;
      }
      const core = getRuntimeCore(input);
      const scene = parsed.searchParams.get("scene") || parsed.searchParams.get("name") || parsed.searchParams.get("rel") || defaultCoreScene(core);
      sendJson(res, await buildRuntimeSceneFromCore(core, scene, {
        game: game || undefined,
      }));
      return;
    }

    if (parsed.pathname === "/api/cbe-emulator") {
      let input = parsed.searchParams.get("input") || undefined;
      const game = parsed.searchParams.get("game") || "";
      if (!input && game) {
        input = (await getGameRecord(game)).item.file;
      }
      const core = getRuntimeCore(input);
      const scene = parsed.searchParams.get("scene") || parsed.searchParams.get("name") || parsed.searchParams.get("rel") || defaultCoreScene(core);
      const runtime = await buildRuntimeSceneFromCore(core, scene, {
        game: game || undefined,
      });
      const response = buildEmulatorResponse(
        runtime,
        parseActions(parsed.searchParams.get("actions")),
        "nicai.cbe.coreEmulatorResponse.v1",
      );
      response.source = {
        mode: "raw-cbe-core",
        input: core.input,
        scene,
      };
      sendJson(res, response);
      return;
    }

    if (parsed.pathname === "/api/bytes") {
      const file = await resolveAsset(parsed.searchParams.get("game"), parsed.searchParams.get("rel"));
      const limit = Math.max(1, Math.min(Number(parsed.searchParams.get("limit") || 8192), 262144));
      const handle = await fsp.open(file, "r");
      try {
        const buf = Buffer.alloc(limit);
        const { bytesRead } = await handle.read(buf, 0, limit, 0);
        sendJson(res, {
          bytes: Array.from(buf.subarray(0, bytesRead)),
          size: (await handle.stat()).size,
        });
      } finally {
        await handle.close();
      }
      return;
    }

    if (parsed.pathname === "/api/struct") {
      const { file, files } = await resolveAssetWithGame(parsed.searchParams.get("game"), parsed.searchParams.get("rel"));
      const summary = await summarizeFile(file, {
        name: path.basename(file).replace(/^[0-9]{4}_/, ""),
        catalog: files,
      });
      sendJson(res, summary);
      return;
    }

    if (parsed.pathname === "/api/maptrace") {
      const { root, file, files } = await resolveAssetWithGame(parsed.searchParams.get("game"), parsed.searchParams.get("rel"));
      if (path.extname(file).toLowerCase() !== ".map") throw new Error("maptrace only supports .map files");
      const trace = await analyzeMapFile(file, {
        root,
        catalog: files.map((entry) => ({
          name: entry.name,
          rel: entry.rel,
          output: path.join(root, entry.rel),
        })),
      });
      sendJson(res, trace);
      return;
    }

    if (parsed.pathname === "/api/runtime") {
      const game = parsed.searchParams.get("game");
      const { root, file, files } = await resolveAssetWithGame(game, parsed.searchParams.get("rel"));
      if (path.extname(file).toLowerCase() !== ".sce") throw new Error("runtime only supports .sce files");
      const runtime = await buildRuntimeScene(file, {
        root,
        game,
        catalog: files.map((entry) => ({
          ...entry,
          output: path.join(root, entry.rel),
        })),
      });
      sendJson(res, runtime);
      return;
    }

    if (parsed.pathname === "/api/true-runtime") {
      const game = parsed.searchParams.get("game") || "";
      if (game && !game.includes("众神之战")) {
        sendJson(res, {
          schema: "nicai.cbe.trueRuntimeProbe.v1",
          available: false,
          reason: "Godwar-specific disassembly trace is not shown for generic CBE previews",
        });
        return;
      }
      const rel = parsed.searchParams.get("rel") || "";
      const scene = parsed.searchParams.get("scene") || (rel ? rawCbeNameFromRel(rel) : "");
      let input = parsed.searchParams.get("input") || undefined;
      if (!input && game) {
        input = (await getGameRecord(game)).item.file;
      }
      const runtime = buildTrueRuntime({
        input,
        scene: scene || undefined,
      });
      sendJson(res, runtime);
      return;
    }

    if (parsed.pathname === "/api/xse-wire") {
      const input = parsed.searchParams.get("input") || undefined;
      const names = String(parsed.searchParams.get("scripts") || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      sendJson(res, buildWireProbe({ input, names }));
      return;
    }

    if (parsed.pathname === "/api/xse-reader-service") {
      if (!(await fileExists(XSE_READER_SERVICE_JSON))) {
        throw new Error("xse reader service trace is missing; run cbe_xse_reader_service_trace.py first");
      }
      sendJson(res, await readJson(XSE_READER_SERVICE_JSON));
      return;
    }

    if (parsed.pathname === "/api/xse-vm-gate") {
      if (!(await fileExists(XSE_VM_GATE_JSON))) {
        throw new Error("xse vm gate probe is missing; run cbe_xse_vm_gate_probe.js first");
      }
      sendJson(res, await readJson(XSE_VM_GATE_JSON));
      return;
    }

    if (parsed.pathname === "/api/emulator") {
      const game = parsed.searchParams.get("game");
      const { root, file, files } = await resolveAssetWithGame(game, parsed.searchParams.get("rel"));
      if (path.extname(file).toLowerCase() !== ".sce") throw new Error("emulator only supports .sce files");
      const runtime = await buildRuntimeScene(file, {
        root,
        game,
        catalog: files.map((entry) => ({
          ...entry,
          output: path.join(root, entry.rel),
        })),
      });
      const actions = parseActions(parsed.searchParams.get("actions"));
      sendJson(res, buildEmulatorResponse(runtime, actions));
      return;
    }

    await serveStatic(parsed.pathname, res);
  } catch (err) {
    send(res, 500, err.message || String(err));
  }
}

http.createServer(handle).listen(PORT, "127.0.0.1", () => {
  console.log(`CBE viewer: http://127.0.0.1:${PORT}`);
});
