const fs = require("fs");
const path = require("path");
const { DEFAULT_INPUT, fixupPayload, loadCbeArchive } = require("./cbe_unpack");
const {
  decodeCompactToken,
  hexBytes,
  parseResourceEnvelope,
} = require("./cbe_struct");

const DEFAULT_OUT = path.resolve(__dirname, "out_godwar_xsefacadenorm");
const DEFAULT_LAYOUT_JSON = path.resolve(__dirname, "out_godwar_xselayout", "xse_layout_trace.json");
const FOCUS = ["s_01.xse", "s_02.xse", "s_03.xse", "s_04.xse"];
const MAX_STATES = 1024;
const MAX_TOTAL_RECORDS = 2048;
const MAX_SCALAR_WIDTH = 6;
const MAX_BRANCH50_WIDTH = 5;

function hex(n, width = 4) {
  if (!Number.isFinite(n) || n < 0) return "";
  return `0x${n.toString(16).toUpperCase().padStart(width, "0")}`;
}

function byteHex(value) {
  return hex(value, 2);
}

function normalizeName(name) {
  return path.basename(String(name || "").replace(/\\/g, "/")).replace(/^[0-9]{4}_/, "").toLowerCase();
}

function findEntry(archive, name) {
  const target = normalizeName(name);
  return archive.entries.find((entry) => normalizeName(entry.name) === target) || null;
}

function readResource(archive, entry) {
  const raw = archive.rawPayload(entry);
  const fixed = fixupPayload(entry.name, raw);
  return {
    raw,
    fixed: fixed.payload,
    fixupNote: fixed.note || "",
  };
}

function tokenSummary(token, label) {
  if (!token) return null;
  return {
    label,
    offset: hex(token.offset),
    next: hex(token.next),
    width: token.next - token.offset,
    tag: token.tag || "raw8",
    value: token.value,
    raw: token.raw,
  };
}

function compactAt(buf, cursor, limit = 0x7fffffff) {
  const token = decodeCompactToken(buf, cursor);
  if (!token || token.truncated || Math.abs(token.value) > limit) return null;
  return token;
}

function rawByte(buf, cursor) {
  if (cursor >= buf.length) return null;
  return {
    offset: cursor,
    next: cursor + 1,
    value: buf[cursor],
    raw: byteHex(buf[cursor]),
    tag: "raw8",
  };
}

function readStableHeader(buf, baseOffset) {
  let cursor = baseOffset + 6;
  const reads = [];

  function compact(label, limit = 4096) {
    const token = compactAt(buf, cursor, limit);
    if (!token) return null;
    cursor = token.next;
    reads.push(tokenSummary(token, label));
    return token;
  }

  function raw(label) {
    const token = rawByte(buf, cursor);
    if (!token) return null;
    cursor = token.next;
    reads.push(tokenSummary(token, label));
    return token;
  }

  const slotCapacity = compact("0x1131A +0x50 object+58 slot capacity");
  const field04 = slotCapacity ? compact("0x1136A +0x50 object+04") : null;
  const field08Byte = field04 ? raw("0x11382 raw object+08 byte") : null;
  const field0C = field08Byte ? compact("0x11392 +0x50 object+0C") : null;
  const typeByte = field0C ? raw("0x113A8 raw type byte") : null;
  let recordByteSizeToken = null;
  let recordByteSize = null;
  if (typeByte) {
    recordByteSize = { 1: 0x14, 2: 0x28, 3: 0x50 }[typeByte.value] || null;
    if (recordByteSize == null) {
      recordByteSizeToken = compact("0x113B2 +0x50 explicit record byte size");
      recordByteSize = recordByteSizeToken?.value ?? null;
    }
  }
  const groupCount = recordByteSizeToken || recordByteSize != null
    ? compact("0x113F2 +0x50 group count")
    : null;
  const ok = Boolean(slotCapacity && field04 && field08Byte && field0C && typeByte && recordByteSize != null && groupCount);

  return {
    ok,
    baseOffset,
    cursor,
    reads,
    slotCapacity: slotCapacity?.value === 0 ? 0x80 : slotCapacity?.value,
    field04: field04?.value,
    field08Byte: field08Byte?.value,
    field0C: field0C?.value,
    typeByte: typeByte?.value,
    recordByteSize,
    groupCount: groupCount?.value,
    warning: ok ? "" : "header did not decode with the current +0x50 compact reader",
  };
}

function current50Branches(buf, cursor, label) {
  const token = compactAt(buf, cursor);
  if (!token) return [];
  return [{
    kind: "+0x50",
    label,
    offset: cursor,
    next: token.next,
    width: token.next - cursor,
    raw: token.raw,
    tag: token.tag,
    value: token.value,
  }];
}

function loose50Branches(buf, cursor, label) {
  const out = [];
  for (let width = 1; width <= MAX_BRANCH50_WIDTH && cursor + width <= buf.length; width += 1) {
    out.push({
      kind: "+0x50-loose",
      label,
      offset: cursor,
      next: cursor + width,
      width,
      raw: hexBytes(buf.subarray(cursor, cursor + width)),
      tag: `w${width}`,
      value: null,
    });
  }
  return out;
}

function scalar4CBranches(buf, cursor, label) {
  const out = [];
  for (let width = 1; width <= MAX_SCALAR_WIDTH && cursor + width <= buf.length; width += 1) {
    out.push({
      kind: "+0x4C/0x934",
      label,
      offset: cursor,
      next: cursor + width,
      width,
      raw: hexBytes(buf.subarray(cursor, cursor + width)),
      tag: `w${width}`,
      value: null,
    });
  }
  return out;
}

function mergeHist(base, opcode) {
  const hist = { ...base };
  hist[opcode] = (hist[opcode] || 0) + 1;
  return hist;
}

function summarizeHist(hist) {
  return Object.entries(hist || {})
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || Number(a.key) - Number(b.key))
    .slice(0, 16);
}

function scoreState(state, targetEnd) {
  const distance = Number.isFinite(targetEnd) ? Math.abs(state.cursor - targetEnd) : 0;
  return (state.totalRecords * 12) - distance - state.loose50Reads * 5 - state.maxScalarWidth * 2;
}

function dedupeStates(states, targetEnd) {
  const byKey = new Map();
  for (const state of states) {
    const key = `${state.cursor}:${state.groupIndex ?? -1}:${state.totalRecords}:${state.loose50Reads}`;
    const prev = byKey.get(key);
    if (!prev || scoreState(state, targetEnd) > scoreState(prev, targetEnd)) byKey.set(key, state);
  }
  return Array.from(byKey.values())
    .sort((a, b) => scoreState(b, targetEnd) - scoreState(a, targetEnd))
    .slice(0, MAX_STATES);
}

function appendRead(state, read) {
  const sample = {
    kind: read.kind,
    label: read.label,
    offset: hex(read.offset),
    next: hex(read.next),
    width: read.width,
    raw: read.raw,
    tag: read.tag,
  };
  return {
    ...state,
    cursor: read.next,
    maxScalarWidth: read.kind.includes("+0x4C") ? Math.max(state.maxScalarWidth, read.width) : state.maxScalarWidth,
    loose50Reads: read.kind === "+0x50-loose" ? state.loose50Reads + 1 : state.loose50Reads,
    readSamples: state.readSamples.length < 24 ? [...state.readSamples, sample] : state.readSamples,
  };
}

function branch50(buf, state, label, mode) {
  const reads = mode === "loose50"
    ? loose50Branches(buf, state.cursor, label)
    : current50Branches(buf, state.cursor, label);
  return reads.map((read) => appendRead(state, read));
}

function branch4C(buf, state, label) {
  return scalar4CBranches(buf, state.cursor, label).map((read) => appendRead(state, read));
}

function branchRecord(buf, state, groupIndex, recordIndex, mode) {
  const opcodeToken = rawByte(buf, state.cursor);
  if (!opcodeToken) {
    return { states: [], failure: { reason: "truncated opcode", offset: hex(state.cursor), groupIndex, recordIndex } };
  }
  if (opcodeToken.value > 8) {
    return {
      states: [],
      failure: {
        reason: "opcode gate failed",
        offset: hex(opcodeToken.offset),
        byte: opcodeToken.raw,
        opcode: opcodeToken.value,
        groupIndex,
        recordIndex,
      },
    };
  }

  const base = {
    ...state,
    cursor: opcodeToken.next,
    totalRecords: state.totalRecords + 1,
    opcodeHist: mergeHist(state.opcodeHist, opcodeToken.value),
    samples: state.samples.length < 18
      ? [...state.samples, { groupIndex, recordIndex, offset: hex(opcodeToken.offset), opcode: opcodeToken.value, raw: opcodeToken.raw }]
      : state.samples,
  };

  switch (opcodeToken.value) {
    case 0:
      return { states: branch50(buf, base, "opcode0 field+08", mode), failure: null };
    case 1:
      return { states: branch4C(buf, base, "opcode1 field+0C via +0x4C/0x934 then 0x353A8"), failure: null };
    case 2:
      return { states: branch50(buf, base, "opcode2 field+08 then forced opcode=2", mode), failure: null };
    case 3:
      return { states: branch50(buf, base, "opcode3 field+14", mode), failure: null };
    case 4: {
      const first = branch50(buf, base, "opcode4 field+14", mode);
      const out = [];
      for (const next of first) out.push(...branch50(buf, next, "opcode4 field+04", mode));
      return { states: out, failure: null };
    }
    case 5:
      return { states: branch50(buf, base, "opcode5 field+18", mode), failure: null };
    case 6:
      return { states: branch50(buf, base, "opcode6 field+1C", mode), failure: null };
    case 7:
      return { states: branch50(buf, base, "opcode7 field+20", mode), failure: null };
    case 8:
      return { states: branch50(buf, base, "opcode8 field+24", mode), failure: null };
    default:
      return { states: [], failure: { reason: "unhandled opcode", offset: hex(opcodeToken.offset), opcode: opcodeToken.value, groupIndex, recordIndex } };
  }
}

function branchGroup(buf, state, groupIndex, targetEnd, mode) {
  const groupBranches = scalar4CBranches(buf, state.cursor, "group id via +0x4C/0x934");
  const failures = [];
  let out = [];

  for (const idRead of groupBranches) {
    const recordCountToken = rawByte(buf, idRead.next);
    if (!recordCountToken) {
      failures.push({ reason: "truncated group record count", offset: hex(idRead.next), groupIndex, idWidth: idRead.width });
      continue;
    }
    const recordCount = recordCountToken.value;
    if (state.totalRecords + recordCount > MAX_TOTAL_RECORDS) {
      failures.push({ reason: "record budget exceeded", offset: hex(recordCountToken.offset), groupIndex, idWidth: idRead.width, recordCount });
      continue;
    }

    let states = [{
      ...appendRead(state, idRead),
      cursor: recordCountToken.next,
      groupIndex,
      groups: [
        ...state.groups,
        {
          index: groupIndex,
          offset: hex(idRead.offset),
          idWidth: idRead.width,
          idRaw: idRead.raw,
          recordCount,
          recordCountOffset: hex(recordCountToken.offset),
          recordCountRaw: recordCountToken.raw,
        },
      ],
      readSamples: state.readSamples.length < 24
        ? [
          ...state.readSamples,
          {
            kind: "+0x4C/0x934",
            label: "group id via +0x4C/0x934",
            offset: hex(idRead.offset),
            next: hex(idRead.next),
            width: idRead.width,
            raw: idRead.raw,
            tag: idRead.tag,
          },
          {
            kind: "raw-byte",
            label: "group record count",
            offset: hex(recordCountToken.offset),
            next: hex(recordCountToken.next),
            width: 1,
            raw: recordCountToken.raw,
            tag: "raw8",
          },
        ].slice(0, 24)
        : state.readSamples,
    }];

    for (let recordIndex = 0; recordIndex < recordCount && states.length; recordIndex += 1) {
      const nextStates = [];
      for (const current of states) {
        const result = branchRecord(buf, current, groupIndex, recordIndex, mode);
        nextStates.push(...result.states);
        if (result.failure) failures.push({ ...result.failure, idWidth: idRead.width });
      }
      states = dedupeStates(nextStates, targetEnd);
    }
    out.push(...states);
  }

  out = dedupeStates(out, targetEnd);
  return { states: out, failures };
}

function searchNormalizedGate(buf, header, targetEnd, mode) {
  if (!header.ok || !Number.isFinite(header.groupCount) || header.groupCount < 0 || header.groupCount > 64) {
    return {
      ok: false,
      anyStrictOpcodePath: false,
      layoutAlignedStrictPath: false,
      reason: header.warning || "implausible header/group count",
      successes: [],
      firstFailures: [],
    };
  }

  let states = [{
    cursor: header.cursor,
    totalRecords: 0,
    opcodeHist: {},
    groups: [],
    samples: [],
    readSamples: [],
    maxScalarWidth: 0,
    loose50Reads: 0,
  }];
  const failures = [];

  for (let groupIndex = 0; groupIndex < header.groupCount && states.length; groupIndex += 1) {
    const nextStates = [];
    for (const state of states) {
      const result = branchGroup(buf, state, groupIndex, targetEnd, mode);
      nextStates.push(...result.states);
      failures.push(...result.failures);
    }
    states = dedupeStates(nextStates, targetEnd);
  }

  const successes = states
    .filter((state) => state.groups.length === header.groupCount && state.totalRecords > 0)
    .map((state) => {
      const delta = Number.isFinite(targetEnd) ? state.cursor - targetEnd : null;
      return {
        endOffset: hex(state.cursor),
        layoutEndDelta: delta,
        layoutAligned: Number.isFinite(delta) ? Math.abs(delta) <= 16 : false,
        totalRecords: state.totalRecords,
        groups: state.groups,
        opcodeHistogram: summarizeHist(state.opcodeHist),
        samples: state.samples,
        readSamples: state.readSamples,
        maxScalarWidth: state.maxScalarWidth,
        loose50Reads: state.loose50Reads,
        score: scoreState(state, targetEnd),
      };
    })
    .sort((a, b) => {
      const ad = Number.isFinite(a.layoutEndDelta) ? Math.abs(a.layoutEndDelta) : 0;
      const bd = Number.isFinite(b.layoutEndDelta) ? Math.abs(b.layoutEndDelta) : 0;
      return ad - bd || b.totalRecords - a.totalRecords || b.score - a.score;
    });

  return {
    ok: successes.length > 0,
    anyStrictOpcodePath: successes.length > 0,
    layoutAlignedStrictPath: successes.some((state) => state.layoutAligned),
    stateCount: states.length,
    successes: successes.slice(0, 8),
    firstFailures: failures.slice(0, 32),
  };
}

function loadLayoutEnds(file = DEFAULT_LAYOUT_JSON) {
  try {
    const report = JSON.parse(fs.readFileSync(file, "utf8"));
    const map = new Map();
    for (const script of report.scripts || []) {
      const endText = script.zones?.objectProbe?.end || "";
      const end = typeof endText === "string" && /^0x/i.test(endText) ? parseInt(endText, 16) : NaN;
      if (Number.isFinite(end)) map.set(normalizeName(script.name), end);
    }
    return { file, map };
  } catch (err) {
    return { file, map: new Map(), error: err.message || String(err) };
  }
}

function probeOne(archive, name, layoutEnds) {
  const entry = findEntry(archive, name);
  if (!entry) return { name, missing: true };
  const resource = readResource(archive, entry);
  const buf = resource.fixed;
  const envelope = parseResourceEnvelope(buf);
  const xseMagic = buf.indexOf(Buffer.from("XSE0", "ascii"));
  const baseCandidates = [
    {
      label: "0x112C4 converted-stream body-prefix",
      baseOffset: envelope.bodyOffset,
      reason: "Matches the current stable header: converted stream cursor is initialized to +6, so slot capacity is read at raw body-prefix+6.",
    },
  ];
  if (xseMagic >= 0 && xseMagic !== envelope.bodyOffset) {
    baseCandidates.push({
      label: "XSE0 pointer comparison",
      baseOffset: xseMagic,
      reason: "Control candidate from sibling parser checks; expected to fail XSE header count but retained as a guard.",
    });
  }
  const targetEnd = layoutEnds.map.get(normalizeName(name));

  return {
    name,
    archiveEntry: entry.name,
    size: buf.length,
    fixupNote: resource.fixupNote,
    envelope: {
      tag: envelope.tag,
      declaredBodyLength: envelope.declaredBodyLength,
      bodyOffset: hex(envelope.bodyOffset),
      lengthMatches: envelope.lengthMatches,
      xseMagicOffset: xseMagic >= 0 ? hex(xseMagic) : "",
    },
    layoutBoundary: {
      objectProbeEnd: Number.isFinite(targetEnd) ? hex(targetEnd) : "",
      source: layoutEnds.error ? "" : layoutEnds.file,
    },
    candidates: baseCandidates.map((candidate) => {
      const header = readStableHeader(buf, candidate.baseOffset);
      const current50 = searchNormalizedGate(buf, header, targetEnd, "current50");
      const loose50 = searchNormalizedGate(buf, header, targetEnd, "loose50");
      return {
        label: candidate.label,
        reason: candidate.reason,
        baseOffset: hex(candidate.baseOffset),
        header: {
          ok: header.ok,
          cursorAfterHeader: hex(header.cursor),
          slotCapacity: header.slotCapacity,
          field04: header.field04,
          field08Byte: header.field08Byte,
          field0C: header.field0C,
          typeByte: header.typeByte,
          recordByteSize: header.recordByteSize,
          groupCount: header.groupCount,
          reads: header.reads,
          warning: header.warning,
        },
        current50,
        loose50,
      };
    }),
  };
}

function summarizeScript(script) {
  const primary = script.candidates?.[0];
  const current = primary?.current50 || {};
  const loose = primary?.loose50 || {};
  return {
    name: script.name,
    baseOffset: primary?.baseOffset || "",
    headerOk: Boolean(primary?.header?.ok),
    groupCount: primary?.header?.groupCount ?? null,
    current50Strict: Boolean(current.anyStrictOpcodePath),
    current50Aligned: Boolean(current.layoutAlignedStrictPath),
    loose50Strict: Boolean(loose.anyStrictOpcodePath),
    loose50Aligned: Boolean(loose.layoutAlignedStrictPath),
    bestCurrentEnd: current.successes?.[0]?.endOffset || "",
    bestLooseEnd: loose.successes?.[0]?.endOffset || "",
    layoutEnd: script.layoutBoundary?.objectProbeEnd || "",
    bestLooseDelta: loose.successes?.[0]?.layoutEndDelta ?? null,
  };
}

function mdRow(values) {
  return `| ${values.map((value) => String(value ?? "").replace(/\|/g, "\\|")).join(" | ")} |`;
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# XSE Facade-Normalized Reader Probe");
  lines.push("");
  lines.push(`- Input CBE: \`${report.input}\``);
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push("");
  lines.push("## Why this probe exists");
  lines.push("");
  lines.push("The verified caller equivalence says wrapper `0x934` must be modeled like `[sb+0x35C4]+0x4C`, and wrapper `0x958` like `[sb+0x35C4]+0x64`. This probe replays the `0x112C4` group/opcode gate through that normalized reader vocabulary instead of treating wrapper calls as unrelated script commands.");
  lines.push("");
  lines.push("Two variants are tested: `current50` keeps the existing `+0x50` compact-token width model; `loose50` allows every record-field `+0x50` read to consume 1..5 bytes. A loose path is only a diagnostic width witness, not an accepted VM decoder, unless it also reaches the layout boundary.");
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(mdRow(["Script", "Base", "Header", "Current +0x50", "Loose +0x50", "Best loose end", "Layout end", "Delta"]));
  lines.push(mdRow(["---", "---", "---", "---", "---", "---", "---", "---:"]));
  for (const row of report.summary) {
    const current = row.current50Aligned ? "aligned pass" : (row.current50Strict ? "shallow pass" : "no path");
    const loose = row.loose50Aligned ? "aligned pass" : (row.loose50Strict ? "shallow pass" : "no path");
    lines.push(mdRow([
      row.name,
      row.baseOffset,
      row.headerOk ? `groups=${row.groupCount}` : "failed",
      current,
      loose,
      row.bestLooseEnd,
      row.layoutEnd,
      row.bestLooseDelta ?? "",
    ]));
  }
  lines.push("");
  lines.push("## Per-Script Evidence");
  for (const script of report.scripts) {
    lines.push("");
    lines.push(`### ${script.name}`);
    const primary = script.candidates?.[0];
    if (!primary) {
      lines.push("- Missing candidate.");
      continue;
    }
    lines.push(`- Base: ${primary.label} ${primary.baseOffset}`);
    lines.push(`- Header: ${primary.header.ok ? "ok" : "failed"}, cursor=${primary.header.cursorAfterHeader}, recordByteSize=${primary.header.recordByteSize}, groups=${primary.header.groupCount}`);
    const currentBest = primary.current50.successes?.[0];
    const looseBest = primary.loose50.successes?.[0];
    lines.push(`- Current +0x50 strict path: ${primary.current50.anyStrictOpcodePath ? "yes" : "no"}, aligned=${primary.current50.layoutAlignedStrictPath ? "yes" : "no"}`);
    lines.push(`- Loose +0x50 strict path: ${primary.loose50.anyStrictOpcodePath ? "yes" : "no"}, aligned=${primary.loose50.layoutAlignedStrictPath ? "yes" : "no"}`);
    if (currentBest) {
      lines.push(`- Best current path: end=${currentBest.endOffset}, delta=${currentBest.layoutEndDelta}, records=${currentBest.totalRecords}, maxScalarWidth=${currentBest.maxScalarWidth}`);
    }
    if (looseBest) {
      const groupText = (looseBest.groups || [])
        .slice(0, 4)
        .map((group) => `g${group.index}:idw${group.idWidth}/n${group.recordCount}`)
        .join(", ");
      const opcodeText = (looseBest.opcodeHistogram || [])
        .slice(0, 8)
        .map((item) => `${item.key}:${item.count}`)
        .join(" ");
      lines.push(`- Best loose path: end=${looseBest.endOffset}, delta=${looseBest.layoutEndDelta}, records=${looseBest.totalRecords}, loose50Reads=${looseBest.loose50Reads}, groups=${groupText}`);
      lines.push(`- Best loose opcodes: ${opcodeText || "none"}`);
      const readText = (looseBest.readSamples || [])
        .slice(0, 8)
        .map((read) => `${read.kind}/${read.label}@${read.offset}->${read.next} ${read.raw}`)
        .join("; ");
      lines.push(`- Best loose read samples: ${readText || "none"}`);
    }
    const failures = primary.current50.firstFailures || [];
    if (failures.length) {
      const failureText = failures.slice(0, 4)
        .map((failure) => `${failure.reason}@${failure.offset} g=${failure.groupIndex} r=${failure.recordIndex} byte=${failure.byte || ""}`)
        .join("; ");
      lines.push(`- Current +0x50 first failures: ${failureText}`);
    }
  }
  lines.push("");
  lines.push("## Current Conclusion");
  lines.push("");
  const alignedLoose = report.summary.filter((row) => row.loose50Aligned).length;
  const anyLoose = report.summary.filter((row) => row.loose50Strict).length;
  lines.push(`- Facade normalization alone does not create an accepted emulator path unless ` +
    `${alignedLoose}/${report.summary.length} scripts gain a layout-aligned strict opcode path under loose +0x50.`);
  lines.push(`- Loose +0x50 found strict opcode-only paths in ${anyLoose}/${report.summary.length} scripts; these remain diagnostic until the real converted-stream object and +0x50 method are resolved.`);
  lines.push("- Keep modeling `0x934` as the `+0x4C` scalar reader and `0x958` as the `+0x64` child/ref reader, but the next real emulator target is still the `0x11300..0x1130E` stream conversion and the exact `[sb+0x35C4]+0x50` cursor method.");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

function buildReport(input = DEFAULT_INPUT) {
  const archive = loadCbeArchive(input);
  const layoutEnds = loadLayoutEnds();
  const scripts = FOCUS.map((name) => probeOne(archive, name, layoutEnds));
  return {
    schema: "nicai.cbe.xseFacadeNormalizedProbe.v1",
    generatedAt: new Date().toISOString(),
    input,
    focus: FOCUS,
    normalizedReader: {
      scalarReader: "0x934 is normalized to direct [sb+0x35C4]+0x4C at the verified 0x112C4 caller sites.",
      childHandleReader: "0x958 is normalized to direct [sb+0x35C4]+0x64 at the verified 0x112C4 caller sites; it is symbolic in this opcode-gate phase.",
      compactReader: "current50 keeps the existing decodeCompactToken width model for [sb+0x35C4]+0x50; loose50 branches only field widths to test whether +0x50 width semantics are the blocker.",
    },
    scripts,
    summary: scripts.map(summarizeScript),
  };
}

function main(argv = process.argv.slice(2)) {
  const input = path.resolve(argv[0] || DEFAULT_INPUT);
  const outDir = path.resolve(argv[1] || DEFAULT_OUT);
  fs.mkdirSync(outDir, { recursive: true });
  const report = buildReport(input);
  const jsonFile = path.join(outDir, "xse_facade_normalized_probe.json");
  const mdFile = path.join(outDir, "xse_facade_normalized_probe.md");
  writeJson(jsonFile, report);
  fs.writeFileSync(mdFile, renderMarkdown(report), "utf8");
  console.log(`wrote ${jsonFile}`);
  console.log(`wrote ${mdFile}`);
}

if (require.main === module) {
  main();
}

module.exports = {
  FOCUS,
  buildReport,
  readStableHeader,
  searchNormalizedGate,
};
