const fs = require("fs");
const path = require("path");
const { DEFAULT_INPUT } = require("./cbe_unpack");

const DEFAULT_OUT = path.resolve(__dirname, "out_godwar_providerrefcontext");
const PROVIDER_REPLAY_JSON = path.resolve(__dirname, "out_godwar_providerreplay", "provider_service_replay_probe.json");
const XSE_REF64_LOADER_JSON = path.resolve(__dirname, "out_godwar_xseref64loader", "xse_ref64_loader_probe.json");
const LOADER_CALLERS_JSON = path.resolve(__dirname, "out_godwar_xseloadercallers", "xse_loader_callers.json");
const PROVIDER_ABI_SHIM_JSON = path.resolve(__dirname, "out_godwar_providerabishim", "provider_abi_shim_probe.json");
const XSE_COMPARE_ABI_JSON = path.resolve(__dirname, "out_godwar_xsecompareabi", "xse_compare_abi_probe.json");
const XSE_REF_NAMESPACE_JSON = path.resolve(__dirname, "out_godwar_xserefnamespace", "xse_ref_namespace_probe.json");

function readJson(file, fallback = null) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function pickWindow(windows, needle) {
  return (windows || []).find((item) => String(item.name || "").includes(needle)) || null;
}

function pickBranch(refs, targetHex) {
  return (refs || []).find((item) => String(item.targetHex || "").toUpperCase() === targetHex.toUpperCase()) || null;
}

function compactSelectedRefRows(ref64Loader) {
  return (ref64Loader?.scripts || []).map((script) => {
    const top = script.candidates?.[0] || null;
    const selected = top?.samples?.selectedEntry || null;
    return {
      script: script.name,
      status: script.status || "",
      modeKey: top?.modeKey || "",
      selectedEntry: selected ? {
        index: selected.index,
        offset: selected.offset,
        refOffset: selected.refOffset,
        raw: selected.refRaw,
        compactValue: selected.compactValue ?? null,
        lengthTextStatus: selected.lengthTextStatus || "",
      } : null,
      entryRefTextLikeCount: top?.entryRefTextLikeCount || 0,
      finalRefTextLikeCount: top?.finalRefTextLikeCount || 0,
    };
  });
}

function buildContexts({ providerReplay, ref64Loader, loaderCallers, providerAbiShim, compareAbi, refNamespace }) {
  const sce = providerReplay?.replays?.sce || {};
  const sceRefReads = (sce.reads || []).filter((read) => read.service === "[sb+0x35C4]+0x64");
  const sceMapNames = (sce.maps || []).map((map) => map.name).filter(Boolean);
  const directChild = pickWindow(loaderCallers?.windows, "0x10B04");
  const wrapperChild = pickWindow(loaderCallers?.windows, "0x16482");
  const wrapper958 = pickBranch(loaderCallers?.directBranchRefs, "0x00000958");
  const compareBranch = compareAbi?.branchContract || {};
  const readerMethods = providerAbiShim?.serviceObjects?.readerService?.methods || {};

  return [
    {
      id: "sce-resource-name",
      service: "[sb+0x35C4]+0x64",
      callSites: sceRefReads.map((read) => read.offsetHex).filter(Boolean),
      sourceEvidence: "provider_service_replay SCE replay",
      proof: sce.status === "service-replay-ok"
        ? `SCE replay recovered ${sce.fields?.width || "?"}x${sce.fields?.height || "?"} and map refs ${sceMapNames.join(", ") || "none"}.`
        : `SCE replay status is ${sce.status || "unknown"}.`,
      returnClass: "length-prefixed resource-name text",
      cursorContract: "read one length byte, read ASCII bytes, advance cursor by 1+length",
      emulatorPolicy: "Use the text reader only in scene/resource-name contexts.",
      safeToParseAsText: true,
      consumers: ["SCE map/resource table"],
      samples: sceRefReads.map((read) => ({
        role: read.role,
        cursorBefore: read.cursorBeforeHex,
        offset: read.offsetHex,
        length: read.length,
        text: read.text,
      })),
    },
    {
      id: "xse-range-entry-ref",
      service: "[sb+0x35C4]+0x64",
      callSites: [ref64Loader?.summary?.rangeRefCallSite || "0x0001173C"].filter(Boolean),
      sourceEvidence: "xse_ref64_loader range-table ABI",
      proof: `${ref64Loader?.summary?.selectedInlineTextCount ?? 0}/${ref64Loader?.summary?.selectedEntryCount ?? 0} selected entry refs decode as inline text; field+0x10 is stored into script+0x64 records and later compared by 0x12326.`,
      returnClass: "provider-opaque entry ref",
      cursorContract: "host service consumes its own ref encoding; scalar width is not promoted",
      emulatorPolicy: "Store an opaque handle at range record +0x10 and compare only through [35C4]+0x50.",
      safeToParseAsText: false,
      consumers: ["0x12326 label/ref compare", "0x11A4A entry activation"],
      samples: compactSelectedRefRows(ref64Loader).filter((row) => row.selectedEntry),
    },
    {
      id: "xse-final-ref",
      service: "[sb+0x35C4]+0x64",
      callSites: [ref64Loader?.summary?.finalRefCallSite || ref64Loader?.loaderAbi?.finalRefs?.refReadSite || "0x00011792"].filter(Boolean),
      sourceEvidence: "xse_ref64_loader final-ref table ABI",
      proof: `0x11752 allocates count*4 at script+0x6C and stores refs read through +0x64 at ${ref64Loader?.summary?.finalRefCallSite || "0x00011792"}.`,
      returnClass: "provider-opaque final-ref handle",
      cursorContract: "host service consumes the final-ref encoding; current emulator keeps it symbolic",
      emulatorPolicy: "Do not feed final refs to the SCE text reader; preserve them as symbolic provider refs until consumers are bound.",
      safeToParseAsText: false,
      consumers: ["script+0x6C final-ref table"],
      samples: compactSelectedRefRows(ref64Loader).filter((row) => row.finalRefTextLikeCount > 0).slice(0, 4),
    },
    {
      id: "xse-child-resource-handle",
      service: "[sb+0x35C4]+0x64 / wrapper 0x958",
      callSites: [directChild?.startHex, directChild?.callHex, wrapperChild?.callHex, wrapper958?.targetHex].filter(Boolean),
      sourceEvidence: "xse_loader_callers 0x112C4 callers",
      proof: [
        directChild?.shape || "direct service-reader caller not available",
        wrapperChild?.shape || "wrapper-reader caller not available",
        wrapper958 ? `0x958 has ${wrapper958.count} direct branch references.` : "",
      ].filter(Boolean).join(" "),
      returnClass: "child resource / sub-script handle",
      cursorContract: "return value is passed as r0 into 0x112C4 with r1=record+0x0C and r2=0",
      emulatorPolicy: "Treat it as a resource/stream handle for nested object loading, not as a label compare ref.",
      safeToParseAsText: false,
      consumers: ["0x112C4 sub-script/object loader"],
      samples: [
        directChild ? { caller: directChild.name, start: directChild.startHex, call: directChild.callHex, shape: directChild.shape } : null,
        wrapperChild ? { caller: wrapperChild.name, start: wrapperChild.startHex, call: wrapperChild.callHex, shape: wrapperChild.shape } : null,
      ].filter(Boolean),
    },
  ].map((context) => ({
    ...context,
    readerMethodDoc: readerMethods["+0x64"] || "",
    compareContract: context.id === "xse-range-entry-ref"
      ? {
        service: "[sb+0x35C4]+0x50",
        argumentShape: compareBranch.argumentShape || "r0=caller label pointer, r1=script+0x64 record+0x10",
        returnZeroMeansMatch: Boolean(compareAbi?.summary?.compareReturnsZeroOnMatch),
        resolverStatus: refNamespace?.summary?.resolverBound ? "bound" : "unbound",
      }
      : null,
  }));
}

function buildReport(options = {}) {
  const input = path.resolve(options.input || DEFAULT_INPUT);
  const providerReplay = readJson(PROVIDER_REPLAY_JSON, {});
  const ref64Loader = readJson(XSE_REF64_LOADER_JSON, {});
  const loaderCallers = readJson(LOADER_CALLERS_JSON, {});
  const providerAbiShim = readJson(PROVIDER_ABI_SHIM_JSON, {});
  const compareAbi = readJson(XSE_COMPARE_ABI_JSON, {});
  const refNamespace = readJson(XSE_REF_NAMESPACE_JSON, {});
  const contexts = buildContexts({ providerReplay, ref64Loader, loaderCallers, providerAbiShim, compareAbi, refNamespace });
  const textSafe = contexts.filter((context) => context.safeToParseAsText).map((context) => context.id);
  const opaque = contexts.filter((context) => !context.safeToParseAsText).map((context) => context.id);
  return {
    schema: "nicai.cbe.providerRefContextProbe.v1",
    generatedAt: new Date().toISOString(),
    input,
    inputs: {
      providerReplay: PROVIDER_REPLAY_JSON,
      xseRef64Loader: XSE_REF64_LOADER_JSON,
      loaderCallers: LOADER_CALLERS_JSON,
      providerAbiShim: PROVIDER_ABI_SHIM_JSON,
      compareAbi: XSE_COMPARE_ABI_JSON,
      refNamespace: XSE_REF_NAMESPACE_JSON,
    },
    summary: {
      status: "provider-ref-context-split",
      contextCount: contexts.length,
      textSafeContextCount: textSafe.length,
      opaqueContextCount: opaque.length,
      textSafeContexts: textSafe,
      opaqueContexts: opaque,
      currentFinding: "Provider-returned [35C4]+0x64 has multiple call-context return classes. Only SCE resource-name refs are proven length-prefixed text; XSE range/final refs are provider-opaque; child-script reads return handles consumed by 0x112C4.",
      emulatorImpact: "A generic CBE emulator must dispatch [35C4]+0x64 by role/call site/context instead of implementing one readRef() return type. Misreading XSE refs as SCE strings would create fake entry matches and fake gameplay.",
      nextTarget: "Recover the provider-side resolver that lets [35C4]+0x50 compare caller labels against xse-range-entry-ref handles without scalar/string guesses.",
      visibleEffectsEnabled: false,
    },
    dispatchRule: {
      method: "[sb+0x35C4]+0x64",
      rule: "context-first dispatch",
      defaultForUnknownXse: "opaque-provider-ref",
      sceTextReaderAllowedOnlyFor: textSafe,
      compareBinding: {
        method: "[sb+0x35C4]+0x50",
        status: refNamespace?.summary?.status || "",
        resolverBound: Boolean(refNamespace?.summary?.resolverBound),
        visibleEffectsEnabled: Boolean(refNamespace?.summary?.visibleEffectsEnabled),
      },
    },
    contexts,
  };
}

function mdRow(values) {
  return `| ${values.map((value) => String(value ?? "").replace(/\|/g, "\\|")).join(" | ")} |`;
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# Provider +0x64 Ref Context Probe");
  lines.push("");
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Input CBE: \`${report.input}\``);
  lines.push(`- Status: ${report.summary.status}`);
  lines.push(`- Finding: ${report.summary.currentFinding}`);
  lines.push(`- Emulator impact: ${report.summary.emulatorImpact}`);
  lines.push(`- Next target: ${report.summary.nextTarget}`);
  lines.push("");
  lines.push("## Context Matrix");
  lines.push("");
  lines.push(mdRow(["Context", "Return class", "Text-safe", "Call sites", "Consumers"]));
  lines.push(mdRow(["---", "---", "---", "---", "---"]));
  for (const context of report.contexts) {
    lines.push(mdRow([
      context.id,
      context.returnClass,
      context.safeToParseAsText ? "yes" : "no",
      context.callSites.join(", "),
      context.consumers.join(", "),
    ]));
  }
  lines.push("");
  lines.push("## Dispatch Rule");
  lines.push("");
  lines.push(`- Method: ${report.dispatchRule.method}`);
  lines.push(`- Rule: ${report.dispatchRule.rule}`);
  lines.push(`- Unknown XSE refs: ${report.dispatchRule.defaultForUnknownXse}`);
  lines.push(`- SCE text reader allowed only for: ${report.dispatchRule.sceTextReaderAllowedOnlyFor.join(", ")}`);
  lines.push(`- Compare binding: ${report.dispatchRule.compareBinding.status || "-"}, resolver=${report.dispatchRule.compareBinding.resolverBound ? "bound" : "unbound"}, effects=${report.dispatchRule.compareBinding.visibleEffectsEnabled ? "enabled" : "disabled"}`);
  for (const context of report.contexts) {
    lines.push("");
    lines.push(`## ${context.id}`);
    lines.push("");
    lines.push(`- Evidence: ${context.sourceEvidence}`);
    lines.push(`- Proof: ${context.proof}`);
    lines.push(`- Cursor contract: ${context.cursorContract}`);
    lines.push(`- Emulator policy: ${context.emulatorPolicy}`);
    if (context.readerMethodDoc) lines.push(`- Reader shim doc: ${context.readerMethodDoc}`);
    if (context.compareContract) {
      lines.push(`- Compare contract: ${context.compareContract.service}, ${context.compareContract.argumentShape}, return0Match=${context.compareContract.returnZeroMeansMatch ? "yes" : "no"}, resolver=${context.compareContract.resolverStatus}`);
    }
    if (context.samples?.length) {
      lines.push("- Samples:");
      for (const sample of context.samples.slice(0, 8)) {
        lines.push(`  - ${JSON.stringify(sample)}`);
      }
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
  const jsonFile = path.join(outDir, "provider_ref_context_probe.json");
  const mdFile = path.join(outDir, "provider_ref_context_probe.md");
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
