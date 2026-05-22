const fs = require("fs");
const path = require("path");
const { DEFAULT_INPUT } = require("./cbe_unpack");
const { extOf } = require("./cbe_profile");
const { CbeRuntimeCore } = require("./cbe_runtime_core");
const { buildReport: buildSelectedTableReport } = require("./cbe_provider35c4_selected_table_walk_probe");
const { buildReport: buildStreamExecutorReport } = require("./cbe_provider35c4_stream_executor_probe");
const { buildReport: buildCaptureAdapterReport } = require("./cbe_provider35c4_return0_capture_adapter_probe");
const { buildReport: buildCapturedSelectedFeedReport } = require("./cbe_provider35c4_captured_selected_feed_probe");

const DEFAULT_INPUT_DIR = path.resolve(__dirname, "..", "cbe file");
const DEFAULT_OUT = path.resolve(__dirname, "out_cbe_runtime_core");
const EVENT_FILE_NAME = "runtime_core_provider35c4_observations.json";

function mdRow(values) {
  return `| ${values.map((value) => String(value ?? "").replace(/\|/g, "\\|")).join(" | ")} |`;
}

function listCbeFiles(input) {
  const resolved = path.resolve(input || DEFAULT_INPUT_DIR);
  const stat = fs.statSync(resolved);
  if (stat.isFile()) return [resolved];
  return fs.readdirSync(resolved)
    .filter((name) => /\.cbe$/i.test(name))
    .sort((a, b) => a.localeCompare(b, "zh-Hans-CN"))
    .map((name) => path.join(resolved, name));
}

function summarizeCore(file) {
  const core = new CbeRuntimeCore({ input: file });
  const summary = core.sourceSummary();
  const firstScene = core.listResources({ ext: ".sce", limit: 1 })[0] || null;
  const firstScript = core.listResources({ ext: ".xse", limit: 1 })[0] || null;
  return {
    file,
    game: path.basename(file, path.extname(file)),
    status: "runtime-core-ready",
    sectionCount: summary.sectionCount,
    resourceCount: summary.resourceCount,
    catalogCount: core.catalog.length,
    flags: summary.profile.flags,
    capabilities: summary.profile.capabilities,
    firstScene: firstScene?.name || "",
    firstScript: firstScript?.name || "",
  };
}

function buildCorpusCoreSummary(inputDir) {
  const files = listCbeFiles(inputDir);
  const games = [];
  for (const file of files) {
    try {
      games.push(summarizeCore(file));
    } catch (err) {
      games.push({
        file,
        game: path.basename(file, path.extname(file)),
        status: "unsupported-or-nonstandard",
        error: err.message || String(err),
      });
    }
  }
  const ready = games.filter((game) => game.status === "runtime-core-ready");
  return {
    input: path.resolve(inputDir || DEFAULT_INPUT_DIR),
    fileCount: games.length,
    readyCount: ready.length,
    unsupportedCount: games.length - ready.length,
    sceneGameCount: ready.filter((game) => game.flags?.hasScene).length,
    xseGameCount: ready.filter((game) => game.flags?.hasXse).length,
    games,
  };
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

function buildInvariant(id, passed, details, impact = "") {
  return { id, passed: Boolean(passed), details, impact };
}

function attachChecks(report, adapterReport, selectedFeedReport) {
  const adapterCheck = summarizeAdapterCheck(adapterReport);
  const selectedFeedCheck = summarizeSelectedFeedCheck(selectedFeedReport);
  report.provider35c4.adapterCheck = adapterCheck;
  report.provider35c4.selectedFeedCheck = selectedFeedCheck;
  report.provider35c4.counts.adapterCheckImportedObservationCount = adapterCheck.importedObservationCount;
  report.provider35c4.counts.adapterCheckFeedRowCount = adapterCheck.observedFeedRowCount;
  report.provider35c4.counts.selectedFeedCheckMatchedCount = selectedFeedCheck.resolverMatchedCount;
  report.provider35c4.counts.selectedFeedCheckExecutableCount = selectedFeedCheck.executableMatchedCount;
  report.invariants.push(buildInvariant(
    "runtime-core-provider-events-import-as-nonfeed",
    adapterCheck.importedObservationCount === report.provider35c4.counts.totalObservationCount
      && adapterCheck.observedFeedRowCount === 0
      && adapterCheck.executableObservedCount === 0,
    `${adapterCheck.importedObservationCount}/${report.provider35c4.counts.totalObservationCount} imported, feed=${adapterCheck.observedFeedRowCount}, executable=${adapterCheck.executableObservedCount}`,
    "Core-owned provider events must still pass through the capture adapter gate."
  ));
  report.invariants.push(buildInvariant(
    "runtime-core-selected-feed-remains-closed",
    selectedFeedCheck.selectedCompareCount === selectedFeedCheck.expectedCompareCount
      && selectedFeedCheck.observedFeedRowCount === 0
      && selectedFeedCheck.resolverMatchedCount === 0
      && selectedFeedCheck.executableMatchedCount === 0,
    `selected=${selectedFeedCheck.selectedCompareCount}/${selectedFeedCheck.expectedCompareCount}, feed=${selectedFeedCheck.observedFeedRowCount}, matched=${selectedFeedCheck.resolverMatchedCount}, executable=${selectedFeedCheck.executableMatchedCount}`,
    "The generic runtime core must not bypass selected-table feed/frontier gates."
  ));
  const failures = report.invariants.filter((item) => !item.passed);
  report.summary.failureCount = failures.length;
  report.summary.status = failures.length ? "cbe-runtime-core-risk" : "cbe-runtime-core-ready";
  return report;
}

function buildReport(options = {}) {
  const input = path.resolve(options.input || DEFAULT_INPUT);
  const inputDir = path.resolve(options.inputDir || DEFAULT_INPUT_DIR);
  const outDir = path.resolve(options.outDir || DEFAULT_OUT);
  const corpus = buildCorpusCoreSummary(inputDir);
  const core = new CbeRuntimeCore({ input });
  const source = core.sourceSummary();
  const selectedTable = buildSelectedTableReport({
    input,
    observationSink: core.provider35c4Channel.sink("core-selected-table"),
  });
  const streamExec = buildStreamExecutorReport({
    input,
    observationSink: core.provider35c4Channel.sink("core-parsed-stream"),
  });
  const annotatedEvents = core.provider35c4Channel.annotatedEvents();
  const selectedEvents = core.provider35c4Channel.eventsBySurface("core-selected-table", { annotated: true });
  const streamEvents = core.provider35c4Channel.eventsBySurface("core-parsed-stream", { annotated: true });
  const channelCounts = core.providerObservationSummary();
  const selectedExpected = selectedTable.summary?.compareOperationCount || selectedTable.counts?.compareOperationCount || 0;
  const streamExpected = streamExec.summary?.compareOperationCount || streamExec.counts?.compareOperationCount || 0;
  const selectedMissingEntryMeta = selectedEvents.filter((row) => row.entryIndex === undefined || !row.entryOffset);
  const eventFile = path.join(outDir, EVENT_FILE_NAME);
  const invariants = [
    buildInvariant(
      "runtime-core-loads-corpus-without-hardcoding-anchor",
      corpus.readyCount > 0 && corpus.readyCount + corpus.unsupportedCount === corpus.fileCount,
      `${corpus.readyCount}/${corpus.fileCount} CBE file(s) ready, ${corpus.unsupportedCount} unsupported/nonstandard`,
      "The core constructor must work as a generic archive/runtime shell, not only for the current anchor game."
    ),
    buildInvariant(
      "runtime-core-catalog-matches-archive",
      source.resourceCount === core.catalog.length && source.sectionCount > 0,
      `${core.catalog.length}/${source.resourceCount} catalog row(s), sections=${source.sectionCount}`,
      "The runtime core must expose archive resources through a stable catalog API."
    ),
    buildInvariant(
      "runtime-core-provider-channel-covers-selected-compares",
      selectedEvents.length === selectedExpected,
      `${selectedEvents.length}/${selectedExpected} selected-table observation(s) emitted through core channel`,
      "The generic core must own the provider event channel used by selected table execution."
    ),
    buildInvariant(
      "runtime-core-provider-channel-covers-stream-compares",
      streamEvents.length === streamExpected,
      `${streamEvents.length}/${streamExpected} parsed-stream observation(s) emitted through core channel`,
      "The generic core must also accept parsed-stream provider observations."
    ),
    buildInvariant(
      "runtime-core-preserves-selected-entry-metadata",
      selectedMissingEntryMeta.length === 0,
      `${selectedEvents.length - selectedMissingEntryMeta.length}/${selectedEvents.length} selected observation(s) include entry metadata`,
      "Future observed return-0 rows need entry metadata to join frontier checks."
    ),
    buildInvariant(
      "runtime-core-provider-events-are-adapter-compatible",
      channelCounts.invalidObservationCount === 0,
      `${channelCounts.adapterCompatibleObservationCount}/${channelCounts.totalObservationCount} adapter-compatible row(s)`,
      "Core provider events must be directly importable by the capture adapter."
    ),
    buildInvariant(
      "runtime-core-no-effects-from-nonmatch-provider-events",
      channelCounts.observedFeedRowCount === 0 && channelCounts.nonMatchObservationCount === channelCounts.totalObservationCount,
      `feed=${channelCounts.observedFeedRowCount}, nonmatch=${channelCounts.nonMatchObservationCount}/${channelCounts.totalObservationCount}`,
      "Generic runtime plumbing must stay no-effects until real return-0 provider observations are captured."
    ),
  ];
  const failures = invariants.filter((item) => !item.passed);
  return {
    schema: "nicai.cbe.runtimeCoreProbe.v1",
    generatedAt: new Date().toISOString(),
    input,
    inputs: {
      inputDir,
      runtimeCore: "CbeRuntimeCore",
      selectedTable: "cbe_provider35c4_selected_table_walk_probe.buildReport({ input, observationSink })",
      streamExecutor: "cbe_provider35c4_stream_executor_probe.buildReport({ input, observationSink })",
    },
    output: {
      providerObservationFile: eventFile,
      writesDefaultNativeCaptureFile: false,
    },
    source,
    corpus,
    provider35c4: {
      counts: {
        selectedObservationCount: selectedEvents.length,
        selectedExpectedCompareCount: selectedExpected,
        streamObservationCount: streamEvents.length,
        streamExpectedCompareCount: streamExpected,
        selectedMissingEntryMetadataCount: selectedMissingEntryMeta.length,
        ...channelCounts,
      },
      surfaces: channelCounts.surfaces,
      observationEvents: annotatedEvents,
      feedRows: core.provider35c4Channel.feedRows(),
      selectedObservationRows: selectedEvents.slice(0, 80),
      streamObservationRows: streamEvents.slice(0, 40),
      adapterCheck: null,
      selectedFeedCheck: null,
    },
    invariants,
    summary: {
      status: failures.length ? "cbe-runtime-core-risk" : "cbe-runtime-core-ready",
      currentFinding: `Runtime core loaded ${corpus.readyCount}/${corpus.fileCount} corpus CBE file(s) and emitted ${channelCounts.totalObservationCount} provider observation event(s) for the anchor through the core-owned channel.`,
      emulatorImpact: "This is the first reusable generic runtime shell: archive catalog, resource access, resource-profile capabilities, provider service construction, and provider observation channel are available outside individual probes.",
      nextTarget: "Move the remaining map renderer, control, and collision internals onto CbeRuntimeCore APIs, then feed real provider return-0 observations through the core-owned channel before enabling any effect VM path.",
      visibleEffectsEnabled: false,
      failureCount: failures.length,
      corpusReadyCount: corpus.readyCount,
      corpusFileCount: corpus.fileCount,
      resourceCount: source.resourceCount,
      providerObservationCount: channelCounts.totalObservationCount,
      providerFeedRowCount: channelCounts.observedFeedRowCount,
    },
  };
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# CBE Runtime Core Probe");
  lines.push("");
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Input CBE: \`${report.input}\``);
  lines.push(`- Corpus: \`${report.corpus.input}\``);
  lines.push(`- Status: ${report.summary.status}`);
  lines.push(`- Finding: ${report.summary.currentFinding}`);
  lines.push(`- Emulator impact: ${report.summary.emulatorImpact}`);
  lines.push(`- Next target: ${report.summary.nextTarget}`);
  lines.push("");
  lines.push("## Core Counts");
  lines.push("");
  lines.push(mdRow(["Field", "Value"]));
  lines.push(mdRow(["---", "---:"]));
  lines.push(mdRow(["corpusReady", `${report.corpus.readyCount}/${report.corpus.fileCount}`]));
  lines.push(mdRow(["sections", report.source.sectionCount]));
  lines.push(mdRow(["resources", report.source.resourceCount]));
  lines.push(mdRow(["providerEvents", report.provider35c4.counts.totalObservationCount]));
  lines.push(mdRow(["providerFeed", report.provider35c4.counts.observedFeedRowCount]));
  lines.push("");
  lines.push("## Provider 0x35C4 Channel");
  lines.push("");
  lines.push(mdRow(["Field", "Value"]));
  lines.push(mdRow(["---", "---:"]));
  for (const [key, value] of Object.entries(report.provider35c4.counts)) lines.push(mdRow([key, value]));
  lines.push("");
  lines.push("## Adapter Checks");
  lines.push("");
  lines.push(mdRow(["Check", "Status", "Selected/Imported", "Feed", "Matched", "Executable"]));
  lines.push(mdRow(["---", "---", "---:", "---:", "---:", "---:"]));
  if (report.provider35c4.adapterCheck) {
    lines.push(mdRow([
      "capture-adapter",
      report.provider35c4.adapterCheck.status,
      report.provider35c4.adapterCheck.importedObservationCount,
      report.provider35c4.adapterCheck.observedFeedRowCount,
      report.provider35c4.adapterCheck.p1MatchedCount,
      report.provider35c4.adapterCheck.executableObservedCount,
    ]));
  }
  if (report.provider35c4.selectedFeedCheck) {
    lines.push(mdRow([
      "selected-feed",
      report.provider35c4.selectedFeedCheck.status,
      `${report.provider35c4.selectedFeedCheck.selectedCompareCount}/${report.provider35c4.selectedFeedCheck.expectedCompareCount}`,
      report.provider35c4.selectedFeedCheck.observedFeedRowCount,
      report.provider35c4.selectedFeedCheck.resolverMatchedCount,
      report.provider35c4.selectedFeedCheck.executableMatchedCount,
    ]));
  }
  lines.push("");
  lines.push("## Corpus Sample");
  lines.push("");
  lines.push(mdRow(["Game", "Status", "Resources", "Scene", "XSE", "First Scene", "Error"]));
  lines.push(mdRow(["---", "---", "---:", "---", "---", "---", "---"]));
  for (const game of report.corpus.games.slice(0, 28)) {
    lines.push(mdRow([
      game.game,
      game.status,
      game.resourceCount || "",
      game.flags?.hasScene ? "yes" : "no",
      game.flags?.hasXse ? "yes" : "no",
      game.firstScene || "",
      game.error || "",
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

function main(argv = process.argv.slice(2)) {
  const input = path.resolve(argv[0] || DEFAULT_INPUT);
  const outDir = path.resolve(argv[1] || DEFAULT_OUT);
  const inputDir = path.resolve(argv[2] || DEFAULT_INPUT_DIR);
  fs.mkdirSync(outDir, { recursive: true });
  const report = buildReport({ input, outDir, inputDir });
  const providerObservationFile = path.join(outDir, EVENT_FILE_NAME);
  fs.writeFileSync(providerObservationFile, `${JSON.stringify({
    schema: "nicai.cbe.provider35c4Return0Observations.v1",
    generatedAt: report.generatedAt,
    authority: "non-authoritative-cbe-runtime-core",
    notes: [
      "This file is emitted by the generic CBE runtime core provider observation channel.",
      "It is adapter-compatible evidence and must not replace provider35c4_return0_observations.json.",
      "Only real provider rows with returnValue === 0 can feed resolver matches.",
    ],
    observations: report.provider35c4.observationEvents,
  }, null, 2)}\n`, "utf8");
  attachChecks(
    report,
    buildCaptureAdapterReport({ input, captureFile: providerObservationFile }),
    buildCapturedSelectedFeedReport({ input, captureFile: providerObservationFile }),
  );
  const jsonFile = path.join(outDir, "cbe_runtime_core_probe.json");
  const mdFile = path.join(outDir, "cbe_runtime_core_probe.md");
  fs.writeFileSync(jsonFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  fs.writeFileSync(mdFile, renderMarkdown(report), "utf8");
  console.log(`wrote ${jsonFile}`);
  console.log(`wrote ${mdFile}`);
  console.log(`wrote ${providerObservationFile}`);
  console.log(`${report.summary.status}: ${report.summary.currentFinding}`);
}

if (require.main === module) {
  main();
}

module.exports = {
  buildReport,
  renderMarkdown,
};
