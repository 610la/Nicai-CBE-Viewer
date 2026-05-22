const fs = require("fs");
const path = require("path");
const { DEFAULT_INPUT } = require("./cbe_unpack");
const { buildReport: buildEntrypointReport } = require("./cbe_xse_entrypoint_probe");

const LAYOUT_JSON = path.resolve(__dirname, "out_godwar_xselayout", "xse_layout_trace.json");
const LABEL_POINTER_JSON = path.resolve(__dirname, "out_godwar_xselabelpointer", "xse_label_pointer_probe.json");
const ENTRY_SAFETY_JSON = path.resolve(__dirname, "out_godwar_xseentrysafety", "xse_entry_safety_probe.json");
const DEFAULT_OUT = path.resolve(__dirname, "out_godwar_xserefwidthsafety");

const REF_MODELS = [
  {
    id: "text-payload",
    description: "only text-pool payload offsets",
    transforms: ["textRelPayload"],
  },
  {
    id: "payload-strong",
    description: "all payload-position transforms",
    transforms: ["absPayload", "symbolRelPayload", "textRelPayload", "groupRelPayload"],
  },
  {
    id: "all-strong",
    description: "all absolute/pool-relative length and payload transforms",
    transforms: [
      "absLen",
      "absPayload",
      "symbolRelLen",
      "symbolRelPayload",
      "textRelLen",
      "textRelPayload",
      "groupRelLen",
      "groupRelPayload",
    ],
  },
];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function parseHex(text) {
  return typeof text === "string" && /^0x/i.test(text) ? parseInt(text, 16) : NaN;
}

function hex(n, width = 4) {
  if (!Number.isFinite(n) || n < 0) return "";
  return `0x${n.toString(16).toUpperCase().padStart(width, "0")}`;
}

function normalizeLabel(text) {
  const raw = String(text || "").trim();
  const lower = raw.toLowerCase();
  if (lower === "init") return "INIT";
  if (lower === "_main" || lower === "main") return "_MAIN";
  return raw.toUpperCase();
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean))).sort();
}

function modeKey(modes) {
  return `74=${modes?.ref74Mode || "-"},64=${modes?.ref64Mode || "-"}`;
}

function symbolKind(slot) {
  const text = normalizeLabel(slot.leadingHit?.text || slot.visible || "");
  if (slot.leadingHit?.kind) return slot.leadingHit.kind;
  if (text === "INIT" || text === "_MAIN") return "label";
  return "slot";
}

function requestedLabelSlots(layoutScript, requestedLabels) {
  const requested = new Set(requestedLabels.map(normalizeLabel));
  return (layoutScript?.lengthSlots || [])
    .map((slot) => ({
      text: normalizeLabel(slot.leadingHit?.text || slot.visible || ""),
      visible: slot.visible || "",
      kind: symbolKind(slot),
      lengthOffset: parseHex(slot.offsetHex),
      payloadOffset: parseHex(slot.payloadOffsetHex),
      lengthOffsetHex: slot.offsetHex || "",
      payloadOffsetHex: slot.payloadOffsetHex || "",
    }))
    .filter((slot) => slot.kind === "label" && requested.has(slot.text));
}

function labelValues(slot, starts) {
  return [
    ["absLen", slot.lengthOffset],
    ["absPayload", slot.payloadOffset],
    ["symbolRelLen", slot.lengthOffset - starts.symbol],
    ["symbolRelPayload", slot.payloadOffset - starts.symbol],
    ["textRelLen", slot.lengthOffset - starts.text],
    ["textRelPayload", slot.payloadOffset - starts.text],
    ["groupRelLen", slot.lengthOffset - starts.group],
    ["groupRelPayload", slot.payloadOffset - starts.group],
  ].filter(([, value]) => Number.isFinite(value) && value >= 0);
}

function matchEntry(entry, slots, starts, transformSet) {
  if (!Number.isFinite(entry.ref)) return [];
  const matches = [];
  for (const slot of slots) {
    for (const [transform, value] of labelValues(slot, starts)) {
      if (!transformSet.has(transform) || value !== entry.ref) continue;
      matches.push({
        label: slot.text,
        transform,
        lengthOffset: slot.lengthOffsetHex,
        payloadOffset: slot.payloadOffsetHex,
      });
    }
  }
  return matches;
}

function entryStatus(entry) {
  if (!entry) return "unmatched";
  if (entry.plausible === false) return "implausible";
  if (!entry.run) return "no-run";
  if (entry.run.writebackRiskCount > 0) return "writeback-risk";
  return "safe-under-trace";
}

function boundaryForCandidate(candidate, layoutScript) {
  const end = parseHex(candidate.end);
  const textStart = parseHex(layoutScript?.zones?.textAndResourcePool?.start);
  const symbolStart = parseHex(layoutScript?.zones?.labelAndSymbolPool?.start);
  let region = "unknown";
  if (Number.isFinite(end) && Number.isFinite(textStart) && end <= textStart) region = "before-text-pool";
  else if (Number.isFinite(end) && Number.isFinite(symbolStart) && end <= symbolStart) region = "text-pool-overrun";
  else if (Number.isFinite(end)) region = "symbol-pool-overrun";
  return {
    end: candidate.end || hex(end),
    region,
    boundaryClean: Number.isFinite(end) && Number.isFinite(textStart) && end <= textStart,
    bytesPastTextStart: Number.isFinite(end) && Number.isFinite(textStart) ? end - textStart : null,
  };
}

function rowSort(a, b) {
  return Number(b.boundaryClean) - Number(a.boundaryClean)
    || Number(a.status !== "safe-under-trace") - Number(b.status !== "safe-under-trace")
    || Math.abs(a.layoutDelta ?? 9999) - Math.abs(b.layoutDelta ?? 9999)
    || b.score - a.score
    || a.entryIndex - b.entryIndex;
}

function scanModel(script, layoutScript, slots, starts, refModel) {
  const transformSet = new Set(refModel.transforms);
  const matchedRows = [];
  const firstRows = [];
  for (const candidate of script.tailCandidates || []) {
    const boundary = boundaryForCandidate(candidate, layoutScript);
    const rowsForCandidate = [];
    for (const entry of candidate.entries || []) {
      const matches = matchEntry(entry, slots, starts, transformSet);
      if (!matches.length) continue;
      const status = entryStatus(entry);
      rowsForCandidate.push({
        modeKey: modeKey(candidate.modes),
        modes: candidate.modes || {},
        end: boundary.end,
        region: boundary.region,
        boundaryClean: boundary.boundaryClean,
        bytesPastTextStart: boundary.bytesPastTextStart,
        layoutDelta: candidate.layoutDelta ?? null,
        score: candidate.score ?? null,
        entryIndex: entry.index,
        offset: entry.offset || "",
        groupCursor: entry.groupCursor,
        kind: entry.kind,
        stackSpan: entry.stackSpan,
        ref: entry.ref,
        status,
        writebackRiskCount: entry.run?.writebackRiskCount ?? null,
        writebackCount: entry.run?.writebackCount ?? null,
        matches,
      });
    }
    rowsForCandidate.sort((a, b) => a.entryIndex - b.entryIndex);
    if (rowsForCandidate.length) firstRows.push(rowsForCandidate[0]);
    matchedRows.push(...rowsForCandidate);
  }

  const safeRows = matchedRows.filter((row) => row.status === "safe-under-trace");
  const safeFirstRows = firstRows.filter((row) => row.status === "safe-under-trace");
  const cleanRows = matchedRows.filter((row) => row.boundaryClean);
  let status = "ref-width-unmatched";
  if (safeFirstRows.length) status = "ref-width-first-match-safe";
  else if (safeRows.length) status = "ref-width-safe-only-after-earlier-match";
  else if (matchedRows.length) status = "ref-width-matches-unsafe";

  return {
    id: refModel.id,
    description: refModel.description,
    transforms: refModel.transforms,
    status,
    candidateWithMatchCount: firstRows.length,
    matchCount: matchedRows.length,
    firstMatchCount: firstRows.length,
    firstMatchSafeCount: safeFirstRows.length,
    safeMatchCount: safeRows.length,
    boundaryCleanMatchCount: cleanRows.length,
    boundaryCleanSafeMatchCount: cleanRows.filter((row) => row.status === "safe-under-trace").length,
    statusCounts: matchedRows.reduce((acc, row) => {
      acc[row.status] = (acc[row.status] || 0) + 1;
      return acc;
    }, {}),
    ref64ModesWithMatches: unique(matchedRows.map((row) => row.modes.ref64Mode)),
    firstRows: firstRows.slice().sort(rowSort).slice(0, 12),
    safeRows: safeRows.slice().sort(rowSort).slice(0, 12),
    matchedRows: matchedRows.slice().sort(rowSort).slice(0, 16),
  };
}

function analyzeScript(script, layoutScript, requestedLabels) {
  const starts = {
    group: parseHex(script.groupEnd),
    text: parseHex(layoutScript?.zones?.textAndResourcePool?.start),
    symbol: parseHex(layoutScript?.zones?.labelAndSymbolPool?.start),
  };
  const slots = requestedLabelSlots(layoutScript, requestedLabels);
  const models = REF_MODELS.map((refModel) => scanModel(script, layoutScript, slots, starts, refModel));
  let status = "ref-width-safety-unmatched";
  if (models.some((model) => model.firstMatchSafeCount > 0)) status = "ref-width-safety-has-first-safe";
  else if (models.some((model) => model.safeMatchCount > 0)) status = "ref-width-safety-later-safe-only";
  else if (models.some((model) => model.matchCount > 0)) status = "ref-width-safety-unsafe-only";
  return {
    name: script.name,
    executionMode: script.executionMode || "",
    status,
    candidateCount: (script.tailCandidates || []).length,
    starts: {
      groupEnd: hex(starts.group),
      textPool: hex(starts.text),
      symbolPool: hex(starts.symbol),
    },
    labels: slots.map((slot) => ({
      text: slot.text,
      lengthOffset: slot.lengthOffsetHex,
      payloadOffset: slot.payloadOffsetHex,
    })),
    models,
  };
}

function compactRows(rows) {
  return rows.map((row) => ({
    modeKey: row.modeKey,
    entry: row.entryIndex,
    offset: row.offset,
    cursor: row.groupCursor,
    ref: row.ref,
    status: row.status,
    boundaryClean: row.boundaryClean,
    region: row.region,
    layoutDelta: row.layoutDelta,
    matches: row.matches.map((match) => `${match.label}:${match.transform}`),
  }));
}

function compactScript(script) {
  return {
    ...script,
    models: script.models.map((model) => ({
      ...model,
      firstRows: compactRows(model.firstRows),
      safeRows: compactRows(model.safeRows),
      matchedRows: compactRows(model.matchedRows),
    })),
  };
}

function buildReport(options = {}) {
  const input = path.resolve(options.input || DEFAULT_INPUT);
  const entrypoint = buildEntrypointReport({ input, includeAllEntries: true, candidateLimit: 100 });
  const layout = readJson(LAYOUT_JSON);
  const labelPointer = readJson(LABEL_POINTER_JSON);
  const entrySafety = fs.existsSync(ENTRY_SAFETY_JSON) ? readJson(ENTRY_SAFETY_JSON) : null;
  const requestedLabels = unique((labelPointer.pointerProfiles || []).map((profile) => normalizeLabel(profile.requestedLabel)));
  const layoutByName = new Map((layout.scripts || []).map((script) => [script.name, script]));
  const scripts = (entrypoint.scripts || []).map((script) => analyzeScript(script, layoutByName.get(script.name), requestedLabels));
  const allModels = scripts.flatMap((script) => script.models.map((model) => ({ script: script.name, ...model })));
  const firstSafe = allModels.reduce((sum, model) => sum + model.firstMatchSafeCount, 0);
  const safeMatches = allModels.reduce((sum, model) => sum + model.safeMatchCount, 0);
  const unsafeMatches = allModels.reduce((sum, model) => sum + model.matchCount - model.safeMatchCount, 0);
  const matchedScripts = scripts.filter((script) => script.models.some((model) => model.matchCount > 0));
  const firstSafeScripts = scripts.filter((script) => script.models.some((model) => model.firstMatchSafeCount > 0));
  const laterSafeScripts = scripts.filter((script) => !script.models.some((model) => model.firstMatchSafeCount > 0) && script.models.some((model) => model.safeMatchCount > 0));
  const status = firstSafe
    ? "ref-width-safety-first-safe-found"
    : safeMatches
    ? "ref-width-safety-later-safe-only"
    : unsafeMatches
    ? "ref-width-safety-unsafe-only"
    : "ref-width-safety-unmatched";

  return {
    schema: "nicai.cbe.xseRefWidthSafetyProbe.v1",
    generatedAt: new Date().toISOString(),
    input,
    inputs: {
      entrypoint: "cbe_xse_entrypoint_probe.buildReport({ includeAllEntries: true, candidateLimit: 100 })",
      layout: LAYOUT_JSON,
      labelPointer: LABEL_POINTER_JSON,
      entrySafety: ENTRY_SAFETY_JSON,
    },
    requestedLabels,
    summary: {
      status,
      scriptCount: scripts.length,
      candidatesPerScript: 100,
      totalCandidateScans: scripts.reduce((sum, script) => sum + script.candidateCount, 0),
      matchedScriptCount: matchedScripts.length,
      firstSafeMatchCount: firstSafe,
      safeMatchCount: safeMatches,
      unsafeMatchCount: unsafeMatches,
      firstSafeScripts: firstSafeScripts.map((script) => script.name),
      laterSafeScripts: laterSafeScripts.map((script) => script.name),
      matchedScripts: matchedScripts.map((script) => script.name),
      currentFinding: `Exhaustive +0x74/+0x64 width scan covers 100 mode pairs per focused script. It finds ${firstSafe} first requested-label match(es) safe for scheduling and ${safeMatches} safe requested-label match(es) total; ${unsafeMatches} requested-label match(es) remain unsafe or implausible under the current trace/writeback contract.`,
      emulatorImpact: "The generic emulator should not try to rescue the current label-entry path by merely picking a different supported ref width or a later same-mode match. The active width grid still lacks a promotable first requested-label selection.",
      nextTarget: firstSafe
        ? "Promote the first-safe width candidates through the full activation gate and compare them against runtime provider calls."
        : "Move below the width grid: recover the provider-backed +0x50 compare/reader ABI and the true +0x64 range-table count/ref encoding instead of choosing among current guessed widths.",
      entrySafetyFinding: entrySafety?.summary?.currentFinding || "",
    },
    scripts: scripts.map(compactScript),
  };
}

function mdRow(cells) {
  return `| ${cells.map((cell) => String(cell ?? "").replace(/\|/g, "\\|")).join(" | ")} |`;
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# XSE Ref Width Safety Probe");
  lines.push("");
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Status: ${report.summary.status}`);
  lines.push(`- Finding: ${report.summary.currentFinding}`);
  lines.push(`- Emulator impact: ${report.summary.emulatorImpact}`);
  lines.push(`- Next target: ${report.summary.nextTarget}`);
  if (report.summary.entrySafetyFinding) lines.push(`- Entry safety context: ${report.summary.entrySafetyFinding}`);
  lines.push("");
  lines.push("## Exhaustive Width Grid");
  lines.push("");
  lines.push(mdRow(["Script", "Model", "Candidates", "Matches", "First safe", "Safe total", "Clean safe", "Ref64 modes", "Status"]));
  lines.push(mdRow(["---", "---", "---:", "---:", "---:", "---:", "---:", "---", "---"]));
  for (const script of report.scripts) {
    for (const model of script.models) {
      lines.push(mdRow([
        script.name,
        model.id,
        script.candidateCount,
        model.matchCount,
        model.firstMatchSafeCount,
        model.safeMatchCount,
        model.boundaryCleanSafeMatchCount,
        model.ref64ModesWithMatches.join(", ") || "-",
        model.status,
      ]));
    }
  }
  lines.push("");
  lines.push("## First Requested-Label Matches");
  for (const script of report.scripts) {
    lines.push("");
    lines.push(`### ${script.name}`);
    for (const model of script.models) {
      const rows = model.firstRows.slice(0, 6);
      if (!rows.length) {
        lines.push(`- ${model.id}: none`);
        continue;
      }
      lines.push(`- ${model.id}: ${rows.map((row) => `${row.modeKey} entry${row.entry} cursor=${row.cursor} ref=${row.ref} ${row.status} ${row.matches.join(",")}`).join("; ")}`);
    }
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
  const jsonFile = path.join(outDir, "xse_ref_width_safety_probe.json");
  const mdFile = path.join(outDir, "xse_ref_width_safety_probe.md");
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
