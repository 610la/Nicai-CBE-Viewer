const fs = require("fs");
const path = require("path");

const SWITCH_REPLAY_JSON = path.resolve(__dirname, "out_godwar_xseswitchreplay", "xse_switch_replay_probe.json");
const TRACE_VM_JSON = path.resolve(__dirname, "out_godwar_xsetracevm", "xse_trace_vm_probe.json");
const WRITEBACK_JSON = path.resolve(__dirname, "out_godwar_xsewriteback", "xse_writeback_probe.json");
const ACTIVATED_OPERAND_JSON = path.resolve(__dirname, "out_godwar_xseactivatedoperand", "xse_activated_operand_probe.json");
const RUNTIME_DISPATCH_JSON = path.resolve(__dirname, "out_godwar_xsedispatch", "xse_runtime_dispatch_probe.json");
const DEFAULT_OUT = path.resolve(__dirname, "out_godwar_xsehighopcode");

const POINTER_TYPES = new Set([3, 4, 8]);
const NUMERIC_VALUE_HELPER = "0x118FA -> 0x11862 -> 0x118D2";
const RECORD_READ_HELPER = "0x11862";
const POINTER_HELPER = "0x11AE6";

const RUNTIME_CONTRACT = {
  loader: {
    site: "0x1148E",
    sequence: "cmp opcode,#9; bhs 0x1150E",
    meaning: "opcode >= 9 is stored as a one-byte record and the 0..8 operand-field switch is skipped; it is not a loader failure",
  },
  recordResolver: {
    site: "0x11862",
    acceptedReferences: [3, 4, 8],
    fallback: "types outside 3/4/8 are copied as the original record; they are not rejected while reading an operand record",
  },
  numericValue: {
    site: "0x118D2",
    acceptedValueTypes: [0, 1, 2],
    fallback: "types outside 0/1/2 return numeric 0 after the 0x11862 record-resolution step",
  },
  writebackTarget: {
    site: "0x11AE6",
    acceptedTargets: [3, 4, 8],
    fallback: "types outside 3/4/8 return null as a destination pointer",
  },
  group6Case: {
    site: "0x11ED4",
    sequence: "0x11EDA movs r1,#0; 0x11EDE bl 0x11862; group id 6 falls through to 0x11FD2",
    meaning: "group 6 copies operand0 as a record and then writes it back through 0x11AE6(operand0); it does not call the numeric-default helper",
  },
};

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function hexByte(value) {
  return Number.isInteger(value) ? `0x${value.toString(16).toUpperCase().padStart(2, "0")}` : "";
}

function isHigh(opcode) {
  return Number.isInteger(opcode) && opcode >= 9;
}

function isPointer(opcode) {
  return POINTER_TYPES.has(opcode);
}

function fieldText(record) {
  return (record?.fields || []).map((field) => `${field.label}=${field.value}`).join(", ");
}

function recordBrief(record) {
  if (!record) return null;
  return {
    index: record.recordIndex ?? record.index ?? null,
    start: record.startHex || record.start || "",
    end: record.endHex || record.end || "",
    opcode: record.opcode,
    opcodeHex: record.opcodeHex || hexByte(record.opcode),
    highOpcode: Boolean(record.highOpcode ?? isHigh(record.opcode)),
    pointerType: isPointer(record.opcode),
    action: record.switchAction || record.action || "",
    fields: (record.fields || []).map((field) => ({
      label: field.label,
      value: field.value,
      raw: field.raw,
      tag: field.tag,
    })),
  };
}

function chooseExecutionAttempt(switchScript, dispatchScript) {
  const mode = dispatchScript?.executionBest?.mode || dispatchScript?.dispatchBest?.mode || switchScript.best?.shortMode || "";
  const attempts = switchScript.attempts || [];
  return attempts.find((attempt) => attempt.ok && attempt.shortMode === mode)
    || switchScript.best
    || attempts.find((attempt) => attempt.ok)
    || null;
}

function stepKey(script, cursor, groupId) {
  return `${script}|${cursor}|${groupId}`;
}

function groupKey(group) {
  return `${group?.index ?? ""}|${group?.id?.value ?? ""}`;
}

function makeExecutionGroups(switchReplay, runtimeDispatch) {
  const dispatchByName = new Map((runtimeDispatch.scripts || []).map((script) => [script.name, script]));
  const result = new Map();
  for (const script of switchReplay.scripts || []) {
    const attempt = chooseExecutionAttempt(script, dispatchByName.get(script.name));
    const groupMap = new Map();
    for (const group of attempt?.groups || []) {
      groupMap.set(groupKey(group), group);
    }
    result.set(script.name, { attempt, groupMap });
  }
  return result;
}

function makeTraceStepMap(traceVm) {
  const result = new Map();
  for (const script of traceVm.scripts || []) {
    for (const step of script.steps || []) {
      result.set(stepKey(script.name, step.cursor, step.groupId), step);
    }
  }
  return result;
}

function highOpcodeUseForStep(step) {
  const target = step?.target || "";
  const groupId = step?.groupId;
  if (target === "0x012222") {
    return {
      helper: NUMERIC_VALUE_HELPER,
      kind: "numeric-default",
      writesBack: false,
      note: "delay/state case calls 0x118FA(operand0), so high opcode records become numeric 0 here",
    };
  }
  if (target === "0x01223E") {
    return {
      helper: RECORD_READ_HELPER,
      kind: "record-read-before-clear-active",
      writesBack: false,
      note: "clear-active reads operand0 through 0x11862 but does not call 0x118D2 or 0x11AE6 for that operand",
    };
  }
  if (target === "0x011ED4" && groupId === 6) {
    return {
      helper: RECORD_READ_HELPER,
      kind: "identity-writeback",
      writesBack: true,
      note: "group 6 reads operand0 through 0x11862 and falls through to the 0x11FD2 writeback without numeric conversion",
    };
  }
  if (target === "0x011ED4") {
    return {
      helper: `${RECORD_READ_HELPER} plus unary case branches`,
      kind: "unary-value-family",
      writesBack: true,
      note: "unary group ids 7/8/9/13 may transform the resolved record, then all visible paths write through operand0",
    };
  }
  if (target === "0x011D4C") {
    return {
      helper: `${RECORD_READ_HELPER} plus binary subcase branches`,
      kind: "binary-value-family",
      writesBack: true,
      note: "binary cases read operand0/operand1 as records first; the final visible path writes through operand0",
    };
  }
  return {
    helper: "",
    kind: "not-high-op-value-case",
    writesBack: false,
    note: "this traced case does not currently bind a high-opcode value helper",
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

function runtimeClassForOpcode(opcode) {
  if (!Number.isInteger(opcode)) return "missing";
  if (isPointer(opcode)) return "pointer-target";
  if (isHigh(opcode)) return "high-opcode-non-target";
  return "immediate-non-target";
}

function enrichWritebackRisk(risk, traceStepMap, executionGroups) {
  const step = traceStepMap.get(stepKey(risk.script, risk.groupIndex, risk.groupId)) || null;
  const execution = executionGroups.get(risk.script);
  const group = execution?.groupMap.get(`${risk.groupIndex}|${risk.groupId}`) || null;
  const operand0 = group?.records?.[0] || null;
  const pointerRecords = (group?.records || [])
    .filter((record) => isPointer(record.opcode))
    .slice(0, 8)
    .map(recordBrief);
  const use = highOpcodeUseForStep(step || risk);
  const opcode = risk.operand0Opcode;
  return {
    script: risk.script,
    mode: risk.mode,
    cursor: risk.groupIndex,
    groupId: risk.groupId,
    target: risk.target,
    caseStatus: step?.caseStatus || "",
    arithmeticSubtarget: step?.arithmeticSubtarget || "",
    operand0: recordBrief(operand0) || {
      opcode,
      opcodeHex: risk.operand0OpcodeHex || hexByte(opcode),
      highOpcode: isHigh(opcode),
      pointerType: isPointer(opcode),
    },
    runtimeClass: runtimeClassForOpcode(opcode),
    highOpcodeUse: use,
    pointerRecordsInSameGroup: pointerRecords,
    firstOpcodes: step?.opcodeSummary?.firstOpcodes || (group?.records || []).slice(0, 12).map((record) => record.opcodeHex || hexByte(record.opcode)),
    resolution: risk.operand0Resolution || null,
    visibleEffectSafe: false,
    blocker: isHigh(opcode)
      ? "high opcode can be read as a record/value but cannot be a 0x11AE6 destination"
      : "operand0 is not one of the 0x11AE6 destination-producing types 3/4/8",
  };
}

function collectHighOperandRows(traceVm) {
  const rows = [];
  for (const script of traceVm.scripts || []) {
    for (const step of script.steps || []) {
      const highRecords = (step.requiredRecords || []).filter((record) => record.highOpcode || isHigh(record.opcode));
      if (!highRecords.length) continue;
      const highRecordRows = highRecords.map((record) => ({
        ...recordBrief(record),
        useKind: operandUseKind(step.target, step.groupId, record.index),
      }));
      rows.push({
        script: script.name,
        mode: script.mode,
        cursor: step.cursor,
        groupId: step.groupId,
        target: step.target,
        caseStatus: step.caseStatus,
        highOpcodeUse: highOpcodeUseForStep(step),
        highRecords: highRecordRows,
        numericDefaultRecordCount: highRecordRows.filter((record) => record.useKind === "numeric" || record.useKind === "numeric-or-resource").length,
        writebackBlocked: (step.blockers || []).includes("writeback target unresolved"),
        notes: step.notes || [],
      });
    }
  }
  return rows;
}

function collectActivatedRows(activatedOperand, switchReplay, runtimeDispatch, traceStepMap) {
  const executionGroups = makeExecutionGroups(switchReplay, runtimeDispatch);
  const rows = [];
  for (const row of activatedOperand.rows || []) {
    const dispatch = row.dispatch || {};
    const opcode = dispatch.operand0?.type;
    if (!isHigh(opcode)) continue;
    const cursor = Number.isInteger(dispatch.activatedCursor) ? dispatch.activatedCursor : row.group?.cursor;
    const execution = executionGroups.get(row.script);
    const group = execution?.groupMap.get(`${cursor}|${dispatch.groupId}`) || null;
    const step = traceStepMap.get(stepKey(row.script, cursor, dispatch.groupId)) || null;
    const pointerRecords = (group?.records || [])
      .filter((record) => isPointer(record.opcode))
      .slice(0, 8)
      .map(recordBrief);
    rows.push({
      script: row.script,
      traceMode: row.traceMode || "",
      cursor,
      groupId: dispatch.groupId,
      target: dispatch.target,
      caseStatus: dispatch.caseStatus,
      operand0: dispatch.operand0,
      highOpcodeUse: highOpcodeUseForStep(step || dispatch),
      firstRecords: (group?.records || []).slice(0, 12).map(recordBrief),
      pointerRecordsInSameGroup: pointerRecords,
      finding: `activated ${row.script} cursor ${cursor} enters group ${dispatch.groupId} with operand0 ${dispatch.operand0?.typeHex || hexByte(opcode)}; later pointer-type records (${pointerRecords.map((item) => `r${item.index}:${item.opcodeHex}`).join(", ") || "none"}) are not used by the 0x11FD2 destination call`,
    });
  }
  return rows;
}

function collectOpcodeHistogram(switchReplay, runtimeDispatch) {
  const dispatchByName = new Map((runtimeDispatch.scripts || []).map((script) => [script.name, script]));
  const hist = new Map();
  for (const script of switchReplay.scripts || []) {
    const attempt = chooseExecutionAttempt(script, dispatchByName.get(script.name));
    for (const group of attempt?.groups || []) {
      for (const record of group.records || []) {
        const opcode = record.opcode;
        if (!isHigh(opcode)) continue;
        const key = opcode;
        const row = hist.get(key) || {
          opcode,
          opcodeHex: hexByte(opcode),
          count: 0,
          scripts: new Set(),
          sampleOffsets: [],
        };
        row.count += 1;
        row.scripts.add(script.name);
        if (row.sampleOffsets.length < 8) row.sampleOffsets.push(`${script.name}:${record.startHex}`);
        hist.set(key, row);
      }
    }
  }
  return Array.from(hist.values())
    .map((row) => ({
      opcode: row.opcode,
      opcodeHex: row.opcodeHex,
      count: row.count,
      scripts: Array.from(row.scripts).sort(),
      sampleOffsets: row.sampleOffsets,
    }))
    .sort((a, b) => b.count - a.count || a.opcode - b.opcode)
    .slice(0, 24);
}

function buildReport() {
  const switchReplay = readJson(SWITCH_REPLAY_JSON);
  const traceVm = readJson(TRACE_VM_JSON);
  const writeback = readJson(WRITEBACK_JSON);
  const activatedOperand = readJson(ACTIVATED_OPERAND_JSON);
  const runtimeDispatch = readJson(RUNTIME_DISPATCH_JSON);
  const traceStepMap = makeTraceStepMap(traceVm);
  const executionGroups = makeExecutionGroups(switchReplay, runtimeDispatch);
  const writebackRows = (writeback.executionRisks || []).map((risk) => enrichWritebackRisk(risk, traceStepMap, executionGroups));
  const highWritebackRows = writebackRows.filter((row) => row.runtimeClass === "high-opcode-non-target");
  const immediateWritebackRows = writebackRows.filter((row) => row.runtimeClass === "immediate-non-target");
  const highOperandRows = collectHighOperandRows(traceVm);
  const activatedRows = collectActivatedRows(activatedOperand, switchReplay, runtimeDispatch, traceStepMap);
  const numericDefaultRows = highOperandRows.filter((row) => row.numericDefaultRecordCount > 0);
  const identityWritebackRows = highOperandRows.filter((row) => row.highOpcodeUse.kind === "identity-writeback");
  const histogram = collectOpcodeHistogram(switchReplay, runtimeDispatch);
  const activatedHighBlocked = activatedRows.filter((row) => row.highOpcodeUse.writesBack);

  const status = highWritebackRows.length || activatedHighBlocked.length
    ? "high-opcode-writeback-blocked"
    : "high-opcode-contract-bound";
  const currentFinding = `High opcode records are loader-valid and can be read by ${RECORD_READ_HELPER}, but ${POINTER_HELPER} only returns destinations for types 3/4/8. ${highWritebackRows.length}/${writebackRows.length} execution writeback risk(s) use high operand0 records; ${activatedHighBlocked.length}/${activatedRows.length} activated high-opcode row(s) still write through operand0. The active s_01 group-6 case is an identity writeback, not a numeric-default rescue.`;

  return {
    schema: "nicai.cbe.xseHighOpcodeProbe.v1",
    generatedAt: new Date().toISOString(),
    inputs: {
      switchReplay: SWITCH_REPLAY_JSON,
      traceVm: TRACE_VM_JSON,
      writeback: WRITEBACK_JSON,
      activatedOperand: ACTIVATED_OPERAND_JSON,
      runtimeDispatch: RUNTIME_DISPATCH_JSON,
    },
    runtimeContract: RUNTIME_CONTRACT,
    summary: {
      status,
      scriptCount: traceVm.summary?.scriptCount || 0,
      writebackRiskCount: writebackRows.length,
      highOpcodeWritebackRiskCount: highWritebackRows.length,
      immediateWritebackRiskCount: immediateWritebackRows.length,
      highOperandUseCount: highOperandRows.length,
      numericDefaultHighOperandCount: numericDefaultRows.length,
      identityWritebackHighOperandCount: identityWritebackRows.length,
      activatedHighOpcodeCount: activatedRows.length,
      activatedHighOpcodeBlockedCount: activatedHighBlocked.length,
      highOpcodeHistogram: histogram.slice(0, 12),
      currentFinding,
      emulatorImpact: "The generic web emulator should preserve opcode>=9 records and allow trace-only reads, but it must not enable visible effects when 0x11FD2 would copy to a null destination returned by 0x11AE6.",
      nextTarget: "Use this contract to demote label-entry candidates that dispatch to group-6/high-operand0 writebacks, then continue binding the true +0x64 range-table count/ref widths until the selected entry reaches a type 3/4/8 destination or a non-writeback case.",
    },
    highOperandRows,
    writebackRows,
    activatedRows,
    opcodeHistogram: histogram,
  };
}

function mdRow(cells) {
  return `| ${cells.map((cell) => String(cell ?? "").replace(/\|/g, "\\|")).join(" | ")} |`;
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# XSE High Opcode Probe");
  lines.push("");
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Status: ${report.summary.status}`);
  lines.push(`- Finding: ${report.summary.currentFinding}`);
  lines.push(`- Emulator impact: ${report.summary.emulatorImpact}`);
  lines.push(`- Next target: ${report.summary.nextTarget}`);
  lines.push("");
  lines.push("## Runtime Contract");
  lines.push("");
  lines.push(`- Loader ${report.runtimeContract.loader.site}: ${report.runtimeContract.loader.meaning}.`);
  lines.push(`- Record read ${report.runtimeContract.recordResolver.site}: ${report.runtimeContract.recordResolver.fallback}.`);
  lines.push(`- Numeric value ${report.runtimeContract.numericValue.site}: ${report.runtimeContract.numericValue.fallback}.`);
  lines.push(`- Writeback target ${report.runtimeContract.writebackTarget.site}: ${report.runtimeContract.writebackTarget.fallback}.`);
  lines.push(`- Group 6 ${report.runtimeContract.group6Case.site}: ${report.runtimeContract.group6Case.meaning}.`);
  lines.push("");
  lines.push("## High Operand Uses");
  lines.push("");
  lines.push(mdRow(["Script", "Cursor", "Group", "Target", "High opcodes", "Use", "Writeback blocked"]));
  lines.push(mdRow(["---", "---:", "---:", "---", "---", "---", "---"]));
  for (const row of report.highOperandRows) {
    lines.push(mdRow([
      row.script,
      row.cursor,
      row.groupId,
      row.target,
      row.highRecords.map((record) => `${record.index}:${record.opcodeHex}/${record.useKind}`).join(" "),
      row.highOpcodeUse.kind,
      row.writebackBlocked ? "yes" : "no",
    ]));
  }
  lines.push("");
  lines.push("## Writeback Risks");
  lines.push("");
  lines.push(mdRow(["Script", "Cursor", "Group", "Target", "Operand0", "Class", "Pointer records in group", "Reason"]));
  lines.push(mdRow(["---", "---:", "---:", "---", "---", "---", "---", "---"]));
  for (const row of report.writebackRows) {
    lines.push(mdRow([
      row.script,
      row.cursor,
      row.groupId,
      row.target,
      row.operand0?.opcodeHex || "",
      row.runtimeClass,
      row.pointerRecordsInSameGroup.map((record) => `r${record.index}:${record.opcodeHex}`).join(" ") || "-",
      row.blocker,
    ]));
  }
  lines.push("");
  lines.push("## Activated High Opcode Rows");
  if (!report.activatedRows.length) {
    lines.push("");
    lines.push("- none");
  } else {
    lines.push("");
    for (const row of report.activatedRows) {
      lines.push(`- ${row.finding}`);
      if (row.firstRecords?.length) {
        const records = row.firstRecords.map((record) => `${record.index}:${record.opcodeHex}${record.pointerType ? "*" : ""}${fieldText(record) ? `(${fieldText(record)})` : ""}`).join(" ");
        lines.push(`  - first records: ${records}`);
      }
      lines.push(`  - high-opcode use: ${row.highOpcodeUse.kind}; ${row.highOpcodeUse.note}`);
    }
  }
  lines.push("");
  lines.push("## Execution High Opcode Histogram");
  lines.push("");
  lines.push(mdRow(["Opcode", "Count", "Scripts", "Samples"]));
  lines.push(mdRow(["---", "---:", "---", "---"]));
  for (const row of report.opcodeHistogram.slice(0, 16)) {
    lines.push(mdRow([row.opcodeHex, row.count, row.scripts.join(", "), row.sampleOffsets.join(", ")]));
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
  const jsonFile = path.join(outDir, "xse_high_opcode_probe.json");
  const mdFile = path.join(outDir, "xse_high_opcode_probe.md");
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
