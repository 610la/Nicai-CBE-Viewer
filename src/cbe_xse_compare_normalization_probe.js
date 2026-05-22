const fs = require("fs");
const path = require("path");
const { DEFAULT_INPUT } = require("./cbe_unpack");
const { buildReport: buildEntrypointReport } = require("./cbe_xse_entrypoint_probe");

const LABEL_POINTER_JSON = path.resolve(__dirname, "out_godwar_xselabelpointer", "xse_label_pointer_probe.json");
const LAYOUT_JSON = path.resolve(__dirname, "out_godwar_xselayout", "xse_layout_trace.json");
const DEFAULT_OUT = path.resolve(__dirname, "out_godwar_xsecomparenormalization");

const REF_MODELS = [
  {
    id: "text-payload",
    description: "Only text-pool payload offsets; current narrow compare-shim model.",
    transforms: new Set(["textRelPayload"]),
  },
  {
    id: "payload-strong",
    description: "All payload-position transforms, excluding length-byte offsets.",
    transforms: new Set(["absPayload", "symbolRelPayload", "textRelPayload", "groupRelPayload"]),
  },
  {
    id: "all-strong",
    description: "All absolute, pool-relative, text-relative, and group-relative length/payload transforms.",
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

const NORMALIZERS = [
  {
    id: "exact-cstring",
    description: "Use the C string beginning exactly at the ADR target.",
    text(profile) {
      return profile.exactTextAtTarget || "";
    },
  },
  {
    id: "target-minus2-cstring",
    description: "Read a C string two bytes before the ADR target.",
    text(profile) {
      return profile.minus2Text || "";
    },
  },
  {
    id: "target-plus2-cstring",
    description: "Read a C string two bytes after the ADR target.",
    text(profile) {
      return profile.plus2Text || "";
    },
  },
  {
    id: "pc-plus2-diagnostic",
    description: "Use the diagnostic address+2+imm target when it forms a known label.",
    text(profile) {
      return profile.adr?.pcPlus2DiagnosticText || "";
    },
  },
  {
    id: "nearest-full-label",
    description: "Use the nearest recovered Init/_main ASCII label.",
    text(profile) {
      return profile.nearestFullLabel || "";
    },
  },
  {
    id: "target-plusminus2-full-label",
    description: "Use target-2 or target+2 only if it lands exactly on Init/_main.",
    text(profile) {
      return knownLabel(profile.minus2Text) || knownLabel(profile.plus2Text) || "";
    },
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

function readAscii(data, start, limit = 48) {
  if (!Number.isFinite(start) || start < 0 || start >= data.length) return "";
  const out = [];
  for (let pos = start; pos < data.length && out.length < limit; pos += 1) {
    const value = data[pos];
    if (value === 0) break;
    if (value < 0x20 || value > 0x7e) break;
    out.push(String.fromCharCode(value));
  }
  return out.join("");
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

function labelSlots(layoutScript, labels) {
  const wanted = new Set(labels.map(normalizeLabel));
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
    .filter((slot) => wanted.has(slot.text));
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
    ["low8Len", slot.lengthOffset & 0xff],
    ["low8Payload", slot.payloadOffset & 0xff],
    ["low16Len", slot.lengthOffset & 0xffff],
    ["low16Payload", slot.payloadOffset & 0xffff],
  ].filter(([, value]) => Number.isFinite(value) && value >= 0);
}

function matchEntryRef(entry, slots, starts, transforms) {
  if (!Number.isFinite(entry.ref)) return [];
  const matches = [];
  for (const slot of slots) {
    for (const [transform, value] of labelValues(slot, starts)) {
      if (!transforms.has(transform)) continue;
      if (value !== entry.ref) continue;
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

function safeUnderTrace(entry) {
  return Boolean(entry.plausible !== false && entry.run && entry.run.writebackRiskCount === 0);
}

function selectionStatus(entry) {
  if (!entry) return "unmatched";
  if (entry.plausible === false) return "selected-implausible";
  if (!entry.run) return "selected-no-run";
  if (entry.run.writebackRiskCount > 0) return "selected-writeback-risk";
  return "selected-safe";
}

function summarizeEntry(entry, matches) {
  return {
    index: entry.index,
    offset: entry.offset,
    groupCursor: entry.groupCursor,
    kind: entry.kind,
    stackSpan: entry.stackSpan,
    plausible: entry.plausible !== false,
    ref: entry.ref,
    safeUnderTrace: safeUnderTrace(entry),
    riskKind: selectionStatus(entry),
    writebackRiskCount: entry.run?.writebackRiskCount ?? null,
    matches,
  };
}

function chooseBest(scans) {
  return scans.find((scan) => scan.selected?.safeUnderTrace)
    || scans.find((scan) => scan.selected)
    || null;
}

function scanCandidate(candidate, slots, starts, refModel) {
  const matched = [];
  const entries = (candidate.entries || []).slice().sort((a, b) => a.index - b.index);
  for (const entry of entries) {
    const matches = matchEntryRef(entry, slots, starts, refModel.transforms);
    if (!matches.length) continue;
    matched.push(summarizeEntry(entry, matches));
  }
  const selected = matched[0] || null;
  return {
    modes: candidate.modes || {},
    end: candidate.end || "",
    layoutDelta: candidate.layoutDelta ?? null,
    score: candidate.score ?? null,
    entryCount: candidate.entryCount || 0,
    plausibleEntryCount: candidate.plausibleEntryCount || 0,
    safeEntryCount: candidate.safeEntryCount || 0,
    selected,
    selectedStatus: selectionStatus(selected),
    matchCount: matched.length,
    matches: matched.slice(0, 8),
  };
}

function analyzeScript(script, layoutScript, labels, refModel) {
  const starts = {
    group: parseHex(script.groupEnd),
    text: parseHex(layoutScript?.zones?.textAndResourcePool?.start),
    symbol: parseHex(layoutScript?.zones?.labelAndSymbolPool?.start),
  };
  const slots = labelSlots(layoutScript, labels);
  const scans = (script.tailCandidates || []).map((candidate) => scanCandidate(candidate, slots, starts, refModel));
  const best = chooseBest(scans);
  return {
    name: script.name,
    labels,
    status: best?.selected ? selectionStatus(best.selected) : "unmatched",
    bestSelection: best,
  };
}

function analyzeNormalizer(normalizer, profiles, entrypoint, layoutByName) {
  const perCall = profiles.map((profile) => {
    const text = normalizer.text(profile);
    const normalizedLabel = knownLabel(text);
    const requestedLabel = normalizeLabel(profile.requestedLabel);
    return {
      call: profile.call,
      target: profile.target,
      requestedLabel,
      text,
      normalizedLabel,
      matchesRequested: Boolean(normalizedLabel && normalizedLabel === requestedLabel),
    };
  });
  const labels = unique(perCall.map((call) => call.normalizedLabel));
  const refModels = REF_MODELS.map((refModel) => {
    const scripts = (entrypoint.scripts || []).map((script) => analyzeScript(script, layoutByName.get(script.name), labels, refModel));
    return {
      id: refModel.id,
      description: refModel.description,
      labels,
      selectedSafeScripts: scripts.filter((script) => script.status === "selected-safe").map((script) => script.name),
      selectedWritebackRiskScripts: scripts.filter((script) => script.status === "selected-writeback-risk" || script.status === "selected-no-run").map((script) => script.name),
      selectedImplausibleScripts: scripts.filter((script) => script.status === "selected-implausible").map((script) => script.name),
      unmatchedScripts: scripts.filter((script) => script.status === "unmatched").map((script) => script.name),
      scripts,
    };
  });
  return {
    id: normalizer.id,
    description: normalizer.description,
    labels,
    coverageCount: perCall.filter((call) => call.normalizedLabel).length,
    requestedCoverageCount: perCall.filter((call) => call.matchesRequested).length,
    perCall,
    refModels,
  };
}

function enrichProfiles(labelPointer, data) {
  return (labelPointer.pointerProfiles || []).map((profile) => {
    const target = profile.targetOffset ?? parseHex(profile.target);
    return {
      ...profile,
      minus2Text: readAscii(data, target - 2),
      plus2Text: readAscii(data, target + 2),
      exactTextAtTarget: profile.exactTextAtTarget || readAscii(data, target),
    };
  });
}

function buildReport(options = {}) {
  const input = path.resolve(options.input || DEFAULT_INPUT);
  const data = fs.readFileSync(input);
  const labelPointer = readJson(LABEL_POINTER_JSON);
  const layout = readJson(LAYOUT_JSON);
  const entrypoint = buildEntrypointReport({ input, includeAllEntries: true });
  const profiles = enrichProfiles(labelPointer, data);
  const layoutByName = new Map((layout.scripts || []).map((script) => [script.name, script]));
  const normalizers = NORMALIZERS.map((normalizer) => analyzeNormalizer(normalizer, profiles, entrypoint, layoutByName));
  const exact = normalizers.find((item) => item.id === "exact-cstring");
  const pc2 = normalizers.find((item) => item.id === "pc-plus2-diagnostic");
  const plusMinus = normalizers.find((item) => item.id === "target-plusminus2-full-label");
  const nearest = normalizers.find((item) => item.id === "nearest-full-label");
  const primary = plusMinus?.refModels.find((model) => model.id === "text-payload") || null;
  const fullCoverage = normalizers.filter((item) => item.requestedCoverageCount === profiles.length).map((item) => item.id);
  return {
    schema: "nicai.cbe.xseCompareNormalizationProbe.v1",
    generatedAt: new Date().toISOString(),
    input,
    inputs: {
      labelPointer: LABEL_POINTER_JSON,
      layout: LAYOUT_JSON,
      entrypoint: "cbe_xse_entrypoint_probe.buildReport({ includeAllEntries: true })",
    },
    summary: {
      status: primary?.selectedSafeScripts.length ? "compare-normalization-partial" : "compare-normalization-ref-blocked",
      profileCount: profiles.length,
      exactRequestedCoverage: exact?.requestedCoverageCount || 0,
      pcPlus2RequestedCoverage: pc2?.requestedCoverageCount || 0,
      targetPlusMinus2RequestedCoverage: plusMinus?.requestedCoverageCount || 0,
      nearestFullRequestedCoverage: nearest?.requestedCoverageCount || 0,
      fullCoverageStrategies: fullCoverage,
      primaryStrategy: "target-plusminus2-full-label/text-payload",
      primarySafeScripts: primary?.selectedSafeScripts || [],
      primaryRiskScripts: primary?.selectedWritebackRiskScripts || [],
      primaryUnmatchedScripts: primary?.unmatchedScripts || [],
      currentFinding: `Exact ADR strings explain ${exact?.requestedCoverageCount || 0}/${profiles.length} caller labels, pc+2 explains ${pc2?.requestedCoverageCount || 0}/${profiles.length}, and target±2 explains ${plusMinus?.requestedCoverageCount || 0}/${profiles.length}. Even the full-coverage target±2/text-payload model has ${primary?.selectedSafeScripts.length || 0}/${entrypoint.scripts?.length || 0} safe selections and ${primary?.selectedWritebackRiskScripts.length || 0} writeback-risk selection(s).`,
      emulatorImpact: "Pointer normalization alone is not sufficient for a generic emulator. The provider compare shim still needs the record+0x10 ref side or another oracle before label-entry activation can drive visible effects.",
      nextTarget: "Bind provider +0x50 label/ref comparison on the record-ref side, or recover a non-symbol-pool ref representation that yields safe requested-label selections across focused scripts.",
    },
    profiles: profiles.map((profile) => ({
      call: profile.call,
      target: profile.target,
      requestedLabel: normalizeLabel(profile.requestedLabel),
      exactTextAtTarget: profile.exactTextAtTarget || "",
      minus2Text: profile.minus2Text || "",
      plus2Text: profile.plus2Text || "",
      pcPlus2DiagnosticText: profile.adr?.pcPlus2DiagnosticText || "",
      nearestFullLabel: profile.nearestFullLabel || "",
    })),
    normalizers,
  };
}

function mdRow(cells) {
  return `| ${cells.map((cell) => String(cell ?? "").replace(/\|/g, "\\|")).join(" | ")} |`;
}

function renderSelection(script) {
  const selected = script.bestSelection?.selected;
  if (!selected) return "-";
  const matches = selected.matches.map((match) => `${match.label}:${match.transform}@${match.lengthOffset}`).join(",");
  return `entry${selected.index} cursor=${selected.groupCursor} ref=${selected.ref} ${selected.riskKind} ${matches}`;
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# XSE Compare Normalization Probe");
  lines.push("");
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Status: ${report.summary.status}`);
  lines.push(`- Finding: ${report.summary.currentFinding}`);
  lines.push(`- Emulator impact: ${report.summary.emulatorImpact}`);
  lines.push(`- Next target: ${report.summary.nextTarget}`);
  lines.push("");
  lines.push("## Pointer Normalizers");
  lines.push("");
  lines.push(mdRow(["Normalizer", "Coverage", "Labels", "text-payload safe/risk/unmatched"]));
  lines.push(mdRow(["---", "---:", "---", "---"]));
  for (const normalizer of report.normalizers) {
    const textPayload = normalizer.refModels.find((model) => model.id === "text-payload");
    lines.push(mdRow([
      normalizer.id,
      `${normalizer.requestedCoverageCount}/${report.summary.profileCount}`,
      normalizer.labels.join(", ") || "-",
      `${textPayload?.selectedSafeScripts.length || 0}/${textPayload?.selectedWritebackRiskScripts.length || 0}/${textPayload?.unmatchedScripts.length || 0}`,
    ]));
  }
  lines.push("");
  lines.push("## Caller Text Matrix");
  lines.push("");
  lines.push(mdRow(["Call", "Requested", "Exact", "Target-2", "Target+2", "PC+2", "Nearest"]));
  lines.push(mdRow(["---", "---", "---", "---", "---", "---", "---"]));
  for (const profile of report.profiles) {
    lines.push(mdRow([
      profile.call,
      profile.requestedLabel,
      profile.exactTextAtTarget || "-",
      profile.minus2Text || "-",
      profile.plus2Text || "-",
      profile.pcPlus2DiagnosticText || "-",
      profile.nearestFullLabel || "-",
    ]));
  }
  lines.push("");
  lines.push("## Full-Coverage Strategy Details");
  for (const normalizer of report.normalizers.filter((item) => report.summary.fullCoverageStrategies.includes(item.id))) {
    lines.push("");
    lines.push(`### ${normalizer.id}`);
    for (const refModel of normalizer.refModels) {
      lines.push(`- ${refModel.id}: safe=${refModel.selectedSafeScripts.join(", ") || "-"}, risk=${refModel.selectedWritebackRiskScripts.join(", ") || "-"}, implausible=${refModel.selectedImplausibleScripts.join(", ") || "-"}, unmatched=${refModel.unmatchedScripts.join(", ") || "-"}`);
      for (const script of refModel.scripts.filter((item) => item.status !== "unmatched")) {
        lines.push(`  - ${script.name}: ${script.status} ${renderSelection(script)}`);
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
  const jsonFile = path.join(outDir, "xse_compare_normalization_probe.json");
  const mdFile = path.join(outDir, "xse_compare_normalization_probe.md");
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
