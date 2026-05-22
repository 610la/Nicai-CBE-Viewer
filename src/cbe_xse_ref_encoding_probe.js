const fs = require("fs");
const path = require("path");
const { DEFAULT_INPUT } = require("./cbe_unpack");
const { buildReport: buildEntrypointReport } = require("./cbe_xse_entrypoint_probe");

const LAYOUT_JSON = path.resolve(__dirname, "out_godwar_xselayout", "xse_layout_trace.json");
const LABEL_POINTER_JSON = path.resolve(__dirname, "out_godwar_xselabelpointer", "xse_label_pointer_probe.json");
const COMPARE_SHIM_JSON = path.resolve(__dirname, "out_godwar_xsecompareshim", "xse_compare_shim_probe.json");
const DEFAULT_OUT = path.resolve(__dirname, "out_godwar_xserefencoding");

const STRONG_TRANSFORMS = new Set([
  "absLen",
  "absPayload",
  "symbolRelLen",
  "symbolRelPayload",
  "textRelLen",
  "textRelPayload",
  "groupRelLen",
  "groupRelPayload",
]);

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

function symbolKind(slot) {
  const text = normalizeLabel(slot.leadingHit?.text || slot.visible || "");
  if (slot.leadingHit?.kind) return slot.leadingHit.kind;
  if (text === "INIT" || text === "_MAIN") return "label";
  return "slot";
}

function buildSymbolSlots(layoutScript) {
  return (layoutScript?.lengthSlots || []).map((slot) => ({
    text: normalizeLabel(slot.leadingHit?.text || slot.visible || ""),
    visible: slot.visible || "",
    kind: symbolKind(slot),
    lengthOffset: parseHex(slot.offsetHex),
    payloadOffset: parseHex(slot.payloadOffsetHex),
    lengthOffsetHex: slot.offsetHex || "",
    payloadOffsetHex: slot.payloadOffsetHex || "",
  }));
}

function valuesForSymbol(symbol, starts) {
  return [
    ["absLen", symbol.lengthOffset],
    ["absPayload", symbol.payloadOffset],
    ["symbolRelLen", symbol.lengthOffset - starts.symbol],
    ["symbolRelPayload", symbol.payloadOffset - starts.symbol],
    ["textRelLen", symbol.lengthOffset - starts.text],
    ["textRelPayload", symbol.payloadOffset - starts.text],
    ["groupRelLen", symbol.lengthOffset - starts.group],
    ["groupRelPayload", symbol.payloadOffset - starts.group],
    ["low8Len", symbol.lengthOffset & 0xff],
    ["low8Payload", symbol.payloadOffset & 0xff],
    ["low16Len", symbol.lengthOffset & 0xffff],
    ["low16Payload", symbol.payloadOffset & 0xffff],
  ].filter(([, value]) => Number.isFinite(value) && value >= 0);
}

function matchRef(ref, symbols, starts) {
  if (!Number.isFinite(ref)) return [];
  const matches = [];
  for (const symbol of symbols) {
    for (const [transform, value] of valuesForSymbol(symbol, starts)) {
      if (value !== ref) continue;
      matches.push({
        transform,
        strength: STRONG_TRANSFORMS.has(transform) ? "strong" : "weak",
        kind: symbol.kind,
        text: symbol.text,
        visible: symbol.visible,
        lengthOffset: symbol.lengthOffsetHex,
        payloadOffset: symbol.payloadOffsetHex,
      });
    }
  }
  return matches;
}

function summarizeEntry(entry, matches, requestedLabels) {
  const strong = matches.filter((match) => match.strength === "strong");
  const labels = strong.filter((match) => match.kind === "label");
  const requested = labels.filter((match) => requestedLabels.includes(normalizeLabel(match.text)));
  const commands = strong.filter((match) => match.kind === "full" || match.kind === "fragment");
  const safe = Boolean(entry.run && entry.run.writebackRiskCount === 0);
  return {
    index: entry.index,
    offset: entry.offset,
    groupCursor: entry.groupCursor,
    kind: entry.kind,
    stackSpan: entry.stackSpan,
    ref: entry.ref,
    safeUnderTrace: safe,
    writebackRiskCount: entry.run?.writebackRiskCount ?? null,
    strongMatchCount: strong.length,
    requestedLabelMatchCount: requested.length,
    commandMatchCount: commands.length,
    matches: [
      ...requested,
      ...commands,
      ...strong.filter((match) => !requested.includes(match) && !commands.includes(match)),
      ...matches.filter((match) => match.strength !== "strong"),
    ].slice(0, 8),
  };
}

function analyzeCandidate(candidate, symbols, starts, requestedLabels) {
  const entries = (candidate.entries || [])
    .filter((entry) => entry.plausible !== false)
    .map((entry) => summarizeEntry(entry, matchRef(entry.ref, symbols, starts), requestedLabels));
  const requestedRows = entries.filter((entry) => entry.requestedLabelMatchCount > 0);
  const commandRows = entries.filter((entry) => entry.commandMatchCount > 0);
  return {
    modes: candidate.modes || {},
    end: candidate.end || "",
    layoutDelta: candidate.layoutDelta ?? null,
    score: candidate.score ?? null,
    entryCount: candidate.entryCount || 0,
    plausibleEntryCount: candidate.plausibleEntryCount || 0,
    safeEntryCount: candidate.safeEntryCount || 0,
    requestedLabelEntryCount: requestedRows.length,
    safeRequestedLabelEntryCount: requestedRows.filter((entry) => entry.safeUnderTrace).length,
    commandEntryCount: commandRows.length,
    safeCommandEntryCount: commandRows.filter((entry) => entry.safeUnderTrace).length,
    requestedRows: requestedRows.slice(0, 8),
    commandRows: commandRows.slice(0, 8),
  };
}

function modeKey(modes) {
  return `74=${modes.ref74Mode || "-"},64=${modes.ref64Mode || "-"}`;
}

function compactCandidate(candidate) {
  return {
    modes: candidate.modes,
    modeKey: modeKey(candidate.modes),
    end: candidate.end,
    layoutDelta: candidate.layoutDelta,
    score: candidate.score,
    plausibleEntryCount: candidate.plausibleEntryCount,
    safeEntryCount: candidate.safeEntryCount,
    requestedLabelEntryCount: candidate.requestedLabelEntryCount,
    safeRequestedLabelEntryCount: candidate.safeRequestedLabelEntryCount,
    commandEntryCount: candidate.commandEntryCount,
    safeCommandEntryCount: candidate.safeCommandEntryCount,
    requestedRows: candidate.requestedRows,
    commandRows: candidate.commandRows,
  };
}

function analyzeScript(entryScript, layoutScript, requestedLabels) {
  const starts = {
    group: parseHex(entryScript.groupEnd),
    text: parseHex(layoutScript?.zones?.textAndResourcePool?.start),
    symbol: parseHex(layoutScript?.zones?.labelAndSymbolPool?.start),
  };
  const symbols = buildSymbolSlots(layoutScript);
  const candidates = (entryScript.tailCandidates || []).map((candidate) => analyzeCandidate(candidate, symbols, starts, requestedLabels));
  const requestedCandidates = candidates.filter((candidate) => candidate.requestedLabelEntryCount > 0);
  const safeRequestedCandidates = candidates.filter((candidate) => candidate.safeRequestedLabelEntryCount > 0);
  const commandCandidates = candidates.filter((candidate) => candidate.commandEntryCount > 0);
  const bestScore = candidates[0] || null;
  const bestLayout = candidates
    .filter((candidate) => Number.isFinite(candidate.layoutDelta))
    .slice()
    .sort((a, b) => Math.abs(a.layoutDelta) - Math.abs(b.layoutDelta) || b.score - a.score)[0] || null;
  const bestRequested = requestedCandidates
    .slice()
    .sort((a, b) => b.safeRequestedLabelEntryCount - a.safeRequestedLabelEntryCount || b.requestedLabelEntryCount - a.requestedLabelEntryCount || b.score - a.score)[0] || null;
  const bestCommand = commandCandidates
    .slice()
    .sort((a, b) => b.safeCommandEntryCount - a.safeCommandEntryCount || b.commandEntryCount - a.commandEntryCount || b.score - a.score)[0] || null;
  let status = "ref-encoding-no-symbol-match";
  if (safeRequestedCandidates.length) status = "ref-encoding-safe-label";
  else if (requestedCandidates.length) status = "ref-encoding-risk-label-collision";
  else if (commandCandidates.length) status = "ref-encoding-command-only";
  return {
    name: entryScript.name,
    executionMode: entryScript.executionMode || "",
    starts: {
      groupEnd: hex(starts.group),
      textPool: hex(starts.text),
      symbolPool: hex(starts.symbol),
    },
    labels: symbols.filter((symbol) => symbol.kind === "label").map((symbol) => ({
      text: symbol.text,
      lengthOffset: symbol.lengthOffsetHex,
      payloadOffset: symbol.payloadOffsetHex,
      symbolRelLen: Number.isFinite(starts.symbol) ? symbol.lengthOffset - starts.symbol : null,
      symbolRelPayload: Number.isFinite(starts.symbol) ? symbol.payloadOffset - starts.symbol : null,
      textRelLen: Number.isFinite(starts.text) ? symbol.lengthOffset - starts.text : null,
      textRelPayload: Number.isFinite(starts.text) ? symbol.payloadOffset - starts.text : null,
    })),
    status,
    candidateCount: candidates.length,
    topMode: bestScore ? modeKey(bestScore.modes) : "",
    topRef64Mode: bestScore?.modes?.ref64Mode || "",
    layoutClosestMode: bestLayout ? modeKey(bestLayout.modes) : "",
    layoutClosestDelta: bestLayout?.layoutDelta ?? null,
    requestedCandidateCount: requestedCandidates.length,
    safeRequestedCandidateCount: safeRequestedCandidates.length,
    commandCandidateCount: commandCandidates.length,
    bestScore: bestScore ? compactCandidate(bestScore) : null,
    bestLayout: bestLayout ? compactCandidate(bestLayout) : null,
    bestRequested: bestRequested ? compactCandidate(bestRequested) : null,
    bestCommand: bestCommand ? compactCandidate(bestCommand) : null,
    candidates: candidates.slice(0, 12).map(compactCandidate),
  };
}

function summarizeModeDiversity(scripts) {
  const topRef64Modes = unique(scripts.map((script) => script.topRef64Mode));
  const topModeCounts = {};
  for (const script of scripts) {
    topModeCounts[script.topMode] = (topModeCounts[script.topMode] || 0) + 1;
  }
  return {
    topRef64Modes,
    topModeCounts,
    universalTopRef64: topRef64Modes.length === 1 ? topRef64Modes[0] : "",
  };
}

function buildReport(options = {}) {
  const input = path.resolve(options.input || DEFAULT_INPUT);
  const entrypoint = buildEntrypointReport({ input, includeAllEntries: true });
  const layout = readJson(LAYOUT_JSON);
  const labelPointer = readJson(LABEL_POINTER_JSON);
  const compareShim = fs.existsSync(COMPARE_SHIM_JSON) ? readJson(COMPARE_SHIM_JSON) : null;
  const requestedLabels = unique((labelPointer.pointerProfiles || []).map((profile) => normalizeLabel(profile.requestedLabel)));
  const layoutByName = new Map((layout.scripts || []).map((script) => [script.name, script]));
  const scripts = (entrypoint.scripts || []).map((script) => analyzeScript(script, layoutByName.get(script.name), requestedLabels));
  const safeLabelScripts = scripts.filter((script) => script.safeRequestedCandidateCount > 0).map((script) => script.name);
  const riskyLabelScripts = scripts.filter((script) => script.safeRequestedCandidateCount === 0 && script.requestedCandidateCount > 0).map((script) => script.name);
  const commandOnlyScripts = scripts.filter((script) => script.requestedCandidateCount === 0 && script.commandCandidateCount > 0).map((script) => script.name);
  const modeDiversity = summarizeModeDiversity(scripts);
  return {
    schema: "nicai.cbe.xseRefEncodingProbe.v1",
    generatedAt: new Date().toISOString(),
    input,
    inputs: {
      entrypoint: "cbe_xse_entrypoint_probe.buildReport({ includeAllEntries: true })",
      layout: LAYOUT_JSON,
      labelPointer: LABEL_POINTER_JSON,
      compareShim: COMPARE_SHIM_JSON,
    },
    summary: {
      status: safeLabelScripts.length ? "ref-encoding-partial" : "ref-encoding-unresolved",
      scriptCount: scripts.length,
      requestedLabels,
      safeLabelScripts,
      riskyLabelScripts,
      commandOnlyScripts,
      topRef64Modes: modeDiversity.topRef64Modes,
      universalTopRef64: modeDiversity.universalTopRef64,
      compareShimPrimaryModel: compareShim?.summary?.primaryModel || "",
      exactAdrSelectedCount: compareShim?.summary?.exactAdrSelectedCount || 0,
      currentFinding: safeLabelScripts.length
        ? `${safeLabelScripts.length}/${scripts.length} focused scripts have a safe requested-label ref candidate; top ref64 modes are ${modeDiversity.topRef64Modes.join(", ") || "none"}.`
        : `No focused script has a safe requested-label +0x64 ref candidate. ${riskyLabelScripts.length} script(s) have only risky requested-label collisions, ${commandOnlyScripts.length} have command-symbol-only collisions, and top ref64 modes split as ${modeDiversity.topRef64Modes.join(", ") || "none"}.`,
      emulatorImpact: "The generic emulator must keep +0x64 record+0x10 as unresolved ABI data. A nearby/full-label compare shim is not enough until the ref width/base explains safe label matches across scripts.",
      nextTarget: "Recover the provider +0x50 label/ref compare normalization or expand the +0x64 ref oracle beyond symbol-pool offsets, then re-run activation only for safe requested-label entries.",
    },
    modeDiversity,
    scripts,
  };
}

function mdRow(cells) {
  return `| ${cells.map((cell) => String(cell ?? "").replace(/\|/g, "\\|")).join(" | ")} |`;
}

function renderEntry(entry) {
  const matches = (entry.matches || []).map((match) => `${match.transform}:${match.text}@${match.lengthOffset}`).join(",");
  return `entry${entry.index}@${entry.offset} ref=${entry.ref} cursor=${entry.groupCursor} safe=${entry.safeUnderTrace ? "yes" : "no"} ${matches}`;
}

function renderCandidate(candidate) {
  if (!candidate) return "-";
  return `${candidate.modeKey} delta=${candidate.layoutDelta} safe=${candidate.safeEntryCount}/${candidate.plausibleEntryCount} label=${candidate.safeRequestedLabelEntryCount}/${candidate.requestedLabelEntryCount} cmd=${candidate.safeCommandEntryCount}/${candidate.commandEntryCount}`;
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# XSE Ref Encoding Probe");
  lines.push("");
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Status: ${report.summary.status}`);
  lines.push(`- Finding: ${report.summary.currentFinding}`);
  lines.push(`- Emulator impact: ${report.summary.emulatorImpact}`);
  lines.push(`- Next target: ${report.summary.nextTarget}`);
  lines.push("");
  lines.push("## Script Matrix");
  lines.push("");
  lines.push(mdRow(["Script", "Status", "Top mode", "Layout-closest", "Best requested label", "Best command"]));
  lines.push(mdRow(["---", "---", "---", "---", "---", "---"]));
  for (const script of report.scripts) {
    lines.push(mdRow([
      script.name,
      script.status,
      renderCandidate(script.bestScore),
      renderCandidate(script.bestLayout),
      renderCandidate(script.bestRequested),
      renderCandidate(script.bestCommand),
    ]));
  }
  for (const script of report.scripts) {
    lines.push("");
    lines.push(`## ${script.name}`);
    lines.push("");
    lines.push(`- Labels: ${script.labels.map((label) => `${label.text}@${label.lengthOffset}/${label.payloadOffset} sym=${label.symbolRelLen}/${label.symbolRelPayload} text=${label.textRelLen}/${label.textRelPayload}`).join("; ") || "-"}`);
    lines.push(`- Top ref64 mode: ${script.topRef64Mode || "-"}; layout closest: ${script.layoutClosestMode || "-"} delta=${script.layoutClosestDelta ?? "-"}`);
    if (script.bestRequested?.requestedRows?.length) {
      lines.push("- Requested-label rows:");
      for (const row of script.bestRequested.requestedRows) lines.push(`  - ${renderEntry(row)}`);
    }
    if (script.bestCommand?.commandRows?.length) {
      lines.push("- Command-symbol rows:");
      for (const row of script.bestCommand.commandRows.slice(0, 6)) lines.push(`  - ${renderEntry(row)}`);
    }
    lines.push("- Top candidates:");
    for (const candidate of script.candidates.slice(0, 6)) {
      lines.push(`  - ${renderCandidate(candidate)}`);
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
  const jsonFile = path.join(outDir, "xse_ref_encoding_probe.json");
  const mdFile = path.join(outDir, "xse_ref_encoding_probe.md");
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
