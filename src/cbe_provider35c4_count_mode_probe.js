const fs = require("fs");
const path = require("path");
const { DEFAULT_INPUT } = require("./cbe_unpack");
const { buildReport: buildEntrypointReport } = require("./cbe_xse_entrypoint_probe");

const DEFAULT_OUT = path.resolve(__dirname, "out_godwar_provider35c4countmode");
const LAYOUT_JSON = path.resolve(__dirname, "out_godwar_xselayout", "xse_layout_trace.json");
const TABLE_WALK_JSON = path.resolve(__dirname, "out_godwar_provider35c4tablewalk", "provider35c4_table_walk_probe.json");
const REF_NAMESPACE_JSON = path.resolve(__dirname, "out_godwar_xserefnamespace", "xse_ref_namespace_probe.json");
const FOCUS_XSE = ["s_01.xse", "s_02.xse", "s_03.xse", "s_04.xse"];

function parseHex(text) {
  return typeof text === "string" && /^0x/i.test(text) ? parseInt(text, 16) : NaN;
}

function hex(n, width = 4) {
  if (!Number.isFinite(n) || n < 0) return "";
  return `0x${n.toString(16).toUpperCase().padStart(width, "0")}`;
}

function mdRow(values) {
  return `| ${values.map((value) => String(value ?? "").replace(/\|/g, "\\|")).join(" | ")} |`;
}

function readJson(file, fallback = null) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function absDelta(value) {
  return Number.isFinite(value) ? Math.abs(value) : 999999;
}

function candidateModeKey(candidate) {
  return `74=${candidate?.modes?.ref74Mode || "-"},64=${candidate?.modes?.ref64Mode || "-"}`;
}

function buildPoolBounds(layoutScript) {
  return {
    objectEnd: parseHex(layoutScript?.zones?.objectProbe?.end),
    textStart: parseHex(layoutScript?.zones?.textAndResourcePool?.start),
    symbolStart: parseHex(layoutScript?.zones?.labelAndSymbolPool?.start),
  };
}

function classifyCandidate(candidate, bounds, primarySelection) {
  const start = parseHex(candidate.start);
  const end = parseHex(candidate.end);
  const primaryEntryIndex = primarySelection?.selected && Number.isInteger(primarySelection.entry) ? primarySelection.entry : null;
  const coversPrimaryEntry = primaryEntryIndex == null || candidate.entryCount > primaryEntryIndex;
  const countsNonNegative = candidate.backfillCount >= 0 && candidate.entryCount >= 0 && candidate.finalRefCount >= 0;
  const rangeCountsNonNegative = candidate.backfillCount >= 0 && candidate.entryCount >= 0;
  const startsInTextPool = Number.isFinite(bounds.textStart) && start >= bounds.textStart;
  const crossesTextPool = Number.isFinite(bounds.textStart) && end > bounds.textStart;
  const endsBeforeObjectEnd = Number.isFinite(bounds.objectEnd) && end < bounds.objectEnd;
  const endsNearObjectEnd = Number.isFinite(candidate.layoutDelta) && Math.abs(candidate.layoutDelta) <= 4;
  const finalCountNegative = candidate.finalRefCount < 0;
  const rangeCountNegative = candidate.entryCount < 0 || candidate.backfillCount < 0;
  const disqualifiers = [];
  if (startsInTextPool) disqualifiers.push("starts-in-text-pool");
  if (rangeCountNegative) disqualifiers.push("negative-range-or-backfill-count");
  if (finalCountNegative) disqualifiers.push("negative-final-ref-count");
  if (crossesTextPool) disqualifiers.push("crosses-text-pool");
  if (!coversPrimaryEntry) disqualifiers.push("misses-primary-entry");
  const promotesTableLane = countsNonNegative && !startsInTextPool && !crossesTextPool && coversPrimaryEntry;
  const usableAsDiagnostic = rangeCountsNonNegative && !startsInTextPool;
  let countInterpretation = "signed-counts-valid";
  if (rangeCountNegative) countInterpretation = "wrong-start-or-signed-range-count";
  else if (finalCountNegative && crossesTextPool) countInterpretation = "walked-into-text-pool";
  else if (finalCountNegative) countInterpretation = "final-count-signed-or-sentinel";
  else if (crossesTextPool) countInterpretation = "unsigned-or-wide-mode-crosses-text";
  return {
    modeKey: candidateModeKey(candidate),
    score: candidate.score,
    layoutDelta: candidate.layoutDelta,
    start: candidate.start,
    end: candidate.end,
    backfillCount: candidate.backfillCount,
    entryCount: candidate.entryCount,
    finalRefCount: candidate.finalRefCount,
    plausibleEntryCount: candidate.plausibleEntryCount,
    safeEntryCount: candidate.safeEntryCount,
    minEntryWritebackRisk: candidate.minEntryWritebackRisk,
    startsInTextPool,
    crossesTextPool,
    endsBeforeObjectEnd,
    endsNearObjectEnd,
    countsNonNegative,
    rangeCountsNonNegative,
    primaryEntryIndex,
    coversPrimaryEntry,
    promotesTableLane,
    usableAsDiagnostic,
    countInterpretation,
    disqualifiers,
  };
}

function chooseCandidate(classified) {
  const promotable = classified.filter((row) => row.promotesTableLane);
  if (!promotable.length) return null;
  return promotable
    .slice()
    .sort((a, b) => (
      absDelta(a.layoutDelta) - absDelta(b.layoutDelta)
      || (b.safeEntryCount || 0) - (a.safeEntryCount || 0)
      || (b.plausibleEntryCount || 0) - (a.plausibleEntryCount || 0)
      || (b.score || 0) - (a.score || 0)
    ))[0];
}

function analyzeScript(script, layoutScript, tableWalk, primarySelection) {
  const bounds = buildPoolBounds(layoutScript);
  const candidates = (script.tailCandidates || []).map((candidate) => classifyCandidate(candidate, bounds, primarySelection));
  const currentTop = candidates[0] || null;
  const selected = chooseCandidate(candidates);
  const tableLanes = (tableWalk?.lanes || []).filter((lane) => lane.script === script.name);
  const startsInText = currentTop?.startsInTextPool || false;
  const topPromotes = Boolean(currentTop?.promotesTableLane);
  const selectedDiffersFromTop = Boolean(selected && currentTop && selected.modeKey !== currentTop.modeKey);
  const status = selected
    ? (selectedDiffersFromTop ? "count-mode-alternative-selected" : "count-mode-top-valid")
    : (startsInText ? "count-mode-start-in-text-pool" : "count-mode-unresolved");
  const blockers = [];
  if (startsInText) blockers.push("group-end-starts-in-text-pool");
  if (!selected) blockers.push("no-promotable-count-mode");
  if (currentTop && !topPromotes) blockers.push(...currentTop.disqualifiers.map((item) => `top-${item}`));
  return {
    name: script.name,
    status,
    groupEnd: script.groupEnd,
    bounds: {
      objectEnd: hex(bounds.objectEnd),
      textStart: hex(bounds.textStart),
      symbolStart: hex(bounds.symbolStart),
    },
    primarySelection: primarySelection || null,
    currentTop,
    selected,
    selectedDiffersFromTop,
    promotableCandidateCount: candidates.filter((row) => row.promotesTableLane).length,
    diagnosticCandidateCount: candidates.filter((row) => row.usableAsDiagnostic).length,
    topCandidateCount: candidates.length,
    currentTableWalk: {
      laneCount: tableLanes.length,
      guardedLaneCount: tableLanes.filter((lane) => (lane.guardReasons || []).length).length,
      rangeRefsProduced: tableLanes.reduce((sum, lane) => sum + (lane.counts?.rangeRefsProduced || 0), 0),
      guardReasons: Array.from(new Set(tableLanes.flatMap((lane) => lane.guardReasons || []))).sort(),
    },
    blockers: Array.from(new Set(blockers)),
    candidates: candidates.slice(0, 24),
  };
}

function buildInvariant(id, passed, details, impact = "") {
  return { id, passed: Boolean(passed), details, impact };
}

function buildReport(options = {}) {
  const input = path.resolve(options.input || DEFAULT_INPUT);
  const entrypoint = buildEntrypointReport({ input, includeAllEntries: true, candidateLimit: 100 });
  const layout = readJson(LAYOUT_JSON, {});
  const tableWalk = readJson(TABLE_WALK_JSON, {});
  const refNamespace = readJson(REF_NAMESPACE_JSON, {});
  const layoutByName = new Map((layout.scripts || []).map((script) => [script.name, script]));
  const primaryByScript = new Map((refNamespace.primarySelections || []).map((row) => [row.script, row]));
  const scripts = (entrypoint.scripts || [])
    .filter((script) => FOCUS_XSE.includes(script.name))
    .map((script) => analyzeScript(script, layoutByName.get(script.name) || null, tableWalk, primaryByScript.get(script.name) || null));
  const selectedScripts = scripts.filter((script) => script.selected);
  const changedSelections = scripts.filter((script) => script.selectedDiffersFromTop);
  const unresolvedScripts = scripts.filter((script) => !script.selected);
  const startInTextPoolScripts = scripts.filter((script) => script.status === "count-mode-start-in-text-pool");
  const topCrossesOrNegative = scripts.filter((script) => script.currentTop && !script.currentTop.promotesTableLane);
  const invariants = [
    buildInvariant(
      "top-table-lanes-need-count-guard",
      topCrossesOrNegative.length > 0,
      `${topCrossesOrNegative.length}/${scripts.length} current top candidate(s) fail count/pool promotion checks`,
      "The existing full-table walk must remain guarded instead of promoting top candidates."
    ),
    buildInvariant(
      "alternative-count-modes-found",
      selectedScripts.length > 0,
      `${selectedScripts.length}/${scripts.length} script(s) have a promotable count/pool candidate`,
      "The next table walker can try evidence-backed alternatives rather than unsigned count guesses."
    ),
    buildInvariant(
      "text-pool-starts-stay-blocked",
      startInTextPoolScripts.every((script) => !script.selected),
      `${startInTextPoolScripts.length} script(s) start in text pool and remain unresolved`,
      "A table start already inside text/resource bytes must not be rescued by count reinterpretation."
    ),
    buildInvariant(
      "selected-modes-avoid-text-pool-crossing",
      selectedScripts.every((script) => script.selected && !script.selected.crossesTextPool && !script.selected.startsInTextPool),
      `${selectedScripts.length} selected candidate(s) avoid text-pool crossing`,
      "Promotable table candidates must stay within binary table/post-probe bytes."
    ),
    buildInvariant(
      "unresolved-scripts-keep-effects-disabled",
      unresolvedScripts.length > 0,
      `${unresolvedScripts.length}/${scripts.length} unresolved script(s)`,
      "Visible effects remain disabled until every focused entry/table lane has a trustworthy count mode and provider return-0 observations."
    ),
  ];
  const failures = invariants.filter((item) => !item.passed);
  return {
    schema: "nicai.cbe.provider35c4CountModeProbe.v1",
    generatedAt: new Date().toISOString(),
    input,
    inputs: {
      entrypoint: "cbe_xse_entrypoint_probe.buildReport({ includeAllEntries: true, candidateLimit: 100 })",
      layout: LAYOUT_JSON,
      provider35c4TableWalk: TABLE_WALK_JSON,
      refNamespace: REF_NAMESPACE_JSON,
    },
    counts: {
      scriptCount: scripts.length,
      selectedScriptCount: selectedScripts.length,
      changedSelectionCount: changedSelections.length,
      unresolvedScriptCount: unresolvedScripts.length,
      startInTextPoolScriptCount: startInTextPoolScripts.length,
      topGuardedCandidateCount: topCrossesOrNegative.length,
    },
    scripts,
    invariants,
    summary: {
      status: failures.length ? "provider35c4-count-mode-risk" : "provider35c4-count-mode-guarded",
      currentFinding: "The negative full-table counts are not solved by blindly treating compact bytes as unsigned: several current top candidates cross into text/pool bytes, while safer alternative count/ref-width modes exist for only part of the focused set.",
      emulatorImpact: "The generic emulator can use this to replace top-score table lanes with pool-clean alternatives where available, but scripts whose table start is already in text bytes must stay blocked.",
      nextTarget: "Re-run the provider 0x35C4 table walk with selected pool-clean count modes for s_01/s_03/s_04 while keeping s_02 and unresolved lanes non-promoting, then continue toward real provider return-0 observations.",
      visibleEffectsEnabled: false,
      failureCount: failures.length,
      selectedScriptCount: selectedScripts.length,
      changedSelectionCount: changedSelections.length,
      unresolvedScriptCount: unresolvedScripts.length,
      topGuardedCandidateCount: topCrossesOrNegative.length,
    },
  };
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# Provider 0x35C4 Count Mode Probe");
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
  lines.push(mdRow(["Script", "Status", "Top", "Selected", "Promotable", "Blockers"]));
  lines.push(mdRow(["---", "---", "---", "---", "---:", "---"]));
  for (const script of report.scripts) {
    lines.push(mdRow([
      script.name,
      script.status,
      script.currentTop ? `${script.currentTop.modeKey} count=${script.currentTop.entryCount}/${script.currentTop.finalRefCount} end=${script.currentTop.end}` : "",
      script.selected ? `${script.selected.modeKey} count=${script.selected.entryCount}/${script.selected.finalRefCount} end=${script.selected.end}` : "",
      script.promotableCandidateCount,
      script.blockers.join("; "),
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
  const jsonFile = path.join(outDir, "provider35c4_count_mode_probe.json");
  const mdFile = path.join(outDir, "provider35c4_count_mode_probe.md");
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
