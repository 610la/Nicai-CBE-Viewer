const fs = require("fs");
const path = require("path");

const COMPARE_SHIM_JSON = path.resolve(__dirname, "out_godwar_xsecompareshim", "xse_compare_shim_probe.json");
const ACTIVATION_JSON = path.resolve(__dirname, "out_godwar_xseactivation", "xse_activation_probe.json");
const ACTIVATED_DISPATCH_JSON = path.resolve(__dirname, "out_godwar_xseactivateddispatch", "xse_activated_dispatch_probe.json");
const HIGH_OPCODE_JSON = path.resolve(__dirname, "out_godwar_xsehighopcode", "xse_high_opcode_probe.json");
const DEFAULT_OUT = path.resolve(__dirname, "out_godwar_xseentrysafety");

const GATE_RULES = [
  {
    id: "compare-selection",
    site: "0x12326",
    requirement: "caller label/ref compare must select a +0x64 entry record under the active ref model",
  },
  {
    id: "activation-cursor",
    site: "0x11A4A",
    requirement: "selected record+0x00 must restore a valid dispatcher cursor and record+0x08+1 must seed +0x5C/+0x60 coherently",
  },
  {
    id: "activated-dispatch",
    site: "0x11C3C",
    requirement: "activated cursor must reach a traced dispatch case instead of an invalid/default-only row",
  },
  {
    id: "writeback-destination",
    site: "0x11AE6 / 0x11FD2",
    requirement: "visible writeback cases must resolve operand0 as destination-producing type 3/4/8",
  },
  {
    id: "high-opcode-contract",
    site: "0x11862 / 0x118D2",
    requirement: "opcode>=9 records are loader-valid, but identity writeback paths cannot treat them as destinations",
  },
];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function byName(rows) {
  return new Map((rows || []).map((row) => [row.name, row]));
}

function unionNames(...lists) {
  const seen = new Set();
  const result = [];
  for (const list of lists) {
    for (const row of list || []) {
      const name = row?.name;
      if (!name || seen.has(name)) continue;
      seen.add(name);
      result.push(name);
    }
  }
  return result;
}

function matchText(effect, selected) {
  const matches = effect?.matches || selected?.matches || [];
  return matches.map((item) => `${item.label}:${item.transform}`).join(",");
}

function primarySelection(compareScript) {
  return compareScript?.primarySelection?.selected || null;
}

function broadSelection(effect) {
  if (!effect) return null;
  return {
    index: effect.selectedIndex,
    offset: effect.selectedOffset || "",
    groupCursor: effect.recordFields?.field00GroupCursor ?? null,
    kind: effect.recordFields?.field04Kind ?? null,
    stackSpan: effect.recordFields?.field08StackSpan ?? null,
    ref: effect.ref ?? null,
    matches: effect.matches || [],
    riskKind: effect.riskKind || "",
    safeUnderTrace: Boolean(effect.effectSafeForDispatch),
  };
}

function dispatchKey(scriptName, row) {
  if (!row) return "";
  return `${scriptName}|${row.activatedCursor}|${row.groupId}|${row.target || ""}`;
}

function makeHighOpcodeActivationMap(highOpcode) {
  const result = new Map();
  for (const row of highOpcode.activatedRows || []) {
    result.set(`${row.script}|${row.cursor}|${row.groupId}|${row.target || ""}`, row);
  }
  return result;
}

function hasHighOpcodeWriteback(dispatch, highRow) {
  if (!dispatch || !highRow) return false;
  return Boolean(
    dispatch.writebackBlocked &&
    highRow.highOpcodeUse?.writesBack &&
    (highRow.highOpcodeUse?.kind === "identity-writeback" || dispatch.operand0?.pointerKind === "high-opcode-no-target")
  );
}

function statusReason(status, context) {
  switch (status) {
    case "entry-promotable":
      return "compare selection, activation, dispatch, and visible writeback checks all pass under the current contract";
    case "entry-unmatched":
      return `${context.modelLabel} compare/ref model did not select a label entry for this script`;
    case "entry-demoted-no-activation":
      return "compare selected an entry, but the activation side-effect probe did not produce a corresponding 0x11A4A effect";
    case "entry-demoted-invalid-cursor":
      return "selected record+0x00 restores a cursor outside the traced group table";
    case "entry-demoted-no-dispatch-step":
      return "selected cursor is valid by count, but no activated dispatch step was captured";
    case "entry-demoted-high-opcode-writeback":
      return "activated dispatch reaches an identity writeback path whose operand0 is an opcode>=9 record; 0x11AE6 cannot return a destination for it";
    case "entry-demoted-writeback":
      return "activated dispatch reaches a visible writeback path whose operand0 does not resolve as a type 3/4/8 destination";
    case "entry-demoted-not-visible-safe":
      return "activated dispatch is traced, but earlier safety probes still mark the selected entry unsafe for visible effects";
    default:
      return "entry is not promotable under the current safety gate";
  }
}

function classifyEntry({
  scriptName,
  model,
  modelLabel,
  compareScript,
  activationScript,
  dispatchScript,
  highByActivation,
}) {
  const isPrimary = model === "primary";
  const selected = isPrimary
    ? primarySelection(compareScript)
    : broadSelection(activationScript?.broadEffect);
  const effect = isPrimary ? activationScript?.primaryEffect : activationScript?.broadEffect;
  const dispatch = isPrimary ? dispatchScript?.primaryDispatch : dispatchScript?.broadDispatch;
  const highRow = highByActivation.get(dispatchKey(scriptName, dispatch)) || null;

  let status = "entry-promotable";
  if (!selected) {
    status = "entry-unmatched";
  } else if (!effect) {
    status = "entry-demoted-no-activation";
  } else if (!effect.cursorValid) {
    status = "entry-demoted-invalid-cursor";
  } else if (!dispatch || !dispatch.stepFound) {
    status = "entry-demoted-no-dispatch-step";
  } else if (hasHighOpcodeWriteback(dispatch, highRow)) {
    status = "entry-demoted-high-opcode-writeback";
  } else if (dispatch.writebackBlocked) {
    status = "entry-demoted-writeback";
  } else if (!dispatch.visibleSafe) {
    status = "entry-demoted-not-visible-safe";
  }

  const promotable = status === "entry-promotable";
  return {
    script: scriptName,
    model,
    modelLabel,
    status,
    promotable,
    reason: statusReason(status, { modelLabel }),
    compareStatus: compareScript?.primaryStatus || "",
    selected: selected
      ? {
        index: selected.index ?? effect?.selectedIndex ?? null,
        offset: selected.offset || effect?.selectedOffset || "",
        groupCursor: selected.groupCursor ?? effect?.recordFields?.field00GroupCursor ?? null,
        kind: selected.kind ?? effect?.recordFields?.field04Kind ?? null,
        stackSpan: selected.stackSpan ?? effect?.recordFields?.field08StackSpan ?? null,
        ref: selected.ref ?? effect?.ref ?? null,
        matches: selected.matches || effect?.matches || [],
        matchText: matchText(effect, selected),
        riskKind: selected.riskKind || effect?.riskKind || "",
        safeUnderTrace: Boolean(selected.safeUnderTrace ?? effect?.effectSafeForDispatch),
      }
      : null,
    activation: effect
      ? {
        cursorValid: Boolean(effect.cursorValid),
        selectedIndex: effect.selectedIndex ?? null,
        groupCursor: effect.recordFields?.field00GroupCursor ?? null,
        stackDelta: effect.activationWrites?.script5cDelta ?? null,
        effectSafeForDispatch: Boolean(effect.effectSafeForDispatch),
        riskKind: effect.riskKind || "",
      }
      : null,
    dispatch: dispatch
      ? {
        result: dispatch.result || "",
        stepFound: Boolean(dispatch.stepFound),
        visibleSafe: Boolean(dispatch.visibleSafe),
        cursorValid: Boolean(dispatch.cursorValid),
        activatedCursor: dispatch.activatedCursor ?? null,
        groupId: dispatch.groupId ?? null,
        target: dispatch.target || "",
        caseStatus: dispatch.caseStatus || "",
        writebackBlocked: Boolean(dispatch.writebackBlocked),
        operand0: dispatch.operand0 || null,
        reason: dispatch.reason || "",
      }
      : null,
    highOpcode: highRow
      ? {
        cursor: highRow.cursor ?? null,
        groupId: highRow.groupId ?? null,
        target: highRow.target || "",
        operand0: highRow.operand0 || null,
        useKind: highRow.highOpcodeUse?.kind || "",
        writesBack: Boolean(highRow.highOpcodeUse?.writesBack),
        finding: highRow.finding || "",
      }
      : null,
  };
}

function mdRow(cells) {
  return `| ${cells.map((cell) => String(cell ?? "").replace(/\|/g, "\\|")).join(" | ")} |`;
}

function renderSelected(row) {
  if (!row.selected) return "-";
  return [
    `entry${row.selected.index}`,
    `cursor=${row.selected.groupCursor}`,
    `ref=${row.selected.ref}`,
    row.selected.matchText || "",
  ].filter(Boolean).join(" ");
}

function renderDispatch(row) {
  if (!row.dispatch) return "-";
  return [
    row.dispatch.stepFound ? `g${row.dispatch.groupId}` : "no-step",
    row.dispatch.target || "",
    row.dispatch.caseStatus || "",
    row.dispatch.operand0?.typeHex ? `op0=${row.dispatch.operand0.typeHex}` : "",
  ].filter(Boolean).join(" ");
}

function buildReport() {
  const compareShim = readJson(COMPARE_SHIM_JSON);
  const activation = readJson(ACTIVATION_JSON);
  const activatedDispatch = readJson(ACTIVATED_DISPATCH_JSON);
  const highOpcode = readJson(HIGH_OPCODE_JSON);
  const compareByName = byName(compareShim.scripts);
  const activationByName = byName(activation.scripts);
  const dispatchByName = byName(activatedDispatch.scripts);
  const highByActivation = makeHighOpcodeActivationMap(highOpcode);
  const names = unionNames(compareShim.scripts, activation.scripts, activatedDispatch.scripts);

  const primaryRows = names.map((scriptName) => classifyEntry({
    scriptName,
    model: "primary",
    modelLabel: compareShim.summary?.primaryModel || "primary",
    compareScript: compareByName.get(scriptName) || null,
    activationScript: activationByName.get(scriptName) || null,
    dispatchScript: dispatchByName.get(scriptName) || null,
    highByActivation,
  }));

  const broadRows = names.map((scriptName) => classifyEntry({
    scriptName,
    model: "all-strong",
    modelLabel: "nearby-full-label/all-strong",
    compareScript: compareByName.get(scriptName) || null,
    activationScript: activationByName.get(scriptName) || null,
    dispatchScript: dispatchByName.get(scriptName) || null,
    highByActivation,
  }));

  const promotablePrimary = primaryRows.filter((row) => row.promotable);
  const selectedPrimary = primaryRows.filter((row) => row.selected);
  const demotedHighOpcode = primaryRows.filter((row) => row.status === "entry-demoted-high-opcode-writeback");
  const demotedWriteback = primaryRows.filter((row) => row.status === "entry-demoted-writeback");
  const unmatchedPrimary = primaryRows.filter((row) => row.status === "entry-unmatched");
  const invalidBroad = broadRows.filter((row) => row.status === "entry-demoted-invalid-cursor");
  const status = promotablePrimary.length
    ? "entry-safety-promotable-selection"
    : "entry-safety-no-promotable-selection";
  const demotedText = demotedHighOpcode.length
    ? `${demotedHighOpcode[0].script} entry${demotedHighOpcode[0].selected?.index} reaches group ${demotedHighOpcode[0].dispatch?.groupId}/operand0 ${demotedHighOpcode[0].dispatch?.operand0?.typeHex || "-"} identity writeback`
    : selectedPrimary.length
    ? `${selectedPrimary[0].script} entry${selectedPrimary[0].selected?.index} is blocked as ${selectedPrimary[0].status}`
    : "no primary compare-shim selection is available";

  return {
    schema: "nicai.cbe.xseEntrySafetyProbe.v1",
    generatedAt: new Date().toISOString(),
    inputs: {
      compareShim: COMPARE_SHIM_JSON,
      activation: ACTIVATION_JSON,
      activatedDispatch: ACTIVATED_DISPATCH_JSON,
      highOpcode: HIGH_OPCODE_JSON,
    },
    gateRules: GATE_RULES,
    summary: {
      status,
      scriptCount: names.length,
      primaryModel: compareShim.summary?.primaryModel || "",
      primarySelectedCount: selectedPrimary.length,
      promotablePrimaryCount: promotablePrimary.length,
      demotedHighOpcodeWritebackCount: demotedHighOpcode.length,
      demotedWritebackCount: demotedWriteback.length,
      unmatchedPrimaryCount: unmatchedPrimary.length,
      invalidBroadCount: invalidBroad.length,
      promotablePrimaryScripts: promotablePrimary.map((row) => row.script),
      demotedHighOpcodeWritebackScripts: demotedHighOpcode.map((row) => row.script),
      demotedWritebackScripts: demotedWriteback.map((row) => row.script),
      unmatchedPrimaryScripts: unmatchedPrimary.map((row) => row.script),
      invalidBroadScripts: invalidBroad.map((row) => row.script),
      currentFinding: `Entry safety gate demotes the current primary compare-shim result: ${demotedText}; ${promotablePrimary.length}/${names.length} focused scripts have promotable label-entry selections under the active ref model.`,
      emulatorImpact: "The generic CBE web emulator must treat label-entry matches as scheduler candidates only after activation and writeback safety pass; current focused XSE entries remain trace-only and cannot produce visible script effects.",
      nextTarget: "Recover the true +0x64 range count/ref widths and compare normalization so a label match also passes activation, dispatch, and destination safety.",
      compareShimFinding: compareShim.summary?.currentFinding || "",
      activationFinding: activation.summary?.currentFinding || "",
      activatedDispatchFinding: activatedDispatch.summary?.currentFinding || "",
      highOpcodeFinding: highOpcode.summary?.currentFinding || "",
    },
    primaryRows,
    broadRows,
  };
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# XSE Entry Safety Probe");
  lines.push("");
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Status: ${report.summary.status}`);
  lines.push(`- Finding: ${report.summary.currentFinding}`);
  lines.push(`- Emulator impact: ${report.summary.emulatorImpact}`);
  lines.push(`- Next target: ${report.summary.nextTarget}`);
  lines.push("");
  lines.push("## Promotion Gate");
  lines.push("");
  lines.push(mdRow(["Rule", "Runtime site", "Requirement"]));
  lines.push(mdRow(["---", "---", "---"]));
  for (const rule of report.gateRules) {
    lines.push(mdRow([rule.id, rule.site, rule.requirement]));
  }
  lines.push("");
  lines.push("## Primary Model");
  lines.push("");
  lines.push(mdRow(["Script", "Selected", "Dispatch", "High opcode", "Status", "Reason"]));
  lines.push(mdRow(["---", "---", "---", "---", "---", "---"]));
  for (const row of report.primaryRows) {
    const high = row.highOpcode ? `${row.highOpcode.useKind} ${row.highOpcode.operand0?.typeHex || ""}`.trim() : "-";
    lines.push(mdRow([row.script, renderSelected(row), renderDispatch(row), high, row.status, row.reason]));
  }
  lines.push("");
  lines.push("## Broad Model Diagnostics");
  lines.push("");
  lines.push(mdRow(["Script", "Selected", "Dispatch", "Status", "Reason"]));
  lines.push(mdRow(["---", "---", "---", "---", "---"]));
  for (const row of report.broadRows) {
    lines.push(mdRow([row.script, renderSelected(row), renderDispatch(row), row.status, row.reason]));
  }
  lines.push("");
  lines.push("## Source Findings");
  lines.push("");
  lines.push(`- Compare shim: ${report.summary.compareShimFinding}`);
  lines.push(`- Activation: ${report.summary.activationFinding}`);
  lines.push(`- Activated dispatch: ${report.summary.activatedDispatchFinding}`);
  lines.push(`- High opcode: ${report.summary.highOpcodeFinding}`);
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
  const jsonFile = path.join(outDir, "xse_entry_safety_probe.json");
  const mdFile = path.join(outDir, "xse_entry_safety_probe.md");
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
