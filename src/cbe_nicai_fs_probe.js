const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { loadCbeArchive } = require("./cbe_unpack");
const { cleanName, extOf } = require("./cbe_profile");
const { summarizeFile } = require("./cbe_struct");

const DEFAULT_ROOT = path.resolve(__dirname, "..", "nicai system files");
const DEFAULT_OUT = path.resolve(process.cwd(), "out_nicai_filesystem");

const RESOURCE_EXTS = new Set([".cbe", ".actor", ".map", ".sce", ".gif", ".mid", ".mp3", ".wav"]);
const SAMPLE_STRUCT_FILES = [
  ".system/MB_MSTAR_WQVGA/PlantsZombies/场景1.sce",
  ".system/MB_MSTAR_WQVGA/PlantsZombies/地图1.map",
  ".system/MB_MSTAR_WQVGA/PlantsZombies/p_wandou1.actor",
  ".system/MB_MSTAR_WQVGA/PlantsZombies/z_01.actor",
];

function rel(root, file) {
  return path.relative(root, file).replace(/\\/g, "/");
}

function normalizeExt(file) {
  return path.extname(file || "").toLowerCase();
}

function addCount(map, key, inc = 1) {
  map.set(key, (map.get(key) || 0) + inc);
}

function toSortedCounts(map, limit = 80) {
  return Array.from(map, ([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit);
}

function walk(root) {
  const dirs = [];
  const files = [];
  function visit(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const stat = fs.statSync(full);
        dirs.push({
          name: entry.name,
          rel: rel(root, full),
          mtime: stat.mtime.toISOString(),
        });
        visit(full);
      } else if (entry.isFile()) {
        const stat = fs.statSync(full);
        files.push({
          name: entry.name,
          rel: rel(root, full),
          full,
          ext: normalizeExt(entry.name),
          size: stat.size,
          mtime: stat.mtime.toISOString(),
        });
      }
    }
  }
  visit(root);
  return { dirs, files };
}

function asciiRuns(buf, min = 4, limit = 80) {
  const out = [];
  let start = -1;
  for (let i = 0; i <= buf.length; i += 1) {
    const byte = i < buf.length ? buf[i] : 0;
    const ok = byte >= 0x20 && byte <= 0x7e;
    if (ok && start < 0) start = i;
    if (!ok && start >= 0) {
      if (i - start >= min) out.push({ offset: start, text: buf.subarray(start, i).toString("ascii") });
      start = -1;
      if (out.length >= limit) break;
    }
  }
  return out;
}

function utf8TextSamples(buf, limit = 40) {
  const text = buf.toString("utf8").replace(/\0+/g, "\n");
  const rows = [];
  const seen = new Set();
  for (const raw of text.split(/[\r\n]+/)) {
    const clean = raw.replace(/[^\u3400-\u9fffA-Za-z0-9_. -]+/gu, "").trim();
    if (clean.length < 2) continue;
    if (!/[\u3400-\u9fff]/u.test(clean) && clean.length < 4) continue;
    if (seen.has(clean)) continue;
    seen.add(clean);
    rows.push(clean);
    if (rows.length >= limit) break;
  }
  return rows;
}

function hexBytes(buf, limit = 64) {
  return Array.from(buf.subarray(0, Math.min(buf.length, limit)))
    .map((byte) => byte.toString(16).toUpperCase().padStart(2, "0"))
    .join(" ");
}

function u16Words(buf, limit = 80) {
  const rows = [];
  for (let i = 0; i + 1 < buf.length && rows.length < limit; i += 2) {
    rows.push({ offset: `0x${i.toString(16).toUpperCase().padStart(2, "0")}`, value: buf.readUInt16LE(i) });
  }
  return rows;
}

function saveRecordSummary(file) {
  const buf = fs.readFileSync(file.full);
  const runs = asciiRuns(buf, 4, 40);
  return {
    name: file.name,
    rel: file.rel,
    size: file.size,
    firstBytes: hexBytes(buf, 80),
    asciiRuns: runs,
    u16Head: u16Words(buf, 48),
    sceneRefs: runs.flatMap((run) => (run.text.match(/[A-Za-z0-9_./-]+\.sce/ig) || [])),
  };
}

function classifyFile(file) {
  const text = `${file.rel}/${file.name}`.toLowerCase();
  if (file.ext === ".cbe") return "cbe-container";
  if ([".actor", ".map", ".sce", ".gif", ".mid"].includes(file.ext)) return "loose-cbe-style-resource";
  if (/record|savedata|save|data|storage|continue|\.sav$/i.test(text)) return "save-or-state";
  if (/\.system\/as_mstar_wqvga/i.test(file.rel)) return "appstore-shell";
  if (/\.system\/java/i.test(file.rel)) return "java-runtime-store";
  if (/wapexplorer|mms|temp/i.test(file.rel)) return "phone-system-data";
  if (/img\.dat|audio|wav|mp3/i.test(text)) return "non-cbe-bundled-app-asset";
  return "other";
}

function summarizeTopLevel(root) {
  return fs.readdirSync(root, { withFileTypes: true })
    .map((entry) => {
      const full = path.join(root, entry.name);
      const stat = fs.statSync(full);
      return {
        name: entry.name,
        kind: entry.isDirectory() ? "directory" : "file",
        hiddenByName: entry.name.startsWith("."),
        size: entry.isFile() ? stat.size : null,
        mtime: stat.mtime.toISOString(),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function summarizeCbe(file) {
  try {
    const archive = loadCbeArchive(file.full);
    const extCounts = new Map();
    for (const entry of archive.entries) addCount(extCounts, extOf(entry.name) || "(none)");
    const resources = archive.entries.map((entry) => cleanName(entry.name));
    return {
      name: file.name,
      rel: file.rel,
      size: file.size,
      ok: true,
      sectionCount: archive.sections.length,
      resourceCount: archive.entries.length,
      resourceExtCounts: toSortedCounts(extCounts, 20),
      hasScene: resources.some((name) => /\.sce$/i.test(name)),
      hasMap: resources.some((name) => /\.map$/i.test(name)),
      hasActor: resources.some((name) => /\.actor$/i.test(name)),
      hasScript: resources.some((name) => /\.xse$/i.test(name)),
      sampleResources: resources.slice(0, 12),
    };
  } catch (err) {
    return {
      name: file.name,
      rel: file.rel,
      size: file.size,
      ok: false,
      error: err.message,
    };
  }
}

function summarizeLooseResourceDirs(files) {
  const byDir = new Map();
  for (const file of files) {
    if (!RESOURCE_EXTS.has(file.ext) || file.ext === ".cbe") continue;
    const dir = path.dirname(file.rel).replace(/\\/g, "/");
    if (!byDir.has(dir)) byDir.set(dir, { dir, count: 0, extCounts: new Map(), samples: [] });
    const row = byDir.get(dir);
    row.count += 1;
    addCount(row.extCounts, file.ext || "(none)");
    if (row.samples.length < 12) row.samples.push({ name: file.name, size: file.size });
  }
  return Array.from(byDir.values())
    .map((row) => ({
      dir: row.dir,
      count: row.count,
      extCounts: toSortedCounts(row.extCounts, 12),
      samples: row.samples,
    }))
    .sort((a, b) => b.count - a.count || a.dir.localeCompare(b.dir));
}

async function summarizeStructSamples(root) {
  const out = [];
  for (const sample of SAMPLE_STRUCT_FILES) {
    const full = path.join(root, sample.replace(/\//g, path.sep));
    if (!fs.existsSync(full)) continue;
    try {
      const summary = await summarizeFile(full);
      const specific = summary.specific || {};
      out.push({
        rel: sample,
        ext: summary.ext,
        size: summary.size,
        sce: specific.sce ? {
          canvas: specific.sce.canvas || null,
          mapHints: specific.sce.mapHints || [],
        } : null,
        map: specific.map ? {
          tilesetHint: specific.map.tilesetHint || "",
          canvas: specific.map.canvas || null,
          dataOffset: specific.map.dataOffset || "",
          drawStreamLength: specific.map.drawStreamLength || 0,
        } : null,
        actor: specific.actor ? {
          primaryImage: specific.actor.primaryImage || "",
          imageRefs: specific.actor.imageRefs || [],
          streamOffset: specific.actor.streamOffset || "",
          streamLength: specific.actor.streamLength || "",
          divider: specific.actor.stream?.divider || null,
        } : null,
      });
    } catch (err) {
      out.push({ rel: sample, error: err.message });
    }
  }
  return out;
}

function buildInsights(report) {
  const cbeOk = report.cbeContainers.filter((row) => row.ok);
  const cbeWithRpgStack = cbeOk.filter((row) => row.hasScene && row.hasMap && row.hasActor);
  const godWarSave = report.saveRecords.find((row) => row.name === "GodWarGameRecord");
  return [
    `filesystemRoot=${report.root}`,
    `standardCbeContainers=${cbeOk.length}/${report.cbeContainers.length}`,
    `cbeWithSceneMapActorStack=${cbeWithRpgStack.length}`,
    `looseResourceDirs=${report.looseResourceDirs.length}`,
    godWarSave?.sceneRefs?.length
      ? `GodWarGameRecord embeds scene ref: ${godWarSave.sceneRefs.join(", ")}`
      : "GodWarGameRecord scene ref not found",
    "PlantsZombies is genre-different, but its loose SCE/MAP/ACTOR resources still validate generic resource-file parsing outside CBE containers.",
    "Most top-level hidden app folders use img.dat/audio bundles and are less useful for the CBE runtime except as phone filesystem layout evidence.",
  ];
}

async function probe(root, outDir) {
  const resolvedRoot = path.resolve(root);
  const { dirs, files } = walk(resolvedRoot);
  const extCounts = new Map();
  const classCounts = new Map();
  for (const file of files) {
    addCount(extCounts, file.ext || "(none)");
    addCount(classCounts, classifyFile(file));
  }

  const cbeContainers = files
    .filter((file) => file.ext === ".cbe")
    .sort((a, b) => a.rel.localeCompare(b.rel))
    .map(summarizeCbe);

  const saveRecords = files
    .filter((file) => classifyFile(file) === "save-or-state")
    .sort((a, b) => a.rel.localeCompare(b.rel))
    .map(saveRecordSummary);

  const appStoreMenu = files.find((file) => file.rel.replace(/\\/g, "/") === ".system/AS_MSTAR_WQVGA/cstoremenu");
  const appStoreSamples = appStoreMenu ? utf8TextSamples(fs.readFileSync(appStoreMenu.full), 80) : [];

  const report = {
    schema: "nicai.cbe.nicaiFilesystemProbe.v1",
    generatedAt: new Date().toISOString(),
    root: resolvedRoot,
    topLevel: summarizeTopLevel(resolvedRoot),
    totals: {
      dirs: dirs.length,
      files: files.length,
      bytes: files.reduce((sum, file) => sum + file.size, 0),
      extensionCounts: toSortedCounts(extCounts, 80),
      classCounts: toSortedCounts(classCounts, 30),
    },
    importantDirs: dirs
      .filter((dir) => /^(\.system|\.APS|AirPlane|beauty|finddiff|nrsh|piano|puff|tom|TTS|store3_0|tcstore3_0)/i.test(dir.rel))
      .slice(0, 120),
    cbeContainers,
    looseResourceDirs: summarizeLooseResourceDirs(files),
    saveRecords,
    appStoreSamples,
    structSamples: await summarizeStructSamples(resolvedRoot),
  };
  report.insights = buildInsights(report);

  await fsp.mkdir(outDir, { recursive: true });
  await fsp.writeFile(path.join(outDir, "nicai_filesystem_probe.json"), JSON.stringify(report, null, 2), "utf8");
  await fsp.writeFile(path.join(outDir, "nicai_filesystem_probe.md"), textReport(report), "utf8");
  return report;
}

function textReport(report) {
  const lines = [];
  lines.push("# Nicai Filesystem Probe");
  lines.push("");
  lines.push(`root=${report.root}`);
  lines.push(`files=${report.totals.files} dirs=${report.totals.dirs} bytes=${report.totals.bytes}`);
  lines.push(`classes=${report.totals.classCounts.map((row) => `${row.name}:${row.count}`).join(" ")}`);
  lines.push(`extensions=${report.totals.extensionCounts.slice(0, 24).map((row) => `${row.name}:${row.count}`).join(" ")}`);
  lines.push("");
  lines.push("## Insights");
  for (const insight of report.insights) lines.push(`- ${insight}`);
  lines.push("");
  lines.push("## Top Level");
  for (const row of report.topLevel) {
    lines.push(`- ${row.name} ${row.kind}${row.hiddenByName ? " hidden" : ""}`);
  }
  lines.push("");
  lines.push("## CBE Containers");
  for (const row of report.cbeContainers) {
    if (!row.ok) {
      lines.push(`- ${row.rel} size=${row.size} ERROR=${row.error}`);
      continue;
    }
    const profile = [
      row.hasScene ? "sce" : "",
      row.hasMap ? "map" : "",
      row.hasActor ? "actor" : "",
      row.hasScript ? "xse" : "",
    ].filter(Boolean).join("+") || "asset-only";
    lines.push(`- ${row.rel} size=${row.size} sections=${row.sectionCount} resources=${row.resourceCount} profile=${profile}`);
  }
  lines.push("");
  lines.push("## Loose Resource Dirs");
  for (const row of report.looseResourceDirs.slice(0, 20)) {
    lines.push(`- ${row.dir} count=${row.count} exts=${row.extCounts.map((item) => `${item.name}:${item.count}`).join(" ")}`);
  }
  lines.push("");
  lines.push("## Save Or State Records");
  for (const row of report.saveRecords.slice(0, 40)) {
    const refs = row.sceneRefs.length ? ` sceneRefs=${row.sceneRefs.join(",")}` : "";
    const ascii = row.asciiRuns.slice(0, 3).map((run) => `${run.offset}:${run.text}`).join(" | ");
    lines.push(`- ${row.rel} size=${row.size}${refs}${ascii ? ` ascii=${ascii}` : ""}`);
  }
  lines.push("");
  lines.push("## Struct Samples");
  for (const row of report.structSamples) {
    if (row.error) {
      lines.push(`- ${row.rel} ERROR=${row.error}`);
    } else if (row.sce) {
      lines.push(`- ${row.rel} SCE canvas=${row.sce.canvas ? `${row.sce.canvas.width}x${row.sce.canvas.height}` : "-"} maps=${(row.sce.mapHints || []).map((item) => item.text).join(",") || "-"}`);
    } else if (row.map) {
      lines.push(`- ${row.rel} MAP tileset=${row.map.tilesetHint || "-"} canvas=${row.map.canvas ? `${row.map.canvas.width}x${row.map.canvas.height}` : "-"} drawLen=${row.map.drawStreamLength}`);
    } else if (row.actor) {
      lines.push(`- ${row.rel} ACTOR image=${row.actor.primaryImage || row.actor.imageRefs.join(",") || "-"} stream=${row.actor.streamOffset}/${row.actor.streamLength} divider=${row.actor.divider ? `${row.actor.divider.markerBytes}@${row.actor.divider.offset}` : "-"}`);
    }
  }
  lines.push("");
  lines.push("## App Store Text Samples");
  for (const item of report.appStoreSamples.slice(0, 40)) lines.push(`- ${item}`);
  return lines.join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    console.log("Usage: node src/cbe_nicai_fs_probe.js [\"./nicai system files\"] [out_dir]");
    return;
  }
  const root = path.resolve(args[0] || DEFAULT_ROOT);
  const outDir = path.resolve(args[1] || DEFAULT_OUT);
  const report = await probe(root, outDir);
  console.log("cbe-nicai-filesystem-probe-ready");
  console.log(`Root: ${report.root}`);
  console.log(`Output: ${outDir}`);
  console.log(`Files: ${report.totals.files}`);
  console.log(`CBE containers: ${report.cbeContainers.length}`);
  console.log(`Loose resource dirs: ${report.looseResourceDirs.length}`);
  for (const insight of report.insights) console.log(`- ${insight}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.stack || err.message || String(err));
    process.exitCode = 1;
  });
}

module.exports = {
  probe,
};
