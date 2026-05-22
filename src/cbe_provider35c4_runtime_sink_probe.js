const fs = require("fs");
const path = require("path");
const { DEFAULT_INPUT } = require("./cbe_unpack");
const { buildReport: buildSelectedTableReport } = require("./cbe_provider35c4_selected_table_walk_probe");
const { buildReport: buildStreamExecutorReport } = require("./cbe_provider35c4_stream_executor_probe");
const { buildReport: buildCaptureAdapterReport } = require("./cbe_provider35c4_return0_capture_adapter_probe");
const { buildReport: buildCapturedSelectedFeedReport } = require("./cbe_provider35c4_captured_selected_feed_probe");
const {
  Provider35C4ObservationChannel,
  createProvider35C4ObservationPayload,
} = require("./cbe_provider_observation_channel");

const DEFAULT_OUT = path.resolve(__dirname, "out_godwar_provider35c4runtimesink");
const EVENT_FILE_NAME = "provider35c4_runtime_observation_events.json";

function mdRow(values) {
  return `| ${values.map((value) => String(value ?? "").replace(/\|/g, "\\|")).join(" | ")} |`;
}

function eventPayload(report) {
  return createProvider35C4ObservationPayload(report.observationEvents, {
    generatedAt: report.generatedAt,
    authority: "non-authoritative-runtime-sink",
    notes: [
      "This file is emitted by the JS runtime service-object sink, not by native provider instrumentation.",
      "It is adapter-compatible evidence and must not replace provider35c4_return0_observations.json.",
      "Only real provider rows with returnValue === 0 can feed resolver matches.",
    ],
  });
}

function buildInvariant(id, passed, details, impact = "") {
  return { id, passed: Boolean(passed), details, impact };
}

function summarizeAdapterCheck(adapterReport) {
  return {
    status: adapterReport.summary?.status || "",
    captureFile: adapterReport.captureSource?.path || "",
    importedObservationCount: adapterReport.summary?.importedObservationCount || adapterReport.counts?.importedObservationCount || 0,
    nonMatchObservationCount: adapterReport.counts?.nonMatchObservationCount || 0,
    observedFeedRowCount: adapterReport.summary?.observedFeedRowCount || adapterReport.counts?.observedFeedRowCount || 0,
    p1MatchedCount: adapterReport.summary?.p1MatchedCount || adapterReport.counts?.p1MatchedCount || 0,
    directCaseObservedCount: adapterReport.summary?.directCaseObservedCount || adapterReport.counts?.directCaseObservedCount || 0,
    executableObservedCount: adapterReport.summary?.executableObservedCount || adapterReport.counts?.executableObservedCount || 0,
  };
}

function summarizeSelectedFeedCheck(feedReport) {
  return {
    status: feedReport.summary?.status || "",
    selectedCompareCount: feedReport.summary?.selectedCompareCount || feedReport.counts?.selectedCompareCount || 0,
    expectedCompareCount: feedReport.counts?.expectedCompareCount || 0,
    observedFeedRowCount: feedReport.summary?.observedFeedRowCount || feedReport.counts?.observedFeedRowCount || 0,
    resolverMatchedCount: feedReport.summary?.resolverMatchedCount || feedReport.counts?.resolverMatchedCount || 0,
    frontierJoinedCount: feedReport.counts?.frontierJoinedCount || 0,
    directMatchedCount: feedReport.summary?.directMatchedCount || feedReport.counts?.directMatchedCount || 0,
    executableMatchedCount: feedReport.summary?.executableMatchedCount || feedReport.counts?.executableMatchedCount || 0,
  };
}

function attachChecks(report, adapterReport, selectedFeedReport) {
  const adapterCheck = summarizeAdapterCheck(adapterReport);
  const selectedFeedCheck = summarizeSelectedFeedCheck(selectedFeedReport);
  report.adapterCheck = adapterCheck;
  report.selectedFeedCheck = selectedFeedCheck;
  report.counts.adapterCheckImportedObservationCount = adapterCheck.importedObservationCount;
  report.counts.adapterCheckFeedRowCount = adapterCheck.observedFeedRowCount;
  report.counts.adapterCheckExecutableRowCount = adapterCheck.executableObservedCount;
  report.counts.selectedFeedCheckMatchedCount = selectedFeedCheck.resolverMatchedCount;
  report.counts.selectedFeedCheckExecutableCount = selectedFeedCheck.executableMatchedCount;
  report.invariants.push(buildInvariant(
    "runtime-sink-imports-as-nonfeed",
    adapterCheck.importedObservationCount === report.counts.totalObservationCount
      && adapterCheck.observedFeedRowCount === 0
      && adapterCheck.executableObservedCount === 0,
    `${adapterCheck.importedObservationCount}/${report.counts.totalObservationCount} imported, feed=${adapterCheck.observedFeedRowCount}, executable=${adapterCheck.executableObservedCount}`,
    "Runtime-emitted observation events must still pass through the same capture adapter gate."
  ));
  report.invariants.push(buildInvariant(
    "runtime-sink-selected-feed-remains-closed",
    selectedFeedCheck.selectedCompareCount === selectedFeedCheck.expectedCompareCount
      && selectedFeedCheck.observedFeedRowCount === 0
      && selectedFeedCheck.resolverMatchedCount === 0
      && selectedFeedCheck.executableMatchedCount === 0,
    `selected=${selectedFeedCheck.selectedCompareCount}/${selectedFeedCheck.expectedCompareCount}, feed=${selectedFeedCheck.observedFeedRowCount}, matched=${selectedFeedCheck.resolverMatchedCount}, executable=${selectedFeedCheck.executableMatchedCount}`,
    "Runtime sink events must not bypass the selected-table feed/frontier gates."
  ));
  const failures = report.invariants.filter((item) => !item.passed);
  report.summary.failureCount = failures.length;
  report.summary.status = failures.length
    ? "provider35c4-runtime-sink-risk"
    : report.counts.return0ObservationCount
    ? "provider35c4-runtime-sink-return0-present"
    : "provider35c4-runtime-sink-nonfeed-ready";
  return report;
}

function buildReport(options = {}) {
  const input = path.resolve(options.input || DEFAULT_INPUT);
  const outDir = path.resolve(options.outDir || DEFAULT_OUT);
  const channel = new Provider35C4ObservationChannel({
    authority: "non-authoritative-runtime-sink",
  });
  const selectedTable = buildSelectedTableReport({
    input,
    observationSink: channel.sink("selected-table"),
  });
  const streamExec = buildStreamExecutorReport({
    input,
    observationSink: channel.sink("parsed-stream"),
  });
  const observations = channel.annotatedEvents();
  const selectedEvents = channel.eventsBySurface("selected-table", { annotated: true });
  const streamEvents = channel.eventsBySurface("parsed-stream", { annotated: true });
  const invalidRows = observations.filter((row) => row.problems.length > 0);
  const return0Rows = observations.filter((row) => row.validForFeed);
  const nonMatchRows = observations.filter((row) => row.nonMatchObservation);
  const selectedExpected = selectedTable.summary?.compareOperationCount || selectedTable.counts?.compareOperationCount || 0;
  const streamExpected = streamExec.summary?.compareOperationCount || streamExec.counts?.compareOperationCount || 0;
  const selectedMissingEntryMeta = selectedEvents.filter((row) => row.entryIndex === undefined || !row.entryOffset);
  const eventFile = path.join(outDir, EVENT_FILE_NAME);
  const invariants = [
    buildInvariant(
      "runtime-sink-covers-selected-compares",
      selectedEvents.length === selectedExpected,
      `${selectedEvents.length}/${selectedExpected} selected-table runtime observation(s) emitted`,
      "The service object must emit observations during selected table execution, not only through report post-processing."
    ),
    buildInvariant(
      "runtime-sink-covers-parsed-stream-compares",
      streamEvents.length === streamExpected,
      `${streamEvents.length}/${streamExpected} parsed-stream runtime observation(s) emitted`,
      "The narrow parsed feeder should use the same service-object observation sink."
    ),
    buildInvariant(
      "runtime-sink-preserves-selected-entry-metadata",
      selectedMissingEntryMeta.length === 0,
      `${selectedEvents.length - selectedMissingEntryMeta.length}/${selectedEvents.length} selected observation(s) include entry metadata`,
      "Selected table runtime events need entry metadata so future return-0 rows can join promotion/frontier checks."
    ),
    buildInvariant(
      "runtime-sink-schema-compatible",
      invalidRows.length === 0,
      `${observations.length - invalidRows.length}/${observations.length} adapter-compatible observation row(s)`,
      "Runtime-emitted events must be directly importable by the capture adapter."
    ),
    buildInvariant(
      "runtime-sink-nonzero-does-not-feed",
      return0Rows.length === 0 && nonMatchRows.length === observations.length,
      `${return0Rows.length} return-0 feed row(s), ${nonMatchRows.length} non-match row(s)`,
      "The runtime sink is an observation channel, not an execution bypass."
    ),
    buildInvariant(
      "runtime-sink-does-not-write-native-capture",
      path.basename(eventFile) !== "provider35c4_return0_observations.json",
      eventFile,
      "Non-authoritative JS runtime events must not pollute the real native/provider observation file."
    ),
  ];
  const failures = invariants.filter((item) => !item.passed);
  const status = failures.length
    ? "provider35c4-runtime-sink-risk"
    : return0Rows.length
    ? "provider35c4-runtime-sink-return0-present"
    : "provider35c4-runtime-sink-nonfeed-ready";
  return {
    schema: "nicai.cbe.provider35c4RuntimeSinkProbe.v1",
    generatedAt: new Date().toISOString(),
    input,
    inputs: {
      selectedTable: "cbe_provider35c4_selected_table_walk_probe.buildReport({ input, observationSink })",
      streamExecutor: "cbe_provider35c4_stream_executor_probe.buildReport({ input, observationSink })",
      serviceObject: "Provider35C4ServiceObject({ observationSink })",
    },
    output: {
      observationEventFile: eventFile,
      writesDefaultNativeCaptureFile: false,
    },
    counts: {
      selectedObservationCount: selectedEvents.length,
      selectedExpectedCompareCount: selectedExpected,
      streamObservationCount: streamEvents.length,
      streamExpectedCompareCount: streamExpected,
      totalObservationCount: observations.length,
      adapterCompatibleObservationCount: observations.length - invalidRows.length,
      invalidObservationCount: invalidRows.length,
      return0ObservationCount: return0Rows.length,
      nonMatchObservationCount: nonMatchRows.length,
      observedFeedRowCount: return0Rows.length,
      selectedMissingEntryMetadataCount: selectedMissingEntryMeta.length,
    },
    selectedObservationRows: selectedEvents.slice(0, 80),
    streamObservationRows: streamEvents.slice(0, 40),
    observationEvents: observations,
    feedRows: return0Rows,
    invalidRows: invalidRows.slice(0, 40),
    adapterCheck: null,
    selectedFeedCheck: null,
    invariants,
    summary: {
      status,
      currentFinding: `Runtime service-object sink emitted ${selectedEvents.length} selected-table compare observation(s) and ${streamEvents.length} parsed-stream compare observation(s); current feed rows remain ${return0Rows.length}.`,
      emulatorImpact: "This moves provider observation capture from offline report extraction into the service-object runtime path that a generic browser CBE emulator can call.",
      nextTarget: "Use this sink as the web emulator provider-event channel, then replace JS non-match fixtures with real native/provider return-0 observations before any entry promotion.",
      visibleEffectsEnabled: false,
      failureCount: failures.length,
      selectedObservationCount: selectedEvents.length,
      streamObservationCount: streamEvents.length,
      totalObservationCount: observations.length,
      observedFeedRowCount: return0Rows.length,
      nonMatchObservationCount: nonMatchRows.length,
    },
  };
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# Provider 0x35C4 Runtime Sink Probe");
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
  if (report.adapterCheck) {
    lines.push("## Adapter Check");
    lines.push("");
    lines.push(mdRow(["Status", "Imported", "Non-match", "Feed", "P1", "Direct", "Executable"]));
    lines.push(mdRow(["---", "---:", "---:", "---:", "---:", "---:", "---:"]));
    lines.push(mdRow([
      report.adapterCheck.status,
      report.adapterCheck.importedObservationCount,
      report.adapterCheck.nonMatchObservationCount,
      report.adapterCheck.observedFeedRowCount,
      report.adapterCheck.p1MatchedCount,
      report.adapterCheck.directCaseObservedCount,
      report.adapterCheck.executableObservedCount,
    ]));
    lines.push("");
  }
  if (report.selectedFeedCheck) {
    lines.push("## Selected Feed Check");
    lines.push("");
    lines.push(mdRow(["Status", "Selected", "Feed", "Matched", "Frontier", "Direct", "Executable"]));
    lines.push(mdRow(["---", "---:", "---:", "---:", "---:", "---:", "---:"]));
    lines.push(mdRow([
      report.selectedFeedCheck.status,
      `${report.selectedFeedCheck.selectedCompareCount}/${report.selectedFeedCheck.expectedCompareCount}`,
      report.selectedFeedCheck.observedFeedRowCount,
      report.selectedFeedCheck.resolverMatchedCount,
      report.selectedFeedCheck.frontierJoinedCount,
      report.selectedFeedCheck.directMatchedCount,
      report.selectedFeedCheck.executableMatchedCount,
    ]));
    lines.push("");
  }
  lines.push("## Selected Runtime Sample");
  lines.push("");
  lines.push(mdRow(["Seq", "Script", "Policy", "Entry", "Label", "Ref", "Return", "Raw"]));
  lines.push(mdRow(["---:", "---", "---", "---:", "---", "---", "---:", "---"]));
  for (const row of report.selectedObservationRows.slice(0, 16)) {
    lines.push(mdRow([row.observationSeq, row.script, row.policy, row.entryIndex, row.label, row.providerRefId, row.returnValue, row.refRaw]));
  }
  lines.push("");
  lines.push("## Stream Runtime Sample");
  lines.push("");
  lines.push(mdRow(["Seq", "Script", "Policy", "Label", "Ref", "Return", "Op"]));
  lines.push(mdRow(["---:", "---", "---", "---", "---", "---:", "---:"]));
  for (const row of report.streamObservationRows.slice(0, 12)) {
    lines.push(mdRow([row.observationSeq, row.script, row.policy, row.label, row.providerRefId, row.returnValue, row.opSeq]));
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

function main(argv = process.argv.slice(2)) {
  const input = path.resolve(argv[0] || DEFAULT_INPUT);
  const outDir = path.resolve(argv[1] || DEFAULT_OUT);
  fs.mkdirSync(outDir, { recursive: true });
  const report = buildReport({ input, outDir });
  const jsonFile = path.join(outDir, "provider35c4_runtime_sink_probe.json");
  const mdFile = path.join(outDir, "provider35c4_runtime_sink_probe.md");
  const eventFile = path.join(outDir, EVENT_FILE_NAME);
  fs.writeFileSync(eventFile, `${JSON.stringify(eventPayload(report), null, 2)}\n`, "utf8");
  attachChecks(
    report,
    buildCaptureAdapterReport({ input, captureFile: eventFile }),
    buildCapturedSelectedFeedReport({ input, captureFile: eventFile }),
  );
  fs.writeFileSync(jsonFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  fs.writeFileSync(mdFile, renderMarkdown(report), "utf8");
  console.log(`wrote ${jsonFile}`);
  console.log(`wrote ${mdFile}`);
  console.log(`wrote ${eventFile}`);
  console.log(`${report.summary.status}: ${report.summary.currentFinding}`);
}

if (require.main === module) {
  main();
}

module.exports = {
  buildReport,
  eventPayload,
  renderMarkdown,
};
