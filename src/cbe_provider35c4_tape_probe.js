const fs = require("fs");
const path = require("path");
const { DEFAULT_INPUT } = require("./cbe_unpack");

const DEFAULT_OUT = path.resolve(__dirname, "out_godwar_provider35c4tape");
const PROVIDER_ABI_SHIM_JSON = path.resolve(__dirname, "out_godwar_providerabishim", "provider_abi_shim_probe.json");
const PROVIDER_RESOLVER_HOOK_JSON = path.resolve(__dirname, "out_godwar_providerresolverhook", "provider_resolver_hook_probe.json");

function readJson(file, fallback = null) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function mdRow(values) {
  return `| ${values.map((value) => String(value ?? "").replace(/\|/g, "\\|")).join(" | ")} |`;
}

function refMap(namespace) {
  return new Map((namespace?.refs || [])
    .filter((ref) => ref.refId)
    .map((ref) => [ref.refId, ref]));
}

function classifyProviderEvent(event) {
  if (event.service === "[sb+0x35C4]+0x64" || event.method === "+0x64") return "ref-producer";
  if ((event.service === "[sb+0x35C4]+0x50" || event.method === "+0x50") && (event.callerLabel != null || event.argumentShape)) return "label-ref-consumer";
  if (event.service === "[sb+0x35C4]+0x50" || event.method === "+0x50") return "cursor-read";
  return "";
}

function buildTape(shim) {
  const namespace = shim?.providerRefNamespace || {};
  const refs = refMap(namespace);
  return (shim?.traceEvents || [])
    .map((event) => {
      const kind = classifyProviderEvent(event);
      if (!kind) return null;
      const refId = event.providerRefId || event.entryRef?.providerRefId || "";
      const ref = refs.get(refId) || null;
      return {
        seq: event.index ?? 0,
        kind,
        slot: event.method || "",
        role: event.role || "",
        resource: event.resource || event.entryRef?.resource || ref?.resource || "",
        policy: event.policy || event.entryRef?.policy || ref?.policy || "",
        context: event.refContext || event.entryRef?.context || ref?.context || "",
        refId,
        refKnown: refId ? refs.has(refId) : false,
        offset: event.offset || event.entryRef?.offset || ref?.offset || "",
        cursorBefore: event.cursorBeforeHex || event.entryRef?.cursorBefore || ref?.cursorBefore || "",
        rawSample: event.rawSample || event.entryRef?.rawSample || event.raw || ref?.rawSample || "",
        text: event.text || ref?.text || "",
        label: event.callerLabel || "",
        normalizedLabel: event.normalizedLabel || "",
        compareStatus: event.compareStatus || "",
        returnValue: event.returnValue ?? null,
        matched: Boolean(event.returnValue === 0 || event.compareStatus === "matched"),
        hookFeedEligible: kind === "label-ref-consumer" && Boolean(refId && refs.has(refId) && event.callerLabel && event.returnValue === 0),
      };
    })
    .filter(Boolean);
}

function buildInvariant(id, passed, details, impact = "") {
  return { id, passed: Boolean(passed), details, impact };
}

function buildReport(options = {}) {
  const input = path.resolve(options.input || DEFAULT_INPUT);
  const shim = readJson(PROVIDER_ABI_SHIM_JSON, {});
  const hook = readJson(PROVIDER_RESOLVER_HOOK_JSON, {});
  const namespace = shim.providerRefNamespace || {};
  const refs = namespace.refs || [];
  const compares = namespace.compares || [];
  const refsById = refMap(namespace);
  const tape = buildTape(shim);
  const producerEvents = tape.filter((event) => event.kind === "ref-producer");
  const cursorReadEvents = tape.filter((event) => event.kind === "cursor-read");
  const labelCompareEvents = tape.filter((event) => event.kind === "label-ref-consumer");
  const unknownCompareRefs = labelCompareEvents.filter((event) => event.refId && !event.refKnown);
  const missingCompareRefs = labelCompareEvents.filter((event) => !event.refId);
  const ledgerUnknownCompareRefs = compares.filter((compare) => compare.refId && !refsById.has(compare.refId));
  const returnZeroCompares = compares.filter((compare) => compare.returnValue === 0 || compare.matched);
  const textRefs = refs.filter((ref) => ref.context === "sce-resource-name");
  const textRefViolations = textRefs.filter((ref) => ref.compareOnly || ref.kind !== "resource-name");
  const textRefCompareUses = compares.filter((compare) => compare.refContext === "sce-resource-name");
  const rangeRefs = refs.filter((ref) => ref.context === "xse-range-entry-ref");
  const rangeRefViolations = rangeRefs.filter((ref) => ref.kind !== "provider-opaque-ref" || !ref.compareOnly || ref.cursorAdvanced);
  const finalAndChildRefs = refs.filter((ref) => ref.context === "xse-final-ref" || ref.context === "xse-child-resource-handle");
  const finalAndChildViolations = finalAndChildRefs.filter((ref) => ref.kind !== "provider-opaque-ref");
  const observedMatches = returnZeroCompares
    .filter((compare) => compare.refId && refsById.has(compare.refId) && compare.callerLabel)
    .map((compare) => ({
      label: compare.callerLabel,
      normalizedLabel: compare.normalizedLabel || String(compare.callerLabel || "").trim().toLowerCase(),
      providerRefId: compare.refId,
      source: "provider35c4-tape-return0",
      compareStatus: compare.compareStatus || "",
      returnValue: compare.returnValue,
    }));
  const invariants = [
    buildInvariant(
      "compare-consumes-known-ref",
      unknownCompareRefs.length === 0 && missingCompareRefs.length === 0 && ledgerUnknownCompareRefs.length === 0,
      `${labelCompareEvents.length} label/ref compare events, ${unknownCompareRefs.length} unknown event ref(s), ${missingCompareRefs.length} missing event ref(s), ${ledgerUnknownCompareRefs.length} unknown ledger ref(s)`,
      "The hook feed can key matches by providerRefId instead of raw bytes."
    ),
    buildInvariant(
      "no-observed-return0-yet",
      returnZeroCompares.length === 0,
      `${returnZeroCompares.length} return-0 or matched compare(s) in the current shim tape`,
      "With no observed match, entry promotion must remain disabled."
    ),
    buildInvariant(
      "matches-are-hook-feed-only",
      observedMatches.length === returnZeroCompares.length,
      `${observedMatches.length}/${returnZeroCompares.length} matched compare(s) are eligible observed hook-feed rows`,
      "Future matches must be produced by provider observations, not scalar/string guesses."
    ),
    buildInvariant(
      "sce-text-refs-not-compare-only",
      textRefViolations.length === 0 && textRefCompareUses.length === 0,
      `${textRefs.length} SCE text ref(s), ${textRefViolations.length} text policy violation(s), ${textRefCompareUses.length} label/ref compare use(s)`,
      "SCE resource-name refs stay in the resource loader lane."
    ),
    buildInvariant(
      "xse-range-refs-opaque-compare-only",
      rangeRefViolations.length === 0,
      `${rangeRefs.length} XSE range ref(s), ${rangeRefViolations.length} range policy violation(s)`,
      "XSE entry refs must stay provider-opaque until +0x50 returns an observed match."
    ),
    buildInvariant(
      "final-child-refs-opaque",
      finalAndChildViolations.length === 0,
      `${finalAndChildRefs.length} final/child handle ref(s), ${finalAndChildViolations.length} policy violation(s)`,
      "Child script and final table handles must not be parsed as SCE text refs."
    ),
  ];
  const failures = invariants.filter((item) => !item.passed);
  return {
    schema: "nicai.cbe.provider35c4InstrumentationTapeProbe.v1",
    generatedAt: new Date().toISOString(),
    input,
    inputs: {
      providerAbiShim: PROVIDER_ABI_SHIM_JSON,
      providerResolverHook: PROVIDER_RESOLVER_HOOK_JSON,
    },
    namespace: {
      namespaceId: namespace.namespaceId || "",
      refCount: namespace.refCount || refs.length,
      opaqueRefCount: namespace.opaqueRefCount || refs.filter((ref) => ref.kind === "provider-opaque-ref").length,
      textRefCount: namespace.textRefCount || refs.filter((ref) => ref.kind === "resource-name").length,
      compareCount: namespace.compareCount || compares.length,
      compareMatchCount: namespace.compareMatchCount || returnZeroCompares.length,
      unboundCompareCount: namespace.unboundCompareCount || compares.filter((compare) => compare.compareStatus === "ref-namespace-unbound").length,
      contexts: namespace.contexts || [],
    },
    resolverHook: {
      status: hook.summary?.status || "",
      mode: hook.summary?.hookMode || shim.resolverHook?.mode || "",
      bound: Boolean(shim.resolverHook?.bound),
      guardFailureCount: hook.summary?.failureCount || 0,
    },
    counts: {
      providerEventCount: tape.length,
      producerEventCount: producerEvents.length,
      cursorReadEventCount: cursorReadEvents.length,
      labelCompareEventCount: labelCompareEvents.length,
      knownCompareRefCount: labelCompareEvents.length - unknownCompareRefs.length - missingCompareRefs.length,
      unknownCompareRefCount: unknownCompareRefs.length,
      missingCompareRefCount: missingCompareRefs.length,
      observedReturn0CompareCount: returnZeroCompares.length,
      hookFeedObservedMatchCount: observedMatches.length,
      textRefCount: textRefs.length,
      rangeRefCount: rangeRefs.length,
      finalAndChildRefCount: finalAndChildRefs.length,
    },
    invariants,
    observedMatches,
    tape: tape.slice(0, 120),
    summary: {
      status: failures.length ? "provider35c4-instrumentation-tape-risk" : "provider35c4-instrumentation-tape-ready",
      currentFinding: "The provider 0x35C4 tape now separates +0x64 ref producers, +0x50 stream/cursor reads, and +0x50 label/ref compare consumers while preserving providerRefId identity across the ledger.",
      emulatorImpact: "This is the bridge from the current shim to a real generic emulator service. The future resolver can consume observed return-0 label/ref pairs from the same tape shape; until such rows exist, the VM must keep visible XSE effects disabled.",
      nextTarget: "Replace the shim-derived tape source with real provider 0x35C4 instrumentation, then feed only observed +0x50 return-0 providerRefId/label pairs into the resolver hook.",
      visibleEffectsEnabled: false,
      failureCount: failures.length,
      providerEventCount: tape.length,
      producerEventCount: producerEvents.length,
      cursorReadEventCount: cursorReadEvents.length,
      labelCompareEventCount: labelCompareEvents.length,
      observedReturn0CompareCount: returnZeroCompares.length,
      hookFeedObservedMatchCount: observedMatches.length,
    },
  };
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# Provider 0x35C4 Instrumentation Tape Probe");
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
  for (const [key, value] of Object.entries(report.counts)) {
    lines.push(mdRow([key, value]));
  }
  lines.push("");
  lines.push("## Invariants");
  lines.push("");
  lines.push(mdRow(["Invariant", "Pass", "Details", "Impact"]));
  lines.push(mdRow(["---", "---", "---", "---"]));
  for (const invariant of report.invariants) {
    lines.push(mdRow([
      invariant.id,
      invariant.passed ? "yes" : "no",
      invariant.details,
      invariant.impact,
    ]));
  }
  lines.push("");
  lines.push("## Hook Feed Preview");
  lines.push("");
  if (report.observedMatches.length) {
    lines.push(mdRow(["Label", "Normalized", "Provider Ref", "Status", "Return"]));
    lines.push(mdRow(["---", "---", "---", "---", "---:"]));
    for (const row of report.observedMatches) {
      lines.push(mdRow([row.label, row.normalizedLabel, row.providerRefId, row.compareStatus, row.returnValue]));
    }
  } else {
    lines.push("- No observed return-0 label/ref rows are present yet; resolver hook feed remains empty.");
  }
  lines.push("");
  lines.push("## Provider Tape Head");
  lines.push("");
  lines.push(mdRow(["Seq", "Kind", "Slot", "Resource", "Context", "Ref", "Label", "Return", "Status"]));
  lines.push(mdRow(["---:", "---", "---", "---", "---", "---", "---", "---:", "---"]));
  for (const event of report.tape.slice(0, 60)) {
    lines.push(mdRow([
      event.seq,
      event.kind,
      event.slot,
      event.resource,
      event.context,
      event.refId,
      event.label,
      event.returnValue == null ? "" : event.returnValue,
      event.compareStatus,
    ]));
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
  const jsonFile = path.join(outDir, "provider35c4_tape_probe.json");
  const mdFile = path.join(outDir, "provider35c4_tape_probe.md");
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
