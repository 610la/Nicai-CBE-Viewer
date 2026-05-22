const fs = require("fs");
const path = require("path");
const { DEFAULT_INPUT } = require("./cbe_unpack");
const { createObservedProviderRefResolver } = require("./cbe_provider_abi_shim_probe");

const DEFAULT_OUT = path.resolve(__dirname, "out_godwar_provider35c4return0inject");
const RETURN0_PRIORITY_JSON = path.resolve(__dirname, "out_godwar_provider35c4return0priority", "provider35c4_return0_priority_probe.json");
const PROMOTION_FRONTIER_JSON = path.resolve(__dirname, "out_godwar_provider35c4frontier", "provider35c4_promotion_frontier_probe.json");

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

function selectedKey(row) {
  return [
    row.script || "",
    row.policy || "",
    row.providerRefId || "",
    normalizeLabel(row.label),
    row.entryIndex ?? "",
  ].join("|");
}

function buildObservedMatches(selectedRows) {
  const seen = new Set();
  const rows = [];
  for (const row of selectedRows) {
    if (!row.providerRefId || !row.label) continue;
    const key = `${normalizeLabel(row.label)}|${row.providerRefId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      label: row.label,
      normalizedLabel: normalizeLabel(row.label),
      providerRefId: row.providerRefId,
      source: "synthetic-p1-return0-diagnostic",
      script: row.script,
      policy: row.policy,
      entryIndex: row.entryIndex,
      returnValue: 0,
    });
  }
  return rows;
}

function replayPriorityRows(selectedRows, observedMatches) {
  const resolver = createObservedProviderRefResolver(observedMatches);
  return selectedRows.map((row) => {
    const result = resolver({
      callerLabel: row.label,
      normalizedLabel: normalizeLabel(row.label),
      entryRef: {
        kind: "provider-opaque-ref",
        context: "xse-selected-return0-priority-ref",
        providerRefId: row.providerRefId,
        resource: row.script,
        policy: row.policy,
        offset: row.entryOffset,
        rawSample: row.refRaw,
      },
    });
    const matched = Boolean(result?.matched);
    return {
      ...row,
      resolverStatus: result?.status || "",
      resolverMatched: matched,
      resolverReturnValue: matched ? 0 : 1,
    };
  });
}

function joinFrontierRows(replays, frontier) {
  const frontierByKey = new Map((frontier.schedulerCandidates || []).map((row) => [selectedKey(row), row]));
  return replays.map((row) => {
    const frontierRow = frontierByKey.get(selectedKey(row)) || null;
    return {
      ...row,
      frontierJoined: Boolean(frontierRow),
      frontierStatus: frontierRow?.status || "",
      frontierReason: frontierRow?.reason || "",
      directCaseIfObserved: Boolean(frontierRow?.promotionEligibleIfObserved),
      schedulerCandidateIfObserved: Boolean(frontierRow?.schedulerCandidateIfObserved),
      defaultDispatchOnly: Boolean(frontierRow?.defaultDispatchOnly),
      target: frontierRow?.target || row.target || "",
      groupId: frontierRow?.groupId ?? row.groupId,
      operand0Hex: frontierRow?.operand0Hex || row.operand0Hex || "",
    };
  });
}

function buildInvariant(id, passed, details, impact = "") {
  return { id, passed: Boolean(passed), details, impact };
}

function buildReport(options = {}) {
  const input = path.resolve(options.input || DEFAULT_INPUT);
  const priority = readJson(RETURN0_PRIORITY_JSON, {});
  const frontier = readJson(PROMOTION_FRONTIER_JSON, {});
  const selectedRows = priority.selectedPriorities || [];
  const observedMatches = buildObservedMatches(selectedRows);
  const replays = replayPriorityRows(selectedRows, observedMatches);
  const joinedRows = joinFrontierRows(replays, frontier);
  const resolverMatches = joinedRows.filter((row) => row.resolverMatched);
  const joinedFrontierRows = joinedRows.filter((row) => row.frontierJoined);
  const directRows = joinedRows.filter((row) => row.directCaseIfObserved);
  const schedulerRows = joinedRows.filter((row) => row.schedulerCandidateIfObserved);
  const executableRows = joinedRows.filter((row) => row.resolverMatched && row.directCaseIfObserved);
  const invariants = [
    buildInvariant(
      "synthetic-feed-covers-p1",
      observedMatches.length === selectedRows.length && resolverMatches.length === selectedRows.length,
      `${observedMatches.length} synthetic observed row(s), ${resolverMatches.length}/${selectedRows.length} resolver match(es)`,
      "The exact observed-match feed path is ready for real P1 return-0 rows."
    ),
    buildInvariant(
      "p1-frontier-rows-join",
      joinedFrontierRows.length === selectedRows.length,
      `${joinedFrontierRows.length}/${selectedRows.length} P1 row(s) joined to the promotion frontier`,
      "Observed feed rows must still be checked against activation/dispatch/writeback frontier data."
    ),
    buildInvariant(
      "synthetic-return0-still-nonexecuting",
      executableRows.length === 0 && directRows.length === 0,
      `${executableRows.length} executable row(s), ${directRows.length} direct-case row(s)`,
      "This diagnostic injection cannot enable visible XSE effects while the direct-case frontier is empty."
    ),
    buildInvariant(
      "p1-remains-scheduler-only",
      schedulerRows.length === selectedRows.length && joinedRows.every((row) => row.defaultDispatchOnly),
      `${schedulerRows.length}/${selectedRows.length} scheduler row(s), defaultOnly=${joinedRows.filter((row) => row.defaultDispatchOnly).length}`,
      "The current P1 rows are useful capture checks, but they still fall through the default dispatcher."
    ),
  ];
  const failures = invariants.filter((item) => !item.passed);
  return {
    schema: "nicai.cbe.provider35c4Return0InjectionProbe.v1",
    generatedAt: new Date().toISOString(),
    input,
    inputs: {
      return0Priority: RETURN0_PRIORITY_JSON,
      promotionFrontier: PROMOTION_FRONTIER_JSON,
    },
    counts: {
      p1PriorityRowCount: selectedRows.length,
      syntheticObservedMatchCount: observedMatches.length,
      resolverReplayCount: replays.length,
      resolverMatchedCount: resolverMatches.length,
      joinedFrontierRowCount: joinedFrontierRows.length,
      schedulerOnlyRowCount: schedulerRows.length,
      directCaseRowCount: directRows.length,
      executableRowCount: executableRows.length,
    },
    observedMatches,
    replayRows: joinedRows,
    invariants,
    summary: {
      status: failures.length ? "provider35c4-return0-injection-risk" : "provider35c4-return0-injection-guarded",
      currentFinding: `Synthetic P1 return-0 injection matches ${resolverMatches.length}/${selectedRows.length} resolver rows, but ${directRows.length} rows reach a direct-case frontier and ${executableRows.length} become executable.`,
      emulatorImpact: "This validates the observed-match feed plumbing without relaxing execution safety: real return-0 observations can be admitted, but direct-case promotion is still required before visible effects.",
      nextTarget: "Replace the synthetic P1 feed with captured provider +0x50 return values; if real P1 rows still default-dispatch, continue attaching live +0x64 refs to P2/P3 mode-scan rows.",
      visibleEffectsEnabled: false,
      failureCount: failures.length,
      syntheticObservedMatchCount: observedMatches.length,
      resolverMatchedCount: resolverMatches.length,
      directCaseRowCount: directRows.length,
      executableRowCount: executableRows.length,
    },
  };
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# Provider 0x35C4 Return-0 Injection Probe");
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
  lines.push("## Replay Rows");
  lines.push("");
  lines.push(mdRow(["#", "Script", "Policy", "Entry", "Label", "Provider ref", "Resolver", "Frontier", "Target", "Direct", "Executable"]));
  lines.push(mdRow(["---:", "---", "---", "---:", "---", "---", "---:", "---", "---", "---", "---"]));
  for (const row of report.replayRows) {
    lines.push(mdRow([
      row.priority,
      row.script,
      row.policy,
      row.entryIndex,
      row.label,
      row.providerRefId,
      row.resolverReturnValue,
      row.frontierStatus,
      row.target,
      row.directCaseIfObserved ? "yes" : "no",
      row.resolverMatched && row.directCaseIfObserved ? "yes" : "no",
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

function main() {
  const input = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_INPUT;
  const outDir = process.argv[3] ? path.resolve(process.argv[3]) : DEFAULT_OUT;
  fs.mkdirSync(outDir, { recursive: true });
  const report = buildReport({ input });
  const jsonFile = path.join(outDir, "provider35c4_return0_injection_probe.json");
  const mdFile = path.join(outDir, "provider35c4_return0_injection_probe.md");
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
