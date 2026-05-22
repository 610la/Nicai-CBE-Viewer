const fs = require("fs");
const path = require("path");

const COMPARE_SHIM_JSON = path.resolve(__dirname, "out_godwar_xsecompareshim", "xse_compare_shim_probe.json");
const ENTRYPOINT_JSON = path.resolve(__dirname, "out_godwar_xseentrypoint", "xse_entrypoint_probe.json");
const SLOT_LIFECYCLE_JSON = path.resolve(__dirname, "out_godwar_xseslotlifecycle", "xse_slot_lifecycle_probe.json");
const DEFAULT_OUT = path.resolve(__dirname, "out_godwar_xseactivation");

const PRIMARY_MODEL_ID = "nearby-full-label/text-payload";
const BROAD_MODEL_ID = "nearby-full-label/all-strong";

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function selectedFromModel(script, modelId) {
  const model = (script.models || []).find((item) => item.id === modelId);
  return model?.bestSelection?.selected || null;
}

function effectForSelection(selected, groupCount) {
  if (!selected) return null;
  const groupCursor = selected.groupCursor;
  const stackSpan = selected.stackSpan;
  const cursorValid = Number.isInteger(groupCursor) && groupCursor >= 0 && groupCursor < groupCount;
  const stackDelta = Number.isFinite(stackSpan) ? stackSpan + 1 : null;
  return {
    selectedIndex: selected.index,
    selectedOffset: selected.offset,
    ref: selected.ref,
    matches: selected.matches || [],
    recordFields: {
      field00GroupCursor: groupCursor,
      field04Kind: selected.kind ?? null,
      field08StackSpan: stackSpan ?? null,
      field10Ref: selected.ref,
    },
    activationWrites: {
      script50GroupCursor: groupCursor,
      script5cDelta: stackDelta,
      script60Delta: stackDelta,
      runtimeRecordStackPush: "+0x54[old +0x5C] receives a transformed copy before +0x5C advances",
    },
    cursorValid,
    riskKind: selected.riskKind || "unknown",
    effectSafeForDispatch: cursorValid && selected.riskKind === "selected-safe",
  };
}

function functionByEntry(slotLifecycle, entry) {
  return (slotLifecycle.functions || []).find((fn) => fn.entry === entry) || null;
}

function buildReport() {
  const compareShim = readJson(COMPARE_SHIM_JSON);
  const entrypoint = readJson(ENTRYPOINT_JSON);
  const slotLifecycle = readJson(SLOT_LIFECYCLE_JSON);
  const groupCounts = new Map((entrypoint.scripts || []).map((script) => [script.name, script.groupCount || 0]));
  const scripts = (compareShim.scripts || []).map((script) => {
    const groupCount = groupCounts.get(script.name) || 0;
    const primarySelection = selectedFromModel(script, PRIMARY_MODEL_ID);
    const broadSelection = selectedFromModel(script, BROAD_MODEL_ID);
    return {
      name: script.name,
      groupCount,
      primaryModel: PRIMARY_MODEL_ID,
      primaryEffect: effectForSelection(primarySelection, groupCount),
      broadModel: BROAD_MODEL_ID,
      broadEffect: effectForSelection(broadSelection, groupCount),
    };
  });
  const primaryEffects = scripts.map((script) => script.primaryEffect).filter(Boolean);
  const primarySafe = scripts.filter((script) => script.primaryEffect?.effectSafeForDispatch);
  const primaryRisk = scripts.filter((script) => script.primaryEffect && !script.primaryEffect.effectSafeForDispatch);
  const broadInvalid = scripts.filter((script) => script.broadEffect && !script.broadEffect.cursorValid);
  const tailSelect = functionByEntry(slotLifecycle, "0x00011A4A");
  const cursorAdjust = functionByEntry(slotLifecycle, "0x00011252");
  return {
    schema: "nicai.cbe.xseActivationProbe.v1",
    generatedAt: new Date().toISOString(),
    inputs: {
      compareShim: COMPARE_SHIM_JSON,
      entrypoint: ENTRYPOINT_JSON,
      slotLifecycle: SLOT_LIFECYCLE_JSON,
    },
    summary: {
      status: primarySafe.length ? "activation-selection-partial" : primaryRisk.length ? "activation-selection-blocked" : "activation-selection-unmatched",
      scriptCount: scripts.length,
      primaryModel: PRIMARY_MODEL_ID,
      primarySelectedScripts: scripts.filter((script) => script.primaryEffect).map((script) => script.name),
      primarySafeScripts: primarySafe.map((script) => script.name),
      primaryRiskScripts: primaryRisk.map((script) => script.name),
      broadInvalidScripts: broadInvalid.map((script) => script.name),
      currentFinding: primaryEffects.length
        ? `0x11A4A side effects are formula-bound for ${primaryEffects.length}/${scripts.length} primary compare-shim selection(s): selected record+0x00 restores script+0x50, and record+0x08+1 advances +0x5C/+0x60 through 0x11252. None are safe for visible dispatch yet.`
        : `No primary compare-shim selections are ready for 0x11A4A activation.`,
      emulatorImpact: "A generic emulator can model the 0x11A4A state transition, but it must still refuse visible effects when the selected entry is unmatched, implausible, or leads to writeback-risk dispatch.",
      nextTarget: "Use these activation formulas to test candidate +0x64 ref encodings and operand record boundaries; promote a script entry only when compare selection and activated dispatch are both safe.",
    },
    activationContract: {
      helper: "0x00011A4A",
      selectedRecordCopy: "0x11954 copies script+0x64[selectedIndex] (0x14 bytes) to a local record",
      stackPush: "0x11A0E writes a transformed record to script+0x54[script+0x5C] and increments +0x5C",
      cursorSeed: "0x11252 adds selected record+0x08+1 into script+0x5C and mirrors it to +0x60",
      groupCursorRestore: "0x11AA8 stores selected record+0x00 into script+0x50",
      tailSelectEvents: tailSelect?.events || [],
      cursorAdjustEvents: cursorAdjust?.events || [],
    },
    scripts,
  };
}

function mdRow(cells) {
  return `| ${cells.map((cell) => String(cell ?? "").replace(/\|/g, "\\|")).join(" | ")} |`;
}

function renderEffect(effect) {
  if (!effect) return "-";
  const match = (effect.matches || []).map((item) => `${item.label}:${item.transform}`).join(",");
  return `entry${effect.selectedIndex} cursor=${effect.recordFields.field00GroupCursor}/${effect.cursorValid ? "valid" : "invalid"} delta=${effect.activationWrites.script5cDelta ?? "-"} risk=${effect.riskKind} ref=${effect.ref}${match ? ` ${match}` : ""}`;
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# XSE Activation Probe");
  lines.push("");
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Status: ${report.summary.status}`);
  lines.push(`- Finding: ${report.summary.currentFinding}`);
  lines.push(`- Emulator impact: ${report.summary.emulatorImpact}`);
  lines.push(`- Next target: ${report.summary.nextTarget}`);
  lines.push("");
  lines.push("## Activation Contract");
  lines.push("");
  lines.push(`- Helper: ${report.activationContract.helper}`);
  lines.push(`- Selected record copy: ${report.activationContract.selectedRecordCopy}`);
  lines.push(`- Stack push: ${report.activationContract.stackPush}`);
  lines.push(`- Cursor seed: ${report.activationContract.cursorSeed}`);
  lines.push(`- Group cursor restore: ${report.activationContract.groupCursorRestore}`);
  lines.push("");
  lines.push("## Selection Effects");
  lines.push("");
  lines.push(mdRow(["Script", "Groups", "Primary effect", "All-strong diagnostic"]));
  lines.push(mdRow(["---", "---:", "---", "---"]));
  for (const script of report.scripts) {
    lines.push(mdRow([
      script.name,
      script.groupCount,
      renderEffect(script.primaryEffect),
      renderEffect(script.broadEffect),
    ]));
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
  const jsonFile = path.join(outDir, "xse_activation_probe.json");
  const mdFile = path.join(outDir, "xse_activation_probe.md");
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
