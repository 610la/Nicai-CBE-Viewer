const fs = require("fs");
const path = require("path");
const { CbeRuntimeCore } = require("./cbe_runtime_core");
const { buildRuntimeSceneFromCore } = require("./cbe_runtime");

const DEFAULT_GAME_DIR = path.resolve(__dirname, "..", "nicai system files", ".system", "MB_MSTAR_WQVGA");
const DEFAULT_CBE = path.resolve(__dirname, "..", "cbe file", "众神之战.CBE");
const DEFAULT_OUT = path.resolve(process.cwd(), "out_godwar_record");

const RECORD_FILES = [
  "GodWarFileSizeRecord",
  "GodWarSceneRecord",
  "GodWarGameRecord",
];

function hex(value, width = 2) {
  return `0x${Number(value).toString(16).toUpperCase().padStart(width, "0")}`;
}

function bytesHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(" ");
}

function asciiPreview(bytes) {
  return Array.from(bytes, (byte) => (byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : ".")).join("");
}

function cStringAt(bytes, offset, limit = 96) {
  if (offset < 0 || offset >= bytes.length) return "";
  let end = offset;
  while (end < bytes.length && end - offset < limit && bytes[end] >= 0x20 && bytes[end] <= 0x7e) end += 1;
  return bytes.subarray(offset, end).toString("ascii");
}

function readU16List(bytes, base = 0) {
  const rows = [];
  for (let off = 0; off + 1 < bytes.length; off += 2) {
    rows.push({ offset: hex(base + off, 2), value: bytes.readUInt16LE(off) });
  }
  return rows;
}

function readByteList(bytes, base = 0) {
  return Array.from(bytes, (value, off) => ({ offset: hex(base + off, 2), value }));
}

function parseRecordBuffer(name, bytes) {
  if (bytes.length < 2) {
    return {
      name,
      size: bytes.length,
      status: "too-small",
      rawHex: bytesHex(bytes),
      fields: [],
    };
  }

  const fieldCount = bytes.readUInt16LE(0);
  let offset = 2;
  const fields = [];
  const errors = [];
  for (let index = 0; index < fieldCount; index += 1) {
    if (offset + 2 > bytes.length) {
      errors.push(`field ${index} missing length at ${hex(offset, 4)}`);
      break;
    }
    const lengthOffset = offset;
    const length = bytes.readUInt16LE(offset);
    offset += 2;
    if (offset + length > bytes.length) {
      errors.push(`field ${index} length ${length} exceeds file at ${hex(offset, 4)}`);
      fields.push({
        index,
        length,
        lengthOffset,
        valueOffset: offset,
        rawHex: bytesHex(bytes.subarray(offset)),
      });
      offset = bytes.length;
      break;
    }
    const value = bytes.subarray(offset, offset + length);
    fields.push({
      index,
      length,
      lengthOffset,
      valueOffset: offset,
      rawHex: bytesHex(value),
      ascii: asciiPreview(value),
      u8: length === 1 ? value[0] : null,
      u16le: length === 2 ? value.readUInt16LE(0) : null,
      i16le: length === 2 ? value.readInt16LE(0) : null,
      u32le: length === 4 ? value.readUInt32LE(0) : null,
      u16lePairs: length > 2 && length % 2 === 0 ? readU16List(value) : [],
    });
    offset += length;
  }

  return {
    name,
    size: bytes.length,
    status: errors.length ? "parse-warning" : (offset === bytes.length ? "parsed" : "parsed-with-trailing"),
    fieldCount,
    parsedBytes: offset,
    trailingBytes: Math.max(0, bytes.length - offset),
    errors,
    rawHex: bytesHex(bytes),
    fields,
  };
}

function findSceneSlot(field0) {
  let sceneOffset = -1;
  let sceneName = "";
  for (let start = 0; start < field0.value.length;) {
    while (start < field0.value.length && (field0.value[start] < 0x20 || field0.value[start] > 0x7e)) start += 1;
    let end = start;
    while (end < field0.value.length && field0.value[end] >= 0x20 && field0.value[end] <= 0x7e) end += 1;
    if (end > start) {
      const text = field0.value.subarray(start, end).toString("ascii");
      const match = /[A-Za-z0-9_./-]+\.sce/i.exec(text);
      if (match) {
        sceneOffset = start + match.index;
        sceneName = cStringAt(field0.value, sceneOffset, 64);
        break;
      }
    }
    start = end + 1;
  }
  if (sceneOffset < 0) return null;
  return {
    sceneName,
    sceneOffset,
    sceneOffsetHex: hex(field0.valueOffset + sceneOffset, 4),
    prefixLength: sceneOffset,
    prefixHex: bytesHex(field0.value.subarray(0, sceneOffset)),
    slotLength: field0.value.length - sceneOffset,
    slotHex: bytesHex(field0.value.subarray(sceneOffset)),
  };
}

function parseGodWarGameRecord(record) {
  const fields = record.fields.map((field) => {
    const value = Buffer.from(field.rawHex.split(" ").filter(Boolean).map((part) => parseInt(part, 16)));
    return { ...field, value };
  });
  const field0 = fields[0] || null;
  const sceneSlot = field0 ? findSceneSlot(field0) : null;
  const field0Prefix = field0 && sceneSlot ? field0.value.subarray(0, sceneSlot.sceneOffset) : Buffer.alloc(0);
  const alignedU16 = readU16List(field0Prefix);
  const bytes = readByteList(field0Prefix);
  const coordinateCandidates = [];
  if (field0Prefix.length >= 14) {
    coordinateCandidates.push({
      source: "field0 prefix aligned u16 pair @0x0A/0x0C",
      x: field0Prefix.readUInt16LE(0x0a),
      y: field0Prefix.readUInt16LE(0x0c),
      confidence: "candidate",
      reason: "two adjacent 16-bit values in the binary prefix before the scene filename",
    });
  }
  if (field0Prefix.length >= 19) {
    coordinateCandidates.push({
      source: "field0 prefix byte flag @0x0E then unaligned u16 pair @0x0F/0x11",
      flag: field0Prefix[0x0e],
      x: field0Prefix.readUInt16LE(0x0f),
      y: field0Prefix.readUInt16LE(0x11),
      confidence: "candidate",
      reason: "the prefix has a single byte followed by two little-endian coordinate-like words",
    });
  }

  const compactFields = fields.map((field) => {
    const value = field.value;
    const row = {
      index: field.index,
      fileLengthOffset: hex(field.lengthOffset, 4),
      fileValueOffset: hex(field.valueOffset, 4),
      length: field.length,
      hex: bytesHex(value),
      ascii: asciiPreview(value),
    };
    if (field.length === 1) row.u8 = value[0];
    if (field.length === 2) {
      row.u16le = value.readUInt16LE(0);
      row.i16le = value.readInt16LE(0);
    }
    if (field.length === 4) row.u32le = value.readUInt32LE(0);
    if (field.length > 1 && field.length <= 16) row.u16lePairs = readU16List(value);
    return row;
  });

  return {
    recordFormat: "u16 fieldCount, then fieldCount entries of u16 fieldLength + raw field bytes",
    constructorsFromGodWarRecordC: {
      gameRecord: {
        codeOffset: "default path 0x0002C6C4..0x0002C6CC; existing-save path 0x0002C6F4..0x0002C70A",
        recordFile: "GodWarGameRecord",
        defaultRecordSize: 0x9f,
        currentRecordSizeSource: "GodWarFileSizeRecord field 3",
        fieldCount: 15,
        note: "0x9F is the no-save default. The existing-save path reads the active size from GodWarFileSizeRecord; this phone save stores 163.",
      },
      sceneRecord: {
        codeOffset: "0x0002C50C..0x0002C522",
        recordFile: "GodWarSceneRecord",
        recordSize: 0x14,
        fieldCount: 6,
      },
      fileSizeRecord: {
        codeOffset: "0x0002C62E..0x0002C634",
        recordFile: "GodWarFileSizeRecord",
        recordSize: 0x1b,
        fieldCount: 6,
      },
    },
    fieldCount: record.fieldCount,
    fieldLengths: record.fields.map((field) => field.length),
    sceneSlot,
    field0Prefix: {
      length: field0Prefix.length,
      hex: bytesHex(field0Prefix),
      bytes,
      alignedU16,
      notes: [
        "The scene filename starts after a 19-byte binary prefix and occupies a 32-byte fixed slot in this save.",
        "Coordinate semantics are not proven yet; they need a second save made at a different position/scene.",
      ],
    },
    coordinateCandidates,
    fields: compactFields,
  };
}

async function resolveScene(cbePath, sceneName) {
  if (!sceneName) return null;
  const core = new CbeRuntimeCore({ input: cbePath });
  const sceneEntry = core.findResource(sceneName);
  if (!sceneEntry) {
    return {
      status: "scene-resource-not-found",
      sceneName,
      cbePath,
    };
  }
  const runtime = await buildRuntimeSceneFromCore(core, sceneEntry.rel, { game: "众神之战" });
  return {
    status: "scene-resource-resolved",
    cbePath,
    scene: {
      name: sceneEntry.name,
      rel: sceneEntry.rel,
      rawSize: sceneEntry.rawSize,
      canvas: runtime.scene?.canvas || null,
      map: runtime.scene?.map ? {
        name: runtime.scene.map.name,
        rel: runtime.scene.map.rel,
        tileset: runtime.scene.map.tileset,
        recordSource: runtime.scene.map.record?.source || "",
      } : null,
      scripts: (runtime.scene?.scripts || []).map((script) => ({
        name: script.name,
        rel: script.rel,
        evidence: script.evidence || script.source || "",
      })),
      entities: (runtime.entities || []).map((entity) => ({
        id: entity.id,
        name: entity.name,
        actor: entity.actor?.rel || entity.actorRel || "",
        actorRel: entity.actor?.rel || entity.actorRel || "",
        image: entity.actor?.primaryImage || entity.image || "",
        imageRel: entity.actor?.primaryImageRel || entity.imageRel || "",
        x: entity.x,
        y: entity.y,
        source: entity.source,
      })),
    },
  };
}

function mdRow(values) {
  return `| ${values.map((value) => String(value ?? "").replace(/\|/g, "\\|")).join(" | ")} |`;
}

function fieldValueSummary(field) {
  const parts = [`len=${field.length}`, `hex=${field.hex}`];
  if (field.ascii && /[A-Za-z0-9_.-]/.test(field.ascii)) parts.push(`ascii=${field.ascii}`);
  if (field.u8 != null) parts.push(`u8=${field.u8}`);
  if (field.u16le != null) parts.push(`u16=${field.u16le}`);
  if (field.u32le != null) parts.push(`u32=${field.u32le}`);
  return parts.join(" ");
}

function buildMarkdown(report) {
  const lines = [
    "# GodWar Record Probe",
    "",
    `gameDir=${report.gameDir}`,
    `cbe=${report.cbePath}`,
    "",
    "## Confirmed Format",
    "",
    "- All three GodWar record files use the same Record serializer: `u16 fieldCount`, then repeated `u16 fieldLength + raw field bytes`.",
    "- `GodWar_Record.c` constructs `GodWarGameRecord` with a no-save default size of `0x9F` and `fieldCount=15`; the existing-save path reads the active size from `GodWarFileSizeRecord`, whose field 3 is `163` for this phone save.",
    "- `GodWarSceneRecord` is a six-field compact flag/state record; the current phone save has all six values at zero.",
    "",
    "## FileSizeRecord",
    "",
    mdRow(["field", "offset", "summary"]),
    mdRow(["---", "---", "---"]),
  ];

  for (const field of report.records.GodWarFileSizeRecord.fields) {
    lines.push(mdRow([field.index, field.fileValueOffset || hex(field.valueOffset, 4), fieldValueSummary(field)]));
  }

  lines.push(
    "",
    "## GameRecord Fields",
    "",
    mdRow(["field", "offset", "summary"]),
    mdRow(["---", "---", "---"]),
  );
  for (const field of report.gameRecord.fields) {
    lines.push(mdRow([field.index, field.fileValueOffset, fieldValueSummary(field)]));
  }

  const slot = report.gameRecord.sceneSlot;
  lines.push("", "## Scene Slot", "");
  if (slot) {
    lines.push(
      `- scene=${slot.sceneName}`,
      `- field0 scene offset=${hex(slot.sceneOffset, 2)} / file offset=${slot.sceneOffsetHex}`,
      `- binary prefix length=${slot.prefixLength}; fixed scene-name slot length=${slot.slotLength}`,
      `- prefix=${slot.prefixHex}`,
    );
  } else {
    lines.push("- no `.sce` string found in field0");
  }

  lines.push("", "## Field0 Prefix Candidates", "");
  lines.push(mdRow(["kind", "value"]));
  lines.push(mdRow(["---", "---"]));
  for (const row of report.gameRecord.field0Prefix.alignedU16) {
    lines.push(mdRow([`u16 ${row.offset}`, row.value]));
  }
  for (const candidate of report.gameRecord.coordinateCandidates) {
    lines.push(mdRow([candidate.source, `x=${candidate.x} y=${candidate.y}${candidate.flag != null ? ` flag=${candidate.flag}` : ""}`]));
  }

  lines.push("", "## Resolved Runtime Scene", "");
  if (report.sceneResolution?.status === "scene-resource-resolved") {
    const scene = report.sceneResolution.scene;
    lines.push(
      `- sceneRel=${scene.rel}`,
      `- canvas=${scene.canvas ? `${scene.canvas.width}x${scene.canvas.height}` : "-"}`,
      `- map=${scene.map?.name || "-"} rel=${scene.map?.rel || "-"} tileset=${scene.map?.tileset || "-"}`,
      `- scripts=${scene.scripts.map((script) => script.name).join(", ") || "-"}`,
      `- entities=${scene.entities.length}`,
    );
    for (const entity of scene.entities) {
      lines.push(`  - ${entity.name || entity.id}: actor=${entity.actor || "-"} image=${entity.image || "-"} pos=${entity.x},${entity.y}`);
    }
  } else {
    lines.push(`- ${report.sceneResolution?.status || "not resolved"}`);
  }

  lines.push(
    "",
    "## Next Diff Needed",
    "",
    "- One more `GodWarGameRecord` captured after moving the player, changing scene, or changing HP/money would immediately label most of field0's binary prefix.",
    "- Until then, the scene filename slot is confirmed, while position/stat semantics remain candidates.",
  );

  return `${lines.join("\n")}\n`;
}

async function buildReport(options = {}) {
  const gameDir = path.resolve(options.gameDir || DEFAULT_GAME_DIR);
  const cbePath = path.resolve(options.cbePath || DEFAULT_CBE);
  const outDir = path.resolve(options.outDir || DEFAULT_OUT);
  const records = {};
  for (const name of RECORD_FILES) {
    const file = path.join(gameDir, name);
    const parsed = parseRecordBuffer(name, fs.readFileSync(file));
    records[name] = {
      ...parsed,
      path: file,
      fields: parsed.fields.map((field) => ({
        index: field.index,
        fileLengthOffset: hex(field.lengthOffset, 4),
        fileValueOffset: hex(field.valueOffset, 4),
        length: field.length,
        hex: field.rawHex,
        ascii: field.ascii,
        u8: field.u8,
        u16le: field.u16le,
        i16le: field.i16le,
        u32le: field.u32le,
        u16lePairs: field.u16lePairs,
      })),
    };
  }

  const gameRecordParsed = parseGodWarGameRecord(parseRecordBuffer(
    "GodWarGameRecord",
    fs.readFileSync(path.join(gameDir, "GodWarGameRecord")),
  ));
  const sceneResolution = await resolveScene(cbePath, gameRecordParsed.sceneSlot?.sceneName || "");
  const report = {
    schema: "nicai.godwar.recordProbe.v1",
    generatedAt: new Date().toISOString(),
    gameDir,
    cbePath,
    records,
    gameRecord: gameRecordParsed,
    sceneResolution,
    conclusions: [
      "GodWarGameRecord is parsed as a 15-field serialized Record file, not an opaque fixed C struct.",
      "The current save points to guangmingshendian.sce inside field0's 32-byte scene-name slot.",
      "GodWarFileSizeRecord confirms current GodWarGameRecord length 163 and GodWarSceneRecord length 20.",
      "Player/camera/stat fields need a second save diff before promotion from candidates to emulator state semantics.",
    ],
  };

  await fs.promises.mkdir(outDir, { recursive: true });
  await fs.promises.writeFile(path.join(outDir, "godwar_record_probe.json"), JSON.stringify(report, null, 2), "utf8");
  await fs.promises.writeFile(path.join(outDir, "godwar_record_probe.md"), buildMarkdown(report), "utf8");
  return report;
}

async function main() {
  const args = process.argv.slice(2);
  const report = await buildReport({
    gameDir: args[0] || DEFAULT_GAME_DIR,
    cbePath: args[1] || DEFAULT_CBE,
    outDir: args[2] || DEFAULT_OUT,
  });
  console.log(`Output: ${path.join(DEFAULT_OUT, "godwar_record_probe.md")}`);
  console.log(`GodWarGameRecord fields: ${report.gameRecord.fieldCount} lengths=${report.gameRecord.fieldLengths.join(",")}`);
  console.log(`Scene: ${report.gameRecord.sceneSlot?.sceneName || "-"}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.stack || err.message || String(err));
    process.exitCode = 1;
  });
}

module.exports = {
  parseRecordBuffer,
  parseGodWarGameRecord,
  buildReport,
};
