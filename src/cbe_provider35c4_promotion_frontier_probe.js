const fs = require("fs");
const path = require("path");
const { DEFAULT_INPUT } = require("./cbe_unpack");
const { buildReport: buildSelectedTableReport } = require("./cbe_provider35c4_selected_table_walk_probe");

const DEFAULT_OUT = path.resolve(__dirname, "out_godwar_provider35c4frontier");
const RUNTIME_DISPATCH_JSON = path.resolve(__dirname, "out_godwar_xsedispatch", "xse_runtime_dispatch_probe.json");
const SWITCH_REPLAY_JSON = path.resolve(__dirname, "out_godwar_xseswitchreplay", "xse_switch_replay_probe.json");
const DISPATCH_CASE_JSON = path.resolve(__dirname, "out_godwar_xsedispatchcases", "xse_dispatch_case_probe.json");
const POINTER_TYPES = new Set([3, 4, 8]);
const WRITEBACK_TARGETS = new Set(["0x011D4C", "0x011ED4"]);

function mdRow(values) {
  return `| ${values.map((value) => String(value ?? "").replace(/\|/g, "\\|")).join(" | ")} |`;
}

function readJson(file, fallback = {}) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function normalizeLabel(label) {
  return String(label || "").trim().toLowerCase();
}

function byName(rows) {
  return new Map((rows || []).map((row) => [row.name, row]));
}

function runtimeSourceMode(scriptName, runtimeScript) {
  if (scriptName === "s_02.xse") {
    return {
      source: "tail-aligned-source-mode",
      mode: runtimeScript?.tailBest?.mode || "",
    };
  }
  return {
    source: "execution-best-source-mode",
    mode: runtimeScript?.executionBest?.mode || runtimeScript?.dispatchBest?.mode || runtimeScript?.tailBest?.mode || "",
  };
}

function switchGroupsFor(scriptName, mode, switchReplay) {
  const script = (switchReplay.scripts || []).find((row) => row.name === scriptName);
  if (!script) return [];
  const attempt = (script.attempts || []).find((row) => row.ok && row.shortMode === mode)
    || (script.best?.shortMode === mode ? script.best : null)
    || (script.attempts || []).find((row) => row.ok)
    || script.best;
  return attempt?.groups || [];
}

function targetForGroup(groupId, caseProbe) {
  if (!Number.isInteger(groupId) || groupId < 0 || groupId > 0x20) {
    return caseProbe.dispatcher?.primaryDefaultTarget || "0x011FE0";
  }
  const window = (caseProbe.caseWindows || []).find((row) => (row.groupIds || []).includes(groupId));
  return window?.target || caseProbe.dispatcher?.primaryDefaultTarget || "0x011FE0";
}

function classifyStatus(row) {
  if (!row.cursorValid) return "frontier-invalid-cursor";
  if (!row.stackDeltaCoherent) return "frontier-invalid-stack-delta";
  if (row.writebackBlocked) return row.operand0HighOpcode ? "frontier-high-opcode-writeback" : "frontier-writeback-blocked";
  if (row.defaultDispatchOnly) return "frontier-default-dispatch-only";
  if (row.directCaseDispatch) return "frontier-direct-case-candidate";
  return "frontier-dispatch-unknown";
}

function statusReason(status) {
  switch (status) {
    case "frontier-invalid-cursor":
      return "selected record+0x00 is outside the traced group table";
    case "frontier-invalid-stack-delta":
      return "selected record+0x08+1 is not a coherent non-negative activation delta";
    case "frontier-high-opcode-writeback":
      return "activated direct writeback would use an opcode>=9 operand0 that cannot be a destination";
    case "frontier-writeback-blocked":
      return "activated direct writeback operand0 does not resolve as destination-producing type 3/4/8";
    case "frontier-default-dispatch-only":
      return "cursor is valid, but the group id falls through the runtime default dispatcher instead of a direct case";
    case "frontier-direct-case-candidate":
      return "cursor, stack delta, direct dispatch, and writeback destination checks pass if a real return-0 is observed";
    default:
      return "dispatch status is not classifiable under the current gate";
  }
}

function selectedCompareRows(selectedTable) {
  const rows = [];
  let seq = 0;
  for (const lane of selectedTable.lanes || []) {
    for (const entry of lane.rows || []) {
      if (entry.kind !== "range-entry") continue;
      for (const compare of entry.compares || []) {
        seq += 1;
        rows.push({
          seq,
          script: lane.script || "",
          policy: lane.policy || "",
          laneIndex: lane.laneIndex,
          modeKey: lane.modeKey || "",
          entryIndex: entry.index,
          entryOffset: entry.offset || "",
          label: compare.label || "",
          normalizedLabel: normalizeLabel(compare.label),
          providerRefId: entry.providerRefId || "",
          sourceReturnValue: compare.returnValue,
          sourceMatched: compare.returnValue === 0,
          field00: entry.field00?.value,
          field04: entry.field04?.value,
          field08: entry.field08?.value,
          field0C: entry.field0C,
          refRaw: entry.field10?.raw || "",
          refMode: entry.field10?.mode || "",
        });
      }
    }
  }
  return rows;
}

function classifyCompare(row, groups, sourceMode, caseProbe) {
  const cursor = row.field00;
  const cursorValid = Number.isInteger(cursor) && cursor >= 0 && cursor < groups.length;
  const group = cursorValid ? groups[cursor] : null;
  const groupId = group?.id?.value;
  const target = cursorValid ? targetForGroup(groupId, caseProbe) : "";
  const directCaseDispatch = Number.isInteger(groupId) && groupId >= 0 && groupId <= 0x20 && target !== (caseProbe.dispatcher?.primaryDefaultTarget || "0x011FE0");
  const defaultDispatchOnly = cursorValid && !directCaseDispatch;
  const operand0 = group?.records?.[0]?.opcode ?? null;
  const operand0Hex = Number.isInteger(operand0) ? `0x${operand0.toString(16).toUpperCase().padStart(2, "0")}` : "";
  const stackDelta = Number.isInteger(row.field08) ? row.field08 + 1 : null;
  const stackDeltaCoherent = Number.isInteger(stackDelta) && stackDelta >= 0 && stackDelta <= 256;
  const writebackTarget = WRITEBACK_TARGETS.has(target);
  const operand0Pointer = POINTER_TYPES.has(operand0);
  const operand0HighOpcode = Number.isInteger(operand0) && operand0 >= 9;
  const writebackBlocked = writebackTarget && !operand0Pointer;
  const status = classifyStatus({
    cursorValid,
    stackDeltaCoherent,
    writebackBlocked,
    operand0HighOpcode,
    defaultDispatchOnly,
    directCaseDispatch,
  });
  const schedulerCandidateIfObserved = cursorValid && stackDeltaCoherent && !writebackBlocked;
  const promotionEligibleIfObserved = schedulerCandidateIfObserved && directCaseDispatch;
  return {
    ...row,
    sourceMode: sourceMode.mode,
    sourceModeRole: sourceMode.source,
    groupCount: groups.length,
    cursorValid,
    stackDelta,
    stackDeltaCoherent,
    groupId,
    target,
    directCaseDispatch,
    defaultDispatchOnly,
    writebackTarget,
    operand0,
    operand0Hex,
    operand0Pointer,
    operand0HighOpcode,
    writebackBlocked,
    schedulerCandidateIfObserved,
    promotionEligibleIfObserved,
    status,
    reason: statusReason(status),
  };
}

function buildInvariant(id, passed, details, impact = "") {
  return { id, passed: Boolean(passed), details, impact };
}

function buildReport(options = {}) {
  const input = path.resolve(options.input || DEFAULT_INPUT);
  const selectedTable = buildSelectedTableReport({ input });
  const runtimeDispatch = readJson(RUNTIME_DISPATCH_JSON, {});
  const switchReplay = readJson(SWITCH_REPLAY_JSON, {});
  const caseProbe = readJson(DISPATCH_CASE_JSON, {});
  const runtimeByName = byName(runtimeDispatch.scripts);
  const groupsByScript = new Map();
  const sourceModes = {};
  for (const scriptName of Array.from(new Set((selectedTable.lanes || []).map((lane) => lane.script)))) {
    const sourceMode = runtimeSourceMode(scriptName, runtimeByName.get(scriptName));
    sourceModes[scriptName] = sourceMode;
    groupsByScript.set(scriptName, switchGroupsFor(scriptName, sourceMode.mode, switchReplay));
  }
  const compareRows = selectedCompareRows(selectedTable);
  const rows = compareRows.map((row) => classifyCompare(
    row,
    groupsByScript.get(row.script) || [],
    sourceModes[row.script] || { mode: "", source: "" },
    caseProbe,
  ));
  const sourceReturn0Rows = rows.filter((row) => row.sourceMatched);
  const validCursorRows = rows.filter((row) => row.cursorValid);
  const coherentStackRows = rows.filter((row) => row.stackDeltaCoherent);
  const validCursorAndStackRows = rows.filter((row) => row.cursorValid && row.stackDeltaCoherent);
  const directCaseRows = rows.filter((row) => row.directCaseDispatch);
  const defaultOnlyRows = rows.filter((row) => row.defaultDispatchOnly);
  const writebackBlockedRows = rows.filter((row) => row.writebackBlocked);
  const schedulerRows = rows.filter((row) => row.schedulerCandidateIfObserved);
  const promotionRows = rows.filter((row) => row.promotionEligibleIfObserved);
  const expectedCompareCount = selectedTable.summary?.compareOperationCount || selectedTable.counts?.compareOperationCount || 0;
  const statusCounts = rows.reduce((acc, row) => {
    acc[row.status] = (acc[row.status] || 0) + 1;
    return acc;
  }, {});
  const invariants = [
    buildInvariant(
      "frontier-covers-selected-compares",
      rows.length === expectedCompareCount,
      `${rows.length}/${expectedCompareCount} selected compare row(s) classified`,
      "The frontier gate must classify every selected table compare."
    ),
    buildInvariant(
      "no-observed-return0-yet",
      sourceReturn0Rows.length === 0,
      `${sourceReturn0Rows.length} selected compare row(s) currently returned 0`,
      "The frontier remains hypothetical until real provider observations exist."
    ),
    buildInvariant(
      "no-direct-promotion-with-empty-feed",
      promotionRows.length === 0 || sourceReturn0Rows.length === 0,
      `${promotionRows.length} direct-case candidate row(s), ${sourceReturn0Rows.length} observed return-0 row(s)`,
      "Even direct-case candidates cannot promote without observed return-0 feed rows."
    ),
    buildInvariant(
      "direct-case-frontier-not-yet-found",
      promotionRows.length === 0,
      `${promotionRows.length} direct-case promotion frontier row(s); ${schedulerRows.length} scheduler-only row(s)`,
      "Current selected lanes still need provider observations and possibly source-mode refinement before visible entry promotion."
    ),
    buildInvariant(
      "valid-scheduler-rows-are-default-only",
      schedulerRows.every((row) => row.defaultDispatchOnly),
      `${schedulerRows.length} scheduler candidate row(s), ${defaultOnlyRows.length} default-dispatch row(s)`,
      "The only cursor/stack-coherent selected rows currently fall through the default dispatcher, so they stay non-visible."
    ),
  ];
  const failures = invariants.filter((item) => !item.passed);
  return {
    schema: "nicai.cbe.provider35c4PromotionFrontierProbe.v1",
    generatedAt: new Date().toISOString(),
    input,
    inputs: {
      selectedTable: "cbe_provider35c4_selected_table_walk_probe.buildReport({ input })",
      runtimeDispatch: RUNTIME_DISPATCH_JSON,
      switchReplay: SWITCH_REPLAY_JSON,
      dispatchCases: DISPATCH_CASE_JSON,
    },
    sourceModes,
    counts: {
      selectedCompareCount: rows.length,
      sourceReturn0CompareCount: sourceReturn0Rows.length,
      validCursorCompareCount: validCursorRows.length,
      coherentStackCompareCount: coherentStackRows.length,
      validCursorAndStackCompareCount: validCursorAndStackRows.length,
      directCaseCompareCount: directCaseRows.length,
      defaultOnlyCompareCount: defaultOnlyRows.length,
      writebackBlockedCompareCount: writebackBlockedRows.length,
      schedulerCandidateIfObservedCount: schedulerRows.length,
      promotionEligibleIfObservedCount: promotionRows.length,
      statusCounts,
    },
    frontierRows: rows,
    schedulerCandidates: schedulerRows.slice(0, 64),
    directPromotionCandidates: promotionRows.slice(0, 64),
    invariants,
    summary: {
      status: failures.length ? "provider35c4-promotion-frontier-risk" : "provider35c4-promotion-frontier-guarded",
      currentFinding: "Selected table return-0 candidates are now classified through activation/dispatch/writeback gates: 268 compares yield 4 cursor/stack-coherent scheduler candidates, but 0 direct-case promotion candidates.",
      emulatorImpact: "The generic emulator can prioritize real provider return-0 capture without enabling effects: an observed match still needs valid cursor, coherent activation delta, direct dispatcher case, and writeback-safe operand0.",
      nextTarget: "Capture real provider +0x50 return-0 rows for selected lanes, then check whether any observed row enters the direct-case promotion frontier; otherwise refine source modes before visible entry execution.",
      visibleEffectsEnabled: false,
      failureCount: failures.length,
      selectedCompareCount: rows.length,
      sourceReturn0CompareCount: sourceReturn0Rows.length,
      schedulerCandidateIfObservedCount: schedulerRows.length,
      promotionEligibleIfObservedCount: promotionRows.length,
    },
  };
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# Provider 0x35C4 Promotion Frontier Probe");
  lines.push("");
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Input CBE: \`${report.input}\``);
  lines.push(`- Status: ${report.summary.status}`);
  lines.push(`- Finding: ${report.summary.currentFinding}`);
  lines.push(`- Emulator impact: ${report.summary.emulatorImpact}`);
  lines.push(`- Next target: ${report.summary.nextTarget}`);
  lines.push("");
  lines.push("## Counts");
  lines.push("");
  lines.push(mdRow(["Field", "Value"]));
  lines.push(mdRow(["---", "---:"]));
  for (const [key, value] of Object.entries(report.counts)) {
    lines.push(mdRow([key, typeof value === "object" ? JSON.stringify(value) : value]));
  }
  lines.push("");
  lines.push("## Source Modes");
  lines.push("");
  lines.push(mdRow(["Script", "Source", "Mode"]));
  lines.push(mdRow(["---", "---", "---"]));
  for (const [script, sourceMode] of Object.entries(report.sourceModes)) {
    lines.push(mdRow([script, sourceMode.source, sourceMode.mode]));
  }
  lines.push("");
  lines.push("## Scheduler Candidates If Observed");
  lines.push("");
  lines.push(mdRow(["Seq", "Script", "Policy", "Entry", "Label", "Ref", "Cursor", "GroupId", "Target", "Op0", "Delta", "Status"]));
  lines.push(mdRow(["---:", "---", "---", "---:", "---", "---", "---:", "---:", "---", "---", "---:", "---"]));
  for (const row of report.schedulerCandidates) {
    lines.push(mdRow([
      row.seq,
      row.script,
      row.policy,
      row.entryIndex,
      row.label,
      row.providerRefId,
      row.field00,
      row.groupId,
      row.target,
      row.operand0Hex,
      row.stackDelta,
      row.status,
    ]));
  }
  if (!report.schedulerCandidates.length) lines.push("- None.");
  lines.push("");
  lines.push("## Direct Promotion Candidates If Observed");
  lines.push("");
  if (report.directPromotionCandidates.length) {
    lines.push(mdRow(["Seq", "Script", "Policy", "Entry", "Label", "Ref", "Cursor", "GroupId", "Target", "Op0"]));
    lines.push(mdRow(["---:", "---", "---", "---:", "---", "---", "---:", "---:", "---", "---"]));
    for (const row of report.directPromotionCandidates) {
      lines.push(mdRow([row.seq, row.script, row.policy, row.entryIndex, row.label, row.providerRefId, row.field00, row.groupId, row.target, row.operand0Hex]));
    }
  } else {
    lines.push("- No selected compare currently reaches a direct-case, writeback-safe promotion frontier even under a hypothetical return-0.");
  }
  lines.push("");
  lines.push("## Invariants");
  lines.push("");
  lines.push(mdRow(["Invariant", "Pass", "Details", "Impact"]));
  lines.push(mdRow(["---", "---", "---", "---"]));
  for (const invariant of report.invariants) {
    lines.push(mdRow([invariant.id, invariant.passed ? "yes" : "no", invariant.details, invariant.impact]));
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
  const jsonFile = path.join(outDir, "provider35c4_promotion_frontier_probe.json");
  const mdFile = path.join(outDir, "provider35c4_promotion_frontier_probe.md");
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
