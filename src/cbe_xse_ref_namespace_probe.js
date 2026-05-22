const fs = require("fs");
const path = require("path");
const { DEFAULT_INPUT } = require("./cbe_unpack");
const { buildReport: buildEntrypointReport } = require("./cbe_xse_entrypoint_probe");

const LABEL_POINTER_JSON = path.resolve(__dirname, "out_godwar_xselabelpointer", "xse_label_pointer_probe.json");
const COMPARE_SHIM_JSON = path.resolve(__dirname, "out_godwar_xsecompareshim", "xse_compare_shim_probe.json");
const REF_ENCODING_JSON = path.resolve(__dirname, "out_godwar_xserefencoding", "xse_ref_encoding_probe.json");
const ENTRY_SAFETY_JSON = path.resolve(__dirname, "out_godwar_xseentrysafety", "xse_entry_safety_probe.json");
const REF_WIDTH_SAFETY_JSON = path.resolve(__dirname, "out_godwar_xserefwidthsafety", "xse_ref_width_safety_probe.json");
const COMPARE_ABI_JSON = path.resolve(__dirname, "out_godwar_xsecompareabi", "xse_compare_abi_probe.json");
const PROVIDER_ABI_SHIM_JSON = path.resolve(__dirname, "out_godwar_providerabishim", "provider_abi_shim_probe.json");
const DEFAULT_OUT = path.resolve(__dirname, "out_godwar_xserefnamespace");

function readJson(file, fallback = null) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, "utf8"));
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

function rawRefPart(raw) {
  const parts = String(raw || "").split("|").map((part) => part.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

function rowKey(row) {
  return [
    row.script,
    row.model || "",
    row.modeKey || "",
    row.entry ?? row.index ?? "",
    row.ref ?? "",
    (row.matches || []).join(","),
  ].join("|");
}

function buildEntryLookup(entrypoint) {
  const result = new Map();
  for (const script of entrypoint.scripts || []) {
    for (const candidate of script.tailCandidates || []) {
      const keyPrefix = `${script.name}|${modeKey(candidate.modes)}`;
      for (const entry of candidate.entries || []) {
        result.set(`${keyPrefix}|${entry.index}`, {
          script: script.name,
          modes: candidate.modes || {},
          modeKey: modeKey(candidate.modes),
          candidateEnd: candidate.end || "",
          layoutDelta: candidate.layoutDelta ?? null,
          score: candidate.score ?? null,
          index: entry.index,
          offset: entry.offset || "",
          groupCursor: entry.groupCursor,
          kind: entry.kind,
          stackSpan: entry.stackSpan,
          ref: entry.ref,
          raw: entry.raw || "",
          refRaw: rawRefPart(entry.raw),
          plausible: entry.plausible !== false,
          writebackRiskCount: entry.run?.writebackRiskCount ?? null,
          writebackCount: entry.run?.writebackCount ?? null,
        });
      }
    }
  }
  return result;
}

function lookupEntry(lookup, script, candidateModeKey, index) {
  return lookup.get(`${script}|${candidateModeKey}|${index}`) || null;
}

function collectScalarCollisions(refWidthSafety, lookup, limit = 18) {
  const rows = [];
  const seen = new Set();
  for (const script of refWidthSafety?.scripts || []) {
    for (const model of script.models || []) {
      const samples = [
        ...(model.firstRows || []),
        ...(model.matchedRows || []),
      ];
      for (const row of samples) {
        const compact = {
          script: script.name,
          model: model.id,
          modeKey: row.modeKey || "",
          entry: row.entry,
          offset: row.offset || "",
          cursor: row.cursor,
          ref: row.ref,
          status: row.status || "",
          boundaryClean: Boolean(row.boundaryClean),
          region: row.region || "",
          layoutDelta: row.layoutDelta ?? null,
          matches: row.matches || [],
        };
        const key = rowKey(compact);
        if (seen.has(key)) continue;
        seen.add(key);
        const raw = lookupEntry(lookup, script.name, compact.modeKey, compact.entry);
        rows.push({
          ...compact,
          raw: raw?.raw || "",
          refRaw: raw?.refRaw || "",
          inferredOnly: true,
        });
      }
    }
  }
  rows.sort((a, b) => (
    Number(b.boundaryClean) - Number(a.boundaryClean)
    || Number(a.status !== "safe-under-trace") - Number(b.status !== "safe-under-trace")
    || Math.abs(a.layoutDelta ?? 9999) - Math.abs(b.layoutDelta ?? 9999)
    || String(a.script).localeCompare(String(b.script))
    || a.entry - b.entry
  ));
  return rows.slice(0, limit);
}

function collectPrimarySelections(compareShim, entrySafety, lookup) {
  const safetyByName = new Map((entrySafety?.primaryRows || []).map((row) => [row.script, row]));
  const rows = [];
  for (const script of compareShim?.scripts || []) {
    const selection = script.primarySelection;
    const selected = selection?.selected || null;
    if (!selected) {
      rows.push({
        script: script.name,
        selected: false,
        status: "unmatched",
        safetyStatus: safetyByName.get(script.name)?.status || "entry-unmatched",
      });
      continue;
    }
    const key = modeKey(selection.modes);
    const raw = lookupEntry(lookup, script.name, key, selected.index);
    rows.push({
      script: script.name,
      selected: true,
      modeKey: key,
      entry: selected.index,
      offset: selected.offset || raw?.offset || "",
      cursor: selected.groupCursor,
      ref: selected.ref,
      raw: raw?.raw || "",
      refRaw: raw?.refRaw || "",
      matches: (selected.matches || []).map((match) => `${match.label}:${match.transform}`),
      riskKind: selected.riskKind || "",
      safeUnderTrace: Boolean(selected.safeUnderTrace),
      safetyStatus: safetyByName.get(script.name)?.status || "",
      safetyReason: safetyByName.get(script.name)?.reason || "",
    });
  }
  return rows;
}

function compactPointerProfiles(labelPointer) {
  return (labelPointer?.pointerProfiles || []).map((profile) => ({
    call: profile.call || "",
    helper: profile.helper || "",
    helperRole: profile.helperRole || "",
    requestedLabel: normalizeLabel(profile.requestedLabel),
    target: profile.target || "",
    exactTextAtTarget: profile.exactTextAtTarget || "",
    nearestFullLabel: normalizeLabel(profile.nearestFullLabel),
    pointerDeltaToFullLabel: profile.pointerDeltaToFullLabel ?? null,
    classification: profile.classification || "",
    pcPlus2DiagnosticText: profile.adr?.pcPlus2DiagnosticText || "",
    pcPlus2DeltaToFullLabel: profile.adr?.pcPlus2DeltaToFullLabel ?? null,
    alignmentClass: profile.adr?.alignmentClass || "",
  }));
}

function scriptMatrix(refEncoding, refWidthSafety, entrySafety) {
  const byWidth = new Map((refWidthSafety?.scripts || []).map((script) => [script.name, script]));
  const bySafety = new Map((entrySafety?.primaryRows || []).map((row) => [row.script, row]));
  const names = unique([
    ...(refEncoding?.scripts || []).map((script) => script.name),
    ...(refWidthSafety?.scripts || []).map((script) => script.name),
    ...(entrySafety?.primaryRows || []).map((row) => row.script),
  ]);
  return names.map((name) => {
    const enc = (refEncoding?.scripts || []).find((script) => script.name === name) || {};
    const width = byWidth.get(name) || {};
    const safety = bySafety.get(name) || {};
    return {
      script: name,
      refEncodingStatus: enc.status || "",
      topMode: enc.topMode || "",
      topRef64Mode: enc.topRef64Mode || "",
      requestedCandidateCount: enc.requestedCandidateCount || 0,
      safeRequestedCandidateCount: enc.safeRequestedCandidateCount || 0,
      refWidthStatus: width.status || "",
      refWidthMatchCount: (width.models || []).reduce((sum, model) => sum + (model.matchCount || 0), 0),
      refWidthSafeCount: (width.models || []).reduce((sum, model) => sum + (model.safeMatchCount || 0), 0),
      entrySafetyStatus: safety.status || "entry-unmatched",
      selected: safety.selected || null,
    };
  });
}

function buildNamespaceModels({ compareAbi, labelPointer, compareShim, refWidthSafety }) {
  const exactAdrSelected = compareShim?.summary?.exactAdrSelectedCount || 0;
  const exactFull = labelPointer?.summary?.exactFullLabelCount || 0;
  const profileCount = labelPointer?.summary?.profileCount || 0;
  const firstSafe = refWidthSafety?.summary?.firstSafeMatchCount || 0;
  const safe = refWidthSafety?.summary?.safeMatchCount || 0;
  const unsafe = refWidthSafety?.summary?.unsafeMatchCount || 0;
  const compareDocumented = Boolean(
    compareAbi?.summary?.status === "compare-abi-branch-documented"
    && compareAbi?.summary?.labelRefCompareCount > 0
    && compareAbi?.summary?.compareReturnsZeroOnMatch
  );
  return [
    {
      id: "direct-c-string",
      status: exactAdrSelected > 0 ? "has-diagnostic-hit" : "rejected-for-scheduling",
      evidence: `exact ADR text selects ${exactAdrSelected}/${compareShim?.summary?.scriptCount || 0} focused script(s); exact full label pointers ${exactFull}/${profileCount}`,
      emulatorRule: "do not compare caller ADR target bytes as plain C strings",
    },
    {
      id: "scalar-symbol-offset",
      status: safe > 0 ? "has-safe-diagnostic-hit" : (unsafe > 0 ? "rejected-for-scheduling" : "unmatched"),
      evidence: `width grid first-safe=${firstSafe}, safe-total=${safe}, unsafe-or-implausible=${unsafe}`,
      emulatorRule: "do not treat record+0x10 as a promoted scalar string-pool offset",
    },
    {
      id: "provider-opaque-ref",
      status: compareDocumented ? "required-but-unbound" : "compare-abi-incomplete",
      evidence: `+0x50 compare windows=${compareAbi?.summary?.labelRefCompareCount || 0}, return0=${compareAbi?.summary?.compareReturnsZeroOnMatch ? "yes" : "no"}`,
      emulatorRule: "route label/ref compare through the provider reader service; without a resolver, return non-match and keep effects disabled",
    },
  ];
}

function buildReport(options = {}) {
  const input = path.resolve(options.input || DEFAULT_INPUT);
  const entrypoint = buildEntrypointReport({ input, includeAllEntries: true, candidateLimit: 100 });
  const lookup = buildEntryLookup(entrypoint);
  const labelPointer = readJson(LABEL_POINTER_JSON, {});
  const compareShim = readJson(COMPARE_SHIM_JSON, {});
  const refEncoding = readJson(REF_ENCODING_JSON, {});
  const entrySafety = readJson(ENTRY_SAFETY_JSON, {});
  const refWidthSafety = readJson(REF_WIDTH_SAFETY_JSON, {});
  const compareAbi = readJson(COMPARE_ABI_JSON, {});
  const providerShim = readJson(PROVIDER_ABI_SHIM_JSON, {});
  const namespaceModels = buildNamespaceModels({ compareAbi, labelPointer, compareShim, refWidthSafety });
  const scalarRows = collectScalarCollisions(refWidthSafety, lookup);
  const primarySelections = collectPrimarySelections(compareShim, entrySafety, lookup);
  const pointerProfiles = compactPointerProfiles(labelPointer);
  const compareDocumented = namespaceModels.find((model) => model.id === "provider-opaque-ref")?.status === "required-but-unbound";
  const scalarSafe = refWidthSafety?.summary?.safeMatchCount || 0;
  const firstSafe = refWidthSafety?.summary?.firstSafeMatchCount || 0;
  const exactAdrSelected = compareShim?.summary?.exactAdrSelectedCount || 0;
  const promotable = entrySafety?.summary?.promotablePrimaryCount || 0;
  const status = compareDocumented && scalarSafe === 0 && exactAdrSelected === 0
    ? "ref-namespace-provider-opaque-unbound"
    : promotable > 0
    ? "ref-namespace-has-promotable-entry"
    : "ref-namespace-unresolved";

  return {
    schema: "nicai.cbe.xseRefNamespaceProbe.v1",
    generatedAt: new Date().toISOString(),
    input,
    inputs: {
      entrypoint: "cbe_xse_entrypoint_probe.buildReport({ includeAllEntries: true, candidateLimit: 100 })",
      labelPointer: LABEL_POINTER_JSON,
      compareShim: COMPARE_SHIM_JSON,
      refEncoding: REF_ENCODING_JSON,
      entrySafety: ENTRY_SAFETY_JSON,
      refWidthSafety: REF_WIDTH_SAFETY_JSON,
      compareAbi: COMPARE_ABI_JSON,
      providerAbiShim: PROVIDER_ABI_SHIM_JSON,
    },
    hostCompareOracle: {
      service: "[sb+0x35C4]",
      compareMethod: "+0x50",
      refReaderMethod: "+0x64",
      compareShape: "r0=caller label pointer, r1=script+0x64 record+0x10",
      unboundReturn: "non-match",
      resolverStatus: "ref-namespace-unbound",
      requiredResolver: "map provider +0x64 entry refs to normalized caller labels before 0x12326 can select a runtime entry",
      shimPlus50Documentation: providerShim.serviceObjects?.readerService?.methods?.["+0x50"] || "",
      shimPlus64Documentation: providerShim.serviceObjects?.readerService?.methods?.["+0x64"] || "",
    },
    summary: {
      status,
      scriptCount: entrypoint.scripts?.length || 0,
      compareBranchDocumented: compareDocumented,
      labelRefCompareCount: compareAbi?.summary?.labelRefCompareCount || 0,
      compareReturnsZeroOnMatch: Boolean(compareAbi?.summary?.compareReturnsZeroOnMatch),
      exactAdrSelectedCount: exactAdrSelected,
      callerPointerProfileCount: labelPointer?.summary?.profileCount || 0,
      suffixPointerCount: labelPointer?.summary?.suffixPointerCount || 0,
      scalarFirstSafeMatchCount: firstSafe,
      scalarSafeMatchCount: scalarSafe,
      unsafeScalarCollisionCount: refWidthSafety?.summary?.unsafeMatchCount || 0,
      entryPromotableCount: promotable,
      primarySelectedCount: entrySafety?.summary?.primarySelectedCount || 0,
      resolverBound: false,
      visibleEffectsEnabled: false,
      currentFinding: `The 0x12326 entry selector must compare caller labels through provider [35C4]+0x50 against record+0x10 refs. Exact ADR strings select ${exactAdrSelected}/${compareShim?.summary?.scriptCount || 0} focused scripts, the scalar width grid has ${firstSafe} first-safe and ${scalarSafe} safe requested-label match(es), and ${refWidthSafety?.summary?.unsafeMatchCount || 0} scalar collisions remain unsafe or implausible. Treat record+0x10 as a provider-opaque ref namespace until a resolver is recovered.`,
      emulatorImpact: "The generic web emulator should not schedule XSE entries from guessed string offsets. Its host-provider shim should return non-match for label/ref compares until +0x64 refs can be resolved, leaving visible script effects disabled.",
      nextTarget: "Instrument or derive the provider +0x64 ref namespace: capture the real refs read into script+0x64 record+0x10, bind them to normalized Init/_main caller labels through [35C4]+0x50, then re-run entry safety.",
      compareAbiFinding: compareAbi?.summary?.currentFinding || "",
      refWidthFinding: refWidthSafety?.summary?.currentFinding || "",
      entrySafetyFinding: entrySafety?.summary?.currentFinding || "",
    },
    namespaceModels,
    pointerProfiles,
    primarySelections,
    scalarCollisionSamples: scalarRows,
    scripts: scriptMatrix(refEncoding, refWidthSafety, entrySafety),
  };
}

function mdRow(cells) {
  return `| ${cells.map((cell) => String(cell ?? "").replace(/\|/g, "\\|")).join(" | ")} |`;
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# XSE Ref Namespace Probe");
  lines.push("");
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Input CBE: \`${report.input}\``);
  lines.push(`- Status: ${report.summary.status}`);
  lines.push(`- Finding: ${report.summary.currentFinding}`);
  lines.push(`- Emulator impact: ${report.summary.emulatorImpact}`);
  lines.push(`- Next target: ${report.summary.nextTarget}`);
  lines.push("");
  lines.push("## Host Compare Oracle");
  lines.push("");
  lines.push(`- Service: ${report.hostCompareOracle.service}`);
  lines.push(`- Compare: ${report.hostCompareOracle.compareMethod} with ${report.hostCompareOracle.compareShape}`);
  lines.push(`- Ref reader: ${report.hostCompareOracle.refReaderMethod}`);
  lines.push(`- Resolver status: ${report.hostCompareOracle.resolverStatus}; unbound compare returns ${report.hostCompareOracle.unboundReturn}.`);
  lines.push("");
  lines.push("## Namespace Models");
  lines.push("");
  lines.push(mdRow(["Model", "Status", "Evidence", "Emulator rule"]));
  lines.push(mdRow(["---", "---", "---", "---"]));
  for (const model of report.namespaceModels) {
    lines.push(mdRow([model.id, model.status, model.evidence, model.emulatorRule]));
  }
  lines.push("");
  lines.push("## Script Matrix");
  lines.push("");
  lines.push(mdRow(["Script", "Ref encoding", "Top mode", "Requested", "Width safe", "Entry safety"]));
  lines.push(mdRow(["---", "---", "---", "---:", "---:", "---"]));
  for (const script of report.scripts) {
    lines.push(mdRow([
      script.script,
      script.refEncodingStatus || "-",
      script.topMode || "-",
      `${script.safeRequestedCandidateCount}/${script.requestedCandidateCount}`,
      `${script.refWidthSafeCount}/${script.refWidthMatchCount}`,
      script.entrySafetyStatus || "-",
    ]));
  }
  lines.push("");
  lines.push("## Primary Compare Selections");
  lines.push("");
  lines.push(mdRow(["Script", "Selection", "Raw ref guess", "Matches", "Safety"]));
  lines.push(mdRow(["---", "---", "---", "---", "---"]));
  for (const row of report.primarySelections) {
    lines.push(mdRow([
      row.script,
      row.selected ? `${row.modeKey} entry${row.entry} cursor=${row.cursor} ref=${row.ref}` : "unmatched",
      row.refRaw || "-",
      (row.matches || []).join(",") || "-",
      row.safetyStatus || row.status || "-",
    ]));
  }
  lines.push("");
  lines.push("## Caller Pointers");
  lines.push("");
  lines.push(mdRow(["Call", "Helper", "Requested", "Exact text", "Full label", "Delta", "Class"]));
  lines.push(mdRow(["---", "---", "---", "---", "---", "---:", "---"]));
  for (const profile of report.pointerProfiles) {
    lines.push(mdRow([
      profile.call,
      profile.helper,
      profile.requestedLabel,
      profile.exactTextAtTarget || "-",
      profile.nearestFullLabel || "-",
      profile.pointerDeltaToFullLabel ?? "-",
      profile.classification,
    ]));
  }
  lines.push("");
  lines.push("## Scalar Collision Samples");
  lines.push("");
  lines.push(mdRow(["Script", "Model", "Entry", "Cursor", "Ref", "Raw", "Status", "Matches"]));
  lines.push(mdRow(["---", "---", "---", "---:", "---:", "---", "---", "---"]));
  for (const row of report.scalarCollisionSamples) {
    lines.push(mdRow([
      row.script,
      row.model,
      `${row.modeKey} entry${row.entry}`,
      row.cursor,
      row.ref,
      row.refRaw || row.raw || "-",
      row.status,
      (row.matches || []).join(",") || "-",
    ]));
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
  const jsonFile = path.join(outDir, "xse_ref_namespace_probe.json");
  const mdFile = path.join(outDir, "xse_ref_namespace_probe.md");
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
