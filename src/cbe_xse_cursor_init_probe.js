const fs = require("fs");
const path = require("path");

const SWITCH_REPLAY_JSON = path.resolve(__dirname, "out_godwar_xseswitchreplay", "xse_switch_replay_probe.json");
const RUNTIME_DISPATCH_JSON = path.resolve(__dirname, "out_godwar_xsedispatch", "xse_runtime_dispatch_probe.json");
const DEFAULT_OUT = path.resolve(__dirname, "out_godwar_xsecursorinit");

const RESET_CONTRACT = {
  entry: "0x011266",
  name: "script-state reset/start helper",
  cursorSeedRule: "if script+0x64 is non-null and script+0x08 is nonzero, script+0x50 is seeded from script+0x64[script+0x0C].field+0x00",
  opcodeCursorSeedRule: "script+0x5C and script+0x60 are cleared, then 0x11252 adds script+0x04 and tail64[script+0x0C].field+0x08+1 into both fields",
  resetFields: [
    { field: "+0x5C", value: 0, meaning: "opcode record cursor reset before 0x11252 seed deltas" },
    { field: "+0x60", value: 0, meaning: "negative-index base reset before 0x11252 seed deltas" },
    { field: "+0x54[*].type", value: -1, meaning: "runtime record stack slots initialized as empty" },
  ],
  emulatorImpact: "A nonzero starting group cursor must come from the tail64 seed condition or slot reuse; otherwise fresh scripts begin at group cursor 0.",
};

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function modeForScript(runtimeDispatch, name, fallback) {
  const row = (runtimeDispatch.scripts || []).find((script) => script.name === name);
  return row?.executionBest?.mode || row?.dispatchBest?.mode || fallback || "";
}

function attemptSeedSummary(script, attempt, executionMode) {
  const header = attempt?.header || {};
  const field08 = header.field08Byte;
  const field0C = header.field0C;
  const slotCapacity = header.slotCapacity;
  const hasTail64 = Boolean(attempt?.bestTail?.steps?.some((step) => (
    String(step.label || "").includes("object+68 ranges") && Number(step.count) >= 0
  )));
  const seedable = Boolean(hasTail64 && field08);
  return {
    name: script.name,
    mode: attempt?.shortMode || "",
    executionMode: attempt?.shortMode === executionMode,
    field08Byte: field08,
    field0C,
    slotCapacity,
    hasTail64,
    seedable,
    cursorSeedStatus: seedable
      ? "seeded-from-tail64"
      : field08 === 0
      ? "not-seeded-field08-zero"
      : hasTail64
      ? "seed-condition-needs-runtime-tail-record"
      : "not-seeded-no-tail64",
    inferredInitialCursor: seedable ? null : 0,
    note: seedable
      ? "0x11266 can set +0x50 from +0x64[field+0x0C]; the concrete value needs tail64 binding."
      : field08 === 0
      ? "0x11266 skips the +0x50 tail64 seed because header field+0x08 is zero."
      : "0x11266 does not have enough tail64 state to seed +0x50 in this attempt.",
  };
}

function buildReport() {
  const switchReplay = readJson(SWITCH_REPLAY_JSON);
  const runtimeDispatch = readJson(RUNTIME_DISPATCH_JSON);
  const scripts = (switchReplay.scripts || []).map((script) => {
    const fallback = script.best?.shortMode || "";
    const executionMode = modeForScript(runtimeDispatch, script.name, fallback);
    const attempts = (script.attempts || [])
      .filter((attempt) => attempt.ok)
      .map((attempt) => attemptSeedSummary(script, attempt, executionMode));
    const executionAttempt = attempts.find((attempt) => attempt.mode === executionMode) || null;
    return {
      name: script.name,
      executionMode,
      executionAttempt,
      attempts,
    };
  });
  const executionRows = scripts.map((script) => script.executionAttempt).filter(Boolean);
  const notSeeded = executionRows.filter((row) => row.cursorSeedStatus === "not-seeded-field08-zero");
  const seedable = executionRows.filter((row) => row.seedable);
  return {
    schema: "nicai.cbe.xseCursorInitProbe.v1",
    generatedAt: new Date().toISOString(),
    inputs: {
      switchReplay: SWITCH_REPLAY_JSON,
      runtimeDispatch: RUNTIME_DISPATCH_JSON,
    },
    resetContract: RESET_CONTRACT,
    summary: {
      status: seedable.length ? "cursor-init-needs-tail64-binding" : "cursor-init-anchored",
      scriptCount: scripts.length,
      executionNotSeededCount: notSeeded.length,
      executionSeedableCount: seedable.length,
      currentFinding: seedable.length
        ? `${seedable.length}/${executionRows.length} execution-best scripts can seed +0x50 through 0x11266; bind tail64 before assuming cursor 0.`
        : `0x11266 clears +0x5C/+0x60 before opcode-stack seed deltas and only seeds +0x50 when header field+0x08 is nonzero; all ${notSeeded.length}/${executionRows.length} execution-best focused scripts have field+0x08=0, so the current writeback blocker is not explained by a nonzero reset group cursor.`,
      emulatorImpact: "The trace-only VM can keep group cursor 0 as the reset-state hypothesis for these focused opening scripts, while still binding +0x5C/+0x60 opcode-stack state and slot reuse for a generic emulator.",
      nextTarget: "Trace script slot reuse and the live +0x50 reader contract; if cursor 0 is confirmed at runtime, unresolved writebacks point back to reader-mode binding or copy-helper null behavior.",
    },
    scripts,
  };
}

function mdRow(cells) {
  return `| ${cells.map((cell) => String(cell ?? "").replace(/\|/g, "\\|")).join(" | ")} |`;
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# XSE Cursor Init Probe");
  lines.push("");
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Switch replay: \`${report.inputs.switchReplay}\``);
  lines.push(`- Runtime dispatch: \`${report.inputs.runtimeDispatch}\``);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Status: ${report.summary.status}`);
  lines.push(`- Finding: ${report.summary.currentFinding}`);
  lines.push(`- Emulator impact: ${report.summary.emulatorImpact}`);
  lines.push(`- Next target: ${report.summary.nextTarget}`);
  lines.push("");
  lines.push("## Reset Contract");
  lines.push("");
  lines.push(`- ${report.resetContract.entry}: ${report.resetContract.cursorSeedRule}.`);
  lines.push(`- Opcode stack seed: ${report.resetContract.opcodeCursorSeedRule}.`);
  for (const item of report.resetContract.resetFields) {
    lines.push(`- ${item.field} <= ${item.value}: ${item.meaning}.`);
  }
  lines.push("");
  lines.push(mdRow(["Script", "Execution mode", "field+08", "field+0C", "Tail64", "Cursor seed", "Initial cursor"]));
  lines.push(mdRow(["---", "---", "---:", "---:", "---", "---", "---:"]));
  for (const script of report.scripts) {
    const row = script.executionAttempt || {};
    lines.push(mdRow([
      script.name,
      script.executionMode,
      row.field08Byte ?? "?",
      row.field0C ?? "?",
      row.hasTail64 ? "yes" : "no",
      row.cursorSeedStatus || "?",
      row.inferredInitialCursor ?? "?",
    ]));
  }
  lines.push("");
  lines.push("## Per-Mode Attempts");
  for (const script of report.scripts) {
    lines.push("");
    lines.push(`### ${script.name}`);
    for (const attempt of script.attempts) {
      lines.push(`- ${attempt.mode}${attempt.executionMode ? " (execution)" : ""}: field+08=${attempt.field08Byte}, field+0C=${attempt.field0C}, tail64=${attempt.hasTail64 ? "yes" : "no"}, seed=${attempt.cursorSeedStatus}; ${attempt.note}`);
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
  const jsonFile = path.join(outDir, "xse_cursor_init_probe.json");
  const mdFile = path.join(outDir, "xse_cursor_init_probe.md");
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
