const fs = require("fs");
const path = require("path");
const { DEFAULT_INPUT } = require("./cbe_unpack");
const { buildReport: buildEmulatedSourceReport } = require("./cbe_provider35c4_emulated_source_probe");

const DEFAULT_OUT = path.resolve(__dirname, "out_godwar_provider35c4svcobj");

function mdRow(values) {
  return `| ${values.map((value) => String(value ?? "").replace(/\|/g, "\\|")).join(" | ")} |`;
}

function normalizeLabel(label) {
  return String(label || "").trim().toLowerCase();
}

function observedKey(label, providerRefId) {
  return `${normalizeLabel(label)}|${providerRefId || ""}`;
}

class Provider35C4ServiceObject {
  constructor({ observedMatches = [], observationSink = null } = {}) {
    this.global = "0x35C4";
    this.providerMethod = "providerApi+0x64";
    this.namespaceId = "provider:0x35C4:+0x64/+0x50";
    this.methods = {
      "+0x64": "produce provider refs by call context",
      "+0x50": "dispatch by argument shape: cursor read or label/ref compare",
    };
    this.refs = new Map();
    this.operations = [];
    this.observationEvents = [];
    this.observationSink = typeof observationSink === "function" ? observationSink : null;
    this.observedMatches = new Set(observedMatches.map((row) => observedKey(row.label || row.normalizedLabel, row.providerRefId)));
  }

  emit(op) {
    const row = {
      opSeq: this.operations.length + 1,
      serviceGlobal: this.global,
      namespaceId: this.namespaceId,
      ...op,
    };
    this.operations.push(row);
    return row;
  }

  emitObservation(row) {
    const observation = {
      observationSeq: this.observationEvents.length + 1,
      serviceGlobal: this.global,
      namespaceId: this.namespaceId,
      ...row,
    };
    this.observationEvents.push(observation);
    if (this.observationSink) this.observationSink(observation);
    return observation;
  }

  readProviderRef(event) {
    if (event.slot !== "+0x64") throw new Error(`readProviderRef expected +0x64, got ${event.slot}`);
    if (!event.providerRefId) throw new Error(`readProviderRef missing providerRefId at source ${event.sourceSeq}`);
    const handle = {
      providerRefId: event.providerRefId,
      context: event.context || "",
      resource: event.resource || "",
      policy: event.policy || "",
      cursorBefore: event.cursorBefore || "",
      offset: event.offset || "",
      rawSample: event.rawSample || "",
      text: event.text || "",
      returnClass: event.context === "sce-resource-name" ? "length-prefixed resource-name text" : "provider-opaque ref",
      compareOnly: event.context === "xse-range-entry-ref",
      sourceSeq: event.sourceSeq,
    };
    this.refs.set(handle.providerRefId, handle);
    this.emit({
      method: "+0x64",
      dispatchShape: "provider-ref-producer",
      sourceSeq: event.sourceSeq,
      capturePointId: event.capturePointId,
      resource: handle.resource,
      policy: handle.policy,
      context: handle.context,
      providerRefId: handle.providerRefId,
      offset: handle.offset,
      rawSample: handle.rawSample,
      text: handle.text,
      resultClass: handle.returnClass,
      resultValue: handle.providerRefId,
    });
    return handle;
  }

  readCursor(event) {
    if (event.slot !== "+0x50") throw new Error(`readCursor expected +0x50, got ${event.slot}`);
    const result = {
      value: event.value,
      nextCursor: event.nextCursor || "",
      cursorBefore: event.cursorBefore || "",
      offset: event.offset || "",
      rawSample: event.rawSample || "",
    };
    this.emit({
      method: "+0x50",
      dispatchShape: "stream-cursor-read",
      sourceSeq: event.sourceSeq,
      capturePointId: event.capturePointId,
      resource: event.resource || "",
      policy: event.policy || "",
      cursorBefore: result.cursorBefore,
      offset: result.offset,
      rawSample: result.rawSample,
      resultValue: result.value,
      nextCursor: result.nextCursor,
    });
    return result;
  }

  compareLabelRef(event) {
    if (event.slot !== "+0x50") throw new Error(`compareLabelRef expected +0x50, got ${event.slot}`);
    const ref = this.refs.get(event.providerRefId);
    const matched = Boolean(ref && this.observedMatches.has(observedKey(event.callerLabel || event.normalizedLabel, event.providerRefId)));
    const returnValue = matched ? 0 : 1;
    const op = this.emit({
      method: "+0x50",
      dispatchShape: "label-ref-compare",
      sourceSeq: event.sourceSeq,
      capturePointId: event.capturePointId,
      resource: event.resource || ref?.resource || "",
      policy: event.policy || ref?.policy || "",
      context: event.context || ref?.context || "",
      providerRefId: event.providerRefId || "",
      callerLabel: event.callerLabel || "",
      normalizedLabel: event.normalizedLabel || normalizeLabel(event.callerLabel),
      refKnown: Boolean(ref),
      refProducerSeq: ref?.sourceSeq ?? null,
      compareStatus: matched ? "observed-provider-match" : "ref-namespace-unbound",
      expectedReturnValue: event.returnValue,
      resultValue: returnValue,
      matched,
    });
    this.emitObservation({
      capturePointId: op.capturePointId,
      site: event.site || "0x0001233C",
      method: op.method,
      dispatchShape: op.dispatchShape,
      script: op.resource,
      resource: op.resource,
      policy: op.policy,
      context: op.context,
      label: op.callerLabel,
      callerLabel: op.callerLabel,
      normalizedLabel: op.normalizedLabel,
      providerRefId: op.providerRefId,
      returnValue,
      source: event.observationSource || "provider35c4-service-object-runtime",
      sourceSeq: op.sourceSeq,
      opSeq: op.opSeq,
      role: event.role || "",
      refKnown: op.refKnown,
      refProducerSeq: op.refProducerSeq,
      compareStatus: op.compareStatus,
      start: event.start || "",
      modeKey: event.modeKey || "",
      laneIndex: event.laneIndex,
      entryIndex: event.entryIndex,
      entryOffset: event.entryOffset || "",
      field04: event.field04,
      field08: event.field08,
      field0C: event.field0C,
      refRaw: event.refRaw || event.rawSample || "",
      refMode: event.refMode || "",
    });
    return returnValue;
  }

  replayEvent(event) {
    if (event.tapeKind === "ref-producer") return this.readProviderRef(event);
    if (event.tapeKind === "cursor-read") return this.readCursor(event);
    if (event.tapeKind === "label-ref-consumer") return this.compareLabelRef(event);
    throw new Error(`unsupported provider35c4 event kind ${event.tapeKind}`);
  }
}

function replayServiceObject(captureEvents, observedMatches = []) {
  const service = new Provider35C4ServiceObject({ observedMatches });
  const rows = [];
  for (const event of captureEvents) {
    const beforeOpCount = service.operations.length;
    const result = service.replayEvent(event);
    const op = service.operations[beforeOpCount];
    rows.push({
      sourceSeq: event.sourceSeq,
      tapeKind: event.tapeKind,
      slot: event.slot,
      capturePointId: event.capturePointId,
      providerRefId: event.providerRefId || result?.providerRefId || "",
      callerLabel: event.callerLabel || "",
      sourceReturnValue: event.returnValue,
      serviceReturnValue: event.tapeKind === "label-ref-consumer" ? result : op.resultValue,
      opSeq: op.opSeq,
      dispatchShape: op.dispatchShape,
      refKnown: op.refKnown ?? Boolean(event.tapeKind === "ref-producer" && event.providerRefId),
      status: event.tapeKind === "label-ref-consumer" && result !== event.returnValue
        ? "service-return-mismatch"
        : "service-replay-ok",
    });
  }
  return {
    service,
    rows,
  };
}

function buildInvariant(id, passed, details, impact = "") {
  return { id, passed: Boolean(passed), details, impact };
}

function buildReport(options = {}) {
  const input = path.resolve(options.input || DEFAULT_INPUT);
  const emulatedSource = buildEmulatedSourceReport({ input });
  const captureEvents = emulatedSource.captureEvents || [];
  const observedMatches = emulatedSource.observedFeedEvents || [];
  const { service, rows } = replayServiceObject(captureEvents, observedMatches);
  const producerOps = service.operations.filter((op) => op.dispatchShape === "provider-ref-producer");
  const cursorReadOps = service.operations.filter((op) => op.dispatchShape === "stream-cursor-read");
  const compareOps = service.operations.filter((op) => op.dispatchShape === "label-ref-compare");
  const returnMismatches = rows.filter((row) => row.status !== "service-replay-ok");
  const compareMissingRefs = compareOps.filter((op) => !op.refKnown);
  const compareLateRefs = compareOps.filter((op) => op.refKnown && !(op.refProducerSeq < op.sourceSeq));
  const nonServiceSlots = rows.filter((row) => row.slot !== "+0x50" && row.slot !== "+0x64");
  const methodShapes = Array.from(new Set(service.operations.map((op) => `${op.method}:${op.dispatchShape}`))).sort();
  const observedReturn0Rows = compareOps.filter((op) => op.resultValue === 0);
  const invariants = [
    buildInvariant(
      "service-object-replays-source",
      rows.length === captureEvents.length && returnMismatches.length === 0,
      `${rows.length}/${captureEvents.length} source event(s) replayed, ${returnMismatches.length} return mismatch(es)`,
      "The service object must be able to reproduce current provider-owned source behavior before replacing source extraction."
    ),
    buildInvariant(
      "service-owns-only-35c4-slots",
      nonServiceSlots.length === 0 && methodShapes.every((shape) => shape.startsWith("+0x50:") || shape.startsWith("+0x64:")),
      `${nonServiceSlots.length} non-service slot event(s); shapes=${methodShapes.join(", ")}`,
      "The 0x35C4 service object must not absorb 0x35C0 conversion handoffs or unrelated slots."
    ),
    buildInvariant(
      "plus50-shape-polymorphism-explicit",
      methodShapes.includes("+0x50:stream-cursor-read") && methodShapes.includes("+0x50:label-ref-compare"),
      methodShapes.join(", "),
      "+0x50 must stay split by argument shape instead of becoming one scalar reader guess."
    ),
    buildInvariant(
      "compare-refs-known-and-prior",
      compareMissingRefs.length === 0 && compareLateRefs.length === 0,
      `${compareOps.length} compare op(s), ${compareMissingRefs.length} missing ref(s), ${compareLateRefs.length} late ref(s)`,
      "Label/ref compare must consume handles produced earlier by +0x64."
    ),
    buildInvariant(
      "empty-observed-feed-keeps-nonmatch",
      observedMatches.length > 0 || observedReturn0Rows.length === 0,
      `${observedMatches.length} observed feed row(s), ${observedReturn0Rows.length} return-0 service compare(s)`,
      "Without observed provider matches, the service object must return non-match for all label/ref compares."
    ),
  ];
  const failures = invariants.filter((item) => !item.passed);
  return {
    schema: "nicai.cbe.provider35c4ServiceObjectProbe.v1",
    generatedAt: new Date().toISOString(),
    input,
    inputs: {
      provider35c4EmulatedSource: "cbe_provider35c4_emulated_source_probe.buildReport({ input })",
    },
    serviceObject: {
      global: service.global,
      providerMethod: service.providerMethod,
      namespaceId: service.namespaceId,
      methods: service.methods,
      resolverMode: observedMatches.length ? "observed-match-feed" : "observed-match-feed-empty",
      methodShapes,
    },
    counts: {
      replayRowCount: rows.length,
      sourceEventCount: captureEvents.length,
      serviceOperationCount: service.operations.length,
      producerOperationCount: producerOps.length,
      cursorReadOperationCount: cursorReadOps.length,
      compareOperationCount: compareOps.length,
      knownRefCount: service.refs.size,
      compareMissingRefCount: compareMissingRefs.length,
      compareLateRefCount: compareLateRefs.length,
      observedFeedCount: observedMatches.length,
      observedReturn0CompareCount: observedReturn0Rows.length,
      returnMismatchCount: returnMismatches.length,
      adapterConversionHandoffCount: emulatedSource.summary?.adapterConversionHandoffCount || 0,
    },
    replayRows: rows,
    operations: service.operations.slice(0, 160),
    invariants,
    summary: {
      status: failures.length ? "provider35c4-service-object-risk" : "provider35c4-service-object-ready",
      currentFinding: "The provider 0x35C4 service object now owns the +0x64 ref producer and the +0x50 shape-polymorphic cursor/label-ref methods, and it replays the provider-owned emulated source without return mismatches.",
      emulatorImpact: "This is the reusable service boundary the generic CBE emulator can call instead of reading a tape. Stream conversion remains outside in 0x35C0, while 0x35C4 handles refs, cursor reads, and guarded label/ref comparison.",
      nextTarget: "Feed this service object from live parsed stream calls instead of prebuilt source events, then recover the real resolver mapping that makes +0x50 return 0 for observed label/ref pairs.",
      visibleEffectsEnabled: false,
      failureCount: failures.length,
      replayRowCount: rows.length,
      producerOperationCount: producerOps.length,
      cursorReadOperationCount: cursorReadOps.length,
      compareOperationCount: compareOps.length,
      knownRefCount: service.refs.size,
      observedFeedCount: observedMatches.length,
      observedReturn0CompareCount: observedReturn0Rows.length,
      adapterConversionHandoffCount: emulatedSource.summary?.adapterConversionHandoffCount || 0,
    },
  };
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# Provider 0x35C4 Service Object Probe");
  lines.push("");
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Input CBE: \`${report.input}\``);
  lines.push(`- Status: ${report.summary.status}`);
  lines.push(`- Finding: ${report.summary.currentFinding}`);
  lines.push(`- Emulator impact: ${report.summary.emulatorImpact}`);
  lines.push(`- Next target: ${report.summary.nextTarget}`);
  lines.push("");
  lines.push("## Service Object");
  lines.push("");
  lines.push(mdRow(["Field", "Value"]));
  lines.push(mdRow(["---", "---"]));
  lines.push(mdRow(["global", report.serviceObject.global]));
  lines.push(mdRow(["providerMethod", report.serviceObject.providerMethod]));
  lines.push(mdRow(["namespaceId", report.serviceObject.namespaceId]));
  lines.push(mdRow(["resolverMode", report.serviceObject.resolverMode]));
  lines.push(mdRow(["methodShapes", report.serviceObject.methodShapes.join(", ")]));
  lines.push("");
  lines.push("## Counts");
  lines.push("");
  lines.push(mdRow(["Field", "Value"]));
  lines.push(mdRow(["---", "---:"]));
  for (const [key, value] of Object.entries(report.counts)) lines.push(mdRow([key, value]));
  lines.push("");
  lines.push("## Replay Head");
  lines.push("");
  lines.push(mdRow(["Seq", "Kind", "Shape", "Ref", "Label", "Source Return", "Service Return", "Status"]));
  lines.push(mdRow(["---:", "---", "---", "---", "---", "---:", "---:", "---"]));
  for (const row of report.replayRows.slice(0, 64)) {
    lines.push(mdRow([
      row.sourceSeq,
      row.tapeKind,
      row.dispatchShape,
      row.providerRefId,
      row.callerLabel,
      row.sourceReturnValue,
      row.serviceReturnValue,
      row.status,
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
  const jsonFile = path.join(outDir, "provider35c4_service_object_probe.json");
  const mdFile = path.join(outDir, "provider35c4_service_object_probe.md");
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
  Provider35C4ServiceObject,
  buildReport,
  renderMarkdown,
  replayServiceObject,
};
