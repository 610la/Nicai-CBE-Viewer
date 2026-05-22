const fs = require("fs");
const path = require("path");
const { DEFAULT_INPUT } = require("./cbe_unpack");
const { buildReport: buildEntrypointReport } = require("./cbe_xse_entrypoint_probe");

const LAYOUT_JSON = path.resolve(__dirname, "out_godwar_xselayout", "xse_layout_trace.json");
const LABEL_POINTER_JSON = path.resolve(__dirname, "out_godwar_xselabelpointer", "xse_label_pointer_probe.json");
const DEFAULT_OUT = path.resolve(__dirname, "out_godwar_xsetailboundary");

const REF_MODELS = [
  {
    id: "text-payload",
    description: "Only text-pool payload offsets.",
    transforms: new Set(["textRelPayload"]),
  },
  {
    id: "payload-strong",
    description: "All payload-position transforms.",
    transforms: new Set(["absPayload", "symbolRelPayload", "textRelPayload", "groupRelPayload"]),
  },
  {
    id: "all-strong",
    description: "All absolute and pool-relative length/payload transforms.",
    transforms: new Set([
      "absLen",
      "absPayload",
      "symbolRelLen",
      "symbolRelPayload",
      "textRelLen",
      "textRelPayload",
      "groupRelLen",
      "groupRelPayload",
    ]),
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

function knownLabel(text) {
  const raw = String(text || "").trim();
  const lower = raw.toLowerCase();
  if (lower === "init") return "INIT";
  if (lower === "_main" || lower === "main") return "_MAIN";
  return "";
}

function normalizeLabel(text) {
  return knownLabel(text) || String(text || "").trim().toUpperCase();
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

function labelSlots(layoutScript, requestedLabels) {
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

function matchEntryRef(entry, slots, starts, transforms) {
  if (!Number.isFinite(entry.ref)) return [];
  const matches = [];
  for (const slot of slots) {
    for (const [transform, value] of labelValues(slot, starts)) {
      if (!transforms.has(transform) || value !== entry.ref) continue;
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

function selectionStatus(entry) {
  if (!entry) return "unmatched";
  if (entry.plausible === false) return "selected-implausible";
  if (!entry.run) return "selected-no-run";
  if (entry.run.writebackRiskCount > 0) return "selected-writeback-risk";
  return "selected-safe";
}

function boundaryForCandidate(candidate, layoutScript) {
  const end = parseHex(candidate.end);
  const objectEnd = parseHex(layoutScript?.zones?.objectProbe?.end);
  const textStart = parseHex(layoutScript?.zones?.textAndResourcePool?.start);
  const symbolStart = parseHex(layoutScript?.zones?.labelAndSymbolPool?.start);
  let region = "unknown";
  if (Number.isFinite(end) && Number.isFinite(objectEnd) && end <= objectEnd) region = "inside-object-probe";
  else if (Number.isFinite(end) && Number.isFinite(textStart) && end <= textStart) region = "post-object-gap";
  else if (Number.isFinite(end) && Number.isFinite(symbolStart) && end <= symbolStart) region = "text-pool-overrun";
  else if (Number.isFinite(end)) region = "symbol-pool-overrun";
  const boundaryClean = Number.isFinite(end) && Number.isFinite(textStart) && end <= textStart;
  return {
    end,
    endHex: candidate.end || hex(end),
    objectEnd: hex(objectEnd),
    textStart: hex(textStart),
    symbolStart: hex(symbolStart),
    bytesPastTextStart: Number.isFinite(end) && Number.isFinite(textStart) ? end - textStart : null,
    boundaryClean,
    region,
  };
}

function modeKey(modes) {
  return `74=${modes?.ref74Mode || "-"},64=${modes?.ref64Mode || "-"}`;
}

function scanCandidate(candidate, slots, starts, boundary, refModel) {
  const matches = [];
  const entries = (candidate.entries || []).slice().sort((a, b) => a.index - b.index);
  for (const entry of entries) {
    const entryMatches = matchEntryRef(entry, slots, starts, refModel.transforms);
    if (!entryMatches.length) continue;
    matches.push({
      index: entry.index,
      offset: entry.offset,
      groupCursor: entry.groupCursor,
      plausible: entry.plausible !== false,
      ref: entry.ref,
      status: selectionStatus(entry),
      writebackRiskCount: entry.run?.writebackRiskCount ?? null,
      matches: entryMatches,
    });
  }
  const selected = matches[0] || null;
  return {
    modeKey: modeKey(candidate.modes),
    modes: candidate.modes || {},
    score: candidate.score ?? null,
    layoutDelta: candidate.layoutDelta ?? null,
    plausibleEntryCount: candidate.plausibleEntryCount || 0,
    safeEntryCount: candidate.safeEntryCount || 0,
    entryCount: candidate.entryCount || 0,
    end: boundary.endHex,
    region: boundary.region,
    boundaryClean: boundary.boundaryClean,
    bytesPastTextStart: boundary.bytesPastTextStart,
    selected,
    selectedStatus: selected?.status || "unmatched",
    matchCount: matches.length,
    matches: matches.slice(0, 8),
  };
}

function chooseBest(scans) {
  return scans.find((scan) => scan.selectedStatus === "selected-safe")
    || scans.find((scan) => scan.selected)
    || null;
}

function compactScan(scan) {
  if (!scan) return null;
  return {
    modeKey: scan.modeKey,
    end: scan.end,
    region: scan.region,
    boundaryClean: scan.boundaryClean,
    bytesPastTextStart: scan.bytesPastTextStart,
    score: scan.score,
    selectedStatus: scan.selectedStatus,
    selected: scan.selected,
  };
}

function analyzeScript(script, layoutScript, requestedLabels) {
  const starts = {
    group: parseHex(script.groupEnd),
    text: parseHex(layoutScript?.zones?.textAndResourcePool?.start),
    symbol: parseHex(layoutScript?.zones?.labelAndSymbolPool?.start),
  };
  const boundaries = {
    objectEnd: layoutScript?.zones?.objectProbe?.end || "",
    textStart: layoutScript?.zones?.textAndResourcePool?.start || "",
    symbolStart: layoutScript?.zones?.labelAndSymbolPool?.start || "",
  };
  const slots = labelSlots(layoutScript, requestedLabels);
  const candidateBoundaries = (script.tailCandidates || []).map((candidate) => ({
    candidate,
    boundary: boundaryForCandidate(candidate, layoutScript),
  }));
  const boundaryCleanCandidateCount = candidateBoundaries.filter((item) => item.boundary.boundaryClean).length;
  const crossingCandidateCount = candidateBoundaries.length - boundaryCleanCandidateCount;
  const models = REF_MODELS.map((refModel) => {
    const scans = candidateBoundaries.map(({ candidate, boundary }) => scanCandidate(candidate, slots, starts, boundary, refModel));
    const matched = scans.filter((scan) => scan.selected);
    const cleanMatched = matched.filter((scan) => scan.boundaryClean);
    const crossingMatched = matched.filter((scan) => !scan.boundaryClean);
    return {
      id: refModel.id,
      description: refModel.description,
      matchedCount: matched.length,
      boundaryCleanMatchedCount: cleanMatched.length,
      boundaryCleanSafeCount: cleanMatched.filter((scan) => scan.selectedStatus === "selected-safe").length,
      crossingMatchedCount: crossingMatched.length,
      crossingSafeCount: crossingMatched.filter((scan) => scan.selectedStatus === "selected-safe").length,
      bestAny: compactScan(chooseBest(matched)),
      bestBoundaryClean: compactScan(chooseBest(cleanMatched)),
      firstCrossing: compactScan(crossingMatched[0] || null),
      topMatches: matched.slice(0, 8).map(compactScan),
    };
  });
  let status = "tail-boundary-no-label-match";
  if (models.some((model) => model.boundaryCleanMatchedCount > 0)) status = "tail-boundary-clean-label-match";
  else if (models.some((model) => model.crossingMatchedCount > 0)) status = "tail-boundary-crossing-only";
  return {
    name: script.name,
    executionMode: script.executionMode || "",
    groupEnd: script.groupEnd || "",
    boundaries,
    labels: slots.map((slot) => `${slot.text}@${slot.lengthOffsetHex}/${slot.payloadOffsetHex}`),
    candidateCount: candidateBoundaries.length,
    boundaryCleanCandidateCount,
    crossingCandidateCount,
    topCandidate: candidateBoundaries[0] ? {
      modeKey: modeKey(candidateBoundaries[0].candidate.modes),
      end: candidateBoundaries[0].boundary.endHex,
      region: candidateBoundaries[0].boundary.region,
      boundaryClean: candidateBoundaries[0].boundary.boundaryClean,
      bytesPastTextStart: candidateBoundaries[0].boundary.bytesPastTextStart,
      score: candidateBoundaries[0].candidate.score,
    } : null,
    status,
    models,
  };
}

function buildReport(options = {}) {
  const input = path.resolve(options.input || DEFAULT_INPUT);
  const layout = readJson(LAYOUT_JSON);
  const labelPointer = readJson(LABEL_POINTER_JSON);
  const requestedLabels = unique((labelPointer.pointerProfiles || []).map((profile) => normalizeLabel(profile.requestedLabel)));
  const entrypoint = buildEntrypointReport({ input, includeAllEntries: true, candidateLimit: 100 });
  const layoutByName = new Map((layout.scripts || []).map((script) => [script.name, script]));
  const scripts = (entrypoint.scripts || []).map((script) => analyzeScript(script, layoutByName.get(script.name), requestedLabels));
  const textPayloadRows = scripts.map((script) => ({
    script,
    model: script.models.find((model) => model.id === "text-payload"),
  }));
  const cleanTextPayloadScripts = textPayloadRows
    .filter((row) => row.model?.boundaryCleanMatchedCount > 0)
    .map((row) => row.script.name);
  const cleanTextPayloadSafeScripts = textPayloadRows
    .filter((row) => row.model?.boundaryCleanSafeCount > 0)
    .map((row) => row.script.name);
  const crossingOnlyTextPayloadScripts = textPayloadRows
    .filter((row) => !row.model?.boundaryCleanMatchedCount && row.model?.crossingMatchedCount > 0)
    .map((row) => row.script.name);
  const cleanAnyScripts = scripts
    .filter((script) => script.models.some((model) => model.boundaryCleanMatchedCount > 0))
    .map((script) => script.name);
  const crossingOnlyAnyScripts = scripts
    .filter((script) => !script.models.some((model) => model.boundaryCleanMatchedCount > 0)
      && script.models.some((model) => model.crossingMatchedCount > 0))
    .map((script) => script.name);
  return {
    schema: "nicai.cbe.xseTailBoundaryProbe.v1",
    generatedAt: new Date().toISOString(),
    input,
    inputs: {
      layout: LAYOUT_JSON,
      labelPointer: LABEL_POINTER_JSON,
      entrypoint: "cbe_xse_entrypoint_probe.buildReport({ includeAllEntries: true, candidateLimit: 100 })",
    },
    summary: {
      status: cleanTextPayloadSafeScripts.length ? "tail-boundary-partial" : "tail-boundary-ref-blocked",
      scriptCount: scripts.length,
      requestedLabels,
      cleanTextPayloadScripts,
      cleanTextPayloadSafeScripts,
      crossingOnlyTextPayloadScripts,
      cleanAnyScripts,
      crossingOnlyAnyScripts,
      currentFinding: cleanTextPayloadScripts.length
        ? `${cleanTextPayloadScripts.length}/${scripts.length} focused scripts have a boundary-clean requested-label text-payload match, but ${cleanTextPayloadSafeScripts.length}/${scripts.length} are safe; crossing-only text-payload collisions appear in ${crossingOnlyTextPayloadScripts.length}/${scripts.length} script(s).`
        : `No focused script has a boundary-clean requested-label text-payload match. Crossing-only text-payload collisions appear in ${crossingOnlyTextPayloadScripts.length}/${scripts.length} script(s).`,
      emulatorImpact: "The generic emulator must reject +0x64 table parses that consume into the text/symbol pools before treating label/ref matches as executable entry bindings.",
      nextTarget: "Recover the provider +0x64 ref reader or the true range-table count/width so +0x64 tables end before the text pool while still matching requested labels.",
    },
    scripts,
  };
}

function mdRow(cells) {
  return `| ${cells.map((cell) => String(cell ?? "").replace(/\|/g, "\\|")).join(" | ")} |`;
}

function renderSelected(scan) {
  if (!scan?.selected) return "-";
  const matches = (scan.selected.matches || []).map((match) => `${match.label}:${match.transform}@${match.lengthOffset}`).join(",");
  const crossing = scan.boundaryClean ? "clean" : `cross+${scan.bytesPastTextStart}`;
  return `${scan.modeKey} end=${scan.end} ${crossing} ${scan.selectedStatus} entry${scan.selected.index} ref=${scan.selected.ref} ${matches}`;
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# XSE Tail Boundary Probe");
  lines.push("");
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Status: ${report.summary.status}`);
  lines.push(`- Finding: ${report.summary.currentFinding}`);
  lines.push(`- Emulator impact: ${report.summary.emulatorImpact}`);
  lines.push(`- Next target: ${report.summary.nextTarget}`);
  lines.push("");
  lines.push("## Script Matrix");
  lines.push("");
  lines.push(mdRow(["Script", "Status", "Top tail", "Candidates clean/cross", "Text-payload clean/safe/cross", "All-strong clean/safe/cross"]));
  lines.push(mdRow(["---", "---", "---", "---:", "---:", "---:"]));
  for (const script of report.scripts) {
    const text = script.models.find((model) => model.id === "text-payload");
    const all = script.models.find((model) => model.id === "all-strong");
    const top = script.topCandidate ? `${script.topCandidate.modeKey} end=${script.topCandidate.end} ${script.topCandidate.region}` : "-";
    lines.push(mdRow([
      script.name,
      script.status,
      top,
      `${script.boundaryCleanCandidateCount}/${script.crossingCandidateCount}`,
      `${text?.boundaryCleanMatchedCount || 0}/${text?.boundaryCleanSafeCount || 0}/${text?.crossingMatchedCount || 0}`,
      `${all?.boundaryCleanMatchedCount || 0}/${all?.boundaryCleanSafeCount || 0}/${all?.crossingMatchedCount || 0}`,
    ]));
  }
  for (const script of report.scripts) {
    lines.push("");
    lines.push(`## ${script.name}`);
    lines.push("");
    lines.push(`- Boundaries: objectEnd=${script.boundaries.objectEnd || "-"}, textStart=${script.boundaries.textStart || "-"}, symbolStart=${script.boundaries.symbolStart || "-"}`);
    lines.push(`- Labels: ${script.labels.join("; ") || "-"}`);
    for (const model of script.models) {
      lines.push(`- ${model.id}: clean=${model.boundaryCleanMatchedCount}, safe=${model.boundaryCleanSafeCount}, crossing=${model.crossingMatchedCount}, bestClean=${renderSelected(model.bestBoundaryClean)}, bestAny=${renderSelected(model.bestAny)}`);
      for (const scan of (model.topMatches || []).slice(0, 3)) {
        lines.push(`  - ${renderSelected(scan)}`);
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
  const input = path.resolve(argv[0] || DEFAULT_INPUT);
  const outDir = path.resolve(argv[1] || DEFAULT_OUT);
  fs.mkdirSync(outDir, { recursive: true });
  const report = buildReport({ input });
  const jsonFile = path.join(outDir, "xse_tail_boundary_probe.json");
  const mdFile = path.join(outDir, "xse_tail_boundary_probe.md");
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
