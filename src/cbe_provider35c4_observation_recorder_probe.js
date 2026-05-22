const fs = require("fs");
const path = require("path");
const { DEFAULT_INPUT } = require("./cbe_unpack");
const { buildReport: buildStreamExecutorReport } = require("./cbe_provider35c4_stream_executor_probe");
const { buildReport: buildSelectedTableReport } = require("./cbe_provider35c4_selected_table_walk_probe");
const { buildReport: buildCaptureAdapterReport } = require("./cbe_provider35c4_return0_capture_adapter_probe");

const DEFAULT_OUT = path.resolve(__dirname, "out_godwar_provider35c4recorder");
const CAPTURE_PLAN_JSON = path.resolve(__dirname, "out_godwar_provider35c4capture", "provider35c4_capture_plan_probe.json");
const EVENT_FILE_NAME = "provider35c4_observation_events.json";

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

function compactSite(site) {
  return String(site || "").replace(/^0x0*/i, "0x").toUpperCase();
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function comparePointFromPlan() {
  const plan = readJson(CAPTURE_PLAN_JSON, {});
  const comparePoint = (plan.capturePoints || []).find((point) => point.id === "provider35c4-label-ref-compare-1") || {};
  return {
    id: comparePoint.id || "provider35c4-label-ref-compare-1",
    site: comparePoint.site || "0x0001233C",
    feedEligible: Boolean(comparePoint.feedEligible),
    planFile: CAPTURE_PLAN_JSON,
  };
}

function makeObservation(row, source, comparePoint, extra = {}) {
  const label = row.label || row.callerLabel || row.normalizedLabel || "";
  const returnValue = numberOrNull(row.returnValue ?? row.resultValue ?? row.serviceReturnValue);
  return {
    capturePointId: row.capturePointId || comparePoint.id,
    site: row.site || comparePoint.site,
    serviceGlobal: row.serviceGlobal || "0x35C4",
    method: row.method || "+0x50",
    dispatchShape: row.dispatchShape || "label-ref-compare",
    script: row.script || row.resource || "",
    resource: row.resource || row.script || "",
    policy: row.policy || "",
    context: row.context || "xse-range-entry-ref",
    label,
    normalizedLabel: normalizeLabel(label),
    providerRefId: row.providerRefId || row.refId || "",
    returnValue,
    source,
    sourceSeq: row.sourceSeq ?? row.callSeq ?? row.seq,
    opSeq: row.opSeq,
    refKnown: row.refKnown !== false,
    matched: returnValue === 0,
    ...extra,
  };
}

function extractStreamObservations(streamReport, comparePoint) {
  return (streamReport.operations || [])
    .filter((op) => op.dispatchShape === "label-ref-compare")
    .map((op, index) => ({
      recorderSeq: index + 1,
      ...makeObservation(op, "parsed-stream-executor", comparePoint, {
        streamOpSeq: op.opSeq,
        compareStatus: op.compareStatus || "",
        expectedReturnValue: op.expectedReturnValue,
      }),
    }));
}

function extractSelectedLaneObservations(selectedReport, comparePoint) {
  const observations = [];
  for (const lane of selectedReport.lanes || []) {
    for (const row of lane.rows || []) {
      if (row.kind !== "range-entry") continue;
      for (const compare of row.compares || []) {
        observations.push({
          recorderSeq: observations.length + 1,
          ...makeObservation({
            capturePointId: comparePoint.id,
            site: comparePoint.site,
            method: "+0x50",
            dispatchShape: "label-ref-compare",
            script: lane.script,
            resource: lane.script,
            policy: lane.policy,
            context: "xse-range-entry-ref",
            label: compare.label,
            providerRefId: row.providerRefId,
            returnValue: compare.returnValue,
          }, "selected-table-walk", comparePoint, {
            laneIndex: lane.laneIndex,
            start: lane.start || "",
            modeKey: lane.modeKey || "",
            entryIndex: row.index,
            entryOffset: row.offset || "",
            field04: row.field04?.value,
            field08: row.field08?.value,
            field0C: row.field0C,
            refRaw: row.field10?.raw || "",
            refMode: row.field10?.mode || "",
          }),
        });
      }
    }
  }
  return observations;
}

function schemaProblems(row, comparePoint) {
  const problems = [];
  if (row.capturePointId !== comparePoint.id) problems.push("wrong-capture-point");
  if (compactSite(row.site) !== compactSite(comparePoint.site)) problems.push("wrong-site");
  if (row.method !== "+0x50") problems.push("wrong-method");
  if (row.dispatchShape !== "label-ref-compare") problems.push("wrong-shape");
  if (!row.label) problems.push("missing-label");
  if (!row.providerRefId) problems.push("missing-providerRefId");
  if (!Number.isFinite(row.returnValue)) problems.push("missing-returnValue");
  return problems;
}

function eventPayload(report) {
  return {
    schema: "nicai.cbe.provider35c4Return0Observations.v1",
    generatedAt: report.generatedAt,
    authority: "non-authoritative-js-recorder",
    notes: [
      "This file is a recorder/export fixture for adapter compatibility checks.",
      "It is not the default native capture file and must not be treated as real return-0 evidence.",
      "Only rows with returnValue === 0 from the real provider compare site can feed resolver matches.",
    ],
    observations: report.observationEvents,
  };
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

function attachAdapterCheck(report, adapterReport) {
  const adapterCheck = summarizeAdapterCheck(adapterReport);
  report.adapterCheck = adapterCheck;
  report.counts.adapterCheckImportedObservationCount = adapterCheck.importedObservationCount;
  report.counts.adapterCheckFeedRowCount = adapterCheck.observedFeedRowCount;
  report.counts.adapterCheckExecutableRowCount = adapterCheck.executableObservedCount;
  report.invariants.push(buildInvariant(
    "capture-adapter-imports-recorder-as-nonfeed",
    adapterCheck.importedObservationCount === report.counts.totalObservationCount
      && adapterCheck.observedFeedRowCount === 0
      && adapterCheck.executableObservedCount === 0,
    `${adapterCheck.importedObservationCount}/${report.counts.totalObservationCount} imported, feed=${adapterCheck.observedFeedRowCount}, executable=${adapterCheck.executableObservedCount}`,
    "The existing capture adapter must treat recorder events as non-match evidence unless real return-0 rows appear."
  ));
  const failures = report.invariants.filter((item) => !item.passed);
  report.summary.failureCount = failures.length;
  report.summary.status = failures.length
    ? "provider35c4-observation-recorder-risk"
    : report.counts.return0ObservationCount
    ? "provider35c4-observation-recorder-return0-present"
    : "provider35c4-observation-recorder-nonfeed-ready";
  return report;
}

function buildReport(options = {}) {
  const input = path.resolve(options.input || DEFAULT_INPUT);
  const comparePoint = comparePointFromPlan();
  const streamReport = buildStreamExecutorReport({ input });
  const selectedReport = buildSelectedTableReport({ input });
  const streamObservations = extractStreamObservations(streamReport, comparePoint);
  const selectedObservations = extractSelectedLaneObservations(selectedReport, comparePoint);
  const selectedOperationCompareCount = (selectedReport.operations || []).filter((op) => op.dispatchShape === "label-ref-compare").length;
  const observations = [
    ...selectedObservations.map((row) => ({ ...row, recorderSurface: "selected" })),
    ...streamObservations.map((row) => ({ ...row, recorderSurface: "stream" })),
  ].map((row, index) => ({
    observationSeq: index + 1,
    ...row,
  }));
  const annotated = observations.map((row) => {
    const problems = schemaProblems(row, comparePoint);
    return {
      ...row,
      validForAdapter: problems.length === 0,
      validForFeed: problems.length === 0 && row.returnValue === 0,
      nonMatchObservation: problems.length === 0 && row.returnValue !== 0,
      problems,
    };
  });
  const invalidRows = annotated.filter((row) => row.problems.length > 0);
  const return0Rows = annotated.filter((row) => row.validForFeed);
  const nonMatchRows = annotated.filter((row) => row.nonMatchObservation);
  const expectedSelected = selectedReport.summary?.compareOperationCount || selectedReport.counts?.compareOperationCount || 0;
  const expectedStream = streamReport.summary?.compareOperationCount || streamReport.counts?.compareOperationCount || 0;
  const eventFile = path.join(path.resolve(options.outDir || DEFAULT_OUT), EVENT_FILE_NAME);
  const invariants = [
    buildInvariant(
      "recorder-covers-selected-table-compares",
      selectedObservations.length === expectedSelected,
      `${selectedObservations.length}/${expectedSelected} selected-table compare observation(s) exported`,
      "The recorder must cover the full selected loader surface, not only the sampled operations list."
    ),
    buildInvariant(
      "recorder-covers-parsed-stream-compares",
      streamObservations.length === expectedStream,
      `${streamObservations.length}/${expectedStream} parsed-stream compare observation(s) exported`,
      "The recorder keeps the narrow parsed feeder available as a parity/debug source."
    ),
    buildInvariant(
      "recorder-schema-compatible-with-capture-adapter",
      invalidRows.length === 0 && comparePoint.feedEligible,
      `${annotated.length - invalidRows.length}/${annotated.length} valid row(s), compare point feedEligible=${comparePoint.feedEligible ? "yes" : "no"}`,
      "Native hooks, JS provider replay, and fixtures need the same label/ref compare observation shape."
    ),
    buildInvariant(
      "nonzero-recorder-events-do-not-feed-resolver",
      return0Rows.length === 0 && nonMatchRows.length === annotated.length,
      `${return0Rows.length} return-0 feed row(s), ${nonMatchRows.length} non-match evidence row(s)`,
      "Recorder evidence with returnValue != 0 must stay out of the resolver feed."
    ),
    buildInvariant(
      "recorder-output-is-not-default-native-capture",
      path.basename(eventFile) !== "provider35c4_return0_observations.json",
      eventFile,
      "The recorder can test adapter shape without polluting the real observation import boundary."
    ),
  ];
  const failures = invariants.filter((item) => !item.passed);
  const status = failures.length
    ? "provider35c4-observation-recorder-risk"
    : return0Rows.length
    ? "provider35c4-observation-recorder-return0-present"
    : "provider35c4-observation-recorder-nonfeed-ready";
  return {
    schema: "nicai.cbe.provider35c4ObservationRecorderProbe.v1",
    generatedAt: new Date().toISOString(),
    input,
    inputs: {
      streamExecutor: "cbe_provider35c4_stream_executor_probe.buildReport({ input })",
      selectedTable: "cbe_provider35c4_selected_table_walk_probe.buildReport({ input })",
      capturePlan: CAPTURE_PLAN_JSON,
    },
    output: {
      observationEventFile: eventFile,
      writesDefaultNativeCaptureFile: false,
    },
    capturePoint: comparePoint,
    counts: {
      selectedObservationCount: selectedObservations.length,
      selectedExpectedCompareCount: expectedSelected,
      selectedOperationCompareCount,
      streamObservationCount: streamObservations.length,
      streamExpectedCompareCount: expectedStream,
      totalObservationCount: annotated.length,
      adapterCompatibleObservationCount: annotated.length - invalidRows.length,
      invalidObservationCount: invalidRows.length,
      return0ObservationCount: return0Rows.length,
      nonMatchObservationCount: nonMatchRows.length,
      observedFeedRowCount: return0Rows.length,
    },
    streamObservationRows: streamObservations.slice(0, 40),
    selectedObservationRows: selectedObservations.slice(0, 80),
    observationEvents: annotated,
    feedRows: return0Rows,
    invalidRows: invalidRows.slice(0, 40),
    adapterCheck: null,
    invariants,
    summary: {
      status,
      currentFinding: `Recorder exports ${selectedObservations.length} selected-table compare observation(s) plus ${streamObservations.length} parsed-stream compare observation(s); all current returns are nonzero, so feed rows remain ${return0Rows.length}.`,
      emulatorImpact: "This creates the common provider-observation boundary the generic CBE web emulator can use for native hooks, JS service replay, and fixtures without enabling visible effects from guessed rows.",
      nextTarget: "Use this recorder shape as the runtime event sink, then replace the non-authoritative fixture with real provider return observations before any entry promotion.",
      visibleEffectsEnabled: false,
      failureCount: failures.length,
      selectedObservationCount: selectedObservations.length,
      streamObservationCount: streamObservations.length,
      totalObservationCount: annotated.length,
      observedFeedRowCount: return0Rows.length,
      nonMatchObservationCount: nonMatchRows.length,
    },
  };
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# Provider 0x35C4 Observation Recorder Probe");
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
  lines.push("## Capture Boundary");
  lines.push("");
  lines.push(mdRow(["Point", "Site", "Feed Eligible", "Event File", "Default Capture"]));
  lines.push(mdRow(["---", "---", "---", "---", "---"]));
  lines.push(mdRow([
    report.capturePoint.id,
    report.capturePoint.site,
    report.capturePoint.feedEligible ? "yes" : "no",
    report.output.observationEventFile,
    report.output.writesDefaultNativeCaptureFile ? "writes" : "not written",
  ]));
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
  lines.push("## Selected Sample");
  lines.push("");
  lines.push(mdRow(["Seq", "Script", "Policy", "Entry", "Label", "Ref", "Return", "Raw"]));
  lines.push(mdRow(["---:", "---", "---", "---:", "---", "---", "---:", "---"]));
  for (const row of report.selectedObservationRows.slice(0, 16)) {
    lines.push(mdRow([row.recorderSeq, row.script, row.policy, row.entryIndex, row.label, row.providerRefId, row.returnValue, row.refRaw]));
  }
  lines.push("");
  lines.push("## Stream Sample");
  lines.push("");
  lines.push(mdRow(["Seq", "Script", "Policy", "Label", "Ref", "Return", "Op"]));
  lines.push(mdRow(["---:", "---", "---", "---", "---", "---:", "---:"]));
  for (const row of report.streamObservationRows.slice(0, 12)) {
    lines.push(mdRow([row.recorderSeq, row.script, row.policy, row.label, row.providerRefId, row.returnValue, row.streamOpSeq]));
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
  const jsonFile = path.join(outDir, "provider35c4_observation_recorder_probe.json");
  const mdFile = path.join(outDir, "provider35c4_observation_recorder_probe.md");
  const eventFile = path.join(outDir, EVENT_FILE_NAME);
  fs.writeFileSync(eventFile, `${JSON.stringify(eventPayload(report), null, 2)}\n`, "utf8");
  attachAdapterCheck(report, buildCaptureAdapterReport({ input, captureFile: eventFile }));
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
