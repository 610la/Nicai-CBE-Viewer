const fs = require("fs");
const path = require("path");

const TRACE_VM_JSON = path.resolve(__dirname, "out_godwar_xsetracevm", "xse_trace_vm_probe.json");
const SLOT_LIFECYCLE_JSON = path.resolve(__dirname, "out_godwar_xseslotlifecycle", "xse_slot_lifecycle_probe.json");
const WRITEBACK_JSON = path.resolve(__dirname, "out_godwar_xsewriteback", "xse_writeback_probe.json");
const DEFAULT_OUT = path.resolve(__dirname, "out_godwar_xseoperandbinding");

const POINTER_TYPES = new Set([3, 4, 8]);
const STACK_INDEX_TYPES = new Set([3, 4]);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function opSummary(op) {
  if (!op) return null;
  return {
    index: op.index,
    type: op.type,
    typeHex: op.typeHex || (Number.isInteger(op.type) ? `0x${op.type.toString(16).toUpperCase().padStart(2, "0")}` : ""),
    pointerKind: op.pointer?.kind || "",
    pointerResolves: Boolean(op.pointer?.resolves),
    typedValueKind: op.typedValue?.kind || "",
  };
}

function blockerRows(traceVm) {
  const rows = [];
  for (const script of traceVm.scripts || []) {
    for (const step of script.steps || []) {
      if (!(step.blockers || []).includes("writeback target unresolved")) continue;
      const operands = step.semantics?.operands || [];
      const operand0 = opSummary(operands[0]);
      const operand1 = opSummary(operands[1]);
      const op0Type = operand0?.type;
      const pointerType = POINTER_TYPES.has(op0Type);
      const stackSeedRelevant = STACK_INDEX_TYPES.has(op0Type);
      rows.push({
        script: script.name,
        mode: script.mode,
        cursor: step.cursor,
        groupId: step.groupId,
        target: step.target,
        caseStatus: step.caseStatus,
        firstOpcodes: step.opcodeSummary?.firstOpcodes || [],
        operand0,
        operand1,
        operand0PointerType: pointerType,
        stackSeedRelevant,
        requiresReaderLayoutBinding: !pointerType,
        note: pointerType
          ? stackSeedRelevant
            ? "operand0 is a stack-index reference; +0x5C/+0x60 binding can affect the final address"
            : "operand0 is type 8 and resolves to the inline script record"
          : "operand0 is not a 3/4/8 pointer type, so +0x5C/+0x60 stack binding cannot make this writeback target valid",
      });
    }
  }
  return rows;
}

function buildReport() {
  const traceVm = readJson(TRACE_VM_JSON);
  const slotLifecycle = readJson(SLOT_LIFECYCLE_JSON);
  const writeback = readJson(WRITEBACK_JSON);
  const rows = blockerRows(traceVm);
  const pointerTypeRows = rows.filter((row) => row.operand0PointerType);
  const stackRelevantRows = rows.filter((row) => row.stackSeedRelevant);
  const readerLayoutRows = rows.filter((row) => row.requiresReaderLayoutBinding);
  const operand0Types = Array.from(new Set(rows.map((row) => row.operand0?.type).filter((value) => Number.isInteger(value)))).sort((a, b) => a - b);
  const operand1ReferenceRows = rows.filter((row) => POINTER_TYPES.has(row.operand1?.type));
  const status = stackRelevantRows.length ? "operand-stack-binding-needed" : "operand-layout-binding-needed";
  return {
    schema: "nicai.cbe.xseOperandBindingProbe.v1",
    generatedAt: new Date().toISOString(),
    inputs: {
      traceVm: TRACE_VM_JSON,
      slotLifecycle: SLOT_LIFECYCLE_JSON,
      writeback: WRITEBACK_JSON,
    },
    summary: {
      status,
      writebackBlockerCount: rows.length,
      operand0PointerTypeCount: pointerTypeRows.length,
      stackSeedRelevantBlockerCount: stackRelevantRows.length,
      readerLayoutBlockerCount: readerLayoutRows.length,
      operand0Types,
      operand1ReferenceCount: operand1ReferenceRows.length,
      currentFinding: stackRelevantRows.length
        ? `${stackRelevantRows.length}/${rows.length} unresolved writebacks have operand0 stack-reference types, so +0x5C/+0x60 binding can affect those targets.`
        : `All ${rows.length} unresolved writebacks have operand0 outside the 3/4/8 pointer set (${operand0Types.join(", ")}); +0x5C/+0x60 stack binding remains necessary for generic references, but it cannot by itself fix the current writeback blockers.`,
      emulatorImpact: "Do not resolve these writebacks by inventing stack targets. The next honest emulator step is correcting operand record layout/reader binding until operand0 itself is a valid pointer type, then applying the generic +0x54/+0x60 address rules.",
      nextTarget: "Re-check operand record boundaries and +0x4C/+0x50 reader binding around the direct value-op groups; keep +0x5C/+0x60 as the address layer only after operand0 is proven type 3/4.",
      slotLifecycleFinding: slotLifecycle.summary?.currentFinding || "",
      writebackFinding: writeback.summary?.currentFinding || "",
    },
    blockers: rows,
  };
}

function mdRow(cells) {
  return `| ${cells.map((cell) => String(cell ?? "").replace(/\|/g, "\\|")).join(" | ")} |`;
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# XSE Operand Binding Probe");
  lines.push("");
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Trace VM: \`${report.inputs.traceVm}\``);
  lines.push(`- Slot lifecycle: \`${report.inputs.slotLifecycle}\``);
  lines.push(`- Writeback: \`${report.inputs.writeback}\``);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Status: ${report.summary.status}`);
  lines.push(`- Finding: ${report.summary.currentFinding}`);
  lines.push(`- Emulator impact: ${report.summary.emulatorImpact}`);
  lines.push(`- Next target: ${report.summary.nextTarget}`);
  lines.push(`- Slot lifecycle context: ${report.summary.slotLifecycleFinding}`);
  lines.push("");
  lines.push(mdRow(["Script", "Mode", "Cursor", "Group", "Operand0", "Operand1", "Stack seed relevant", "Reason"]));
  lines.push(mdRow(["---", "---", "---:", "---:", "---", "---", "---", "---"]));
  for (const row of report.blockers) {
    const op0 = row.operand0 ? `${row.operand0.typeHex}/${row.operand0.pointerKind}` : "-";
    const op1 = row.operand1 ? `${row.operand1.typeHex}/${row.operand1.pointerKind}` : "-";
    lines.push(mdRow([
      row.script,
      row.mode,
      row.cursor,
      row.groupId,
      op0,
      op1,
      row.stackSeedRelevant ? "yes" : "no",
      row.note,
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
  const jsonFile = path.join(outDir, "xse_operand_binding_probe.json");
  const mdFile = path.join(outDir, "xse_operand_binding_probe.md");
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
