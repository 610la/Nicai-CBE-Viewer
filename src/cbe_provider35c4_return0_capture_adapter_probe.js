const fs = require("fs");
const path = require("path");
const { DEFAULT_INPUT } = require("./cbe_unpack");
const { createObservedProviderRefResolver } = require("./cbe_provider_abi_shim_probe");

const DEFAULT_OUT = path.resolve(__dirname, "out_godwar_provider35c4return0capture");
const DEFAULT_CAPTURE_JSON = path.resolve(DEFAULT_OUT, "provider35c4_return0_observations.json");
const RETURN0_PRIORITY_JSON = path.resolve(__dirname, "out_godwar_provider35c4return0priority", "provider35c4_return0_priority_probe.json");
const PROMOTION_FRONTIER_JSON = path.resolve(__dirname, "out_godwar_provider35c4frontier", "provider35c4_promotion_frontier_probe.json");
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

function compactSite(site) {
  return String(site || "").replace(/^0x0*/i, "0x").toUpperCase();
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

function labelRefKey(row) {
  return `${normalizeLabel(row.label || row.callerLabel || row.normalizedLabel)}|${row.providerRefId || ""}`;
}

function loadCaptureFile(file) {
  if (!fs.existsSync(file)) {
    return {
      exists: false,
      source: file,
      observations: [],
      rawObservationCount: 0,
      loadStatus: "capture-file-missing",
    };
  }
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const observations = Array.isArray(raw) ? raw : (raw.observations || raw.events || []);
  return {
    exists: true,
    source: file,
    observations,
    rawObservationCount: observations.length,
    loadStatus: "capture-file-loaded",
  };
}

function normalizeObservation(row, index, comparePoint) {
  const label = row.label || row.callerLabel || row.normalizedLabel || "";
  const providerRefId = row.providerRefId || row.refId || "";
  const returnValue = Number.isFinite(row.returnValue) ? row.returnValue : Number(row.returnValue);
  const capturePointId = row.capturePointId || row.pointId || comparePoint.id || "provider35c4-label-ref-compare-1";
  const site = row.site || row.captureSite || comparePoint.site || "0x0001233C";
  const normalized = {
    importSeq: index + 1,
    capturePointId,
    site,
    script: row.script || row.resource || "",
    policy: row.policy || "",
    start: row.start || "",
    modeKey: row.modeKey || "",
    entryIndex: row.entryIndex,
    entryOffset: row.entryOffset || "",
    label,
    normalizedLabel: normalizeLabel(label),
    providerRefId,
    refRaw: row.refRaw || row.rawSample || "",
    refMode: row.refMode || "",
    returnValue,
    source: row.source || "external-provider35c4-return0-capture",
  };
  const problems = [];
  if (capturePointId !== "provider35c4-label-ref-compare-1") problems.push("wrong-capture-point");
  if (comparePoint.site && compactSite(site) !== compactSite(comparePoint.site)) problems.push("wrong-site");
  if (!providerRefId) problems.push("missing-providerRefId");
  if (!label) problems.push("missing-label");
  if (!Number.isFinite(returnValue)) problems.push("missing-returnValue");
  normalized.validForFeed = problems.length === 0 && returnValue === 0;
  normalized.nonMatchObservation = problems.length === 0 && returnValue !== 0;
  normalized.problems = problems;
  return normalized;
}

function buildObservedMatches(observations) {
  const seen = new Set();
  const rows = [];
  for (const row of observations.filter((item) => item.validForFeed)) {
    const key = labelRefKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      label: row.label,
      normalizedLabel: row.normalizedLabel,
      providerRefId: row.providerRefId,
      source: "captured-provider35c4-return0",
      script: row.script,
      policy: row.policy,
      entryIndex: row.entryIndex,
      returnValue: row.returnValue,
      importSeq: row.importSeq,
    });
  }
  return rows;
}

function replayP1(selectedRows, observedMatches) {
  const resolver = createObservedProviderRefResolver(observedMatches);
  return selectedRows.map((row) => {
    const result = resolver({
      callerLabel: row.label,
      normalizedLabel: normalizeLabel(row.label),
      entryRef: {
        kind: "provider-opaque-ref",
        context: "xse-selected-return0-capture-ref",
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

function joinFrontier(rows, frontier) {
  const frontierByKey = new Map((frontier.schedulerCandidates || []).map((row) => [selectedKey(row), row]));
  return rows.map((row) => {
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

function matchModeRows(observations, modeRows) {
  const return0Rows = observations.filter((row) => row.validForFeed);
  return return0Rows.flatMap((observation) => {
    const matches = modeRows.filter((row) => (
      (!observation.script || row.script === observation.script)
      && (!observation.start || row.start === observation.start)
      && (!observation.modeKey || row.modeKey === observation.modeKey)
      && (!Number.isInteger(observation.entryIndex) || row.entryIndex === observation.entryIndex)
      && normalizeLabel(row.label) === observation.normalizedLabel
      && (!observation.refRaw || row.refRaw === observation.refRaw)
    ));
    return matches.map((row) => ({
      importSeq: observation.importSeq,
      script: row.script,
      start: row.start,
      modeKey: row.modeKey,
      entryIndex: row.entryIndex,
      label: row.label,
      providerRefId: observation.providerRefId,
      refRaw: row.refRaw,
      target: row.target,
      blocker: row.blocker,
    }));
  });
}

function captureTemplate(comparePoint) {
  return {
    schema: "nicai.cbe.provider35c4Return0Observations.v1",
    notes: [
      "Only observations from provider35c4-label-ref-compare-1 at 0x1233C can feed resolver matches.",
      "Rows with returnValue 0 become observed feed rows when label and providerRefId are present.",
      "Nonzero return values are kept as evidence but do not feed the resolver.",
    ],
    observations: [
      {
        capturePointId: "provider35c4-label-ref-compare-1",
        site: comparePoint.site || "0x0001233C",
        script: "s_04.xse",
        policy: "xse-body-prefix",
        entryIndex: 2,
        label: "Init",
        providerRefId: "ref193",
        returnValue: 0,
        source: "native-provider-capture",
      },
    ],
  };
}

function buildInvariant(id, passed, details, impact = "") {
  return { id, passed: Boolean(passed), details, impact };
}

function buildReport(options = {}) {
  const input = path.resolve(options.input || DEFAULT_INPUT);
  const captureFile = path.resolve(options.captureFile || DEFAULT_CAPTURE_JSON);
  const priority = readJson(RETURN0_PRIORITY_JSON, {});
  const frontier = readJson(PROMOTION_FRONTIER_JSON, {});
  const capturePlan = readJson(CAPTURE_PLAN_JSON, {});
  const comparePoint = (capturePlan.capturePoints || []).find((point) => point.id === "provider35c4-label-ref-compare-1") || {};
  const capture = loadCaptureFile(captureFile);
  const observations = capture.observations.map((row, index) => normalizeObservation(row, index, comparePoint));
  const invalidObservations = observations.filter((row) => row.problems.length > 0);
  const return0Observations = observations.filter((row) => row.validForFeed);
  const nonMatchObservations = observations.filter((row) => row.nonMatchObservation);
  const observedMatches = buildObservedMatches(observations);
  const p1Rows = priority.selectedPriorities || [];
  const p1Replays = joinFrontier(replayP1(p1Rows, observedMatches), frontier);
  const p1Matches = p1Replays.filter((row) => row.resolverMatched);
  const directRows = p1Replays.filter((row) => row.resolverMatched && row.directCaseIfObserved);
  const executableRows = directRows;
  const modeMatches = matchModeRows(observations, priority.modeScanPriorities || []);
  const invariants = [
    buildInvariant(
      "capture-schema-bound-to-label-ref-point",
      comparePoint.feedEligible === true,
      `${comparePoint.id || "missing"} ${comparePoint.site || ""} feedEligible=${comparePoint.feedEligible === true ? "yes" : "no"}`,
      "The real observation adapter must stay bound to the label/ref compare return point."
    ),
    buildInvariant(
      "capture-import-has-no-invalid-feed-rows",
      invalidObservations.length === 0,
      `${invalidObservations.length}/${observations.length} invalid imported observation row(s)`,
      "Malformed observations are evidence only and cannot enter the resolver feed."
    ),
    buildInvariant(
      "empty-capture-keeps-effects-disabled",
      capture.exists || (observedMatches.length === 0 && p1Matches.length === 0 && executableRows.length === 0),
      `exists=${capture.exists ? "yes" : "no"}, observed=${observedMatches.length}, p1Matches=${p1Matches.length}, executable=${executableRows.length}`,
      "A missing capture file must preserve the current no-effects behavior."
    ),
    buildInvariant(
      "captured-return0-still-frontier-gated",
      executableRows.length === 0,
      `${directRows.length} direct observed row(s), ${executableRows.length} executable row(s)`,
      "Even real return-0 rows must pass the direct-case frontier before visible effects can be enabled."
    ),
  ];
  const failures = invariants.filter((item) => !item.passed);
  const hasDirect = executableRows.length > 0;
  const status = failures.length
    ? "provider35c4-return0-capture-adapter-risk"
    : hasDirect
    ? "provider35c4-return0-capture-direct-frontier-observed"
    : observedMatches.length
    ? "provider35c4-return0-capture-adapter-observed"
    : "provider35c4-return0-capture-adapter-empty";
  return {
    schema: "nicai.cbe.provider35c4Return0CaptureAdapterProbe.v1",
    generatedAt: new Date().toISOString(),
    input,
    inputs: {
      captureFile,
      return0Priority: RETURN0_PRIORITY_JSON,
      promotionFrontier: PROMOTION_FRONTIER_JSON,
      capturePlan: CAPTURE_PLAN_JSON,
    },
    captureSchema: captureTemplate(comparePoint),
    captureSource: {
      path: capture.source,
      exists: capture.exists,
      loadStatus: capture.loadStatus,
      rawObservationCount: capture.rawObservationCount,
    },
    counts: {
      importedObservationCount: observations.length,
      invalidObservationCount: invalidObservations.length,
      return0ObservationCount: return0Observations.length,
      nonMatchObservationCount: nonMatchObservations.length,
      observedFeedRowCount: observedMatches.length,
      p1PriorityRowCount: p1Rows.length,
      p1MatchedCount: p1Matches.length,
      modeScanMatchedCount: modeMatches.length,
      directCaseObservedCount: directRows.length,
      executableObservedCount: executableRows.length,
    },
    observations: observations.slice(0, 64),
    observedMatches,
    p1Replays,
    modeScanMatches: modeMatches.slice(0, 64),
    invariants,
    summary: {
      status,
      currentFinding: capture.exists
        ? `Imported ${observations.length} provider return observation(s): ${observedMatches.length} return-0 feed row(s), ${p1Matches.length} P1 match(es), and ${executableRows.length} executable row(s).`
        : "No provider return observation file is present yet; the real-capture adapter is ready and keeps the observed feed empty.",
      emulatorImpact: "This replaces synthetic return-0 injection with a real observation import boundary while preserving the rule that captured matches still need direct-case promotion before visible effects.",
      nextTarget: capture.exists
        ? "Re-run selected feed and promotion frontier using the imported provider observations, then promote only rows that reach direct-case execution gates."
        : `Write native/provider observations to ${captureFile}, then re-run this adapter before replacing the synthetic P1 injection.`,
      visibleEffectsEnabled: false,
      failureCount: failures.length,
      importedObservationCount: observations.length,
      observedFeedRowCount: observedMatches.length,
      p1MatchedCount: p1Matches.length,
      modeScanMatchedCount: modeMatches.length,
      directCaseObservedCount: directRows.length,
      executableObservedCount: executableRows.length,
    },
  };
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# Provider 0x35C4 Return-0 Capture Adapter Probe");
  lines.push("");
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Input CBE: \`${report.input}\``);
  lines.push(`- Capture file: \`${report.captureSource.path}\``);
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
  lines.push("## Capture Schema");
  lines.push("");
  lines.push("- Feed point: `provider35c4-label-ref-compare-1` at `0x0001233C`");
  lines.push("- Required feed fields: `capturePointId`, `site`, `label`, `providerRefId`, `returnValue`");
  lines.push("- Feed rule: only rows with `returnValue === 0` and a known `label + providerRefId` become resolver observations.");
  lines.push("");
  lines.push("## P1 Replay");
  lines.push("");
  lines.push(mdRow(["#", "Script", "Policy", "Entry", "Label", "Provider ref", "Resolver", "Frontier", "Direct"]));
  lines.push(mdRow(["---:", "---", "---", "---:", "---", "---", "---:", "---", "---"]));
  for (const row of report.p1Replays) {
    lines.push(mdRow([row.priority, row.script, row.policy, row.entryIndex, row.label, row.providerRefId, row.resolverReturnValue, row.frontierStatus, row.directCaseIfObserved ? "yes" : "no"]));
  }
  if (!report.p1Replays.length) lines.push("- No P1 rows are available.");
  lines.push("");
  lines.push("## Observed Matches");
  lines.push("");
  if (report.observedMatches.length) {
    lines.push(mdRow(["Import", "Script", "Policy", "Label", "Provider ref", "Return"]));
    lines.push(mdRow(["---:", "---", "---", "---", "---", "---:"]));
    for (const row of report.observedMatches) {
      lines.push(mdRow([row.importSeq, row.script, row.policy, row.label, row.providerRefId, row.returnValue]));
    }
  } else {
    lines.push("- No captured return-0 observations are available yet.");
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
  const captureFile = process.argv[4] ? path.resolve(process.argv[4]) : DEFAULT_CAPTURE_JSON;
  fs.mkdirSync(outDir, { recursive: true });
  const report = buildReport({ input, captureFile });
  const jsonFile = path.join(outDir, "provider35c4_return0_capture_adapter_probe.json");
  const mdFile = path.join(outDir, "provider35c4_return0_capture_adapter_probe.md");
  const templateFile = path.join(outDir, "provider35c4_return0_observations.template.json");
  fs.writeFileSync(jsonFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  fs.writeFileSync(mdFile, renderMarkdown(report), "utf8");
  fs.writeFileSync(templateFile, `${JSON.stringify(report.captureSchema, null, 2)}\n`, "utf8");
  console.log(`wrote ${jsonFile}`);
  console.log(`wrote ${mdFile}`);
  console.log(`wrote ${templateFile}`);
  console.log(`${report.summary.status}: ${report.summary.currentFinding}`);
}

if (require.main === module) {
  main();
}

module.exports = {
  buildReport,
  renderMarkdown,
};
