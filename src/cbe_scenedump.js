const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { summarizeFile } = require("./cbe_struct");

const DEFAULT_SCENE = path.resolve(process.cwd(), "out_godwar", "section_1_39BCD", "0312_guangmingshendian.sce");
const DEFAULT_OUT = path.resolve(process.cwd(), "out_godwar_scenedump");

function usage() {
  console.log(`Usage:
  node src/cbe_scenedump.js [scene.sce|unpacked_dir] [output_dir]

Examples:
  node src/cbe_scenedump.js .\\out_godwar\\section_1_39BCD\\0312_guangmingshendian.sce .\\out_godwar_scenedump
  node src/cbe_scenedump.js .\\out_godwar .\\out_godwar_scenedump_all`);
}

function cleanName(name) {
  return String(name || "").replace(/^[0-9]{4}_/, "");
}

function walk(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    const stat = fs.statSync(file);
    if (stat.isDirectory()) out.push(...walk(file));
    else out.push(file);
  }
  return out;
}

function relFrom(base, file) {
  return path.relative(base, file).split(path.sep).join("/");
}

function loadCatalog(root) {
  const manifestPath = path.join(root, "manifest.json");
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return manifest.files
      .filter((file) => file.name && file.output)
      .map((file) => ({
        name: file.name,
        rel: relFrom(root, file.output),
        output: file.output,
      }));
  }

  return walk(root).map((file) => ({
    name: cleanName(path.basename(file)),
    rel: relFrom(root, file),
    output: file,
  }));
}

function findRoot(file) {
  let dir = path.dirname(path.resolve(file));
  while (dir && dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "manifest.json"))) return dir;
    dir = path.dirname(dir);
  }
  return path.dirname(path.resolve(file));
}

function byCleanName(catalog) {
  const map = new Map();
  for (const entry of catalog) {
    map.set(cleanName(entry.name).toLowerCase(), entry);
    map.set(cleanName(path.basename(entry.rel)).toLowerCase(), entry);
  }
  return map;
}

async function enrichPlacement(placement, lookup, root) {
  const actorEntry = placement.rel ? { rel: placement.rel, name: placement.matched } : lookup.get(String(placement.matched || "").toLowerCase());
  if (!actorEntry?.rel) return placement;

  const actorFile = path.join(root, actorEntry.rel);
  const actorSummary = await summarizeFile(actorFile, {
    name: cleanName(path.basename(actorFile)),
    catalog: Array.from(lookup.values()),
  });
  const imageName = actorSummary.specific.actor?.primaryImage || "";
  const imageEntry = lookup.get(imageName.toLowerCase());
  return {
    ...placement,
    actor: {
      rel: actorEntry.rel,
      image: imageName,
      imageRel: imageEntry?.rel || "",
    },
  };
}

function sceneObjectProbeSummary(probe) {
  if (!probe) return null;
  return {
    note: probe.note,
    sceneStreamOffset: probe.sceneStreamOffset,
    sceneStreamLength: probe.sceneStreamLength,
    resourceRefCount: probe.resourceRefCount || 0,
    resourceRefs: (probe.resourceRefs || []).slice(0, 16).map((ref) => ({
      offset: ref.offset,
      text: ref.text,
      matched: ref.matched,
      rel: ref.rel,
      ext: ref.ext,
      matchReason: ref.matchReason,
      postU16LE: ref.postU16LE,
    })),
    externalProbes: (probe.externalProbes || []).map((external) => ({
      refOffset: external.refOffset,
      text: external.text,
      matched: external.matched,
      rel: external.rel,
      ext: external.ext,
      error: external.error || "",
      confidence: external.probe?.confidence || "",
      best: external.probe?.best ? {
        score: external.probe.best.score,
        ok: external.probe.best.ok,
        groupIdReader: external.probe.best.groupIdReader,
        baseOffset: external.probe.best.baseOffset,
        cursorStart: external.probe.best.cursorStart,
        endOffset: external.probe.best.endOffset,
        consumedBytes: external.probe.best.consumedBytes,
        groupCount: external.probe.best.groupCount,
        totalRecords: external.probe.best.totalRecords,
        knownOpcodePercent: external.probe.best.knownOpcodePercent,
        opcodeHistogram: external.probe.best.opcodeHistogram,
        groups: external.probe.best.groups,
        warnings: external.probe.best.warnings,
      } : null,
    })),
  };
}

function textFor(report) {
  const lines = [];
  lines.push(`# ${report.scene.name}`);
  lines.push(`canvas=${report.scene.canvas ? `${report.scene.canvas.width}x${report.scene.canvas.height}` : "-"}`);
  if (report.scene.map) lines.push(`map=${report.scene.map.name} rel=${report.scene.map.rel}`);
  lines.push("");
  lines.push("## Placements");
  for (const placement of report.placements) {
    const actor = placement.actor?.image ? ` image=${placement.actor.image}` : "";
    lines.push(`${placement.offset} ${placement.name} -> ${placement.matched} x=${placement.x} y=${placement.y} type=${placement.recordType}${actor}`);
  }
  if (report.sceneObjectProbe) {
    lines.push("");
    lines.push("## Scene Object Bytecode Probe");
    lines.push(`stream=${report.sceneObjectProbe.sceneStreamOffset} length=${report.sceneObjectProbe.sceneStreamLength} refs=${report.sceneObjectProbe.resourceRefCount}`);
    for (const ref of report.sceneObjectProbe.resourceRefs || []) {
      lines.push(`${ref.offset} ${ref.text} -> ${ref.matched || "-"} ${ref.rel || ""}`.trim());
    }
    for (const external of report.sceneObjectProbe.externalProbes || []) {
      const best = external.best;
      if (!best) {
        lines.push(`${external.refOffset} ${external.text}: ${external.error || "no probe"}`);
        continue;
      }
      const ops = (best.opcodeHistogram || []).slice(0, 8).map((item) => `${item.key}:${item.count}`).join(" ");
      lines.push(`${external.refOffset} ${external.text}: confidence=${external.confidence || "-"} score=${best.score} groups=${best.groupCount} records=${best.totalRecords} cursor=${best.cursorStart}->${best.endOffset} reader=${best.groupIdReader}`);
      lines.push(`  opcodes ${ops || "-"}`);
    }
  }
  return lines.join("\n");
}

async function dump(sceneFile, outDir) {
  const root = findRoot(sceneFile);
  const catalog = loadCatalog(root);
  const lookup = byCleanName(catalog);
  const summary = await summarizeFile(sceneFile, {
    name: cleanName(path.basename(sceneFile)),
    catalog,
  });

  const mapHint = summary.specific.sce?.mapHints?.[0]?.text || "";
  const mapEntry = mapHint ? lookup.get(mapHint.toLowerCase()) : null;
  const placements = [];
  for (const placement of summary.specific.sce?.placements || []) {
    placements.push(await enrichPlacement(placement, lookup, root));
  }

  const report = {
    input: sceneFile,
    root,
    generatedAt: new Date().toISOString(),
    scene: {
      name: cleanName(path.basename(sceneFile)),
      canvas: summary.specific.sce?.canvas || null,
      map: mapEntry ? { name: mapEntry.name, rel: mapEntry.rel } : null,
      lengthPrefixedRefs: summary.specific.sce?.lengthPrefixedRefs || [],
    },
    placements,
    sceneObjectProbe: sceneObjectProbeSummary(summary.specific.sce?.sceneObjectProbe),
  };

  await fsp.mkdir(outDir, { recursive: true });
  await fsp.writeFile(path.join(outDir, "scene.json"), JSON.stringify(report, null, 2), "utf8");
  await fsp.writeFile(path.join(outDir, "scene.txt"), textFor(report), "utf8");
  console.log(`Input: ${sceneFile}`);
  console.log(`Output: ${outDir}`);
  console.log(`Placements: ${placements.length}`);
  if (report.sceneObjectProbe) {
    console.log(`Scene object refs: ${report.sceneObjectProbe.resourceRefCount}`);
    console.log(`Scene object probes: ${report.sceneObjectProbe.externalProbes.length}`);
  }
}

async function dumpMany(rootDir, outDir) {
  const root = path.resolve(rootDir);
  const scenes = walk(root).filter((file) => path.extname(file).toLowerCase() === ".sce");
  await fsp.mkdir(outDir, { recursive: true });
  const index = [];
  for (const sceneFile of scenes) {
    const rel = relFrom(root, sceneFile);
    const safeName = rel.replace(/[\\/]/g, "__").replace(/\.sce$/i, "");
    const sceneOut = path.join(outDir, safeName);
    await dump(sceneFile, sceneOut);
    const sceneJson = JSON.parse(await fsp.readFile(path.join(sceneOut, "scene.json"), "utf8"));
    index.push({
      scene: rel,
      canvas: sceneJson.scene.canvas,
      map: sceneJson.scene.map,
      placements: sceneJson.placements.length,
      sceneObjectRefs: sceneJson.sceneObjectProbe?.resourceRefCount || 0,
      externalProbes: sceneJson.sceneObjectProbe?.externalProbes?.length || 0,
    });
  }
  await fsp.writeFile(path.join(outDir, "index.json"), JSON.stringify(index, null, 2), "utf8");
  await fsp.writeFile(path.join(outDir, "index.txt"), index.map((item) => (
    `${item.scene} canvas=${item.canvas ? `${item.canvas.width}x${item.canvas.height}` : "-"} placements=${item.placements} objectRefs=${item.sceneObjectRefs} probes=${item.externalProbes}`
  )).join("\n"), "utf8");
  console.log(`Scenes: ${scenes.length}`);
  console.log(`Index: ${path.join(outDir, "index.txt")}`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    usage();
    return;
  }
  const input = path.resolve(args[0] || DEFAULT_SCENE);
  const outDir = path.resolve(args[1] || DEFAULT_OUT);
  const stat = fs.statSync(input);
  if (stat.isDirectory()) await dumpMany(input, outDir);
  else await dump(input, outDir);
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
