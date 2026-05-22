const fs = require("fs");
const path = require("path");
const { DEFAULT_INPUT } = require("./cbe_unpack");
const { buildReport: buildProviderAbiShimReport } = require("./cbe_provider_abi_shim_probe");

const DEFAULT_OUT = path.resolve(__dirname, "out_godwar_provider35c4emu");
const PROVIDER35C4_CAPTURE_JSON = path.resolve(__dirname, "out_godwar_provider35c4capture", "provider35c4_capture_plan_probe.json");
const PROVIDER35C4_SOURCE_JSON = path.resolve(__dirname, "out_godwar_provider35c4source", "provider35c4_capture_source_probe.json");

function readJson(file, fallback = null) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function mdRow(values) {
  return `| ${values.map((value) => String(value ?? "").replace(/\|/g, "\\|")).join(" | ")} |`;
}

function normalizeLabel(label) {
  return String(label || "").trim().toLowerCase();
}

function buildPlanLookup(plan) {
  const byId = new Map();
  for (const point of plan?.capturePoints || []) byId.set(point.id, point);
  return byId;
}

function classifyCapturePoint(event, tapeKind) {
  const context = event.refContext || event.entryRef?.context || "";
  if (tapeKind === "ref-producer" && context === "sce-resource-name") return "provider35c4-sce-resource-ref";
  if (tapeKind === "ref-producer" && context === "xse-range-entry-ref") return "provider35c4-xse-range-ref";
  if (tapeKind === "ref-producer" && context === "xse-final-ref") return "provider35c4-xse-final-ref";
  if (tapeKind === "label-ref-consumer") return "provider35c4-label-ref-compare-1";
  if (tapeKind === "cursor-read") {
    const role = String(event.role || "");
    if (role.includes("0x11672")) return "provider35c4-stream-read-2";
    if (role.includes("0x11752")) return "provider35c4-stream-read-3";
    return "provider35c4-stream-read-1";
  }
  return "";
}

function canonicalKind(tapeKind) {
  if (tapeKind === "ref-producer") return "provider-ref-produced";
  if (tapeKind === "label-ref-consumer") return "provider-label-ref-compared";
  if (tapeKind === "cursor-read") return "provider-cursor-read";
  return "provider-event";
}

function capturedKind(event) {
  if (event.service !== "[sb+0x35C4]+0x64" && event.service !== "[sb+0x35C4]+0x50") return "";
  if (event.method === "+0x64") return "ref-producer";
  if (event.method === "+0x50" && (event.callerLabel || event.entryRef || event.providerRefId)) return "label-ref-consumer";
  if (event.method === "+0x50") return "cursor-read";
  return "";
}

function toCaptureEvent(event, planById, ordinal) {
  const tapeKind = capturedKind(event);
  const capturePointId = classifyCapturePoint(event, tapeKind);
  const point = planById.get(capturePointId) || {};
  const label = event.callerLabel || "";
  const normalizedLabel = event.normalizedLabel || normalizeLabel(label);
  const entryRef = event.entryRef || {};
  const providerRefId = event.providerRefId || entryRef.providerRefId || "";
  const context = event.refContext || entryRef.context || point.context || "";
  const cursorBefore = event.cursorBeforeHex || entryRef.cursorBefore || "";
  const offset = event.offset || entryRef.offset || "";
  const rawSample = event.rawSample || entryRef.rawSample || event.raw || "";
  const feedEligible = tapeKind === "label-ref-consumer" && providerRefId && event.returnValue === 0;
  return {
    captureSeq: ordinal,
    sourceSeq: event.index,
    source: "provider35c4-abi-shim-emulated-source",
    namespaceId: "provider:0x35C4:+0x64/+0x50",
    capturePointId,
    capturePointSite: point.site || "",
    capturePointReady: Boolean(point.ready),
    kind: canonicalKind(tapeKind),
    tapeKind,
    service: event.service || "",
    slot: event.method || point.slot || "",
    role: event.role || "",
    resource: event.resource || entryRef.resource || "",
    policy: event.policy || entryRef.policy || "",
    context,
    providerRefId,
    providerRefKnown: Boolean(providerRefId),
    cursorBefore,
    offset,
    rawSample,
    text: event.text || "",
    value: event.value,
    nextCursor: event.nextCursorHex || "",
    callerLabel: label,
    normalizedLabel,
    compareStatus: event.compareStatus || "",
    returnValue: event.returnValue,
    return0MeansMatch: tapeKind === "label-ref-consumer",
    observedMatch: Boolean(tapeKind === "label-ref-consumer" && event.returnValue === 0),
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
  for (const event of captureEvents) counts.set(event.capturePointId, (counts.get(event.capturePointId) || 0) + 1);
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

function signature(events) {
  return events.map((event) => [
    event.sourceSeq,
    event.tapeKind,
    event.providerRefId,
    event.callerLabel,
    event.returnValue ?? "",
    event.offset,
  ].join("|")).join("\n");
}

function buildInvariant(id, passed, details, impact = "") {
  return { id, passed: Boolean(passed), details, impact };
}

function buildReport(options = {}) {
  const input = path.resolve(options.input || DEFAULT_INPUT);
  const plan = readJson(PROVIDER35C4_CAPTURE_JSON, {});
  const adapter = readJson(PROVIDER35C4_SOURCE_JSON, {});
  const planById = buildPlanLookup(plan);
  const abiShim = buildProviderAbiShimReport({ input });
  const providerTraceEvents = (abiShim.traceEvents || []).filter((event) => capturedKind(event));
  const captureEvents = providerTraceEvents.map((event, index) => toCaptureEvent(event, planById, index + 1));
  const producerLedger = buildProducerLedger(captureEvents);
  const compareLinks = buildCompareLinks(captureEvents, producerLedger);
  const pointCoverage = buildPointCoverage(plan, captureEvents);
  const producerEvents = captureEvents.filter((event) => event.tapeKind === "ref-producer");
  const cursorReadEvents = captureEvents.filter((event) => event.tapeKind === "cursor-read");
  const labelCompareEvents = captureEvents.filter((event) => event.tapeKind === "label-ref-consumer");
  const observedFeedEvents = captureEvents.filter((event) => event.feedEligible);
  const return0CompareEvents = labelCompareEvents.filter((event) => event.returnValue === 0 && event.providerRefId);
  const missingCompareProducer = compareLinks.filter((row) => !row.producerKnown);
  const lateCompareProducer = compareLinks.filter((row) => row.producerKnown && !row.producerBeforeCompare);
  const unclassifiedEvents = captureEvents.filter((event) => !event.capturePointId);
  const adapterEvents = adapter?.captureEvents || [];
  const adapterConversionHandoffs = adapterEvents.filter((event) => event.tapeKind === "cursor-read" && event.role === "convert opened stream");
  const adapterProviderOwnedEvents = adapterEvents.filter((event) => !(event.tapeKind === "cursor-read" && event.role === "convert opened stream"));
  const adapterComparable = adapterProviderOwnedEvents.length === captureEvents.length;
  const sameEventSignature = adapterComparable && signature(adapterProviderOwnedEvents) === signature(captureEvents);
  const observedPointCount = pointCoverage.filter((point) => point.observedEventCount > 0).length;
  const invariants = [
    buildInvariant(
      "emulated-source-covers-provider-trace",
      captureEvents.length === providerTraceEvents.length && unclassifiedEvents.length === 0,
      `${captureEvents.length}/${providerTraceEvents.length} provider trace event(s) emitted, ${unclassifiedEvents.length} unclassified`,
      "The emulated source must preserve every relevant provider 0x35C4 call from the ABI shim run."
    ),
    buildInvariant(
      "emulated-source-parity-with-adapter",
      sameEventSignature,
      `${captureEvents.length} emulated event(s), ${adapterProviderOwnedEvents.length} adapter provider-owned event(s), ${adapterConversionHandoffs.length} conversion handoff(s) excluded, signature=${sameEventSignature ? "same" : "different"}`,
      "The direct ABI-shim source should match the provider-owned subset of the tape adapter before the VM switches source providers."
    ),
    buildInvariant(
      "compare-refs-have-prior-producers",
      missingCompareProducer.length === 0 && lateCompareProducer.length === 0,
      `${compareLinks.length} compare(s), ${missingCompareProducer.length} missing producer(s), ${lateCompareProducer.length} late producer(s)`,
      "The label/ref compare source must preserve providerRefId provenance from +0x64."
    ),
    buildInvariant(
      "feed-derived-only-from-return0-compares",
      observedFeedEvents.length === return0CompareEvents.length,
      `${observedFeedEvents.length} source feed event(s), ${return0CompareEvents.length} return-0 compare(s)`,
      "The emulated source cannot feed resolver matches unless +0x50 returned 0."
    ),
    buildInvariant(
      "empty-source-keeps-visible-effects-disabled",
      observedFeedEvents.length === 0,
      `${observedFeedEvents.length} observed feed event(s)`,
      "Visible XSE effects stay disabled until the emulated or live provider source produces return-0 observations."
    ),
  ];
  const failures = invariants.filter((item) => !item.passed);
  return {
    schema: "nicai.cbe.provider35c4EmulatedSourceProbe.v1",
    generatedAt: new Date().toISOString(),
    input,
    inputs: {
      providerAbiShim: "cbe_provider_abi_shim_probe.buildReport({ input })",
      provider35c4CapturePlan: PROVIDER35C4_CAPTURE_JSON,
      provider35c4SourceAdapter: PROVIDER35C4_SOURCE_JSON,
    },
    sourceContract: {
      sourceMode: "abi-shim-emulated-provider-source",
      namespaceId: "provider:0x35C4:+0x64/+0x50",
      providerGlobal: "0x35C4",
      producerSlot: "+0x64",
      compareAndCursorSlot: "+0x50",
      adapterBoundary: "This source is rebuilt from raw CBE through the provider ABI shim, not read from the provider35c4 tape.",
      feedRule: "Only provider-label-ref-compared events with returnValue === 0 and providerRefId become observed resolver feed rows.",
      nextReplacement: "Move this from ABI-shim emulation into a live/emulated provider service object that owns +0x64 and +0x50 directly.",
    },
    counts: {
      providerTraceEventCount: providerTraceEvents.length,
      captureEventCount: captureEvents.length,
      adapterEventCount: adapterEvents.length,
      adapterProviderOwnedEventCount: adapterProviderOwnedEvents.length,
      adapterConversionHandoffCount: adapterConversionHandoffs.length,
      producerEventCount: producerEvents.length,
      cursorReadEventCount: cursorReadEvents.length,
      labelCompareEventCount: labelCompareEvents.length,
      linkedCompareCount: compareLinks.filter((row) => row.producerKnown).length,
      priorProducerCompareCount: compareLinks.filter((row) => row.producerBeforeCompare).length,
      observedReturn0CompareCount: return0CompareEvents.length,
      observedFeedEventCount: observedFeedEvents.length,
      planCapturePointCount: pointCoverage.length,
      observedCapturePointCount: observedPointCount,
      adapterParity: sameEventSignature,
    },
    pointCoverage,
    producerLedger: Array.from(producerLedger.values()),
    compareLinks,
    observedFeedEvents,
    captureEvents: captureEvents.slice(0, 160),
    invariants,
    summary: {
      status: failures.length ? "provider35c4-emulated-source-risk" : "provider35c4-emulated-source-parity-ready",
      currentFinding: "The provider 0x35C4 source can now be regenerated from raw CBE through the ABI shim without reading the tape. It matches the provider-owned subset of the shim-tape adapter and separates the [sb+0x35C0]+0x50 conversion handoffs from 0x35C4 source events.",
      emulatorImpact: "This moves the generic emulator one layer closer to a real provider service. The VM can target an emulated provider source interface while stream conversion, provider reads, and feed/promotion gates remain separately modeled.",
      nextTarget: "Turn the ABI-shim emulated source into a provider service object that owns +0x64 ref production and +0x50 label/ref comparison directly, then bind the real return-0 resolver behavior.",
      visibleEffectsEnabled: false,
      failureCount: failures.length,
      captureEventCount: captureEvents.length,
      adapterEventCount: adapterEvents.length,
      adapterProviderOwnedEventCount: adapterProviderOwnedEvents.length,
      adapterConversionHandoffCount: adapterConversionHandoffs.length,
      producerEventCount: producerEvents.length,
      cursorReadEventCount: cursorReadEvents.length,
      labelCompareEventCount: labelCompareEvents.length,
      linkedCompareCount: compareLinks.filter((row) => row.producerKnown).length,
      priorProducerCompareCount: compareLinks.filter((row) => row.producerBeforeCompare).length,
      observedFeedEventCount: observedFeedEvents.length,
      observedCapturePointCount: observedPointCount,
      planCapturePointCount: pointCoverage.length,
      adapterParity: sameEventSignature,
    },
  };
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# Provider 0x35C4 Emulated Source Probe");
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
  for (const [key, value] of Object.entries(report.sourceContract)) lines.push(mdRow([key, value]));
  lines.push("");
  lines.push("## Counts");
  lines.push("");
  lines.push(mdRow(["Field", "Value"]));
  lines.push(mdRow(["---", "---:"]));
  for (const [key, value] of Object.entries(report.counts)) lines.push(mdRow([key, value]));
  lines.push("");
  lines.push("## Capture Point Coverage");
  lines.push("");
  lines.push(mdRow(["Point", "Kind", "Slot", "Site", "Context", "Ready", "Events"]));
  lines.push(mdRow(["---", "---", "---", "---", "---", "---", "---:"]));
  for (const point of report.pointCoverage) {
    lines.push(mdRow([point.id, point.eventKind, point.slot, point.site, point.context, point.ready ? "yes" : "no", point.observedEventCount]));
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
  const jsonFile = path.join(outDir, "provider35c4_emulated_source_probe.json");
  const mdFile = path.join(outDir, "provider35c4_emulated_source_probe.md");
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
