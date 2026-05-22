const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { CbeRuntimeCore } = require("./cbe_runtime_core");
const { buildRuntimeSceneFromCore } = require("./cbe_runtime");
const { cleanName } = require("./cbe_profile");
const { decodeCompactToken, parseGifInfoBuffer, summarizeBuffer } = require("./cbe_struct");

const DEFAULT_INPUT = path.resolve(__dirname, "..", "cbe file", "众神之战.CBE");
const DEFAULT_OUT = path.resolve(process.cwd(), "out_cbe_actor_logic");
const DEFAULT_ANCHOR_SCENE = "guangmingshendian.sce";
const DEFAULT_FOCUS_ACTORS = [
  "heermode.actor",
  "nanna.actor",
  "fali.actor",
  "lang.actor",
  "guangmingshen.actor",
];

function usage() {
  console.log("Usage: node src/cbe_actor_logic_probe.js [input.CBE] [out_dir]");
}

function hexToInt(text) {
  if (typeof text === "number") return text;
  const clean = String(text || "").replace(/^0x/i, "");
  const value = Number.parseInt(clean || "0", 16);
  return Number.isFinite(value) ? value : 0;
}

function compactGifInfo(info) {
  if (!info) return null;
  return {
    width: info.width,
    height: info.height,
    frames: info.frames,
    graphicControls: info.graphicControls,
    delaysCentiseconds: info.delaysCentiseconds || [],
    uniqueDelaysCentiseconds: info.uniqueDelaysCentiseconds || [],
    positiveDelay: (info.uniqueDelaysCentiseconds || []).some((delay) => delay > 0),
    sheetLike: info.sheetLike,
    imageDescriptors: info.imageDescriptors || [],
  };
}

function publicCatalogForStruct(core) {
  return core.catalog.map((entry) => ({
    ...entry,
    base: cleanName(entry.name),
  }));
}

function findImageEntry(core, actor) {
  if (actor?.primaryImageRel) return core.findResource(actor.primaryImageRel);
  if (actor?.primaryImage) return core.findResource(actor.primaryImage);
  return null;
}

function readImageInfo(core, entry) {
  if (!entry) return null;
  try {
    const resource = core.readResource(entry);
    return compactGifInfo(parseGifInfoBuffer(resource.fixed));
  } catch {
    return null;
  }
}

function tokenList(bytes, start, limit = 32) {
  const out = [];
  let cursor = Math.max(0, Math.min(start, bytes.length));
  while (cursor < bytes.length && out.length < limit) {
    const token = decodeCompactToken(bytes, cursor);
    if (!token) break;
    out.push({
      offset: `0x${cursor.toString(16).toUpperCase().padStart(4, "0")}`,
      tag: token.tag,
      value: token.value,
      raw: token.raw,
      next: `0x${token.next.toString(16).toUpperCase().padStart(4, "0")}`,
      truncated: Boolean(token.truncated),
    });
    cursor = token.next;
    if (token.truncated) break;
  }
  return out;
}

function tokenStats(bytes, start, end) {
  const tags = new Map();
  const values = [];
  let cursor = Math.max(0, Math.min(start, bytes.length));
  const stop = Math.max(cursor, Math.min(end, bytes.length));
  let truncated = false;
  while (cursor < stop && values.length < 4096) {
    const token = decodeCompactToken(bytes, cursor);
    if (!token || token.next > stop) {
      truncated = true;
      break;
    }
    tags.set(token.tag, (tags.get(token.tag) || 0) + 1);
    values.push(token.value);
    cursor = token.next;
    if (token.truncated) {
      truncated = true;
      break;
    }
  }
  return {
    tokenCount: values.length,
    consumedBytes: cursor - start,
    truncated,
    min: values.length ? Math.min(...values) : null,
    max: values.length ? Math.max(...values) : null,
    negativeCount: values.filter((value) => value < 0).length,
    highPositiveCount: values.filter((value) => value > 255).length,
    tagCounts: Array.from(tags, ([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
      .slice(0, 12),
  };
}

function markerFamily(markerBytes) {
  const bytes = String(markerBytes || "").split(/\s+/);
  if (bytes.length >= 5 && bytes[2] === "0xFF" && bytes[3] === "0xFF" && bytes[4] === "0xFF") {
    return `${bytes[0]} ${bytes[1]} FF FF FF`;
  }
  if (bytes.length >= 3 && bytes[0] === "0xFF" && bytes[1] === "0xFF" && bytes[2] === "0xFF") return "FF FF FF";
  return markerBytes || "";
}

function summarizePictureRefTable(probe) {
  if (!probe) return null;
  return {
    note: probe.note,
    count: probe.count,
    countRaw: probe.countRaw,
    complete: probe.complete,
    recordCount: probe.recordCount,
    afterRecordsOffset: probe.afterRecordsOffset,
    columns: probe.columns || [],
    image: probe.image || null,
    records: (probe.records || []).slice(0, 12),
    nextTokens: (probe.nextTokens || []).slice(0, 12),
  };
}

function summarizeF222(probe) {
  if (!probe) return null;
  return {
    note: probe.note,
    count: probe.count,
    countRaw: probe.countRaw,
    tableComplete: probe.tableComplete,
    tableAfterOffset: probe.tableAfterOffset,
    referenceTableApproximation: probe.referenceTableApproximation,
    fieldsOffset: probe.fieldsOffset,
    fields: probe.fields || [],
    grid: probe.grid || null,
    image: probe.image || null,
    matrixRead: probe.matrixRead,
    matrixExpected: probe.matrixExpected,
    matrixEndOffset: probe.matrixEndOffset,
    bytesToFfCandidate: probe.bytesToFfCandidate,
    ffTokenCandidate: probe.ffTokenCandidate || null,
    firstMatrixTokens: (probe.firstMatrixTokens || []).slice(0, 16),
  };
}

function summarizeTemplateProbe(probe) {
  if (!probe) return null;
  return {
    note: probe.note,
    ffTokenCandidate: probe.ffTokenCandidate || null,
    attempts: (probe.attempts || []).slice(0, 6),
  };
}

function classifyActorLogic(actor, imageInfo) {
  const reasons = [];
  if (imageInfo?.frames === 1 && !(imageInfo.uniqueDelaysCentiseconds || []).some((delay) => delay > 0)) {
    reasons.push("image resource is a static sheet/atlas, not a GIF-container animation");
  }
  if (actor?.frameTableProbe?.recordCount) {
    reasons.push("leading compact record table exists; likely picture/part/frame metadata consumed by engine helpers");
  }
  if (actor?.stream?.divider) {
    reasons.push("stable FF-heavy sentinel splits metadata-like and state/animation-like stream regions");
  }
  if (actor?.f222LayoutProbe?.grid || actor?.templateStreamProbe?.attempts?.length) {
    reasons.push("0x0F222-style template/layout candidates exist; renderer must execute records instead of drawing whole GIFs");
  }
  return {
    status: "engine-controlled-sheet-animation-evidence",
    confidence: reasons.length >= 3 ? "medium" : "low",
    reasons,
  };
}

function analyzeActor(core, catalog, entry) {
  const resource = core.readResource(entry);
  const firstSummary = summarizeBuffer(entry.name, resource.fixed, { catalog, source: "raw-cbe-core" });
  const firstActor = firstSummary.specific?.actor || {};
  const imageEntry = findImageEntry(core, firstActor);
  const imageInfo = readImageInfo(core, imageEntry);
  const summary = summarizeBuffer(entry.name, resource.fixed, {
    catalog,
    source: "raw-cbe-core",
    imageInfo,
  });
  const actor = summary.specific?.actor || firstActor;
  const streamOffset = hexToInt(actor.streamOffset);
  const stream = resource.fixed.subarray(streamOffset);
  const divider = actor.stream?.divider || null;
  const markerStart = divider ? hexToInt(divider.offset) : stream.length;
  const markerEnd = divider ? hexToInt(divider.postOffset) : markerStart;
  return {
    name: cleanName(entry.name),
    rel: entry.rel,
    primaryImage: actor.primaryImage || "",
    primaryImageRel: imageEntry?.rel || actor.primaryImageRel || "",
    imageInfo,
    sheetInterpretation: classifyActorLogic(actor, imageInfo),
    stream: {
      offset: actor.streamOffset,
      length: actor.streamLength,
      divider: divider ? {
        offset: divider.offset,
        postOffset: divider.postOffset,
        markerBytes: divider.markerBytes,
        family: markerFamily(divider.markerBytes),
        preDataLength: divider.preDataLength,
        postLength: divider.postLength,
      } : null,
      preStats: tokenStats(stream, 0, markerStart),
      postStats: divider ? tokenStats(stream, markerEnd, stream.length) : null,
      firstTokens: tokenList(stream, 0, 28),
      postTokens: divider ? tokenList(stream, markerEnd, 28) : [],
    },
    pictureRefTableApprox: summarizePictureRefTable(actor.frameTableProbe),
    f222Layout: summarizeF222(actor.f222LayoutProbe),
    templateStreamProbe: summarizeTemplateProbe(actor.templateStreamProbe),
  };
}

function actorByRelOrImage(actors, relOrImage) {
  const text = String(relOrImage || "").toLowerCase();
  return actors.find((actor) => (
    actor.rel.toLowerCase() === text ||
    actor.name.toLowerCase() === text ||
    actor.primaryImage.toLowerCase() === text ||
    actor.primaryImageRel.toLowerCase() === text
  )) || null;
}

async function buildSceneAnchor(core, actors) {
  const sceneEntry = core.findResource(DEFAULT_ANCHOR_SCENE);
  if (!sceneEntry) return null;
  try {
    const runtime = await buildRuntimeSceneFromCore(core, sceneEntry.rel);
    return {
      scene: runtime.scene?.name || cleanName(sceneEntry.name),
      rel: sceneEntry.rel,
      canvas: runtime.scene?.canvas || null,
      map: runtime.scene?.map ? {
        name: runtime.scene.map.name,
        rel: runtime.scene.map.rel,
        tileset: runtime.scene.map.tileset,
        tilesetRel: runtime.scene.map.tilesetRel,
        drawCandidateCount: runtime.scene.map.renderHint?.drawCandidates?.length || 0,
        rleCandidateCount: runtime.scene.map.renderHint?.rleCandidates?.length || 0,
        note: "RLE grid remains diagnostic-only; draw-record/compositor semantics are the renderer target.",
      } : null,
      entities: (runtime.entities || []).map((entity) => {
        const match = actorByRelOrImage(actors, entity.actor?.rel || entity.actor?.primaryImageRel || entity.actor?.primaryImage);
        return {
          id: entity.id,
          x: entity.x,
          y: entity.y,
          actorRel: entity.actor?.rel || "",
          image: entity.actor?.primaryImage || "",
          logicStatus: match?.sheetInterpretation?.status || "",
          logicConfidence: match?.sheetInterpretation?.confidence || "",
        };
      }),
    };
  } catch (err) {
    return { scene: cleanName(sceneEntry.name), rel: sceneEntry.rel, error: err.message };
  }
}

function summarizeStats(actors) {
  const families = new Map();
  let staticSheetActors = 0;
  let positiveDelayActors = 0;
  let withDivider = 0;
  let withPictureTable = 0;
  let withF222 = 0;
  for (const actor of actors) {
    if (actor.imageInfo?.frames === 1 && !actor.imageInfo.positiveDelay) staticSheetActors += 1;
    if (actor.imageInfo?.positiveDelay) positiveDelayActors += 1;
    if (actor.stream.divider) {
      withDivider += 1;
      families.set(actor.stream.divider.family, (families.get(actor.stream.divider.family) || 0) + 1);
    }
    if (actor.pictureRefTableApprox?.recordCount) withPictureTable += 1;
    if (actor.f222Layout?.grid || actor.f222Layout?.matrixRead) withF222 += 1;
  }
  return {
    actorCount: actors.length,
    staticSheetActors,
    positiveDelayActors,
    withDivider,
    withPictureTable,
    withF222,
    dividerFamilies: Array.from(families, ([family, count]) => ({ family, count }))
      .sort((a, b) => b.count - a.count || a.family.localeCompare(b.family))
      .slice(0, 20),
  };
}

function tokenLine(token) {
  return `${token.offset}:${token.value}(${token.raw})`;
}

function textReport(report) {
  const lines = [];
  lines.push("# CBE Actor Logic Probe");
  lines.push("");
  lines.push(`input=${report.input}`);
  lines.push(`actors=${report.stats.actorCount} staticSheetActors=${report.stats.staticSheetActors} positiveDelayActors=${report.stats.positiveDelayActors}`);
  lines.push(`withDivider=${report.stats.withDivider} withPictureTable=${report.stats.withPictureTable} withF222=${report.stats.withF222}`);
  lines.push(`dividerFamilies=${report.stats.dividerFamilies.map((row) => `${row.family}:${row.count}`).join(" ")}`);
  lines.push("");
  lines.push("## Interpretation");
  lines.push("- GIF resources are treated as static texture atlases when they have one descriptor and 0cs control delay.");
  lines.push("- Actor motion must be driven by CBE actor/template records, engine timers, and VM state, not by GIF container animation.");
  lines.push("- The FF-heavy sentinel and compact tables are evidence targets; they are not yet promoted as a complete animation grammar.");
  lines.push("");
  if (report.sceneAnchor) {
    lines.push("## Scene Anchor");
    lines.push(`scene=${report.sceneAnchor.scene} rel=${report.sceneAnchor.rel} canvas=${report.sceneAnchor.canvas ? `${report.sceneAnchor.canvas.width}x${report.sceneAnchor.canvas.height}` : "-"}`);
    if (report.sceneAnchor.map) {
      lines.push(`map=${report.sceneAnchor.map.name} tileset=${report.sceneAnchor.map.tileset || "-"} drawCandidates=${report.sceneAnchor.map.drawCandidateCount} rleCandidates=${report.sceneAnchor.map.rleCandidateCount}`);
      lines.push(`mapNote=${report.sceneAnchor.map.note}`);
    }
    for (const entity of report.sceneAnchor.entities || []) {
      lines.push(`entity=${entity.id} image=${entity.image || "-"} @${entity.x},${entity.y} logic=${entity.logicStatus || "-"} confidence=${entity.logicConfidence || "-"}`);
    }
    lines.push("");
  }
  lines.push("## Focus Actors");
  for (const actor of report.focusActors) {
    const info = actor.imageInfo;
    lines.push(`### ${actor.name}`);
    lines.push(`image=${actor.primaryImage || "-"} rel=${actor.primaryImageRel || "-"} size=${info ? `${info.width}x${info.height}` : "-"} frames=${info?.frames ?? "-"} delays=${(info?.uniqueDelaysCentiseconds || []).join(",") || "-"}`);
    lines.push(`logic=${actor.sheetInterpretation.status} confidence=${actor.sheetInterpretation.confidence}`);
    for (const reason of actor.sheetInterpretation.reasons) lines.push(`- ${reason}`);
    const div = actor.stream.divider;
    lines.push(`stream=${actor.stream.offset} len=${actor.stream.length} divider=${div ? `${div.markerBytes} @ ${div.offset} pre=${div.preDataLength} post=${div.postLength}` : "-"}`);
    lines.push(`preTokens=${actor.stream.preStats.tokenCount} range=${actor.stream.preStats.min}..${actor.stream.preStats.max} tags=${actor.stream.preStats.tagCounts.map((row) => `${row.tag}:${row.count}`).join(" ")}`);
    if (actor.stream.postStats) lines.push(`postTokens=${actor.stream.postStats.tokenCount} range=${actor.stream.postStats.min}..${actor.stream.postStats.max} negatives=${actor.stream.postStats.negativeCount} highPositive=${actor.stream.postStats.highPositiveCount} tags=${actor.stream.postStats.tagCounts.map((row) => `${row.tag}:${row.count}`).join(" ")}`);
    if (actor.pictureRefTableApprox) {
      const table = actor.pictureRefTableApprox;
      lines.push(`pictureRefApprox=count:${table.count} records:${table.recordCount} complete:${table.complete} after:${table.afterRecordsOffset} imageHit=${table.image?.valuesWithinImagePercent ?? "-"}%`);
      for (const record of (table.records || []).slice(0, 5)) lines.push(`  ref#${record.index} ${record.offset} values=${record.values.join(",")} raw=${record.raw}`);
    }
    if (actor.f222Layout) {
      const f = actor.f222Layout;
      const grid = f.grid ? `extent=${f.grid.extentW}x${f.grid.extentH} cell=${f.grid.cellW}x${f.grid.cellH} ceil=${f.grid.ceilColumns}x${f.grid.ceilRows}/${f.grid.ceilCells}` : "-";
      lines.push(`f222=count:${f.count} complete=${f.tableComplete} fields=${f.fieldsOffset} matrix=${f.matrixRead}/${f.matrixExpected ?? "-"} end=${f.matrixEndOffset} bytesToFf=${f.bytesToFfCandidate ?? "-"} ${grid}`);
      lines.push(`f222MatrixHead=${(f.firstMatrixTokens || []).slice(0, 8).map(tokenLine).join(" ") || "-"}`);
    }
    lines.push(`firstTokens=${actor.stream.firstTokens.slice(0, 12).map(tokenLine).join(" ")}`);
    lines.push(`postTokens=${actor.stream.postTokens.slice(0, 12).map(tokenLine).join(" ") || "-"}`);
    lines.push("");
  }
  return lines.join("\n");
}

async function probe(input, outDir) {
  const core = new CbeRuntimeCore({ input });
  const catalog = publicCatalogForStruct(core);
  const actors = core.listResources({ ext: ".actor" }).map((entry) => analyzeActor(core, catalog, entry));
  const focusActors = DEFAULT_FOCUS_ACTORS
    .map((name) => actors.find((actor) => actor.name.toLowerCase() === name.toLowerCase()))
    .filter(Boolean);
  const sceneAnchor = await buildSceneAnchor(core, actors);
  const report = {
    schema: "nicai.cbe.actorLogicProbe.v1",
    generatedAt: new Date().toISOString(),
    input: core.input,
    stats: summarizeStats(actors),
    sceneAnchor,
    focusActors,
    actors,
  };
  await fsp.mkdir(outDir, { recursive: true });
  await fsp.writeFile(path.join(outDir, "actor_logic_probe.json"), JSON.stringify(report, null, 2), "utf8");
  await fsp.writeFile(path.join(outDir, "actor_logic_probe.md"), textReport(report), "utf8");
  return report;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    usage();
    return;
  }
  const input = path.resolve(args[0] || DEFAULT_INPUT);
  const outDir = path.resolve(args[1] || DEFAULT_OUT);
  const report = await probe(input, outDir);
  console.log("cbe-actor-logic-probe-ready");
  console.log(`Input: ${report.input}`);
  console.log(`Output: ${outDir}`);
  console.log(`Actors: ${report.stats.actorCount}`);
  console.log(`Static sheet actors: ${report.stats.staticSheetActors}`);
  console.log(`With divider: ${report.stats.withDivider}`);
  console.log(`With picture table: ${report.stats.withPictureTable}`);
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
