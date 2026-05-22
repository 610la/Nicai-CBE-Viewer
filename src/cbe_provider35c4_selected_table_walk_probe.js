const fs = require("fs");
const path = require("path");
const { DEFAULT_INPUT, loadCbeArchive } = require("./cbe_unpack");
const { ParsedProvider35C4StreamExecutor } = require("./cbe_provider35c4_stream_executor_probe");
const { walkLane } = require("./cbe_provider35c4_table_walk_probe");
const { buildReport: buildCountModeReport } = require("./cbe_provider35c4_count_mode_probe");
const { buildReport: buildS02SourceModeReport } = require("./cbe_provider35c4_s02_source_mode_probe");

const DEFAULT_OUT = path.resolve(__dirname, "out_godwar_provider35c4selectedtable");

function mdRow(values) {
  return `| ${values.map((value) => String(value ?? "").replace(/\|/g, "\\|")).join(" | ")} |`;
}

function modesFromModeKey(modeKey) {
  const out = {};
  for (const part of String(modeKey || "").split(",")) {
    const [key, value] = part.split("=").map((item) => item.trim());
    if (key === "74") out.ref74Mode = value;
    if (key === "64") out.ref64Mode = value;
  }
  return out;
}

function scriptForSelectedMode(script) {
  if (!script.selected) return null;
  const modes = modesFromModeKey(script.selected.modeKey);
  return {
    name: script.name,
    candidates: [{
      role: "count-mode-selected-pool-clean",
      modeKey: script.selected.modeKey,
      modes,
      start: script.selected.start,
      end: script.selected.end,
      entryCount: script.selected.entryCount,
      finalRefCount: script.selected.finalRefCount,
      score: script.selected.score,
      layoutDelta: script.selected.layoutDelta,
    }],
  };
}

function scriptForS02SourceMode(report) {
  const selected = report?.selected;
  if (!selected) return null;
  const modes = modesFromModeKey(selected.modeKey);
  return {
    name: report.script || "s_02.xse",
    source: "s02-tail-aligned-tail-end",
    candidates: [{
      role: "s02-tail-aligned-tail-end-table",
      modeKey: selected.modeKey,
      modes,
      start: selected.start,
      end: selected.end,
      entryCount: selected.entryCount,
      finalRefCount: selected.finalRefCount,
      score: 0,
      layoutDelta: selected.layoutDelta,
    }],
  };
}

function buildInvariant(id, passed, details, impact = "") {
  return { id, passed: Boolean(passed), details, impact };
}

function buildReport(options = {}) {
  const input = path.resolve(options.input || DEFAULT_INPUT);
  const archive = loadCbeArchive(input);
  const countMode = buildCountModeReport({ input });
  const s02SourceMode = buildS02SourceModeReport({ input });
  const s02SelectedScript = scriptForS02SourceMode(s02SourceMode);
  const executor = new ParsedProvider35C4StreamExecutor({
    observationSink: options.observationSink,
    observedMatches: options.observedMatches || [],
  });
  const lanes = [];
  const blocked = [];
  let laneIndex = 0;
  for (const script of countMode.scripts || []) {
    const selectedScript = script.name === "s_02.xse" && s02SelectedScript
      ? s02SelectedScript
      : scriptForSelectedMode(script);
    if (!selectedScript) {
      blocked.push({
        script: script.name,
        status: script.status,
        blockers: script.blockers || ["no-selected-count-mode"],
        currentTop: script.currentTop || null,
      });
      continue;
    }
    for (const policy of ["xse-body-prefix", "xse-magic-pointer"]) {
      laneIndex += 1;
      lanes.push(walkLane({ archive, executor, script: selectedScript, policy, laneIndex }));
    }
  }

  const producerOps = executor.service.operations.filter((op) => op.dispatchShape === "provider-ref-producer");
  const cursorReadOps = executor.service.operations.filter((op) => op.dispatchShape === "stream-cursor-read");
  const compareOps = executor.service.operations.filter((op) => op.dispatchShape === "label-ref-compare");
  const return0CompareOps = compareOps.filter((op) => op.resultValue === 0);
  const missingRefs = compareOps.filter((op) => !op.refKnown);
  const lateRefs = compareOps.filter((op) => op.refKnown && !(op.refProducerSeq < op.sourceSeq));
  const guardedLanes = lanes.filter((lane) => lane.guardReasons.length > 0 || lane.status !== "table-lane-expanded");
  const expandedLanes = lanes.filter((lane) => lane.counts.rangeEntriesWalked > 0);
  const sourceModeSelectedScriptCount = s02SelectedScript ? 1 : 0;
  const countModeSelectedScriptCount = countMode.summary?.selectedScriptCount || 0;
  const expectedSelectedScriptCount = countModeSelectedScriptCount + sourceModeSelectedScriptCount;
  const invariants = [
    buildInvariant(
      "selected-lanes-cover-count-and-source-mode-scripts",
      lanes.length === expectedSelectedScriptCount * 2,
      `${lanes.length} selected lane(s), ${countModeSelectedScriptCount} count-mode script(s), ${sourceModeSelectedScriptCount} source-mode script(s)`,
      "The selected table walker should rerun pool-clean count modes plus source-mode handoff candidates, across both current conversion policies."
    ),
    buildInvariant(
      "selected-table-reduces-guards",
      guardedLanes.length === 0,
      `${guardedLanes.length}/${lanes.length} selected lane(s) guarded`,
      "Pool-clean count modes should remove negative-count guards for selected scripts."
    ),
    buildInvariant(
      "s02-source-mode-removes-text-pool-block",
      sourceModeSelectedScriptCount === 1 && !blocked.some((row) => row.script === "s_02.xse"),
      `sourceModeSelected=${sourceModeSelectedScriptCount}, blocked=${blocked.map((row) => row.script).join(", ") || "none"}`,
      "s_02 should move from compact text-pool start to the tail-aligned source-mode table lane without enabling effects."
    ),
    buildInvariant(
      "selected-compares-consume-known-prior-refs",
      missingRefs.length === 0 && lateRefs.length === 0,
      `${compareOps.length} compare op(s), ${missingRefs.length} missing ref(s), ${lateRefs.length} late ref(s)`,
      "Selected table compares must still consume prior +0x64 range refs."
    ),
    buildInvariant(
      "selected-table-keeps-nonmatch-with-empty-feed",
      return0CompareOps.length === 0,
      `${return0CompareOps.length} return-0 compare(s)`,
      "Even improved count modes cannot enable visible effects without real provider return-0 observations."
    ),
  ];
  const failures = invariants.filter((item) => !item.passed);
  return {
    schema: "nicai.cbe.provider35c4SelectedTableWalkProbe.v1",
    generatedAt: new Date().toISOString(),
    input,
    inputs: {
      countMode: "cbe_provider35c4_count_mode_probe.buildReport({ input })",
      s02SourceMode: "cbe_provider35c4_s02_source_mode_probe.buildReport({ input })",
      tableWalker: "cbe_provider35c4_table_walk_probe.walkLane",
    },
    selectedContract: {
      sourceMode: "count-and-source-mode-selected-table-walk",
      selectedScripts: [
        ...(countMode.scripts || []).filter((script) => script.selected).map((script) => `${script.name}:${script.selected.modeKey}`),
        ...(s02SelectedScript ? [`${s02SelectedScript.name}:${s02SelectedScript.candidates[0].modeKey}:tailEnd`] : []),
      ],
      blockedScripts: blocked.map((row) => `${row.script}:${row.blockers.join("+")}`),
      conversionPolicies: ["xse-body-prefix", "xse-magic-pointer"],
      visibleEffectsEnabled: false,
    },
    s02SourceMode: {
      status: s02SourceMode.summary?.status || "",
      selected: s02SourceMode.selected || null,
      counts: s02SourceMode.counts || {},
      nextTarget: s02SourceMode.summary?.nextTarget || "",
    },
    counts: {
      countModeSelectedScriptCount,
      sourceModeSelectedScriptCount,
      selectedScriptCount: expectedSelectedScriptCount,
      blockedScriptCount: blocked.length,
      laneCount: lanes.length,
      expandedLaneCount: expandedLanes.length,
      guardedLaneCount: guardedLanes.length,
      serviceOperationCount: executor.service.operations.length,
      producerOperationCount: producerOps.length,
      cursorReadOperationCount: cursorReadOps.length,
      compareOperationCount: compareOps.length,
      knownRefCount: executor.service.refs.size,
      return0CompareCount: return0CompareOps.length,
      missingCompareRefCount: missingRefs.length,
      lateCompareRefCount: lateRefs.length,
    },
    lanes,
    blocked,
    operations: executor.service.operations.slice(0, 192),
    invariants,
    summary: {
      status: failures.length ? "provider35c4-selected-table-walk-risk" : "provider35c4-selected-table-walk-ready",
      currentFinding: "Pool-clean count modes cover s_01/s_03/s_04, and the s_02 tail-aligned source-mode handoff now expands without treating text bytes as table data.",
      emulatorImpact: "This is a safer lane selector for the generic table loader: it reduces negative-count guards, repairs the s_02 table-start source-mode blocker, and still keeps visible effects disabled.",
      nextTarget: "Bind all selected table lanes to real provider +0x50 return-0 observations before entry promotion.",
      visibleEffectsEnabled: false,
      failureCount: failures.length,
      selectedScriptCount: expectedSelectedScriptCount,
      sourceModeSelectedScriptCount,
      blockedScriptCount: blocked.length,
      laneCount: lanes.length,
      expandedLaneCount: expandedLanes.length,
      guardedLaneCount: guardedLanes.length,
      producerOperationCount: producerOps.length,
      cursorReadOperationCount: cursorReadOps.length,
      compareOperationCount: compareOps.length,
      knownRefCount: executor.service.refs.size,
      return0CompareCount: return0CompareOps.length,
    },
  };
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# Provider 0x35C4 Selected Table Walk Probe");
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
  for (const [key, value] of Object.entries(report.counts)) lines.push(mdRow([key, value]));
  lines.push("");
  lines.push("## Lanes");
  lines.push("");
  lines.push(mdRow(["Lane", "Script", "Policy", "Mode", "Status", "Entries", "Refs", "Compares", "Guards"]));
  lines.push(mdRow(["---:", "---", "---", "---", "---", "---:", "---:", "---:", "---"]));
  for (const lane of report.lanes) {
    lines.push(mdRow([
      lane.laneIndex,
      lane.script,
      lane.policy,
      lane.modeKey,
      lane.status,
      lane.counts.rangeEntriesWalked,
      lane.counts.rangeRefsProduced,
      lane.counts.labelCompares,
      lane.guardReasons.join("; "),
    ]));
  }
  lines.push("");
  lines.push("## Blocked");
  lines.push("");
  lines.push(mdRow(["Script", "Status", "Blockers"]));
  lines.push(mdRow(["---", "---", "---"]));
  for (const row of report.blocked) lines.push(mdRow([row.script, row.status, row.blockers.join("; ")]));
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
  const jsonFile = path.join(outDir, "provider35c4_selected_table_walk_probe.json");
  const mdFile = path.join(outDir, "provider35c4_selected_table_walk_probe.md");
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
