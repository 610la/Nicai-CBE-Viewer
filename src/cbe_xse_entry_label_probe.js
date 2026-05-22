const fs = require("fs");
const path = require("path");

const ENTRYPOINT_JSON = path.resolve(__dirname, "out_godwar_xseentrypoint", "xse_entrypoint_probe.json");
const LAYOUT_JSON = path.resolve(__dirname, "out_godwar_xselayout", "xse_layout_trace.json");
const DEFAULT_OUT = path.resolve(__dirname, "out_godwar_xseentrylabels");

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

function symbolKind(slot) {
  const text = slot.leadingHit?.text || slot.visible || "";
  if (slot.leadingHit?.kind) return slot.leadingHit.kind;
  if (text === "INIT" || text === "_MAIN") return "label";
  return "slot";
}

function buildSymbolSlots(layoutScript) {
  return (layoutScript.lengthSlots || []).map((slot) => ({
    text: slot.leadingHit?.text || slot.visible || "",
    visible: slot.visible || "",
    kind: symbolKind(slot),
    lengthOffset: parseHex(slot.offsetHex),
    payloadOffset: parseHex(slot.payloadOffsetHex),
    lengthOffsetHex: slot.offsetHex || "",
    payloadOffsetHex: slot.payloadOffsetHex || "",
  }));
}

function candidateValuesForSymbol(symbol, starts) {
  const values = [
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
  ];
  return values.filter(([, value]) => Number.isFinite(value) && value >= 0);
}

function matchRefToSymbols(ref, symbols, starts) {
  if (!Number.isFinite(ref)) return [];
  const matches = [];
  for (const symbol of symbols) {
    for (const [transform, value] of candidateValuesForSymbol(symbol, starts)) {
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

function summarizeMatches(matches) {
  const label = matches.filter((match) => match.kind === "label");
  const strongLabel = label.filter((match) => match.strength === "strong");
  const command = matches.filter((match) => match.kind === "full" || match.kind === "fragment");
  const strongCommand = command.filter((match) => match.strength === "strong");
  return {
    labelCount: label.length,
    strongLabelCount: strongLabel.length,
    commandCount: command.length,
    strongCommandCount: strongCommand.length,
    best: [
      ...strongLabel,
      ...strongCommand,
      ...label.filter((match) => match.strength !== "strong"),
      ...command.filter((match) => match.strength !== "strong"),
      ...matches.filter((match) => match.kind !== "label" && match.kind !== "full" && match.kind !== "fragment"),
    ].slice(0, 6),
  };
}

function analyzeCandidate(candidate, symbols, starts) {
  const entries = (candidate.entries || []).map((entry) => {
    const matches = matchRefToSymbols(entry.ref, symbols, starts);
    const summary = summarizeMatches(matches);
    return {
      index: entry.index,
      offset: entry.offset,
      groupCursor: entry.groupCursor,
      kind: entry.kind,
      stackSpan: entry.stackSpan,
      ref: entry.ref,
      writebackRiskCount: entry.run?.writebackRiskCount ?? null,
      writebackCount: entry.run?.writebackCount ?? null,
      safeUnderTrace: entry.run?.writebackRiskCount === 0,
      matches: summary.best,
      labelMatched: summary.labelCount > 0,
      strongLabelMatched: summary.strongLabelCount > 0,
      commandMatched: summary.commandCount > 0,
      strongCommandMatched: summary.strongCommandCount > 0,
    };
  });
  const safeEntries = entries.filter((entry) => entry.safeUnderTrace);
  return {
    modes: candidate.modes || {},
    end: candidate.end || "",
    layoutDelta: candidate.layoutDelta ?? null,
    plausibleEntryCount: candidate.plausibleEntryCount || 0,
    safeEntryCount: candidate.safeEntryCount || 0,
    minEntryWritebackRisk: candidate.minEntryWritebackRisk ?? null,
    score: candidate.score ?? null,
    entrySampleCount: entries.length,
    strongLabelEntryCount: entries.filter((entry) => entry.strongLabelMatched).length,
    safeStrongLabelEntryCount: safeEntries.filter((entry) => entry.strongLabelMatched).length,
    strongCommandEntryCount: entries.filter((entry) => entry.strongCommandMatched).length,
    safeStrongCommandEntryCount: safeEntries.filter((entry) => entry.strongCommandMatched).length,
    entries,
  };
}

function buildScriptReport(entryScript, layoutScript) {
  const starts = {
    group: parseHex(entryScript.groupEnd),
    text: parseHex(layoutScript?.zones?.textAndResourcePool?.start),
    symbol: parseHex(layoutScript?.zones?.labelAndSymbolPool?.start),
  };
  const symbols = layoutScript ? buildSymbolSlots(layoutScript) : [];
  const labelSlots = symbols.filter((symbol) => symbol.kind === "label");
  const candidates = (entryScript.tailCandidates || [])
    .slice(0, 12)
    .map((candidate) => analyzeCandidate(candidate, symbols, starts));
  const safeLabelCandidates = candidates.filter((candidate) => candidate.safeStrongLabelEntryCount > 0);
  const safeCommandCandidates = candidates.filter((candidate) => candidate.safeStrongCommandEntryCount > 0);
  const bestLabelCandidate = safeLabelCandidates[0] || candidates.find((candidate) => candidate.strongLabelEntryCount > 0) || null;
  const bestCommandCandidate = safeCommandCandidates[0] || candidates.find((candidate) => candidate.strongCommandEntryCount > 0) || null;
  const status = safeLabelCandidates.length
    ? "label-entry-confirmed"
    : safeCommandCandidates.length
    ? "symbol-command-only"
    : candidates.some((candidate) => candidate.strongLabelEntryCount > 0)
    ? "label-match-not-safe"
    : "label-ref-unresolved";
  return {
    name: entryScript.name,
    executionMode: entryScript.executionMode || "",
    entryStatus: entryScript.status || "",
    starts: {
      groupEnd: hex(starts.group),
      textPool: hex(starts.text),
      symbolPool: hex(starts.symbol),
    },
    labels: labelSlots.map((slot) => ({
      text: slot.text,
      lengthOffset: slot.lengthOffsetHex,
      payloadOffset: slot.payloadOffsetHex,
      symbolRelLength: Number.isFinite(starts.symbol) ? slot.lengthOffset - starts.symbol : null,
      symbolRelPayload: Number.isFinite(starts.symbol) ? slot.payloadOffset - starts.symbol : null,
    })),
    status,
    candidateCount: candidates.length,
    safeLabelCandidateCount: safeLabelCandidates.length,
    safeCommandCandidateCount: safeCommandCandidates.length,
    bestLabelCandidate: bestLabelCandidate ? {
      modes: bestLabelCandidate.modes,
      end: bestLabelCandidate.end,
      layoutDelta: bestLabelCandidate.layoutDelta,
      safeStrongLabelEntryCount: bestLabelCandidate.safeStrongLabelEntryCount,
      entries: bestLabelCandidate.entries.filter((entry) => entry.strongLabelMatched).slice(0, 4),
    } : null,
    bestCommandCandidate: bestCommandCandidate ? {
      modes: bestCommandCandidate.modes,
      end: bestCommandCandidate.end,
      layoutDelta: bestCommandCandidate.layoutDelta,
      safeStrongCommandEntryCount: bestCommandCandidate.safeStrongCommandEntryCount,
      entries: bestCommandCandidate.entries.filter((entry) => entry.strongCommandMatched).slice(0, 4),
    } : null,
    candidates,
  };
}

function buildReport() {
  const entrypoint = readJson(ENTRYPOINT_JSON);
  const layout = readJson(LAYOUT_JSON);
  const layoutByName = new Map((layout.scripts || []).map((script) => [script.name, script]));
  const scripts = (entrypoint.scripts || []).map((script) => buildScriptReport(script, layoutByName.get(script.name)));
  const labelConfirmed = scripts.filter((script) => script.status === "label-entry-confirmed");
  const commandOnly = scripts.filter((script) => script.status === "symbol-command-only");
  return {
    schema: "nicai.cbe.xseEntryLabelProbe.v1",
    generatedAt: new Date().toISOString(),
    inputs: {
      entrypoint: ENTRYPOINT_JSON,
      layout: LAYOUT_JSON,
    },
    summary: {
      status: labelConfirmed.length ? "entry-label-partial" : "entry-label-binding-unresolved",
      scriptCount: scripts.length,
      labelConfirmedScripts: labelConfirmed.map((script) => script.name),
      commandOnlyScripts: commandOnly.map((script) => script.name),
      currentFinding: labelConfirmed.length
        ? `${labelConfirmed.length}/${scripts.length} focused scripts have a safe +0x64 candidate whose ref strongly maps to a label slot; ${commandOnly.length} only map to command-symbol slots.`
        : `No focused script has a safe +0x64 candidate whose ref strongly maps to INIT/_MAIN label slots; ${commandOnly.length}/${scripts.length} only map to command-symbol slots under current tail modes.`,
      emulatorImpact: "The 0x12364 label-entry helper is real, but safe cursor candidates are not enough. A generic emulator should not promote a +0x64 entry until its ref is bound to a caller-requested label/symbol value.",
      nextTarget: "Bind the caller-provided label/ref value and the +0x64 ref width, then prefer candidates that match INIT/_MAIN or the actual requested label before enabling visible script effects.",
    },
    scripts,
  };
}

function mdRow(cells) {
  return `| ${cells.map((cell) => String(cell ?? "").replace(/\|/g, "\\|")).join(" | ")} |`;
}

function matchText(entries) {
  if (!entries?.length) return "-";
  return entries.map((entry) => {
    const labels = entry.matches.map((match) => `${match.transform}:${match.text}@${match.lengthOffset}`).join(",");
    return `entry${entry.index} ref=${entry.ref} cursor=${entry.groupCursor} ${labels}`;
  }).join("; ");
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# XSE Entry Label Probe");
  lines.push("");
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Status: ${report.summary.status}`);
  lines.push(`- Finding: ${report.summary.currentFinding}`);
  lines.push(`- Emulator impact: ${report.summary.emulatorImpact}`);
  lines.push(`- Next target: ${report.summary.nextTarget}`);
  lines.push("");
  lines.push(mdRow(["Script", "Status", "Labels", "Safe label candidates", "Safe command candidates", "Best label", "Best command"]));
  lines.push(mdRow(["---", "---", "---", "---:", "---:", "---", "---"]));
  for (const script of report.scripts) {
    lines.push(mdRow([
      script.name,
      script.status,
      script.labels.map((label) => `${label.text}@${label.lengthOffset}`).join(", "),
      script.safeLabelCandidateCount,
      script.safeCommandCandidateCount,
      script.bestLabelCandidate ? matchText(script.bestLabelCandidate.entries) : "-",
      script.bestCommandCandidate ? matchText(script.bestCommandCandidate.entries) : "-",
    ]));
  }
  for (const script of report.scripts) {
    lines.push("");
    lines.push(`## ${script.name}`);
    lines.push(`- Starts: groupEnd=${script.starts.groupEnd}, textPool=${script.starts.textPool}, symbolPool=${script.starts.symbolPool}`);
    lines.push(`- Labels: ${script.labels.map((label) => `${label.text} lenRel=${label.symbolRelLength} payloadRel=${label.symbolRelPayload}`).join("; ") || "-"}`);
    for (const candidate of script.candidates.slice(0, 6)) {
      lines.push(`- 74=${candidate.modes.ref74Mode || "-"},64=${candidate.modes.ref64Mode || "-"} end=${candidate.end} delta=${candidate.layoutDelta} safe=${candidate.safeEntryCount} strongLabel=${candidate.safeStrongLabelEntryCount}/${candidate.strongLabelEntryCount} strongCommand=${candidate.safeStrongCommandEntryCount}/${candidate.strongCommandEntryCount}`);
      for (const entry of candidate.entries.filter((item) => item.strongLabelMatched || item.strongCommandMatched).slice(0, 4)) {
        lines.push(`  - entry${entry.index}@${entry.offset}: cursor=${entry.groupCursor}, ref=${entry.ref}, safe=${entry.safeUnderTrace ? "yes" : "no"}, matches=${entry.matches.map((match) => `${match.transform}:${match.text}@${match.lengthOffset}`).join(", ")}`);
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
  const jsonFile = path.join(outDir, "xse_entry_label_probe.json");
  const mdFile = path.join(outDir, "xse_entry_label_probe.md");
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
