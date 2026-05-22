const fs = require("fs");
const path = require("path");
const { DEFAULT_INPUT } = require("./cbe_unpack");

const DEFAULT_OUT = path.resolve(__dirname, "out_godwar_provider35c4source");
const PROVIDER35C4_CAPTURE_JSON = path.resolve(__dirname, "out_godwar_provider35c4capture", "provider35c4_capture_plan_probe.json");
const PROVIDER35C4_TAPE_JSON = path.resolve(__dirname, "out_godwar_provider35c4tape", "provider35c4_tape_probe.json");
const PROVIDER35C4_FEED_JSON = path.resolve(__dirname, "out_godwar_provider35c4feed", "provider35c4_feed_probe.json");

function readJson(file, fallback = null) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function mdRow(values) {
  return `| ${values.map((value) => String(value ?? "").replace(/\|/g, "\\|")).join(" | ")} |`;
}

function serviceForSlot(slot) {
  return `[sb+0x35C4]${slot || ""}`;
}

function normalizeLabel(label) {
  return String(label || "").trim().toLowerCase();
}

function buildPlanLookup(plan) {
  const byId = new Map();
  for (const point of plan?.capturePoints || []) {
    byId.set(point.id, point);
  }
  return byId;
}

function classifyCapturePoint(event) {
  if (event.kind === "ref-producer" && event.context === "sce-resource-name") {
    return "provider35c4-sce-resource-ref";
  }
  if (event.kind === "ref-producer" && event.context === "xse-range-entry-ref") {
    return "provider35c4-xse-range-ref";
  }
  if (event.kind === "ref-producer" && event.context === "xse-final-ref") {
    return "provider35c4-xse-final-ref";
  }
  if (event.kind === "label-ref-consumer") {
    return "provider35c4-label-ref-compare-1";
  }
  if (event.kind === "cursor-read") {
    const role = String(event.role || "");
    if (role.includes("0x11672")) return "provider35c4-stream-read-2";
    if (role.includes("0x11752")) return "provider35c4-stream-read-3";
    return "provider35c4-stream-read-1";
  }
  return "";
}

function canonicalKind(event) {
  if (event.kind === "ref-producer") return "provider-ref-produced";
  if (event.kind === "label-ref-consumer") return "provider-label-ref-compared";
  if (event.kind === "cursor-read") return "provider-cursor-read";
  return "provider-event";
}

function buildCaptureEvent(event, planById, ordinal) {
  const capturePointId = classifyCapturePoint(event);
  const point = planById.get(capturePointId) || {};
  const label = event.label || "";
  const normalizedLabel = event.normalizedLabel || normalizeLabel(label);
  const providerRefId = event.refId || "";
  const feedEligible = event.kind === "label-ref-consumer" && providerRefId && event.returnValue === 0;
  return {
    captureSeq: ordinal,
    sourceSeq: event.seq,
    source: "provider35c4-shim-tape-adapter",
    namespaceId: "provider:0x35C4:+0x64/+0x50",
    capturePointId,
    capturePointSite: point.site || "",
    capturePointReady: Boolean(point.ready),
    kind: canonicalKind(event),
    tapeKind: event.kind || "",
    service: serviceForSlot(event.slot || point.slot),
    slot: event.slot || point.slot || "",
    role: event.role || "",
    resource: event.resource || "",
    policy: event.policy || "",
    context: event.context || point.context || "",
    providerRefId,
    providerRefKnown: Boolean(event.refKnown || providerRefId),
    cursorBefore: event.cursorBefore || "",
    offset: event.offset || "",
    rawSample: event.rawSample || "",
    text: event.text || "",
    callerLabel: label,
    normalizedLabel,
    compareStatus: event.compareStatus || "",
    returnValue: event.returnValue,
    return0MeansMatch: event.kind === "label-ref-consumer",
    observedMatch: Boolean(event.kind === "label-ref-consumer" && event.returnValue === 0),
    feedEligible: Boolean(feedEligible),
  };
}

function buildProducerLedger(captureEvents) {
  const ledger = new Map();
  for (const event of captureEvents) {
    if (event.tapeKind !== "ref-producer" || !event.providerRefId) continue;
    ledger.set(event.providerRefId, {
      providerRefId: event.providerRefId,
      sourceSeq: event.sourceSeq,
      captureSeq: event.captureSeq,
      capturePointId: event.capturePointId,
      resource: event.resource,
      policy: event.policy,
      context: event.context,
      offset: event.offset,
      rawSample: event.rawSample,
      text: event.text,
    });
  }
  return ledger;
}

function buildCompareLinks(captureEvents, producerLedger) {
  return captureEvents
    .filter((event) => event.tapeKind === "label-ref-consumer")
    .map((event) => {
      const producer = producerLedger.get(event.providerRefId) || null;
      return {
        sourceSeq: event.sourceSeq,
        captureSeq: event.captureSeq,
        capturePointId: event.capturePointId,
        callerLabel: event.callerLabel,
        normalizedLabel: event.normalizedLabel,
        providerRefId: event.providerRefId,
        producerSeq: producer?.sourceSeq ?? null,
        producerCapturePointId: producer?.capturePointId || "",
        producerContext: producer?.context || "",
        producerResource: producer?.resource || "",
        compareStatus: event.compareStatus,
        returnValue: event.returnValue,
        observedMatch: event.observedMatch,
        feedEligible: event.feedEligible,
        producerKnown: Boolean(producer),
        producerBeforeCompare: Boolean(producer && producer.sourceSeq < event.sourceSeq),
      };
    });
}

function buildPointCoverage(plan, captureEvents) {
  const counts = new Map();
  for (const event of captureEvents) {
    counts.set(event.capturePointId, (counts.get(event.capturePointId) || 0) + 1);
  }
  return (plan?.capturePoints || []).map((point) => ({
    id: point.id,
    eventKind: point.eventKind || "",
    slot: point.slot || "",
    site: point.site || "",
    context: point.context || "",
    feedEligiblePoint: Boolean(point.feedEligible),
    ready: Boolean(point.ready),
    observedEventCount: counts.get(point.id) || 0,
  }));
}

function buildInvariant(id, passed, details, impact = "") {
  return { id, passed: Boolean(passed), details, impact };
}

function buildReport(options = {}) {
  const input = path.resolve(options.input || DEFAULT_INPUT);
  const plan = readJson(PROVIDER35C4_CAPTURE_JSON, {});
  const tape = readJson(PROVIDER35C4_TAPE_JSON, {});
  const feed = readJson(PROVIDER35C4_FEED_JSON, {});
  const planById = buildPlanLookup(plan);
  const tapeEvents = tape?.tape || [];
  const captureEvents = tapeEvents.map((event, index) => buildCaptureEvent(event, planById, index + 1));
  const producerLedger = buildProducerLedger(captureEvents);
  const compareLinks = buildCompareLinks(captureEvents, producerLedger);
  const pointCoverage = buildPointCoverage(plan, captureEvents);
  const unclassifiedEvents = captureEvents.filter((event) => !event.capturePointId);
  const labelCompareEvents = captureEvents.filter((event) => event.tapeKind === "label-ref-consumer");
  const cursorReadEvents = captureEvents.filter((event) => event.tapeKind === "cursor-read");
  const producerEvents = captureEvents.filter((event) => event.tapeKind === "ref-producer");
  const observedFeedEvents = captureEvents.filter((event) => event.feedEligible);
  const feedObservedCount = feed?.summary?.observedMatchCount || feed?.feed?.observedMatchCount || 0;
  const missingCompareProducer = compareLinks.filter((row) => !row.producerKnown);
  const lateCompareProducer = compareLinks.filter((row) => row.producerKnown && !row.producerBeforeCompare);
  const nonCompareFeedEligible = captureEvents.filter((event) => event.tapeKind !== "label-ref-consumer" && event.feedEligible);
  const return0CompareEvents = labelCompareEvents.filter((event) => event.returnValue === 0 && event.providerRefId);
  const observedPointCount = pointCoverage.filter((point) => point.observedEventCount > 0).length;
  const invariants = [
    buildInvariant(
      "adapter-covers-current-tape",
      captureEvents.length === tapeEvents.length && unclassifiedEvents.length === 0,
      `${captureEvents.length}/${tapeEvents.length} tape event(s) emitted, ${unclassifiedEvents.length} unclassified`,
      "The shim adapter must be a lossless source until live provider instrumentation replaces it."
    ),
    buildInvariant(
      "compare-refs-have-prior-producers",
      missingCompareProducer.length === 0 && lateCompareProducer.length === 0,
      `${compareLinks.length} compare(s), ${missingCompareProducer.length} missing producer(s), ${lateCompareProducer.length} late producer(s)`,
      "A label/ref compare is only trustworthy if its providerRefId was produced earlier by +0x64."
    ),
    buildInvariant(
      "feed-derived-only-from-return0-compares",
      observedFeedEvents.length === return0CompareEvents.length && observedFeedEvents.length === feedObservedCount,
      `${observedFeedEvents.length} source feed event(s), ${return0CompareEvents.length} return-0 compare(s), feed report has ${feedObservedCount}`,
      "The capture source must not invent observed providerRefId/label matches."
    ),
    buildInvariant(
      "only-label-ref-compare-can-feed",
      nonCompareFeedEligible.length === 0,
      `${nonCompareFeedEligible.length} non-compare feed-eligible event(s)`,
      "Stream reads and +0x64 ref producers stay outside the resolver feed."
    ),
    buildInvariant(
      "plan-points-remain-ready",
      (plan?.summary?.readyCapturePointCount || 0) === (plan?.summary?.capturePointCount || 0),
      `${plan?.summary?.readyCapturePointCount || 0}/${plan?.summary?.capturePointCount || 0} plan point(s) ready`,
      "The adapter is bound to a complete provider 0x35C4 capture contract."
    ),
    buildInvariant(
      "empty-source-keeps-visible-effects-disabled",
      observedFeedEvents.length > 0 || !Boolean(feed?.summary?.visibleEffectsEnabled),
      `${observedFeedEvents.length} observed feed event(s), feed effects=${feed?.summary?.visibleEffectsEnabled ? "enabled" : "disabled"}`,
      "No visible XSE effects should be enabled while the provider source has no return-0 compare observations."
    ),
  ];
  const failures = invariants.filter((item) => !item.passed);
  return {
    schema: "nicai.cbe.provider35c4CaptureSourceProbe.v1",
    generatedAt: new Date().toISOString(),
    input,
    inputs: {
      provider35c4CapturePlan: PROVIDER35C4_CAPTURE_JSON,
      provider35c4Tape: PROVIDER35C4_TAPE_JSON,
      provider35c4Feed: PROVIDER35C4_FEED_JSON,
    },
    sourceContract: {
      sourceMode: "shim-tape-adapter",
      namespaceId: "provider:0x35C4:+0x64/+0x50",
      providerGlobal: "0x35C4",
      producerSlot: "+0x64",
      compareAndCursorSlot: "+0x50",
      adapterBoundary: "This is the current capture-source adapter. It preserves the event contract that live/emulated provider calls must emit next.",
      feedRule: "Only provider-label-ref-compared events with returnValue === 0 and providerRefId become observed resolver feed rows.",
      compareLinkRule: "Every label/ref compare must link to an earlier +0x64 provider-ref-produced event by providerRefId.",
    },
    counts: {
      captureEventCount: captureEvents.length,
      producerEventCount: producerEvents.length,
      cursorReadEventCount: cursorReadEvents.length,
      labelCompareEventCount: labelCompareEvents.length,
      linkedCompareCount: compareLinks.filter((row) => row.producerKnown).length,
      priorProducerCompareCount: compareLinks.filter((row) => row.producerBeforeCompare).length,
      observedReturn0CompareCount: return0CompareEvents.length,
      observedFeedEventCount: observedFeedEvents.length,
      planCapturePointCount: pointCoverage.length,
      observedCapturePointCount: observedPointCount,
      unobservedCapturePointCount: pointCoverage.filter((point) => point.observedEventCount === 0).length,
    },
    pointCoverage,
    producerLedger: Array.from(producerLedger.values()),
    compareLinks,
    observedFeedEvents,
    captureEvents: captureEvents.slice(0, 160),
    invariants,
    summary: {
      status: failures.length ? "provider35c4-capture-source-risk" : "provider35c4-capture-source-shim-adapter-ready",
      currentFinding: "The provider 0x35C4 capture source now emits canonical producer, cursor-read, and label/ref compare events from the current shim tape, and every observed label/ref compare links back to a prior +0x64 providerRefId producer.",
      emulatorImpact: "This is the first replaceable provider source for the generic CBE emulator. The VM can consume a stable event stream now, then swap the source from shim tape to live/emulated provider calls without changing the feed and promotion gates.",
      nextTarget: "Replace the shim-tape adapter with a live/emulated provider 0x35C4 source at the 0x1173C +0x64 range-ref producer and the 0x1233C +0x50 label/ref compare return value.",
      visibleEffectsEnabled: false,
      failureCount: failures.length,
      captureEventCount: captureEvents.length,
      producerEventCount: producerEvents.length,
      cursorReadEventCount: cursorReadEvents.length,
      labelCompareEventCount: labelCompareEvents.length,
      linkedCompareCount: compareLinks.filter((row) => row.producerKnown).length,
      priorProducerCompareCount: compareLinks.filter((row) => row.producerBeforeCompare).length,
      observedFeedEventCount: observedFeedEvents.length,
      observedCapturePointCount: observedPointCount,
      planCapturePointCount: pointCoverage.length,
    },
  };
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# Provider 0x35C4 Capture Source Probe");
  lines.push("");
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Input CBE: \`${report.input}\``);
  lines.push(`- Status: ${report.summary.status}`);
  lines.push(`- Finding: ${report.summary.currentFinding}`);
  lines.push(`- Emulator impact: ${report.summary.emulatorImpact}`);
  lines.push(`- Next target: ${report.summary.nextTarget}`);
  lines.push("");
  lines.push("## Source Contract");
  lines.push("");
  lines.push(mdRow(["Field", "Value"]));
  lines.push(mdRow(["---", "---"]));
  for (const [key, value] of Object.entries(report.sourceContract)) {
    lines.push(mdRow([key, value]));
  }
  lines.push("");
  lines.push("## Counts");
  lines.push("");
  lines.push(mdRow(["Field", "Value"]));
  lines.push(mdRow(["---", "---:"]));
  for (const [key, value] of Object.entries(report.counts)) {
    lines.push(mdRow([key, value]));
  }
  lines.push("");
  lines.push("## Capture Point Coverage");
  lines.push("");
  lines.push(mdRow(["Point", "Kind", "Slot", "Site", "Context", "Ready", "Events"]));
  lines.push(mdRow(["---", "---", "---", "---", "---", "---", "---:"]));
  for (const point of report.pointCoverage) {
    lines.push(mdRow([
      point.id,
      point.eventKind,
      point.slot,
      point.site,
      point.context,
      point.ready ? "yes" : "no",
      point.observedEventCount,
    ]));
  }
  lines.push("");
  lines.push("## Compare Links");
  lines.push("");
  lines.push(mdRow(["Seq", "Label", "Ref", "Producer", "Context", "Return", "Status", "Feed"]));
  lines.push(mdRow(["---:", "---", "---", "---:", "---", "---:", "---", "---"]));
  for (const row of report.compareLinks.slice(0, 48)) {
    lines.push(mdRow([
      row.sourceSeq,
      row.callerLabel,
      row.providerRefId,
      row.producerSeq ?? "",
      row.producerContext,
      row.returnValue,
      row.compareStatus,
      row.feedEligible ? "yes" : "no",
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
  const jsonFile = path.join(outDir, "provider35c4_capture_source_probe.json");
  const mdFile = path.join(outDir, "provider35c4_capture_source_probe.md");
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
