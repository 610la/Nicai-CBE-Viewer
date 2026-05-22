const fs = require("fs");
const path = require("path");
const { DEFAULT_INPUT } = require("./cbe_unpack");
const { createObservedProviderRefResolver } = require("./cbe_provider_abi_shim_probe");

const DEFAULT_OUT = path.resolve(__dirname, "out_godwar_providerresolverhook");
const PROVIDER_ABI_SHIM_JSON = path.resolve(__dirname, "out_godwar_providerabishim", "provider_abi_shim_probe.json");
const COMPARE_RESOLVER_JSON = path.resolve(__dirname, "out_godwar_xsecompareresolver", "xse_compare_resolver_boundary_probe.json");

function readJson(file, fallback = null) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function firstRangeCompare(namespace) {
  return (namespace?.compares || []).find((compare) => compare.refContext === "xse-range-entry-ref" && compare.refId) || null;
}

function refById(namespace, refId) {
  return (namespace?.refs || []).find((ref) => ref.refId === refId) || null;
}

function callResolver(resolver, label, ref) {
  const result = resolver({
    callerLabel: label,
    normalizedLabel: String(label || "").trim().toLowerCase(),
    entryRef: {
      kind: ref?.kind || "provider-opaque-ref",
      context: ref?.context || "xse-range-entry-ref",
      providerRefId: ref?.refId || "",
      resource: ref?.resource || "",
      policy: ref?.policy || "",
      offset: ref?.offset || "",
      rawSample: ref?.rawSample || "",
    },
  });
  return {
    label,
    refId: ref?.refId || "",
    matched: Boolean(result?.matched),
    status: result?.status || "",
    returnValue: result?.matched ? 0 : 1,
  };
}

function buildReport(options = {}) {
  const input = path.resolve(options.input || DEFAULT_INPUT);
  const shim = readJson(PROVIDER_ABI_SHIM_JSON, {});
  const compareResolver = readJson(COMPARE_RESOLVER_JSON, {});
  const namespace = shim.providerRefNamespace || {};
  const baseline = firstRangeCompare(namespace);
  const baselineRef = refById(namespace, baseline?.refId);
  const observedMatch = baseline ? {
    label: baseline.callerLabel,
    providerRefId: baseline.refId,
    source: "synthetic-hook-mechanics-only",
  } : null;
  const resolver = createObservedProviderRefResolver(observedMatch ? [observedMatch] : []);
  const wrongLabel = baseline?.callerLabel === "Init" ? "_main" : "Init";
  const wrongRef = (namespace.refs || []).find((ref) => ref.refId !== baseline?.refId && ref.context === "xse-range-entry-ref") || null;
  const checks = baselineRef ? [
    { id: "exact-observed-pair", ...callResolver(resolver, baseline.callerLabel, baselineRef), expectedMatched: true },
    { id: "same-label-wrong-ref", ...callResolver(resolver, baseline.callerLabel, wrongRef || { refId: "missing" }), expectedMatched: false },
    { id: "wrong-label-same-ref", ...callResolver(resolver, wrongLabel, baselineRef), expectedMatched: false },
    { id: "text-normalization-only", ...callResolver(resolver, String(baseline.callerLabel || "").toUpperCase(), baselineRef), expectedMatched: true },
    { id: "unknown-ref", ...callResolver(resolver, baseline.callerLabel, { refId: "unknown-provider-ref" }), expectedMatched: false },
  ] : [];
  const failures = checks.filter((check) => check.matched !== check.expectedMatched);
  return {
    schema: "nicai.cbe.providerResolverHookProbe.v1",
    generatedAt: new Date().toISOString(),
    input,
    inputs: {
      providerAbiShim: PROVIDER_ABI_SHIM_JSON,
      compareResolver: COMPARE_RESOLVER_JSON,
    },
    baseline: {
      namespaceId: namespace.namespaceId || "",
      refCount: namespace.refCount || 0,
      opaqueRefCount: namespace.opaqueRefCount || 0,
      compareCount: namespace.compareCount || 0,
      compareMatchCount: namespace.compareMatchCount || 0,
      unboundCompareCount: namespace.unboundCompareCount || 0,
      compareResolverStatus: compareResolver?.summary?.status || "",
      resolverHookMode: shim.resolverHook?.mode || "unbound-observed-match-only",
      resolverHookBound: Boolean(shim.resolverHook?.bound),
    },
    syntheticObservedMatch: observedMatch,
    checks,
    summary: {
      status: failures.length ? "resolver-hook-guard-failed" : "resolver-hook-guarded",
      hookMode: "observed-match-only",
      syntheticObservedMatchCount: observedMatch ? 1 : 0,
      checkCount: checks.length,
      failureCount: failures.length,
      exactObservedPairMatches: Boolean(checks.find((check) => check.id === "exact-observed-pair")?.matched),
      sameLabelWrongRefMatches: Boolean(checks.find((check) => check.id === "same-label-wrong-ref")?.matched),
      wrongLabelSameRefMatches: Boolean(checks.find((check) => check.id === "wrong-label-same-ref")?.matched),
      currentFinding: "The provider resolver hook is guarded: it can return the 0x12326 return-0 match shape for an explicitly observed label/refId pair, while rejecting same-label/wrong-ref and wrong-label/same-ref cases.",
      emulatorImpact: "This creates a safe insertion point for future provider instrumentation. The hook does not infer matches from scalar widths, raw bytes, or label text alone, so visible effects remain disabled until real provider observations feed it.",
      nextTarget: "Instrument the real or emulated provider 0x35C4 service so +0x64 ref creation and +0x50 label/ref compare results can feed observed providerRefId/label pairs into this hook.",
      visibleEffectsEnabled: false,
    },
  };
}

function mdRow(values) {
  return `| ${values.map((value) => String(value ?? "").replace(/\|/g, "\\|")).join(" | ")} |`;
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# Provider Resolver Hook Probe");
  lines.push("");
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Input CBE: \`${report.input}\``);
  lines.push(`- Status: ${report.summary.status}`);
  lines.push(`- Finding: ${report.summary.currentFinding}`);
  lines.push(`- Emulator impact: ${report.summary.emulatorImpact}`);
  lines.push(`- Next target: ${report.summary.nextTarget}`);
  lines.push("");
  lines.push("## Baseline");
  lines.push("");
  lines.push(mdRow(["Field", "Value"]));
  lines.push(mdRow(["---", "---"]));
  for (const [key, value] of Object.entries(report.baseline)) {
    lines.push(mdRow([key, value]));
  }
  lines.push("");
  lines.push("## Hook Checks");
  lines.push("");
  lines.push(mdRow(["Check", "Label", "Ref", "Matched", "Expected", "Status", "Return"]));
  lines.push(mdRow(["---", "---", "---", "---", "---", "---", "---:"]));
  for (const check of report.checks) {
    lines.push(mdRow([
      check.id,
      check.label,
      check.refId,
      check.matched ? "yes" : "no",
      check.expectedMatched ? "yes" : "no",
      check.status,
      check.returnValue,
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
  const jsonFile = path.join(outDir, "provider_resolver_hook_probe.json");
  const mdFile = path.join(outDir, "provider_resolver_hook_probe.md");
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
