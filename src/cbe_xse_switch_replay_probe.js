const fs = require("fs");
const path = require("path");
const { DEFAULT_INPUT, fixupPayload, loadCbeArchive } = require("./cbe_unpack");
const {
  decodeCompactToken,
  hexBytes,
  parseResourceEnvelope,
} = require("./cbe_struct");

const DEFAULT_OUT = path.resolve(__dirname, "out_godwar_xseswitchreplay");
const LAYOUT_JSON = path.resolve(__dirname, "out_godwar_xselayout", "xse_layout_trace.json");
const FOCUS_XSE = ["s_01.xse", "s_02.xse", "s_03.xse", "s_04.xse"];
const SHORT_MODES = ["compact", "u16le", "u16be"];
const REF_MODES = ["compact", "raw1", "raw2le", "raw2be", "raw3le", "raw3be", "raw4le", "raw4be", "fixed5", "fixed8"];

function hex(n, width = 4) {
  if (!Number.isFinite(n) || n < 0) return "";
  return `0x${n.toString(16).toUpperCase().padStart(width, "0")}`;
}

function byteHex(value) {
  return hex(value, 2);
}

function normalizeName(name) {
  return path.basename(String(name || "").replace(/\\/g, "/")).replace(/^[0-9]{4}_/, "").toLowerCase();
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

function parseHex(text) {
  return typeof text === "string" && /^0x/i.test(text) ? parseInt(text, 16) : NaN;
}

function loadLayoutHints(file = LAYOUT_JSON) {
  try {
    const report = JSON.parse(fs.readFileSync(file, "utf8"));
    const map = new Map();
    for (const script of report.scripts || []) {
      map.set(normalizeName(script.name), {
        objectEnd: parseHex(script.zones?.objectProbe?.end),
        textStart: parseHex(script.zones?.textAndResourcePool?.start),
        symbolStart: parseHex(script.zones?.labelAndSymbolPool?.start),
        oldReader: script.zones?.objectProbe?.reader || "",
      });
    }
    return { available: true, file, map };
  } catch (err) {
    return { available: false, file, map: new Map(), reason: err.message || String(err) };
  }
}

function compactAt(buf, cursor, label, limit = 0x7fffffff) {
  const start = cursor.value;
  const token = decodeCompactToken(buf, start);
  if (!token || token.truncated || Math.abs(token.value) > limit) {
    throw new Error(`${label} compact read failed at ${hex(start)}`);
  }
  cursor.value = token.next;
  return {
    label,
    offset: start,
    offsetHex: hex(start),
    next: token.next,
    nextHex: hex(token.next),
    width: token.next - start,
    value: token.value,
    raw: token.raw,
    tag: token.tag,
  };
}

function raw8At(buf, cursor, label) {
  const start = cursor.value;
  if (start >= buf.length) throw new Error(`${label} raw8 read failed at ${hex(start)}`);
  const value = buf[start];
  cursor.value += 1;
  return {
    label,
    offset: start,
    offsetHex: hex(start),
    next: cursor.value,
    nextHex: hex(cursor.value),
    width: 1,
    value,
    raw: byteHex(value),
    tag: "raw8",
  };
}

function read4C(buf, cursor, mode, label) {
  if (mode === "compact") return compactAt(buf, cursor, label);
  const start = cursor.value;
  if (start + 2 > buf.length) throw new Error(`${label} ${mode} read failed at ${hex(start)}`);
  const value = mode === "u16be" ? buf.readUInt16BE(start) : buf.readUInt16LE(start);
  cursor.value += 2;
  return {
    label,
    offset: start,
    offsetHex: hex(start),
    next: cursor.value,
    nextHex: hex(cursor.value),
    width: 2,
    value,
    raw: hexBytes(buf.subarray(start, start + 2)),
    tag: mode,
  };
}

function addHist(hist, value) {
  hist[value] = (hist[value] || 0) + 1;
}

function topHist(hist, limit = 16) {
  return Object.entries(hist)
    .map(([opcode, count]) => ({ opcode: Number(opcode), count }))
    .sort((a, b) => b.count - a.count || a.opcode - b.opcode)
    .slice(0, limit);
}

function sampleRead(read) {
  if (!read) return null;
  return {
    label: read.label,
    offset: read.offsetHex,
    next: read.nextHex,
    width: read.width,
    value: read.value,
    raw: read.raw,
    tag: read.tag,
  };
}

function parseHeader(buf, baseOffset) {
  const cursor = { value: baseOffset + 6 };
  const reads = [];
  const slotCapacity = compactAt(buf, cursor, "0x1131A object+58 slot capacity", 4096);
  reads.push(sampleRead(slotCapacity));
  const field04 = compactAt(buf, cursor, "0x1136A object+04");
  reads.push(sampleRead(field04));
  const field08Byte = raw8At(buf, cursor, "0x11382 object+08 raw byte");
  reads.push(sampleRead(field08Byte));
  const field0C = compactAt(buf, cursor, "0x11392 object+0C");
  reads.push(sampleRead(field0C));
  const typeByte = raw8At(buf, cursor, "0x113A8 object type raw byte");
  reads.push(sampleRead(typeByte));

  let recordByteSize = { 1: 0x14, 2: 0x28, 3: 0x50 }[typeByte.value] || null;
  let recordByteSizeToken = null;
  if (recordByteSize == null) {
    recordByteSizeToken = compactAt(buf, cursor, "0x113B2 explicit record byte size", 4096);
    reads.push(sampleRead(recordByteSizeToken));
    recordByteSize = recordByteSizeToken.value;
  }

  const groupCount = compactAt(buf, cursor, "0x113F2 group count", 4096);
  reads.push(sampleRead(groupCount));
  if (groupCount.value < 0 || groupCount.value > 64) {
    throw new Error(`implausible group count ${groupCount.value}`);
  }

  return {
    baseOffset,
    cursorAfterHeader: cursor.value,
    cursorAfterHeaderHex: hex(cursor.value),
    slotCapacity: slotCapacity.value === 0 ? 0x80 : slotCapacity.value,
    field04: field04.value,
    field08Byte: field08Byte.value,
    field0C: field0C.value,
    typeByte: typeByte.value,
    recordByteSize,
    recordByteSizeToken: sampleRead(recordByteSizeToken),
    groupCount: groupCount.value,
    reads,
  };
}

function parseRecord(buf, cursor, shortMode, groupIndex, recordIndex) {
  const start = cursor.value;
  const opcode = raw8At(buf, cursor, "opcode raw byte");
  const fields = [];

  function add50(label) {
    fields.push(compactAt(buf, cursor, label));
  }

  function add4C(label) {
    fields.push(read4C(buf, cursor, shortMode, label));
  }

  let switchAction = "high-opcode-skip";
  switch (opcode.value) {
    case 0:
      switchAction = "+0x50 field+08";
      add50("opcode0 field+08");
      break;
    case 1:
      switchAction = "+0x4C field+0C then 0x353A8";
      add4C("opcode1 field+0C");
      break;
    case 2:
      switchAction = "+0x50 field+08; force opcode=2";
      add50("opcode2 field+08");
      break;
    case 3:
      switchAction = "+0x50 field+14";
      add50("opcode3 field+14");
      break;
    case 4:
      switchAction = "+0x50 field+14 and +0x50 field+04";
      add50("opcode4 field+14");
      add50("opcode4 field+04");
      break;
    case 5:
      switchAction = "+0x50 field+18";
      add50("opcode5 field+18");
      break;
    case 6:
      switchAction = "+0x50 field+1C";
      add50("opcode6 field+1C");
      break;
    case 7:
      switchAction = "+0x50 field+20";
      add50("opcode7 field+20");
      break;
    case 8:
      switchAction = "+0x50 field+24";
      add50("opcode8 field+24");
      break;
    default:
      // The real code branches to 0x1150E for opcode >= 9, increments the record index,
      // and continues. It is not a loader failure.
      break;
  }

  return {
    groupIndex,
    recordIndex,
    start,
    startHex: hex(start),
    end: cursor.value,
    endHex: hex(cursor.value),
    opcode: opcode.value,
    opcodeHex: opcode.raw,
    highOpcode: opcode.value >= 9,
    switchAction,
    fields: fields.map(sampleRead),
  };
}

function refModeByteCount(mode) {
  if (mode === "compact") return 0;
  const fixed = mode.match(/^fixed(\d+)$/);
  if (fixed) return Number(fixed[1]);
  return ({ raw1: 1, raw2le: 2, raw2be: 2, raw3le: 3, raw3be: 3, raw4le: 4, raw4be: 4 }[mode] || 0);
}

function readRefMode(buf, cursor, mode, label) {
  if (mode === "compact") return compactAt(buf, cursor, label);
  const width = refModeByteCount(mode);
  const start = cursor.value;
  if (!width || start + width > buf.length) throw new Error(`${label} ${mode} failed at ${hex(start)}`);
  let value = null;
  if (mode === "raw1") value = buf[start];
  else if (mode === "raw2le") value = buf.readUInt16LE(start);
  else if (mode === "raw2be") value = buf.readUInt16BE(start);
  else if (mode === "raw3le") value = buf.readUIntLE(start, 3);
  else if (mode === "raw3be") value = buf.readUIntBE(start, 3);
  else if (mode === "raw4le") value = buf.readUInt32LE(start);
  else if (mode === "raw4be") value = buf.readUInt32BE(start);
  cursor.value += width;
  return {
    label,
    offset: start,
    offsetHex: hex(start),
    next: cursor.value,
    nextHex: hex(cursor.value),
    width,
    value,
    raw: hexBytes(buf.subarray(start, start + width)),
    tag: mode,
  };
}

function parseTailAttempt(buf, startOffset, modes) {
  const cursor = { value: startOffset };
  const steps = [];
  const warnings = [];
  let ok = true;

  function readCount(label) {
    const token = compactAt(buf, cursor, `${label} count`, 256);
    if (token.value < 0 || token.value > 256) throw new Error(`${label} count ${token.value} outside 0..256 at ${token.offsetHex}`);
    steps.push({ label: `${label} count`, offset: token.offsetHex, value: token.value, raw: token.raw, tag: token.tag });
    return token.value;
  }

  function skipRefs(label, count, mode) {
    const samples = [];
    for (let index = 0; index < count; index += 1) {
      const token = readRefMode(buf, cursor, mode, `${label}[${index}]`);
      if (index < 8) samples.push(sampleRead(token));
    }
    steps.push({ label, count, mode, samples });
  }

  try {
    const linkCount = readCount("0x115B8 opcode2 backfill +0x74 refs");
    if (linkCount > 0) skipRefs("0x115B8 opcode2 backfill +0x74 refs", linkCount, modes.ref74Mode);

    const rangeCount = readCount("0x11672 object+68 ranges");
    if (rangeCount > 0) {
      const samples = [];
      for (let index = 0; index < rangeCount; index += 1) {
        const start = compactAt(buf, cursor, "range+00");
        const kind = raw8At(buf, cursor, "range+04 kind");
        const span = compactAt(buf, cursor, "range+08 span");
        const ref = readRefMode(buf, cursor, modes.ref64Mode, "range+10 +0x64 ref");
        if (index < 8) {
          samples.push({
            index,
            offset: start.offsetHex,
            start: start.value,
            kind: kind.value,
            span: span.value,
            inclusiveEnd: kind.value + span.value + 1,
            ref: ref.value,
            raw: [start.raw, kind.raw, span.raw, ref.raw].join(" | "),
          });
        }
      }
      steps.push({ label: "0x11672 object+68 ranges", count: rangeCount, samples });
    }

    const finalRefCount = readCount("0x11752 object+70 final +0x64 refs");
    if (finalRefCount > 0) skipRefs("0x11752 object+70 final +0x64 refs", finalRefCount, modes.ref64Mode);
  } catch (err) {
    ok = false;
    warnings.push(err.message || String(err));
  }

  return {
    modes,
    ok,
    start: startOffset,
    startHex: hex(startOffset),
    end: cursor.value,
    endHex: hex(cursor.value),
    consumed: cursor.value - startOffset,
    steps,
    warnings,
  };
}

function scoreTail(tail, context) {
  const layoutDelta = Number.isFinite(context.layoutEnd) ? tail.end - context.layoutEnd : null;
  const textGap = Number.isFinite(context.textStart) ? context.textStart - tail.end : null;
  const crossedText = Number.isFinite(context.textStart) && tail.end > context.textStart;
  const layoutScore = layoutDelta == null ? 0 : Math.max(0, 180 - Math.abs(layoutDelta));
  const textScore = textGap == null ? 0 : Math.max(-80, Math.min(80, textGap));
  const modePenalty = (tail.modes.ref74Mode === "compact" ? 0 : 3) + (tail.modes.ref64Mode === "compact" ? 0 : 3);
  return (tail.ok ? 100 : -60) + layoutScore + textScore - (crossedText ? 160 : 0) - modePenalty;
}

function buildTailAttempts(buf, groupEnd, context) {
  const attempts = [];
  for (const ref74Mode of REF_MODES) {
    for (const ref64Mode of REF_MODES) {
      const tail = parseTailAttempt(buf, groupEnd, { ref74Mode, ref64Mode });
      const layoutDelta = Number.isFinite(context.layoutEnd) ? tail.end - context.layoutEnd : null;
      const textGap = Number.isFinite(context.textStart) ? context.textStart - tail.end : null;
      attempts.push({
        ...tail,
        layoutDelta,
        textGap,
        score: scoreTail(tail, context),
      });
    }
  }
  return attempts.sort((a, b) => b.score - a.score || Math.abs(a.layoutDelta ?? 0) - Math.abs(b.layoutDelta ?? 0)).slice(0, 12);
}

function parseSwitchReplay(buf, shortMode, layoutHint = {}) {
  const envelope = parseResourceEnvelope(buf);
  const baseOffset = envelope.bodyOffset;
  const header = parseHeader(buf, baseOffset);
  const cursor = { value: header.cursorAfterHeader };
  const groups = [];
  const opcodeHist = {};
  const recordSamples = [];
  let totalRecords = 0;
  let highOpcodeRecords = 0;
  let lowOpcodeRecords = 0;

  for (let groupIndex = 0; groupIndex < header.groupCount; groupIndex += 1) {
    const groupStart = cursor.value;
    const id = read4C(buf, cursor, shortMode, "0x11426 group id +0x4C");
    const recordCount = raw8At(buf, cursor, "0x1144E group record count raw byte");
    const group = {
      index: groupIndex,
      start: groupStart,
      startHex: hex(groupStart),
      id: sampleRead(id),
      recordCount: recordCount.value,
      recordCountOffset: recordCount.offsetHex,
      recordCountRaw: recordCount.raw,
      records: [],
    };

    if (totalRecords + recordCount.value > 4096) {
      throw new Error(`record budget exceeded at group ${groupIndex}`);
    }

    for (let recordIndex = 0; recordIndex < recordCount.value; recordIndex += 1) {
      const record = parseRecord(buf, cursor, shortMode, groupIndex, recordIndex);
      addHist(opcodeHist, record.opcode);
      if (record.highOpcode) highOpcodeRecords += 1;
      else lowOpcodeRecords += 1;
      if (group.records.length < 10) group.records.push(record);
      if (recordSamples.length < 36) recordSamples.push(record);
    }

    totalRecords += recordCount.value;
    groups.push(group);
  }

  const groupEnd = cursor.value;
  const tailAttempts = buildTailAttempts(buf, groupEnd, {
    layoutEnd: layoutHint.objectEnd,
    textStart: layoutHint.textStart,
  });
  const bestTail = tailAttempts[0] || null;
  const layoutDelta = Number.isFinite(layoutHint.objectEnd) && bestTail ? bestTail.end - layoutHint.objectEnd : null;
  const groupDelta = Number.isFinite(layoutHint.objectEnd) ? groupEnd - layoutHint.objectEnd : null;

  return {
    ok: true,
    shortMode,
    baseOffset,
    baseOffsetHex: hex(baseOffset),
    envelope: {
      tag: byteHex(buf[0]),
      bodyOffset: hex(envelope.bodyOffset),
      declaredBodyLength: envelope.declaredBodyLength,
      bodyLength: envelope.bodyLength,
      lengthMatches: envelope.lengthMatches,
      xseMagicOffset: hex(buf.indexOf(Buffer.from("XSE0", "ascii"))),
    },
    header,
    groups,
    parsedGroupCount: groups.length,
    totalRecords,
    highOpcodeRecords,
    lowOpcodeRecords,
    highOpcodePercent: totalRecords ? Number(((highOpcodeRecords / totalRecords) * 100).toFixed(2)) : 0,
    opcodeHistogram: topHist(opcodeHist),
    groupEnd,
    groupEndHex: hex(groupEnd),
    groupDelta,
    tailAttempts,
    bestTail,
    layoutDelta,
    recordSamples,
  };
}

function summarizeScript(archive, name, layoutHints) {
  const entry = findEntry(archive, name);
  if (!entry) return { name, missing: true };
  const resource = readResource(archive, entry);
  const layoutHint = layoutHints.map.get(normalizeName(name)) || {};
  const attempts = [];
  for (const mode of SHORT_MODES) {
    try {
      attempts.push(parseSwitchReplay(resource.fixed, mode, layoutHint));
    } catch (err) {
      attempts.push({
        ok: false,
        shortMode: mode,
        warning: err.message || String(err),
      });
    }
  }

  attempts.sort((a, b) => {
    if (a.ok !== b.ok) return a.ok ? -1 : 1;
    const ad = Math.abs(a.layoutDelta ?? a.groupDelta ?? 999999);
    const bd = Math.abs(b.layoutDelta ?? b.groupDelta ?? 999999);
    const ats = a.bestTail?.score ?? -9999;
    const bts = b.bestTail?.score ?? -9999;
    return ad - bd || bts - ats;
  });

  return {
    name,
    resource: entry.name,
    size: resource.fixed.length,
    fixupNote: resource.fixupNote,
    layoutHint: {
      objectEnd: Number.isFinite(layoutHint.objectEnd) ? hex(layoutHint.objectEnd) : "",
      textStart: Number.isFinite(layoutHint.textStart) ? hex(layoutHint.textStart) : "",
      symbolStart: Number.isFinite(layoutHint.symbolStart) ? hex(layoutHint.symbolStart) : "",
      oldReader: layoutHint.oldReader || "",
    },
    attempts,
    best: attempts.find((attempt) => attempt.ok) || attempts[0],
  };
}

function buildReport(options = {}) {
  const input = path.resolve(options.input || DEFAULT_INPUT);
  const archive = loadCbeArchive(input);
  const layoutHints = loadLayoutHints();
  const scripts = FOCUS_XSE.map((name) => summarizeScript(archive, name, layoutHints));
  const okScripts = scripts.filter((script) => script.best?.ok).length;
  const closeTailScripts = scripts.filter((script) => {
    const delta = script.best?.layoutDelta;
    return Number.isFinite(delta) && Math.abs(delta) <= 16;
  }).length;
  return {
    schema: "nicai.cbe.xseSwitchReplayProbe.v1",
    generatedAt: new Date().toISOString(),
    input,
    layoutHints: {
      available: layoutHints.available,
      file: layoutHints.file,
      reason: layoutHints.reason || "",
    },
    disassemblyCorrection: {
      site: "0x1148E",
      instruction: "cmp opcode,#9; bhs 0x1150E",
      meaning: "opcode >= 9 skips the 0..8 operand switch and still continues the record loop; it is not a loader-failure gate.",
      emulatorImpact: "The old strict-opcode gate was over-restrictive. A true 0x112C4 loader must store high opcode bytes as table records with no extra operands at this stage.",
    },
    summary: {
      status: okScripts === scripts.length ? "switch-replay-ok" : "switch-replay-partial",
      okScripts,
      scriptCount: scripts.length,
      closeTailScripts,
      currentFinding: `${okScripts}/${scripts.length} focused XSE files replay the 0x112C4 group/opcode switch when opcode>=9 is treated as the disassembled high-opcode skip path.`,
      nextTarget: "Bind high opcode records to the later symbol/handler tables and resolve +0x74/+0x64 tail reader semantics, with s_02 tail alignment as the narrow blocker.",
    },
    scripts,
  };
}

function mdRow(cells) {
  return `| ${cells.map((cell) => String(cell ?? "").replace(/\|/g, "\\|")).join(" | ")} |`;
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# XSE 0x112C4 Switch Replay Probe");
  lines.push("");
  lines.push(`- Input CBE: \`${report.input}\``);
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push("");
  lines.push("## Disassembly Correction");
  lines.push("");
  lines.push(`- Site: ${report.disassemblyCorrection.site}`);
  lines.push(`- Instruction: \`${report.disassemblyCorrection.instruction}\``);
  lines.push(`- Meaning: ${report.disassemblyCorrection.meaning}`);
  lines.push(`- Emulator impact: ${report.disassemblyCorrection.emulatorImpact}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Status: ${report.summary.status}`);
  lines.push(`- Finding: ${report.summary.currentFinding}`);
  lines.push(`- Next target: ${report.summary.nextTarget}`);
  lines.push("");
  lines.push(mdRow(["Script", "+0x4C mode", "Groups", "Records", "High >=9", "Group end", "Best tail", "Layout", "Delta", "Tail modes"]));
  lines.push(mdRow(["---", "---", "---:", "---:", "---:", "---", "---", "---", "---:", "---"]));
  for (const script of report.scripts) {
    const best = script.best || {};
    const tail = best.bestTail || {};
    lines.push(mdRow([
      script.name,
      best.shortMode || "",
      best.header?.groupCount ?? "",
      best.totalRecords ?? "",
      best.highOpcodeRecords ?? "",
      best.groupEndHex || "",
      tail.endHex || "",
      script.layoutHint?.objectEnd || "",
      best.layoutDelta ?? "",
      tail.modes ? `74=${tail.modes.ref74Mode},64=${tail.modes.ref64Mode}` : "",
    ]));
  }
  lines.push("");
  lines.push("## Per-Script Evidence");
  for (const script of report.scripts) {
    const best = script.best || {};
    lines.push("");
    lines.push(`### ${script.name}`);
    if (!best.ok) {
      lines.push(`- Parse failed: ${best.warning || "unknown"}`);
      continue;
    }
    lines.push(`- Resource: ${script.resource}, size=${script.size}`);
    lines.push(`- Header: base=${best.baseOffsetHex}, cursor=${best.header.cursorAfterHeaderHex}, recordByteSize=${best.header.recordByteSize}, groups=${best.header.groupCount}`);
    lines.push(`- Best +0x4C mode: ${best.shortMode}; records=${best.totalRecords}; high-opcode skip records=${best.highOpcodeRecords} (${best.highOpcodePercent}%)`);
    lines.push(`- Group end: ${best.groupEndHex}; best tail end=${best.bestTail?.endHex || ""}; layout=${script.layoutHint.objectEnd || ""}; delta=${best.layoutDelta ?? ""}`);
    lines.push(`- Top opcodes: ${best.opcodeHistogram.slice(0, 10).map((item) => `${item.opcode}:${item.count}`).join(", ")}`);
    lines.push(`- Groups: ${best.groups.slice(0, 8).map((group) => `g${group.index}@${group.startHex} id=${group.id.value}(${group.id.raw}) n=${group.recordCount}`).join("; ")}`);
    const firstHigh = best.recordSamples.find((record) => record.highOpcode);
    const firstLow = best.recordSamples.find((record) => !record.highOpcode);
    if (firstLow) lines.push(`- First low switch record: g${firstLow.groupIndex}/r${firstLow.recordIndex} ${firstLow.startHex} opcode=${firstLow.opcode} action=${firstLow.switchAction}`);
    if (firstHigh) lines.push(`- First high skip record: g${firstHigh.groupIndex}/r${firstHigh.recordIndex} ${firstHigh.startHex} opcode=${firstHigh.opcode}; next=${firstHigh.endHex}`);
    const tail = best.bestTail;
    if (tail) {
      lines.push(`- Tail: ok=${tail.ok}, start=${tail.startHex}, end=${tail.endHex}, score=${tail.score}, modes=74=${tail.modes.ref74Mode},64=${tail.modes.ref64Mode}`);
      for (const step of tail.steps.slice(0, 4)) {
        const samples = (step.samples || []).slice(0, 3).map((sample) => `${sample.offset}:${sample.raw}`).join(" ");
        lines.push(`- Tail step: ${step.label}, count=${step.count ?? step.value ?? ""}${step.mode ? `, mode=${step.mode}` : ""}${samples ? `, samples=${samples}` : ""}`);
      }
      for (const warning of tail.warnings || []) lines.push(`- Tail warning: ${warning}`);
    }
  }
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
  const jsonFile = path.join(outDir, "xse_switch_replay_probe.json");
  const mdFile = path.join(outDir, "xse_switch_replay_probe.md");
  writeJson(jsonFile, report);
  fs.writeFileSync(mdFile, renderMarkdown(report), "utf8");
  console.log(`wrote ${jsonFile}`);
  console.log(`wrote ${mdFile}`);
  console.log(`${report.summary.status}: ${report.summary.currentFinding}`);
}

if (require.main === module) {
  main();
}

module.exports = {
  buildReport,
  renderMarkdown,
};
