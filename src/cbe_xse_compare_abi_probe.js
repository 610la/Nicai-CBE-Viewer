const fs = require("fs");
const path = require("path");

const COMPARE_SERVICE_JSON = path.resolve(__dirname, "out_godwar_xsecomparesvc", "xse_compare_service_probe.json");
const PROVIDER_ABI_SHIM_JSON = path.resolve(__dirname, "out_godwar_providerabishim", "provider_abi_shim_probe.json");
const ENTRY_SAFETY_JSON = path.resolve(__dirname, "out_godwar_xseentrysafety", "xse_entry_safety_probe.json");
const REF_WIDTH_SAFETY_JSON = path.resolve(__dirname, "out_godwar_xserefwidthsafety", "xse_ref_width_safety_probe.json");
const DEFAULT_OUT = path.resolve(__dirname, "out_godwar_xsecompareabi");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function slotOf(window) {
  return window?.slot || "";
}

function shapeKind(window) {
  const role = window?.role || "";
  const shape = window?.shape || "";
  if (/label.*compare|caller-label/i.test(role) || /caller label pointer/i.test(shape)) return "label-ref-compare";
  if (/cursor.*reader|stream,cursor/i.test(role) || /converted stream/i.test(shape)) return "stream-cursor-read";
  return "unknown";
}

function compactWindow(window) {
  return {
    name: window.name,
    site: window.startHex || "",
    end: window.endHex || "",
    slot: window.slot || "",
    role: window.role || "",
    shape: window.shape || "",
    kind: shapeKind(window),
    return0Match: Boolean(window.hasReturnZeroMatch),
  };
}

function buildBranchContract(windows) {
  const plus50 = windows.filter((window) => slotOf(window) === "+0x50");
  const streamReads = plus50.filter((window) => shapeKind(window) === "stream-cursor-read");
  const compares = plus50.filter((window) => shapeKind(window) === "label-ref-compare");
  return {
    slot: "[sb+0x35C4]+0x50",
    providerMethod: "providerApi+0x64 -> reader/open/cursor service",
    branchRule: "dispatch by argument shape, not by vtable slot alone",
    streamCursorRead: {
      count: streamReads.length,
      signature: "r0=converted stream, r1=&cursor",
      returnValue: "numeric token/scalar and an advanced cursor",
      sites: streamReads.map(compactWindow),
    },
    labelRefCompare: {
      count: compares.length,
      signature: "r0=caller label pointer, r1=script+0x64 record+0x10",
      returnValue: "0 means match; nonzero means keep scanning",
      sites: compares.map(compactWindow),
    },
  };
}

function readerServiceMethods(providerShim) {
  return providerShim.serviceObjects?.readerService?.methods || {};
}

function buildReport() {
  const compareService = readJson(COMPARE_SERVICE_JSON);
  const providerShim = readJson(PROVIDER_ABI_SHIM_JSON);
  const entrySafety = readJson(ENTRY_SAFETY_JSON);
  const refWidthSafety = readJson(REF_WIDTH_SAFETY_JSON);
  const windows = compareService.windows || [];
  const branchContract = buildBranchContract(windows);
  const methods = readerServiceMethods(providerShim);
  const shimPlus50Text = methods["+0x50"] || "";
  const compareBranchMissingFromShim = !/compare|label|ref/i.test(shimPlus50Text);
  const streamRoleCount = branchContract.streamCursorRead.count;
  const compareRoleCount = branchContract.labelRefCompare.count;
  const status = compareRoleCount && compareBranchMissingFromShim
    ? "compare-abi-branch-needed"
    : compareRoleCount
    ? "compare-abi-branch-documented"
    : "compare-abi-compare-unseen";
  const shimBranchFinding = compareBranchMissingFromShim
    ? `The current provider ABI shim documents +0x50 as "${shimPlus50Text || "unknown"}", so it still needs an explicit label/ref compare branch.`
    : `The provider ABI shim now documents +0x50 as "${shimPlus50Text}", so the remaining blocker is the ref namespace behind script+0x64 record+0x10.`;
  const nextTarget = compareBranchMissingFromShim
    ? "Extend the host-provider reader service contract with a +0x50 label/ref compare branch, then recover the ref namespace used by script+0x64 record+0x10 instead of treating it as a raw scalar width."
    : "Recover the ref namespace used by script+0x64 record+0x10 and route 0x12326 label/ref comparisons through the provider reader service instead of guessed scalar width transforms.";

  return {
    schema: "nicai.cbe.xseCompareAbiProbe.v1",
    generatedAt: new Date().toISOString(),
    inputs: {
      compareService: COMPARE_SERVICE_JSON,
      providerAbiShim: PROVIDER_ABI_SHIM_JSON,
      entrySafety: ENTRY_SAFETY_JSON,
      refWidthSafety: REF_WIDTH_SAFETY_JSON,
    },
    providerReaderService: {
      global: providerShim.serviceObjects?.readerService?.global || "0x35C4",
      providerMethod: providerShim.serviceObjects?.readerService?.providerMethod || "providerApi+0x64",
      documentedMethods: methods,
      plus50Documentation: shimPlus50Text,
      compareBranchMissingFromShim,
    },
    branchContract,
    summary: {
      status,
      plus50RoleCount: compareService.summary?.plus50RoleCount || 0,
      streamCursorReadCount: streamRoleCount,
      labelRefCompareCount: compareRoleCount,
      compareReturnsZeroOnMatch: Boolean(compareService.summary?.compareReturnsZeroOnMatch),
      compareBranchMissingFromShim,
      refWidthFirstSafeMatchCount: refWidthSafety.summary?.firstSafeMatchCount || 0,
      refWidthSafeMatchCount: refWidthSafety.summary?.safeMatchCount || 0,
      entryPromotableCount: entrySafety.summary?.promotablePrimaryCount || 0,
      currentFinding: `[sb+0x35C4]+0x50 is a shape-polymorphic reader/compare method: ${streamRoleCount} stream,cursor read window(s) and ${compareRoleCount} label/ref compare window(s). ${shimBranchFinding}`,
      emulatorImpact: "A generic CBE emulator must model the provider-returned reader service as a host ABI with a +0x50 dispatcher: stream/cursor calls read tokens, while label/ref calls compare caller labels against +0x64 entry refs. Width-grid guessing cannot replace this service branch.",
      nextTarget,
      entrySafetyFinding: entrySafety.summary?.currentFinding || "",
      refWidthSafetyFinding: refWidthSafety.summary?.currentFinding || "",
      compareServiceFinding: compareService.summary?.currentFinding || "",
    },
  };
}

function mdRow(cells) {
  return `| ${cells.map((cell) => String(cell ?? "").replace(/\|/g, "\\|")).join(" | ")} |`;
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# XSE Compare ABI Probe");
  lines.push("");
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Status: ${report.summary.status}`);
  lines.push(`- Finding: ${report.summary.currentFinding}`);
  lines.push(`- Emulator impact: ${report.summary.emulatorImpact}`);
  lines.push(`- Next target: ${report.summary.nextTarget}`);
  lines.push("");
  lines.push("## +0x50 Branch Contract");
  lines.push("");
  lines.push(`- Slot: ${report.branchContract.slot}`);
  lines.push(`- Provider method: ${report.branchContract.providerMethod}`);
  lines.push(`- Rule: ${report.branchContract.branchRule}`);
  lines.push("");
  lines.push(mdRow(["Kind", "Count", "Signature", "Return"]));
  lines.push(mdRow(["---", "---:", "---", "---"]));
  lines.push(mdRow([
    "stream-cursor-read",
    report.branchContract.streamCursorRead.count,
    report.branchContract.streamCursorRead.signature,
    report.branchContract.streamCursorRead.returnValue,
  ]));
  lines.push(mdRow([
    "label-ref-compare",
    report.branchContract.labelRefCompare.count,
    report.branchContract.labelRefCompare.signature,
    report.branchContract.labelRefCompare.returnValue,
  ]));
  lines.push("");
  lines.push("## Call Windows");
  lines.push("");
  lines.push(mdRow(["Site", "Slot", "Kind", "Role", "Return0 match"]));
  lines.push(mdRow(["---", "---", "---", "---", "---"]));
  for (const window of [
    ...report.branchContract.streamCursorRead.sites,
    ...report.branchContract.labelRefCompare.sites,
  ]) {
    lines.push(mdRow([window.site, window.slot, window.kind, window.role, window.return0Match ? "yes" : "no"]));
  }
  lines.push("");
  lines.push("## Source Findings");
  lines.push("");
  lines.push(`- Compare service: ${report.summary.compareServiceFinding}`);
  lines.push(`- Entry safety: ${report.summary.entrySafetyFinding}`);
  lines.push(`- Ref width safety: ${report.summary.refWidthSafetyFinding}`);
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

function main(argv = process.argv.slice(2)) {
  const outDir = path.resolve(argv[0] || DEFAULT_OUT);
  fs.mkdirSync(outDir, { recursive: true });
  const report = buildReport();
  const jsonFile = path.join(outDir, "xse_compare_abi_probe.json");
  const mdFile = path.join(outDir, "xse_compare_abi_probe.md");
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
