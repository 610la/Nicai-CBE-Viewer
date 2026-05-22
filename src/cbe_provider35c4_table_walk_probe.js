const fs = require("fs");
const path = require("path");
const { DEFAULT_INPUT, fixupPayload, loadCbeArchive } = require("./cbe_unpack");
const { decodeCompactToken, hexBytes } = require("./cbe_struct");
const { ParsedProvider35C4StreamExecutor, buildReport: buildStreamExecutorReport } = require("./cbe_provider35c4_stream_executor_probe");

const DEFAULT_OUT = path.resolve(__dirname, "out_godwar_provider35c4tablewalk");
const REF64_LOADER_JSON = path.resolve(__dirname, "out_godwar_xseref64loader", "xse_ref64_loader_probe.json");
const LABELS = ["Init", "_main"];

function hex(n, width = 4) {
  if (!Number.isFinite(n) || n < 0) return "";
  return `0x${n.toString(16).toUpperCase().padStart(width, "0")}`;
}

function parseHex(text) {
  return typeof text === "string" && /^0x/i.test(text) ? parseInt(text, 16) : NaN;
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

function mdRow(values) {
  return `| ${values.map((value) => String(value ?? "").replace(/\|/g, "\\|")).join(" | ")} |`;
}

function findEntry(archive, name) {
  const target = normalizeName(name);
  return archive.entries.find((entry) => normalizeName(entry.name) === target) || null;
}

function readResource(archive, entry) {
  const raw = archive.rawPayload(entry);
  const fixed = fixupPayload(entry.name, raw);
  return {
    name: entry.name,
    raw,
    fixed: fixed.payload,
    fixupNote: fixed.note || "",
  };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function parseModeKey(modeKey) {
  const out = {};
  for (const part of String(modeKey || "").split(",")) {
    const [key, value] = part.split("=").map((item) => item.trim());
    if (key === "74") out.ref74Mode = value;
    if (key === "64") out.ref64Mode = value;
  }
  return {
    ref74Mode: out.ref74Mode || "",
    ref64Mode: out.ref64Mode || "",
  };
}

function refModeByteCount(mode) {
  if (mode === "compact") return 0;
  const fixed = String(mode || "").match(/^fixed(\d+)$/);
  if (fixed) return Number(fixed[1]);
  return ({ raw1: 1, raw2le: 2, raw2be: 2, raw3le: 3, raw3be: 3, raw4le: 4, raw4be: 4 }[mode] || 0);
}

function readCompactRaw(buf, cursor, label, limit = 0x7fffffff) {
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

function readRaw8(buf, cursor, label) {
  const start = cursor.value;
  if (start >= buf.length) throw new Error(`${label} raw8 read failed at ${hex(start)}`);
  cursor.value += 1;
  return {
    label,
    offset: start,
    offsetHex: hex(start),
    next: cursor.value,
    nextHex: hex(cursor.value),
    width: 1,
    value: buf[start],
    raw: byteHex(buf[start]),
    tag: "raw8",
  };
}

function readRefModeRaw(buf, cursor, mode, label) {
  if (mode === "compact") return readCompactRaw(buf, cursor, label);
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

function syncRawCursorFromRelative(converted, relativeCursor, rawCursor) {
  rawCursor.value = converted.baseOffset + relativeCursor.value;
}

function readProviderCompact(executor, converted, rawCursor, role, capturePointId, limit = 0x7fffffff) {
  const relativeCursor = { value: rawCursor.value - converted.baseOffset };
  const token = executor.readCompact(converted, relativeCursor, role, capturePointId, limit);
  syncRawCursorFromRelative(converted, relativeCursor, rawCursor);
  return token;
}

function skipBackfillRefs(buf, rawCursor, modes, laneRows) {
  const backfillCount = readCompactRaw(buf, rawCursor, "0x115B8 opcode2 backfill +0x74 refs count", 256).value;
  const valid = Number.isInteger(backfillCount) && backfillCount >= 0 && backfillCount <= 256;
  laneRows.push({
    kind: "backfill-count",
    offset: hex(rawCursor.value),
    count: backfillCount,
    valid,
  });
  if (!valid) {
    return { backfillCount, skipped: true, reason: "invalid-backfill-count" };
  }
  for (let index = 0; index < backfillCount; index += 1) {
    readRefModeRaw(buf, rawCursor, modes.ref74Mode, `0x115B8 opcode2 backfill +0x74 refs[${index}]`);
  }
  return { backfillCount, skipped: false, reason: "" };
}

function walkLane({ archive, executor, script, policy, laneIndex }) {
  const entry = findEntry(archive, script.name);
  const top = script.candidates?.[0] || null;
  const modes = parseModeKey(top?.modeKey || "");
  const startOffset = parseHex(top?.start);
  const laneRows = [];
  const guardReasons = [];
  const counts = {
    rangeEntriesWalked: 0,
    rangeRefsProduced: 0,
    labelCompares: 0,
    cursorReads: 0,
    finalRefsProduced: 0,
  };
  if (!entry || !top || !Number.isFinite(startOffset) || !modes.ref74Mode || !modes.ref64Mode) {
    return {
      script: script.name,
      policy,
      laneIndex,
      status: "table-lane-missing-input",
      modeKey: top?.modeKey || "",
      guardReasons: ["missing-entry-or-mode"],
      counts,
      rows: laneRows,
    };
  }

  const resource = readResource(archive, entry);
  const opened = executor.open(resource);
  const converted = executor.convert(opened, policy);
  const rawCursor = { value: startOffset };

  try {
    const backfill = skipBackfillRefs(converted.raw, rawCursor, modes, laneRows);
    if (backfill.skipped) guardReasons.push(backfill.reason);

    const rangeCountToken = readProviderCompact(
      executor,
      converted,
      rawCursor,
      "0x11672 script+0x64 range count",
      "provider35c4-stream-read-2",
      256,
    );
    counts.cursorReads += 1;
    const rangeCount = rangeCountToken.value;
    const rangeCountValid = Number.isInteger(rangeCount) && rangeCount >= 0 && rangeCount <= 256;
    laneRows.push({
      kind: "range-count",
      offset: rangeCountToken.offset,
      raw: rangeCountToken.raw,
      value: rangeCount,
      valid: rangeCountValid,
    });
    if (!rangeCountValid) {
      guardReasons.push("invalid-range-count");
      return {
        script: script.name,
        policy,
        laneIndex,
        status: "table-lane-guarded",
        modeKey: top.modeKey,
        start: top.start,
        end: hex(rawCursor.value),
        expectedEntryCount: top.entryCount,
        walkedEntryCount: 0,
        guardReasons,
        counts,
        rows: laneRows,
      };
    }

    for (let index = 0; index < rangeCount; index += 1) {
      const entryStart = rawCursor.value;
      const field00 = readProviderCompact(
        executor,
        converted,
        rawCursor,
        `0x116D6 range[${index}]+00 group cursor`,
        "provider35c4-stream-read-2",
      );
      const field04 = readRaw8(converted.raw, rawCursor, `0x116EA range[${index}]+04 raw/kind`);
      const field08 = readProviderCompact(
        executor,
        converted,
        rawCursor,
        `0x1170A range[${index}]+08 stack span`,
        "provider35c4-stream-read-2",
      );
      const refCursorBefore = rawCursor.value;
      const refValue = readRefModeRaw(converted.raw, rawCursor, modes.ref64Mode, `0x1173C range[${index}]+10 provider ref`);
      const ref = executor.readOpaqueProviderRef(converted, refCursorBefore - converted.baseOffset, {
        role: `0x1173C range[${index}]+10 provider ref`,
        context: "xse-range-entry-ref",
      });
      counts.cursorReads += 2;
      counts.rangeEntriesWalked += 1;
      counts.rangeRefsProduced += 1;
      const compareRows = [];
      for (const label of LABELS) {
        const returnValue = executor.compareLabelRef(
          converted,
          ref,
          label,
          `0x1233C range[${index}] label/ref compare`,
          {
            laneIndex,
            start: top.start,
            modeKey: top.modeKey,
            entryIndex: index,
            entryOffset: hex(entryStart),
            field04: field04.value,
            field08: field08.value,
            field0C: field04.value + field08.value + 1,
            refRaw: refValue.raw,
            refMode: modes.ref64Mode,
          },
        );
        counts.labelCompares += 1;
        compareRows.push({ label, returnValue });
      }
      laneRows.push({
        kind: "range-entry",
        index,
        offset: hex(entryStart),
        field00: { offset: field00.offset, raw: field00.raw, value: field00.value },
        field04: { offset: field04.offsetHex, raw: field04.raw, value: field04.value },
        field08: { offset: field08.offset, raw: field08.raw, value: field08.value },
        field0C: field04.value + field08.value + 1,
        field10: { offset: hex(refCursorBefore), raw: refValue.raw, value: refValue.value, mode: modes.ref64Mode },
        providerRefId: ref.providerRefId,
        compares: compareRows,
      });
    }

    const finalCountToken = readProviderCompact(
      executor,
      converted,
      rawCursor,
      "0x11752 final +0x64 refs count",
      "provider35c4-stream-read-3",
      256,
    );
    counts.cursorReads += 1;
    const finalRefCount = finalCountToken.value;
    const finalCountValid = Number.isInteger(finalRefCount) && finalRefCount >= 0 && finalRefCount <= 256;
    laneRows.push({
      kind: "final-ref-count",
      offset: finalCountToken.offset,
      raw: finalCountToken.raw,
      value: finalRefCount,
      valid: finalCountValid,
    });
    if (!finalCountValid) {
      guardReasons.push("invalid-final-ref-count");
    } else {
      for (let index = 0; index < finalRefCount; index += 1) {
        const refCursorBefore = rawCursor.value;
        const refValue = readRefModeRaw(converted.raw, rawCursor, modes.ref64Mode, `0x11792 final[${index}] +0x64 provider ref`);
        const ref = executor.readOpaqueProviderRef(converted, refCursorBefore - converted.baseOffset, {
          role: `0x11792 final[${index}] +0x64 provider ref`,
          context: "xse-final-ref",
        });
        counts.finalRefsProduced += 1;
        laneRows.push({
          kind: "final-ref",
          index,
          offset: hex(refCursorBefore),
          raw: refValue.raw,
          value: refValue.value,
          mode: modes.ref64Mode,
          providerRefId: ref.providerRefId,
        });
      }
    }

    return {
      script: script.name,
      policy,
      laneIndex,
      status: guardReasons.length ? "table-lane-guarded" : "table-lane-expanded",
      modeKey: top.modeKey,
      start: top.start,
      end: hex(rawCursor.value),
      expectedEntryCount: top.entryCount,
      expectedFinalRefCount: top.finalRefCount,
      walkedEntryCount: counts.rangeEntriesWalked,
      guardReasons,
      counts,
      rows: laneRows.slice(0, 96),
    };
  } catch (err) {
    guardReasons.push(err.message || String(err));
    return {
      script: script.name,
      policy,
      laneIndex,
      status: "table-lane-error",
      modeKey: top.modeKey,
      start: top.start,
      end: hex(rawCursor.value),
      expectedEntryCount: top.entryCount,
      guardReasons,
      counts,
      rows: laneRows.slice(0, 96),
    };
  }
}

function buildInvariant(id, passed, details, impact = "") {
  return { id, passed: Boolean(passed), details, impact };
}

function buildReport(options = {}) {
  const input = path.resolve(options.input || DEFAULT_INPUT);
  const archive = loadCbeArchive(input);
  const ref64Loader = readJson(REF64_LOADER_JSON);
  const baseline = buildStreamExecutorReport({ input });
  const executor = new ParsedProvider35C4StreamExecutor();
  const lanes = [];
  let laneIndex = 0;
  for (const script of ref64Loader.scripts || []) {
    for (const policy of ["xse-body-prefix", "xse-magic-pointer"]) {
      laneIndex += 1;
      lanes.push(walkLane({ archive, executor, script, policy, laneIndex }));
    }
  }
  const producerOps = executor.service.operations.filter((op) => op.dispatchShape === "provider-ref-producer");
  const cursorReadOps = executor.service.operations.filter((op) => op.dispatchShape === "stream-cursor-read");
  const compareOps = executor.service.operations.filter((op) => op.dispatchShape === "label-ref-compare");
  const return0CompareOps = compareOps.filter((op) => op.resultValue === 0);
  const missingRefs = compareOps.filter((op) => !op.refKnown);
  const lateRefs = compareOps.filter((op) => op.refKnown && !(op.refProducerSeq < op.sourceSeq));
  const methodShapes = Array.from(new Set(executor.service.operations.map((op) => `${op.method}:${op.dispatchShape}`))).sort();
  const expandedLanes = lanes.filter((lane) => lane.counts.rangeEntriesWalked > 0);
  const guardedLanes = lanes.filter((lane) => lane.guardReasons.length > 0 || lane.status !== "table-lane-expanded");
  const tableEntryRefCount = lanes.reduce((sum, lane) => sum + lane.counts.rangeRefsProduced, 0);
  const baselineRefCount = baseline.summary?.producerOperationCount || 0;
  const invariants = [
    buildInvariant(
      "full-table-walk-expands-beyond-samples",
      tableEntryRefCount > baselineRefCount,
      `${tableEntryRefCount} table range ref(s), ${baselineRefCount} previous sampled/base ref(s)`,
      "The next feeder must walk more than the previous sampled offset set."
    ),
    buildInvariant(
      "guarded-lanes-stay-nonpromoting",
      guardedLanes.length > 0,
      `${guardedLanes.length}/${lanes.length} guarded lane(s)`,
      "Negative or suspicious counts must be recorded as blockers instead of promoted as executable script state."
    ),
    buildInvariant(
      "plus50-table-shapes-stay-split",
      methodShapes.includes("+0x50:stream-cursor-read") && methodShapes.includes("+0x50:label-ref-compare"),
      methodShapes.join(", "),
      "The table walk must keep range-field cursor reads and label/ref compares distinct."
    ),
    buildInvariant(
      "table-compare-refs-known-and-prior",
      missingRefs.length === 0 && lateRefs.length === 0,
      `${compareOps.length} compare op(s), ${missingRefs.length} missing ref(s), ${lateRefs.length} late ref(s)`,
      "Every table label/ref compare must consume a prior +0x64 range handle."
    ),
    buildInvariant(
      "empty-feed-keeps-table-walk-nonmatch",
      return0CompareOps.length === 0,
      `${return0CompareOps.length} return-0 compare(s)`,
      "Full table expansion still cannot enable visible effects without real provider return-0 observations."
    ),
  ];
  const failures = invariants.filter((item) => !item.passed);
  return {
    schema: "nicai.cbe.provider35c4TableWalkProbe.v1",
    generatedAt: new Date().toISOString(),
    input,
    inputs: {
      ref64Loader: REF64_LOADER_JSON,
      previousParsedStreamFeeder: "cbe_provider35c4_stream_executor_probe.buildReport({ input })",
    },
    tableContract: {
      sourceMode: "guarded-0x112c4-range-table-walk",
      serviceGlobal: executor.service.global,
      rangeTableSites: ["0x11672 count", "0x116D6 +00 +0x50", "0x1170A +08 +0x50", "0x1173C +10 +0x64"],
      compareSite: "0x1233C label/ref +0x50",
      labels: LABELS,
      traceEventsUsedAsInput: false,
      guardedCountsStayNonPromoting: true,
      visibleEffectsEnabled: false,
    },
    counts: {
      laneCount: lanes.length,
      expandedLaneCount: expandedLanes.length,
      guardedLaneCount: guardedLanes.length,
      serviceOperationCount: executor.service.operations.length,
      producerOperationCount: producerOps.length,
      cursorReadOperationCount: cursorReadOps.length,
      compareOperationCount: compareOps.length,
      knownRefCount: executor.service.refs.size,
      tableEntryRefCount,
      finalRefProducedCount: lanes.reduce((sum, lane) => sum + lane.counts.finalRefsProduced, 0),
      return0CompareCount: return0CompareOps.length,
      missingCompareRefCount: missingRefs.length,
      lateCompareRefCount: lateRefs.length,
      previousParsedCallCount: baseline.summary?.parsedCallCount || 0,
      previousProducerOperationCount: baseline.summary?.producerOperationCount || 0,
    },
    lanes,
    operations: executor.service.operations.slice(0, 192),
    refLedger: executor.refAllocator.refs.slice(0, 192),
    invariants,
    summary: {
      status: failures.length ? "provider35c4-full-table-walk-risk" : "provider35c4-full-table-walk-guarded",
      currentFinding: "The parsed provider 0x35C4 feeder can now expand the 0x112C4/0x11672 range table into direct service-object calls, while guarding negative or suspicious count lanes from promotion.",
      emulatorImpact: "This moves the generic CBE emulator from sampled XSE ref offsets toward a real table-walk loader. It deliberately records count/mode blockers and keeps visible script effects disabled.",
      nextTarget: "Resolve the signed/count and final-ref mode ambiguity in the full 0x112C4 table walk, then bind real provider +0x50 return-0 observations before entry promotion.",
      visibleEffectsEnabled: false,
      failureCount: failures.length,
      laneCount: lanes.length,
      expandedLaneCount: expandedLanes.length,
      guardedLaneCount: guardedLanes.length,
      producerOperationCount: producerOps.length,
      cursorReadOperationCount: cursorReadOps.length,
      compareOperationCount: compareOps.length,
      knownRefCount: executor.service.refs.size,
      tableEntryRefCount,
      return0CompareCount: return0CompareOps.length,
    },
  };
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# Provider 0x35C4 Table Walk Probe");
  lines.push("");
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Input CBE: \`${report.input}\``);
  lines.push(`- Status: ${report.summary.status}`);
  lines.push(`- Finding: ${report.summary.currentFinding}`);
  lines.push(`- Emulator impact: ${report.summary.emulatorImpact}`);
  lines.push(`- Next target: ${report.summary.nextTarget}`);
  lines.push("");
  lines.push("## Table Contract");
  lines.push("");
  lines.push(mdRow(["Field", "Value"]));
  lines.push(mdRow(["---", "---"]));
  for (const [key, value] of Object.entries(report.tableContract)) {
    lines.push(mdRow([key, Array.isArray(value) ? value.join(", ") : value]));
  }
  lines.push("");
  lines.push("## Counts");
  lines.push("");
  lines.push(mdRow(["Field", "Value"]));
  lines.push(mdRow(["---", "---:"]));
  for (const [key, value] of Object.entries(report.counts)) lines.push(mdRow([key, value]));
  lines.push("");
  lines.push("## Lanes");
  lines.push("");
  lines.push(mdRow(["Lane", "Script", "Policy", "Mode", "Status", "Entries", "Refs", "Compares", "Guards"]));
  lines.push(mdRow(["---:", "---", "---", "---", "---", "---:", "---:", "---:", "---"]));
  for (const lane of report.lanes) {
    lines.push(mdRow([
      lane.laneIndex,
      lane.script,
      lane.policy,
      lane.modeKey,
      lane.status,
      lane.counts.rangeEntriesWalked,
      lane.counts.rangeRefsProduced,
      lane.counts.labelCompares,
      lane.guardReasons.join("; "),
    ]));
  }
  lines.push("");
  lines.push("## Invariants");
  lines.push("");
  lines.push(mdRow(["Invariant", "Pass", "Details", "Impact"]));
  lines.push(mdRow(["---", "---", "---", "---"]));
  for (const invariant of report.invariants) {
    lines.push(mdRow([invariant.id, invariant.passed ? "yes" : "no", invariant.details, invariant.impact]));
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
  const jsonFile = path.join(outDir, "provider35c4_table_walk_probe.json");
  const mdFile = path.join(outDir, "provider35c4_table_walk_probe.md");
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
  walkLane,
};
