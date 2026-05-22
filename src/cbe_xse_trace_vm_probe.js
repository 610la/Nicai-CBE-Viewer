const fs = require("fs");
const path = require("path");

const SWITCH_REPLAY_JSON = path.resolve(__dirname, "out_godwar_xseswitchreplay", "xse_switch_replay_probe.json");
const DISPATCH_JSON = path.resolve(__dirname, "out_godwar_xsedispatch", "xse_runtime_dispatch_probe.json");
const CASE_JSON = path.resolve(__dirname, "out_godwar_xsedispatchcases", "xse_dispatch_case_probe.json");
const DEFAULT_OUT = path.resolve(__dirname, "out_godwar_xsetracevm");

const CASE_STATUS = {
  "0x011D4C": "binary-value-op",
  "0x011ED4": "unary-value-op",
  "0x012222": "delay-state",
  "0x01223E": "clear-active",
  "0x015F08": "register-shape-suspect",
  "0x011FE0": "default-noop",
};

const REQUIRED_RECORDS = {
  "0x011D4C": [0, 1],
  "0x011ED4": [0],
  "0x012222": [0],
  "0x01223E": [0],
  "0x015F08": [],
  "0x011FE0": [],
};

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function asHexByte(n) {
  if (!Number.isFinite(n)) return "";
  return `0x${n.toString(16).toUpperCase().padStart(2, "0")}`;
}

function targetForGroup(caseProbe, groupId) {
  for (const item of caseProbe.caseWindows || []) {
    if ((item.groupIds || []).includes(groupId)) return item.target;
  }
  return caseProbe.dispatcher?.primaryDefaultTarget || "0x011FE0";
}

function caseNote(caseProbe, target) {
  const item = (caseProbe.caseWindows || []).find((row) => row.target === target);
  return item?.note || CASE_STATUS[target] || "";
}

function arithmeticSubtarget(caseProbe, groupId) {
  const rows = caseProbe.dispatcher?.arithmeticSubtable?.rows || [];
  return rows.find((row) => row.id === groupId)?.target || "";
}

function recordSummary(record) {
  if (!record) return null;
  return {
    index: record.recordIndex,
    start: record.startHex,
    end: record.endHex,
    opcode: record.opcode,
    opcodeHex: record.opcodeHex || asHexByte(record.opcode),
    highOpcode: Boolean(record.highOpcode),
    action: record.switchAction || "",
    fields: (record.fields || []).map((field) => ({
      label: field.label,
      value: field.value,
      raw: field.raw,
      tag: field.tag,
    })),
  };
}

function fieldValue(record, labelPart) {
  return (record?.fields || []).find((field) => field.label.includes(labelPart)) || null;
}

function typedValueSemantics(record) {
  if (!record) {
    return {
      kind: "missing",
      concrete: false,
      defaulted: true,
      value: 0,
      note: "missing operand defaults to 0 in the trace model",
    };
  }
  const type = record.opcode;
  if (type === 0) {
    const valueField = fieldValue(record, "field+08");
    return {
      kind: "primitive-number",
      concrete: true,
      defaulted: false,
      value: valueField?.value ?? 0,
      sourceField: valueField?.label || "+0x08",
      note: "0x118D2 type 0 returns record +0x08",
    };
  }
  if (type === 1) {
    const valueField = fieldValue(record, "field+0C");
    return {
      kind: "transformed-number",
      concrete: false,
      defaulted: false,
      value: valueField?.value ?? null,
      sourceField: valueField?.label || "+0x0C",
      helper: "0x35334",
      note: "0x118D2 type 1 transforms record +0x0C through 0x35334",
    };
  }
  if (type === 2) {
    const valueField = fieldValue(record, "field+08");
    return {
      kind: "boxed-or-resource-value",
      concrete: false,
      defaulted: false,
      value: valueField?.value ?? null,
      helper: "0x02A8",
      note: "0x118D2 type 2 calls 0x02A8 with the record +0x10 payload",
    };
  }
  if ([3, 4, 8].includes(type)) {
    return {
      kind: "reference-resolved-value",
      concrete: false,
      defaulted: false,
      value: null,
      helper: "0x11862",
      note: "0x11862 resolves type 3/4/8 before typed-value evaluation",
    };
  }
  return {
    kind: type >= 9 ? "high-opcode-default" : "unsupported-type-default",
    concrete: true,
    defaulted: true,
    value: 0,
    note: "0x118D2 returns 0 for record types outside 0/1/2 after reference resolution",
  };
}

function recordReadSemantics(record) {
  if (!record) {
    return {
      kind: "missing-record",
      concrete: false,
      defaulted: false,
      value: null,
      note: "missing operand cannot be copied by 0x11862",
    };
  }
  const type = record.opcode;
  if ([3, 4, 8].includes(type)) {
    return {
      kind: "reference-resolved-record",
      concrete: false,
      defaulted: false,
      value: null,
      helper: "0x11862",
      note: "0x11862 resolves type 3/4/8 before copying the record",
    };
  }
  return {
    kind: type >= 9 ? "high-opcode-record-copy" : "immediate-record-copy",
    concrete: false,
    defaulted: false,
    value: null,
    helper: "0x11862",
    note: "0x11862 copies non-reference operand records unchanged; numeric defaulting happens only when the caller later invokes 0x118D2/0x118FA",
  };
}

function operandUseKind(target, groupId, operandIndex) {
  if (target === "0x012222") return "numeric";
  if (target === "0x01223E") return "record";
  if (target === "0x011ED4") {
    return [7, 8, 9, 13].includes(groupId) ? "numeric-or-resource" : "record";
  }
  if (target === "0x011D4C") {
    return operandIndex === 1 ? "numeric-or-resource" : "record";
  }
  return "record";
}

function valueSemanticsForUse(record, target, groupId, operandIndex) {
  const useKind = operandUseKind(target, groupId, operandIndex);
  const semantics = useKind === "numeric" || useKind === "numeric-or-resource"
    ? typedValueSemantics(record)
    : recordReadSemantics(record);
  return {
    ...semantics,
    useKind,
  };
}

function pointerSemantics(record) {
  if (!record) {
    return {
      resolves: false,
      kind: "missing",
      note: "missing operand cannot provide a writeback target",
    };
  }
  const type = record.opcode;
  if (type === 3 || type === 4) {
    return {
      resolves: true,
      kind: "record-reference",
      helper: "0x1180A/0x11AE6",
      note: "type 3/4 resolves through the script +0x54/+0x60 record tables",
    };
  }
  if (type === 8) {
    return {
      resolves: true,
      kind: "script-record-base",
      helper: "0x11AE6",
      note: "type 8 resolves to the current script record +0x20",
    };
  }
  return {
    resolves: false,
    kind: type >= 9 ? "high-opcode-no-target" : "immediate-no-target",
    note: "0x11AE6 returns null unless operand0 resolves as type 3/4/8",
  };
}

function semanticSummaryForStep(target, groupId, records) {
  const operands = records.map((record) => ({
    index: record.index,
    type: record.opcode,
    typeHex: record.opcodeHex,
    typedValue: valueSemanticsForUse(record, target, groupId, record.index),
    pointer: pointerSemantics(record),
  }));
  const blockers = [];
  const notes = [];
  let writeback = null;
  if (target === "0x011D4C" || target === "0x011ED4") {
    const operand0 = operands[0] || null;
    writeback = operand0?.pointer || pointerSemantics(null);
    if (!writeback.resolves) blockers.push("writeback target unresolved");
    notes.push("case result is copied back through 0x11AE6(operand0) at 0x11FD2");
  }
  if (target === "0x012222") {
    const value = operands[0]?.typedValue || typedValueSemantics(null);
    if (value.defaulted) notes.push("delay operand resolves to runtime default 0");
  }
  if (target === "0x01223E") {
    notes.push("case clears script active flag at +0x10");
  }
  return {
    operands,
    writeback,
    blockers,
    notes,
    concreteTypedValues: operands.filter((item) => item.typedValue.concrete && !item.typedValue.defaulted).length,
    defaultTypedValues: operands.filter((item) => item.typedValue.defaulted).length,
    symbolicTypedValues: operands.filter((item) => !item.typedValue.concrete && !item.typedValue.defaulted).length,
  };
}

function chooseAttempt(switchScript, dispatchScript) {
  const mode = dispatchScript?.executionBest?.mode || dispatchScript?.dispatchBest?.mode || switchScript.best?.shortMode || "";
  const attempts = switchScript.attempts || [];
  return attempts.find((attempt) => attempt.ok && attempt.shortMode === mode)
    || switchScript.best
    || attempts.find((attempt) => attempt.ok)
    || null;
}

function summarizeGroupOpcodes(group) {
  const records = group.records || [];
  const high = records.filter((record) => record.highOpcode).length;
  const low = records.length - high;
  const firstOpcodes = records.slice(0, 12).map((record) => record.opcodeHex || asHexByte(record.opcode));
  return {
    recordCount: records.length,
    lowOpcodeRecords: low,
    highOpcodeRecords: high,
    highOpcodePercent: records.length ? Number(((high / records.length) * 100).toFixed(1)) : 0,
    firstOpcodes,
  };
}

function traceStep(caseProbe, group, cursor, active) {
  const groupId = group.id?.value;
  const direct = Number.isInteger(groupId) && groupId >= 0 && groupId <= 0x20;
  const target = direct ? targetForGroup(caseProbe, groupId) : "0x011FE0";
  const required = REQUIRED_RECORDS[target] || [];
  const records = required.map((index) => recordSummary(group.records?.[index])).filter(Boolean);
  const highRequired = records.filter((record) => record.highOpcode);
  const highNumericRequired = highRequired.filter((record) => {
    const useKind = operandUseKind(target, groupId, record.index);
    return useKind === "numeric" || useKind === "numeric-or-resource";
  });
  const semantics = semanticSummaryForStep(target, groupId, records);
  const blockers = [];
  const notes = [];
  if (!direct) blockers.push("default-group-id");
  if (highNumericRequired.length) {
    notes.push("high-opcode numeric operands default through runtime helpers unless referenced by a bound type");
  } else if (highRequired.length) {
    notes.push("high-opcode operands are copied as records here; this case does not use the numeric default helper");
  }
  if (target === "0x015F08") {
    blockers.push("register-shape mismatch for id32 overlap target");
    notes.push("0x15F08 is an inner table-lookup label that expects r4 as an object pointer, not the group id");
  }
  if (target === "0x012222" && highRequired.length) notes.push("delay operand currently defaults to 0");
  blockers.push(...semantics.blockers);
  notes.push(...semantics.notes);
  const nextActive = active && target !== "0x01223E";
  return {
    cursor,
    groupIndex: group.index,
    groupId,
    direct,
    target,
    caseStatus: CASE_STATUS[target] || "mapped-case",
    role: caseNote(caseProbe, target),
    arithmeticSubtarget: target === "0x011D4C" ? arithmeticSubtarget(caseProbe, groupId) : "",
    opcodeSummary: summarizeGroupOpcodes(group),
    requiredRecordIndexes: required,
    requiredRecords: records,
    semantics,
    blockers,
    notes,
    stateEffect: target === "0x01223E"
      ? "active=false"
      : target === "0x012222"
      ? "sets delay flag/deadline if operand resolves"
      : direct
      ? "cursor advances after case unless case writes +0x50"
      : "default path; cursor advances",
    nextCursor: cursor + 1,
    activeAfter: nextActive,
  };
}

function traceScript(switchScript, dispatchScript, caseProbe) {
  const attempt = chooseAttempt(switchScript, dispatchScript);
  if (!attempt) {
    return {
      name: switchScript.name,
      status: "missing-attempt",
      steps: [],
    };
  }
  const steps = [];
  let cursor = 0;
  let active = true;
  while (active && cursor < (attempt.groups || []).length && steps.length < 64) {
    const group = attempt.groups[cursor];
    const step = traceStep(caseProbe, group, cursor, active);
    steps.push(step);
    cursor = step.nextCursor;
    active = step.activeAfter;
  }
  const directSteps = steps.filter((step) => step.direct).length;
  const highDefaulted = steps.filter((step) => step.notes.some((note) => note.startsWith("high-opcode numeric"))).length;
  const registerShapeSuspect = steps.filter((step) => step.blockers.includes("register-shape mismatch for id32 overlap target")).length;
  const writebackBlocked = steps.filter((step) => step.blockers.includes("writeback target unresolved")).length;
  return {
    name: switchScript.name,
    status: "trace-only",
    mode: attempt.shortMode,
    groupCount: attempt.groups?.length || 0,
    finalCursor: cursor,
    active,
    directSteps,
    defaultSteps: steps.length - directSteps,
    highOpcodeOperandDefaultSteps: highDefaulted,
    highOpcodeOperandBlockedSteps: 0,
    runtimeHelperBlockedSteps: 0,
    registerShapeSuspectSteps: registerShapeSuspect,
    writebackTargetBlockedSteps: writebackBlocked,
    concreteTypedValues: steps.reduce((sum, step) => sum + (step.semantics?.concreteTypedValues || 0), 0),
    defaultTypedValues: steps.reduce((sum, step) => sum + (step.semantics?.defaultTypedValues || 0), 0),
    symbolicTypedValues: steps.reduce((sum, step) => sum + (step.semantics?.symbolicTypedValues || 0), 0),
    steps,
  };
}

function buildReport() {
  const switchReplay = readJson(SWITCH_REPLAY_JSON);
  const dispatch = readJson(DISPATCH_JSON);
  const caseProbe = readJson(CASE_JSON);
  const dispatchByName = new Map((dispatch.scripts || []).map((script) => [script.name, script]));
  const scripts = (switchReplay.scripts || []).map((script) => traceScript(script, dispatchByName.get(script.name), caseProbe));
  const allSteps = scripts.flatMap((script) => script.steps);
  const directGroups = Array.from(new Set(allSteps.filter((step) => step.direct).map((step) => step.groupId))).sort((a, b) => a - b);
  const highDefaulted = allSteps.filter((step) => step.notes.some((note) => note.startsWith("high-opcode numeric"))).length;
  const registerShapeSuspect = allSteps.filter((step) => step.blockers.includes("register-shape mismatch for id32 overlap target")).length;
  const writebackBlocked = allSteps.filter((step) => step.blockers.includes("writeback target unresolved")).length;
  const concreteTypedValues = allSteps.reduce((sum, step) => sum + (step.semantics?.concreteTypedValues || 0), 0);
  const defaultTypedValues = allSteps.reduce((sum, step) => sum + (step.semantics?.defaultTypedValues || 0), 0);
  const symbolicTypedValues = allSteps.reduce((sum, step) => sum + (step.semantics?.symbolicTypedValues || 0), 0);
  const avoidedRegisterShapeSuspects = (dispatch.scripts || [])
    .filter((script) => script.executionBest?.mode && script.dispatchBest?.mode && script.executionBest.mode !== script.dispatchBest.mode)
    .filter((script) => (script.dispatchBest?.registerShapeSuspectGroups || []).length)
    .map((script) => ({
      name: script.name,
      dispatchMode: script.dispatchBest.mode,
      executionMode: script.executionBest.mode,
      suspectGroups: script.dispatchBest.registerShapeSuspectGroups || [],
    }));
  const registerShapeText = registerShapeSuspect
    ? `leaving ${registerShapeSuspect} register-shape suspect around the id32 overlap target`
    : avoidedRegisterShapeSuspects.length
    ? `avoiding ${avoidedRegisterShapeSuspects.length} register-shape suspect compact path by selecting execution-best modes`
    : "with no register-shape suspect steps";
  return {
    schema: "nicai.cbe.xseTraceVmProbe.v1",
    generatedAt: new Date().toISOString(),
    inputs: {
      switchReplay: SWITCH_REPLAY_JSON,
      dispatch: DISPATCH_JSON,
      caseProbe: CASE_JSON,
    },
    summary: {
      status: "trace-vm-dispatch-walk",
      scriptCount: scripts.length,
      stepCount: allSteps.length,
      directGroups,
      highOpcodeOperandDefaultSteps: highDefaulted,
      highOpcodeOperandBlockedSteps: 0,
      runtimeHelperBlockedSteps: 0,
      registerShapeSuspectSteps: registerShapeSuspect,
      writebackTargetBlockedSteps: writebackBlocked,
      concreteTypedValues,
      defaultTypedValues,
      symbolicTypedValues,
      avoidedRegisterShapeSuspects,
      currentFinding: `Trace-only VM walks ${allSteps.length} group steps across ${scripts.length} focused scripts under execution-best modes; ${highDefaulted} high-opcode numeric operand step(s) resolve as runtime default-value cases while other high-opcode reads are record copies, ${registerShapeText}; ${writebackBlocked} direct writeback steps still need a resolvable operand0 target.`,
      emulatorImpact: "The emulator can now advance real group cursors and expose the first semantic blockers without pretending decoded scene evidence is executable gameplay.",
      nextTarget: "Bind reference/writeback records for operand0 via +0x54/+0x60 and resolve the avoided s_04 compact group32/tail ambiguity before enabling visible script effects.",
    },
    scripts,
  };
}

function mdRow(cells) {
  return `| ${cells.map((cell) => String(cell ?? "").replace(/\|/g, "\\|")).join(" | ")} |`;
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# XSE Trace VM Probe");
  lines.push("");
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Switch replay: \`${report.inputs.switchReplay}\``);
  lines.push(`- Dispatch: \`${report.inputs.dispatch}\``);
  lines.push(`- Case probe: \`${report.inputs.caseProbe}\``);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Status: ${report.summary.status}`);
  lines.push(`- Finding: ${report.summary.currentFinding}`);
  lines.push(`- Emulator impact: ${report.summary.emulatorImpact}`);
  lines.push(`- Next target: ${report.summary.nextTarget}`);
  if (report.summary.avoidedRegisterShapeSuspects?.length) {
    const avoided = report.summary.avoidedRegisterShapeSuspects
      .map((item) => `${item.name}:${item.dispatchMode}->${item.executionMode} groups=${item.suspectGroups.join(",")}`)
      .join("; ");
    lines.push(`- Avoided register-shape paths: ${avoided}`);
  }
  lines.push("");
  lines.push(mdRow(["Script", "Mode", "Steps", "Direct/default", "High-op defaults", "Writeback blockers", "Register-shape suspects", "Final"]));
  lines.push(mdRow(["---", "---", "---:", "---", "---:", "---:", "---:", "---"]));
  for (const script of report.scripts) {
    lines.push(mdRow([
      script.name,
      script.mode,
      script.steps.length,
      `${script.directSteps}/${script.defaultSteps}`,
      script.highOpcodeOperandDefaultSteps,
      script.writebackTargetBlockedSteps,
      script.registerShapeSuspectSteps,
      `cursor=${script.finalCursor} active=${script.active}`,
    ]));
  }
  lines.push("");
  lines.push("## Step Trace");
  for (const script of report.scripts) {
    lines.push("");
    lines.push(`### ${script.name}`);
    for (const step of script.steps) {
      const blockers = step.blockers.length ? ` blockers=${step.blockers.join(",")}` : "";
      const notes = step.notes.length ? ` notes=${step.notes.join(";")}` : "";
      const sub = step.arithmeticSubtarget ? ` sub=${step.arithmeticSubtarget}` : "";
      const opcodes = step.opcodeSummary.firstOpcodes.join(" ");
      lines.push(`- cursor ${step.cursor}: group=${step.groupId} target=${step.target}${sub} ${step.caseStatus}; records=${step.opcodeSummary.recordCount} high=${step.opcodeSummary.highOpcodeRecords}; first=${opcodes}${blockers}${notes}; effect=${step.stateEffect}`);
      if (step.semantics?.writeback) {
        lines.push(`  - writeback: ${step.semantics.writeback.resolves ? "resolved" : "unresolved"} ${step.semantics.writeback.kind} (${step.semantics.writeback.note})`);
      }
      if (step.requiredRecords.length) {
        for (const record of step.requiredRecords) {
          const fields = record.fields.map((field) => `${field.label}=${field.value}`).join(", ");
          lines.push(`  - record${record.index} ${record.opcodeHex} ${record.highOpcode ? "high" : "low"} ${record.action}${fields ? ` (${fields})` : ""}`);
          const operand = (step.semantics?.operands || []).find((item) => item.index === record.index);
          if (operand) {
            const typed = operand.typedValue;
            lines.push(`    - typed-value: ${typed.kind} value=${typed.value ?? "?"}${typed.helper ? ` helper=${typed.helper}` : ""} (${typed.note})`);
          }
        }
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
  const outDir = path.resolve(argv[0] || DEFAULT_OUT);
  fs.mkdirSync(outDir, { recursive: true });
  const report = buildReport();
  const jsonFile = path.join(outDir, "xse_trace_vm_probe.json");
  const mdFile = path.join(outDir, "xse_trace_vm_probe.md");
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
