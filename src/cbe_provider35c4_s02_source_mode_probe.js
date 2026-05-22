const fs = require("fs");
const path = require("path");
const { DEFAULT_INPUT, fixupPayload, loadCbeArchive } = require("./cbe_unpack");
const { decodeCompactToken, hexBytes } = require("./cbe_struct");
const { buildReport: buildDispatchReport } = require("./cbe_xse_runtime_dispatch_probe");
const { ParsedProvider35C4StreamExecutor } = require("./cbe_provider35c4_stream_executor_probe");
const { walkLane } = require("./cbe_provider35c4_table_walk_probe");

const DEFAULT_OUT = path.resolve(__dirname, "out_godwar_provider35c4s02source");
const LAYOUT_JSON = path.resolve(__dirname, "out_godwar_xselayout", "xse_layout_trace.json");
const SCRIPT_NAME = "s_02.xse";
const REF_MODES = ["compact", "raw1", "raw2le", "raw2be", "raw3le", "raw3be", "raw4le", "raw4be", "fixed5", "fixed8"];

function hex(n, width = 4) {
  if (!Number.isFinite(n) || n < 0) return "";
  return `0x${n.toString(16).toUpperCase().padStart(width, "0")}`;
}

function parseHex(text) {
  return typeof text === "string" && /^0x/i.test(text) ? parseInt(text, 16) : NaN;
}

function mdRow(values) {
  return `| ${values.map((value) => String(value ?? "").replace(/\|/g, "\\|")).join(" | ")} |`;
}

function readJson(file, fallback = {}) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, "utf8"));
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
  return fixupPayload(entry.name, raw).payload;
}

function refModeByteCount(mode) {
  if (mode === "compact") return 0;
  const fixed = mode.match(/^fixed(\d+)$/);
  if (fixed) return Number(fixed[1]);
  return ({ raw1: 1, raw2le: 2, raw2be: 2, raw3le: 3, raw3be: 3, raw4le: 4, raw4be: 4 }[mode] || 0);
}

function compactAt(buf, cursor, label, limit = 0x7fffffff) {
  const start = cursor.value;
  const token = decodeCompactToken(buf, start);
  if (!token || token.truncated || Math.abs(token.value) > limit) {
    throw new Error(`${label} compact read failed at ${hex(start)}`);
  }
  cursor.value = token.next;
  return {
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

function readRefMode(buf, cursor, mode, label) {
  if (mode === "compact") return compactAt(buf, cursor, label);
  const width = refModeByteCount(mode);
  const start = cursor.value;
  if (!width || start + width > buf.length) throw new Error(`${label} ${mode} failed at ${hex(start)}`);
  cursor.value += width;
  return {
    offset: start,
    offsetHex: hex(start),
    next: cursor.value,
    nextHex: hex(cursor.value),
    width,
    raw: hexBytes(buf.subarray(start, start + width)),
    tag: mode,
  };
}

function parseTableAt(buf, startOffset, modes, bounds) {
  const cursor = { value: startOffset };
  const rows = [];
  const warnings = [];
  let backfillCount = 0;
  let entryCount = 0;
  let finalRefCount = 0;
  let ok = true;
  try {
    const backfill = compactAt(buf, cursor, "0x115B8 opcode2 backfill +0x74 refs count", 256);
    backfillCount = backfill.value;
    rows.push({ kind: "backfill-count", offset: backfill.offsetHex, raw: backfill.raw, value: backfill.value });
    for (let index = 0; index < backfillCount; index += 1) {
      readRefMode(buf, cursor, modes.ref74Mode, `0x115B8 opcode2 backfill +0x74 refs[${index}]`);
    }

    const range = compactAt(buf, cursor, "0x11672 script+0x64 entry/range count", 256);
    entryCount = range.value;
    rows.push({ kind: "range-count", offset: range.offsetHex, raw: range.raw, value: range.value });
    for (let index = 0; index < entryCount; index += 1) {
      const field00 = compactAt(buf, cursor, "entry+00 group cursor");
      const field04Offset = cursor.value;
      if (field04Offset >= buf.length) throw new Error(`entry+04 raw/kind read failed at ${hex(field04Offset)}`);
      cursor.value += 1;
      const field08 = compactAt(buf, cursor, "entry+08 opcode-stack span");
      const ref = readRefMode(buf, cursor, modes.ref64Mode, "entry+10 +0x64 label/ref");
      if (index < 8) {
        rows.push({
          kind: "range-entry",
          index,
          offset: field00.offsetHex,
          field00: field00.value,
          field04: buf[field04Offset],
          field08: field08.value,
          refRaw: ref.raw,
        });
      }
    }

    const finalCount = compactAt(buf, cursor, "0x11752 final +0x64 refs count", 256);
    finalRefCount = finalCount.value;
    rows.push({ kind: "final-count", offset: finalCount.offsetHex, raw: finalCount.raw, value: finalCount.value });
    for (let index = 0; index < finalRefCount; index += 1) {
      readRefMode(buf, cursor, modes.ref64Mode, `0x11752 final +0x64 refs[${index}]`);
    }
  } catch (err) {
    ok = false;
    warnings.push(err.message || String(err));
  }
  const textStart = bounds.textStart;
  const startInTextPool = Number.isFinite(textStart) && startOffset >= textStart;
  const crossesTextPool = Number.isFinite(textStart) && cursor.value > textStart;
  const countsNonNegative = backfillCount >= 0 && entryCount >= 0 && finalRefCount >= 0;
  return {
    modeKey: `74=${modes.ref74Mode},64=${modes.ref64Mode}`,
    modes,
    ok,
    start: hex(startOffset),
    end: hex(cursor.value),
    consumed: cursor.value - startOffset,
    backfillCount,
    entryCount,
    finalRefCount,
    startInTextPool,
    crossesTextPool,
    countsNonNegative,
    poolClean: ok && countsNonNegative && entryCount > 0 && !startInTextPool && !crossesTextPool,
    layoutDelta: Number.isFinite(bounds.objectEnd) ? cursor.value - bounds.objectEnd : null,
    textStartDelta: Number.isFinite(textStart) ? textStart - cursor.value : null,
    rows,
    warnings,
  };
}

function parseAllModesAt(buf, startOffset, bounds) {
  const rows = [];
  for (const ref74Mode of REF_MODES) {
    for (const ref64Mode of REF_MODES) {
      rows.push(parseTableAt(buf, startOffset, { ref74Mode, ref64Mode }, bounds));
    }
  }
  return rows;
}

function scanWindow(buf, startOffset, endOffset, bounds) {
  const rows = [];
  for (let offset = startOffset; offset < endOffset; offset += 1) {
    rows.push(...parseAllModesAt(buf, offset, bounds).filter((row) => row.poolClean));
  }
  return rows.sort((a, b) => (
    Math.abs(a.layoutDelta ?? 999999) - Math.abs(b.layoutDelta ?? 999999)
    || parseHex(a.start) - parseHex(b.start)
    || a.modeKey.localeCompare(b.modeKey)
  ));
}

function summarizeAttempt(attempt, bounds) {
  if (!attempt) return null;
  const groupEnd = parseHex(attempt.groupEnd);
  const tailEnd = parseHex(attempt.tailEnd);
  return {
    mode: attempt.mode || "",
    groupEnd: attempt.groupEnd || "",
    tailEnd: attempt.tailEnd || "",
    layoutDelta: attempt.layoutDelta ?? null,
    dispatchScore: attempt.dispatchScore ?? null,
    executionScore: attempt.executionScore ?? null,
    directGroups: attempt.directGroups ?? null,
    defaultGroups: attempt.defaultGroups ?? null,
    groupIds: attempt.groupIds || [],
    groupEndStartsInTextPool: Number.isFinite(bounds.textStart) && groupEnd >= bounds.textStart,
    tailEndStartsInTextPool: Number.isFinite(bounds.textStart) && tailEnd >= bounds.textStart,
  };
}

function buildInvariant(id, passed, details, impact = "") {
  return { id, passed: Boolean(passed), details, impact };
}

function buildReport(options = {}) {
  const input = path.resolve(options.input || DEFAULT_INPUT);
  const archive = loadCbeArchive(input);
  const entry = findEntry(archive, SCRIPT_NAME);
  const buf = entry ? readResource(archive, entry) : null;
  const layout = readJson(LAYOUT_JSON, {});
  const layoutScript = (layout.scripts || []).find((script) => script.name === SCRIPT_NAME) || {};
  const bounds = {
    objectEnd: parseHex(layoutScript.zones?.objectProbe?.end),
    textStart: parseHex(layoutScript.zones?.textAndResourcePool?.start),
    symbolStart: parseHex(layoutScript.zones?.labelAndSymbolPool?.start),
  };
  const dispatch = buildDispatchReport({ input });
  const dispatchScript = (dispatch.scripts || []).find((script) => script.name === SCRIPT_NAME) || {};
  const tailBest = summarizeAttempt(dispatchScript.tailBest, bounds);
  const dispatchBest = summarizeAttempt(dispatchScript.dispatchBest, bounds);
  const executionBest = summarizeAttempt(dispatchScript.executionBest, bounds);
  const attempts = (dispatchScript.attempts || []).map((attempt) => summarizeAttempt(attempt, bounds));
  const tailEnd = parseHex(tailBest?.tailEnd);
  const groupEnd = parseHex(tailBest?.groupEnd);
  const textStart = bounds.textStart;
  const anchorStarts = [
    { source: "tail-aligned-group-end", offset: groupEnd },
    { source: "tail-aligned-tail-end", offset: tailEnd },
    { source: "layout-object-end", offset: bounds.objectEnd },
    { source: "dispatch-group-end", offset: parseHex(dispatchBest?.groupEnd) },
  ].filter((row) => Number.isFinite(row.offset));
  const anchored = buf
    ? anchorStarts.map((anchor) => {
      const candidates = parseAllModesAt(buf, anchor.offset, bounds).filter((row) => row.poolClean);
      return {
        source: anchor.source,
        offset: hex(anchor.offset),
        offsetInTextPool: Number.isFinite(textStart) && anchor.offset >= textStart,
        poolCleanCandidateCount: candidates.length,
        candidates: candidates.slice(0, 12),
      };
    })
    : [];
  const windowScan = buf && Number.isFinite(groupEnd) && Number.isFinite(textStart)
    ? scanWindow(buf, groupEnd, textStart, bounds)
    : [];
  const tailEndAnchor = anchored.find((row) => row.source === "tail-aligned-tail-end");
  const selected = tailEndAnchor?.candidates.length === 1 ? tailEndAnchor.candidates[0] : null;

  const executor = new ParsedProvider35C4StreamExecutor();
  const lanes = [];
  if (selected) {
    let laneIndex = 0;
    const script = {
      name: SCRIPT_NAME,
      candidates: [{
        role: "s02-tail-aligned-tail-end-table",
        modeKey: selected.modeKey,
        start: selected.start,
        end: selected.end,
      }],
    };
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
  const guardedLanes = lanes.filter((lane) => lane.guardReasons.length > 0 || lane.status !== "table-lane-expanded");
  const invariants = [
    buildInvariant(
      "dispatch-group-end-is-text-pool",
      Boolean(dispatchBest?.groupEndStartsInTextPool),
      `dispatch ${dispatchBest?.mode || "-"} groupEnd=${dispatchBest?.groupEnd || "-"}, textStart=${hex(bounds.textStart)}`,
      "The compact dispatch-scored mode must not be used as a table start when it lands inside text/resource bytes."
    ),
    buildInvariant(
      "tail-end-has-unique-pool-clean-table",
      Boolean(selected),
      `${tailEndAnchor?.poolCleanCandidateCount || 0} pool-clean candidate(s) at tailEnd=${tailBest?.tailEnd || "-"}`,
      "A source-mode handoff is plausible only if the anchored tail end has a narrow, pool-clean table parse."
    ),
    buildInvariant(
      "selected-s02-table-expands-unguarded",
      Boolean(selected) && lanes.length === 2 && guardedLanes.length === 0,
      `${guardedLanes.length}/${lanes.length} selected s_02 lane(s) guarded`,
      "The candidate can feed provider service-object table calls, but only as non-promoting loader evidence."
    ),
    buildInvariant(
      "selected-s02-compares-consume-prior-refs",
      missingRefs.length === 0 && lateRefs.length === 0,
      `${compareOps.length} compare op(s), ${missingRefs.length} missing ref(s), ${lateRefs.length} late ref(s)`,
      "Label/ref compares must remain tied to prior +0x64 producer calls."
    ),
    buildInvariant(
      "selected-s02-keeps-empty-feed-nonmatch",
      return0CompareOps.length === 0,
      `${return0CompareOps.length} return-0 compare(s)`,
      "No visible effects or entry promotion are allowed without real provider return-0 observations."
    ),
  ];
  const failures = invariants.filter((item) => !item.passed);
  return {
    schema: "nicai.cbe.provider35c4S02SourceModeProbe.v1",
    generatedAt: new Date().toISOString(),
    input,
    script: SCRIPT_NAME,
    inputs: {
      layout: LAYOUT_JSON,
      dispatch: "cbe_xse_runtime_dispatch_probe.buildReport({ input })",
      walker: "cbe_provider35c4_table_walk_probe.walkLane",
    },
    bounds: {
      objectEnd: hex(bounds.objectEnd),
      textStart: hex(bounds.textStart),
      symbolStart: hex(bounds.symbolStart),
    },
    attempts,
    tailBest,
    dispatchBest,
    executionBest,
    anchored,
    windowScan: {
      start: hex(groupEnd),
      end: hex(textStart),
      poolCleanCandidateCount: windowScan.length,
      candidates: windowScan.slice(0, 24),
    },
    selected,
    lanes,
    counts: {
      anchoredStartCount: anchored.length,
      tailEndCandidateCount: tailEndAnchor?.poolCleanCandidateCount || 0,
      windowPoolCleanCandidateCount: windowScan.length,
      laneCount: lanes.length,
      guardedLaneCount: guardedLanes.length,
      producerOperationCount: producerOps.length,
      cursorReadOperationCount: cursorReadOps.length,
      compareOperationCount: compareOps.length,
      knownRefCount: executor.service.refs.size,
      return0CompareCount: return0CompareOps.length,
      missingCompareRefCount: missingRefs.length,
      lateCompareRefCount: lateRefs.length,
    },
    invariants,
    summary: {
      status: failures.length ? "provider35c4-s02-source-mode-risk" : "provider35c4-s02-source-mode-tailend-candidate-ready",
      currentFinding: "s_02.xse compact dispatch scoring points into text/resource bytes, while the tail-aligned u16le handoff exposes a unique pool-clean table candidate at tailEnd 0x02A1.",
      emulatorImpact: "The generic loader should treat s_02 as a source-mode handoff ambiguity instead of rescuing the compact text-pool start with count reinterpretation; the 0x02A1 lane is table-loader evidence only until provider return-0 observations exist.",
      nextTarget: "Fold the s_02 tailEnd-selected lane into the selected provider table walker, then bind all selected lanes to real provider +0x50 return-0 observations before entry promotion.",
      visibleEffectsEnabled: false,
      failureCount: failures.length,
    },
  };
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# Provider 0x35C4 s_02 Source Mode Probe");
  lines.push("");
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Input CBE: \`${report.input}\``);
  lines.push(`- Status: ${report.summary.status}`);
  lines.push(`- Finding: ${report.summary.currentFinding}`);
  lines.push(`- Emulator impact: ${report.summary.emulatorImpact}`);
  lines.push(`- Next target: ${report.summary.nextTarget}`);
  lines.push("");
  lines.push("## Bounds");
  lines.push("");
  lines.push(mdRow(["objectEnd", "textStart", "symbolStart"]));
  lines.push(mdRow(["---:", "---:", "---:"]));
  lines.push(mdRow([report.bounds.objectEnd, report.bounds.textStart, report.bounds.symbolStart]));
  lines.push("");
  lines.push("## Attempts");
  lines.push("");
  lines.push(mdRow(["Role", "Mode", "GroupEnd", "TailEnd", "Direct/Default", "GroupEnd In Text", "Score"]));
  lines.push(mdRow(["---", "---", "---:", "---:", "---", "---", "---:"]));
  for (const [role, attempt] of [["tailBest", report.tailBest], ["dispatchBest", report.dispatchBest], ["executionBest", report.executionBest]]) {
    lines.push(mdRow([
      role,
      attempt?.mode || "",
      attempt?.groupEnd || "",
      attempt?.tailEnd || "",
      `${attempt?.directGroups ?? "-"}/${attempt?.defaultGroups ?? "-"}`,
      attempt?.groupEndStartsInTextPool ? "yes" : "no",
      attempt?.executionScore ?? attempt?.dispatchScore ?? "",
    ]));
  }
  lines.push("");
  lines.push("## Anchored Starts");
  lines.push("");
  lines.push(mdRow(["Source", "Offset", "In Text", "Pool-clean Candidates", "First Candidate"]));
  lines.push(mdRow(["---", "---:", "---", "---:", "---"]));
  for (const anchor of report.anchored) {
    const first = anchor.candidates[0];
    lines.push(mdRow([
      anchor.source,
      anchor.offset,
      anchor.offsetInTextPool ? "yes" : "no",
      anchor.poolCleanCandidateCount,
      first ? `${first.modeKey} entries=${first.entryCount} final=${first.finalRefCount} end=${first.end}` : "",
    ]));
  }
  lines.push("");
  lines.push("## Selected Lane");
  lines.push("");
  if (report.selected) {
    lines.push(mdRow(["Start", "Mode", "End", "Backfill", "Entries", "Final", "Text Gap"]));
    lines.push(mdRow(["---:", "---", "---:", "---:", "---:", "---:", "---:"]));
    lines.push(mdRow([
      report.selected.start,
      report.selected.modeKey,
      report.selected.end,
      report.selected.backfillCount,
      report.selected.entryCount,
      report.selected.finalRefCount,
      report.selected.textStartDelta,
    ]));
  } else {
    lines.push("No selected s_02 lane.");
  }
  lines.push("");
  lines.push("## Provider Walk");
  lines.push("");
  lines.push(mdRow(["Lane", "Policy", "Status", "Entries", "Refs", "Compares", "Guards"]));
  lines.push(mdRow(["---:", "---", "---", "---:", "---:", "---:", "---"]));
  for (const lane of report.lanes) {
    lines.push(mdRow([
      lane.laneIndex,
      lane.policy,
      lane.status,
      lane.counts.rangeEntriesWalked,
      lane.counts.rangeRefsProduced,
      lane.counts.labelCompares,
      lane.guardReasons.join("; "),
    ]));
  }
  lines.push("");
  lines.push("## Counts");
  lines.push("");
  lines.push(mdRow(["Field", "Value"]));
  lines.push(mdRow(["---", "---:"]));
  for (const [key, value] of Object.entries(report.counts)) lines.push(mdRow([key, value]));
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
  const jsonFile = path.join(outDir, "provider35c4_s02_source_mode_probe.json");
  const mdFile = path.join(outDir, "provider35c4_s02_source_mode_probe.md");
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
