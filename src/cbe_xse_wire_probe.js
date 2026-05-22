const fs = require("fs");
const path = require("path");
const { DEFAULT_INPUT, fixupPayload, loadCbeArchive } = require("./cbe_unpack");
const {
  asciiRuns,
  decodeCompactToken,
  hexBytes,
  parseResourceEnvelope,
  probe112C4ResourceBuffer,
  scanTextRuns,
} = require("./cbe_struct");

const DEFAULT_OUT = path.resolve(__dirname, "out_godwar_xsewire");
const DEFAULT_HANDLER_JSON = path.resolve(__dirname, "out_godwar_scripthandlers", "script_handler_trace.json");
const FOCUS = ["s_01.xse", "s_02.xse", "s_03.xse", "s_04.xse"];
const REF_RE = /\.(?:actor|gif|map|sce|xse|mp3)\b/i;
const FRAGMENT_ALIASES = [
  ["LIGHTGOD", "LOADLIGHTGOD"],
  ["DARKGOD", "LOADDARKGOD"],
  ["MONSTER", "LOADMONSTER"],
  ["RAMODE", "SETCAMERAMODE"],
  ["SCREENSIZE", "GETSCREENSIZE"],
  ["RTDIALOG", "STARTDIALOG"],
  ["SHOW", "SHOWDIALOG"],
  ["ROLEPOS", "SETROLEPOS"],
  ["MOVETO", "ROLEMOVETO"],
  ["ONWUDI", "ROLEONWUDI"],
  ["ATTACK", "ROLEATTACK"],
  ["SKILL", "ROLESKILL"],
  ["ISF", "ISFINISHSKILL"],
  ["OPENCR", "OPENCR"],
  ["SWORD", "SETROLESWORD"],
  ["HUR", "HURTROLE"],
  ["CHANG", "CHANGESCENE"],
  ["ENE", "CHANGESCENE"],
  ["END", "ENDSCRIPT"],
  ["CR", "OPENCR"],
  ["DARK", "LOADDARKGOD"],
  ["LIGHT", "LOADLIGHTGOD"],
];

function hex(n, width = 4) {
  if (!Number.isFinite(n) || n < 0) return "";
  return `0x${n.toString(16).toUpperCase().padStart(width, "0")}`;
}

function byteHex(value) {
  return hex(value, 2);
}

function cleanName(name) {
  return path.basename(String(name || "").replace(/\\/g, "/")).replace(/^[0-9]{4}_/, "");
}

function normalizeName(name) {
  return cleanName(name).toLowerCase();
}

function extOf(name) {
  return path.extname(name || "").toLowerCase();
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

function loadHandlerTable(file = DEFAULT_HANDLER_JSON) {
  try {
    const report = JSON.parse(fs.readFileSync(file, "utf8"));
    const commands = (report.commands || []).map((command) => {
      const reads = (command.callsFromBlock || [])
        .filter((call) => call.kind && call.kind !== "vm-advance" && call.kind !== "vm-branch/result")
        .map((call) => ({
          kind: call.kind,
          slot: call.slot,
          argIndex: call.argIndex,
        }));
      const controls = (command.callsFromBlock || [])
        .filter((call) => call.kind === "vm-advance" || call.kind === "vm-branch/result")
        .map((call) => ({
          kind: call.kind,
          slot: call.slot,
          argIndex: call.argIndex,
        }));
      return {
        name: command.name,
        target: command.target,
        reads,
        controls,
      };
    });
    const byName = new Map(commands.map((command) => [command.name, command]));
    return {
      file,
      commandCount: commands.length,
      commands,
      byName,
      names: commands.map((command) => command.name).sort((a, b) => b.length - a.length || a.localeCompare(b)),
    };
  } catch (err) {
    return { file, error: err.message || String(err), commandCount: 0, commands: [], byName: new Map(), names: [] };
  }
}

function isUsefulText(text) {
  const value = String(text || "");
  const chinese = (value.match(/[\u3400-\u4dbf\u4e00-\u9fff]/gu) || []).length;
  return REF_RE.test(value) || chinese >= 3 || value.includes("[") || value.includes("]");
}

function detectPools(buf) {
  const initOffset = buf.indexOf(Buffer.from("INIT", "ascii"));
  const mainOffset = buf.indexOf(Buffer.from("_MAIN", "ascii"));
  const symbolPoolStart = initOffset >= 0 ? initOffset : mainOffset;
  const symbolSearchEnd = symbolPoolStart >= 0 ? symbolPoolStart : buf.length;
  const textRuns = scanTextRuns(buf, 3, 1000)
    .filter((run) => run.offset < symbolSearchEnd && isUsefulText(run.text))
    .map((run) => ({ offset: run.offset, offsetHex: hex(run.offset), text: run.text }));
  const refs = asciiRuns(buf, 3, 1000)
    .filter((run) => REF_RE.test(run.text))
    .map((run) => ({ offset: run.offset, offsetHex: hex(run.offset), text: run.text }));
  return {
    textPoolStart: textRuns[0]?.offset ?? -1,
    textPoolStartHex: hex(textRuns[0]?.offset ?? -1),
    symbolPoolStart,
    symbolPoolStartHex: hex(symbolPoolStart),
    initOffset,
    initOffsetHex: hex(initOffset),
    mainOffset,
    mainOffsetHex: hex(mainOffset),
    refs,
    textRuns,
  };
}

function compactPreview(buf, start, end, limit = 24) {
  const out = [];
  let cursor = Math.max(0, start);
  const stop = Math.min(buf.length, end);
  while (cursor < stop && out.length < limit) {
    const token = decodeCompactToken(buf, cursor);
    if (!token) break;
    out.push({
      offset: hex(token.offset),
      raw: token.raw,
      tag: token.tag,
      value: token.value,
      unsigned32: token.unsigned32 ?? null,
    });
    cursor = token.next;
  }
  return out;
}

function findCommandAtoms(buf, pools, handlerTable) {
  if (pools.symbolPoolStart < 0) return [];
  const start = Math.max(0, pools.symbolPoolStart - 1);
  const tail = buf.subarray(start);
  const occupied = [];
  const atoms = [];
  const labels = ["INIT", "_MAIN"];
  const names = [...handlerTable.names, ...labels].sort((a, b) => b.length - a.length || a.localeCompare(b));

  function overlaps(offset, end) {
    return occupied.some((range) => offset < range.end && end > range.offset);
  }

  function addAtom(name, offset, kind, handlerName = name) {
    const end = offset + name.length;
    if (overlaps(offset, end)) return;
    occupied.push({ offset, end });
    atoms.push({ name, handlerName, offset, end, kind });
  }

  for (const name of names) {
    const needle = Buffer.from(name, "ascii");
    let rel = -1;
    while ((rel = tail.indexOf(needle, rel + 1)) >= 0) {
      const offset = start + rel;
      const prev = offset > 0 ? buf[offset - 1] : -1;
      const kind = labels.includes(name)
        ? "label"
        : (prev === name.length ? "exact-len-slot" : "embedded-fragment");
      addAtom(name, offset, kind);
    }
  }

  for (const [fragment, command] of FRAGMENT_ALIASES.sort((a, b) => b[0].length - a[0].length || a[0].localeCompare(b[0]))) {
    if (!handlerTable.byName.has(command)) continue;
    const needle = Buffer.from(fragment, "ascii");
    let rel = -1;
    while ((rel = tail.indexOf(needle, rel + 1)) >= 0) {
      const offset = start + rel;
      addAtom(fragment, offset, "fragment-alias", command);
    }
  }

  atoms.sort((a, b) => a.offset - b.offset || b.name.length - a.name.length);
  let prevEnd = start;
  return atoms.map((atom) => {
    const gapStart = prevEnd;
    const gapEnd = atom.offset;
    prevEnd = Math.max(prevEnd, atom.end);
    const handler = handlerTable.byName.get(atom.handlerName) || null;
    return {
      offset: hex(atom.offset),
      end: hex(atom.end),
      name: atom.name,
      command: atom.handlerName,
      kind: atom.kind,
      gapBefore: {
        offset: hex(gapStart),
        length: Math.max(0, gapEnd - gapStart),
        bytes: hexBytes(buf.subarray(gapStart, gapEnd)),
        compact: compactPreview(buf, gapStart, gapEnd, 16),
      },
      handler: handler ? {
        target: handler.target,
        reads: handler.reads,
        controls: handler.controls,
      } : null,
    };
  });
}

function readValue(buf, offset, mode) {
  if (offset >= buf.length) return null;
  if (mode === "raw8") return { value: buf[offset], next: offset + 1, raw: byteHex(buf[offset]), tag: "raw8" };
  if (mode === "s8") {
    const value = buf[offset] > 127 ? buf[offset] - 256 : buf[offset];
    return { value, next: offset + 1, raw: byteHex(buf[offset]), tag: "s8" };
  }
  if (mode === "u16le") {
    if (offset + 2 > buf.length) return null;
    return { value: buf.readUInt16LE(offset), next: offset + 2, raw: hexBytes(buf.subarray(offset, offset + 2)), tag: "u16le" };
  }
  if (mode === "u16be") {
    if (offset + 2 > buf.length) return null;
    return { value: buf.readUInt16BE(offset), next: offset + 2, raw: hexBytes(buf.subarray(offset, offset + 2)), tag: "u16be" };
  }
  if (mode === "compact") {
    const token = decodeCompactToken(buf, offset);
    if (!token || token.truncated) return null;
    return { value: token.value, next: token.next, raw: token.raw, tag: token.tag };
  }
  return null;
}

function readCompact(buf, offset) {
  const token = decodeCompactToken(buf, offset);
  if (!token || token.truncated || Math.abs(token.value) > 0x7fffffff) return null;
  return token;
}

function parseStrictRecord(buf, offset, shortMode) {
  if (offset >= buf.length) return null;
  const opcode = buf[offset];
  if (opcode < 0 || opcode > 8) return null;
  let cursor = offset + 1;

  function compact() {
    const token = readCompact(buf, cursor);
    if (!token) return false;
    cursor = token.next;
    return true;
  }

  function short() {
    const token = readValue(buf, cursor, shortMode);
    if (!token) return false;
    cursor = token.next;
    return true;
  }

  switch (opcode) {
    case 0:
    case 2:
    case 3:
    case 5:
    case 6:
    case 7:
    case 8:
      if (!compact()) return null;
      break;
    case 1:
      if (!short()) return null;
      break;
    case 4:
      if (!compact() || !compact()) return null;
      break;
    default:
      return null;
  }
  return { opcode, next: cursor };
}

function scanStrictRecordCandidates(buf, pools) {
  const stop = Math.min(
    pools.textPoolStart >= 0 ? pools.textPoolStart : buf.length,
    pools.symbolPoolStart >= 0 ? pools.symbolPoolStart : buf.length,
    buf.length
  );
  const candidates = [];
  const idModes = ["raw8", "s8", "u16le", "u16be", "compact"];
  const countModes = ["raw8", "compact"];

  for (let start = 0; start < stop; start += 1) {
    for (const idMode of idModes) {
      for (const countMode of countModes) {
        let cursor = start;
        const groups = [];
        let records = 0;
        let failed = false;
        for (let groupIndex = 0; groupIndex < 12 && cursor < stop; groupIndex += 1) {
          const id = readValue(buf, cursor, idMode);
          if (!id) { failed = true; break; }
          cursor = id.next;
          const count = readValue(buf, cursor, countMode);
          if (!count) { failed = true; break; }
          cursor = count.next;
          if (count.value < 0 || count.value > 96) { failed = true; break; }
          const opcodes = [];
          for (let recordIndex = 0; recordIndex < count.value; recordIndex += 1) {
            const record = parseStrictRecord(buf, cursor, idMode);
            if (!record) { failed = true; break; }
            opcodes.push(record.opcode);
            cursor = record.next;
          }
          if (failed) break;
          groups.push({
            index: groupIndex,
            offset: hex(id.next - (idMode.startsWith("u16") ? 2 : 1)),
            id: id.value,
            count: count.value,
            opcodes: opcodes.slice(0, 12),
          });
          records += count.value;
          if (records > 512) break;
        }
        if (!groups.length || records <= 0) continue;
        const gap = stop - cursor;
        const sixGroupBonus = groups.length === 6 ? 120 : 0;
        const nearPoolBonus = gap >= 0 && gap <= 256 ? 80 - Math.floor(gap / 4) : 0;
        const score = groups.length * 20 + records * 4 + sixGroupBonus + nearPoolBonus - Math.max(0, gap - 384) / 8;
        candidates.push({
          score: Number(score.toFixed(2)),
          start: hex(start),
          end: hex(cursor),
          gapToPool: gap,
          idMode,
          countMode,
          groups: groups.length,
          records,
          sampleGroups: groups.slice(0, 4),
        });
      }
    }
  }

  return candidates
    .sort((a, b) => b.score - a.score || b.records - a.records || a.gapToPool - b.gapToPool)
    .slice(0, 12);
}

function analyzeXseEntry(archive, entry, handlerTable) {
  const resource = readResource(archive, entry);
  const buf = resource.fixed;
  const envelope = parseResourceEnvelope(buf);
  const xseOffset = buf.indexOf(Buffer.from("XSE0", "ascii"));
  const pools = detectPools(buf);
  const objectProbe = xseOffset >= 0 ? probe112C4ResourceBuffer(buf, { resourceName: entry.name }) : null;
  const atoms = findCommandAtoms(buf, pools, handlerTable);
  const strictCandidates = xseOffset >= 0 ? scanStrictRecordCandidates(buf, pools) : [];
  return {
    name: entry.name,
    cleanName: cleanName(entry.name),
    section: entry.section,
    index: entry.index,
    size: buf.length,
    rawSize: resource.raw.length,
    fixupNote: resource.fixupNote,
    kind: xseOffset >= 0 ? "xse-object-script" : "xse-data-table",
    envelope,
    xseOffset: hex(xseOffset),
    bodyOffset: hex(envelope.bodyOffset),
    headBytes: hexBytes(buf.subarray(0, Math.min(buf.length, 48))),
    pools: {
      textPoolStart: pools.textPoolStartHex,
      symbolPoolStart: pools.symbolPoolStartHex,
      initOffset: pools.initOffsetHex,
      mainOffset: pools.mainOffsetHex,
      refs: pools.refs.slice(0, 16),
      textRuns: pools.textRuns.slice(0, 16),
    },
    objectProbe: objectProbe ? {
      confidence: objectProbe.confidence,
      strictOpcodeGate: objectProbe.strictOpcodeGate,
      best: objectProbe.best ? {
        reader: objectProbe.best.groupIdReader,
        baseOffset: objectProbe.best.baseOffset,
        endOffset: objectProbe.best.endOffset,
        groupCount: objectProbe.best.groupCount,
        records: objectProbe.best.totalRecords,
        knownOpcodePercent: objectProbe.best.knownOpcodePercent,
        opcodeHistogram: objectProbe.best.opcodeHistogram,
      } : null,
    } : null,
    strictRecordCandidates: strictCandidates,
    symbolAtoms: atoms.slice(0, 80),
  };
}

function buildWireProbe(options = {}) {
  const input = path.resolve(options.input || DEFAULT_INPUT);
  const archive = loadCbeArchive(input);
  const handlerTable = loadHandlerTable(options.handlerJson || DEFAULT_HANDLER_JSON);
  const names = options.names?.length ? options.names : FOCUS;
  const scripts = names
    .map((name) => findEntry(archive, name))
    .filter(Boolean)
    .map((entry) => analyzeXseEntry(archive, entry, handlerTable));
  const dataTables = archive.entries
    .filter((entry) => extOf(entry.name) === ".xse")
    .map((entry) => {
      const resource = readResource(archive, entry);
      return {
        name: entry.name,
        cleanName: cleanName(entry.name),
        size: resource.fixed.length,
        xseOffset: resource.fixed.indexOf(Buffer.from("XSE0", "ascii")),
      };
    })
    .filter((entry) => entry.xseOffset < 0);

  return {
    schema: "nicai.cbe.xseWireProbe.v1",
    generatedAt: new Date().toISOString(),
    input,
    handlerTable: {
      file: handlerTable.file,
      commandCount: handlerTable.commandCount,
      error: handlerTable.error || "",
    },
    xseCount: archive.entries.filter((entry) => extOf(entry.name) === ".xse").length,
    dataTables,
    scripts,
  };
}

function renderAtom(atom) {
  const reads = atom.handler?.reads?.map((read) => `${read.kind}@${read.slot}`).join(", ") || "";
  const controls = atom.handler?.controls?.map((read) => `${read.kind}@${read.slot}`).join(", ") || "";
  const sig = reads || controls ? ` handler=${[reads, controls].filter(Boolean).join("; ")}` : "";
  const gap = atom.gapBefore?.length ? ` gap=${atom.gapBefore.bytes}` : "";
  const command = atom.command && atom.command !== atom.name ? ` -> ${atom.command}` : "";
  return `- ${atom.offset}: ${atom.name}${command} (${atom.kind})${sig}${gap}`;
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# God War XSE Wire Probe");
  lines.push("");
  lines.push("This report reads `.xse` resources directly from the original `.CBE` archive and keeps byte-level VM evidence separate from symbolic command text.");
  lines.push("");
  lines.push("## Summary");
  lines.push(`- Input: ${report.input}`);
  lines.push(`- XSE resources: ${report.xseCount}`);
  lines.push(`- Handler commands: ${report.handlerTable.commandCount}`);
  lines.push(`- XSE data-table resources without XSE0: ${report.dataTables.map((entry) => entry.name).join(", ") || "none"}`);
  lines.push("");
  for (const script of report.scripts) {
    lines.push(`## ${script.name}`);
    lines.push("");
    lines.push(`- Kind: ${script.kind}`);
    lines.push(`- Size: ${script.size} bytes`);
    lines.push(`- XSE0: ${script.xseOffset}`);
    lines.push(`- Text pool: ${script.pools.textPoolStart || "unknown"}`);
    lines.push(`- Symbol pool: ${script.pools.symbolPoolStart || "unknown"}`);
    if (script.objectProbe) {
      const best = script.objectProbe.best;
      lines.push(`- Strict opcode gate: ${script.objectProbe.strictOpcodeGate.passed ? "pass" : "fail"} (${script.objectProbe.strictOpcodeGate.knownOpcodePercent}% known opcode)`);
      if (best) lines.push(`- Legacy 0x112C4 probe: confidence=${script.objectProbe.confidence}, reader=${best.reader}, groups=${best.groupCount}, records=${best.records}, end=${best.endOffset}`);
    }
    lines.push("");
    lines.push("### Text/Refs");
    for (const ref of script.pools.refs.slice(0, 8)) lines.push(`- ${ref.offsetHex}: ${ref.text}`);
    for (const text of script.pools.textRuns.slice(0, 8)) lines.push(`- ${text.offsetHex}: ${text.text.replace(/\s+/g, " ")}`);
    if (!script.pools.refs.length && !script.pools.textRuns.length) lines.push("- none");
    lines.push("");
    lines.push("### Strict Record Scan");
    if (!script.strictRecordCandidates.length) {
      lines.push("- no all-opcode-0..8 candidate records found before the first pool");
    } else {
      for (const candidate of script.strictRecordCandidates.slice(0, 6)) {
        lines.push(`- score=${candidate.score} ${candidate.start}->${candidate.end} groups=${candidate.groups} records=${candidate.records} gap=${candidate.gapToPool} id=${candidate.idMode} count=${candidate.countMode}`);
      }
    }
    lines.push("");
    lines.push("### Symbol Atoms");
    if (!script.symbolAtoms.length) lines.push("- none");
    for (const atom of script.symbolAtoms.slice(0, 28)) lines.push(renderAtom(atom));
    lines.push("");
  }
  lines.push("## Emulator Implication");
  lines.push("");
  lines.push("- The opening scripts expose handler symbols and handler arities, but the current object-table reader still fails the 0..8 opcode gate.");
  lines.push("- A true emulator should keep these symbol atoms as callable vocabulary only, then resolve the service readers that turn object records into command invocations.");
  return `${lines.join("\n")}\n`;
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

function main() {
  const args = process.argv.slice(2);
  const input = args[0] ? path.resolve(args[0]) : DEFAULT_INPUT;
  const outDir = args[1] ? path.resolve(args[1]) : DEFAULT_OUT;
  const names = args.slice(2);
  fs.mkdirSync(outDir, { recursive: true });
  const report = buildWireProbe({ input, names });
  writeJson(path.join(outDir, "xse_wire_probe.json"), report);
  fs.writeFileSync(path.join(outDir, "xse_wire_probe.md"), renderMarkdown(report), "utf8");
  console.log(`Input: ${report.input}`);
  console.log(`Scripts: ${report.scripts.length}`);
  console.log(`Handlers: ${report.handlerTable.commandCount}`);
  console.log(`Output: ${outDir}`);
}

if (require.main === module) {
  main();
}

module.exports = {
  DEFAULT_OUT,
  analyzeXseEntry,
  buildWireProbe,
  renderMarkdown,
};
