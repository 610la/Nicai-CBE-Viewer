const fs = require("fs");
const path = require("path");
const { DEFAULT_INPUT, fixupPayload, loadCbeArchive } = require("./cbe_unpack");
const { decodeCompactToken, hexBytes } = require("./cbe_struct");
const { buildReport: buildEntrypointReport } = require("./cbe_xse_entrypoint_probe");

const LAYOUT_JSON = path.resolve(__dirname, "out_godwar_xselayout", "xse_layout_trace.json");
const COMPARE_SHIM_JSON = path.resolve(__dirname, "out_godwar_xsecompareshim", "xse_compare_shim_probe.json");
const REF_NAMESPACE_JSON = path.resolve(__dirname, "out_godwar_xserefnamespace", "xse_ref_namespace_probe.json");
const DEFAULT_OUT = path.resolve(__dirname, "out_godwar_xseref64loader");

const REF_MODES = ["compact", "raw1", "raw2le", "raw2be", "raw3le", "raw3be", "raw4le", "raw4be", "fixed5", "fixed8"];

const LOADER_ABI = {
  rangeTable: {
    countSite: "0x00011672",
    allocation: "count * 0x14 bytes stored at script+0x64; count stored at script+0x68",
    loop: "0x000116B6..0x0001173E",
    fields: [
      { field: "+0x00", source: "[sb+0x35C4]+0x50", store: "0x000116D6", role: "entry cursor/group selector" },
      { field: "+0x04", source: "raw byte from converted stream", store: "0x000116EA", role: "kind / lower bound" },
      { field: "+0x08", source: "[sb+0x35C4]+0x50", store: "0x0001170A", role: "span / stack delta seed" },
      { field: "+0x0C", source: "field+0x04 + field+0x08 + 1", store: "0x0001171C", role: "derived inclusive end; not read from stream" },
      { field: "+0x10", source: "[sb+0x35C4]+0x64", store: "0x0001173C", role: "provider ref later compared by 0x12326" },
    ],
  },
  finalRefs: {
    countSite: "0x00011752",
    allocation: "count * 4 bytes stored at script+0x6C; count stored at script+0x70",
    refReadSite: "0x00011792",
    store: "0x000117AE",
    source: "[sb+0x35C4]+0x64",
  },
};

function readJson(file, fallback = null) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function hex(n, width = 4) {
  if (!Number.isFinite(n) || n < 0) return "";
  return `0x${n.toString(16).toUpperCase().padStart(width, "0")}`;
}

function byteHex(value) {
  return hex(value, 2);
}

function parseHex(text) {
  return typeof text === "string" && /^0x/i.test(text) ? parseInt(text, 16) : NaN;
}

function normalizeName(name) {
  return path.basename(String(name || "").replace(/\\/g, "/")).replace(/^[0-9]{4}_/, "").toLowerCase();
}

function findEntry(archive, name) {
  const target = normalizeName(name);
  return archive.entries.find((entry) => normalizeName(entry.name) === target) || null;
}

function readResource(archive, entry) {
  return fixupPayload(entry.name, archive.rawPayload(entry)).payload;
}

function compactAt(buf, cursor, label, limit = 0x7fffffff) {
  const start = cursor.value;
  const token = decodeCompactToken(buf, start);
  if (!token || token.truncated || Math.abs(token.value) > limit) {
    throw new Error(`${label} compact read failed at ${hex(start)}`);
  }
  cursor.value = token.next;
  return {
    label,
    offset: start,
    offsetHex: hex(start),
    next: token.next,
    nextHex: hex(token.next),
    width: token.next - start,
    value: token.value,
    raw: token.raw,
    tag: token.tag,
  };
}

function raw8At(buf, cursor, label) {
  const start = cursor.value;
  if (start >= buf.length) throw new Error(`${label} raw8 read failed at ${hex(start)}`);
  cursor.value += 1;
  return {
    label,
    offset: start,
    offsetHex: hex(start),
    next: cursor.value,
    nextHex: hex(cursor.value),
    width: 1,
    value: buf[start],
    raw: byteHex(buf[start]),
    tag: "raw8",
  };
}

function refModeByteCount(mode) {
  if (mode === "compact") return 0;
  const fixed = String(mode || "").match(/^fixed(\d+)$/);
  if (fixed) return Number(fixed[1]);
  return ({ raw1: 1, raw2le: 2, raw2be: 2, raw3le: 3, raw3be: 3, raw4le: 4, raw4be: 4 }[mode] || 0);
}

function readRefMode(buf, cursor, mode, label) {
  if (mode === "compact") return compactAt(buf, cursor, label);
  const width = refModeByteCount(mode);
  const start = cursor.value;
  if (!width || start + width > buf.length) throw new Error(`${label} ${mode} failed at ${hex(start)}`);
  let value = null;
  if (mode === "raw1") value = buf[start];
  else if (mode === "raw2le") value = buf.readUInt16LE(start);
  else if (mode === "raw2be") value = buf.readUInt16BE(start);
  else if (mode === "raw3le") value = buf.readUIntLE(start, 3);
  else if (mode === "raw3be") value = buf.readUIntBE(start, 3);
  else if (mode === "raw4le") value = buf.readUInt32LE(start);
  else if (mode === "raw4be") value = buf.readUInt32BE(start);
  cursor.value += width;
  return {
    label,
    offset: start,
    offsetHex: hex(start),
    next: cursor.value,
    nextHex: hex(cursor.value),
    width,
    value,
    raw: hexBytes(buf.subarray(start, start + width)),
    tag: mode,
  };
}

function printableAscii(buf) {
  return Array.from(buf).every((value) => value >= 0x20 && value <= 0x7e);
}

function classifyLengthPrefixedText(buf, offset, layoutScript) {
  if (!Number.isFinite(offset) || offset < 0 || offset >= buf.length) {
    return { status: "out-of-range", textLike: false };
  }
  const length = buf[offset];
  const start = offset + 1;
  const end = start + length;
  const textStart = parseHex(layoutScript?.zones?.textAndResourcePool?.start);
  const symbolStart = parseHex(layoutScript?.zones?.labelAndSymbolPool?.start);
  const crossesTextPool = Number.isFinite(textStart) && end > textStart;
  const crossesSymbolPool = Number.isFinite(symbolStart) && end > symbolStart;
  if (length === 0) {
    return { status: "zero-length", textLike: false, length, end: hex(end), crossesTextPool, crossesSymbolPool };
  }
  if (length > 64) {
    return { status: "length-too-large-for-inline-text", textLike: false, length, end: hex(end), crossesTextPool, crossesSymbolPool };
  }
  if (end > buf.length) {
    return { status: "truncated-length-text", textLike: false, length, end: hex(end), crossesTextPool, crossesSymbolPool };
  }
  const bytes = buf.subarray(start, end);
  const text = bytes.toString("ascii");
  const ascii = printableAscii(bytes);
  const meaningful = /[A-Za-z_][A-Za-z0-9_./-]*/.test(text);
  return {
    status: ascii && meaningful ? "length-prefixed-ascii" : (ascii ? "ascii-but-not-symbolic" : "non-ascii-body"),
    textLike: Boolean(ascii && meaningful),
    length,
    text: ascii ? text : "",
    end: hex(end),
    rawBody: hexBytes(bytes.subarray(0, 24)),
    crossesTextPool,
    crossesSymbolPool,
  };
}

function classifyRefContext(buf, offset, layoutScript) {
  const compact = decodeCompactToken(buf, offset);
  return {
    offset: hex(offset),
    firstByte: offset < buf.length ? byteHex(buf[offset]) : "",
    nextBytes: hexBytes(buf.subarray(offset, Math.min(buf.length, offset + 12))),
    compact: compact ? {
      tag: compact.tag,
      value: compact.value,
      raw: compact.raw,
      next: hex(compact.next),
    } : null,
    lengthText: classifyLengthPrefixedText(buf, offset, layoutScript),
  };
}

function parseTailWithOffsets(buf, startOffset, modes, layoutScript) {
  const cursor = { value: startOffset };
  const warnings = [];
  const entries = [];
  const finalRefs = [];
  let ok = true;
  let backfillCount = 0;
  let entryCount = 0;
  let finalRefCount = 0;

  try {
    backfillCount = compactAt(buf, cursor, "0x115B8 opcode2 backfill +0x74 refs count", 256).value;
    for (let index = 0; index < backfillCount; index += 1) {
      readRefMode(buf, cursor, modes.ref74Mode, `0x115B8 opcode2 backfill +0x74 refs[${index}]`);
    }

    entryCount = compactAt(buf, cursor, "0x11672 script+0x64 range count", 256).value;
    for (let index = 0; index < entryCount; index += 1) {
      const field00 = compactAt(buf, cursor, "range+00 group cursor");
      const field04 = raw8At(buf, cursor, "range+04 raw/kind");
      const field08 = compactAt(buf, cursor, "range+08 stack span");
      const refCursorBefore = cursor.value;
      const field10 = readRefMode(buf, cursor, modes.ref64Mode, "range+10 provider ref");
      entries.push({
        index,
        recordStride: 0x14,
        offset: field00.offsetHex,
        groupCursor: field00.value,
        kind: field04.value,
        stackSpan: field08.value,
        derivedEnd: field04.value + field08.value + 1,
        fields: {
          field00: { offset: field00.offsetHex, raw: field00.raw, value: field00.value, source: "+0x50" },
          field04: { offset: field04.offsetHex, raw: field04.raw, value: field04.value, source: "raw8" },
          field08: { offset: field08.offsetHex, raw: field08.raw, value: field08.value, source: "+0x50" },
          field0C: { raw: "", value: field04.value + field08.value + 1, source: "derived field04+field08+1" },
          field10: { offset: field10.offsetHex, raw: field10.raw, value: field10.value, source: "+0x64", mode: modes.ref64Mode },
        },
        refOffset: hex(refCursorBefore),
        refRaw: field10.raw,
        refValue: field10.value,
        refContext: classifyRefContext(buf, refCursorBefore, layoutScript),
      });
    }

    finalRefCount = compactAt(buf, cursor, "0x11752 final +0x64 refs count", 256).value;
    for (let index = 0; index < finalRefCount; index += 1) {
      const refCursorBefore = cursor.value;
      const ref = readRefMode(buf, cursor, modes.ref64Mode, `0x11752 final +0x64 refs[${index}]`);
      finalRefs.push({
        index,
        offset: hex(refCursorBefore),
        raw: ref.raw,
        value: ref.value,
        mode: modes.ref64Mode,
        context: classifyRefContext(buf, refCursorBefore, layoutScript),
      });
    }
  } catch (err) {
    ok = false;
    warnings.push(err.message || String(err));
  }

  return {
    modes,
    ok,
    start: hex(startOffset),
    end: hex(cursor.value),
    consumed: cursor.value - startOffset,
    backfillCount,
    entryCount,
    finalRefCount,
    entries,
    finalRefs,
    warnings,
  };
}

function candidateKey(candidate) {
  return `74=${candidate?.modes?.ref74Mode || "-"},64=${candidate?.modes?.ref64Mode || "-"}`;
}

function uniqueCandidates(candidates) {
  const seen = new Set();
  const out = [];
  for (const candidate of candidates.filter(Boolean)) {
    const key = candidateKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}

function primaryModeForScript(compareShim, name) {
  const script = (compareShim?.scripts || []).find((row) => row.name === name);
  return script?.primarySelection || null;
}

function primaryRefNamespaceForScript(refNamespace, name) {
  return (refNamespace?.primarySelections || []).find((row) => row.script === name) || null;
}

function textLikeCount(entries) {
  return entries.filter((entry) => entry.refContext?.lengthText?.textLike).length;
}

function summarizeEntries(entries, primaryRow) {
  const wantedIndex = primaryRow?.selected ? primaryRow.entry : null;
  const selected = Number.isInteger(wantedIndex)
    ? entries.find((entry) => entry.index === wantedIndex)
    : null;
  const textLike = entries.filter((entry) => entry.refContext?.lengthText?.textLike).slice(0, 4);
  const first = entries.slice(0, 6);
  const samples = selected
    ? [selected, ...first.filter((entry) => entry.index !== selected.index)]
    : first;
  return {
    selectedEntry: selected ? compactEntry(selected) : null,
    textLikeEntries: textLike.map(compactEntry),
    firstEntries: samples.slice(0, 8).map(compactEntry),
  };
}

function compactEntry(entry) {
  return {
    index: entry.index,
    offset: entry.offset,
    cursor: entry.groupCursor,
    kind: entry.kind,
    span: entry.stackSpan,
    derivedEnd: entry.derivedEnd,
    refOffset: entry.refOffset,
    refRaw: entry.refRaw,
    refValue: entry.refValue,
    refFirstByte: entry.refContext?.firstByte || "",
    compactValue: entry.refContext?.compact?.value ?? null,
    lengthTextStatus: entry.refContext?.lengthText?.status || "",
    lengthText: entry.refContext?.lengthText?.text || "",
  };
}

function analyzeScript({ script, layoutScript, archive, compareShim, refNamespace }) {
  const entry = findEntry(archive, script.name);
  const primaryMode = primaryModeForScript(compareShim, script.name);
  const primaryRow = primaryRefNamespaceForScript(refNamespace, script.name);
  if (!entry) {
    return { name: script.name, status: "missing-resource", candidates: [] };
  }
  const buf = readResource(archive, entry);
  const groupEnd = parseHex(script.groupEnd);
  const selectedCandidate = primaryMode?.modes
    ? { modes: primaryMode.modes, score: primaryMode.score ?? null, end: primaryMode.end || "", layoutDelta: primaryMode.layoutDelta ?? null, role: "primary-compare-selection" }
    : null;
  const candidates = uniqueCandidates([
    selectedCandidate,
    ...(script.tailCandidates || []).slice(0, 3).map((candidate, index) => ({ ...candidate, role: index === 0 ? "top-score" : "alternate-top" })),
  ]).map((candidate) => {
    const parsed = parseTailWithOffsets(buf, groupEnd, candidate.modes, layoutScript);
    const entryTextLikeCount = textLikeCount(parsed.entries);
    const finalTextLikeCount = parsed.finalRefs.filter((ref) => ref.context?.lengthText?.textLike).length;
    return {
      role: candidate.role || "candidate",
      modeKey: candidateKey(candidate),
      candidateEnd: candidate.end || "",
      candidateLayoutDelta: candidate.layoutDelta ?? null,
      candidateScore: candidate.score ?? null,
      ok: parsed.ok,
      start: parsed.start,
      end: parsed.end,
      consumed: parsed.consumed,
      backfillCount: parsed.backfillCount,
      entryCount: parsed.entryCount,
      finalRefCount: parsed.finalRefCount,
      entryRefTextLikeCount: entryTextLikeCount,
      finalRefTextLikeCount: finalTextLikeCount,
      warnings: parsed.warnings,
      samples: summarizeEntries(parsed.entries, primaryRow),
      finalRefSamples: parsed.finalRefs.slice(0, 6).map((ref) => ({
        index: ref.index,
        offset: ref.offset,
        raw: ref.raw,
        value: ref.value,
        firstByte: ref.context?.firstByte || "",
        lengthTextStatus: ref.context?.lengthText?.status || "",
        lengthText: ref.context?.lengthText?.text || "",
      })),
    };
  });
  const top = candidates[0] || null;
  let status = "ref64-loader-unparsed";
  if (top?.samples?.selectedEntry && top.samples.selectedEntry.lengthTextStatus !== "length-prefixed-ascii") {
    status = "ref64-selected-entry-not-inline-text";
  } else if (top && top.entryRefTextLikeCount === 0 && top.finalRefTextLikeCount === 0) {
    status = "ref64-no-inline-text-refs";
  } else if (top) {
    status = "ref64-has-inline-text-diagnostics";
  }
  return {
    name: script.name,
    status,
    groupEnd: script.groupEnd,
    layoutTextPool: layoutScript?.zones?.textAndResourcePool?.start || "",
    layoutSymbolPool: layoutScript?.zones?.labelAndSymbolPool?.start || "",
    primarySelection: primaryRow || null,
    candidates,
  };
}

function buildReport(options = {}) {
  const input = path.resolve(options.input || DEFAULT_INPUT);
  const archive = loadCbeArchive(input);
  const entrypoint = buildEntrypointReport({ input, includeAllEntries: true, candidateLimit: 100 });
  const layout = readJson(LAYOUT_JSON, {});
  const compareShim = readJson(COMPARE_SHIM_JSON, {});
  const refNamespace = readJson(REF_NAMESPACE_JSON, {});
  const layoutByName = new Map((layout.scripts || []).map((script) => [script.name, script]));
  const scripts = (entrypoint.scripts || []).map((script) => analyzeScript({
    script,
    layoutScript: layoutByName.get(script.name) || null,
    archive,
    compareShim,
    refNamespace,
  }));
  const topCandidates = scripts.map((script) => script.candidates?.[0]).filter(Boolean);
  const selected = scripts.map((script) => script.candidates?.[0]?.samples?.selectedEntry).filter(Boolean);
  const selectedInlineText = selected.filter((entry) => entry.lengthTextStatus === "length-prefixed-ascii");
  const inlineTextCandidateCount = topCandidates.filter((candidate) => (
    (candidate.entryRefTextLikeCount || 0) + (candidate.finalRefTextLikeCount || 0) > 0
  )).length;
  const status = selectedInlineText.length
    ? "ref64-loader-selected-inline-text"
    : inlineTextCandidateCount
    ? "ref64-loader-inline-text-diagnostics-only"
    : "ref64-loader-provider-opaque";
  return {
    schema: "nicai.cbe.xseRef64LoaderProbe.v1",
    generatedAt: new Date().toISOString(),
    input,
    inputs: {
      entrypoint: "cbe_xse_entrypoint_probe.buildReport({ includeAllEntries: true, candidateLimit: 100 })",
      layout: LAYOUT_JSON,
      compareShim: COMPARE_SHIM_JSON,
      refNamespace: REF_NAMESPACE_JSON,
    },
    loaderAbi: LOADER_ABI,
    summary: {
      status,
      scriptCount: scripts.length,
      rangeRefCallSite: LOADER_ABI.rangeTable.fields.find((field) => field.field === "+0x10")?.store || "",
      finalRefCallSite: LOADER_ABI.finalRefs.refReadSite,
      derivedField0C: true,
      selectedEntryCount: selected.length,
      selectedInlineTextCount: selectedInlineText.length,
      inlineTextDiagnosticScriptCount: inlineTextCandidateCount,
      currentFinding: `The 0x11672 range loader writes a 0x14-byte table and stores [35C4]+0x64 return values at record+0x10 after deriving record+0x0C from field04+field08+1. Under the current compare/ref candidates, ${selectedInlineText.length}/${selected.length || 0} selected compare entries decode as inline length-prefixed text, so record+0x10 remains a provider ref rather than a SCE-style text string.`,
      emulatorImpact: "A generic emulator should model XSE range refs as host-service return values stored in the script record table. The SCE length-prefixed text reader cannot be reused for XSE entry refs unless the +0x64 call context proves it.",
      nextTarget: "Trace or emulate the provider +0x64 method by call context: resource-name refs for SCE and provider-opaque entry refs for XSE range/final-ref tables, then bind those opaque refs to [35C4]+0x50 label/ref compare.",
      refNamespaceFinding: refNamespace?.summary?.currentFinding || "",
    },
    scripts,
  };
}

function mdRow(cells) {
  return `| ${cells.map((cell) => String(cell ?? "").replace(/\|/g, "\\|")).join(" | ")} |`;
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# XSE +0x64 Loader Probe");
  lines.push("");
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Input CBE: \`${report.input}\``);
  lines.push(`- Status: ${report.summary.status}`);
  lines.push(`- Finding: ${report.summary.currentFinding}`);
  lines.push(`- Emulator impact: ${report.summary.emulatorImpact}`);
  lines.push(`- Next target: ${report.summary.nextTarget}`);
  if (report.summary.refNamespaceFinding) lines.push(`- Ref namespace context: ${report.summary.refNamespaceFinding}`);
  lines.push("");
  lines.push("## Loader ABI");
  lines.push("");
  lines.push(`- Range count: ${report.loaderAbi.rangeTable.countSite}; ${report.loaderAbi.rangeTable.allocation}.`);
  lines.push(`- Range loop: ${report.loaderAbi.rangeTable.loop}.`);
  lines.push(`- Final refs: ${report.loaderAbi.finalRefs.countSite}; ${report.loaderAbi.finalRefs.allocation}; reads ${report.loaderAbi.finalRefs.source} at ${report.loaderAbi.finalRefs.refReadSite}.`);
  lines.push("");
  lines.push(mdRow(["Field", "Source", "Store", "Role"]));
  lines.push(mdRow(["---", "---", "---", "---"]));
  for (const field of report.loaderAbi.rangeTable.fields) {
    lines.push(mdRow([field.field, field.source, field.store, field.role]));
  }
  lines.push("");
  lines.push("## Script Matrix");
  lines.push("");
  lines.push(mdRow(["Script", "Status", "Mode", "Entries", "Final refs", "Entry text-like", "Selected ref"]));
  lines.push(mdRow(["---", "---", "---", "---:", "---:", "---:", "---"]));
  for (const script of report.scripts) {
    const top = script.candidates?.[0] || {};
    const selected = top.samples?.selectedEntry;
    lines.push(mdRow([
      script.name,
      script.status,
      top.modeKey || "-",
      top.entryCount ?? "-",
      top.finalRefCount ?? "-",
      `${top.entryRefTextLikeCount || 0}/${top.finalRefTextLikeCount || 0}`,
      selected ? `entry${selected.index} raw=${selected.refRaw} len=${selected.lengthTextStatus}` : "-",
    ]));
  }
  for (const script of report.scripts) {
    lines.push("");
    lines.push(`## ${script.name}`);
    lines.push("");
    lines.push(`- Group end: ${script.groupEnd || "-"}; text pool: ${script.layoutTextPool || "-"}; symbol pool: ${script.layoutSymbolPool || "-"}.`);
    if (script.primarySelection?.selected) {
      lines.push(`- Primary selection: entry${script.primarySelection.entry} ref=${script.primarySelection.ref} raw=${script.primarySelection.refRaw || "-"} status=${script.primarySelection.safetyStatus || "-"}.`);
    } else {
      lines.push("- Primary selection: unmatched.");
    }
    for (const candidate of script.candidates || []) {
      lines.push("");
      lines.push(`### ${candidate.role} ${candidate.modeKey}`);
      lines.push(`- Parse: ok=${candidate.ok}, start=${candidate.start}, end=${candidate.end}, entries=${candidate.entryCount}, finalRefs=${candidate.finalRefCount}, entryTextLike=${candidate.entryRefTextLikeCount}, finalTextLike=${candidate.finalRefTextLikeCount}${candidate.warnings?.length ? `, warnings=${candidate.warnings.join("; ")}` : ""}`);
      const entries = [
        candidate.samples?.selectedEntry ? { label: "selected", entry: candidate.samples.selectedEntry } : null,
        ...(candidate.samples?.firstEntries || []).map((entry) => ({ label: "sample", entry })),
      ].filter(Boolean);
      const seen = new Set();
      for (const item of entries) {
        const entry = item.entry;
        if (seen.has(entry.index)) continue;
        seen.add(entry.index);
        lines.push(`  - ${item.label} entry${entry.index}@${entry.offset}: cursor=${entry.cursor}, kind=${entry.kind}, span=${entry.span}, derived0C=${entry.derivedEnd}, ref@${entry.refOffset} raw=${entry.refRaw}, compact=${entry.compactValue ?? "-"}, len=${entry.lengthTextStatus}${entry.lengthText ? ` "${entry.lengthText}"` : ""}`);
      }
      if (candidate.finalRefSamples?.length) {
        lines.push(`  - final refs: ${candidate.finalRefSamples.map((ref) => `#${ref.index}@${ref.offset} raw=${ref.raw} len=${ref.lengthTextStatus}${ref.lengthText ? `:${ref.lengthText}` : ""}`).join("; ")}`);
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
  const jsonFile = path.join(outDir, "xse_ref64_loader_probe.json");
  const mdFile = path.join(outDir, "xse_ref64_loader_probe.md");
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
