const fs = require("fs");
const path = require("path");
const { DEFAULT_INPUT } = require("./cbe_unpack");

const SWITCH_REPLAY_JSON = path.resolve(__dirname, "out_godwar_xseswitchreplay", "xse_switch_replay_probe.json");
const DEFAULT_OUT = path.resolve(__dirname, "out_godwar_xsedispatch");
const PRIMARY_TABLE_OFFSET = 0x11D0C;
const PRIMARY_TABLE_COUNT = 0x21;
const PRIMARY_ADD_PC_BASE = 0x11D08;
const PRIMARY_DEFAULT_TARGET = 0x11FE0;
const REGISTER_SHAPE_SUSPECT_TARGETS = new Set(["0x015F08"]);

function hex(n, width = 4) {
  if (!Number.isFinite(n) || n < 0) return "";
  return `0x${n.toString(16).toUpperCase().padStart(width, "0")}`;
}

function readPrimarySwitchTable(input = DEFAULT_INPUT) {
  const buf = fs.readFileSync(input);
  const cases = [];
  for (let id = 0; id < PRIMARY_TABLE_COUNT; id += 1) {
    const offset = PRIMARY_TABLE_OFFSET + (id * 2);
    const half = buf.readUInt16LE(offset);
    cases.push({
      id,
      tableOffset: hex(offset, 6),
      halfword: hex(half, 4),
      target: hex(PRIMARY_ADD_PC_BASE + (half * 2), 6),
    });
  }
  return {
    site: "0x11CF8..0x11D06",
    condition: "if groupId >= 0x21 branch to default 0x11FE0; otherwise jump table",
    tableOffset: hex(PRIMARY_TABLE_OFFSET, 6),
    addPcBase: hex(PRIMARY_ADD_PC_BASE, 6),
    defaultTarget: hex(PRIMARY_DEFAULT_TARGET, 6),
    cases,
  };
}

function summarizeTargetCounts(groups, table) {
  const byTarget = new Map();
  for (const group of groups || []) {
    const id = group.id?.value;
    const direct = Number.isInteger(id) && id >= 0 && id < PRIMARY_TABLE_COUNT;
    const target = direct ? table.cases[id].target : table.defaultTarget;
    const key = `${target}:${direct ? "direct" : "default"}`;
    const item = byTarget.get(key) || {
      target,
      dispatch: direct ? "direct" : "default",
      count: 0,
      groupIds: [],
    };
    item.count += 1;
    item.groupIds.push(id);
    byTarget.set(key, item);
  }
  return Array.from(byTarget.values()).sort((a, b) => b.count - a.count || a.target.localeCompare(b.target));
}

function scoreDispatchAttempt(attempt, table) {
  if (!attempt?.ok) return -999999;
  const groups = attempt.groups || [];
  const directCount = groups.filter((group) => {
    const id = group.id?.value;
    return Number.isInteger(id) && id >= 0 && id < PRIMARY_TABLE_COUNT;
  }).length;
  const absDelta = Math.abs(attempt.layoutDelta ?? attempt.groupDelta ?? 999999);
  const tailOk = attempt.bestTail?.ok ? 1 : 0;
  return (directCount * 1000) + (tailOk * 100) - Math.min(absDelta, 9999);
}

function registerShapeSuspectGroups(groups, table) {
  return (groups || [])
    .map((group) => group.id?.value)
    .filter((id) => Number.isInteger(id) && id >= 0 && id < PRIMARY_TABLE_COUNT)
    .filter((id) => REGISTER_SHAPE_SUSPECT_TARGETS.has(table.cases[id].target));
}

function scoreExecutionAttempt(attempt, table) {
  if (!attempt?.ok) return -999999;
  const groups = attempt.groups || [];
  const directCount = groups.filter((group) => {
    const id = group.id?.value;
    return Number.isInteger(id) && id >= 0 && id < PRIMARY_TABLE_COUNT;
  }).length;
  const absDelta = Math.abs(attempt.layoutDelta ?? attempt.groupDelta ?? 999999);
  const tailOk = attempt.bestTail?.ok ? 1 : 0;
  const shapeSuspects = registerShapeSuspectGroups(groups, table).length;
  return (directCount * 1000) + (tailOk * 100) - Math.min(absDelta, 9999) - (shapeSuspects * 4000);
}

function summarizeAttempt(attempt, table) {
  const groups = attempt.groups || [];
  const shapeSuspects = registerShapeSuspectGroups(groups, table);
  const directGroups = groups.filter((group) => {
    const id = group.id?.value;
    return Number.isInteger(id) && id >= 0 && id < PRIMARY_TABLE_COUNT;
  }).length;
  const defaultGroups = groups.length - directGroups;
  return {
    mode: attempt.shortMode || "",
    ok: Boolean(attempt.ok),
    groups: groups.length,
    records: attempt.totalRecords ?? null,
    groupIds: groups.map((group) => group.id?.value),
    directGroups,
    defaultGroups,
    groupEnd: attempt.groupEndHex || "",
    tailEnd: attempt.bestTail?.endHex || "",
    layoutDelta: attempt.layoutDelta ?? null,
    tailOk: Boolean(attempt.bestTail?.ok),
    tailModes: attempt.bestTail?.modes || {},
    registerShapeSuspectGroups: shapeSuspects,
    targetCounts: summarizeTargetCounts(groups, table),
    dispatchScore: scoreDispatchAttempt(attempt, table),
    executionScore: scoreExecutionAttempt(attempt, table),
  };
}

function buildReport(options = {}) {
  const input = path.resolve(options.input || DEFAULT_INPUT);
  const switchReplayFile = path.resolve(options.switchReplay || SWITCH_REPLAY_JSON);
  const switchReplay = JSON.parse(fs.readFileSync(switchReplayFile, "utf8"));
  const table = readPrimarySwitchTable(input);
  const scripts = (switchReplay.scripts || []).map((script) => {
    const attempts = (script.attempts || []).filter((attempt) => attempt.ok).map((attempt) => summarizeAttempt(attempt, table));
    const tailBest = summarizeAttempt(script.best, table);
    const dispatchBest = attempts.slice().sort((a, b) => b.dispatchScore - a.dispatchScore)[0] || tailBest;
    const executionBest = attempts.slice().sort((a, b) => b.executionScore - a.executionScore)[0] || tailBest;
    return {
      name: script.name,
      layoutEnd: script.layoutHint?.objectEnd || "",
      tailBest,
      dispatchBest,
      executionBest,
      tension: tailBest.mode !== dispatchBest.mode,
      executionCorrection: dispatchBest.mode !== executionBest.mode,
      attempts,
    };
  });
  const tensions = scripts.filter((script) => script.tension).map((script) => script.name);
  const executionCorrections = scripts.filter((script) => script.executionCorrection).map((script) => script.name);
  return {
    schema: "nicai.cbe.xseRuntimeDispatchProbe.v1",
    generatedAt: new Date().toISOString(),
    input,
    switchReplayFile,
    primaryGroupDispatch: table,
    summary: {
      status: tensions.length ? "dispatch-reader-tension" : "dispatch-reader-consistent",
      tensionScripts: tensions,
      executionCorrections,
      currentFinding: tensions.length
        ? `Tail-aligned +0x4C mode and dispatch-plausible +0x4C mode disagree in ${tensions.join(", ")}; execution scoring avoids register-shape suspect modes in ${executionCorrections.join(", ") || "none"}.`
        : "Tail-aligned +0x4C modes also keep group ids on direct runtime dispatch cases.",
      emulatorImpact: "The corrected 0x112C4 table replay must be validated against the runtime group dispatcher at 0x11CF8; object-boundary alignment alone is not enough to choose +0x4C semantics.",
      nextTarget: "Trace the 0x11C3C group dispatcher cases and +0x74/+0x64 tail readers together, using execution scoring to reject register-shape-impossible direct hits before enabling script effects.",
    },
    scripts,
  };
}

function mdRow(cells) {
  return `| ${cells.map((cell) => String(cell ?? "").replace(/\|/g, "\\|")).join(" | ")} |`;
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# XSE Runtime Dispatch Probe");
  lines.push("");
  lines.push(`- Input CBE: \`${report.input}\``);
  lines.push(`- Switch replay: \`${report.switchReplayFile}\``);
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push("");
  lines.push("## Dispatcher Anchor");
  lines.push("");
  lines.push(`- Site: ${report.primaryGroupDispatch.site}`);
  lines.push(`- Rule: ${report.primaryGroupDispatch.condition}`);
  lines.push(`- Table: ${report.primaryGroupDispatch.tableOffset}; default=${report.primaryGroupDispatch.defaultTarget}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Status: ${report.summary.status}`);
  lines.push(`- Finding: ${report.summary.currentFinding}`);
  lines.push(`- Emulator impact: ${report.summary.emulatorImpact}`);
  lines.push(`- Next target: ${report.summary.nextTarget}`);
  lines.push("");
  lines.push(mdRow(["Script", "Tail-best mode", "Tail direct/default", "Tail delta", "Dispatch-best mode", "Dispatch direct/default", "Execution mode", "Shape suspects", "Tension"]));
  lines.push(mdRow(["---", "---", "---", "---:", "---", "---", "---", "---:", "---"]));
  for (const script of report.scripts) {
    lines.push(mdRow([
      script.name,
      script.tailBest.mode,
      `${script.tailBest.directGroups}/${script.tailBest.defaultGroups}`,
      script.tailBest.layoutDelta ?? "",
      script.dispatchBest.mode,
      `${script.dispatchBest.directGroups}/${script.dispatchBest.defaultGroups}`,
      script.executionBest.mode,
      script.executionBest.registerShapeSuspectGroups.length,
      script.tension ? "yes" : "no",
    ]));
  }
  lines.push("");
  lines.push("## Per-Script Attempts");
  for (const script of report.scripts) {
    lines.push("");
    lines.push(`### ${script.name}`);
    for (const attempt of script.attempts || []) {
      const targets = attempt.targetCounts.map((item) => `${item.target}/${item.dispatch}:${item.count}[${item.groupIds.join(",")}]`).join("; ");
      const tailModes = attempt.tailModes?.ref74Mode ? `74=${attempt.tailModes.ref74Mode},64=${attempt.tailModes.ref64Mode}` : "-";
      lines.push(`- ${attempt.mode}: groups=${attempt.groups}, records=${attempt.records}, ids=${attempt.groupIds.join(",")}, direct=${attempt.directGroups}, default=${attempt.defaultGroups}, shapeSuspects=${attempt.registerShapeSuspectGroups.join(",") || "-"}, dispatchScore=${attempt.dispatchScore}, executionScore=${attempt.executionScore}, tail=${attempt.tailEnd} delta=${attempt.layoutDelta}, tailOk=${attempt.tailOk}, tailModes=${tailModes}, targets=${targets}`);
    }
  }
  lines.push("");
  lines.push("## Direct Case Table");
  lines.push("");
  lines.push(mdRow(["Group id", "Target"]));
  lines.push(mdRow(["---:", "---"]));
  for (const item of report.primaryGroupDispatch.cases) {
    lines.push(mdRow([item.id, item.target]));
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
  const jsonFile = path.join(outDir, "xse_runtime_dispatch_probe.json");
  const mdFile = path.join(outDir, "xse_runtime_dispatch_probe.md");
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
