const fs = require("fs");
const path = require("path");
const { DEFAULT_INPUT } = require("./cbe_unpack");

const DEFAULT_OUT = path.resolve(__dirname, "out_godwar_provider35c4capture");
const COMPARE_ABI_JSON = path.resolve(__dirname, "out_godwar_xsecompareabi", "xse_compare_abi_probe.json");
const REF64_LOADER_JSON = path.resolve(__dirname, "out_godwar_xseref64loader", "xse_ref64_loader_probe.json");
const PROVIDER35C4_TAPE_JSON = path.resolve(__dirname, "out_godwar_provider35c4tape", "provider35c4_tape_probe.json");
const PROVIDER35C4_FEED_JSON = path.resolve(__dirname, "out_godwar_provider35c4feed", "provider35c4_feed_probe.json");
const COMPARE_RESOLVER_JSON = path.resolve(__dirname, "out_godwar_xsecompareresolver", "xse_compare_resolver_boundary_probe.json");

function readJson(file, fallback = null) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function mdRow(values) {
  return `| ${values.map((value) => String(value ?? "").replace(/\|/g, "\\|")).join(" | ")} |`;
}

function captureFields(kind) {
  if (kind === "ref-producer") {
    return ["seq", "service", "slot", "resource", "policy", "context", "providerRefId", "cursorBefore", "offset", "rawSample", "text"];
  }
  if (kind === "label-ref-consumer") {
    return ["seq", "service", "slot", "callerLabel", "normalizedLabel", "providerRefId", "refContext", "refResource", "returnValue", "compareStatus"];
  }
  return ["seq", "service", "slot", "resource", "policy", "cursorBefore", "offset", "raw", "value", "nextCursor"];
}

function findTapeSample(tape, predicate) {
  return (tape?.tape || []).find(predicate) || null;
}

function buildCapturePoint(point) {
  const requiredFields = captureFields(point.eventKind);
  const missingEvidence = [];
  if (!point.site && point.codeSiteRequired) missingEvidence.push("site");
  if (!point.slot) missingEvidence.push("slot");
  if (!point.argumentShape) missingEvidence.push("argumentShape");
  if (point.requiresProviderRef && !point.providerRefIdentity) missingEvidence.push("providerRefIdentity");
  return {
    ...point,
    requiredFields,
    missingEvidence,
    ready: missingEvidence.length === 0,
  };
}

function buildInvariant(id, passed, details, impact = "") {
  return { id, passed: Boolean(passed), details, impact };
}

function buildReport(options = {}) {
  const input = path.resolve(options.input || DEFAULT_INPUT);
  const compareAbi = readJson(COMPARE_ABI_JSON, {});
  const ref64Loader = readJson(REF64_LOADER_JSON, {});
  const tape = readJson(PROVIDER35C4_TAPE_JSON, {});
  const feed = readJson(PROVIDER35C4_FEED_JSON, {});
  const compareResolver = readJson(COMPARE_RESOLVER_JSON, {});
  const streamSites = compareAbi?.branchContract?.streamCursorRead?.sites || [];
  const compareSites = compareAbi?.branchContract?.labelRefCompare?.sites || [];
  const rangeProducerSample = findTapeSample(tape, (event) => event.kind === "ref-producer" && event.context === "xse-range-entry-ref");
  const finalProducerSample = findTapeSample(tape, (event) => event.kind === "ref-producer" && event.context === "xse-final-ref");
  const sceProducerSample = findTapeSample(tape, (event) => event.kind === "ref-producer" && event.context === "sce-resource-name");
  const compareSample = findTapeSample(tape, (event) => event.kind === "label-ref-consumer" && event.refId);
  const capturePoints = [
    buildCapturePoint({
      id: "provider35c4-sce-resource-ref",
      eventKind: "ref-producer",
      service: "[sb+0x35C4]+0x64",
      slot: "+0x64",
      site: sceProducerSample?.seq != null ? `shim-event-${sceProducerSample.seq}` : "",
      codeSiteRequired: false,
      context: "sce-resource-name",
      argumentShape: "resource stream cursor -> length-prefixed resource-name text",
      providerRefIdentity: Boolean(sceProducerSample?.refId),
      requiresProviderRef: true,
      currentEvidence: sceProducerSample ? `${sceProducerSample.resource}@${sceProducerSample.offset || "-"} -> ${sceProducerSample.refId}` : "no current tape sample",
      capturePurpose: "Keep SCE resource-name reads in the text-safe lane and out of XSE label/ref compare feed.",
      feedEligible: false,
    }),
    buildCapturePoint({
      id: "provider35c4-xse-range-ref",
      eventKind: "ref-producer",
      service: "[sb+0x35C4]+0x64",
      slot: "+0x64",
      site: ref64Loader?.summary?.rangeRefCallSite || "0x0001173C",
      codeSiteRequired: true,
      context: "xse-range-entry-ref",
      argumentShape: "0x11672 range loader stores provider return at script+0x64 record+0x10",
      providerRefIdentity: Boolean(rangeProducerSample?.refId),
      requiresProviderRef: true,
      currentEvidence: rangeProducerSample ? `${rangeProducerSample.resource}@${rangeProducerSample.offset || "-"} -> ${rangeProducerSample.refId}` : "no current tape sample",
      capturePurpose: "Create stable providerRefId values for later 0x12326 label/ref compares.",
      feedEligible: false,
    }),
    buildCapturePoint({
      id: "provider35c4-xse-final-ref",
      eventKind: "ref-producer",
      service: "[sb+0x35C4]+0x64",
      slot: "+0x64",
      site: ref64Loader?.summary?.finalRefCallSite || "0x00011792",
      codeSiteRequired: true,
      context: "xse-final-ref",
      argumentShape: "0x11752 final-ref table reads provider refs through +0x64",
      providerRefIdentity: Boolean(finalProducerSample?.refId) || Boolean(ref64Loader?.summary?.finalRefCallSite),
      requiresProviderRef: true,
      currentEvidence: finalProducerSample ? `${finalProducerSample.resource}@${finalProducerSample.offset || "-"} -> ${finalProducerSample.refId}` : "site known; no current tape sample",
      capturePurpose: "Preserve non-entry XSE refs as provider-opaque handles, not SCE text.",
      feedEligible: false,
    }),
    ...streamSites.map((site, index) => buildCapturePoint({
      id: `provider35c4-stream-read-${index + 1}`,
      eventKind: "cursor-read",
      service: "[sb+0x35C4]+0x50",
      slot: site.slot || "+0x50",
      site: site.site || "",
      codeSiteRequired: true,
      context: "stream-cursor-read",
      argumentShape: site.shape || "r0=converted stream, r1=&cursor",
      providerRefIdentity: true,
      requiresProviderRef: false,
      currentEvidence: `${site.name || "stream read"}; return0Match=${site.return0Match ? "yes" : "no"}`,
      capturePurpose: "Keep numeric/cursor reads separated from label/ref compare events in the same +0x50 slot.",
      feedEligible: false,
    })),
    ...compareSites.map((site, index) => buildCapturePoint({
      id: `provider35c4-label-ref-compare-${index + 1}`,
      eventKind: "label-ref-consumer",
      service: "[sb+0x35C4]+0x50",
      slot: site.slot || "+0x50",
      site: site.site || "0x0001233C",
      codeSiteRequired: true,
      context: "xse-range-entry-ref",
      argumentShape: site.shape || "r0=caller label pointer, r1=script+0x64 record+0x10",
      providerRefIdentity: Boolean(compareSample?.refId),
      requiresProviderRef: true,
      currentEvidence: compareSample ? `${compareSample.label}/${compareSample.refId} -> ${compareSample.returnValue}` : "no current compare sample",
      capturePurpose: "Only this branch may produce observed providerRefId/label return-0 feed rows.",
      feedEligible: true,
      return0MeansMatch: Boolean(site.return0Match),
    })),
  ];
  const readyCapturePoints = capturePoints.filter((point) => point.ready);
  const feedEligiblePoints = capturePoints.filter((point) => point.feedEligible);
  const captureSchema = {
    namespaceId: tape?.namespace?.namespaceId || "provider:0x35C4:+0x64/+0x50",
    eventKinds: ["ref-producer", "cursor-read", "label-ref-consumer"],
    observedFeedRule: "Only label-ref-consumer events with returnValue === 0 and a known providerRefId become resolver feed rows.",
    promotionRule: "Feed matches are necessary but not sufficient; activation, dispatch, and writeback safety must still pass.",
    requiredLabelRefCompareFields: captureFields("label-ref-consumer"),
  };
  const feedEmpty = (feed?.summary?.observedMatchCount || 0) === 0 && (feed?.summary?.resolverMatchedCount || 0) === 0;
  const invariants = [
    buildInvariant(
      "label-ref-compare-site-return0",
      compareSites.length > 0 && compareSites.every((site) => site.return0Match),
      `${compareSites.length} label/ref compare site(s), ${compareSites.filter((site) => site.return0Match).length} return-0 match site(s)`,
      "The capture source must know which +0x50 branch can feed resolver matches."
    ),
    buildInvariant(
      "stream-and-compare-branches-separated",
      streamSites.length > 0 && compareSites.length > 0,
      `${streamSites.length} stream/cursor read site(s), ${compareSites.length} label/ref compare site(s)`,
      "The same +0x50 slot must not collapse stream reads into label/ref compare observations."
    ),
    buildInvariant(
      "range-ref-producer-site-known",
      Boolean(ref64Loader?.summary?.rangeRefCallSite),
      `rangeRefCallSite=${ref64Loader?.summary?.rangeRefCallSite || ""}`,
      "The compare refId producer must be instrumented before the compare consumer can be trusted."
    ),
    buildInvariant(
      "feed-empty-keeps-promotions-zero",
      feedEmpty && (feed?.summary?.promotionEligibleCount || 0) === 0,
      `${feed?.summary?.observedMatchCount || 0} observed match(es), ${feed?.summary?.promotionEligibleCount || 0} promotion candidate(s)`,
      "The capture plan preserves the current no-fake-effects rule."
    ),
    buildInvariant(
      "capture-points-ready",
      readyCapturePoints.length === capturePoints.length,
      `${readyCapturePoints.length}/${capturePoints.length} capture point(s) have the required evidence fields`,
      "The next implementation can target a concrete event contract instead of another scalar/string ref guess."
    ),
  ];
  const failures = invariants.filter((item) => !item.passed);
  return {
    schema: "nicai.cbe.provider35c4CapturePlanProbe.v1",
    generatedAt: new Date().toISOString(),
    input,
    inputs: {
      compareAbi: COMPARE_ABI_JSON,
      ref64Loader: REF64_LOADER_JSON,
      provider35c4Tape: PROVIDER35C4_TAPE_JSON,
      provider35c4Feed: PROVIDER35C4_FEED_JSON,
      compareResolver: COMPARE_RESOLVER_JSON,
    },
    serviceOrigin: {
      providerReaderGlobal: compareResolver?.summary?.providerReaderGlobal || "0x35C4",
      providerReaderMethod: compareResolver?.summary?.providerReaderMethod || "providerApi+0x64",
      compareSlot: compareResolver?.summary?.compareSlot || "+0x50",
      resolverBoundaryStatus: compareResolver?.summary?.status || "",
      staticCbeCompareTargetKnown: Boolean(compareResolver?.boundary?.staticCbeCompareTargetKnown),
    },
    captureSchema,
    capturePoints,
    currentTape: {
      status: tape?.summary?.status || "",
      providerEventCount: tape?.summary?.providerEventCount || 0,
      producerEventCount: tape?.summary?.producerEventCount || 0,
      cursorReadEventCount: tape?.summary?.cursorReadEventCount || 0,
      labelCompareEventCount: tape?.summary?.labelCompareEventCount || 0,
      observedReturn0CompareCount: tape?.summary?.observedReturn0CompareCount || 0,
    },
    currentFeed: {
      status: feed?.summary?.status || "",
      observedMatchCount: feed?.summary?.observedMatchCount || 0,
      resolverReplayCount: feed?.summary?.resolverReplayCount || 0,
      resolverMatchedCount: feed?.summary?.resolverMatchedCount || 0,
      promotionEligibleCount: feed?.summary?.promotionEligibleCount || 0,
      entrySafetyPromotableCount: feed?.summary?.entrySafetyPromotableCount || 0,
    },
    invariants,
    summary: {
      status: failures.length ? "provider35c4-capture-plan-risk" : "provider35c4-capture-plan-ready",
      currentFinding: "The provider 0x35C4 capture plan now has concrete producer, cursor-read, and label/ref compare capture points, with a feed rule that only accepts +0x50 return-0 providerRefId/label observations.",
      emulatorImpact: "This is the implementation contract for replacing shim-derived evidence with real or emulated provider observations. It keeps stream reads, opaque refs, and label/ref compares separate, and it still leaves visible effects disabled while the feed is empty.",
      nextTarget: "Implement the capture source for these provider 0x35C4 points, starting with the 0x1173C +0x64 range-ref producer and the 0x1233C +0x50 label/ref compare return value.",
      visibleEffectsEnabled: false,
      failureCount: failures.length,
      capturePointCount: capturePoints.length,
      readyCapturePointCount: readyCapturePoints.length,
      feedEligibleCapturePointCount: feedEligiblePoints.length,
      observedMatchCount: feed?.summary?.observedMatchCount || 0,
      promotionEligibleCount: feed?.summary?.promotionEligibleCount || 0,
    },
  };
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# Provider 0x35C4 Capture Plan Probe");
  lines.push("");
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Input CBE: \`${report.input}\``);
  lines.push(`- Status: ${report.summary.status}`);
  lines.push(`- Finding: ${report.summary.currentFinding}`);
  lines.push(`- Emulator impact: ${report.summary.emulatorImpact}`);
  lines.push(`- Next target: ${report.summary.nextTarget}`);
  lines.push("");
  lines.push("## Service Origin");
  lines.push("");
  lines.push(mdRow(["Field", "Value"]));
  lines.push(mdRow(["---", "---"]));
  for (const [key, value] of Object.entries(report.serviceOrigin)) {
    lines.push(mdRow([key, value]));
  }
  lines.push("");
  lines.push("## Capture Points");
  lines.push("");
  lines.push(mdRow(["Point", "Kind", "Slot", "Site", "Context", "Feed", "Ready", "Evidence"]));
  lines.push(mdRow(["---", "---", "---", "---", "---", "---", "---", "---"]));
  for (const point of report.capturePoints) {
    lines.push(mdRow([
      point.id,
      point.eventKind,
      point.slot,
      point.site,
      point.context,
      point.feedEligible ? "yes" : "no",
      point.ready ? "yes" : "no",
      point.currentEvidence,
    ]));
  }
  lines.push("");
  lines.push("## Feed Contract");
  lines.push("");
  lines.push(`- Namespace: ${report.captureSchema.namespaceId}`);
  lines.push(`- Observed feed rule: ${report.captureSchema.observedFeedRule}`);
  lines.push(`- Promotion rule: ${report.captureSchema.promotionRule}`);
  lines.push(`- Required label/ref fields: ${report.captureSchema.requiredLabelRefCompareFields.join(", ")}`);
  lines.push("");
  lines.push("## Current State");
  lines.push("");
  lines.push(mdRow(["Metric", "Value"]));
  lines.push(mdRow(["---", "---:"]));
  for (const [key, value] of Object.entries(report.currentTape)) lines.push(mdRow([`tape.${key}`, value]));
  for (const [key, value] of Object.entries(report.currentFeed)) lines.push(mdRow([`feed.${key}`, value]));
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
  const jsonFile = path.join(outDir, "provider35c4_capture_plan_probe.json");
  const mdFile = path.join(outDir, "provider35c4_capture_plan_probe.md");
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
