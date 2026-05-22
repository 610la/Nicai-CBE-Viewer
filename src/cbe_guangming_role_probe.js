const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { CbeRuntimeCore } = require("./cbe_runtime_core");
const { cleanName } = require("./cbe_profile");
const { parseGifInfoBuffer, summarizeBuffer } = require("./cbe_struct");

const DEFAULT_INPUT = path.resolve(__dirname, "..", "cbe file", "众神之战.CBE");
const DEFAULT_SYMBOLS = path.resolve(process.cwd(), "out_godwar_symbols_current", "cbe_symbols.json");
const DEFAULT_OUT = path.resolve(process.cwd(), "out_cbe_guangming_role");

const TARGET_IMAGE = "guangming.gif";
const LIGHT_HANDLER = {
  command: "LOADLIGHTGOD",
  target: 0x0000698A,
  stringLoads: [
    { label: "light-skill-actor-global", ldr: 0x0000698E, add: 0x00006990 },
    { label: "light-role-actor-load-call", ldr: 0x000069AC, add: 0x000069AE },
  ],
};

function hex(value, width = 8) {
  return `0x${(value >>> 0).toString(16).toUpperCase().padStart(width, "0")}`;
}

function readCString(buf, offset, limit = 96) {
  if (offset < 0 || offset >= buf.length) return "";
  let end = offset;
  while (end < buf.length && end - offset < limit && buf[end] >= 0x20 && buf[end] <= 0x7e) end += 1;
  return buf.subarray(offset, end).toString("ascii");
}

function isResourceString(text) {
  return /\.(actor|gif|map|mp3|sce|xse)$/i.test(text || "");
}

function literalPoolCandidates(ldrAddress, addAddress) {
  return [
    { poolBaseKind: "addr+2", poolBase: ldrAddress + 2 },
    { poolBaseKind: "addr+4", poolBase: ldrAddress + 4 },
    { poolBaseKind: "thumb-align", poolBase: (ldrAddress + 4) & ~3 },
  ].flatMap((poolBase) => ([
    { ...poolBase, addPcKind: "addr+2", addPc: addAddress + 2 },
    { ...poolBase, addPcKind: "addr+4", addPc: addAddress + 4 },
    { ...poolBase, addPcKind: "thumb-align", addPc: (addAddress + 4) & ~3 },
  ]));
}

function decodeThumbLiteralString(buf, load) {
  const halfword = buf.readUInt16LE(load.ldr);
  const immBytes = (halfword & 0xff) * 4;
  const rows = [];
  for (const candidate of literalPoolCandidates(load.ldr, load.add)) {
    const poolOffset = candidate.poolBase + immBytes;
    if (poolOffset < 0 || poolOffset + 4 > buf.length) continue;
    const raw = buf.readInt32LE(poolOffset);
    const targetOffset = (candidate.addPc + raw) >>> 0;
    const text = readCString(buf, targetOffset);
    rows.push({
      poolBaseKind: candidate.poolBaseKind,
      addPcKind: candidate.addPcKind,
      poolOffset: hex(poolOffset),
      rawOffset: hex(raw),
      signedRawOffset: raw,
      targetOffset: hex(targetOffset),
      text,
      resourceLike: isResourceString(text),
    });
  }
  rows.sort((a, b) => Number(b.resourceLike) - Number(a.resourceLike) || b.text.length - a.text.length);
  return {
    label: load.label,
    ldr: hex(load.ldr),
    add: hex(load.add),
    halfword: hex(halfword, 4),
    immBytes,
    selected: rows.find((row) => row.resourceLike) || rows[0] || null,
    candidates: rows,
  };
}

function gifInfo(core, name) {
  const entry = core.findResource(name);
  if (!entry) return null;
  const resource = core.readResource(entry);
  const info = parseGifInfoBuffer(resource.fixed);
  return {
    name: cleanName(entry.name),
    rel: entry.rel,
    width: info.width,
    height: info.height,
    frames: info.frames,
    graphicControls: info.graphicControls,
    delaysCentiseconds: info.delaysCentiseconds || [],
    uniqueDelaysCentiseconds: info.uniqueDelaysCentiseconds || [],
    sheetLike: info.sheetLike,
    imageDescriptors: info.imageDescriptors || [],
  };
}

function actorSummary(core, catalog, entry) {
  const resource = core.readResource(entry);
  const first = summarizeBuffer(entry.name, resource.fixed, { catalog, source: "raw-cbe-core" });
  const actor = first.specific?.actor || {};
  let imageInfo = null;
  if (actor.primaryImageRel || actor.primaryImage) {
    const imageEntry = core.findResource(actor.primaryImageRel || actor.primaryImage);
    if (imageEntry) {
      const imageResource = core.readResource(imageEntry);
      imageInfo = parseGifInfoBuffer(imageResource.fixed);
    }
  }
  return {
    actor: cleanName(entry.name),
    rel: entry.rel,
    primaryImage: actor.primaryImage || "",
    primaryImageRel: actor.primaryImageRel || "",
    streamOffset: actor.streamOffset || "",
    streamLength: actor.streamLength || "",
    image: imageInfo ? {
      width: imageInfo.width,
      height: imageInfo.height,
      frames: imageInfo.frames,
      uniqueDelaysCentiseconds: imageInfo.uniqueDelaysCentiseconds || [],
      sheetLike: imageInfo.sheetLike,
    } : null,
    f222: actor.f222LayoutProbe ? {
      tableMethod: actor.f222LayoutProbe.tableMethod,
      recordStride: actor.f222LayoutProbe.recordStride,
      count: actor.f222LayoutProbe.count,
      fieldsOffset: actor.f222LayoutProbe.fieldsOffset,
      fields: actor.f222LayoutProbe.fields || [],
      grid: actor.f222LayoutProbe.grid || null,
      matrixRead: actor.f222LayoutProbe.matrixRead,
      matrixExpected: actor.f222LayoutProbe.matrixExpected,
      matrixEndOffset: actor.f222LayoutProbe.matrixEndOffset,
      bytesToFfCandidate: actor.f222LayoutProbe.bytesToFfCandidate,
      note: actor.f222LayoutProbe.note,
    } : null,
  };
}

function findRawStringOccurrences(buf, needle) {
  const needleBuf = Buffer.from(needle, "ascii");
  const rows = [];
  let offset = buf.indexOf(needleBuf);
  while (offset >= 0) {
    const before = readCString(buf, Math.max(0, offset - 24), 24);
    const after = readCString(buf, offset, 64);
    const previousByte = offset > 0 ? buf[offset - 1] : null;
    const nextByte = offset + needle.length < buf.length ? buf[offset + needle.length] : null;
    const previousIsNameByte = previousByte != null && (
      (previousByte >= 0x30 && previousByte <= 0x39) ||
      (previousByte >= 0x41 && previousByte <= 0x5a) ||
      (previousByte >= 0x61 && previousByte <= 0x7a) ||
      previousByte === 0x5f || previousByte === 0x2d || previousByte === 0x2e
    );
    const nextIsNameByte = nextByte != null && (
      (nextByte >= 0x30 && nextByte <= 0x39) ||
      (nextByte >= 0x41 && nextByte <= 0x5a) ||
      (nextByte >= 0x61 && nextByte <= 0x7a) ||
      nextByte === 0x5f || nextByte === 0x2d || nextByte === 0x2e
    );
    const standalone = (
      !previousIsNameByte &&
      !nextIsNameByte &&
      (
        after === needle ||
        after.startsWith(`${needle}\0`) ||
        (previousByte === needle.length && after.startsWith(needle))
      )
    );
    rows.push({
      offset: hex(offset),
      previousByte: previousByte == null ? null : hex(previousByte, 2),
      nextByte: nextByte == null ? null : hex(nextByte, 2),
      textAtOffset: after,
      leftContext: before,
      standalone,
      classification: standalone
        ? "standalone-resource-name-or-catalog-entry"
        : "substring-or-neighboring-resource-name",
    });
    offset = buf.indexOf(needleBuf, offset + 1);
  }
  return rows;
}

function symbolsForTarget(symbols, target) {
  const rows = Array.isArray(symbols.resources) ? symbols.resources : [];
  return rows.filter((row) => String(row.text || "").toLowerCase().includes(target.replace(/\.gif$/i, "")));
}

function buildCatalogForStruct(core) {
  return core.catalog.map((entry) => ({
    ...entry,
    base: cleanName(entry.name),
  }));
}

async function probe(input, outDir, symbolsPath = DEFAULT_SYMBOLS) {
  const core = new CbeRuntimeCore({ input });
  const raw = fs.readFileSync(core.input);
  const catalog = buildCatalogForStruct(core);
  const symbols = fs.existsSync(symbolsPath) ? JSON.parse(fs.readFileSync(symbolsPath, "utf8")) : {};

  const targetImageInfo = gifInfo(core, TARGET_IMAGE);
  const actors = core.listResources({ ext: ".actor" }).map((entry) => actorSummary(core, catalog, entry));
  const exactActorRefs = actors.filter((actor) => cleanName(actor.primaryImage).toLowerCase() === TARGET_IMAGE);
  const lightFamilyActors = actors.filter((actor) => (
    /guangming|guangmin/i.test(actor.actor) ||
    /guangming|guangmin/i.test(actor.primaryImage) ||
    /guangming|guangmin/i.test(actor.primaryImageRel)
  ));

  const report = {
    schema: "nicai.cbe.guangmingRoleProbe.v1",
    generatedAt: new Date().toISOString(),
    input: core.input,
    target: {
      image: TARGET_IMAGE,
      info: targetImageInfo,
      directActorReferenceCount: exactActorRefs.length,
      directActorReferences: exactActorRefs,
    },
    loadLightGod: {
      command: LIGHT_HANDLER.command,
      target: hex(LIGHT_HANDLER.target),
      selectedResourceStrings: LIGHT_HANDLER.stringLoads.map((load) => decodeThumbLiteralString(raw, load)),
      interpretation: [
        "The script command handler resolves light-side runtime resources through actor resources, not by drawing guangming.gif directly.",
        "The first selected string is the light skill actor; the second selected string is the light role actor passed into the loader call.",
      ],
    },
    guangmingRawStringOccurrences: findRawStringOccurrences(raw, TARGET_IMAGE),
    symbolResourceNameHits: symbolsForTarget(symbols, TARGET_IMAGE),
    lightFamilyActors,
    conclusion: {
      status: exactActorRefs.length === 0 ? "target-gif-is-not-currently-actor-bound" : "target-gif-has-actor-bindings",
      nextEngineStep: exactActorRefs.length === 0
        ? "Trace hidden resource-index/record references or promote LOADLIGHTGOD -> guangmingshen.actor as the original playable light-role path before composing a character frame."
        : "Use the referenced actor stream and PictureLibrary/0x0F222 records to compose the first frame.",
    },
  };

  await fsp.mkdir(outDir, { recursive: true });
  await fsp.writeFile(path.join(outDir, "guangming_role_probe.json"), JSON.stringify(report, null, 2), "utf8");
  await fsp.writeFile(path.join(outDir, "guangming_role_probe.md"), textReport(report), "utf8");
  return report;
}

function textReport(report) {
  const lines = [];
  lines.push("# CBE Guangming Role Probe");
  lines.push("");
  lines.push(`input=${report.input}`);
  lines.push(`target=${report.target.image}`);
  if (report.target.info) {
    const info = report.target.info;
    lines.push(`targetInfo=rel:${info.rel} size:${info.width}x${info.height} frames:${info.frames} delays:${info.uniqueDelaysCentiseconds.join(",") || "-"} sheetLike:${info.sheetLike}`);
  }
  lines.push(`directActorReferenceCount=${report.target.directActorReferenceCount}`);
  lines.push(`status=${report.conclusion.status}`);
  lines.push("");
  lines.push("## LOADLIGHTGOD Evidence");
  lines.push(`handler=${report.loadLightGod.target}`);
  for (const load of report.loadLightGod.selectedResourceStrings) {
    const row = load.selected || {};
    lines.push(`- ${load.label}: ${row.text || "-"} target=${row.targetOffset || "-"} pool=${row.poolOffset || "-"} poolBase=${row.poolBaseKind || "-"} addPc=${row.addPcKind || "-"}`);
  }
  lines.push("");
  lines.push("## Exact guangming.gif Occurrences");
  for (const row of report.guangmingRawStringOccurrences) {
    lines.push(`- ${row.offset} ${row.classification} standalone=${row.standalone} text=${JSON.stringify(row.textAtOffset)}`);
  }
  lines.push("");
  lines.push("## Light-Family Actors");
  for (const actor of report.lightFamilyActors) {
    const image = actor.image ? `${actor.image.width}x${actor.image.height} frames=${actor.image.frames}` : "-";
    lines.push(`- ${actor.actor} -> ${actor.primaryImage || "-"} rel=${actor.primaryImageRel || "-"} image=${image}`);
  }
  lines.push("");
  lines.push("## Conclusion");
  lines.push(`- ${report.conclusion.nextEngineStep}`);
  return lines.join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    console.log("Usage: node src/cbe_guangming_role_probe.js [input.CBE] [out_dir] [symbols.json]");
    return;
  }
  const input = path.resolve(args[0] || DEFAULT_INPUT);
  const outDir = path.resolve(args[1] || DEFAULT_OUT);
  const symbolsPath = path.resolve(args[2] || DEFAULT_SYMBOLS);
  const report = await probe(input, outDir, symbolsPath);
  console.log("cbe-guangming-role-probe-ready");
  console.log(`Input: ${report.input}`);
  console.log(`Output: ${outDir}`);
  console.log(`Target: ${report.target.image}`);
  console.log(`Direct actor refs: ${report.target.directActorReferenceCount}`);
  for (const load of report.loadLightGod.selectedResourceStrings) {
    console.log(`${load.label}: ${load.selected?.text || "-"}`);
  }
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
