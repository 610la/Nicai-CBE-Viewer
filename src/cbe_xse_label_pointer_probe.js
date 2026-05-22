const fs = require("fs");
const path = require("path");
const { DEFAULT_INPUT } = require("./cbe_unpack");

const ENTRY_COMPARE_JSON = path.resolve(__dirname, "out_godwar_xseentrycompare", "xse_entry_compare_probe.json");
const ENTRY_CALLER_JSON = path.resolve(__dirname, "out_godwar_xseentrycallers", "xse_entry_caller_probe.json");
const COMPARE_SHIM_JSON = path.resolve(__dirname, "out_godwar_xsecompareshim", "xse_compare_shim_probe.json");
const DEFAULT_OUT = path.resolve(__dirname, "out_godwar_xselabelpointer");

function hex(n, width = 8) {
  if (!Number.isFinite(n) || n < 0) return "";
  return `0x${n.toString(16).toUpperCase().padStart(width, "0")}`;
}

function parseHex(text) {
  if (typeof text !== "string") return NaN;
  const match = text.match(/^0x([0-9a-f]+)$/i);
  return match ? parseInt(match[1], 16) : NaN;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function normalizeLabel(text) {
  const raw = String(text || "").trim();
  const lower = raw.toLowerCase();
  if (lower === "init") return "INIT";
  if (lower === "_main" || lower === "main") return "_MAIN";
  return raw.toUpperCase();
}

function readAscii(data, start, limit = 48) {
  if (!Number.isFinite(start) || start < 0 || start >= data.length) return "";
  const out = [];
  for (let pos = start; pos < data.length && out.length < limit; pos += 1) {
    const value = data[pos];
    if (value === 0) break;
    if (value < 0x20 || value > 0x7e) break;
    out.push(String.fromCharCode(value));
  }
  return out.join("");
}

function rawBytes(data, start, end) {
  const lo = Math.max(0, start);
  const hi = Math.min(data.length, end);
  return Array.from(data.subarray(lo, hi), (value) => value.toString(16).toUpperCase().padStart(2, "0")).join(" ");
}

function bestNearby(profile) {
  const nearby = profile.nearby || [];
  return nearby.find((item) => {
    const label = normalizeLabel(item.text);
    return label === "INIT" || label === "_MAIN";
  }) || nearby[0] || null;
}

function parseAdrArg(call) {
  const labelArg = call?.labelArg || {};
  const address = parseHex(labelArg.address);
  const immMatch = String(labelArg.instruction || "").match(/#0x([0-9a-f]+)/i);
  const imm = immMatch ? parseInt(immMatch[1], 16) : NaN;
  if (!Number.isFinite(address) || !Number.isFinite(imm)) return null;
  return {
    address,
    addressHex: labelArg.address || "",
    instruction: labelArg.instruction || "",
    imm,
    officialThumbTarget: ((address + 4) & ~3) + imm,
    pcPlus2DiagnosticTarget: address + 2 + imm,
  };
}

function classifyProfile(profile, data, callerByCall) {
  const target = parseHex(profile.target);
  const exactText = readAscii(data, target);
  const best = bestNearby(profile);
  const bestStart = parseHex(best?.start);
  const caller = callerByCall.get(profile.call) || null;
  const adrArg = parseAdrArg(caller);
  const requested = normalizeLabel(profile.requestedLabel);
  const nearestFull = normalizeLabel(best?.text);
  const delta = Number.isFinite(bestStart) && Number.isFinite(target) ? target - bestStart : null;
  const pcPlus2Delta = adrArg && Number.isFinite(bestStart) ? adrArg.pcPlus2DiagnosticTarget - bestStart : null;
  const pcPlus2Text = adrArg ? readAscii(data, adrArg.pcPlus2DiagnosticTarget) : "";
  const containsTarget = Boolean(best && best.containsTarget);
  const targetInsideFullLabel = Boolean(
    Number.isFinite(delta)
    && delta >= 0
    && exactText
    && best?.text
    && best.text.toLowerCase().slice(delta) === exactText.toLowerCase()
  );
  const exactFullLabel = Boolean(exactText && normalizeLabel(exactText) === requested);
  let classification = "no-nearby-label";
  if (exactFullLabel) {
    classification = "exact-full-label";
  } else if (targetInsideFullLabel && containsTarget) {
    classification = "interior-suffix-pointer";
  } else if (best && !containsTarget && Number.isFinite(delta) && delta < 0) {
    classification = "pretarget-before-full-label";
  } else if (best) {
    classification = "nearby-inferred-label";
  }
  let alignmentClass = "no-adr-arg";
  if (adrArg) {
    if (pcPlus2Delta === 0 && normalizeLabel(pcPlus2Text) === nearestFull) {
      alignmentClass = "pc-plus2-diagnostic-hits-full-label";
    } else if (pcPlus2Delta != null) {
      alignmentClass = "pc-plus2-diagnostic-mismatch";
    }
  }

  return {
    call: profile.call,
    helper: profile.helper,
    helperRole: profile.helperRole || "",
    target: profile.target,
    targetOffset: target,
    exactTextAtTarget: exactText || profile.exactTextAtTarget || "",
    requestedLabel: requested,
    nearestFullLabel: nearestFull,
    nearestFullStart: best?.start || "",
    pointerDeltaToFullLabel: delta,
    containsTarget,
    targetInsideFullLabel,
    classification,
    adr: adrArg ? {
      address: adrArg.addressHex,
      instruction: adrArg.instruction,
      imm: hex(adrArg.imm, 0),
      officialThumbTarget: hex(adrArg.officialThumbTarget),
      pcPlus2DiagnosticTarget: hex(adrArg.pcPlus2DiagnosticTarget),
      pcPlus2DiagnosticText: pcPlus2Text,
      pcPlus2DeltaToFullLabel: pcPlus2Delta,
      alignmentClass,
    } : null,
    twoBytesBeforeTarget: Number.isFinite(target) ? rawBytes(data, target - 2, target) : "",
    bytesAroundTarget: Number.isFinite(target) ? rawBytes(data, target - 8, target + 16) : "",
    asciiAtFullStart: Number.isFinite(bestStart) ? readAscii(data, bestStart) : "",
    nearby: profile.nearby || [],
  };
}

function loadCompareShimConsequences() {
  if (!fs.existsSync(COMPARE_SHIM_JSON)) {
    return {
      available: false,
      reason: "compare shim probe has not been generated",
    };
  }
  const shim = readJson(COMPARE_SHIM_JSON);
  return {
    available: true,
    status: shim.summary?.status || "",
    primaryModel: shim.summary?.primaryModel || "",
    scriptCount: shim.summary?.scriptCount || 0,
    exactAdrSelectedCount: shim.summary?.exactAdrSelectedCount || 0,
    selectedSafeScripts: shim.summary?.selectedSafeScripts || [],
    selectedWritebackRiskScripts: shim.summary?.selectedWritebackRiskScripts || [],
    selectedImplausibleScripts: shim.summary?.selectedImplausibleScripts || [],
    allStrongImplausibleScripts: shim.summary?.allStrongImplausibleScripts || [],
    currentFinding: shim.summary?.currentFinding || "",
  };
}

function loadEntryCallerNotes() {
  if (!fs.existsSync(ENTRY_CALLER_JSON)) {
    return {
      available: false,
      reason: "entry caller probe has not been generated",
    };
  }
  const caller = readJson(ENTRY_CALLER_JSON);
  return {
    available: true,
    status: caller.summary?.status || "",
    callCount: caller.summary?.callCount || 0,
    semanticLabels: caller.summary?.semanticLabels || [],
    currentFinding: caller.summary?.currentFinding || "",
  };
}

function buildReport(options = {}) {
  const input = path.resolve(options.input || DEFAULT_INPUT);
  const data = fs.readFileSync(input);
  const compare = readJson(ENTRY_COMPARE_JSON);
  const caller = fs.existsSync(ENTRY_CALLER_JSON) ? readJson(ENTRY_CALLER_JSON) : { calls: [] };
  const callerByCall = new Map((caller.calls || []).map((call) => [call.callHex, call]));
  const profiles = (compare.callerLabelProfiles || []).map((profile) => classifyProfile(profile, data, callerByCall));
  const exactFullLabelCount = profiles.filter((profile) => profile.classification === "exact-full-label").length;
  const nonZeroDeltaCount = profiles.filter((profile) => profile.pointerDeltaToFullLabel !== 0).length;
  const suffixPointerCount = profiles.filter((profile) => profile.classification === "interior-suffix-pointer").length;
  const pretargetMismatchCount = profiles.filter((profile) => profile.classification === "pretarget-before-full-label").length;
  const pcPlus2FullLabelCount = profiles.filter((profile) => profile.adr?.alignmentClass === "pc-plus2-diagnostic-hits-full-label").length;
  const pcPlus2MismatchCount = profiles.filter((profile) => profile.adr?.alignmentClass === "pc-plus2-diagnostic-mismatch").length;
  const compareShim = loadCompareShimConsequences();
  const entryCaller = loadEntryCallerNotes();
  return {
    schema: "nicai.cbe.xseLabelPointerProbe.v1",
    generatedAt: new Date().toISOString(),
    inputs: {
      input,
      entryCompare: ENTRY_COMPARE_JSON,
      entryCallers: ENTRY_CALLER_JSON,
      compareShim: COMPARE_SHIM_JSON,
    },
    summary: {
      status: exactFullLabelCount === profiles.length ? "label-pointer-exact" : "label-pointer-normalization-needed",
      profileCount: profiles.length,
      exactFullLabelCount,
      nonZeroDeltaCount,
      suffixPointerCount,
      pretargetMismatchCount,
      pcPlus2FullLabelCount,
      pcPlus2MismatchCount,
      exactAdrSelectedCount: compareShim.available ? compareShim.exactAdrSelectedCount : 0,
      compareShimPrimaryModel: compareShim.available ? compareShim.primaryModel : "",
      compareShimWritebackRiskCount: compareShim.available ? compareShim.selectedWritebackRiskScripts.length : 0,
      compareShimSafeCount: compareShim.available ? compareShim.selectedSafeScripts.length : 0,
      currentFinding: `${nonZeroDeltaCount}/${profiles.length} label-entry caller pointer(s) do not land on the recovered full label start; ${suffixPointerCount} point inside Init/_main and ${pretargetMismatchCount} point before the nearby full label. A diagnostic address+2+imm back-computation reaches the full label for ${pcPlus2FullLabelCount}/${profiles.length}, but exact ADR-target text still selects ${compareShim.available ? `${compareShim.exactAdrSelectedCount}/${compareShim.scriptCount}` : "unknown"} focused script(s), while the current inferred full-label shim remains unsafe.`,
      emulatorImpact: "A generic CBE emulator should not promote nearby full labels as exact compare inputs yet. The +0x50 compare provider likely normalizes or interprets these pointers/refs, and that ABI must be recovered before entry activation can drive visible effects.",
      nextTarget: "Trace the concrete [sb+0x35C4]+0x50 provider implementation or add an argument-shape emulator that can prove how suffix/pretarget label pointers compare with script+0x64 record+0x10 refs.",
    },
    entryCaller,
    compareShim,
    pointerProfiles: profiles,
  };
}

function mdRow(cells) {
  return `| ${cells.map((cell) => String(cell ?? "").replace(/\|/g, "\\|")).join(" | ")} |`;
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# XSE Label Pointer Probe");
  lines.push("");
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Status: ${report.summary.status}`);
  lines.push(`- Finding: ${report.summary.currentFinding}`);
  lines.push(`- Emulator impact: ${report.summary.emulatorImpact}`);
  lines.push(`- Next target: ${report.summary.nextTarget}`);
  lines.push("");
  lines.push("## Caller Pointer Shape");
  lines.push("");
  lines.push(mdRow(["Call", "Helper", "ADR target", "Exact text", "Full label", "Delta", "PC+2 diag", "Class", "Bytes before"]));
  lines.push(mdRow(["---", "---", "---", "---", "---", "---:", "---", "---", "---"]));
  for (const profile of report.pointerProfiles) {
    lines.push(mdRow([
      profile.call,
      profile.helper,
      profile.target,
      profile.exactTextAtTarget || "-",
      profile.nearestFullLabel ? `${profile.nearestFullLabel}@${profile.nearestFullStart}` : "-",
      profile.pointerDeltaToFullLabel ?? "-",
      profile.adr ? `${profile.adr.pcPlus2DiagnosticTarget}:${profile.adr.pcPlus2DiagnosticText || "-"} delta=${profile.adr.pcPlus2DeltaToFullLabel ?? "-"}` : "-",
      profile.classification,
      profile.twoBytesBeforeTarget || "-",
    ]));
  }
  lines.push("");
  lines.push("## Model Consequence");
  lines.push("");
  if (report.compareShim.available) {
    lines.push(`- Compare shim: ${report.compareShim.status}; primary=${report.compareShim.primaryModel || "-"}`);
    lines.push(`- Exact ADR text selected ${report.compareShim.exactAdrSelectedCount}/${report.compareShim.scriptCount}; primary inferred full-label model safe=${report.compareShim.selectedSafeScripts.length}/${report.compareShim.scriptCount}, writeback-risk=${report.compareShim.selectedWritebackRiskScripts.length}/${report.compareShim.scriptCount}, implausible under all-strong=${report.compareShim.allStrongImplausibleScripts.length}/${report.compareShim.scriptCount}.`);
  } else {
    lines.push(`- Compare shim unavailable: ${report.compareShim.reason}`);
  }
  lines.push("");
  lines.push("## Raw Windows");
  for (const profile of report.pointerProfiles) {
    lines.push("");
    lines.push(`### ${profile.call} -> ${profile.helper}`);
    lines.push("");
    lines.push(`- Target: ${profile.target}; exact=${profile.exactTextAtTarget || "-"}; full=${profile.asciiAtFullStart || "-"}; class=${profile.classification}`);
    lines.push("");
    lines.push("```text");
    lines.push(`${hex(profile.targetOffset - 8)}  ${profile.bytesAroundTarget}`);
    lines.push("```");
  }
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
  const jsonFile = path.join(outDir, "xse_label_pointer_probe.json");
  const mdFile = path.join(outDir, "xse_label_pointer_probe.md");
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
