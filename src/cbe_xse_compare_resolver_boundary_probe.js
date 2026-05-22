const fs = require("fs");
const path = require("path");
const { DEFAULT_INPUT } = require("./cbe_unpack");

const DEFAULT_OUT = path.resolve(__dirname, "out_godwar_xsecompareresolver");
const PROVIDER_SERVICE_JSON = path.resolve(__dirname, "out_godwar_xseprovidersvc", "xse_provider_service_trace.json");
const COMPARE_ABI_JSON = path.resolve(__dirname, "out_godwar_xsecompareabi", "xse_compare_abi_probe.json");
const PROVIDER_ABI_SHIM_JSON = path.resolve(__dirname, "out_godwar_providerabishim", "provider_abi_shim_probe.json");
const PROVIDER_REF_CONTEXT_JSON = path.resolve(__dirname, "out_godwar_providerrefcontext", "provider_ref_context_probe.json");

function readJson(file, fallback = null) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function findProviderAssignment(providerService, globalHex) {
  return (providerService?.providerAssignments || [])
    .find((item) => String(item.globalHex || "").toUpperCase() === String(globalHex).toUpperCase()) || null;
}

function collectCompareSamples(providerAbiShim) {
  const samples = [];
  for (const script of providerAbiShim?.replays?.xse?.scripts || []) {
    for (const candidate of script.candidates || []) {
      for (const sample of candidate.providerRefContextSamples || []) {
        for (const compare of sample.compareSamples || []) {
          samples.push({
            script: script.name,
            policy: candidate.policy,
            refContext: sample.context,
            refOffset: sample.refOffset,
            label: compare.label,
            returnValue: compare.returnValue,
            matched: Boolean(compare.matched),
            resolverStatus: compare.resolverStatus || "",
          });
        }
      }
    }
  }
  return samples;
}

function buildReport(options = {}) {
  const input = path.resolve(options.input || DEFAULT_INPUT);
  const providerService = readJson(PROVIDER_SERVICE_JSON, {});
  const compareAbi = readJson(COMPARE_ABI_JSON, {});
  const providerAbiShim = readJson(PROVIDER_ABI_SHIM_JSON, {});
  const providerRefContext = readJson(PROVIDER_REF_CONTEXT_JSON, {});
  const readerAssignment = findProviderAssignment(providerService, "0x35C4");
  const compareSite = compareAbi?.branchContract?.labelRefCompare?.sites?.[0] || {};
  const streamSites = compareAbi?.branchContract?.streamCursorRead?.sites || [];
  const compareSamples = collectCompareSamples(providerAbiShim);
  const namespace = providerAbiShim?.providerRefNamespace || {};
  const resolverHook = providerAbiShim?.resolverHook || providerAbiShim?.serviceObjects?.readerService?.resolverHook || {};
  const matchedSamples = compareSamples.filter((sample) => sample.matched || sample.returnValue === 0);
  const unboundSamples = compareSamples.filter((sample) => sample.resolverStatus === "ref-namespace-unbound");
  const resolverIsHostBoundary = Boolean(readerAssignment?.providerMethod === "+0x64" && compareSite.slot === "+0x50");
  return {
    schema: "nicai.cbe.xseCompareResolverBoundaryProbe.v1",
    generatedAt: new Date().toISOString(),
    input,
    inputs: {
      providerService: PROVIDER_SERVICE_JSON,
      compareAbi: COMPARE_ABI_JSON,
      providerAbiShim: PROVIDER_ABI_SHIM_JSON,
      providerRefContext: PROVIDER_REF_CONTEXT_JSON,
    },
    originChain: {
      hostProviderEntry: providerService?.bootCalls?.find((call) => call.targetHex === "0x00000354") || null,
      globalSetup: providerService?.windows?.find((window) => window.startHex === "0x00000354") ? "0x00000354 provider-service setup" : "",
      readerServiceAssignment: readerAssignment,
      compareLoad: {
        site: compareSite.site || "0x0001233C",
        slot: compareSite.slot || "+0x50",
        shape: compareSite.shape || "",
        returnZeroMeansMatch: Boolean(compareSite.return0Match),
      },
    },
    boundary: {
      status: resolverIsHostBoundary ? "compare-resolver-host-boundary" : "compare-resolver-boundary-uncertain",
      resolverIsHostProviderService: resolverIsHostBoundary,
      staticCbeCompareTargetKnown: false,
      providerReaderGlobal: readerAssignment?.globalHex || "0x35C4",
      providerReaderMethod: readerAssignment?.providerMethod || "",
      compareSlot: compareSite.slot || "+0x50",
      streamShapeCount: streamSites.length,
      labelRefShapeCount: compareAbi?.summary?.labelRefCompareCount || 0,
      compareReturnsZeroOnMatch: Boolean(compareAbi?.summary?.compareReturnsZeroOnMatch),
      shimCompareSampleCount: compareSamples.length,
      shimMatchedSampleCount: matchedSamples.length,
      shimUnboundSampleCount: unboundSamples.length,
      ledgerRefCount: namespace.refCount || 0,
      ledgerOpaqueRefCount: namespace.opaqueRefCount || 0,
      ledgerCompareCount: namespace.compareCount || 0,
      ledgerUnboundCompareCount: namespace.unboundCompareCount || 0,
      resolverHookMode: resolverHook.mode || "",
      resolverHookBound: Boolean(resolverHook.bound),
      visibleEffectsEnabled: Boolean(providerRefContext?.summary?.visibleEffectsEnabled),
    },
    providerRefNamespace: {
      namespaceId: namespace.namespaceId || "",
      refCount: namespace.refCount || 0,
      opaqueRefCount: namespace.opaqueRefCount || 0,
      textRefCount: namespace.textRefCount || 0,
      compareCount: namespace.compareCount || 0,
      compareMatchCount: namespace.compareMatchCount || 0,
      unboundCompareCount: namespace.unboundCompareCount || 0,
      contexts: namespace.contexts || [],
      refs: (namespace.refs || []).slice(0, 24),
      compares: (namespace.compares || []).slice(0, 24),
    },
    compareSamples: compareSamples.slice(0, 24),
    summary: {
      status: resolverIsHostBoundary ? "compare-resolver-host-boundary" : "compare-resolver-boundary-uncertain",
      currentFinding: "The 0x12326 label/ref compare does not call a statically recovered CBE resolver. It loads +0x50 from the provider-returned 0x35C4 reader service, and the ABI shim now records +0x64 ref producers and +0x50 compare consumers in one provider namespace ledger.",
      emulatorImpact: "The generic emulator should keep the resolver behind the host-provider ABI boundary. Static scalar/string ref guesses remain diagnostics only; real promotion needs either runtime instrumentation of the provider service object or a host-service resolver contract derived from observed ledger matches.",
      nextTarget: "Feed the observed-match-only provider resolver hook with real +0x64/+0x50 service observations, then promote entries only from observed return-0 label/ref pairs.",
      providerReaderGlobal: readerAssignment?.globalHex || "0x35C4",
      providerReaderMethod: readerAssignment?.providerMethod || "+0x64",
      compareSite: compareSite.site || "0x0001233C",
      compareSlot: compareSite.slot || "+0x50",
      shimCompareSampleCount: compareSamples.length,
      shimMatchedSampleCount: matchedSamples.length,
      shimUnboundSampleCount: unboundSamples.length,
      ledgerRefCount: namespace.refCount || 0,
      ledgerCompareCount: namespace.compareCount || 0,
      resolverHookMode: resolverHook.mode || "unbound-observed-match-only",
      resolverHookBound: Boolean(resolverHook.bound),
      visibleEffectsEnabled: Boolean(providerRefContext?.summary?.visibleEffectsEnabled),
    },
  };
}

function mdRow(values) {
  return `| ${values.map((value) => String(value ?? "").replace(/\|/g, "\\|")).join(" | ")} |`;
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# XSE Compare Resolver Boundary Probe");
  lines.push("");
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Input CBE: \`${report.input}\``);
  lines.push(`- Status: ${report.summary.status}`);
  lines.push(`- Finding: ${report.summary.currentFinding}`);
  lines.push(`- Emulator impact: ${report.summary.emulatorImpact}`);
  lines.push(`- Next target: ${report.summary.nextTarget}`);
  lines.push("");
  lines.push("## Origin Chain");
  lines.push("");
  lines.push(`- Host entry: ${report.originChain.hostProviderEntry?.siteHex || "-"} -> ${report.originChain.hostProviderEntry?.targetHex || "-"}`);
  lines.push(`- Global setup: ${report.originChain.globalSetup || "-"}`);
  lines.push(`- Reader assignment: ${report.originChain.readerServiceAssignment?.globalHex || "-"} <= ${report.originChain.readerServiceAssignment?.expression || "-"}`);
  lines.push(`- Compare load: ${report.originChain.compareLoad.site} ${report.originChain.compareLoad.slot}; ${report.originChain.compareLoad.shape}`);
  if (report.providerRefNamespace?.namespaceId) {
    lines.push(`- Provider namespace ledger: ${report.providerRefNamespace.namespaceId}; refs=${report.providerRefNamespace.refCount}, opaque=${report.providerRefNamespace.opaqueRefCount}, compares=${report.providerRefNamespace.compareCount}, matches=${report.providerRefNamespace.compareMatchCount}, unbound=${report.providerRefNamespace.unboundCompareCount}`);
  }
  lines.push(`- Resolver hook: mode=${report.summary.resolverHookMode}, bound=${report.summary.resolverHookBound ? "yes" : "no"}`);
  lines.push("");
  lines.push("## Boundary");
  lines.push("");
  lines.push(mdRow(["Field", "Value"]));
  lines.push(mdRow(["---", "---"]));
  for (const [key, value] of Object.entries(report.boundary)) {
    lines.push(mdRow([key, Array.isArray(value) ? value.join(", ") : value]));
  }
  if (report.compareSamples.length) {
    lines.push("");
    lines.push("## Shim Compare Samples");
    lines.push("");
    lines.push(mdRow(["Script", "Policy", "Ref", "Label", "Return", "Resolver"]));
    lines.push(mdRow(["---", "---", "---", "---", "---:", "---"]));
    for (const sample of report.compareSamples) {
      lines.push(mdRow([
        sample.script,
        sample.policy,
        `${sample.refContext}@${sample.refOffset}`,
        sample.label,
        sample.returnValue,
        sample.resolverStatus,
      ]));
    }
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
  const jsonFile = path.join(outDir, "xse_compare_resolver_boundary_probe.json");
  const mdFile = path.join(outDir, "xse_compare_resolver_boundary_probe.md");
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
