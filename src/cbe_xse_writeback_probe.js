const fs = require("fs");
const path = require("path");

const SWITCH_REPLAY_JSON = path.resolve(__dirname, "out_godwar_xseswitchreplay", "xse_switch_replay_probe.json");
const DISPATCH_CASES_JSON = path.resolve(__dirname, "out_godwar_xsedispatchcases", "xse_dispatch_case_probe.json");
const RUNTIME_DISPATCH_JSON = path.resolve(__dirname, "out_godwar_xsedispatch", "xse_runtime_dispatch_probe.json");
const DEFAULT_OUT = path.resolve(__dirname, "out_godwar_xsewriteback");
const PRIMARY_TABLE_COUNT = 0x21;
const WRITEBACK_TARGETS = new Set(["0x011D4C", "0x011ED4"]);
const REGISTER_SHAPE_TARGET = "0x015F08";
const REQUIRED_POINTER_TYPES = new Set([3, 4, 8]);

const RUNTIME_CONTRACT = {
  writebackSite: {
    address: "0x011FD2",
    localNullGuard: false,
    sequence: "r0=0; bl 0x11AE6; r2=0x28; r1=sp+0x158; blx 0x34540",
    meaning: "value-operator cases copy the computed record back to the pointer returned by 0x11AE6(operand0); the writeback site itself does not check for null",
  },
  pointerResolver: {
    address: "0x011AE6",
    acceptedTypes: [3, 4, 8],
    type3: "0x1180A returns operand.field+0x14, then 0x11AE6 indexes script +0x54; negative indexes add script +0x60 first",
    type4: "0x1180A copies script +0x54[operand.field+0x04], returns copied.field+0x08 + operand.field+0x14, then 0x11AE6 indexes script +0x54",
    type8: "returns the current script inline record at script+0x20",
    fallback: "all other operand0 types return null",
  },
  copyRecordByIndex: {
    address: "0x0117D8",
    recordSize: 0x28,
    meaning: "copy one 0x28-byte record from script +0x54; negative indexes are rebased through script +0x60",
  },
};

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function isDirectGroup(id) {
  return Number.isInteger(id) && id >= 0 && id < PRIMARY_TABLE_COUNT;
}

function targetForGroup(caseProbe, groupId) {
  for (const item of caseProbe.caseWindows || []) {
    if ((item.groupIds || []).includes(groupId)) return item.target;
  }
  return caseProbe.dispatcher?.primaryDefaultTarget || "0x011FE0";
}

function pointerKind(opcode) {
  if (opcode === 3) return "record-reference-direct-index";
  if (opcode === 4) return "record-reference-base-plus-delta";
  if (opcode === 8) return "script-record-base";
  if (opcode >= 9) return "high-opcode-no-target";
  return "immediate-no-target";
}

function pointerResolves(opcode) {
  return REQUIRED_POINTER_TYPES.has(opcode);
}

function fieldByOffset(record, offsetHex) {
  const suffix = offsetHex.toUpperCase().replace(/^0X/, "");
  return (record?.fields || []).find((field) => {
    const label = String(field.label || "").toUpperCase();
    return label.includes(`FIELD+${suffix}`);
  }) || null;
}

function operandResolution(record) {
  if (!record || !Number.isInteger(record.opcode)) {
    return {
      resolves: false,
      kind: "missing",
      runtimePath: "0x11AE6 has no operand record to inspect",
      requiredTypes: Array.from(REQUIRED_POINTER_TYPES),
    };
  }
  const opcode = record.opcode;
  if (opcode === 3) {
    const index = fieldByOffset(record, "0x14");
    return {
      resolves: true,
      kind: pointerKind(opcode),
      type: opcode,
      typeHex: record.opcodeHex || "",
      index: index?.value ?? null,
      indexRaw: index?.raw || "",
      runtimePath: "0x1180A(type3) returns operand.field+0x14; 0x11AE6 maps that index through script +0x54/+0x60",
      requiredTypes: Array.from(REQUIRED_POINTER_TYPES),
    };
  }
  if (opcode === 4) {
    const baseIndex = fieldByOffset(record, "0x04");
    const delta = fieldByOffset(record, "0x14");
    return {
      resolves: true,
      kind: pointerKind(opcode),
      type: opcode,
      typeHex: record.opcodeHex || "",
      baseIndex: baseIndex?.value ?? null,
      baseIndexRaw: baseIndex?.raw || "",
      delta: delta?.value ?? null,
      deltaRaw: delta?.raw || "",
      runtimePath: "0x1180A(type4) copies script +0x54[field+0x04], adds copied.field+0x08 to operand.field+0x14, then 0x11AE6 maps the result through script +0x54/+0x60",
      requiredTypes: Array.from(REQUIRED_POINTER_TYPES),
    };
  }
  if (opcode === 8) {
    const inlineField = fieldByOffset(record, "0x24");
    return {
      resolves: true,
      kind: pointerKind(opcode),
      type: opcode,
      typeHex: record.opcodeHex || "",
      inlineField: inlineField?.value ?? null,
      inlineFieldRaw: inlineField?.raw || "",
      runtimePath: "0x11AE6(type8) returns the current script inline record at script+0x20",
      requiredTypes: Array.from(REQUIRED_POINTER_TYPES),
    };
  }
  return {
    resolves: false,
    kind: pointerKind(opcode),
    type: opcode,
    typeHex: record.opcodeHex || "",
    runtimePath: "0x11AE6 returns null for operand0 types outside 3/4/8",
    requiredTypes: Array.from(REQUIRED_POINTER_TYPES),
  };
}

function summarizeAttempt(attempt, caseProbe) {
  const groups = attempt.groups || [];
  const writebackRisks = [];
  const writebackResolved = [];
  const registerShapeSuspects = [];
  const directGroups = [];
  const defaultGroups = [];

  for (const group of groups) {
    const groupId = group.id?.value;
    if (!isDirectGroup(groupId)) {
      defaultGroups.push(groupId);
      continue;
    }
    directGroups.push(groupId);
    const target = targetForGroup(caseProbe, groupId);
    if (target === REGISTER_SHAPE_TARGET) {
      registerShapeSuspects.push(groupId);
    }
    if (!WRITEBACK_TARGETS.has(target)) continue;
    const operand0 = group.records?.[0] || null;
    const opcode = operand0?.opcode;
    const item = {
      groupIndex: group.index,
      groupId,
      target,
      operand0Opcode: opcode,
      operand0OpcodeHex: operand0?.opcodeHex || "",
      pointerKind: Number.isInteger(opcode) ? pointerKind(opcode) : "missing",
      operand0Resolution: operandResolution(operand0),
      writebackSite: RUNTIME_CONTRACT.writebackSite.address,
      localNullGuard: RUNTIME_CONTRACT.writebackSite.localNullGuard,
      riskClass: Number.isInteger(opcode) && pointerResolves(opcode) ? "" : "null-copy-site",
    };
    if (Number.isInteger(opcode) && pointerResolves(opcode)) writebackResolved.push(item);
    else writebackRisks.push(item);
  }

  return {
    mode: attempt.shortMode,
    ok: Boolean(attempt.ok),
    groupIds: groups.map((group) => group.id?.value),
    directGroups,
    defaultGroups,
    groupEnd: attempt.groupEndHex || "",
    tailEnd: attempt.bestTail?.endHex || "",
    layoutDelta: attempt.layoutDelta ?? null,
    tailOk: Boolean(attempt.bestTail?.ok),
    registerShapeSuspects,
    writebackRiskCount: writebackRisks.length,
    writebackResolvedCount: writebackResolved.length,
    writebackRisks,
    writebackResolved,
  };
}

function buildReport() {
  const switchReplay = readJson(SWITCH_REPLAY_JSON);
  const caseProbe = readJson(DISPATCH_CASES_JSON);
  const runtimeDispatch = readJson(RUNTIME_DISPATCH_JSON);
  const runtimeByName = new Map((runtimeDispatch.scripts || []).map((script) => [script.name, script]));
  const scripts = (switchReplay.scripts || []).map((script) => {
    const attempts = (script.attempts || [])
      .filter((attempt) => attempt.ok)
      .map((attempt) => summarizeAttempt(attempt, caseProbe));
    const runtime = runtimeByName.get(script.name) || {};
    const executionMode = runtime.executionBest?.mode || runtime.dispatchBest?.mode || script.best?.shortMode || "";
    const executionAttempt = attempts.find((attempt) => attempt.mode === executionMode) || null;
    const lowRiskModes = attempts
      .filter((attempt) => attempt.writebackRiskCount === 0 && attempt.registerShapeSuspects.length === 0)
      .map((attempt) => attempt.mode);
    return {
      name: script.name,
      executionMode,
      executionAttempt,
      lowRiskModes,
      attempts,
    };
  });
  const executionRisks = scripts.flatMap((script) => (
    script.executionAttempt?.writebackRisks || []
  ).map((risk) => ({ script: script.name, mode: script.executionMode, ...risk })));
  const allLowRiskButDefaultOnly = scripts
    .filter((script) => script.lowRiskModes.length)
    .filter((script) => script.lowRiskModes.every((mode) => {
      const attempt = script.attempts.find((item) => item.mode === mode);
      return attempt && attempt.directGroups.length === 0;
    }))
    .map((script) => script.name);
  const directLowRiskScripts = scripts
    .filter((script) => script.lowRiskModes.length)
    .filter((script) => script.lowRiskModes.some((mode) => {
      const attempt = script.attempts.find((item) => item.mode === mode);
      return attempt && attempt.directGroups.length > 0;
    }))
    .map((script) => script.name);
  return {
    schema: "nicai.cbe.xseWritebackProbe.v1",
    generatedAt: new Date().toISOString(),
    inputs: {
      switchReplay: SWITCH_REPLAY_JSON,
      dispatchCases: DISPATCH_CASES_JSON,
      runtimeDispatch: RUNTIME_DISPATCH_JSON,
    },
    summary: {
      status: executionRisks.length ? "writeback-target-risk" : "writeback-targets-resolved",
      scriptCount: scripts.length,
      executionWritebackRiskCount: executionRisks.length,
      executionRiskScripts: Array.from(new Set(executionRisks.map((item) => item.script))),
      allLowRiskButDefaultOnly,
      directLowRiskScripts,
      nullGuardedWritebackSite: RUNTIME_CONTRACT.writebackSite.localNullGuard,
      writebackSite: RUNTIME_CONTRACT.writebackSite.address,
      requiredPointerTypes: Array.from(REQUIRED_POINTER_TYPES),
      currentFinding: executionRisks.length
        ? `Execution-best modes contain ${executionRisks.length} direct writeback steps whose operand0 does not resolve as a type 3/4/8 target; 0x11FD2 has no local null guard, and low-risk alternatives are mostly default-only modes, so this is a reader/cursor binding problem rather than a safe effect path.`
        : "Execution-best modes have resolvable operand0 writeback targets for all direct writeback cases.",
      emulatorImpact: "Visible script effects must stay disabled until writebacks can land on real +0x54/+0x60 records, the live reader/cursor chooses different executable groups, or the shared copy helper is proven null-safe.",
      nextTarget: "Bind exact live +0x50 reader/cursor state and the +0x54/+0x60 record stack, or prove the 0x34540 copy helper ignores null destinations; until then the web emulator should remain trace-only for XSE effects.",
    },
    runtimeContract: RUNTIME_CONTRACT,
    executionRisks,
    scripts,
  };
}

function mdRow(cells) {
  return `| ${cells.map((cell) => String(cell ?? "").replace(/\|/g, "\\|")).join(" | ")} |`;
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# XSE Writeback Probe");
  lines.push("");
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Switch replay: \`${report.inputs.switchReplay}\``);
  lines.push(`- Dispatch cases: \`${report.inputs.dispatchCases}\``);
  lines.push(`- Runtime dispatch: \`${report.inputs.runtimeDispatch}\``);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Status: ${report.summary.status}`);
  lines.push(`- Finding: ${report.summary.currentFinding}`);
  lines.push(`- Emulator impact: ${report.summary.emulatorImpact}`);
  lines.push(`- Next target: ${report.summary.nextTarget}`);
  lines.push(`- Writeback site: ${report.summary.writebackSite}; local null guard: ${report.summary.nullGuardedWritebackSite ? "yes" : "no"}; required operand0 types: ${report.summary.requiredPointerTypes.join(", ")}`);
  lines.push("");
  lines.push(mdRow(["Script", "Execution mode", "Exec direct/default", "Exec writeback risks", "Low-risk modes"]));
  lines.push(mdRow(["---", "---", "---", "---:", "---"]));
  for (const script of report.scripts) {
    const exec = script.executionAttempt || {};
    lines.push(mdRow([
      script.name,
      script.executionMode,
      `${exec.directGroups?.length ?? "?"}/${exec.defaultGroups?.length ?? "?"}`,
      exec.writebackRiskCount ?? "?",
      script.lowRiskModes.join(", ") || "-",
    ]));
  }
  lines.push("");
  lines.push("## Runtime Contract");
  lines.push("");
  lines.push(`- ${report.runtimeContract.writebackSite.address}: ${report.runtimeContract.writebackSite.meaning}.`);
  lines.push(`- ${report.runtimeContract.pointerResolver.address}: accepts operand0 types ${report.runtimeContract.pointerResolver.acceptedTypes.join(", ")}; all other types return null.`);
  lines.push(`- type 3: ${report.runtimeContract.pointerResolver.type3}.`);
  lines.push(`- type 4: ${report.runtimeContract.pointerResolver.type4}.`);
  lines.push(`- type 8: ${report.runtimeContract.pointerResolver.type8}.`);
  lines.push(`- ${report.runtimeContract.copyRecordByIndex.address}: ${report.runtimeContract.copyRecordByIndex.meaning}.`);
  lines.push("");
  lines.push("## Execution Risks");
  if (!report.executionRisks.length) {
    lines.push("");
    lines.push("- none");
  } else {
    lines.push("");
    for (const risk of report.executionRisks) {
      lines.push(`- ${risk.script} ${risk.mode} cursor/group ${risk.groupIndex}/${risk.groupId}: target=${risk.target}, operand0=${risk.operand0OpcodeHex || risk.operand0Opcode}, ${risk.pointerKind}, ${risk.riskClass}; ${risk.operand0Resolution?.runtimePath || ""}`);
    }
  }
  lines.push("");
  lines.push("## Per-Mode Attempts");
  for (const script of report.scripts) {
    lines.push("");
    lines.push(`### ${script.name}`);
    for (const attempt of script.attempts) {
      lines.push(`- ${attempt.mode}: ids=${attempt.groupIds.join(",")}, direct=${attempt.directGroups.length}, default=${attempt.defaultGroups.length}, tail=${attempt.tailEnd} delta=${attempt.layoutDelta}, tailOk=${attempt.tailOk}, shape=${attempt.registerShapeSuspects.join(",") || "-"}, writebackRisk=${attempt.writebackRiskCount}, writebackResolved=${attempt.writebackResolvedCount}`);
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
  const jsonFile = path.join(outDir, "xse_writeback_probe.json");
  const mdFile = path.join(outDir, "xse_writeback_probe.md");
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
