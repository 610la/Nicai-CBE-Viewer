const fs = require("fs");
const path = require("path");
const { DEFAULT_INPUT, fixupPayload, loadCbeArchive } = require("./cbe_unpack");
const { decodeCompactToken, hexBytes } = require("./cbe_struct");
const { buildReport: buildEntrypointReport } = require("./cbe_xse_entrypoint_probe");
const { buildReport: buildS02SourceModeReport } = require("./cbe_provider35c4_s02_source_mode_probe");

const DEFAULT_OUT = path.resolve(__dirname, "out_godwar_provider35c4frontiermodes");
const LAYOUT_JSON = path.resolve(__dirname, "out_godwar_xselayout", "xse_layout_trace.json");
const RUNTIME_DISPATCH_JSON = path.resolve(__dirname, "out_godwar_xsedispatch", "xse_runtime_dispatch_probe.json");
const SWITCH_REPLAY_JSON = path.resolve(__dirname, "out_godwar_xseswitchreplay", "xse_switch_replay_probe.json");
const DISPATCH_CASE_JSON = path.resolve(__dirname, "out_godwar_xsedispatchcases", "xse_dispatch_case_probe.json");
const FOCUS_XSE = ["s_01.xse", "s_02.xse", "s_03.xse", "s_04.xse"];
const REF_MODES = ["compact", "raw1", "raw2le", "raw2be", "raw3le", "raw3be", "raw4le", "raw4be", "fixed5", "fixed8"];
const POINTER_TYPES = new Set([3, 4, 8]);
const WRITEBACK_TARGETS = new Set(["0x011D4C", "0x011ED4"]);

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

function modeKeyFromModes(modes) {
  return `74=${modes?.ref74Mode || "-"},64=${modes?.ref64Mode || "-"}`;
}

function modesFromModeKey(modeKey) {
  const out = {};
  for (const part of String(modeKey || "").split(",")) {
    const [key, value] = part.split("=").map((item) => item.trim());
    if (key === "74") out.ref74Mode = value;
    if (key === "64") out.ref64Mode = value;
  }
  return out;
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
    value: token.value,
    raw: token.raw,
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
    raw: hexBytes(buf.subarray(start, start + width)),
  };
}

function parseTable(buf, startOffset, modes) {
  const cursor = { value: startOffset };
  const entries = [];
  const warnings = [];
  let ok = true;
  let backfillCount = 0;
  let entryCount = 0;
  let finalRefCount = 0;
  try {
    const backfill = compactAt(buf, cursor, "0x115B8 opcode2 backfill +0x74 refs count", 256);
    backfillCount = backfill.value;
    for (let index = 0; index < backfillCount; index += 1) {
      readRefMode(buf, cursor, modes.ref74Mode, `0x115B8 opcode2 backfill +0x74 refs[${index}]`);
    }
    const range = compactAt(buf, cursor, "0x11672 script+0x64 entry/range count", 256);
    entryCount = range.value;
    for (let index = 0; index < entryCount; index += 1) {
      const field00 = compactAt(buf, cursor, "entry+00 group cursor");
      const field04Offset = cursor.value;
      if (field04Offset >= buf.length) throw new Error(`entry+04 raw/kind read failed at ${hex(field04Offset)}`);
      const field04 = buf[field04Offset];
      cursor.value += 1;
      const field08 = compactAt(buf, cursor, "entry+08 opcode-stack span");
      const ref = readRefMode(buf, cursor, modes.ref64Mode, "entry+10 +0x64 label/ref");
      entries.push({
        index,
        offset: field00.offsetHex,
        field00: field00.value,
        field04,
        field08: field08.value,
        field0C: field04 + field08.value + 1,
        refRaw: ref.raw,
      });
    }
    const finalCount = compactAt(buf, cursor, "0x11752 final +0x64 refs count", 256);
    finalRefCount = finalCount.value;
    for (let index = 0; index < finalRefCount; index += 1) {
      readRefMode(buf, cursor, modes.ref64Mode, `0x11752 final +0x64 refs[${index}]`);
    }
  } catch (err) {
    ok = false;
    warnings.push(err.message || String(err));
  }
  return {
    ok,
    start: hex(startOffset),
    end: hex(cursor.value),
    endOffset: cursor.value,
    backfillCount,
    entryCount,
    finalRefCount,
    entries,
    warnings,
  };
}

function byName(rows) {
  return new Map((rows || []).map((row) => [row.name, row]));
}

function runtimeSourceMode(scriptName, runtimeScript) {
  if (scriptName === "s_02.xse") {
    return { source: "tail-aligned-source-mode", mode: runtimeScript?.tailBest?.mode || "" };
  }
  return {
    source: "execution-best-source-mode",
    mode: runtimeScript?.executionBest?.mode || runtimeScript?.dispatchBest?.mode || runtimeScript?.tailBest?.mode || "",
  };
}

function switchGroupsFor(scriptName, mode, switchReplay) {
  const script = (switchReplay.scripts || []).find((row) => row.name === scriptName);
  if (!script) return [];
  const attempt = (script.attempts || []).find((row) => row.ok && row.shortMode === mode)
    || (script.best?.shortMode === mode ? script.best : null)
    || (script.attempts || []).find((row) => row.ok)
    || script.best;
  return attempt?.groups || [];
}

function targetForGroup(groupId, caseProbe) {
  if (!Number.isInteger(groupId) || groupId < 0 || groupId > 0x20) {
    return caseProbe.dispatcher?.primaryDefaultTarget || "0x011FE0";
  }
  const window = (caseProbe.caseWindows || []).find((row) => (row.groupIds || []).includes(groupId));
  return window?.target || caseProbe.dispatcher?.primaryDefaultTarget || "0x011FE0";
}

function classifyEntry(entry, label, groups, caseProbe) {
  const cursor = entry.field00;
  const cursorValid = Number.isInteger(cursor) && cursor >= 0 && cursor < groups.length;
  const group = cursorValid ? groups[cursor] : null;
  const groupId = group?.id?.value;
  const target = cursorValid ? targetForGroup(groupId, caseProbe) : "";
  const defaultTarget = caseProbe.dispatcher?.primaryDefaultTarget || "0x011FE0";
  const directCaseDispatch = Number.isInteger(groupId) && groupId >= 0 && groupId <= 0x20 && target !== defaultTarget;
  const defaultDispatchOnly = cursorValid && !directCaseDispatch;
  const operand0 = group?.records?.[0]?.opcode ?? null;
  const stackDelta = Number.isInteger(entry.field08) ? entry.field08 + 1 : null;
  const stackDeltaCoherent = Number.isInteger(stackDelta) && stackDelta >= 0 && stackDelta <= 256;
  const writebackTarget = WRITEBACK_TARGETS.has(target);
  const operand0Pointer = POINTER_TYPES.has(operand0);
  const writebackBlocked = writebackTarget && !operand0Pointer;
  const schedulerCandidateIfObserved = cursorValid && stackDeltaCoherent && !writebackBlocked;
  const promotionEligibleIfObserved = schedulerCandidateIfObserved && directCaseDispatch;
  return {
    label,
    cursor,
    cursorValid,
    groupId,
    target,
    directCaseDispatch,
    defaultDispatchOnly,
    operand0,
    operand0Hex: Number.isInteger(operand0) ? `0x${operand0.toString(16).toUpperCase().padStart(2, "0")}` : "",
    stackDelta,
    stackDeltaCoherent,
    writebackTarget,
    operand0Pointer,
    writebackBlocked,
    schedulerCandidateIfObserved,
    promotionEligibleIfObserved,
  };
}

function classifyCandidate({ scriptName, candidate, buf, bounds, groups, caseProbe }) {
  const startOffset = parseHex(candidate.start);
  const modes = candidate.modes || modesFromModeKey(candidate.modeKey);
  const modeKey = candidate.modeKey || modeKeyFromModes(modes);
  const parsed = Number.isFinite(startOffset) ? parseTable(buf, startOffset, modes) : { ok: false, entries: [], endOffset: NaN, warnings: ["bad-start"] };
  const startInTextPool = Number.isFinite(bounds.textStart) && startOffset >= bounds.textStart;
  const crossesTextPool = Number.isFinite(bounds.textStart) && parsed.endOffset > bounds.textStart;
  const countsNonNegative = parsed.backfillCount >= 0 && parsed.entryCount >= 0 && parsed.finalRefCount >= 0;
  const poolClean = parsed.ok && countsNonNegative && parsed.entryCount > 0 && !startInTextPool && !crossesTextPool;
  const compareRows = [];
  for (const entry of parsed.entries) {
    for (const label of ["Init", "_main"]) {
      compareRows.push({ entry, ...classifyEntry(entry, label, groups, caseProbe) });
    }
  }
  const validCursorRows = compareRows.filter((row) => row.cursorValid);
  const schedulerRows = compareRows.filter((row) => row.schedulerCandidateIfObserved);
  const directRows = compareRows.filter((row) => row.promotionEligibleIfObserved);
  return {
    script: scriptName,
    source: candidate.source || "entrypoint-tail-candidate",
    modeKey,
    start: parsed.start || candidate.start || "",
    end: parsed.end || "",
    layoutDelta: Number.isFinite(bounds.objectEnd) ? parsed.endOffset - bounds.objectEnd : null,
    textStartDelta: Number.isFinite(bounds.textStart) ? bounds.textStart - parsed.endOffset : null,
    ok: Boolean(parsed.ok),
    poolClean,
    startInTextPool,
    crossesTextPool,
    countsNonNegative,
    backfillCount: parsed.backfillCount,
    entryCount: parsed.entryCount,
    finalRefCount: parsed.finalRefCount,
    compareCount: compareRows.length,
    validCursorCompareCount: validCursorRows.length,
    schedulerCandidateIfObservedCount: schedulerRows.length,
    promotionEligibleIfObservedCount: directRows.length,
    defaultOnlyIfObservedCount: schedulerRows.filter((row) => row.defaultDispatchOnly).length,
    writebackBlockedIfObservedCount: compareRows.filter((row) => row.writebackBlocked).length,
    schedulerRows: schedulerRows.slice(0, 8).map((row) => ({
      entryIndex: row.entry.index,
      entryOffset: row.entry.offset,
      label: row.label,
      cursor: row.cursor,
      field04: row.entry.field04,
      field08: row.entry.field08,
      field0C: row.entry.field0C,
      refRaw: row.entry.refRaw,
      refMode: modes.ref64Mode,
      groupId: row.groupId,
      target: row.target,
      operand0Hex: row.operand0Hex,
      stackDelta: row.stackDelta,
      directCaseDispatch: row.directCaseDispatch,
      defaultDispatchOnly: row.defaultDispatchOnly,
    })),
    directRows: directRows.slice(0, 8).map((row) => ({
      entryIndex: row.entry.index,
      entryOffset: row.entry.offset,
      label: row.label,
      cursor: row.cursor,
      field04: row.entry.field04,
      field08: row.entry.field08,
      field0C: row.entry.field0C,
      refRaw: row.entry.refRaw,
      refMode: modes.ref64Mode,
      groupId: row.groupId,
      target: row.target,
      operand0Hex: row.operand0Hex,
      stackDelta: row.stackDelta,
    })),
    warnings: parsed.warnings || [],
  };
}

function collectCandidates(script, s02Source) {
  const rows = [];
  for (const candidate of script.tailCandidates || []) {
    rows.push({
      source: "entrypoint-tail-candidate",
      start: candidate.start,
      modeKey: modeKeyFromModes(candidate.modes),
      modes: candidate.modes,
    });
  }
  if (script.name === "s_02.xse") {
    if (s02Source.selected) {
      rows.push({
        source: "s02-tailEnd-selected",
        start: s02Source.selected.start,
        modeKey: s02Source.selected.modeKey,
        modes: s02Source.selected.modes,
      });
    }
    for (const candidate of s02Source.windowScan?.candidates || []) {
      rows.push({
        source: "s02-window-pool-clean",
        start: candidate.start,
        modeKey: candidate.modeKey,
        modes: candidate.modes || modesFromModeKey(candidate.modeKey),
      });
    }
  }
  const seen = new Set();
  return rows.filter((row) => {
    const key = `${row.start}|${row.modeKey}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return REF_MODES.includes(row.modes?.ref74Mode) && REF_MODES.includes(row.modes?.ref64Mode);
  });
}

function buildInvariant(id, passed, details, impact = "") {
  return { id, passed: Boolean(passed), details, impact };
}

function buildReport(options = {}) {
  const input = path.resolve(options.input || DEFAULT_INPUT);
  const archive = loadCbeArchive(input);
  const entrypoint = buildEntrypointReport({ input, includeAllEntries: true, candidateLimit: 100 });
  const s02Source = buildS02SourceModeReport({ input });
  const layout = readJson(LAYOUT_JSON, {});
  const runtimeDispatch = readJson(RUNTIME_DISPATCH_JSON, {});
  const switchReplay = readJson(SWITCH_REPLAY_JSON, {});
  const caseProbe = readJson(DISPATCH_CASE_JSON, {});
  const layoutByName = byName(layout.scripts);
  const runtimeByName = byName(runtimeDispatch.scripts);
  const scripts = [];
  for (const script of (entrypoint.scripts || []).filter((row) => FOCUS_XSE.includes(row.name))) {
    const entry = findEntry(archive, script.name);
    const buf = entry ? readResource(archive, entry) : null;
    const layoutScript = layoutByName.get(script.name) || {};
    const bounds = {
      objectEnd: parseHex(layoutScript.zones?.objectProbe?.end),
      textStart: parseHex(layoutScript.zones?.textAndResourcePool?.start),
      symbolStart: parseHex(layoutScript.zones?.labelAndSymbolPool?.start),
    };
    const sourceMode = runtimeSourceMode(script.name, runtimeByName.get(script.name));
    const groups = switchGroupsFor(script.name, sourceMode.mode, switchReplay);
    const candidates = buf
      ? collectCandidates(script, s02Source).map((candidate) => classifyCandidate({ scriptName: script.name, candidate, buf, bounds, groups, caseProbe }))
      : [];
    const poolClean = candidates.filter((candidate) => candidate.poolClean);
    const scheduler = poolClean.filter((candidate) => candidate.schedulerCandidateIfObservedCount > 0);
    const direct = poolClean.filter((candidate) => candidate.promotionEligibleIfObservedCount > 0);
    candidates.sort((a, b) => (
      Number(b.poolClean) - Number(a.poolClean)
      || b.promotionEligibleIfObservedCount - a.promotionEligibleIfObservedCount
      || b.schedulerCandidateIfObservedCount - a.schedulerCandidateIfObservedCount
      || Math.abs(a.layoutDelta ?? 999999) - Math.abs(b.layoutDelta ?? 999999)
      || parseHex(a.start) - parseHex(b.start)
    ));
    scripts.push({
      name: script.name,
      sourceMode,
      bounds: {
        objectEnd: hex(bounds.objectEnd),
        textStart: hex(bounds.textStart),
        symbolStart: hex(bounds.symbolStart),
      },
      groupCount: groups.length,
      scannedCandidateCount: candidates.length,
      poolCleanCandidateCount: poolClean.length,
      schedulerCandidateModeCount: scheduler.length,
      directPromotionCandidateModeCount: direct.length,
      topCandidates: candidates.slice(0, 16),
      directPromotionCandidates: direct.slice(0, 16),
      schedulerCandidates: scheduler.slice(0, 64),
    });
  }
  const allCandidates = scripts.flatMap((script) => script.topCandidates.map((candidate) => ({ script: script.name, ...candidate })));
  const directScripts = scripts.filter((script) => script.directPromotionCandidateModeCount > 0);
  const schedulerScripts = scripts.filter((script) => script.schedulerCandidateModeCount > 0);
  const totalScanned = scripts.reduce((sum, script) => sum + script.scannedCandidateCount, 0);
  const totalPoolClean = scripts.reduce((sum, script) => sum + script.poolCleanCandidateCount, 0);
  const totalSchedulerModes = scripts.reduce((sum, script) => sum + script.schedulerCandidateModeCount, 0);
  const totalDirectModes = scripts.reduce((sum, script) => sum + script.directPromotionCandidateModeCount, 0);
  const invariants = [
    buildInvariant(
      "mode-scan-covers-focused-scripts",
      scripts.length === FOCUS_XSE.length,
      `${scripts.length}/${FOCUS_XSE.length} focused script(s) scanned`,
      "Source-mode refinement must stay generic across the focused XSE set."
    ),
    buildInvariant(
      "pool-clean-modes-exist",
      totalPoolClean > 0,
      `${totalPoolClean}/${totalScanned} scanned candidate mode(s) are pool-clean`,
      "The scan needs pool-clean alternatives before checking promotion frontiers."
    ),
    buildInvariant(
      "direct-frontier-remains-unpromoted",
      totalDirectModes === 0,
      `${totalDirectModes} direct-case candidate mode(s), ${totalSchedulerModes} scheduler candidate mode(s)`,
      "Mode scans are diagnostics only; no visible effect can be enabled without direct-case and observed return-0 evidence."
    ),
    buildInvariant(
      "scheduler-modes-are-diagnostic",
      schedulerScripts.every((script) => script.directPromotionCandidateModeCount === 0),
      `${schedulerScripts.map((script) => script.name).join(", ") || "none"} have scheduler-only candidates`,
      "Scheduler-only/default-dispatch candidates are useful capture priorities but not promotion rows."
    ),
  ];
  const failures = invariants.filter((item) => !item.passed);
  return {
    schema: "nicai.cbe.provider35c4FrontierModeScanProbe.v1",
    generatedAt: new Date().toISOString(),
    input,
    inputs: {
      entrypoint: "cbe_xse_entrypoint_probe.buildReport({ includeAllEntries: true, candidateLimit: 100 })",
      s02SourceMode: "cbe_provider35c4_s02_source_mode_probe.buildReport({ input })",
      layout: LAYOUT_JSON,
      runtimeDispatch: RUNTIME_DISPATCH_JSON,
      switchReplay: SWITCH_REPLAY_JSON,
      dispatchCases: DISPATCH_CASE_JSON,
    },
    counts: {
      scriptCount: scripts.length,
      scannedCandidateCount: totalScanned,
      poolCleanCandidateCount: totalPoolClean,
      schedulerCandidateModeCount: totalSchedulerModes,
      directPromotionCandidateModeCount: totalDirectModes,
      schedulerCandidateScriptCount: schedulerScripts.length,
      directPromotionCandidateScriptCount: directScripts.length,
    },
    scripts,
    candidateHead: allCandidates.slice(0, 48),
    invariants,
    summary: {
      status: failures.length ? "provider35c4-frontier-mode-scan-risk" : "provider35c4-frontier-mode-scan-guarded",
      currentFinding: `A broader pool-clean source/mode scan found ${totalSchedulerModes} scheduler-only candidate mode(s) but ${totalDirectModes} direct-case promotion candidate mode(s).`,
      emulatorImpact: "This keeps source-mode refinement evidence-backed: alternative table modes may prioritize provider return-0 capture, but none currently justify visible XSE execution.",
      nextTarget: "Use live provider return-0 capture to validate scheduler-only candidates, then refine source/table modes until a return-0 row also reaches a direct-case promotion frontier.",
      visibleEffectsEnabled: false,
      failureCount: failures.length,
      scannedCandidateCount: totalScanned,
      poolCleanCandidateCount: totalPoolClean,
      schedulerCandidateModeCount: totalSchedulerModes,
      directPromotionCandidateModeCount: totalDirectModes,
    },
  };
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# Provider 0x35C4 Frontier Mode Scan Probe");
  lines.push("");
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Input CBE: \`${report.input}\``);
  lines.push(`- Status: ${report.summary.status}`);
  lines.push(`- Finding: ${report.summary.currentFinding}`);
  lines.push(`- Emulator impact: ${report.summary.emulatorImpact}`);
  lines.push(`- Next target: ${report.summary.nextTarget}`);
  lines.push("");
  lines.push("## Counts");
  lines.push("");
  lines.push(mdRow(["Field", "Value"]));
  lines.push(mdRow(["---", "---:"]));
  for (const [key, value] of Object.entries(report.counts)) lines.push(mdRow([key, value]));
  lines.push("");
  lines.push("## Scripts");
  lines.push("");
  lines.push(mdRow(["Script", "Source mode", "Scanned", "Pool-clean", "Scheduler modes", "Direct modes", "Top candidate"]));
  lines.push(mdRow(["---", "---", "---:", "---:", "---:", "---:", "---"]));
  for (const script of report.scripts) {
    const top = script.topCandidates[0];
    lines.push(mdRow([
      script.name,
      `${script.sourceMode.source}:${script.sourceMode.mode}`,
      script.scannedCandidateCount,
      script.poolCleanCandidateCount,
      script.schedulerCandidateModeCount,
      script.directPromotionCandidateModeCount,
      top ? `${top.source} ${top.start} ${top.modeKey} entries=${top.entryCount} sched=${top.schedulerCandidateIfObservedCount} direct=${top.promotionEligibleIfObservedCount}` : "",
    ]));
  }
  lines.push("");
  lines.push("## Scheduler Candidate Modes");
  lines.push("");
  lines.push(mdRow(["Script", "Source", "Start", "Mode", "Entries", "Scheduler", "Direct", "First Scheduler Row"]));
  lines.push(mdRow(["---", "---", "---:", "---", "---:", "---:", "---:", "---"]));
  for (const script of report.scripts) {
    for (const candidate of script.schedulerCandidates.slice(0, 8)) {
      const first = candidate.schedulerRows[0];
      lines.push(mdRow([
        script.name,
        candidate.source,
        candidate.start,
        candidate.modeKey,
        candidate.entryCount,
        candidate.schedulerCandidateIfObservedCount,
        candidate.promotionEligibleIfObservedCount,
        first ? `entry${first.entryIndex} ${first.label} cursor=${first.cursor} gid=${first.groupId} target=${first.target}` : "",
      ]));
    }
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
  const jsonFile = path.join(outDir, "provider35c4_frontier_mode_scan_probe.json");
  const mdFile = path.join(outDir, "provider35c4_frontier_mode_scan_probe.md");
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
