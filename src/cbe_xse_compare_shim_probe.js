const fs = require("fs");
const path = require("path");
const { DEFAULT_INPUT } = require("./cbe_unpack");
const { buildReport: buildEntrypointReport } = require("./cbe_xse_entrypoint_probe");

const ENTRY_COMPARE_JSON = path.resolve(__dirname, "out_godwar_xseentrycompare", "xse_entry_compare_probe.json");
const COMPARE_SERVICE_JSON = path.resolve(__dirname, "out_godwar_xsecomparesvc", "xse_compare_service_probe.json");
const LAYOUT_JSON = path.resolve(__dirname, "out_godwar_xselayout", "xse_layout_trace.json");
const DEFAULT_OUT = path.resolve(__dirname, "out_godwar_xsecompareshim");

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

const POINTER_MODELS = [
  {
    id: "exact-adr-text",
    description: "Use the string visible exactly at the ADR target pointer.",
    labels(profile) {
      const label = normalizeLabel(profile.exactTextAtTarget);
      return label ? [label] : [];
    },
  },
  {
    id: "nearby-full-label",
    description: "Normalize the ADR target to the nearest recovered full Init/_main label.",
    labels(profile) {
      const label = normalizeLabel(profile.requestedLabel);
      return label ? [label] : [];
    },
  },
];

const REF_MODELS = [
  {
    id: "all-strong",
    description: "Allow all absolute, pool-relative, text-relative, and group-relative length/payload transforms.",
    transforms: STRONG_TRANSFORMS,
  },
  {
    id: "payload-strong",
    description: "Allow only payload-position transforms, excluding length-byte offsets.",
    transforms: new Set(["absPayload", "symbolRelPayload", "textRelPayload", "groupRelPayload"]),
  },
  {
    id: "text-payload",
    description: "Allow only text-pool payload offsets, the least collision-prone current model.",
    transforms: new Set(["textRelPayload"]),
  },
];

const PRIMARY_MODEL_ID = "nearby-full-label/text-payload";

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
  if (!raw) return "";
  return raw.toUpperCase();
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean))).sort();
}

function symbolKind(slot) {
  const text = slot.leadingHit?.text || slot.visible || "";
  if (slot.leadingHit?.kind) return slot.leadingHit.kind;
  if (normalizeLabel(text) === "INIT" || normalizeLabel(text) === "_MAIN") return "label";
  return "slot";
}

function labelSlots(layoutScript, requestedLabels) {
  const wanted = new Set(requestedLabels.map(normalizeLabel));
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
  const values = [
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
  ];
  return values.filter(([, value]) => Number.isFinite(value) && value >= 0);
}

function matchEntryRef(entry, slots, starts, transforms = null) {
  if (!Number.isFinite(entry.ref)) return [];
  const matches = [];
  for (const slot of slots) {
    for (const [transform, value] of labelValues(slot, starts)) {
      if (transforms && !transforms.has(transform)) continue;
      if (value !== entry.ref) continue;
      matches.push({
        label: slot.text,
        transform,
        strength: STRONG_TRANSFORMS.has(transform) ? "strong" : "weak",
        lengthOffset: slot.lengthOffsetHex,
        payloadOffset: slot.payloadOffsetHex,
      });
    }
  }
  return matches;
}

function pointerLabelsByModel(profiles) {
  return Object.fromEntries(POINTER_MODELS.map((model) => [
    model.id,
    unique(profiles.flatMap((profile) => model.labels(profile))),
  ]));
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

function scanCandidate(candidate, model, slots, starts) {
  const labels = new Set(model.labels);
  const activeSlots = slots.filter((slot) => labels.has(slot.text));
  const matched = [];
  const weakCollisions = [];
  const entries = (candidate.entries || []).slice().sort((a, b) => a.index - b.index);
  for (const entry of entries) {
    const matches = matchEntryRef(entry, activeSlots, starts, model.transforms);
    if (!matches.length) continue;
    const strong = matches.filter((match) => match.strength === "strong");
    const summary = summarizeEntry(entry, matches);
    if (strong.length) {
      matched.push({ ...summary, matches: strong });
    } else {
      weakCollisions.push(summary);
    }
  }
  const selected = matched[0] || null;
  return {
    modes: candidate.modes || {},
    score: candidate.score ?? null,
    end: candidate.end || "",
    layoutDelta: candidate.layoutDelta ?? null,
    entryScanCoverage: candidate.entryScanCoverage || "unknown",
    entryCount: candidate.entryCount || 0,
    plausibleEntryCount: candidate.plausibleEntryCount || 0,
    safeEntryCount: candidate.safeEntryCount || 0,
    selected,
    selectedStatus: selectionStatus(selected),
    strongMatchCount: matched.length,
    weakCollisionCount: weakCollisions.length,
    matches: matched.slice(0, 8),
    weakCollisions: weakCollisions.slice(0, 8),
  };
}

function chooseBestSelection(scans) {
  return scans.find((scan) => scan.selected?.safeUnderTrace)
    || scans.find((scan) => scan.selected)
    || null;
}

function analyzeScript(script, layoutScript, modelLabels) {
  const starts = {
    group: parseHex(script.groupEnd),
    text: parseHex(layoutScript?.zones?.textAndResourcePool?.start),
    symbol: parseHex(layoutScript?.zones?.labelAndSymbolPool?.start),
  };
  const requestedLabels = unique(Object.values(modelLabels).flat());
  const slots = labelSlots(layoutScript, requestedLabels);
  const models = [];
  for (const pointerModel of POINTER_MODELS) {
    for (const refModel of REF_MODELS) {
      const labels = modelLabels[pointerModel.id] || [];
      const scans = (script.tailCandidates || []).map((candidate) => scanCandidate(candidate, {
        labels,
        transforms: refModel.transforms,
      }, slots, starts));
      const best = chooseBestSelection(scans);
      models.push({
        id: `${pointerModel.id}/${refModel.id}`,
        pointerModel: pointerModel.id,
        refModel: refModel.id,
        description: `${pointerModel.description} ${refModel.description}`,
        labels,
        transforms: Array.from(refModel.transforms),
        status: best?.selected
          ? `shim-${best.selected.riskKind}`
          : "shim-unmatched",
        bestSelection: best,
        candidateScans: scans,
      });
    }
  }
  const primary = models.find((model) => model.id === PRIMARY_MODEL_ID) || models[0] || null;
  return {
    name: script.name,
    executionMode: script.executionMode || "",
    starts: {
      groupEnd: hex(starts.group),
      textPool: hex(starts.text),
      symbolPool: hex(starts.symbol),
    },
    labels: slots.map((slot) => ({
      text: slot.text,
      lengthOffset: slot.lengthOffsetHex,
      payloadOffset: slot.payloadOffsetHex,
      values: Object.fromEntries(labelValues(slot, starts).map(([name, value]) => [name, value])),
    })),
    primaryStatus: primary?.status || "shim-unmatched",
    primarySelection: primary?.bestSelection || null,
    models,
  };
}

function buildReport(options = {}) {
  const input = path.resolve(options.input || DEFAULT_INPUT);
  const entrypoint = buildEntrypointReport({ input, includeAllEntries: true });
  const entryCompare = readJson(ENTRY_COMPARE_JSON);
  const compareService = readJson(COMPARE_SERVICE_JSON);
  const layout = readJson(LAYOUT_JSON);
  const profiles = entryCompare.callerLabelProfiles || [];
  const modelLabels = pointerLabelsByModel(profiles);
  const layoutByName = new Map((layout.scripts || []).map((script) => [script.name, script]));
  const scripts = (entrypoint.scripts || []).map((script) => analyzeScript(script, layoutByName.get(script.name), modelLabels));
  const primarySafe = scripts.filter((script) => script.primaryStatus === "shim-selected-safe");
  const primaryImplausible = scripts.filter((script) => script.primaryStatus === "shim-selected-implausible");
  const primaryRisk = scripts.filter((script) => script.primaryStatus === "shim-selected-writeback-risk" || script.primaryStatus === "shim-selected-no-run");
  const primaryUnsafe = scripts.filter((script) => script.primaryStatus !== "shim-selected-safe" && script.primaryStatus !== "shim-unmatched");
  const primaryUnmatched = scripts.filter((script) => script.primaryStatus === "shim-unmatched");
  const exactModel = scripts.map((script) => script.models.find((model) => model.id === "exact-adr-text/text-payload")).filter(Boolean);
  const exactSelected = exactModel.filter((model) => model.status !== "shim-unmatched");
  const allStrongModel = scripts.map((script) => ({
    name: script.name,
    model: script.models.find((model) => model.id === "nearby-full-label/all-strong"),
  })).filter((item) => item.model);
  const allStrongImplausible = allStrongModel.filter((item) => item.model.status === "shim-selected-implausible");
  return {
    schema: "nicai.cbe.xseCompareShimProbe.v1",
    generatedAt: new Date().toISOString(),
    input,
    inputs: {
      entryCompare: ENTRY_COMPARE_JSON,
      compareService: COMPARE_SERVICE_JSON,
      layout: LAYOUT_JSON,
      entrypoint: "cbe_xse_entrypoint_probe.buildReport({ includeAllEntries: true })",
    },
    argumentShape: {
      plus50Roles: compareService.summary?.plus50Roles || [],
      compareReturnsZeroOnMatch: Boolean(compareService.summary?.compareReturnsZeroOnMatch),
      modeledCompareShape: "r0=caller label pointer, r1=+0x64 record+0x10 ref; return 0 selects that record",
      streamReadShape: "r0=converted stream, r1=&cursor; same slot remains stream/cursor reader outside compare windows",
    },
    pointerModels: POINTER_MODELS.map((model) => ({
      id: model.id,
      description: model.description,
      labels: modelLabels[model.id] || [],
    })),
    refModels: REF_MODELS.map((model) => ({
      id: model.id,
      description: model.description,
      transforms: Array.from(model.transforms),
    })),
    summary: {
      status: primarySafe.length
        ? "compare-shim-partial"
        : primaryUnsafe.length
        ? "compare-shim-blocked"
        : "compare-shim-unresolved",
      scriptCount: scripts.length,
      primaryModel: PRIMARY_MODEL_ID,
      exactAdrSelectedCount: exactSelected.length,
      allStrongImplausibleScripts: allStrongImplausible.map((item) => item.name),
      selectedSafeScripts: primarySafe.map((script) => script.name),
      selectedImplausibleScripts: primaryImplausible.map((script) => script.name),
      selectedWritebackRiskScripts: primaryRisk.map((script) => script.name),
      selectedUnsafeScripts: primaryUnsafe.map((script) => script.name),
      unmatchedScripts: primaryUnmatched.map((script) => script.name),
      currentFinding: primarySafe.length
        ? `${primarySafe.length}/${scripts.length} focused scripts have a safe shape-aware +0x50 label selection under the ${PRIMARY_MODEL_ID} model.`
        : `${primaryRisk.length}/${scripts.length} focused scripts first-match writeback-risk records and ${primaryImplausible.length}/${scripts.length} first-match implausible records under the ${PRIMARY_MODEL_ID} model; ${primaryUnmatched.length}/${scripts.length} remain unmatched. The broader all-strong model first-matches implausible records in ${allStrongImplausible.length}/${scripts.length}; exact ADR-target text selects ${exactSelected.length}/${scripts.length}.`,
      emulatorImpact: "This is the first host-service compare shim for 0x12326, but it is still selection-only. Visible script effects stay disabled until selected records are safe and +0x5C/+0x60/writeback targets are bound.",
      nextTarget: "Bind the concrete compare/ref encoding for +0x64 record+0x10 and the 0x11A4A activation side effects, then promote only safe selected entries into the VM scheduler.",
    },
    callerLabelProfiles: profiles,
    scripts,
  };
}

function mdRow(cells) {
  return `| ${cells.map((cell) => String(cell ?? "").replace(/\|/g, "\\|")).join(" | ")} |`;
}

function renderSelection(selection) {
  if (!selection?.selected) return "-";
  const entry = selection.selected;
  const matches = entry.matches.map((match) => `${match.label}:${match.transform}@${match.lengthOffset}`).join(",");
  return `entry${entry.index} cursor=${entry.groupCursor} ref=${entry.ref} risk=${entry.riskKind || "unknown"} ${matches}`;
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# XSE Compare Shim Probe");
  lines.push("");
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Status: ${report.summary.status}`);
  lines.push(`- Finding: ${report.summary.currentFinding}`);
  lines.push(`- Emulator impact: ${report.summary.emulatorImpact}`);
  lines.push(`- Next target: ${report.summary.nextTarget}`);
  lines.push("");
  lines.push("## +0x50 Argument Shape");
  lines.push("");
  lines.push(`- Roles: ${report.argumentShape.plus50Roles.join("; ") || "-"}`);
  lines.push(`- Compare return: ${report.argumentShape.compareReturnsZeroOnMatch ? "0 means match" : "unknown"}`);
  lines.push(`- Compare shape: ${report.argumentShape.modeledCompareShape}`);
  lines.push(`- Stream shape: ${report.argumentShape.streamReadShape}`);
  lines.push("");
  lines.push("## Pointer Models");
  lines.push("");
  lines.push(mdRow(["Model", "Labels", "Description"]));
  lines.push(mdRow(["---", "---", "---"]));
  for (const model of report.pointerModels) {
    lines.push(mdRow([model.id, model.labels.join(", ") || "-", model.description]));
  }
  lines.push("");
  lines.push("## Ref Models");
  lines.push("");
  lines.push(mdRow(["Model", "Transforms", "Description"]));
  lines.push(mdRow(["---", "---", "---"]));
  for (const model of report.refModels || []) {
    lines.push(mdRow([model.id, model.transforms.join(", ") || "-", model.description]));
  }
  lines.push("");
  lines.push("## Primary Selection");
  lines.push("");
  lines.push(mdRow(["Script", "Status", "Labels", "Best selection"]));
  lines.push(mdRow(["---", "---", "---", "---"]));
  for (const script of report.scripts) {
    const primary = script.models.find((model) => model.id === report.summary.primaryModel);
    lines.push(mdRow([
      script.name,
      script.primaryStatus,
      script.labels.map((label) => `${label.text}@${label.lengthOffset}/${label.payloadOffset}`).join(", "),
      renderSelection(primary?.bestSelection),
    ]));
  }
  for (const script of report.scripts) {
    lines.push("");
    lines.push(`### ${script.name}`);
    lines.push(`- Starts: groupEnd=${script.starts.groupEnd}, textPool=${script.starts.textPool}, symbolPool=${script.starts.symbolPool}`);
    for (const model of script.models) {
      lines.push(`- ${model.id}: ${model.status}, labels=${model.labels.join(", ") || "-"}, best=${renderSelection(model.bestSelection)}`);
      for (const scan of model.candidateScans.filter((item) => item.selected || item.weakCollisionCount).slice(0, 4)) {
        lines.push(`  - 74=${scan.modes.ref74Mode || "-"},64=${scan.modes.ref64Mode || "-"} coverage=${scan.entryScanCoverage} strong=${scan.strongMatchCount} weak=${scan.weakCollisionCount} selected=${renderSelection(scan)}`);
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
  const jsonFile = path.join(outDir, "xse_compare_shim_probe.json");
  const mdFile = path.join(outDir, "xse_compare_shim_probe.md");
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
