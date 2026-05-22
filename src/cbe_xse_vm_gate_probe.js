const fs = require("fs");
const path = require("path");
const { DEFAULT_INPUT, fixupPayload, loadCbeArchive } = require("./cbe_unpack");
const {
  decodeCompactToken,
  hexBytes,
  parseResourceEnvelope,
  probe112C4ResourceBuffer,
} = require("./cbe_struct");

const DEFAULT_OUT = path.resolve(__dirname, "out_godwar_xsevmgate");
const DEFAULT_LAYOUT_JSON = path.resolve(__dirname, "out_godwar_xselayout", "xse_layout_trace.json");
const FOCUS = ["s_01.xse", "s_02.xse", "s_03.xse", "s_04.xse"];
const MAX_4C_WIDTH = 6;
const MAX_TOTAL_RECORDS = 2048;
const MAX_STATES = 512;
const COMMANDS = [
  "GETGAMESTATE",
  "LOADHERERSKILL",
  "CLOSESCRIPT",
  "CANSAY",
  "LOADLIGHTGOD",
  "LOADDARKGOD",
  "LOADMONSTER",
  "SETROLEPOS",
  "ROLEMOVETO",
  "SETCAMERAMODE",
  "GETSCREENSIZE",
  "STARTDIALOG",
  "SHOWDIALOG",
  "OPENCR",
  "CHANGESCENE",
  "ENDSCRIPT",
];
const FRAGMENTS = [
  ["SCREENSIZE", "GETSCREENSIZE"],
  ["RAMODE", "SETCAMERAMODE"],
  ["RTDIALOG", "STARTDIALOG"],
  ["ROLEPOS", "SETROLEPOS"],
  ["MOVETO", "ROLEMOVETO"],
  ["LIGHTGOD", "LOADLIGHTGOD"],
  ["DARKGOD", "LOADDARKGOD"],
  ["MONSTER", "LOADMONSTER"],
  ["OPENCR", "OPENCR"],
];

function hex(n, width = 4) {
  if (!Number.isFinite(n) || n < 0) return "";
  return `0x${n.toString(16).toUpperCase().padStart(width, "0")}`;
}

function byteHex(value) {
  return hex(value, 2);
}

function cleanName(name) {
  return path.basename(String(name || "").replace(/\\/g, "/")).replace(/^[0-9]{4}_/, "");
}

function normalizeName(name) {
  return cleanName(name).toLowerCase();
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
  };
}

function tokenSummary(token, label) {
  if (!token) return null;
  return {
    label,
    offset: hex(token.offset),
    raw: token.raw,
    tag: token.tag || "raw8",
    value: token.value,
    next: hex(token.next),
  };
}

function readHeader(buf, baseOffset) {
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

  const slotCapacity = compact("object+58 slot capacity");
  const field04 = slotCapacity ? compact("object+04") : null;
  const field08Byte = field04 ? raw("object+08 byte") : null;
  const field0C = field08Byte ? compact("object+0C") : null;
  const typeByte = field0C ? raw("object type") : null;
  let recordByteSize = null;
  let recordByteSizeToken = null;
  if (typeByte) {
    recordByteSize = { 1: 0x14, 2: 0x28, 3: 0x50 }[typeByte.value] || null;
    if (recordByteSize == null) {
      recordByteSizeToken = compact("object+1C record byte size");
      recordByteSize = recordByteSizeToken?.value ?? null;
    }
  }
  const groupCount = recordByteSizeToken || recordByteSize != null ? compact("object+4C group count") : null;
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
    warning: ok ? "" : "Header did not fully decode with the current +0x50 compact reader.",
  };
}

function readVar4C(buf, cursor, label) {
  const out = [];
  for (let width = 1; width <= MAX_4C_WIDTH && cursor + width <= buf.length; width += 1) {
    out.push({
      label,
      offset: cursor,
      next: cursor + width,
      width,
      raw: hexBytes(buf.subarray(cursor, cursor + width)),
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
  return (state.totalRecords * 8) - distance - (state.max4CWidth * 2);
}

function dedupeStates(states, targetEnd) {
  const bestByCursor = new Map();
  for (const state of states) {
    const key = `${state.cursor}:${state.totalRecords}:${state.groupIndex ?? -1}`;
    const prev = bestByCursor.get(key);
    if (!prev || scoreState(state, targetEnd) > scoreState(prev, targetEnd)) {
      bestByCursor.set(key, state);
    }
  }
  return Array.from(bestByCursor.values())
    .sort((a, b) => scoreState(b, targetEnd) - scoreState(a, targetEnd))
    .slice(0, MAX_STATES);
}

function branchRecord(buf, state, groupIndex, recordIndex) {
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
    samples: state.samples.length < 12
      ? [...state.samples, { groupIndex, recordIndex, offset: hex(opcodeToken.offset), opcode: opcodeToken.value, raw: opcodeToken.raw }]
      : state.samples,
  };

  function compactField(inputState, label) {
    const token = compactAt(buf, inputState.cursor);
    if (!token) {
      return {
        states: [],
        failure: { reason: `truncated compact field ${label}`, offset: hex(inputState.cursor), groupIndex, recordIndex },
      };
    }
    return { states: [{ ...inputState, cursor: token.next }], failure: null };
  }

  switch (opcodeToken.value) {
    case 0:
      return compactField(base, "field08");
    case 1: {
      const branches = readVar4C(buf, base.cursor, "opcode1 field0C").map((read) => ({
        ...base,
        cursor: read.next,
        max4CWidth: Math.max(base.max4CWidth, read.width),
        varReads: base.varReads.length < 16
          ? [...base.varReads, { ...read, offset: hex(read.offset), next: hex(read.next) }]
          : base.varReads,
      }));
      return {
        states: branches,
        failure: branches.length ? null : { reason: "truncated variable +0x4C field", offset: hex(base.cursor), groupIndex, recordIndex },
      };
    }
    case 2:
    case 3:
    case 5:
    case 6:
    case 7:
    case 8:
      return compactField(base, `opcode${opcodeToken.value} compact field`);
    case 4: {
      const first = compactField(base, "opcode4 field14");
      if (!first.states.length) return first;
      const out = [];
      let failure = null;
      for (const nextState of first.states) {
        const second = compactField(nextState, "opcode4 field04");
        out.push(...second.states);
        if (second.failure && !failure) failure = second.failure;
      }
      return { states: out, failure };
    }
    default:
      return { states: [], failure: { reason: "unhandled opcode", offset: hex(opcodeToken.offset), opcode: opcodeToken.value, groupIndex, recordIndex } };
  }
}

function branchGroup(buf, state, groupIndex, targetEnd) {
  const groupBranches = readVar4C(buf, state.cursor, "group id");
  if (!groupBranches.length) {
    return {
      states: [],
      failures: [{ reason: "truncated group id", offset: hex(state.cursor), groupIndex }],
    };
  }

  let out = [];
  const failures = [];
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
      ...state,
      cursor: recordCountToken.next,
      groupIndex,
      max4CWidth: Math.max(state.max4CWidth, idRead.width),
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
      varReads: state.varReads.length < 16
        ? [...state.varReads, { ...idRead, offset: hex(idRead.offset), next: hex(idRead.next) }]
        : state.varReads,
    }];

    for (let recordIndex = 0; recordIndex < recordCount && states.length; recordIndex += 1) {
      const nextStates = [];
      for (const current of states) {
        const result = branchRecord(buf, current, groupIndex, recordIndex);
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

function searchGate(buf, header, targetEnd) {
  if (!header.ok || !Number.isFinite(header.groupCount) || header.groupCount < 0 || header.groupCount > 64) {
    return {
      ok: false,
      reason: header.warning || "implausible header/group count",
      states: [],
      failures: [],
    };
  }

  let states = [{
    cursor: header.cursor,
    totalRecords: 0,
    opcodeHist: {},
    groups: [],
    samples: [],
    varReads: [],
    max4CWidth: 0,
  }];
  const failures = [];
  for (let groupIndex = 0; groupIndex < header.groupCount && states.length; groupIndex += 1) {
    const nextStates = [];
    for (const state of states) {
      const result = branchGroup(buf, state, groupIndex, targetEnd);
      nextStates.push(...result.states);
      failures.push(...result.failures);
    }
    states = dedupeStates(nextStates, targetEnd);
  }

  const successful = states
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
        varReadSamples: state.varReads,
        max4CWidth: state.max4CWidth,
        score: scoreState(state, targetEnd),
      };
    })
    .sort((a, b) => {
      const ad = Number.isFinite(a.layoutEndDelta) ? Math.abs(a.layoutEndDelta) : 0;
      const bd = Number.isFinite(b.layoutEndDelta) ? Math.abs(b.layoutEndDelta) : 0;
      return ad - bd || b.totalRecords - a.totalRecords || b.score - a.score;
    });

  return {
    ok: successful.length > 0,
    anyStrictOpcodePath: successful.length > 0,
    layoutAlignedStrictPath: successful.some((state) => state.layoutAligned),
    stateCount: states.length,
    successes: successful.slice(0, 8),
    firstFailures: failures.slice(0, 24),
  };
}

function indexOfAll(buf, needle, start = 0) {
  const out = [];
  let pos = start - 1;
  while ((pos = buf.indexOf(needle, pos + 1)) >= 0) out.push(pos);
  return out;
}

function symbolEvidence(buf) {
  const initOffset = buf.indexOf(Buffer.from("INIT", "ascii"));
  const mainOffset = buf.indexOf(Buffer.from("_MAIN", "ascii"));
  const poolStart = initOffset >= 0 ? initOffset : (mainOffset >= 0 ? mainOffset : Math.max(0, buf.length - 512));
  const exact = [];
  const embedded = [];

  for (const command of COMMANDS) {
    const needle = Buffer.from(command, "ascii");
    for (const offset of indexOfAll(buf, needle, Math.max(0, poolStart - 256))) {
      const previous = offset > 0 ? buf[offset - 1] : -1;
      const item = {
        command,
        offset: hex(offset),
        previousByte: previous >= 0 ? byteHex(previous) : "",
        previousMatchesLength: previous === command.length,
      };
      if (item.previousMatchesLength) exact.push(item);
      else embedded.push(item);
    }
  }

  const fragments = [];
  for (const [fragment, command] of FRAGMENTS) {
    const needle = Buffer.from(fragment, "ascii");
    for (const offset of indexOfAll(buf, needle, Math.max(0, poolStart - 256))) {
      const previous = offset > 0 ? buf[offset - 1] : -1;
      fragments.push({
        fragment,
        command,
        offset: hex(offset),
        previousByte: previous >= 0 ? byteHex(previous) : "",
        previousMatchesFragmentLength: previous === fragment.length,
        previousMatchesCommandLength: previous === command.length,
      });
    }
  }

  return {
    initOffset: initOffset >= 0 ? hex(initOffset) : "",
    mainOffset: mainOffset >= 0 ? hex(mainOffset) : "",
    poolStart: hex(poolStart),
    exactLengthSlots: exact.slice(0, 16),
    embeddedCommands: embedded.slice(0, 16),
    fragmentAliases: fragments.slice(0, 24),
  };
}

function loadLayoutEnds(file = DEFAULT_LAYOUT_JSON) {
  try {
    const report = JSON.parse(fs.readFileSync(file, "utf8"));
    const map = new Map();
    for (const script of report.scripts || []) {
      const name = normalizeName(script.name);
      const endText = script.zones?.objectProbe?.end || "";
      const end = typeof endText === "string" && /^0x/i.test(endText) ? parseInt(endText, 16) : NaN;
      if (Number.isFinite(end)) map.set(name, end);
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
      label: "envelope-body-prefix",
      baseOffset: envelope.bodyOffset,
      reason: "Legacy diagnostic base: resource envelope body begins with a one-byte prefix before XSE0.",
    },
  ];
  if (xseMagic >= 0 && xseMagic !== envelope.bodyOffset) {
    baseCandidates.push({
      label: "xse-magic-pointer",
      baseOffset: xseMagic,
      reason: "Stream-prep candidate: sibling SCE parser obtains a pointer whose byte 0 is the SCE2 magic.",
    });
  }
  const targetEnd = layoutEnds.map.get(normalizeName(name));
  const probedBases = baseCandidates.map((candidate) => {
    const header = readHeader(buf, candidate.baseOffset);
    const variable4CSearch = searchGate(buf, header, targetEnd);
    return {
      label: candidate.label,
      reason: candidate.reason,
      baseOffset: hex(candidate.baseOffset),
      cursorAfterHeader: hex(header.cursor),
      header: {
        ok: header.ok,
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
      variable4CSearch,
    };
  });
  const primary = probedBases.find((candidate) => candidate.label === "envelope-body-prefix") || probedBases[0];
  const header = {
    ok: primary?.header.ok,
    baseOffset: envelope.bodyOffset,
    cursor: parseInt(primary?.cursorAfterHeader || "0", 16),
    slotCapacity: primary?.header.slotCapacity,
    field04: primary?.header.field04,
    field08Byte: primary?.header.field08Byte,
    field0C: primary?.header.field0C,
    typeByte: primary?.header.typeByte,
    recordByteSize: primary?.header.recordByteSize,
    groupCount: primary?.header.groupCount,
    reads: primary?.header.reads || [],
    warning: primary?.header.warning || "",
  };
  const baseline = probe112C4ResourceBuffer(buf, { resourceName: name });
  const symbols = symbolEvidence(buf);
  return {
    name,
    archiveEntry: entry.name,
    size: buf.length,
    fixupNote: resource.fixupNote,
    envelope: {
      tag: envelope.tag,
      declaredBodyLength: envelope.declaredBodyLength,
      bodyOffset: hex(envelope.bodyOffset),
      bodyLength: envelope.bodyLength,
      lengthMatches: envelope.lengthMatches,
      headerBytes: envelope.headerBytes,
    },
    streamPrepEvidence: {
      xseMagicOffset: xseMagic >= 0 ? hex(xseMagic) : "",
      testedBaseCandidates: probedBases.map((candidate) => ({
        label: candidate.label,
        baseOffset: candidate.baseOffset,
        reason: candidate.reason,
        cursorAfterHeader: candidate.cursorAfterHeader,
        headerGroupCount: candidate.header.groupCount,
        headerRecordByteSize: candidate.header.recordByteSize,
        anyStrictOpcodePath: candidate.variable4CSearch.anyStrictOpcodePath,
        layoutAlignedStrictPath: candidate.variable4CSearch.layoutAlignedStrictPath,
        bestEndOffset: candidate.variable4CSearch.successes?.[0]?.endOffset || "",
        bestLayoutDelta: candidate.variable4CSearch.successes?.[0]?.layoutEndDelta ?? null,
      })),
      siblingParserClue: "At 0x10824..0x10838 a SCE-style parser checks r4[0..3] == SCE2 immediately after its stream conversion call; raw SCE resources store SCE2 at offset 0x0A, not 0x09.",
    },
    header: {
      ok: header.ok,
      baseOffset: hex(header.baseOffset),
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
    layoutBoundaryHypothesis: {
      objectProbeEnd: Number.isFinite(targetEnd) ? hex(targetEnd) : "",
      source: layoutEnds.error ? "" : layoutEnds.file,
    },
    baseline112C4: {
      strictOpcodeGate: baseline.strictOpcodeGate,
      best: baseline.best ? {
        groupIdReader: baseline.best.groupIdReader,
        cursorStart: baseline.best.cursorStart,
        endOffset: baseline.best.endOffset,
        groupCount: baseline.best.groupCount,
        parsedGroupCount: baseline.best.parsedGroupCount,
        totalRecords: baseline.best.totalRecords,
        knownOpcodePercent: baseline.best.knownOpcodePercent,
        opcodeHistogram: baseline.best.opcodeHistogram,
      } : null,
    },
    baseCandidates: probedBases,
    variable4CSearch: primary?.variable4CSearch || { ok: false, anyStrictOpcodePath: false, layoutAlignedStrictPath: false, successes: [], firstFailures: [] },
    symbolPoolEvidence: symbols,
  };
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

function mdRow(values) {
  return `| ${values.map((value) => String(value ?? "").replace(/\|/g, "\\|")).join(" | ")} |`;
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# XSE VM Gate Probe");
  lines.push("");
  lines.push(`- Input CBE: \`${report.input}\``);
  lines.push(`- Focus: ${report.focus.join(", ")}`);
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push("");
  lines.push("## Why this probe exists");
  lines.push("");
  lines.push("The real 0x112C4 loader rejects opcodes >= 9. Earlier object-layout probes could walk bytes, but most parsed opcodes were outside 0..8. This probe keeps the raw CBE resource stream, keeps the current +0x50 compact reader, and deliberately widens only the unresolved +0x4C reads to 1..6 bytes. If that still cannot produce a layout-aligned 0..8 opcode stream, the blocker is upstream stream preparation or +0x50 semantics, not merely a +0x4C integer width guess.");
  lines.push("");
  lines.push("The stream-base hypothesis is now explicit: each XSE is tested both at the envelope body prefix (`0x09`) and at the `XSE0` magic pointer (`0x0A`). The `0x0A` candidate comes from a sibling SCE parser that checks `r4[0..3] == SCE2` immediately after stream conversion, while raw SCE resources store `SCE2` at offset `0x0A`.");
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(mdRow(["Script", "Base", "Header", "Baseline opcode %", "Variable +0x4C result", "Best end", "Layout end", "Delta"]));
  lines.push(mdRow(["---", "---", "---", "---:", "---", "---", "---", "---:"]));
  for (const script of report.scripts) {
    for (const candidate of script.baseCandidates || []) {
      const best = candidate.variable4CSearch.successes?.[0];
      const result = candidate.variable4CSearch.layoutAlignedStrictPath
        ? "layout-aligned pass"
        : (candidate.variable4CSearch.anyStrictOpcodePath ? "only shallow/non-aligned pass" : "no strict path");
      lines.push(mdRow([
        script.name,
        `${candidate.label} ${candidate.baseOffset}`,
        candidate.header.ok ? `groups=${candidate.header.groupCount}, recSize=${candidate.header.recordByteSize}` : "failed",
        script.baseline112C4.strictOpcodeGate.knownOpcodePercent,
        result,
        best?.endOffset || "",
        script.layoutBoundaryHypothesis.objectProbeEnd || "",
        best?.layoutEndDelta ?? "",
      ]));
    }
  }
  lines.push("");
  lines.push("## Header Reads");
  lines.push("");
  for (const script of report.scripts) {
    lines.push(`### ${script.name}`);
    lines.push("");
    lines.push(`- Envelope: tag ${script.envelope.tag}, bodyOffset ${script.envelope.bodyOffset}, declaredBodyLength ${script.envelope.declaredBodyLength}, lengthMatches ${script.envelope.lengthMatches}`);
    lines.push(`- Header cursor after read: ${script.header.cursorAfterHeader}`);
    lines.push(`- Header values: slotCapacity=${script.header.slotCapacity}, type=${script.header.typeByte}, recordByteSize=${script.header.recordByteSize}, groupCount=${script.header.groupCount}`);
    for (const candidate of script.streamPrepEvidence.testedBaseCandidates || []) {
      lines.push(`- Base ${candidate.label} ${candidate.baseOffset}: cursor=${candidate.cursorAfterHeader}, recordByteSize=${candidate.headerRecordByteSize}, groupCount=${candidate.headerGroupCount}, aligned=${candidate.layoutAlignedStrictPath}`);
    }
    lines.push("");
  }
  lines.push("## First Failures");
  lines.push("");
  for (const script of report.scripts) {
    lines.push(`### ${script.name}`);
    const failures = script.variable4CSearch.firstFailures || [];
    if (!failures.length) {
      lines.push("");
      lines.push("- No recorded failure samples.");
      lines.push("");
      continue;
    }
    lines.push("");
    for (const failure of failures.slice(0, 6)) {
      lines.push(`- ${failure.reason} at ${failure.offset || ""}, group=${failure.groupIndex ?? ""}, record=${failure.recordIndex ?? ""}, opcode=${failure.opcode ?? ""}, byte=${failure.byte || ""}`);
    }
    lines.push("");
  }
  lines.push("## Symbol Pool Evidence");
  lines.push("");
  lines.push("The tail command strings are evidence of a symbol/string pool, not executable order. Some commands are full length-prefixed atoms, while other visible strings are suffix fragments of a longer command token.");
  lines.push("");
  for (const script of report.scripts) {
    const exact = script.symbolPoolEvidence.exactLengthSlots.slice(0, 5)
      .map((item) => `${item.command}@${item.offset}`).join(", ") || "none";
    const fragments = script.symbolPoolEvidence.fragmentAliases
      .slice(0, 5)
      .map((item) => `${item.fragment}->${item.command}@${item.offset}/prev=${item.previousByte}`).join(", ") || "none";
    lines.push(`- ${script.name}: exact ${exact}; mixed fragments ${fragments}`);
  }
  lines.push("");
  lines.push("## Current Conclusion");
  lines.push("");
  lines.push("- The raw XSE envelope/header is stable, but the stream-base is not solved by choosing either the envelope prefix (`0x09`) or the `XSE0` magic pointer (`0x0A`).");
  lines.push("- The baseline 0x112C4 parser still fails the real opcode gate because most candidate opcodes are outside 0..8.");
  lines.push("- Widening only +0x4C to a 1..6 byte read does not recover a layout-aligned valid opcode stream for either tested stream-base candidate.");
  lines.push("- Next reverse-engineering target: emulate the exact stream object returned by [sb+0x35C4]+0x40 and [sb+0x35C0]+0x50, then re-check +0x50 compact token semantics against the real VM.");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function main(argv = process.argv.slice(2)) {
  const input = path.resolve(argv[0] || DEFAULT_INPUT);
  const outDir = path.resolve(argv[1] || DEFAULT_OUT);
  fs.mkdirSync(outDir, { recursive: true });
  const archive = loadCbeArchive(input);
  const layoutEnds = loadLayoutEnds();
  const scripts = FOCUS.map((name) => probeOne(archive, name, layoutEnds));
  const report = {
    schema: "nicai.cbe.xseVmGateProbe.v1",
    generatedAt: new Date().toISOString(),
    input,
    archiveEntryCount: archive.entries.length,
    focus: FOCUS,
    assumptions: {
      compactReader: "Current decodeCompactToken implementation is treated as [sb+0x35C4]+0x50.",
      variable4C: `Unresolved [sb+0x35C4]+0x4C is widened to 1..${MAX_4C_WIDTH} consumed bytes; value interpretation is intentionally ignored.`,
      opcodeGate: "The loader at 0x1148A requires raw opcode bytes to be < 9.",
      layoutAlignment: "A candidate must end within +/-16 bytes of the previous layout object boundary to count as a full stream recovery.",
    },
    scripts,
  };
  const jsonFile = path.join(outDir, "xse_vm_gate_probe.json");
  const mdFile = path.join(outDir, "xse_vm_gate_probe.md");
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
  readHeader,
  searchGate,
  symbolEvidence,
  probeOne,
};
