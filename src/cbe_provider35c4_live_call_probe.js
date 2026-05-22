const fs = require("fs");
const path = require("path");
const { DEFAULT_INPUT } = require("./cbe_unpack");
const { buildReport: buildProviderAbiShimReport } = require("./cbe_provider_abi_shim_probe");
const { buildReport: buildServiceObjectReport, Provider35C4ServiceObject } = require("./cbe_provider35c4_service_object_probe");

const DEFAULT_OUT = path.resolve(__dirname, "out_godwar_provider35c4livecall");

function mdRow(values) {
  return `| ${values.map((value) => String(value ?? "").replace(/\|/g, "\\|")).join(" | ")} |`;
}

function normalizeLabel(label) {
  return String(label || "").trim().toLowerCase();
}

function traceKind(event) {
  if (event.service !== "[sb+0x35C4]+0x64" && event.service !== "[sb+0x35C4]+0x50") return "";
  if (event.method === "+0x64") return "ref-producer";
  if (event.method === "+0x50" && (event.callerLabel || event.entryRef || event.providerRefId)) return "label-ref-consumer";
  if (event.method === "+0x50") return "cursor-read";
  return "";
}

function classifyCapturePoint(event, kind) {
  const context = event.refContext || event.entryRef?.context || "";
  if (kind === "ref-producer" && context === "sce-resource-name") return "provider35c4-sce-resource-ref";
  if (kind === "ref-producer" && context === "xse-range-entry-ref") return "provider35c4-xse-range-ref";
  if (kind === "ref-producer" && context === "xse-final-ref") return "provider35c4-xse-final-ref";
  if (kind === "label-ref-consumer") return "provider35c4-label-ref-compare-1";
  if (kind === "cursor-read") return "provider35c4-stream-read-1";
  return "";
}

function requestFromTrace(event) {
  const kind = traceKind(event);
  const entryRef = event.entryRef || {};
  const providerRefId = event.providerRefId || entryRef.providerRefId || "";
  const context = event.refContext || entryRef.context || "";
  const request = {
    sourceSeq: event.index,
    method: event.method || "",
    service: event.service || "",
    tapeKind: kind,
    dispatchShape: kind === "ref-producer"
      ? "provider-ref-producer"
      : (kind === "label-ref-consumer" ? "label-ref-compare" : "stream-cursor-read"),
    capturePointId: classifyCapturePoint(event, kind),
    role: event.role || "",
    resource: event.resource || entryRef.resource || "",
    policy: event.policy || entryRef.policy || "",
    context,
    providerRefId,
    cursorBefore: event.cursorBeforeHex || entryRef.cursorBefore || "",
    offset: event.offset || entryRef.offset || "",
    rawSample: event.rawSample || entryRef.rawSample || event.raw || "",
    text: event.text || "",
    value: event.value,
    nextCursor: event.nextCursorHex || "",
    callerLabel: event.callerLabel || "",
    normalizedLabel: event.normalizedLabel || normalizeLabel(event.callerLabel),
    returnValue: event.returnValue,
  };
  return request;
}

function feedRequest(service, request) {
  const event = {
    sourceSeq: request.sourceSeq,
    tapeKind: request.tapeKind,
    slot: request.method,
    capturePointId: request.capturePointId,
    resource: request.resource,
    policy: request.policy,
    context: request.context,
    providerRefId: request.providerRefId,
    cursorBefore: request.cursorBefore,
    offset: request.offset,
    rawSample: request.rawSample,
    text: request.text,
    value: request.value,
    nextCursor: request.nextCursor,
    callerLabel: request.callerLabel,
    normalizedLabel: request.normalizedLabel,
    returnValue: request.returnValue,
  };
  return service.replayEvent(event);
}

function operationSignature(ops) {
  return ops.map((op) => [
    op.sourceSeq,
    op.method,
    op.dispatchShape,
    op.providerRefId || "",
    op.callerLabel || "",
    op.resultValue ?? "",
  ].join("|")).join("\n");
}

function buildInvariant(id, passed, details, impact = "") {
  return { id, passed: Boolean(passed), details, impact };
}

function buildReport(options = {}) {
  const input = path.resolve(options.input || DEFAULT_INPUT);
  const abiShim = buildProviderAbiShimReport({ input });
  const serviceObjectReport = buildServiceObjectReport({ input });
  const providerTrace = (abiShim.traceEvents || []).filter((event) => traceKind(event));
  const requests = providerTrace.map(requestFromTrace);
  const service = new Provider35C4ServiceObject({ observedMatches: [] });
  const rows = [];
  for (const request of requests) {
    const opBefore = service.operations.length;
    const result = feedRequest(service, request);
    const op = service.operations[opBefore] || {};
    rows.push({
      sourceSeq: request.sourceSeq,
      method: request.method,
      dispatchShape: request.dispatchShape,
      providerRefId: request.providerRefId,
      callerLabel: request.callerLabel,
      requestReturnValue: request.returnValue,
      serviceReturnValue: request.tapeKind === "label-ref-consumer" ? result : op.resultValue,
      opSeq: op.opSeq,
      status: request.tapeKind === "label-ref-consumer" && result !== request.returnValue
        ? "live-call-return-mismatch"
        : "live-call-ok",
    });
  }
  const producerOps = service.operations.filter((op) => op.dispatchShape === "provider-ref-producer");
  const cursorOps = service.operations.filter((op) => op.dispatchShape === "stream-cursor-read");
  const compareOps = service.operations.filter((op) => op.dispatchShape === "label-ref-compare");
  const methodShapes = Array.from(new Set(service.operations.map((op) => `${op.method}:${op.dispatchShape}`))).sort();
  const returnMismatches = rows.filter((row) => row.status !== "live-call-ok");
  const missingRefs = compareOps.filter((op) => !op.refKnown);
  const lateRefs = compareOps.filter((op) => op.refKnown && !(op.refProducerSeq < op.sourceSeq));
  const return0Rows = compareOps.filter((op) => op.resultValue === 0);
  const serviceObjectOps = serviceObjectReport.operations || [];
  const parity = serviceObjectOps.length === service.operations.length && operationSignature(serviceObjectOps) === operationSignature(service.operations);
  const invariants = [
    buildInvariant(
      "live-call-feeder-covers-provider-trace",
      requests.length === providerTrace.length && requests.every((request) => request.method === "+0x50" || request.method === "+0x64"),
      `${requests.length}/${providerTrace.length} provider trace call(s), methods=${Array.from(new Set(requests.map((request) => request.method))).join(", ")}`,
      "The live-call feeder must own only provider 0x35C4 method calls."
    ),
    buildInvariant(
      "direct-service-call-parity",
      parity,
      `${service.operations.length} live-call operation(s), ${serviceObjectOps.length} source-replay operation(s), signature=${parity ? "same" : "different"}`,
      "Calling the service object from trace requests must match the previous source-event replay."
    ),
    buildInvariant(
      "plus50-shapes-stay-split",
      methodShapes.includes("+0x50:stream-cursor-read") && methodShapes.includes("+0x50:label-ref-compare"),
      methodShapes.join(", "),
      "The runtime call feeder must keep cursor reads and label/ref compares distinct."
    ),
    buildInvariant(
      "compare-refs-known-and-prior",
      missingRefs.length === 0 && lateRefs.length === 0,
      `${compareOps.length} compare op(s), ${missingRefs.length} missing ref(s), ${lateRefs.length} late ref(s)`,
      "Provider label/ref compare calls must consume a prior +0x64 handle."
    ),
    buildInvariant(
      "empty-feed-keeps-live-calls-nonmatch",
      return0Rows.length === 0 && returnMismatches.length === 0,
      `${return0Rows.length} return-0 compare(s), ${returnMismatches.length} return mismatch(es)`,
      "Direct service calls must preserve the current no-visible-effects behavior while real resolver observations are absent."
    ),
  ];
  const failures = invariants.filter((item) => !item.passed);
  return {
    schema: "nicai.cbe.provider35c4LiveCallProbe.v1",
    generatedAt: new Date().toISOString(),
    input,
    inputs: {
      providerAbiShim: "cbe_provider_abi_shim_probe.buildReport({ input })",
      provider35c4ServiceObject: "Provider35C4ServiceObject",
      provider35c4ServiceObjectProbe: "cbe_provider35c4_service_object_probe.buildReport({ input })",
    },
    callContract: {
      sourceMode: "abi-shim-trace-live-call-feeder",
      serviceGlobal: service.global,
      providerMethod: service.providerMethod,
      allowedMethods: ["+0x64", "+0x50"],
      methodShapes,
      excludedService: "[sb+0x35C0]+0x50 stream conversion remains outside this feeder",
      resolverMode: "observed-match-feed-empty",
    },
    counts: {
      providerTraceCallCount: providerTrace.length,
      callRequestCount: requests.length,
      serviceOperationCount: service.operations.length,
      producerOperationCount: producerOps.length,
      cursorReadOperationCount: cursorOps.length,
      compareOperationCount: compareOps.length,
      knownRefCount: service.refs.size,
      missingCompareRefCount: missingRefs.length,
      lateCompareRefCount: lateRefs.length,
      return0CompareCount: return0Rows.length,
      returnMismatchCount: returnMismatches.length,
      serviceObjectParity: parity,
    },
    callRequests: requests.slice(0, 160),
    replayRows: rows,
    operations: service.operations.slice(0, 160),
    invariants,
    summary: {
      status: failures.length ? "provider35c4-live-call-risk" : "provider35c4-live-call-feeder-ready",
      currentFinding: "The provider 0x35C4 service object can now be fed directly from ABI shim service-call requests, reproducing the service-object source replay while keeping +0x64 and +0x50 method shapes explicit.",
      emulatorImpact: "This is the runtime-facing call boundary for the generic CBE emulator. The next emulator loop can call the 0x35C4 service object instead of prebuilding provider source events.",
      nextTarget: "Replace the ABI-shim trace call feeder with parsed live stream execution that invokes 0x35C4 methods as the XSE/SCE readers encounter +0x64 and +0x50 call sites.",
      visibleEffectsEnabled: false,
      failureCount: failures.length,
      callRequestCount: requests.length,
      producerOperationCount: producerOps.length,
      cursorReadOperationCount: cursorOps.length,
      compareOperationCount: compareOps.length,
      knownRefCount: service.refs.size,
      return0CompareCount: return0Rows.length,
      serviceObjectParity: parity,
    },
  };
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# Provider 0x35C4 Live Call Probe");
  lines.push("");
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Input CBE: \`${report.input}\``);
  lines.push(`- Status: ${report.summary.status}`);
  lines.push(`- Finding: ${report.summary.currentFinding}`);
  lines.push(`- Emulator impact: ${report.summary.emulatorImpact}`);
  lines.push(`- Next target: ${report.summary.nextTarget}`);
  lines.push("");
  lines.push("## Call Contract");
  lines.push("");
  lines.push(mdRow(["Field", "Value"]));
  lines.push(mdRow(["---", "---"]));
  for (const [key, value] of Object.entries(report.callContract)) {
    lines.push(mdRow([key, Array.isArray(value) ? value.join(", ") : value]));
  }
  lines.push("");
  lines.push("## Counts");
  lines.push("");
  lines.push(mdRow(["Field", "Value"]));
  lines.push(mdRow(["---", "---:"]));
  for (const [key, value] of Object.entries(report.counts)) lines.push(mdRow([key, value]));
  lines.push("");
  lines.push("## Replay Head");
  lines.push("");
  lines.push(mdRow(["Seq", "Method", "Shape", "Ref", "Label", "Request Return", "Service Return", "Status"]));
  lines.push(mdRow(["---:", "---", "---", "---", "---", "---:", "---:", "---"]));
  for (const row of report.replayRows.slice(0, 64)) {
    lines.push(mdRow([
      row.sourceSeq,
      row.method,
      row.dispatchShape,
      row.providerRefId,
      row.callerLabel,
      row.requestReturnValue,
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
  const jsonFile = path.join(outDir, "provider35c4_live_call_probe.json");
  const mdFile = path.join(outDir, "provider35c4_live_call_probe.md");
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
