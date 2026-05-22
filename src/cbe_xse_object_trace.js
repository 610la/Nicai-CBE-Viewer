const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const {
  asciiRuns,
  hexBytes,
  parseResourceEnvelope,
  readCompactTokenAt,
  scanTextRuns,
} = require("./cbe_struct");

const DEFAULT_GAME_ROOT = path.join(process.cwd(), "out_batch", "众神之战");
const DEFAULT_OUT = path.join(process.cwd(), "out_godwar_xseobject");
const DEFAULT_LAYOUT_JSON = path.join(process.cwd(), "out_godwar_xselayout", "xse_layout_trace.json");
const FOCUS = ["s_01.xse", "s_02.xse", "s_03.xse", "s_04.xse"];
const SHORT_MODES = ["compact", "u16le", "u16be"];
const TAIL_REF_MODES = [
  "compact",
  "raw1",
  "raw2le",
  "raw2be",
  "raw3le",
  "raw3be",
  "raw4le",
  "raw4be",
  "fixed5",
  "fixed8",
];

function cleanName(name) {
  return String(name || "").replace(/^[0-9]{4}_/, "");
}

function relFrom(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function resolveManifestOutput(gameRoot, output) {
  const literal = path.resolve(output);
  const normalized = String(output || "").replace(/\\/g, "/");
  const gameName = path.basename(gameRoot).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const marker = new RegExp(`/out_batch/${gameName}/`, "i");
  const match = normalized.match(marker);
  if (match) {
    const suffix = normalized.slice(match.index + match[0].length).split("/");
    const candidate = path.join(gameRoot, ...suffix);
    if (fs.existsSync(candidate)) return candidate;
  }
  return literal;
}

function hex(n, width = 4) {
  if (!Number.isFinite(n) || n < 0) return "";
  return `0x${n.toString(16).toUpperCase().padStart(width, "0")}`;
}

function byteHex(value) {
  return hex(value, 2);
}

function loadCatalog(gameRoot) {
  const manifest = JSON.parse(fs.readFileSync(path.join(gameRoot, "manifest.json"), "utf8"));
  return manifest.files
    .filter((file) => file.output && !file.skipped)
    .map((file) => ({
      name: file.name,
      cleanName: cleanName(file.name),
      output: resolveManifestOutput(gameRoot, file.output),
      rel: relFrom(gameRoot, resolveManifestOutput(gameRoot, file.output)),
    }));
}

function findEntry(catalog, name) {
  const target = name.toLowerCase();
  return catalog.find((entry) => entry.cleanName.toLowerCase() === target) || null;
}

function parseHexString(value) {
  if (typeof value !== "string") return -1;
  const match = value.match(/^0x([0-9a-f]+)$/i);
  return match ? parseInt(match[1], 16) : -1;
}

function loadLayoutHints(layoutJson = DEFAULT_LAYOUT_JSON) {
  try {
    const report = JSON.parse(fs.readFileSync(layoutJson, "utf8"));
    const hints = new Map();
    for (const script of report.scripts || []) {
      const objectEnd = parseHexString(script.zones?.objectProbe?.end);
      const textStart = parseHexString(script.zones?.textAndResourcePool?.start);
      const symbolStart = parseHexString(script.zones?.labelAndSymbolPool?.start);
      if (script.name) hints.set(script.name.toLowerCase(), { objectEnd, textStart, symbolStart });
    }
    return hints;
  } catch {
    return new Map();
  }
}

function isUsefulText(text) {
  const value = String(text || "");
  const chinese = (value.match(/[\u3400-\u4dbf\u4e00-\u9fff]/gu) || []).length;
  const hasRef = /\.(?:actor|gif|map|sce|xse|mp3)\b/i.test(value);
  const hasSpeaker = value.includes("[") || value.includes("]") || value.includes("：");
  return hasRef || hasSpeaker || chinese >= 4;
}

function detectPools(buf) {
  const usefulTextRuns = scanTextRuns(buf, 3, 500)
    .filter((run) => isUsefulText(run.text))
    .map((run) => ({ ...run, offsetHex: hex(run.offset) }));
  const initOffset = buf.indexOf(Buffer.from("INIT", "ascii"));
  const mainOffset = buf.indexOf(Buffer.from("_MAIN", "ascii"));
  const refs = asciiRuns(buf, 3, 500)
    .filter((run) => /\.(?:actor|gif|map|sce|xse|mp3)\b/i.test(run.text))
    .map((run) => ({ ...run, offsetHex: hex(run.offset) }));
  return {
    textPoolStart: usefulTextRuns[0]?.offset ?? -1,
    textPoolStartHex: hex(usefulTextRuns[0]?.offset ?? -1),
    symbolPoolStart: initOffset >= 0 ? initOffset : mainOffset,
    symbolPoolStartHex: hex(initOffset >= 0 ? initOffset : mainOffset),
    firstTextRuns: usefulTextRuns.slice(0, 10),
    refs,
  };
}

function readCompact(stream, cursor, label, limit = 0x7fffffff) {
  const start = cursor.value;
  const token = readCompactTokenAt(stream, cursor, limit);
  if (!token) throw new Error(`compact read failed for ${label} at rel ${hex(start)}`);
  return {
    label,
    rel: start,
    relHex: hex(start),
    value: token.value,
    raw: token.raw,
    tag: token.tag,
  };
}

function readRaw8(stream, cursor, label) {
  if (cursor.value >= stream.length) throw new Error(`raw8 read failed for ${label} at rel ${hex(cursor.value)}`);
  const start = cursor.value;
  const value = stream[cursor.value];
  cursor.value += 1;
  return {
    label,
    rel: start,
    relHex: hex(start),
    value,
    raw: byteHex(value),
    tag: "raw8",
  };
}

function readShort(stream, cursor, mode, label) {
  if (mode === "compact") return readCompact(stream, cursor, label);
  if (cursor.value + 2 > stream.length) throw new Error(`${mode} read failed for ${label} at rel ${hex(cursor.value)}`);
  const start = cursor.value;
  const bytes = stream.subarray(start, start + 2);
  const value = mode === "u16be" ? stream.readUInt16BE(start) : stream.readUInt16LE(start);
  cursor.value += 2;
  return {
    label,
    rel: start,
    relHex: hex(start),
    value,
    raw: hexBytes(bytes),
    tag: mode,
  };
}

function parseRecord(stream, cursor, shortMode, groupIndex, recordIndex) {
  const start = cursor.value;
  const opcode = readRaw8(stream, cursor, "opcode");
  const fields = [];
  const addCompact = (label) => fields.push(readCompact(stream, cursor, label));
  const addShort = (label) => fields.push(readShort(stream, cursor, shortMode, label));

  switch (opcode.value) {
    case 0:
      addCompact("field+08");
      break;
    case 1:
      addShort("field+0C");
      break;
    case 2:
      addCompact("field+08");
      fields.push({ label: "forced-type", tag: "const", value: 2, raw: "" });
      break;
    case 3:
      addCompact("field+14");
      break;
    case 4:
      addCompact("field+14");
      addCompact("field+04");
      break;
    case 5:
      addCompact("field+18");
      break;
    case 6:
      addCompact("field+1C");
      break;
    case 7:
      addCompact("field+20");
      break;
    case 8:
      addCompact("field+24");
      break;
    default:
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
    fields,
  };
}

function addHistogram(histogram, value) {
  histogram.set(value, (histogram.get(value) || 0) + 1);
}

function topHistogram(histogram, limit = 14) {
  return Array.from(histogram, ([key, count]) => ({ key: String(key), count }))
    .sort((a, b) => b.count - a.count || Number(a.key) - Number(b.key))
    .slice(0, limit);
}

function readRefWithMode(stream, cursor, mode, label) {
  if (mode === "compact") return readCompact(stream, cursor, label);

  const fixedMatch = mode.match(/^fixed(\d+)$/);
  const byteCount = fixedMatch ? Number(fixedMatch[1]) : ({ raw1: 1, raw2le: 2, raw2be: 2, raw3le: 3, raw3be: 3, raw4le: 4, raw4be: 4 }[mode] || 0);
  if (!byteCount || cursor.value + byteCount > stream.length) {
    throw new Error(`${mode} read failed for ${label} at rel ${hex(cursor.value)}`);
  }

  const start = cursor.value;
  const bytes = stream.subarray(start, start + byteCount);
  let value = null;
  if (mode === "raw1") value = stream[start];
  else if (mode === "raw2le") value = stream.readUInt16LE(start);
  else if (mode === "raw2be") value = stream.readUInt16BE(start);
  else if (mode === "raw3le") value = stream.readUIntLE(start, 3);
  else if (mode === "raw3be") value = stream.readUIntBE(start, 3);
  else if (mode === "raw4le") value = stream.readUInt32LE(start);
  else if (mode === "raw4be") value = stream.readUInt32BE(start);
  cursor.value += byteCount;
  return {
    label,
    rel: start,
    relHex: hex(start),
    value,
    raw: hexBytes(bytes),
    tag: mode,
  };
}

function parseTailAttempt(stream, startCursor, modes) {
  const cursor = { value: startCursor };
  const steps = [];
  const warnings = [];
  let ok = true;

  function compactCount(label, max = 512) {
    if (cursor.value >= stream.length) throw new Error(`${label} count outside stream at rel ${hex(cursor.value)}`);
    const token = readCompact(stream, cursor, `${label} count`, max);
    if (!token) throw new Error(`${label} count decode failed at rel ${hex(cursor.value)}`);
    if (token.value < 0 || token.value > max) {
      throw new Error(`${label} count ${token.value} is outside 0..${max} at rel ${token.relHex}`);
    }
    steps.push({ label: `${label} count`, offset: token.relHex, value: token.value, raw: token.raw });
    return token;
  }

  function skipRefList(label, count, mode, maxSample = 12) {
    const samples = [];
    for (let index = 0; index < count; index += 1) {
      const token = readRefWithMode(stream, cursor, mode, `${label}[${index}]`);
      if (index < maxSample) samples.push({ offset: token.relHex, value: token.value, raw: token.raw });
    }
    steps.push({ label, mode, count, samples });
  }

  try {
    const linkCount = compactCount("opcode2 backfill +0x74 refs", 256);
    if (linkCount.value > 0) skipRefList("opcode2 backfill +0x74 refs", linkCount.value, modes.ref74Mode);

    const rangeCount = compactCount("object+68 ranges", 256);
    if (rangeCount.value > 0) {
      const samples = [];
      for (let index = 0; index < rangeCount.value; index += 1) {
        const start = readCompact(stream, cursor, "range+00");
        const kind = readRaw8(stream, cursor, "range+04");
        const span = readCompact(stream, cursor, "range+08");
        const ref = readRefWithMode(stream, cursor, modes.ref64Mode, "range+10/+0x64 ref");
        if (index < 8) {
          samples.push({
            index,
            offset: start.relHex,
            start: start.value,
            kind: kind.value,
            span: span.value,
            inclusiveEnd: kind.value + span.value + 1,
            ref: ref.value,
            raw: [start.raw, kind.raw, span.raw, ref.raw].join(" | "),
          });
        }
      }
      steps.push({ label: "object+68 ranges", count: rangeCount.value, samples });
    }

    const finalRefCount = compactCount("object+70 count / object+6C +0x64 final refs", 256);
    if (finalRefCount.value > 0) skipRefList("object+70 count / object+6C +0x64 final refs", finalRefCount.value, modes.ref64Mode);
  } catch (err) {
    ok = false;
    warnings.push(err.message);
  }

  return {
    modes,
    ok,
    start: startCursor,
    startHex: hex(startCursor),
    end: cursor.value,
    endHex: hex(cursor.value),
    consumed: cursor.value - startCursor,
    steps,
    warnings,
  };
}

function scoreTailAttempt(tail, context) {
  const absoluteEnd = context.base + tail.end;
  const textStart = context.textStart >= 0 ? context.textStart : context.symbolStart;
  const layoutEnd = context.layoutHint?.objectEnd ?? -1;
  const crossedText = textStart >= 0 && absoluteEnd > textStart;
  const beforeGroups = absoluteEnd < context.absoluteGroupEnd;
  const textGap = textStart >= 0 ? textStart - absoluteEnd : null;
  const layoutDelta = layoutEnd >= 0 ? absoluteEnd - layoutEnd : null;
  const layoutScore = layoutDelta == null
    ? 0
    : Math.max(0, 120 - Math.min(120, Math.abs(layoutDelta) * 2));
  const textScore = textGap == null
    ? 0
    : textGap >= 0
      ? Math.max(0, 40 - Math.floor(textGap / 24))
      : -120 - Math.min(120, Math.abs(textGap));
  const modePenalty = (tail.modes.ref74Mode === "compact" ? 0 : 2) + (tail.modes.ref64Mode === "compact" ? 0 : 2);
  return {
    ...tail,
    absoluteEnd,
    absoluteEndHex: hex(absoluteEnd),
    textGap,
    layoutDelta,
    crossedText,
    score: (tail.ok ? 80 : -80)
      + layoutScore
      + textScore
      - (beforeGroups ? 160 : 0)
      - (crossedText ? 180 : 0)
      - tail.warnings.length * 40
      - modePenalty,
  };
}

function buildTailExperiments(stream, startCursor, context) {
  const attempts = [];
  for (const ref74Mode of TAIL_REF_MODES) {
    for (const ref64Mode of TAIL_REF_MODES) {
      const attempt = parseTailAttempt(stream, startCursor, { ref74Mode, ref64Mode });
      attempts.push(scoreTailAttempt(attempt, context));
    }
  }
  attempts.sort((a, b) => b.score - a.score
    || Math.abs(a.layoutDelta ?? 999999) - Math.abs(b.layoutDelta ?? 999999)
    || Math.abs(a.textGap ?? 999999) - Math.abs(b.textGap ?? 999999)
    || a.end - b.end);
  return attempts;
}

function buildTailStartScan(stream, groupEnd, context) {
  const textStartRel = context.textStart >= 0 ? context.textStart - context.base : stream.length;
  const layoutRel = context.layoutHint?.objectEnd >= 0 ? context.layoutHint.objectEnd - context.base : -1;
  const endRel = Math.min(stream.length, textStartRel, Math.max(groupEnd + 1, groupEnd + 96));
  const modes74 = ["compact", "raw1", "raw2le", "raw3le", "raw4le", "fixed5", "fixed8"];
  const modes64 = ["compact", "raw1", "raw2le", "raw3le", "raw4le", "fixed5", "fixed8"];
  const candidates = [];

  for (let start = Math.max(0, groupEnd - 8); start < endRel; start += 1) {
    for (const ref74Mode of modes74) {
      for (const ref64Mode of modes64) {
        const rawAttempt = parseTailAttempt(stream, start, { ref74Mode, ref64Mode });
        const attempt = scoreTailAttempt(rawAttempt, context);
        const startBeforeGroupPenalty = start < groupEnd ? 100 + ((groupEnd - start) * 4) : 0;
        const score = attempt.score - startBeforeGroupPenalty;
        const firstCount = attempt.steps.find((step) => /count$/.test(step.label)) || null;
        const rangeCount = attempt.steps.find((step) => step.label === "object+68 ranges count") || null;
        const finalCount = attempt.steps.find((step) => step.label === "object+70 count / object+6C +0x64 final refs count") || null;
        candidates.push({
          start,
          startHex: hex(context.base + start),
          startDeltaFromGroupEnd: start - groupEnd,
          startDeltaFromLayout: layoutRel >= 0 ? start - layoutRel : null,
          end: attempt.end,
          endHex: attempt.absoluteEndHex,
          modes: attempt.modes,
          ok: attempt.ok,
          score,
          startBeforeGroupPenalty,
          textGap: attempt.textGap,
          layoutDelta: attempt.layoutDelta,
          firstCount: firstCount ? { value: firstCount.value, raw: firstCount.raw, offset: firstCount.offset } : null,
          rangeCount: rangeCount ? { value: rangeCount.value, raw: rangeCount.raw, offset: rangeCount.offset } : null,
          finalCount: finalCount ? { value: finalCount.value, raw: finalCount.raw, offset: finalCount.offset } : null,
          warning: attempt.warnings[0] || "",
        });
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score
    || (a.ok === b.ok ? 0 : a.ok ? -1 : 1)
    || Math.abs(a.startDeltaFromLayout ?? 999999) - Math.abs(b.startDeltaFromLayout ?? 999999)
    || Math.abs(a.textGap ?? 999999) - Math.abs(b.textGap ?? 999999)
    || a.start - b.start);

  return candidates.slice(0, 16);
}

function buildTailTokenWindow(stream, groupEnd, context) {
  const textStartRel = context.textStart >= 0 ? context.textStart - context.base : stream.length;
  const layoutRel = context.layoutHint?.objectEnd >= 0 ? context.layoutHint.objectEnd - context.base : -1;
  const pivots = [
    { label: "groupEnd", rel: groupEnd },
    { label: "layoutBoundary", rel: layoutRel },
    { label: "textPool", rel: textStartRel },
  ].filter((pivot) => pivot.rel >= 0 && pivot.rel < stream.length);

  return pivots.map((pivot) => {
    const start = Math.max(0, pivot.rel - 16);
    const end = Math.min(stream.length, pivot.rel + 48);
    const tokens = [];
    let cursor = { value: start };
    while (cursor.value < end && tokens.length < 18) {
      const before = cursor.value;
      const token = readCompactTokenAt(stream, cursor, 0x7fffffff);
      if (!token || cursor.value <= before) {
        tokens.push({
          offset: hex(context.base + before),
          value: null,
          raw: byteHex(stream[before]),
          tag: "undecoded",
        });
        cursor = { value: before + 1 };
        continue;
      }
      tokens.push({
        offset: hex(context.base + before),
        value: token.value,
        raw: token.raw,
        tag: token.tag,
      });
    }
    return {
      label: pivot.label,
      pivot: hex(context.base + pivot.rel),
      window: `${hex(context.base + start)}..${hex(context.base + end)}`,
      bytes: hexBytes(stream.subarray(start, end)),
      visible: Array.from(stream.subarray(start, end)).map((byte) => (byte >= 0x20 && byte <= 0x7E ? String.fromCharCode(byte) : ".")).join(""),
      tokens,
    };
  });
}

function parseAttempt(buf, shortMode, pools, layoutHint) {
  const envelope = parseResourceEnvelope(buf);
  const base = envelope.bodyOffset;
  const stream = buf.subarray(base);
  const cursor = { value: 6 };
  const opcodeHistogram = new Map();
  const groups = [];
  const recordSamples = [];
  const warnings = [];
  let ok = true;
  let header = null;
  let totalRecords = 0;
  let groupEnd = -1;
  let tail = null;
  let tailAttempts = [];
  let tailStartScan = [];
  let tailTokenWindows = [];

  try {
    const slotCapacity = readCompact(stream, cursor, "object+58 slot capacity", 4096);
    const field04 = readCompact(stream, cursor, "object+04");
    const field08Byte = readRaw8(stream, cursor, "object+08 byte");
    const field0C = readCompact(stream, cursor, "object+0C");
    const typeByte = readRaw8(stream, cursor, "object type byte");
    let recordByteSize = { 1: 0x14, 2: 0x28, 3: 0x50 }[typeByte.value] || null;
    let recordByteSizeToken = null;
    if (recordByteSize == null) {
      recordByteSizeToken = readCompact(stream, cursor, "object+1C record byte size", 4096);
      recordByteSize = recordByteSizeToken.value;
    }
    const groupCount = readCompact(stream, cursor, "object+4C group count", 4096);
    header = { slotCapacity, field04, field08Byte, field0C, typeByte, recordByteSize, recordByteSizeToken, groupCount };
    if (groupCount.value < 0 || groupCount.value > 64) throw new Error(`implausible group count ${groupCount.value}`);

    for (let groupIndex = 0; groupIndex < groupCount.value; groupIndex += 1) {
      const groupStart = cursor.value;
      const id = readShort(stream, cursor, shortMode, "group id +0x4C");
      const count = readRaw8(stream, cursor, "group record count");
      if (totalRecords + count.value > 4096) throw new Error(`record budget exceeded at group ${groupIndex}`);
      const records = [];
      for (let recordIndex = 0; recordIndex < count.value; recordIndex += 1) {
        const record = parseRecord(stream, cursor, shortMode, groupIndex, recordIndex);
        addHistogram(opcodeHistogram, record.opcode);
        if (recordSamples.length < 28) recordSamples.push(record);
        if (records.length < 8) records.push(record);
      }
      totalRecords += count.value;
      groups.push({
        index: groupIndex,
        start: groupStart,
        startHex: hex(groupStart),
        id,
        recordCount: count.value,
        recordCountOffset: count.relHex,
        sampleRecords: records,
      });
    }
    groupEnd = cursor.value;
    tailAttempts = buildTailExperiments(stream, cursor.value, {
      base,
      absoluteGroupEnd: base + cursor.value,
      textStart: pools.textPoolStart,
      symbolStart: pools.symbolPoolStart,
      layoutHint,
    });
    tail = tailAttempts[0] || null;
    const tailContext = {
      base,
      absoluteGroupEnd: base + cursor.value,
      textStart: pools.textPoolStart,
      symbolStart: pools.symbolPoolStart,
      layoutHint,
    };
    tailStartScan = buildTailStartScan(stream, cursor.value, tailContext);
    tailTokenWindows = buildTailTokenWindow(stream, cursor.value, tailContext);
  } catch (err) {
    ok = false;
    warnings.push(err.message);
  }

  const opcodeTotal = Array.from(opcodeHistogram.values()).reduce((sum, value) => sum + value, 0);
  const knownOpcodes = Array.from(opcodeHistogram)
    .filter(([opcode]) => opcode >= 0 && opcode <= 8)
    .reduce((sum, [, value]) => sum + value, 0);
  return {
    shortMode,
    ok,
    base,
    baseHex: hex(base),
    groupEnd,
    groupEndHex: hex(base + groupEnd),
    approxTailEnd: tail ? tail.end : -1,
    approxTailEndHex: tail ? hex(base + tail.end) : "",
    header,
    groups,
    totalRecords,
    parsedGroupCount: groups.length,
    opcodeHistogram: topHistogram(opcodeHistogram),
    knownOpcodePercent: opcodeTotal ? Number(((knownOpcodes / opcodeTotal) * 100).toFixed(2)) : 0,
    recordSamples,
    tail,
    tailAttempts: tailAttempts.slice(0, 12),
    tailStartScan,
    tailTokenWindows,
    warnings,
  };
}

function summarizeScript(entry, layoutHints) {
  const buf = fs.readFileSync(entry.output);
  const pools = detectPools(buf);
  const layoutHint = layoutHints.get(entry.cleanName.toLowerCase()) || null;
  const attempts = SHORT_MODES.map((mode) => {
    const attempt = parseAttempt(buf, mode, pools, layoutHint);
    const absoluteGroupEnd = attempt.groupEnd >= 0 ? attempt.base + attempt.groupEnd : -1;
    const absoluteTailEnd = attempt.approxTailEnd >= 0 ? attempt.base + attempt.approxTailEnd : -1;
    const target = pools.textPoolStart >= 0 ? pools.textPoolStart : pools.symbolPoolStart;
    const bytesFromGroupEndToText = target >= 0 && absoluteGroupEnd >= 0 ? target - absoluteGroupEnd : null;
    const bytesFromTailEndToText = target >= 0 && absoluteTailEnd >= 0 ? target - absoluteTailEnd : null;
    const groupGapScore = bytesFromGroupEndToText != null && bytesFromGroupEndToText >= 0
      ? Math.max(0, 40 - Math.floor(bytesFromGroupEndToText / 32))
      : -60;
    const tailGapScore = bytesFromTailEndToText != null && bytesFromTailEndToText >= 0
      ? Math.max(0, 40 - Math.floor(bytesFromTailEndToText / 16))
      : -70;
    const layoutDelta = layoutHint?.objectEnd >= 0 && absoluteTailEnd >= 0 ? absoluteTailEnd - layoutHint.objectEnd : null;
    const layoutScore = layoutDelta == null ? 0 : Math.max(0, 80 - Math.min(80, Math.abs(layoutDelta) * 2));
    return {
      ...attempt,
      absoluteGroupEnd,
      absoluteGroupEndHex: hex(absoluteGroupEnd),
      absoluteTailEnd,
      absoluteTailEndHex: hex(absoluteTailEnd),
      bytesFromGroupEndToText,
      bytesFromTailEndToText,
      layoutHint,
      layoutDelta,
      score: (attempt.ok ? 100 : 0)
        + (attempt.parsedGroupCount === 6 ? 20 : 0)
        + Math.max(0, Math.min(40, attempt.knownOpcodePercent))
        + groupGapScore
        + tailGapScore
        + layoutScore
        + (attempt.tail?.score || 0) / 4,
    };
  }).sort((a, b) => b.score - a.score || Math.abs(a.bytesFromGroupEndToText ?? 99999) - Math.abs(b.bytesFromGroupEndToText ?? 99999));

  return {
    name: entry.cleanName,
    rel: entry.rel,
    size: buf.length,
    envelope: parseResourceEnvelope(buf),
    pools,
    layoutHint,
    attempts,
  };
}

function compactTokenText(token) {
  if (!token) return "";
  return `${token.value} ${token.raw || ""}`.trim();
}

function mdList(items, render) {
  if (!items.length) return "- none\n";
  return items.map((item) => `- ${render(item)}`).join("\n") + "\n";
}

function renderAttemptSummary(script, attempt) {
  const h = attempt.header;
  const groupGap = attempt.bytesFromGroupEndToText == null ? "" : attempt.bytesFromGroupEndToText;
  const tailGap = attempt.bytesFromTailEndToText == null ? "" : attempt.bytesFromTailEndToText;
  const layoutDelta = attempt.layoutDelta == null ? "" : attempt.layoutDelta;
  const tailMode = attempt.tail ? `74=${attempt.tail.modes.ref74Mode},64=${attempt.tail.modes.ref64Mode}` : "?";
  return [
    `${attempt.shortMode}`,
    `ok=${attempt.ok}`,
    `score=${attempt.score}`,
    `groups=${attempt.parsedGroupCount}/${h?.groupCount?.value ?? "?"}`,
    `records=${attempt.totalRecords}`,
    `recordByteSize=${h?.recordByteSize ?? "?"}`,
    `groupEnd=${attempt.absoluteGroupEndHex}`,
    `bestTailEnd=${attempt.absoluteTailEndHex}`,
    `tailOk=${attempt.tail?.ok ?? false}`,
    `tailMode=${tailMode}`,
    `gap(group/text)=${groupGap}`,
    `gap(tail/text)=${tailGap}`,
    `delta(layout)=${layoutDelta}`,
    `knownOpcode=${attempt.knownOpcodePercent}%`,
  ].join("; ");
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# God War XSE Object Trace");
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push("");
  lines.push("## Reading Notes");
  lines.push("");
  lines.push("- This report follows the `DF_Script.c` parser shape around raw CBE `0x112C4`: object header, group table, 0x28-byte opcode records, then trailing reference/range arrays.");
  lines.push("- `+0x4C`, `+0x64`, and `+0x74` semantics are still under investigation, so the report compares short-reader modes and tail reference modes instead of pretending there is a final XSE VM decompiler.");
  lines.push("- Disassembly now separates the XSE stream service from the per-script record table: `sb+0x35C4` supplies stream reads such as `+0x50/+0x64`, while `sb+0x86DC` is the 0x74-byte per-script record table.");
  lines.push("- Literal-pool candidates around `0x115B8/0x11614` can look off by one halfword; treat `+0x74` there as a reader/service callback, not as script-record field `+0x74`.");
  lines.push("- `out_godwar_reader_callbacks` keeps the unresolved callback chain separate: the `0x35C0+0x74` candidates at `0xDCC8/0xDCCA` and `0x11094` are callback-layer clues, not proven primitive XSE reference readers.");
  lines.push("- `groupEnd` is the end of the parsed group/opcode records. `bestTailEnd` is the best-scored diagnostic parse of the later reference/range arrays.");
  lines.push("- Tail experiments are scored against the first text/resource pool and, when present, the layout-report object boundary from `out_godwar_xselayout`.");
  lines.push("");
  lines.push("## Disassembly Anchors");
  lines.push("");
  lines.push("- `0x115B8`: reads the first post-group count through the reader service `+0x50`, allocates `count * 4`, then fills that array through the reader/service `+0x74` callback.");
  lines.push("- `0x11632..0x11660`: walks parsed 0x28-byte opcode records and backfills opcode `2` record field `+0x10` from the first post-group array.");
  lines.push("- `0x11672`: reads the range count through `+0x50`, stores it at script-record `+0x68`, allocates `count * 0x14` at `+0x64`, then each range reads compact start, raw kind byte, compact span, and a `+0x64` reference.");
  lines.push("- `0x11752`: reads the final reference count through `+0x50`, stores it at script-record `+0x70`, allocates `count * 4` at `+0x6C`, then fills it with `+0x64` references.");
  lines.push("");
  lines.push("## Current Conclusions");
  lines.push("");
  lines.push("- The focused opening scripts all share a stable `0x112C4` header shape: parsing starts at stream-relative `+6`, slot capacity reads as `8`, and the group count reads as `6`.");
  lines.push("- The parsed group records are not the final human-readable script order. They are the engine's internal object/opcode table, followed by reference/range arrays and then the text/resource pool.");
  lines.push("- The new tail matrix narrows the overshoot problem to concrete width/alignment candidates for the post-group arrays. Treat the winning modes as alignment hypotheses, not proven VM semantics.");
  lines.push("- `s_02.xse` is the key unresolved case: the best boundary hypothesis now stays before `tianbing.actor`, but its next range-count read is still invalid, so the reader/service `+0x74` reference callback is not decoded yet.");
  lines.push("");

  for (const script of report.scripts) {
    lines.push(`## ${script.name}`);
    lines.push("");
    lines.push(`Rel: ${script.rel}`);
    lines.push(`Size: ${script.size}`);
    lines.push(`Text/resource pool starts: ${script.pools.textPoolStartHex || "unknown"}`);
    lines.push(`Symbol pool starts: ${script.pools.symbolPoolStartHex || "unknown"}`);
    if (script.layoutHint) {
      lines.push(`Layout object boundary: ${hex(script.layoutHint.objectEnd)} (from xse_layout_trace)`);
    }
    lines.push("");
    lines.push("### Attempt Summary");
    lines.push("");
    lines.push(mdList(script.attempts, (attempt) => renderAttemptSummary(script, attempt)));

    const best = script.attempts[0];
    lines.push("### Best Attempt Groups");
    lines.push("");
    lines.push(mdList(best.groups.slice(0, 10), (group) => (
      `group ${group.index} at rel ${group.startHex}: id=${group.id.value} (${group.id.tag} ${group.id.raw}), records=${group.recordCount}`
    )));
    lines.push("### Best Attempt Top Opcodes");
    lines.push("");
    lines.push(mdList(best.opcodeHistogram, (item) => `opcode ${item.key}: ${item.count}`));
    lines.push("### Best Tail Experiments");
    lines.push("");
    lines.push(mdList((best.tailAttempts || []).slice(0, 8), (tail) => (
      `score=${tail.score}; end=${tail.absoluteEndHex}; mode 74=${tail.modes.ref74Mode}, 64=${tail.modes.ref64Mode}; gap(text)=${tail.textGap ?? ""}; delta(layout)=${tail.layoutDelta ?? ""}; ok=${tail.ok}`
    )));
    lines.push("### Tail Start Scan");
    lines.push("");
    lines.push(mdList((best.tailStartScan || []).slice(0, 10), (candidate) => {
      const first = candidate.firstCount ? `${candidate.firstCount.value} ${candidate.firstCount.raw}` : "?";
      const range = candidate.rangeCount ? `${candidate.rangeCount.value} ${candidate.rangeCount.raw}` : "?";
      const final = candidate.finalCount ? `${candidate.finalCount.value} ${candidate.finalCount.raw}` : "?";
      return [
        `start=${candidate.startHex}`,
        `dGroup=${candidate.startDeltaFromGroupEnd}`,
        `dLayout=${candidate.startDeltaFromLayout ?? ""}`,
        `score=${candidate.score}`,
        `ok=${candidate.ok}`,
        `end=${candidate.endHex}`,
        `mode 74=${candidate.modes.ref74Mode},64=${candidate.modes.ref64Mode}`,
        `counts=${first}/${range}/${final}`,
        candidate.startBeforeGroupPenalty ? `startPenalty=${candidate.startBeforeGroupPenalty}` : "",
        candidate.warning ? `warn=${candidate.warning}` : "",
      ].filter(Boolean).join("; ");
    }));
    lines.push("### Tail Token Windows");
    lines.push("");
    lines.push(mdList(best.tailTokenWindows || [], (window) => {
      const tokenText = window.tokens.slice(0, 10).map((token) => `${token.offset}:${token.value ?? "?"}(${token.raw})`).join(" ");
      return `${window.label} ${window.window} pivot=${window.pivot} visible=\`${window.visible}\` tokens=${tokenText}`;
    }));
    lines.push("### First Text/Refs");
    lines.push("");
    lines.push(mdList(script.pools.firstTextRuns.slice(0, 8), (run) => `${run.offsetHex}: ${run.text.replace(/\s*\n\s*/g, " / ")}`));
    lines.push("### Tail Warnings");
    lines.push("");
    const warnings = best.warnings.concat(best.tail?.warnings || []);
    lines.push(mdList(warnings, (warning) => warning));
  }
  return lines.join("\n");
}

async function main() {
  const gameRoot = path.resolve(process.argv[2] || DEFAULT_GAME_ROOT);
  const outDir = path.resolve(process.argv[3] || DEFAULT_OUT);
  const catalog = loadCatalog(gameRoot);
  const layoutHints = loadLayoutHints();
  const scripts = FOCUS
    .map((name) => findEntry(catalog, name))
    .filter(Boolean)
    .map((entry) => summarizeScript(entry, layoutHints));
  const report = {
    schema: "nicai.cbe.xseObjectTrace.v3",
    generatedAt: new Date().toISOString(),
    gameRoot,
    layoutHints: DEFAULT_LAYOUT_JSON,
    scripts,
  };
  await fsp.mkdir(outDir, { recursive: true });
  await fsp.writeFile(path.join(outDir, "xse_object_trace.json"), JSON.stringify(report, null, 2), "utf8");
  await fsp.writeFile(path.join(outDir, "xse_object_trace.md"), renderMarkdown(report), "utf8");
  console.log(`Output: ${outDir}`);
  for (const script of scripts) {
    const best = script.attempts[0];
    console.log(`${script.name}: best=${best.shortMode} records=${best.totalRecords} groupEnd=${best.absoluteGroupEndHex} tailEnd=${best.absoluteTailEndHex} tailMode=74/${best.tail?.modes.ref74Mode || "?"},64/${best.tail?.modes.ref64Mode || "?"}`);
  }
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
