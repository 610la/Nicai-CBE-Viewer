const fs = require("fs");
const path = require("path");

const ACTIVATION_JSON = path.resolve(__dirname, "out_godwar_xseactivation", "xse_activation_probe.json");
const TRACE_VM_JSON = path.resolve(__dirname, "out_godwar_xsetracevm", "xse_trace_vm_probe.json");
const OPERAND_BINDING_JSON = path.resolve(__dirname, "out_godwar_xseoperandbinding", "xse_operand_binding_probe.json");
const DISPATCH_CASES_JSON = path.resolve(__dirname, "out_godwar_xsedispatchcases", "xse_dispatch_case_probe.json");
const DEFAULT_OUT = path.resolve(__dirname, "out_godwar_xseactivateddispatch");

const POINTER_TYPES = new Set([3, 4, 8]);
const STACK_INDEX_TYPES = new Set([3, 4]);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function key(script, cursor, groupId) {
  return `${script}|${cursor}|${groupId}`;
}

function stepKey(scriptName, step) {
  return key(scriptName, step.cursor, step.groupId);
}

function opSummary(op) {
  if (!op) return null;
  return {
    index: op.index,
    type: op.type,
    typeHex: op.typeHex || (Number.isInteger(op.type) ? `0x${op.type.toString(16).toUpperCase().padStart(2, "0")}` : ""),
    pointerKind: op.pointerKind || op.pointer?.kind || "",
    pointerResolves: Boolean(op.pointerResolves ?? op.pointer?.resolves),
    typedValueKind: op.typedValueKind || op.typedValue?.kind || "",
  };
}

function matchText(effect) {
  return (effect?.matches || []).map((item) => `${item.label}:${item.transform}`).join(",");
}

function makeBlockerMap(operandBinding) {
  const result = new Map();
  for (const row of operandBinding.blockers || []) {
    result.set(key(row.script, row.cursor, row.groupId), row);
  }
  return result;
}

function makeCaseMap(dispatchCases) {
  const result = new Map();
  for (const row of dispatchCases.dispatcher?.primary || []) {
    result.set(row.id, row);
  }
  return result;
}

function classifyStep(effect, scriptName, traceScript, blockerMap, caseMap, model) {
  if (!effect) return null;
  const activatedCursor = effect.recordFields?.field00GroupCursor;
  const selectedIndex = effect.selectedIndex;
  const base = {
    model,
    script: scriptName,
    selectedIndex,
    selectedOffset: effect.selectedOffset || "",
    ref: effect.ref ?? null,
    match: matchText(effect),
    riskKind: effect.riskKind || "",
    activationEffectSafe: Boolean(effect.effectSafeForDispatch),
    activatedCursor,
    stackDelta: effect.activationWrites?.script5cDelta ?? null,
    cursorValid: Boolean(effect.cursorValid),
  };
  if (!effect.cursorValid) {
    return {
      ...base,
      stepFound: false,
      result: "activation-cursor-invalid",
      reason: "selected record+0x00 is outside the traced group table, so it cannot enter the dispatcher safely",
      visibleSafe: false,
    };
  }

  const step = (traceScript?.steps || []).find((item) => item.cursor === activatedCursor) || null;
  if (!step) {
    return {
      ...base,
      stepFound: false,
      result: "activated-step-missing",
      reason: "selected cursor is valid by group count but no trace VM step was captured for it",
      visibleSafe: false,
    };
  }

  const blocker = blockerMap.get(stepKey(scriptName, step)) || null;
  const operands = step.semantics?.operands || [];
  const operand0 = opSummary(blocker?.operand0 || operands[0]);
  const operand1 = opSummary(blocker?.operand1 || operands[1]);
  const operand0Type = operand0?.type;
  const operand0PointerType = Boolean(blocker?.operand0PointerType ?? POINTER_TYPES.has(operand0Type));
  const stackSeedRelevant = Boolean(blocker?.stackSeedRelevant ?? STACK_INDEX_TYPES.has(operand0Type));
  const writebackBlocked = Boolean(blocker || (step.blockers || []).includes("writeback target unresolved"));
  const requiresReaderLayoutBinding = Boolean(blocker?.requiresReaderLayoutBinding ?? (writebackBlocked && !operand0PointerType));
  const activationCanFixWriteback = Boolean(writebackBlocked && stackSeedRelevant);
  const dispatchCase = caseMap.get(step.groupId) || null;

  let result = "activated-dispatch-trace-ok";
  let reason = "activated cursor reaches a trace VM step without the current writeback blocker";
  if (writebackBlocked) {
    result = stackSeedRelevant ? "activated-dispatch-stack-address-needed" : "activated-dispatch-writeback-blocked";
    reason = stackSeedRelevant
      ? "operand0 is a stack-reference type; activation stack delta can affect the final address, but +0x54/+0x60 binding is still needed"
      : "operand0 is not a pointer-producing type, so activation stack delta cannot make 0x11AE6 return a writeback destination";
  } else if ((step.blockers || []).length) {
    result = (step.blockers || []).includes("default-group-id")
      ? "activated-dispatch-default"
      : "activated-dispatch-blocked";
    reason = `activated cursor reaches ${step.blockers.join(", ")}`;
  }

  return {
    ...base,
    stepFound: true,
    traceMode: traceScript?.mode || "",
    groupId: step.groupId,
    direct: Boolean(step.direct),
    target: step.target || dispatchCase?.target || "",
    dispatchCaseTarget: dispatchCase?.target || "",
    caseStatus: step.caseStatus || "",
    role: step.role || "",
    firstOpcodes: step.opcodeSummary?.firstOpcodes || [],
    blockers: step.blockers || [],
    operand0,
    operand1,
    writebackBlocked,
    operand0PointerType,
    stackSeedRelevant,
    requiresReaderLayoutBinding,
    activationCanFixWriteback,
    result,
    reason,
    visibleSafe: result === "activated-dispatch-trace-ok" && Boolean(effect.effectSafeForDispatch),
  };
}

function buildReport() {
  const activation = readJson(ACTIVATION_JSON);
  const traceVm = readJson(TRACE_VM_JSON);
  const operandBinding = readJson(OPERAND_BINDING_JSON);
  const dispatchCases = readJson(DISPATCH_CASES_JSON);
  const traceByName = new Map((traceVm.scripts || []).map((script) => [script.name, script]));
  const blockerMap = makeBlockerMap(operandBinding);
  const caseMap = makeCaseMap(dispatchCases);

  const scripts = (activation.scripts || []).map((script) => {
    const traceScript = traceByName.get(script.name) || null;
    return {
      name: script.name,
      groupCount: script.groupCount || 0,
      traceMode: traceScript?.mode || "",
      primaryDispatch: classifyStep(script.primaryEffect, script.name, traceScript, blockerMap, caseMap, "primary"),
      broadDispatch: classifyStep(script.broadEffect, script.name, traceScript, blockerMap, caseMap, "all-strong"),
    };
  });

  const primaryRows = scripts.map((script) => script.primaryDispatch).filter(Boolean);
  const primaryBlocked = primaryRows.filter((row) => row.writebackBlocked);
  const primaryReaderLayout = primaryRows.filter((row) => row.requiresReaderLayoutBinding);
  const primaryStackRelevant = primaryRows.filter((row) => row.stackSeedRelevant);
  const primaryVisibleSafe = primaryRows.filter((row) => row.visibleSafe);
  const firstBlocked = primaryBlocked[0] || null;
  const status = primaryRows.length === 0
    ? "activated-dispatch-unmatched"
    : primaryVisibleSafe.length && primaryBlocked.length
    ? "activated-dispatch-partial"
    : primaryVisibleSafe.length
    ? "activated-dispatch-trace-ok"
    : primaryBlocked.length
    ? "activated-dispatch-writeback-blocked"
    : "activated-dispatch-blocked";

  const blockerFinding = firstBlocked
    ? `${firstBlocked.script} entry${firstBlocked.selectedIndex} restores cursor ${firstBlocked.activatedCursor}, dispatches group ${firstBlocked.groupId} at ${firstBlocked.target}, and operand0 ${firstBlocked.operand0?.typeHex || "-"} / ${firstBlocked.operand0?.pointerKind || "-"} is ${firstBlocked.stackSeedRelevant ? "stack-seed relevant" : "not stack-seed relevant"}.`
    : primaryRows.length
    ? "Primary activation reaches traced dispatch without the current writeback blocker, but visible effects still need the remaining non-writeback guardrails."
    : "No primary activation selection is available to test against dispatch.";

  return {
    schema: "nicai.cbe.xseActivatedDispatchProbe.v1",
    generatedAt: new Date().toISOString(),
    inputs: {
      activation: ACTIVATION_JSON,
      traceVm: TRACE_VM_JSON,
      operandBinding: OPERAND_BINDING_JSON,
      dispatchCases: DISPATCH_CASES_JSON,
    },
    summary: {
      status,
      scriptCount: scripts.length,
      primarySelectedCount: primaryRows.length,
      primaryCursorValidCount: primaryRows.filter((row) => row.cursorValid).length,
      primaryActivatedStepCount: primaryRows.filter((row) => row.stepFound).length,
      primaryWritebackBlockedCount: primaryBlocked.length,
      primaryReaderLayoutBlockedCount: primaryReaderLayout.length,
      primaryStackSeedRelevantCount: primaryStackRelevant.length,
      primaryVisibleSafeCount: primaryVisibleSafe.length,
      blockedScripts: primaryBlocked.map((row) => row.script),
      readerLayoutBlockedScripts: primaryReaderLayout.map((row) => row.script),
      stackSeedRelevantScripts: primaryStackRelevant.map((row) => row.script),
      currentFinding: `Activated-dispatch check binds 0x11A4A selection to the trace VM: ${primaryRows.length}/${scripts.length} primary selections can be tested, ${primaryBlocked.length} land on unresolved writeback. ${blockerFinding}`,
      emulatorImpact: "The generic emulator can apply the activation state transition, but it must keep visible effects disabled when the activated group still writes through an unresolved operand0 destination.",
      nextTarget: "Correct operand record boundaries and +0x4C/+0x50 reader binding at activated value-op groups; apply +0x54/+0x60 address rules only after operand0 resolves as type 3/4/8.",
      activationFinding: activation.summary?.currentFinding || "",
      operandBindingFinding: operandBinding.summary?.currentFinding || "",
    },
    scripts,
  };
}

function mdRow(cells) {
  return `| ${cells.map((cell) => String(cell ?? "").replace(/\|/g, "\\|")).join(" | ")} |`;
}

function renderDispatch(row) {
  if (!row) return null;
  const operand0 = row.operand0 ? `${row.operand0.typeHex}/${row.operand0.pointerKind || "-"}` : "-";
  const dispatch = row.stepFound ? `g${row.groupId} ${row.target || "-"} ${row.caseStatus || "-"}` : "-";
  return mdRow([
    row.script,
    row.model,
    row.selectedIndex == null ? "-" : `entry${row.selectedIndex}`,
    row.activatedCursor,
    dispatch,
    operand0,
    row.stackSeedRelevant ? "yes" : "no",
    row.result,
    row.reason,
  ]);
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# XSE Activated Dispatch Probe");
  lines.push("");
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Status: ${report.summary.status}`);
  lines.push(`- Finding: ${report.summary.currentFinding}`);
  lines.push(`- Emulator impact: ${report.summary.emulatorImpact}`);
  lines.push(`- Next target: ${report.summary.nextTarget}`);
  lines.push("");
  lines.push("## Activation To Dispatch");
  lines.push("");
  lines.push(mdRow(["Script", "Model", "Entry", "Cursor", "Dispatch", "Operand0", "Stack seed", "Result", "Reason"]));
  lines.push(mdRow(["---", "---", "---", "---:", "---", "---", "---", "---", "---"]));
  for (const script of report.scripts) {
    const primary = renderDispatch(script.primaryDispatch);
    if (primary) lines.push(primary);
    const broad = renderDispatch(script.broadDispatch);
    if (broad) lines.push(broad);
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
  const jsonFile = path.join(outDir, "xse_activated_dispatch_probe.json");
  const mdFile = path.join(outDir, "xse_activated_dispatch_probe.md");
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
