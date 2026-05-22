const fs = require("fs");
const path = require("path");
const { DEFAULT_INPUT } = require("./cbe_unpack");
const { createObservedProviderRefResolver } = require("./cbe_provider_abi_shim_probe");
const { buildReport: buildSelectedTableReport } = require("./cbe_provider35c4_selected_table_walk_probe");

const DEFAULT_OUT = path.resolve(__dirname, "out_godwar_provider35c4selectedfeed");
const ENTRY_SAFETY_JSON = path.resolve(__dirname, "out_godwar_xseentrysafety", "xse_entry_safety_probe.json");

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
          returnValue: compare.returnValue,
          sourceMatched: compare.returnValue === 0,
        });
      }
    }
  }
  return out;
}

function buildObservedMatches(compareEvents) {
  const seen = new Set();
  const out = [];
  for (const event of compareEvents.filter((row) => row.sourceMatched && row.refId && row.label)) {
    const key = `${event.normalizedLabel}|${event.refId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      label: event.label,
      normalizedLabel: event.normalizedLabel,
      providerRefId: event.refId,
      source: "provider35c4-selected-table-return0",
      script: event.script,
      policy: event.policy,
      laneIndex: event.laneIndex,
      entryIndex: event.entryIndex,
      returnValue: event.returnValue,
    });
  }
  return out;
}

function replayCompareEvents(compareEvents, observedMatches) {
  const resolver = createObservedProviderRefResolver(observedMatches);
  return compareEvents.map((event) => {
    const result = resolver({
      callerLabel: event.label,
      normalizedLabel: event.normalizedLabel,
      entryRef: {
        kind: "provider-opaque-ref",
        context: "xse-selected-table-range-entry-ref",
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
      resolverReturnValue: matched ? 0 : 1,
      resolverMatched: matched,
      promotionEligible: matched && event.refId && event.label,
    };
  });
}

function buildInvariant(id, passed, details, impact = "") {
  return { id, passed: Boolean(passed), details, impact };
}

function buildReport(options = {}) {
  const input = path.resolve(options.input || DEFAULT_INPUT);
  const selectedTable = buildSelectedTableReport({ input });
  const entrySafety = readJson(ENTRY_SAFETY_JSON, {});
  const compareEvents = extractSelectedCompareEvents(selectedTable);
  const observedMatches = buildObservedMatches(compareEvents);
  const replays = replayCompareEvents(compareEvents, observedMatches);
  const sourceMatches = compareEvents.filter((row) => row.sourceMatched);
  const resolverMatches = replays.filter((row) => row.resolverMatched);
  const nonObservedResolverMatches = replays.filter((row) => row.resolverMatched && !row.sourceMatched);
  const missedSourceMatches = replays.filter((row) => row.sourceMatched && !row.resolverMatched);
  const promotionEligibleRows = replays.filter((row) => row.promotionEligible);
  const entryPromotableCount = entrySafety?.summary?.promotablePrimaryCount ?? (entrySafety?.primaryRows || []).filter((row) => row.status === "entry-promotable").length;
  const expectedCompareCount = selectedTable.summary?.compareOperationCount || selectedTable.counts?.compareOperationCount || 0;
  const invariants = [
    buildInvariant(
      "selected-feed-covers-selected-compares",
      compareEvents.length === expectedCompareCount,
      `${compareEvents.length}/${expectedCompareCount} selected table compare event(s) replayed`,
      "The feed gate must cover the full selected table walk, not only the earlier sampled provider tape."
    ),
    buildInvariant(
      "selected-feed-derived-only-from-return0",
      observedMatches.length === sourceMatches.length,
      `${observedMatches.length} observed feed row(s), ${sourceMatches.length} source return-0 row(s)`,
      "The selected-table resolver feed must be a projection of real provider compare returns."
    ),
    buildInvariant(
      "selected-resolver-does-not-invent-matches",
      nonObservedResolverMatches.length === 0,
      `${nonObservedResolverMatches.length} resolver match(es) without source return-0`,
      "Expanded provider refs cannot promote entries through label/ref coincidences."
    ),
    buildInvariant(
      "selected-resolver-covers-observed-matches",
      missedSourceMatches.length === 0,
      `${missedSourceMatches.length} source return-0 row(s) missed by the resolver`,
      "When a real selected-table return-0 row appears, the observed-match resolver should admit it."
    ),
    buildInvariant(
      "selected-empty-feed-keeps-promotions-disabled",
      observedMatches.length > 0 || promotionEligibleRows.length === 0,
      `${promotionEligibleRows.length} promotion-eligible row(s) with ${observedMatches.length} feed row(s)`,
      "A zero-observation selected table must leave XSE label-entry promotion disabled."
    ),
    buildInvariant(
      "entry-safety-still-demotes",
      entryPromotableCount === 0,
      `${entryPromotableCount} currently promotable primary entry selection(s) in entry-safety output`,
      "The selected-table feed gate does not override activation/writeback safety."
    ),
  ];
  const failures = invariants.filter((item) => !item.passed);
  return {
    schema: "nicai.cbe.provider35c4SelectedFeedProbe.v1",
    generatedAt: new Date().toISOString(),
    input,
    inputs: {
      selectedTable: "cbe_provider35c4_selected_table_walk_probe.buildReport({ input })",
      entrySafety: ENTRY_SAFETY_JSON,
    },
    selectedTable: {
      status: selectedTable.summary?.status || "",
      selectedScriptCount: selectedTable.summary?.selectedScriptCount || 0,
      laneCount: selectedTable.summary?.laneCount || 0,
      guardedLaneCount: selectedTable.summary?.guardedLaneCount || 0,
      compareOperationCount: expectedCompareCount,
      return0CompareCount: selectedTable.summary?.return0CompareCount || 0,
    },
    feed: {
      selectedCompareCount: compareEvents.length,
      observedMatchCount: observedMatches.length,
      sourceReturn0CompareCount: sourceMatches.length,
      resolverReplayCount: replays.length,
      resolverMatchedCount: resolverMatches.length,
      nonObservedResolverMatchCount: nonObservedResolverMatches.length,
      missedSourceMatchCount: missedSourceMatches.length,
      promotionEligibleCount: promotionEligibleRows.length,
      entrySafetyPromotableCount: entryPromotableCount,
    },
    observedMatches,
    replayedCompares: replays.slice(0, 160),
    invariants,
    summary: {
      status: failures.length ? "provider35c4-selected-feed-risk" : "provider35c4-selected-feed-guarded-empty",
      currentFinding: "The expanded selected-table provider refs are now behind the same observed-return0 feed gate: 268 selected label/ref compares replay with an empty feed and produce 0 resolver matches.",
      emulatorImpact: "The generic emulator can walk all selected provider table lanes without enabling script effects; entry promotion still depends on real provider +0x50 return-0 observations plus activation/writeback safety.",
      nextTarget: "Capture or emulate real provider +0x50 return-0 rows for the selected table lanes, then replay this selected feed gate before enabling any XSE entry promotion.",
      visibleEffectsEnabled: false,
      failureCount: failures.length,
      selectedCompareCount: compareEvents.length,
      observedMatchCount: observedMatches.length,
      resolverMatchedCount: resolverMatches.length,
      promotionEligibleCount: promotionEligibleRows.length,
      entrySafetyPromotableCount: entryPromotableCount,
    },
  };
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# Provider 0x35C4 Selected Feed Probe");
  lines.push("");
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Input CBE: \`${report.input}\``);
  lines.push(`- Status: ${report.summary.status}`);
  lines.push(`- Finding: ${report.summary.currentFinding}`);
  lines.push(`- Emulator impact: ${report.summary.emulatorImpact}`);
  lines.push(`- Next target: ${report.summary.nextTarget}`);
  lines.push("");
  lines.push("## Feed Counts");
  lines.push("");
  lines.push(mdRow(["Field", "Value"]));
  lines.push(mdRow(["---", "---:"]));
  for (const [key, value] of Object.entries(report.feed)) lines.push(mdRow([key, value]));
  lines.push("");
  lines.push("## Selected Table");
  lines.push("");
  lines.push(mdRow(["Status", "Scripts", "Lanes", "Guarded", "Compares", "Return-0"]));
  lines.push(mdRow(["---", "---:", "---:", "---:", "---:", "---:"]));
  lines.push(mdRow([
    report.selectedTable.status,
    report.selectedTable.selectedScriptCount,
    report.selectedTable.laneCount,
    report.selectedTable.guardedLaneCount,
    report.selectedTable.compareOperationCount,
    report.selectedTable.return0CompareCount,
  ]));
  lines.push("");
  lines.push("## Invariants");
  lines.push("");
  lines.push(mdRow(["Invariant", "Pass", "Details", "Impact"]));
  lines.push(mdRow(["---", "---", "---", "---"]));
  for (const invariant of report.invariants) {
    lines.push(mdRow([invariant.id, invariant.passed ? "yes" : "no", invariant.details, invariant.impact]));
  }
  lines.push("");
  lines.push("## Observed Feed Rows");
  lines.push("");
  if (report.observedMatches.length) {
    lines.push(mdRow(["Script", "Policy", "Label", "Provider Ref", "Return"]));
    lines.push(mdRow(["---", "---", "---", "---", "---:"]));
    for (const row of report.observedMatches) {
      lines.push(mdRow([row.script, row.policy, row.label, row.providerRefId, row.returnValue]));
    }
  } else {
    lines.push("- No selected-table return-0 providerRefId/label rows are available yet.");
  }
  lines.push("");
  lines.push("## Compare Replay Head");
  lines.push("");
  lines.push(mdRow(["Seq", "Script", "Policy", "Entry", "Label", "Ref", "Source Return", "Resolver Return", "Resolver Status"]));
  lines.push(mdRow(["---:", "---", "---", "---:", "---", "---", "---:", "---:", "---"]));
  for (const row of report.replayedCompares.slice(0, 64)) {
    lines.push(mdRow([
      row.seq,
      row.script,
      row.policy,
      row.entryIndex,
      row.label,
      row.refId,
      row.returnValue,
      row.resolverReturnValue,
      row.resolverStatus,
    ]));
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
  const jsonFile = path.join(outDir, "provider35c4_selected_feed_probe.json");
  const mdFile = path.join(outDir, "provider35c4_selected_feed_probe.md");
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
  buildObservedMatches,
  buildReport,
  extractSelectedCompareEvents,
  renderMarkdown,
  replayCompareEvents,
};
