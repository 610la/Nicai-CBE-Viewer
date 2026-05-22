const fs = require("fs");
const path = require("path");
const { DEFAULT_INPUT } = require("./cbe_unpack");

const DEFAULT_OUT = path.resolve(__dirname, "out_godwar_provider35c4return0priority");
const PROMOTION_FRONTIER_JSON = path.resolve(__dirname, "out_godwar_provider35c4frontier", "provider35c4_promotion_frontier_probe.json");
const FRONTIER_MODE_SCAN_JSON = path.resolve(__dirname, "out_godwar_provider35c4frontiermodes", "provider35c4_frontier_mode_scan_probe.json");
const CAPTURE_PLAN_JSON = path.resolve(__dirname, "out_godwar_provider35c4capture", "provider35c4_capture_plan_probe.json");

function mdRow(values) {
  return `| ${values.map((value) => String(value ?? "").replace(/\|/g, "\\|")).join(" | ")} |`;
}

function readJson(file, fallback = {}) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function normalizeLabel(label) {
  return String(label || "").trim().toLowerCase();
}

function rowKey(row) {
  return [
    row.source,
    row.script,
    row.policy || "",
    row.start || "",
    row.modeKey || "",
    row.entryIndex,
    row.entryOffset,
    normalizeLabel(row.label),
    row.providerRefId || row.refRaw || "",
  ].join("|");
}

function capturePoint(plan, id) {
  return (plan.capturePoints || []).find((point) => point.id === id) || {};
}

function selectedPriorities(frontier, comparePoint, rangePoint) {
  return (frontier.schedulerCandidates || []).map((row, index) => ({
    source: "selected-table-frontier",
    priority: index + 1,
    tier: "P1-selected-provider-ref",
    script: row.script || "",
    policy: row.policy || "",
    start: "",
    modeKey: row.modeKey || "",
    entryIndex: row.entryIndex,
    entryOffset: row.entryOffset || "",
    label: row.label || "",
    normalizedLabel: row.normalizedLabel || normalizeLabel(row.label),
    providerRefId: row.providerRefId || "",
    providerRefState: row.providerRefId ? "known-selected-walk-ref" : "requires-provider-ref-capture",
    refRaw: row.refRaw || "",
    refMode: row.refMode || "",
    cursor: row.field00,
    field04: row.field04,
    field08: row.field08,
    field0C: row.field0C,
    groupId: row.groupId,
    target: row.target || "",
    operand0Hex: row.operand0Hex || "",
    stackDelta: row.stackDelta,
    capturePointId: comparePoint.id || "provider35c4-label-ref-compare-1",
    captureSite: comparePoint.site || "0x1233C",
    producerCapturePointId: rangePoint.id || "provider35c4-xse-range-ref",
    producerSite: rangePoint.site || "0x1173C",
    return0WouldFeedResolver: true,
    directCaseIfObserved: Boolean(row.promotionEligibleIfObserved),
    executionAllowed: false,
    blocker: row.reason || row.status || "default-dispatch-only",
  }));
}

function modeScanPriorities(modeScan, comparePoint, rangePoint, selectedKeys) {
  const rows = [];
  for (const script of modeScan.scripts || []) {
    for (const candidate of script.schedulerCandidates || []) {
      for (const schedulerRow of candidate.schedulerRows || []) {
        const row = {
          source: "frontier-mode-scan",
          priority: 0,
          tier: candidate.script === "s_04.xse" ? "P2-selected-script-mode" : "P3-mode-scan-scheduler",
          script: candidate.script || script.name || "",
          policy: "",
          start: candidate.start || "",
          modeKey: candidate.modeKey || "",
          entryIndex: schedulerRow.entryIndex,
          entryOffset: schedulerRow.entryOffset || "",
          label: schedulerRow.label || "",
          normalizedLabel: normalizeLabel(schedulerRow.label),
          providerRefId: "",
          providerRefState: "requires-live-provider-ref",
          refRaw: schedulerRow.refRaw || "",
          refMode: schedulerRow.refMode || "",
          cursor: schedulerRow.cursor,
          field04: schedulerRow.field04,
          field08: schedulerRow.field08,
          field0C: schedulerRow.field0C,
          groupId: schedulerRow.groupId,
          target: schedulerRow.target || "",
          operand0Hex: schedulerRow.operand0Hex || "",
          stackDelta: schedulerRow.stackDelta,
          capturePointId: comparePoint.id || "provider35c4-label-ref-compare-1",
          captureSite: comparePoint.site || "0x1233C",
          producerCapturePointId: rangePoint.id || "provider35c4-xse-range-ref",
          producerSite: rangePoint.site || "0x1173C",
          return0WouldFeedResolver: true,
          directCaseIfObserved: Boolean(schedulerRow.directCaseDispatch),
          executionAllowed: false,
          blocker: schedulerRow.defaultDispatchOnly ? "default-dispatch-only" : "mode-scan-diagnostic",
        };
        const selectedEquivalentKey = rowKey({ ...row, source: "selected-table-frontier", policy: "xse-body-prefix" });
        row.selectedEquivalent = selectedKeys.has(selectedEquivalentKey);
        rows.push(row);
      }
    }
  }
  rows.sort((a, b) => (
    (a.tier === "P2-selected-script-mode" ? 0 : 1) - (b.tier === "P2-selected-script-mode" ? 0 : 1)
    || a.script.localeCompare(b.script)
    || a.start.localeCompare(b.start)
    || a.modeKey.localeCompare(b.modeKey)
    || (a.entryIndex || 0) - (b.entryIndex || 0)
    || a.label.localeCompare(b.label)
  ));
  rows.forEach((row, index) => { row.priority = index + 1; });
  return rows;
}

function summarizeByScript(rows) {
  const byScript = new Map();
  for (const row of rows) {
    if (!byScript.has(row.script)) {
      byScript.set(row.script, {
        script: row.script,
        selectedRows: 0,
        modeRows: 0,
        uniqueModeKeys: new Set(),
        labels: new Set(),
        directRows: 0,
      });
    }
    const item = byScript.get(row.script);
    if (row.source === "selected-table-frontier") item.selectedRows += 1;
    if (row.source === "frontier-mode-scan") item.modeRows += 1;
    if (row.modeKey) item.uniqueModeKeys.add(row.modeKey);
    if (row.label) item.labels.add(row.label);
    if (row.directCaseIfObserved) item.directRows += 1;
  }
  return [...byScript.values()].map((item) => ({
    script: item.script,
    selectedRows: item.selectedRows,
    modeRows: item.modeRows,
    uniqueModeKeyCount: item.uniqueModeKeys.size,
    labels: [...item.labels].sort(),
    directRows: item.directRows,
  }));
}

function buildInvariant(id, passed, details, impact = "") {
  return { id, passed: Boolean(passed), details, impact };
}

function buildReport(options = {}) {
  const input = path.resolve(options.input || DEFAULT_INPUT);
  const frontier = readJson(PROMOTION_FRONTIER_JSON, {});
  const modeScan = readJson(FRONTIER_MODE_SCAN_JSON, {});
  const capturePlan = readJson(CAPTURE_PLAN_JSON, {});
  const comparePoint = capturePoint(capturePlan, "provider35c4-label-ref-compare-1");
  const rangePoint = capturePoint(capturePlan, "provider35c4-xse-range-ref");
  const selectedRows = selectedPriorities(frontier, comparePoint, rangePoint);
  const selectedKeys = new Set(selectedRows.map(rowKey));
  const modeRows = modeScanPriorities(modeScan, comparePoint, rangePoint, selectedKeys);
  const priorities = [...selectedRows, ...modeRows];
  const directRows = priorities.filter((row) => row.directCaseIfObserved);
  const executableRows = priorities.filter((row) => row.executionAllowed);
  const knownProviderRefRows = priorities.filter((row) => row.providerRefId);
  const unknownProviderRefRows = priorities.filter((row) => !row.providerRefId);
  const invariants = [
    buildInvariant(
      "capture-point-feed-eligible",
      comparePoint.feedEligible === true,
      `${comparePoint.id || "missing"} feedEligible=${comparePoint.feedEligible === true ? "yes" : "no"}`,
      "Only the label/ref +0x50 compare point should feed observed return-0 rows."
    ),
    buildInvariant(
      "selected-priorities-have-provider-ref-identity",
      selectedRows.length > 0 && selectedRows.every((row) => row.providerRefId),
      `${knownProviderRefRows.length}/${selectedRows.length} selected priority row(s) have providerRefId values`,
      "Selected table priorities can be replayed through the observed-match resolver once a real return-0 is captured."
    ),
    buildInvariant(
      "mode-priorities-require-live-provider-ref",
      modeRows.length > 0 && modeRows.every((row) => !row.providerRefId),
      `${unknownProviderRefRows.length} mode-scan row(s) still require live +0x64 provider ref identity`,
      "Alternative table modes are capture targets, not synthetic resolver feed rows."
    ),
    buildInvariant(
      "no-direct-execution-priority",
      directRows.length === 0 && executableRows.length === 0,
      `${directRows.length} direct-case row(s), ${executableRows.length} executable row(s)`,
      "Return-0 capture priorities must not enable visible XSE effects by themselves."
    ),
  ];
  const failures = invariants.filter((item) => !item.passed);
  return {
    schema: "nicai.cbe.provider35c4Return0PriorityProbe.v1",
    generatedAt: new Date().toISOString(),
    input,
    inputs: {
      promotionFrontier: PROMOTION_FRONTIER_JSON,
      frontierModeScan: FRONTIER_MODE_SCAN_JSON,
      capturePlan: CAPTURE_PLAN_JSON,
    },
    capturePoints: {
      labelRefCompare: comparePoint,
      xseRangeRefProducer: rangePoint,
    },
    counts: {
      selectedPriorityRowCount: selectedRows.length,
      selectedKnownProviderRefRowCount: selectedRows.filter((row) => row.providerRefId).length,
      modePriorityRowCount: modeRows.length,
      modePriorityModeCount: (modeScan.scripts || []).reduce((sum, script) => sum + (script.schedulerCandidateModeCount || 0), 0),
      knownProviderRefRowCount: knownProviderRefRows.length,
      unknownProviderRefRowCount: unknownProviderRefRows.length,
      directCasePriorityRowCount: directRows.length,
      executablePriorityRowCount: executableRows.length,
      priorityScriptCount: new Set(priorities.map((row) => row.script).filter(Boolean)).size,
    },
    summaryByScript: summarizeByScript(priorities),
    selectedPriorities: selectedRows,
    modeScanPriorities: modeRows,
    invariants,
    summary: {
      status: failures.length ? "provider35c4-return0-priority-risk" : "provider35c4-return0-priority-ready",
      currentFinding: `${selectedRows.length} selected rows with known providerRefId values and ${modeRows.length} mode-scan compare rows are now ordered as return-0 capture priorities; none are execution rows.`,
      emulatorImpact: "The generic emulator now has a concrete observation queue for provider +0x50 return-0 capture while preserving the rule that observed matches still need direct-case promotion before visible effects.",
      nextTarget: "Capture provider +0x50 return values at the label/ref compare point for P1 selected refs first, then attach live +0x64 providerRefIds to P2/P3 mode-scan rows before re-running the feed and promotion frontier.",
      visibleEffectsEnabled: false,
      failureCount: failures.length,
      selectedPriorityRowCount: selectedRows.length,
      modePriorityRowCount: modeRows.length,
      directCasePriorityRowCount: directRows.length,
    },
  };
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# Provider 0x35C4 Return-0 Capture Priority Probe");
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
  lines.push("## Capture Points");
  lines.push("");
  lines.push(mdRow(["Point", "Site", "Kind", "Feed eligible", "Purpose"]));
  lines.push(mdRow(["---", "---", "---", "---", "---"]));
  for (const point of [report.capturePoints.xseRangeRefProducer, report.capturePoints.labelRefCompare]) {
    lines.push(mdRow([point.id || "-", point.site || "-", point.eventKind || "-", point.feedEligible ? "yes" : "no", point.capturePurpose || ""]));
  }
  lines.push("");
  lines.push("## Script Summary");
  lines.push("");
  lines.push(mdRow(["Script", "Selected rows", "Mode rows", "Modes", "Labels", "Direct rows"]));
  lines.push(mdRow(["---", "---:", "---:", "---:", "---", "---:"]));
  for (const row of report.summaryByScript) {
    lines.push(mdRow([row.script, row.selectedRows, row.modeRows, row.uniqueModeKeyCount, row.labels.join(", "), row.directRows]));
  }
  lines.push("");
  lines.push("## P1 Selected Provider Refs");
  lines.push("");
  lines.push(mdRow(["#", "Script", "Policy", "Mode", "Entry", "Label", "Provider ref", "Ref raw", "Cursor", "Group", "Target", "Blocker"]));
  lines.push(mdRow(["---:", "---", "---", "---", "---:", "---", "---", "---", "---:", "---:", "---", "---"]));
  for (const row of report.selectedPriorities.slice(0, 32)) {
    lines.push(mdRow([row.priority, row.script, row.policy, row.modeKey, row.entryIndex, row.label, row.providerRefId, row.refRaw, row.cursor, row.groupId, row.target, row.blocker]));
  }
  if (!report.selectedPriorities.length) lines.push("- No selected priority rows are available.");
  lines.push("");
  lines.push("## Mode-Scan Priority Head");
  lines.push("");
  lines.push(mdRow(["#", "Tier", "Script", "Start", "Mode", "Entry", "Label", "Ref raw", "Cursor", "Group", "Target", "Blocker"]));
  lines.push(mdRow(["---:", "---", "---", "---:", "---", "---:", "---", "---", "---:", "---:", "---", "---"]));
  for (const row of report.modeScanPriorities.slice(0, 48)) {
    lines.push(mdRow([row.priority, row.tier, row.script, row.start, row.modeKey, row.entryIndex, row.label, row.refRaw, row.cursor, row.groupId, row.target, row.blocker]));
  }
  if (!report.modeScanPriorities.length) lines.push("- No mode-scan priority rows are available.");
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

function main() {
  const input = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_INPUT;
  const outDir = process.argv[3] ? path.resolve(process.argv[3]) : DEFAULT_OUT;
  fs.mkdirSync(outDir, { recursive: true });
  const report = buildReport({ input });
  const jsonFile = path.join(outDir, "provider35c4_return0_priority_probe.json");
  const mdFile = path.join(outDir, "provider35c4_return0_priority_probe.md");
  fs.writeFileSync(jsonFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
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
