const fs = require("fs");
const path = require("path");
const { DEFAULT_INPUT, fixupPayload, loadCbeArchive } = require("./cbe_unpack");
const { hexBytes, parseResourceEnvelope, probe112C4ResourceBuffer } = require("./cbe_struct");

const DEFAULT_OUT = path.resolve(__dirname, "out_godwar_providerreplay");
const PROVIDER_SERVICE_JSON = path.resolve(__dirname, "out_godwar_xseprovidersvc", "xse_provider_service_trace.json");

function hex(n, width = 4) {
  if (!Number.isFinite(n) || n < 0) return "";
  return `0x${n.toString(16).toUpperCase().padStart(width, "0")}`;
}

function cleanName(name) {
  return path.basename(String(name || "").replace(/\\/g, "/")).replace(/^[0-9]{4}_/, "");
}

function normalizeName(name) {
  return cleanName(name).toLowerCase();
}

function findEntry(archive, name) {
  const target = normalizeName(name);
  return archive.entries.find((entry) => normalizeName(entry.name) === target) || null;
}

function readResource(archive, entry) {
  const raw = archive.rawPayload(entry);
  const fixed = fixupPayload(entry.name, raw);
  return {
    raw,
    fixed: fixed.payload,
    fixupNote: fixed.note || "",
  };
}

function readProviderSummary(file = PROVIDER_SERVICE_JSON) {
  try {
    const trace = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      available: true,
      assignments: (trace.providerAssignments || []).map((item) => ({
        global: item.globalHex,
        source: item.expression,
        role: item.emulatorRole,
        store: item.storeHex,
      })),
      conclusion: trace.conclusion || {},
    };
  } catch (err) {
    return {
      available: false,
      reason: err.message || String(err),
      assignments: [],
      conclusion: {},
    };
  }
}

function openResourceStream(resource) {
  return {
    service: "[sb+0x35C4]+0x40",
    raw: resource.fixed,
    envelope: parseResourceEnvelope(resource.fixed),
  };
}

function convertOpenedStream(opened) {
  const buf = opened.raw;
  const body = opened.envelope.bodyOffset;
  const sceMagic = buf.indexOf(Buffer.from("SCE2", "ascii"));
  const xseMagic = buf.indexOf(Buffer.from("XSE0", "ascii"));
  const magicOffset = sceMagic >= 0 ? sceMagic : xseMagic;
  const baseOffset = magicOffset >= 0 ? magicOffset : body;
  return {
    service: "[sb+0x35C0]+0x50",
    raw: buf,
    baseOffset,
    baseOffsetHex: hex(baseOffset),
    magic: magicOffset >= 0 ? buf.subarray(magicOffset, magicOffset + 4).toString("ascii") : "",
    note: magicOffset >= 0
      ? "converted pointer lands at the resource magic, matching the SCE parser's explicit magic check"
      : "no known magic; converted pointer falls back to envelope body",
  };
}

function makeCursor(initial = 0) {
  return { value: initial, reads: [] };
}

function readU16LE(converted, cursor, role) {
  const offset = converted.baseOffset + cursor.value;
  if (offset + 2 > converted.raw.length) {
    throw new Error(`truncated u16 read at ${hex(offset)}`);
  }
  const value = converted.raw.readUInt16LE(offset);
  cursor.reads.push({
    service: "[sb+0x35C4]+0x4C",
    role,
    offset,
    offsetHex: hex(offset),
    cursorBefore: cursor.value,
    cursorBeforeHex: hex(cursor.value),
    bytes: hexBytes(converted.raw.subarray(offset, offset + 2)),
    value,
  });
  cursor.value += 2;
  return value;
}

function readLengthPrefixedAscii(converted, cursor, role) {
  const offset = converted.baseOffset + cursor.value;
  if (offset >= converted.raw.length) {
    throw new Error(`truncated ref length at ${hex(offset)}`);
  }
  const length = converted.raw[offset];
  const start = offset + 1;
  const end = start + length;
  if (end > converted.raw.length) {
    throw new Error(`truncated ref body at ${hex(start)}`);
  }
  const text = converted.raw.subarray(start, end).toString("ascii");
  cursor.reads.push({
    service: "[sb+0x35C4]+0x64",
    role,
    offset,
    offsetHex: hex(offset),
    cursorBefore: cursor.value,
    cursorBeforeHex: hex(cursor.value),
    length,
    text,
  });
  cursor.value += 1 + length;
  return text;
}

function replaySce(resource) {
  const opened = openResourceStream(resource);
  const converted = convertOpenedStream(opened);
  const cursor = makeCursor(converted.magic === "SCE2" ? 4 : 0);
  const width = readU16LE(converted, cursor, "scene width");
  const height = readU16LE(converted, cursor, "scene height");
  const mapCount = readU16LE(converted, cursor, "map count");
  const maps = [];
  for (let i = 0; i < mapCount && i < 8; i += 1) {
    const name = readLengthPrefixedAscii(converted, cursor, `map ${i} resource`);
    const fields = [
      readU16LE(converted, cursor, `map ${i} x/tile field 0`),
      readU16LE(converted, cursor, `map ${i} y/tile field 1`),
      readU16LE(converted, cursor, `map ${i} field 2`),
      readU16LE(converted, cursor, `map ${i} field 3`),
    ];
    maps.push({ name, fields });
  }
  return {
    status: converted.magic === "SCE2" && width > 0 && height > 0 && mapCount === maps.length
      ? "service-replay-ok"
      : "service-replay-suspicious",
    opened: {
      service: opened.service,
      bodyOffset: hex(opened.envelope.bodyOffset),
      prefixByte: hex(opened.raw[opened.envelope.bodyOffset], 2),
      first16: hexBytes(opened.raw.subarray(0, 16)),
    },
    converted,
    cursorStart: 4,
    fields: { width, height, mapCount },
    maps,
    reads: cursor.reads,
  };
}

function replayXse(resource) {
  const opened = openResourceStream(resource);
  const converted = convertOpenedStream(opened);
  const probe = probe112C4ResourceBuffer(resource.fixed, { resourceName: resource.name });
  const best = probe.best || {};
  return {
    status: "blocked-at-exact-plus50",
    opened: {
      service: opened.service,
      bodyOffset: hex(opened.envelope.bodyOffset),
      prefixByte: hex(opened.raw[opened.envelope.bodyOffset], 2),
      first32: hexBytes(opened.raw.subarray(0, 32)),
    },
    converted,
    currentProbe: {
      confidence: probe.confidence || "",
      reader: best.reader || "",
      groupCount: best.groupCount ?? null,
      totalRecords: best.totalRecords ?? null,
      knownOpcodePercent: best.knownOpcodePercent ?? null,
      warnings: best.warnings || [],
    },
    note: "Provider/open/convert provenance is now modeled, but the exact [sb+0x35C4]+0x50 cursor method is still missing, so XSE execution remains blocked.",
  };
}

function buildReport(options = {}) {
  const input = path.resolve(options.input || DEFAULT_INPUT);
  const archive = loadCbeArchive(input);
  const provider = readProviderSummary();
  const sceEntry = findEntry(archive, "guangmingshendian.sce");
  const xseEntry = findEntry(archive, "s_02.xse");
  if (!sceEntry || !xseEntry) throw new Error("focused SCE/XSE resources were not found in the raw CBE");
  const sceResource = { name: sceEntry.name, ...readResource(archive, sceEntry) };
  const xseResource = { name: xseEntry.name, ...readResource(archive, xseEntry) };
  const sceReplay = replaySce(sceResource);
  const xseReplay = replayXse(xseResource);
  return {
    schema: "nicai.cbe.providerServiceReplay.v1",
    generatedAt: new Date().toISOString(),
    input,
    provider,
    resources: {
      sce: sceEntry.name,
      xse: xseEntry.name,
    },
    replays: {
      sce: sceReplay,
      xse: xseReplay,
    },
    conclusion: {
      currentFinding: "The provider-derived service chain can replay the SCE parser far enough to recover the real scene dimensions and map reference from raw CBE bytes.",
      emulatorImpact: "This is the first runnable service-chain slice: provider +0x64 -> [35C4]+40 open, provider +0x5C -> [35C0]+50 conversion, then [35C4]+4C/+64 typed reads.",
      xseBlocker: "XSE still cannot be executed until [35C4]+50 cursor semantics are reproduced exactly; the current 0x112C4 probe remains a guardrail, not a VM.",
      nextTarget: "Implement the exact [35C4]+50 cursor method over the converted stream and re-run the 0x112C4 strict opcode gate.",
    },
  };
}

function mdRow(values) {
  return `| ${values.map((value) => String(value ?? "").replace(/\|/g, "\\|")).join(" | ")} |`;
}

function renderMarkdown(report) {
  const sce = report.replays.sce;
  const xse = report.replays.xse;
  const lines = [];
  lines.push("# Provider Service Replay Probe");
  lines.push("");
  lines.push(`- Input CBE: \`${report.input}\``);
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push("");
  lines.push("## Current Conclusion");
  lines.push("");
  lines.push(`- ${report.conclusion.currentFinding}`);
  lines.push(`- ${report.conclusion.emulatorImpact}`);
  lines.push(`- ${report.conclusion.xseBlocker}`);
  lines.push(`- Next: ${report.conclusion.nextTarget}`);
  lines.push("");
  lines.push("## Provider Assignments Used");
  lines.push("");
  if (!report.provider.available) {
    lines.push(`- Provider service trace unavailable: ${report.provider.reason}`);
  } else {
    for (const item of report.provider.assignments.filter((entry) => ["0x35C0", "0x35C4"].includes(entry.global))) {
      lines.push(`- ${item.global}: ${item.source} (${item.role})`);
    }
  }
  lines.push("");
  lines.push("## SCE Replay");
  lines.push("");
  lines.push(`- Status: ${sce.status}`);
  lines.push(`- Open: ${sce.opened.service}, body=${sce.opened.bodyOffset}, prefix=${sce.opened.prefixByte}`);
  lines.push(`- Convert: ${sce.converted.service}, base=${sce.converted.baseOffsetHex}, magic=${sce.converted.magic}`);
  lines.push(`- Fields: ${sce.fields.width}x${sce.fields.height}, maps=${sce.fields.mapCount}`);
  for (const item of sce.maps) {
    lines.push(`- Map: ${item.name}, fields=${item.fields.join(",")}`);
  }
  lines.push("");
  lines.push(mdRow(["Service", "Role", "Offset", "Bytes/Text", "Value"]));
  lines.push(mdRow(["---", "---", "---", "---", "---"]));
  for (const read of sce.reads) {
    lines.push(mdRow([read.service, read.role, read.offsetHex, read.text || read.bytes, read.value ?? ""]));
  }
  lines.push("");
  lines.push("## XSE Replay Guardrail");
  lines.push("");
  lines.push(`- Status: ${xse.status}`);
  lines.push(`- Convert: ${xse.converted.service}, base=${xse.converted.baseOffsetHex}, magic=${xse.converted.magic}`);
  lines.push(`- Current 0x112C4 probe: confidence=${xse.currentProbe.confidence}, reader=${xse.currentProbe.reader}, groups=${xse.currentProbe.groupCount}, records=${xse.currentProbe.totalRecords}, knownOpcode=${xse.currentProbe.knownOpcodePercent}%`);
  lines.push(`- ${xse.note}`);
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

function main(argv = process.argv.slice(2)) {
  const input = path.resolve(argv[0] || DEFAULT_INPUT);
  const outDir = path.resolve(argv[1] || DEFAULT_OUT);
  fs.mkdirSync(outDir, { recursive: true });
  const report = buildReport({ input });
  const jsonFile = path.join(outDir, "provider_service_replay_probe.json");
  const mdFile = path.join(outDir, "provider_service_replay_probe.md");
  writeJson(jsonFile, report);
  fs.writeFileSync(mdFile, renderMarkdown(report), "utf8");
  console.log(`wrote ${jsonFile}`);
  console.log(`wrote ${mdFile}`);
}

if (require.main === module) {
  main();
}

module.exports = {
  buildReport,
  renderMarkdown,
};
