const fs = require("fs");
const path = require("path");
const { DEFAULT_INPUT } = require("./cbe_unpack");
const { buildReport: buildEmulatedSourceReport } = require("./cbe_provider35c4_emulated_source_probe");
const { Provider35C4ServiceObject } = require("./cbe_provider35c4_service_object_probe");

const DEFAULT_OUT = path.resolve(__dirname, "out_godwar_provider35c4svcresolver");

function mdRow(values) {
  return `| ${values.map((value) => String(value ?? "").replace(/\|/g, "\\|")).join(" | ")} |`;
}

function normalizeLabel(label) {
  return String(label || "").trim().toLowerCase();
}

function replayUntil(captureEvents, targetEvent, observedMatches = []) {
  const service = new Provider35C4ServiceObject({ observedMatches });
  let result = null;
  for (const event of captureEvents) {
    if (event.sourceSeq > targetEvent.sourceSeq) break;
    result = service.replayEvent(event);
    if (event.sourceSeq === targetEvent.sourceSeq) break;
  }
  const op = service.operations[service.operations.length - 1] || {};
  return {
    returnValue: result,
    compareStatus: op.compareStatus || "",
    matched: Boolean(op.matched),
    refKnown: Boolean(op.refKnown),
    refProducerSeq: op.refProducerSeq ?? null,
    operation: op,
  };
}

function buildCheck(id, description, event, observedMatches, expectedReturnValue, captureEvents) {
  const replay = replayUntil(captureEvents, event, observedMatches);
  return {
    id,
    description,
    sourceSeq: event.sourceSeq,
    label: event.callerLabel || "",
    normalizedLabel: event.normalizedLabel || normalizeLabel(event.callerLabel),
    providerRefId: event.providerRefId || "",
    observedMatches: observedMatches.map((match) => ({
      label: match.label || "",
      normalizedLabel: match.normalizedLabel || normalizeLabel(match.label),
      providerRefId: match.providerRefId || "",
    })),
    expectedReturnValue,
    returnValue: replay.returnValue,
    matched: replay.matched,
    compareStatus: replay.compareStatus,
    refKnown: replay.refKnown,
    refProducerSeq: replay.refProducerSeq,
    passed: replay.returnValue === expectedReturnValue,
  };
}

function buildInvariant(id, passed, details, impact = "") {
  return { id, passed: Boolean(passed), details, impact };
}

function buildReport(options = {}) {
  const input = path.resolve(options.input || DEFAULT_INPUT);
  const emulatedSource = buildEmulatedSourceReport({ input });
  const captureEvents = emulatedSource.captureEvents || [];
  const compares = captureEvents.filter((event) => event.tapeKind === "label-ref-consumer" && event.providerRefId && event.callerLabel);
  const target = compares.find((event) => normalizeLabel(event.callerLabel) === "init") || compares[0] || null;
  const sameLabelWrongRef = target
    ? compares.find((event) => normalizeLabel(event.callerLabel) === normalizeLabel(target.callerLabel) && event.providerRefId !== target.providerRefId)
    : null;
  const wrongLabelSameRef = target
    ? compares.find((event) => normalizeLabel(event.callerLabel) !== normalizeLabel(target.callerLabel) && event.providerRefId === target.providerRefId)
    : null;
  const observedPair = target ? [{ label: target.callerLabel, normalizedLabel: target.normalizedLabel, providerRefId: target.providerRefId }] : [];
  const checks = [];
  if (target) {
    checks.push(buildCheck(
      "baseline-empty-feed-rejects-target",
      "The target pair must remain non-match while the observed feed is empty.",
      target,
      [],
      1,
      captureEvents,
    ));
    checks.push(buildCheck(
      "exact-observed-pair-returns-zero",
      "The exact observed label/providerRefId pair should produce the 0x12326 return-0 shape.",
      target,
      observedPair,
      0,
      captureEvents,
    ));
  }
  if (sameLabelWrongRef) {
    checks.push(buildCheck(
      "same-label-wrong-ref-rejects",
      "The same label with a different providerRefId must not inherit the observed match.",
      sameLabelWrongRef,
      observedPair,
      1,
      captureEvents,
    ));
  }
  if (wrongLabelSameRef) {
    checks.push(buildCheck(
      "wrong-label-same-ref-rejects",
      "A different label with the same providerRefId must not inherit the observed match.",
      wrongLabelSameRef,
      observedPair,
      1,
      captureEvents,
    ));
  }
  const failures = checks.filter((check) => !check.passed);
  const exactCheck = checks.find((check) => check.id === "exact-observed-pair-returns-zero");
  const baselineCheck = checks.find((check) => check.id === "baseline-empty-feed-rejects-target");
  const sameLabelCheck = checks.find((check) => check.id === "same-label-wrong-ref-rejects");
  const wrongLabelCheck = checks.find((check) => check.id === "wrong-label-same-ref-rejects");
  const invariants = [
    buildInvariant(
      "baseline-empty-feed-nonmatch",
      Boolean(baselineCheck?.passed),
      baselineCheck ? `${baselineCheck.label}/${baselineCheck.providerRefId}->${baselineCheck.returnValue}` : "no baseline check",
      "The service object must preserve current no-effects behavior when no observed provider matches are available."
    ),
    buildInvariant(
      "exact-observed-pair-only-returns-zero",
      Boolean(exactCheck?.passed),
      exactCheck ? `${exactCheck.label}/${exactCheck.providerRefId}->${exactCheck.returnValue}` : "no exact-pair check",
      "Future real provider observations should enter the service object as exact label/ref pairs."
    ),
    buildInvariant(
      "same-label-wrong-ref-rejected",
      !sameLabelCheck || sameLabelCheck.passed,
      sameLabelCheck ? `${sameLabelCheck.label}/${sameLabelCheck.providerRefId}->${sameLabelCheck.returnValue}` : "no alternate ref sample",
      "A label match alone cannot promote an entry."
    ),
    buildInvariant(
      "wrong-label-same-ref-rejected",
      !wrongLabelCheck || wrongLabelCheck.passed,
      wrongLabelCheck ? `${wrongLabelCheck.label}/${wrongLabelCheck.providerRefId}->${wrongLabelCheck.returnValue}` : "no alternate label sample",
      "A providerRefId match alone cannot promote an entry."
    ),
    buildInvariant(
      "synthetic-guard-keeps-production-feed-empty",
      (emulatedSource.summary?.observedFeedEventCount || 0) === 0,
      `${emulatedSource.summary?.observedFeedEventCount || 0} production observed feed event(s)`,
      "The guard check is synthetic and must not enable visible script effects."
    ),
  ];
  const invariantFailures = invariants.filter((item) => !item.passed);
  return {
    schema: "nicai.cbe.provider35c4ServiceResolverProbe.v1",
    generatedAt: new Date().toISOString(),
    input,
    inputs: {
      provider35c4EmulatedSource: "cbe_provider35c4_emulated_source_probe.buildReport({ input })",
      provider35c4ServiceObject: "Provider35C4ServiceObject",
    },
    targetPair: target ? {
      sourceSeq: target.sourceSeq,
      label: target.callerLabel,
      normalizedLabel: target.normalizedLabel,
      providerRefId: target.providerRefId,
      producerSeq: (emulatedSource.compareLinks || []).find((link) => link.sourceSeq === target.sourceSeq)?.producerSeq ?? null,
    } : null,
    checks,
    invariants,
    summary: {
      status: invariantFailures.length || failures.length ? "provider35c4-service-resolver-risk" : "provider35c4-service-resolver-guarded",
      currentFinding: "The provider 0x35C4 service object resolver gate now accepts only exact observed label/providerRefId pairs and rejects empty-feed, same-label/wrong-ref, and wrong-label/same-ref cases.",
      emulatorImpact: "This preserves the generic emulator safety boundary for future real provider observations: return-0 compare rows can be injected, but label-only or ref-only coincidences still cannot enable visible XSE effects.",
      nextTarget: "Replace the synthetic observed-pair guard with real resolver observations from the provider +0x50 implementation, then feed only those return-0 rows into entry promotion.",
      visibleEffectsEnabled: false,
      failureCount: invariantFailures.length + failures.length,
      checkCount: checks.length,
      passedCheckCount: checks.filter((check) => check.passed).length,
      exactObservedPairMatches: Boolean(exactCheck?.passed && exactCheck.returnValue === 0),
      sameLabelWrongRefMatches: Boolean(sameLabelCheck && sameLabelCheck.returnValue === 0),
      wrongLabelSameRefMatches: Boolean(wrongLabelCheck && wrongLabelCheck.returnValue === 0),
      productionObservedFeedCount: emulatedSource.summary?.observedFeedEventCount || 0,
    },
  };
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# Provider 0x35C4 Service Resolver Probe");
  lines.push("");
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Input CBE: \`${report.input}\``);
  lines.push(`- Status: ${report.summary.status}`);
  lines.push(`- Finding: ${report.summary.currentFinding}`);
  lines.push(`- Emulator impact: ${report.summary.emulatorImpact}`);
  lines.push(`- Next target: ${report.summary.nextTarget}`);
  lines.push("");
  if (report.targetPair) {
    lines.push("## Target Pair");
    lines.push("");
    lines.push(mdRow(["Field", "Value"]));
    lines.push(mdRow(["---", "---"]));
    for (const [key, value] of Object.entries(report.targetPair)) lines.push(mdRow([key, value]));
    lines.push("");
  }
  lines.push("## Checks");
  lines.push("");
  lines.push(mdRow(["Check", "Label", "Ref", "Return", "Expected", "Pass", "Status"]));
  lines.push(mdRow(["---", "---", "---", "---:", "---:", "---", "---"]));
  for (const check of report.checks) {
    lines.push(mdRow([
      check.id,
      check.label,
      check.providerRefId,
      check.returnValue,
      check.expectedReturnValue,
      check.passed ? "yes" : "no",
      check.compareStatus,
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
  const jsonFile = path.join(outDir, "provider35c4_service_resolver_probe.json");
  const mdFile = path.join(outDir, "provider35c4_service_resolver_probe.md");
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
