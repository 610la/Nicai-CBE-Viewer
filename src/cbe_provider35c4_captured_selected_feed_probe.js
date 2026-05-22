const fs = require("fs");
const path = require("path");
const { DEFAULT_INPUT } = require("./cbe_unpack");
const { createObservedProviderRefResolver } = require("./cbe_provider_abi_shim_probe");
const { buildReport: buildSelectedTableReport } = require("./cbe_provider35c4_selected_table_walk_probe");
const { buildReport: buildCaptureAdapterReport } = require("./cbe_provider35c4_return0_capture_adapter_probe");

const DEFAULT_OUT = path.resolve(__dirname, "out_godwar_provider35c4capturedfeed");
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
    row.providerRefId || row.refId || "",
    normalizeLabel(row.label),
    row.entryIndex ?? "",
  ].join("|");
}

function extractSelectedCompareEvents(selectedTable) {
  const out = [];
  let seq = 0;
  for (const lane of selectedTable.lanes || []) {
    for (const row of lane.rows || []) {
      if (row.kind !== "range-entry") continue;
      for (const compare of row.compares || []) {
        seq += 1;
        out.push({
          seq,
          script: lane.script || "",
          policy: lane.policy || "",
          laneIndex: lane.laneIndex,
          modeKey: lane.modeKey || "",
          entryIndex: row.index,
          entryOffset: row.offset || "",
          label: compare.label || "",
          normalizedLabel: normalizeLabel(compare.label),
          refId: row.providerRefId || "",
          refRaw: row.field10?.raw || "",
          refMode: row.field10?.mode || "",
          sourceReturnValue: compare.returnValue,
          sourceMatched: compare.returnValue === 0,
        });
      }
    }
  }
  return out;
}

function replayWithCapturedFeed(compareEvents, observedMatches) {
  const resolver = createObservedProviderRefResolver(observedMatches);
  return compareEvents.map((event) => {
    const result = resolver({
      callerLabel: event.label,
      normalizedLabel: event.normalizedLabel,
      entryRef: {
        kind: "provider-opaque-ref",
        context: "xse-captured-selected-table-range-entry-ref",
        providerRefId: event.refId,
        resource: event.script,
        policy: event.policy,
        offset: event.entryOffset,
        rawSample: event.refRaw,
      },
    });
    const matched = Boolean(result?.matched);
    return {
      ...event,
      resolverStatus: result?.status || "",
      resolverMatched: matched,
      resolverReturnValue: matched ? 0 : 1,
    };
  });
}

function joinFrontier(rows, frontier) {
  const frontierByKey = new Map((frontier.frontierRows || []).map((row) => [selectedKey(row), row]));
  return rows.map((row) => {
    const frontierRow = frontierByKey.get(selectedKey(row)) || null;
    return {
      ...row,
      frontierJoined: Boolean(frontierRow),
      frontierStatus: frontierRow?.status || "",
      frontierReason: frontierRow?.reason || "",
      schedulerCandidateIfObserved: Boolean(frontierRow?.schedulerCandidateIfObserved),
      directCaseIfObserved: Boolean(frontierRow?.promotionEligibleIfObserved),
      defaultDispatchOnly: Boolean(frontierRow?.defaultDispatchOnly),
      target: frontierRow?.target || "",
      groupId: frontierRow?.groupId,
      operand0Hex: frontierRow?.operand0Hex || "",
    };
  });
}

function buildInvariant(id, passed, details, impact = "") {
  return { id, passed: Boolean(passed), details, impact };
}

function buildReport(options = {}) {
  const input = path.resolve(options.input || DEFAULT_INPUT);
  const selectedTable = buildSelectedTableReport({ input });
  const captureAdapter = buildCaptureAdapterReport({
    input,
    captureFile: options.captureFile,
  });
  const frontier = readJson(PROMOTION_FRONTIER_JSON, {});
  const compareEvents = extractSelectedCompareEvents(selectedTable);
  const observedMatches = captureAdapter.observedMatches || [];
  const replayRows = joinFrontier(replayWithCapturedFeed(compareEvents, observedMatches), frontier);
  const resolverMatches = replayRows.filter((row) => row.resolverMatched);
  const frontierJoinedRows = replayRows.filter((row) => row.frontierJoined);
  const schedulerMatches = replayRows.filter((row) => row.resolverMatched && row.schedulerCandidateIfObserved);
  const directMatches = replayRows.filter((row) => row.resolverMatched && row.directCaseIfObserved);
  const executableRows = directMatches;
  const expectedCompareCount = selectedTable.summary?.compareOperationCount || selectedTable.counts?.compareOperationCount || 0;
  const invariants = [
    buildInvariant(
      "captured-feed-covers-selected-compares",
      compareEvents.length === expectedCompareCount,
      `${compareEvents.length}/${expectedCompareCount} selected compare row(s) replayed`,
      "The captured feed path must cover the same selected table surface as the empty-feed probe."
    ),
    buildInvariant(
      "captured-feed-derived-from-capture-adapter",
      observedMatches.length === (captureAdapter.summary?.observedFeedRowCount || 0),
      `${observedMatches.length} observed feed row(s), adapter reports ${captureAdapter.summary?.observedFeedRowCount || 0}`,
      "Captured selected-feed rows must come from the real return-0 capture adapter, not from table guesses."
    ),
    buildInvariant(
      "captured-feed-frontier-joins-selected",
      frontierJoinedRows.length === replayRows.length,
      `${frontierJoinedRows.length}/${replayRows.length} replay row(s) joined to the frontier`,
      "Every captured resolver match must still be checked by activation/dispatch/writeback gates."
    ),
    buildInvariant(
      "empty-capture-keeps-selected-feed-empty",
      observedMatches.length > 0 || resolverMatches.length === 0,
      `${resolverMatches.length} resolver match(es) with ${observedMatches.length} captured feed row(s)`,
      "A missing or empty capture file must not produce selected-table matches."
    ),
    buildInvariant(
      "captured-matches-remain-frontier-gated",
      executableRows.length === 0,
      `${schedulerMatches.length} scheduler match(es), ${directMatches.length} direct match(es), ${executableRows.length} executable`,
      "Captured return-0 rows are feed evidence only until they reach a direct-case promotion frontier."
    ),
  ];
  const failures = invariants.filter((item) => !item.passed);
  const status = failures.length
    ? "provider35c4-captured-selected-feed-risk"
    : executableRows.length
    ? "provider35c4-captured-selected-feed-direct-frontier"
    : observedMatches.length
    ? "provider35c4-captured-selected-feed-observed-guarded"
    : "provider35c4-captured-selected-feed-empty";
  return {
    schema: "nicai.cbe.provider35c4CapturedSelectedFeedProbe.v1",
    generatedAt: new Date().toISOString(),
    input,
    inputs: {
      selectedTable: "cbe_provider35c4_selected_table_walk_probe.buildReport({ input })",
      captureAdapter: "cbe_provider35c4_return0_capture_adapter_probe.buildReport({ input, captureFile })",
      promotionFrontier: PROMOTION_FRONTIER_JSON,
    },
    captureAdapter: {
      status: captureAdapter.summary?.status || "",
      captureFile: captureAdapter.captureSource?.path || "",
      captureFileExists: Boolean(captureAdapter.captureSource?.exists),
      importedObservationCount: captureAdapter.summary?.importedObservationCount || 0,
      observedFeedRowCount: captureAdapter.summary?.observedFeedRowCount || 0,
      p1MatchedCount: captureAdapter.summary?.p1MatchedCount || 0,
      directCaseObservedCount: captureAdapter.summary?.directCaseObservedCount || 0,
      executableObservedCount: captureAdapter.summary?.executableObservedCount || 0,
    },
    counts: {
      selectedCompareCount: replayRows.length,
      expectedCompareCount,
      observedFeedRowCount: observedMatches.length,
      resolverMatchedCount: resolverMatches.length,
      frontierJoinedCount: frontierJoinedRows.length,
      schedulerMatchedCount: schedulerMatches.length,
      directMatchedCount: directMatches.length,
      executableMatchedCount: executableRows.length,
    },
    observedMatches,
    replayRows: replayRows.slice(0, 160),
    matchedRows: resolverMatches.slice(0, 64),
    executableRows: executableRows.slice(0, 64),
    invariants,
    summary: {
      status,
      currentFinding: `Captured return-0 feed replay covers ${replayRows.length} selected compares with ${observedMatches.length} captured feed row(s), ${resolverMatches.length} resolver match(es), and ${executableRows.length} executable row(s).`,
      emulatorImpact: "This is the selected-table feed path that can consume real provider observations. Empty capture remains non-executing; captured matches still need direct-case frontier promotion.",
      nextTarget: observedMatches.length
        ? "Review captured resolver matches against the direct-case frontier, then only promote executable rows with safe dispatch/writeback evidence."
        : "Populate the return-0 capture adapter with real provider observations, then re-run this captured selected-feed replay.",
      visibleEffectsEnabled: false,
      failureCount: failures.length,
      selectedCompareCount: replayRows.length,
      observedFeedRowCount: observedMatches.length,
      resolverMatchedCount: resolverMatches.length,
      directMatchedCount: directMatches.length,
      executableMatchedCount: executableRows.length,
    },
  };
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# Provider 0x35C4 Captured Selected Feed Probe");
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
  lines.push("## Capture Adapter");
  lines.push("");
  lines.push(mdRow(["Status", "File", "Exists", "Imported", "Feed", "P1", "Direct", "Executable"]));
  lines.push(mdRow(["---", "---", "---", "---:", "---:", "---:", "---:", "---:"]));
  lines.push(mdRow([
    report.captureAdapter.status,
    report.captureAdapter.captureFile,
    report.captureAdapter.captureFileExists ? "yes" : "no",
    report.captureAdapter.importedObservationCount,
    report.captureAdapter.observedFeedRowCount,
    report.captureAdapter.p1MatchedCount,
    report.captureAdapter.directCaseObservedCount,
    report.captureAdapter.executableObservedCount,
  ]));
  lines.push("");
  lines.push("## Matched Rows");
  lines.push("");
  if (report.matchedRows.length) {
    lines.push(mdRow(["Seq", "Script", "Policy", "Entry", "Label", "Ref", "Frontier", "Direct"]));
    lines.push(mdRow(["---:", "---", "---", "---:", "---", "---", "---", "---"]));
    for (const row of report.matchedRows) {
      lines.push(mdRow([row.seq, row.script, row.policy, row.entryIndex, row.label, row.refId, row.frontierStatus, row.directCaseIfObserved ? "yes" : "no"]));
    }
  } else {
    lines.push("- No captured selected-table resolver matches are available yet.");
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
  const captureFile = process.argv[4] ? path.resolve(process.argv[4]) : undefined;
  fs.mkdirSync(outDir, { recursive: true });
  const report = buildReport({ input, captureFile });
  const jsonFile = path.join(outDir, "provider35c4_captured_selected_feed_probe.json");
  const mdFile = path.join(outDir, "provider35c4_captured_selected_feed_probe.md");
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
