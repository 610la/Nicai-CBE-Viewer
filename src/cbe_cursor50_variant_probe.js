const fs = require("fs");
const path = require("path");
const { DEFAULT_INPUT, fixupPayload, loadCbeArchive } = require("./cbe_unpack");
const {
  findActorStreamDividers,
  hexBytes,
  parseActorHeader,
  parseResourceEnvelope,
} = require("./cbe_struct");

const DEFAULT_OUT = path.resolve(__dirname, "out_godwar_cursor50variants");
const LAYOUT_JSON = path.resolve(__dirname, "out_godwar_xselayout", "xse_layout_trace.json");
const ACTOR_FOCUS = [
  "heermode.actor",
  "nanna.actor",
  "fali.actor",
  "lang.actor",
  "boss_anjila_jineng.actor",
  "mingbing.actor",
  "jianmo.actor",
  "huoba.actor",
  "aoding.actor",
];
const XSE_FOCUS = ["s_01.xse", "s_02.xse", "s_03.xse", "s_04.xse"];
const MAX_STATES = 1024;
const MAX_TOTAL_RECORDS = 2048;
const MAX_SCALAR_WIDTH = 6;

const VARIANTS = [
  {
    id: "current",
    label: "current compact-token model",
    note: "tag<0x80 raw, 0x80/0x81 one unsigned payload byte, 0x82/0x83 signed big-endian, 0x84/0x85 signed little-endian, >0x85 signed one-byte negative",
    tag80: "unsigned",
    int16: "be-signed",
    int24: "be-signed",
    int32: "le-signed",
    high: "signed",
  },
  {
    id: "tag80-signed",
    label: "0x80/0x81 signed payload",
    note: "Only the one-byte payload form is sign-extended.",
    tag80: "signed",
    int16: "be-signed",
    int24: "be-signed",
    int32: "le-signed",
    high: "signed",
  },
  {
    id: "int16-le",
    label: "0x82 little-endian",
    note: "Only the 0x82 two-byte payload changes endian.",
    tag80: "unsigned",
    int16: "le-signed",
    int24: "be-signed",
    int32: "le-signed",
    high: "signed",
  },
  {
    id: "int16-unsigned",
    label: "0x82 unsigned big-endian",
    note: "Only the 0x82 two-byte payload changes signedness.",
    tag80: "unsigned",
    int16: "be-unsigned",
    int24: "be-signed",
    int32: "le-signed",
    high: "signed",
  },
  {
    id: "int24-le",
    label: "0x83 little-endian",
    note: "Only the 0x83 three-byte payload changes endian.",
    tag80: "unsigned",
    int16: "be-signed",
    int24: "le-signed",
    int32: "le-signed",
    high: "signed",
  },
  {
    id: "int24-unsigned",
    label: "0x83 unsigned big-endian",
    note: "Only the 0x83 three-byte payload changes signedness.",
    tag80: "unsigned",
    int16: "be-signed",
    int24: "be-unsigned",
    int32: "le-signed",
    high: "signed",
  },
  {
    id: "int32-be",
    label: "0x84/0x85 big-endian",
    note: "Only the 32-bit payload form changes endian.",
    tag80: "unsigned",
    int16: "be-signed",
    int24: "be-signed",
    int32: "be-signed",
    high: "signed",
  },
  {
    id: "high-unsigned",
    label: ">0x85 raw unsigned",
    note: "Treats high single-byte tags as unsigned raw bytes instead of signed negatives.",
    tag80: "unsigned",
    int16: "be-signed",
    int24: "be-signed",
    int32: "le-signed",
    high: "unsigned",
  },
  {
    id: "raw-unsigned",
    label: "raw byte control",
    note: "Consumes every byte as an unsigned one-byte value; this is a falsification/control variant.",
    rawOnly: true,
  },
];

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

function parseGifInfoBuffer(buf) {
  if (!buf || buf.length < 10 || buf.subarray(0, 3).toString("ascii") !== "GIF") return null;
  return {
    width: buf.readUInt16LE(6),
    height: buf.readUInt16LE(8),
  };
}

function signed8(value) {
  return value & 0x80 ? value - 0x100 : value;
}

function signed24(value) {
  return value & 0x800000 ? value - 0x1000000 : value;
}

function decodeVariantToken(stream, offset, variant) {
  if (offset >= stream.length) return null;
  const tag = stream[offset];
  if (variant.rawOnly) {
    return { offset, next: offset + 1, tag: "raw", value: tag, raw: byteHex(tag), unsigned32: tag };
  }
  if (tag < 0x80) {
    return { offset, next: offset + 1, tag: "raw", value: tag, raw: byteHex(tag), unsigned32: tag };
  }
  if ((tag === 0x80 || tag === 0x81) && offset + 1 < stream.length) {
    const byte = stream[offset + 1];
    return {
      offset,
      next: offset + 2,
      tag: byteHex(tag),
      value: variant.tag80 === "signed" ? signed8(byte) : byte,
      raw: hexBytes(stream.subarray(offset, offset + 2)),
      unsigned32: byte,
    };
  }
  if (tag === 0x82 && offset + 2 < stream.length) {
    const raw = stream.subarray(offset, offset + 3);
    const unsigned = variant.int16.startsWith("le")
      ? stream.readUInt16LE(offset + 1)
      : stream.readUInt16BE(offset + 1);
    const value = variant.int16.endsWith("unsigned")
      ? unsigned
      : (variant.int16.startsWith("le") ? stream.readInt16LE(offset + 1) : stream.readInt16BE(offset + 1));
    return { offset, next: offset + 3, tag: byteHex(tag), value, unsigned32: unsigned, raw: hexBytes(raw) };
  }
  if (tag === 0x83 && offset + 3 < stream.length) {
    const unsigned = variant.int24.startsWith("le")
      ? stream[offset + 1] | (stream[offset + 2] << 8) | (stream[offset + 3] << 16)
      : (stream[offset + 1] << 16) | (stream[offset + 2] << 8) | stream[offset + 3];
    const value = variant.int24.endsWith("unsigned") ? unsigned : signed24(unsigned);
    return {
      offset,
      next: offset + 4,
      tag: byteHex(tag),
      value,
      unsigned32: unsigned,
      raw: hexBytes(stream.subarray(offset, offset + 4)),
    };
  }
  if ((tag === 0x84 || tag === 0x85) && offset + 4 < stream.length) {
    const value = variant.int32.startsWith("be") ? stream.readInt32BE(offset + 1) : stream.readInt32LE(offset + 1);
    const unsigned = variant.int32.startsWith("be") ? stream.readUInt32BE(offset + 1) : stream.readUInt32LE(offset + 1);
    return {
      offset,
      next: offset + 5,
      tag: byteHex(tag),
      value,
      unsigned32: unsigned,
      raw: hexBytes(stream.subarray(offset, offset + 5)),
    };
  }
  if (tag > 0x85) {
    return {
      offset,
      next: offset + 1,
      tag: variant.high === "unsigned" ? "raw-high" : "s8",
      value: variant.high === "unsigned" ? tag : tag - 0x100,
      raw: byteHex(tag),
      unsigned32: tag,
    };
  }
  return { offset, next: offset + 1, tag: byteHex(tag), value: tag, raw: byteHex(tag), unsigned32: tag, truncated: true };
}

function readVariantTokenAt(stream, cursorRef, variant, limitValue = 0x7fffffff) {
  const token = decodeVariantToken(stream, cursorRef.value, variant);
  if (!token || token.truncated || Math.abs(token.value) > limitValue) return null;
  cursorRef.value = token.next;
  return {
    offset: hex(token.offset),
    numericOffset: token.offset,
    next: hex(token.next),
    width: token.next - token.offset,
    tag: token.tag,
    value: token.value,
    unsigned32: token.unsigned32 ?? null,
    raw: token.raw,
  };
}

function readRawByte(stream, cursor) {
  if (cursor >= stream.length) return null;
  return {
    offset: cursor,
    next: cursor + 1,
    value: stream[cursor],
    raw: byteHex(stream[cursor]),
    tag: "raw8",
  };
}

function readFourCompactReferenceTable(stream, variant) {
  const cursor = { value: 0 };
  const countToken = readVariantTokenAt(stream, cursor, variant, 1024);
  if (!countToken || countToken.value <= 0 || countToken.value > 512) return null;
  const records = [];
  let truncatedAtRecord = null;
  let truncatedReason = "";
  for (let i = 0; i < countToken.value; i += 1) {
    const fields = [];
    for (let field = 0; field < 4; field += 1) {
      const token = readVariantTokenAt(stream, cursor, variant);
      if (!token) {
        truncatedAtRecord = i;
        truncatedReason = `record ${i} field ${field}`;
        break;
      }
      fields.push(token);
    }
    if (truncatedAtRecord != null) break;
    records.push({ index: i, offset: fields[0]?.offset || "", fields });
  }
  return {
    method: "compact4",
    stride: null,
    countToken,
    records,
    afterRecords: cursor.value,
    truncatedAtRecord,
    truncatedReason,
  };
}

function readFixedStrideReferenceTable(stream, variant, stride) {
  const cursor = { value: 0 };
  const countToken = readVariantTokenAt(stream, cursor, variant, 1024);
  if (!countToken || countToken.value <= 0 || countToken.value > 512) return null;
  const start = cursor.value;
  const afterRecords = start + countToken.value * stride;
  if (afterRecords > stream.length) {
    return {
      method: `fixed${stride}`,
      stride,
      countToken,
      records: [],
      afterRecords: stream.length,
      truncatedAtRecord: Math.max(0, Math.floor((stream.length - start) / stride)),
      truncatedReason: `fixed stride ${stride} exceeds stream length`,
    };
  }
  return {
    method: `fixed${stride}`,
    stride,
    countToken,
    records: Array.from({ length: countToken.value }, (_, index) => ({ index })),
    afterRecords,
    truncatedAtRecord: null,
    truncatedReason: "",
  };
}

function decodeMatrixToken(token, slotCount) {
  const unsigned = token.unsigned32 == null ? (token.value >>> 0) : token.unsigned32 >>> 0;
  const pictureSlot = (unsigned >>> 28) & 0x0f;
  return {
    ...token,
    pictureSlot,
    payload24: unsigned & 0x00ffffff,
    slotInTable: slotCount ? pictureSlot < slotCount : null,
  };
}

function actorDividerSummary(stream, divider) {
  if (!divider) return null;
  return {
    offset: hex(divider.markerStart),
    markerBytes: hexBytes(stream.subarray(divider.markerStart, Math.min(stream.length, divider.markerStart + divider.markerLength))),
    preDataLength: divider.preDataLength,
    postLength: divider.postLength,
  };
}

function buildF222Attempt(stream, table, variant, imageInfo, ffCandidate) {
  if (!table) return null;
  const fieldsCursor = { value: table.afterRecords };
  const fields = [];
  let truncatedField = null;
  for (let i = 0; i < 4; i += 1) {
    const token = readVariantTokenAt(stream, fieldsCursor, variant, 4096);
    if (!token) {
      truncatedField = i;
      break;
    }
    fields.push(token);
  }

  const values = fields.map((field) => field.value);
  const [cellW, cellH, extentW, extentH] = values;
  const positive = values.length === 4 && values.every((value) => value > 0 && value <= 4096);
  const ceilColumns = positive && cellW ? Math.ceil(extentW / cellW) : 0;
  const ceilRows = positive && cellH ? Math.ceil(extentH / cellH) : 0;
  const matrixCells = ceilColumns * ceilRows;
  const matrixCursor = { value: fieldsCursor.value };
  const matrix = [];
  let matrixTruncatedAt = null;
  if (positive && matrixCells > 0 && matrixCells <= 4096) {
    for (let i = 0; i < matrixCells; i += 1) {
      const token = readVariantTokenAt(stream, matrixCursor, variant);
      if (!token) {
        matrixTruncatedAt = i;
        break;
      }
      matrix.push(decodeMatrixToken(token, table.countToken.value));
    }
  }

  const matrixEnd = matrixCursor.value;
  const targetDelta = imageInfo && positive
    ? Math.abs(extentW - imageInfo.width) + Math.abs(extentH - imageInfo.height)
    : null;
  const cellDelta = imageInfo && positive
    ? Math.abs(cellW - imageInfo.width) + Math.abs(cellH - imageInfo.height)
    : null;
  let score = 0;
  if (positive) score += 20;
  else score -= 40;
  if (table.truncatedAtRecord == null && table.records.length === table.countToken.value) score += 10;
  if (matrixCells > 0 && matrix.length === matrixCells) score += 30;
  if (matrixCells > 0 && matrixCells <= 256) score += 5;
  if (ffCandidate) {
    const diff = ffCandidate.markerStart - matrixEnd;
    if (diff === 0) score += 70;
    else if (Math.abs(diff) <= 4) score += 45;
    else if (diff > 0) score += Math.max(0, 30 - Math.floor(diff / 8));
    else score -= 20;
  }
  if (targetDelta != null) {
    if (targetDelta <= 4) score += 35;
    else if (targetDelta <= 16) score += 24;
    else if (targetDelta <= 64) score += 10;
  }
  if (table.stride === 8) score += 4;
  if (table.method === "compact4") score += 1;
  const validSlots = matrix.filter((token) => token.slotInTable === true).length;
  if (matrix.length) score += Math.round((validSlots / matrix.length) * 4);

  return {
    score,
    variant: variant.id,
    tableMethod: table.method,
    recordStride: table.stride,
    referenceTableApproximation: table.method === "compact4" ? "four compact tokens per +0x64 entry" : `${table.stride} raw bytes per +0x64 entry`,
    count: table.countToken.value,
    countRaw: table.countToken.raw,
    tableComplete: table.truncatedAtRecord == null && table.records.length === table.countToken.value,
    tableAfterOffset: hex(table.afterRecords),
    tableTruncatedAtRecord: table.truncatedAtRecord,
    tableTruncatedReason: table.truncatedReason,
    fieldsOffset: hex(table.afterRecords),
    fields: fields.map((field, index) => ({
      objectOffset: ["+0x00", "+0x04", "+0x08", "+0x0C"][index],
      role: ["cellW/divisor", "cellH/divisor", "extentW/dividend", "extentH/dividend"][index],
      ...field,
    })),
    truncatedField,
    grid: positive ? {
      extentW,
      extentH,
      cellW,
      cellH,
      ceilColumns,
      ceilRows,
      ceilCells: matrixCells,
    } : null,
    matrixEndOffset: hex(matrixEnd),
    matrixRead: matrix.length,
    matrixExpected: matrixCells,
    matrixTruncatedAt,
    bytesToFfCandidate: ffCandidate ? ffCandidate.markerStart - matrixEnd : null,
    image: imageInfo ? { ...imageInfo, extentDelta: targetDelta, cellDelta } : null,
    firstMatrixTokens: matrix.slice(0, 8),
    ffTokenCandidate: actorDividerSummary(stream, ffCandidate),
  };
}

function probeF222Variant(stream, variant, imageInfo) {
  const ffCandidate = findActorStreamDividers(stream)[0] || null;
  const tables = [];
  const compact = readFourCompactReferenceTable(stream, variant);
  if (compact) tables.push(compact);
  for (const stride of [4, 6, 8, 10, 12, 16]) {
    const table = readFixedStrideReferenceTable(stream, variant, stride);
    if (table && table.truncatedAtRecord == null) tables.push(table);
  }
  const attempts = tables
    .map((table) => buildF222Attempt(stream, table, variant, imageInfo, ffCandidate))
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || Math.abs(a.bytesToFfCandidate ?? 999999) - Math.abs(b.bytesToFfCandidate ?? 999999));
  return attempts[0] || null;
}

function readStableHeaderVariant(buf, baseOffset, variant) {
  let cursor = baseOffset + 6;
  const reads = [];

  function compact(label, limit = 4096) {
    const cursorRef = { value: cursor };
    const token = readVariantTokenAt(buf, cursorRef, variant, limit);
    if (!token) return null;
    cursor = cursorRef.value;
    reads.push({ label, ...token });
    return token;
  }

  function raw(label) {
    const token = readRawByte(buf, cursor);
    if (!token) return null;
    cursor = token.next;
    reads.push({
      label,
      offset: hex(token.offset),
      next: hex(token.next),
      width: 1,
      tag: token.tag,
      value: token.value,
      raw: token.raw,
    });
    return token;
  }

  const slotCapacityToken = compact("0x1131A +0x50 object+58 slot capacity");
  const field04 = slotCapacityToken ? compact("0x1136A +0x50 object+04") : null;
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
  const ok = Boolean(slotCapacityToken && field04 && field08Byte && field0C && typeByte && recordByteSize != null && groupCount);
  return {
    ok,
    variant: variant.id,
    baseOffset,
    cursor,
    cursorAfterHeader: hex(cursor),
    slotCapacity: slotCapacityToken?.value === 0 ? 0x80 : slotCapacityToken?.value,
    field04: field04?.value,
    field08Byte: field08Byte?.value,
    field0C: field0C?.value,
    typeByte: typeByte?.value,
    recordByteSize,
    recordByteSizeToken: recordByteSizeToken || null,
    groupCount: groupCount?.value,
    reads,
    warning: ok ? "" : "header did not decode with this +0x50 variant",
  };
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

function appendRead(state, read) {
  const sample = {
    kind: read.kind,
    label: read.label,
    offset: hex(read.offset),
    next: hex(read.next),
    width: read.width,
    raw: read.raw,
    tag: read.tag,
    value: read.value ?? null,
  };
  return {
    ...state,
    cursor: read.next,
    maxScalarWidth: read.kind.includes("+0x4C") ? Math.max(state.maxScalarWidth, read.width) : state.maxScalarWidth,
    readSamples: state.readSamples.length < 24 ? [...state.readSamples, sample] : state.readSamples,
  };
}

function branch50(buf, state, variant, label) {
  const token = decodeVariantToken(buf, state.cursor, variant);
  if (!token || token.truncated) return [];
  return [appendRead(state, {
    kind: "+0x50",
    label,
    offset: state.cursor,
    next: token.next,
    width: token.next - state.cursor,
    raw: token.raw,
    tag: token.tag,
    value: token.value,
  })];
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
  return state.totalRecords * 12 - distance - state.maxScalarWidth * 2;
}

function dedupeStates(states, targetEnd) {
  const byKey = new Map();
  for (const state of states) {
    const key = `${state.cursor}:${state.groupIndex ?? -1}:${state.totalRecords}:${state.maxScalarWidth}`;
    const prev = byKey.get(key);
    if (!prev || scoreState(state, targetEnd) > scoreState(prev, targetEnd)) byKey.set(key, state);
  }
  return Array.from(byKey.values())
    .sort((a, b) => scoreState(b, targetEnd) - scoreState(a, targetEnd))
    .slice(0, MAX_STATES);
}

function branchRecord(buf, state, groupIndex, recordIndex, variant) {
  const opcodeToken = readRawByte(buf, state.cursor);
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
      return { states: branch50(buf, base, variant, "opcode0 field+08"), failure: null };
    case 1:
      return { states: scalar4CBranches(buf, base.cursor, "opcode1 field+0C via +0x4C/0x934").map((read) => appendRead(base, read)), failure: null };
    case 2:
      return { states: branch50(buf, base, variant, "opcode2 field+08 then forced opcode=2"), failure: null };
    case 3:
      return { states: branch50(buf, base, variant, "opcode3 field+14"), failure: null };
    case 4: {
      const first = branch50(buf, base, variant, "opcode4 field+14");
      const out = [];
      for (const next of first) out.push(...branch50(buf, next, variant, "opcode4 field+04"));
      return { states: out, failure: null };
    }
    case 5:
      return { states: branch50(buf, base, variant, "opcode5 field+18"), failure: null };
    case 6:
      return { states: branch50(buf, base, variant, "opcode6 field+1C"), failure: null };
    case 7:
      return { states: branch50(buf, base, variant, "opcode7 field+20"), failure: null };
    case 8:
      return { states: branch50(buf, base, variant, "opcode8 field+24"), failure: null };
    default:
      return { states: [], failure: { reason: "unhandled opcode", offset: hex(opcodeToken.offset), opcode: opcodeToken.value, groupIndex, recordIndex } };
  }
}

function branchGroup(buf, state, groupIndex, targetEnd, variant) {
  const groupBranches = scalar4CBranches(buf, state.cursor, "group id via +0x4C/0x934");
  const failures = [];
  let out = [];
  for (const idRead of groupBranches) {
    const recordCountToken = readRawByte(buf, idRead.next);
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
            value: recordCount,
          },
        ].slice(0, 24)
        : state.readSamples,
    }];

    for (let recordIndex = 0; recordIndex < recordCount && states.length; recordIndex += 1) {
      const nextStates = [];
      for (const current of states) {
        const result = branchRecord(buf, current, groupIndex, recordIndex, variant);
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

function searchGateVariant(buf, header, targetEnd, variant) {
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
  }];
  const failures = [];
  for (let groupIndex = 0; groupIndex < header.groupCount && states.length; groupIndex += 1) {
    const nextStates = [];
    for (const state of states) {
      const result = branchGroup(buf, state, groupIndex, targetEnd, variant);
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
    successes: successes.slice(0, 6),
    firstFailures: failures.slice(0, 20),
  };
}

function loadLayoutEnds(file = LAYOUT_JSON) {
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

function probeActor(archive, name) {
  const entry = findEntry(archive, name);
  if (!entry) return { name, missing: true };
  const resource = readResource(archive, entry);
  const header = parseActorHeader(resource.fixed);
  if (!header) return { name, archiveEntry: entry.name, missingHeader: true };
  const gifEntry = findEntry(archive, header.compactName);
  const gif = gifEntry ? readResource(archive, gifEntry) : null;
  const imageInfo = gif ? parseGifInfoBuffer(gif.fixed) : null;
  const stream = resource.fixed.subarray(Math.min(header.streamOffset, resource.fixed.length));
  const variants = VARIANTS.map((variant) => ({
    id: variant.id,
    label: variant.label,
    best: probeF222Variant(stream, variant, imageInfo),
  })).sort((a, b) => (b.best?.score ?? -9999) - (a.best?.score ?? -9999));
  return {
    name,
    archiveEntry: entry.name,
    image: header.compactName,
    imageInfo,
    streamOffset: hex(header.streamOffset),
    streamLength: stream.length,
    winners: variants.filter((item) => (item.best?.score ?? -9999) === (variants[0]?.best?.score ?? -9999)).map((item) => item.id),
    variants,
  };
}

function probeXseScript(archive, name, layoutEnds) {
  const entry = findEntry(archive, name);
  if (!entry) return { name, missing: true };
  const resource = readResource(archive, entry);
  const buf = resource.fixed;
  const envelope = parseResourceEnvelope(buf);
  const xseMagic = buf.indexOf(Buffer.from("XSE0", "ascii"));
  const targetEnd = layoutEnds.map.get(normalizeName(name));
  const baseCandidates = [
    {
      label: "body-prefix",
      baseOffset: envelope.bodyOffset,
      reason: "Matches the established object-probe base: cursor starts at converted base + 6 and lands at 0x000F for focused XSE files.",
    },
  ];
  if (xseMagic >= 0 && xseMagic !== envelope.bodyOffset) {
    baseCandidates.push({
      label: "magic-pointer",
      baseOffset: xseMagic,
      reason: "Control candidate from the provider replay's magic pointer behavior; retained because SCE conversion lands at SCE2.",
    });
  }

  return {
    name,
    archiveEntry: entry.name,
    size: buf.length,
    envelope: {
      tag: envelope.tag,
      bodyOffset: hex(envelope.bodyOffset),
      declaredBodyLength: envelope.declaredBodyLength,
      lengthMatches: envelope.lengthMatches,
      xseMagicOffset: xseMagic >= 0 ? hex(xseMagic) : "",
    },
    layoutBoundary: {
      objectProbeEnd: Number.isFinite(targetEnd) ? hex(targetEnd) : "",
      source: layoutEnds.error ? "" : layoutEnds.file,
    },
    variants: VARIANTS.map((variant) => ({
      id: variant.id,
      label: variant.label,
      candidates: baseCandidates.map((candidate) => {
        const header = readStableHeaderVariant(buf, candidate.baseOffset, variant);
        const gate = searchGateVariant(buf, header, targetEnd, variant);
        return {
          label: candidate.label,
          reason: candidate.reason,
          baseOffset: hex(candidate.baseOffset),
          header: {
            ok: header.ok,
            cursorAfterHeader: header.cursorAfterHeader,
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
          gate,
        };
      }),
    })),
  };
}

function summarizeActorVariants(actors) {
  return VARIANTS.map((variant) => {
    const rows = actors
      .map((actor) => actor.variants?.find((item) => item.id === variant.id))
      .filter(Boolean);
    const scores = rows.map((row) => row.best?.score ?? -9999);
    const wins = actors.filter((actor) => actor.winners?.includes(variant.id)).length;
    const plausible = rows.filter((row) => row.best?.grid && row.best.matrixRead === row.best.matrixExpected).length;
    return {
      id: variant.id,
      label: variant.label,
      wins,
      actorCount: rows.length,
      plausibleActorCount: plausible,
      averageScore: scores.length ? Number((scores.reduce((sum, value) => sum + value, 0) / scores.length).toFixed(2)) : null,
      bestScore: scores.length ? Math.max(...scores) : null,
    };
  }).sort((a, b) => b.wins - a.wins || (b.averageScore ?? -9999) - (a.averageScore ?? -9999));
}

function summarizeXseVariants(scripts) {
  return VARIANTS.map((variant) => {
    const perScript = scripts.map((script) => {
      const row = script.variants?.find((item) => item.id === variant.id);
      const candidates = row?.candidates || [];
      const best = candidates
        .flatMap((candidate) => (candidate.gate?.successes || []).map((success) => ({
          ...success,
          candidateLabel: candidate.label,
          baseOffset: candidate.baseOffset,
          header: candidate.header,
        })))
        .sort((a, b) => {
          const ad = Number.isFinite(a.layoutEndDelta) ? Math.abs(a.layoutEndDelta) : 999999;
          const bd = Number.isFinite(b.layoutEndDelta) ? Math.abs(b.layoutEndDelta) : 999999;
          return ad - bd || b.totalRecords - a.totalRecords;
        })[0] || null;
      return {
        name: script.name,
        headerOk: candidates.some((candidate) => candidate.header?.ok),
        strict: candidates.some((candidate) => candidate.gate?.anyStrictOpcodePath),
        aligned: candidates.some((candidate) => candidate.gate?.layoutAlignedStrictPath),
        bestEnd: best?.endOffset || "",
        bestDelta: best?.layoutEndDelta ?? null,
        bestBase: best?.candidateLabel || "",
        groupCount: best?.header?.groupCount ?? candidates.find((candidate) => candidate.header?.ok)?.header?.groupCount ?? null,
      };
    });
    return {
      id: variant.id,
      label: variant.label,
      scriptCount: perScript.length,
      headerOkCount: perScript.filter((item) => item.headerOk).length,
      strictCount: perScript.filter((item) => item.strict).length,
      alignedCount: perScript.filter((item) => item.aligned).length,
      bestAligned: perScript.filter((item) => item.aligned).map((item) => item.name),
      perScript,
    };
  }).sort((a, b) => b.alignedCount - a.alignedCount || b.strictCount - a.strictCount || b.headerOkCount - a.headerOkCount);
}

function buildConclusion(actorSummary, xseSummary) {
  const actorBest = actorSummary[0] || null;
  const xseBest = xseSummary[0] || null;
  const anyAligned = xseSummary.some((item) => item.alignedCount > 0);
  const currentActor = actorSummary.find((item) => item.id === "current");
  const currentXse = xseSummary.find((item) => item.id === "current");
  const topActorIds = actorBest
    ? actorSummary
      .filter((item) => item.wins === actorBest.wins && item.averageScore === actorBest.averageScore)
      .map((item) => item.id)
    : [];
  const currentWinsActor = currentActor && topActorIds.includes("current");
  const actorFinding = topActorIds.length > 1
    ? `The current compact-token primitive ties for the strongest actor 0x0F222 oracle (${topActorIds.join(", ")}).`
    : "The current compact-token primitive is the strongest actor 0x0F222 oracle.";

  if (!anyAligned && currentWinsActor) {
    return {
      currentFinding: `${actorFinding} No tested endian/signedness +0x50 variant produces a layout-aligned XSE 0x112C4 opcode path.`,
      emulatorImpact: "This shifts the blocker away from a simple +0x50 primitive endian/signedness tweak and toward the XSE converted-stream object state, base/cursor contract, or object-table grammar after the provider/open/convert chain.",
      nextTarget: "Trace the live [35C4]+50 method body/object state instead of widening token variants; keep the actor F222 oracle as the sibling-reader regression test.",
      actorBest: actorBest.id,
      actorBestTies: topActorIds,
      xseBest: xseBest?.id || "",
      currentXseStrictCount: currentXse?.strictCount ?? 0,
    };
  }
  if (anyAligned) {
    return {
      currentFinding: `At least one +0x50 variant produced a layout-aligned XSE path; best current candidate is ${xseBest.id}.`,
      emulatorImpact: "The aligned variant must be checked against actor F222 and the real method body before being accepted as executable VM semantics.",
      nextTarget: `Audit ${xseBest.id} against disassembly and sibling parsers, then replay 0x112C4 with that exact method model.`,
      actorBest: actorBest?.id || "",
      actorBestTies: topActorIds,
      xseBest: xseBest.id,
      currentXseStrictCount: currentXse?.strictCount ?? 0,
    };
  }
  return {
    currentFinding: "No tested +0x50 token variant creates an executable XSE path; actor evidence is inconclusive across variants.",
    emulatorImpact: "The emulator still needs live reader-service reconstruction before script execution can be accepted.",
    nextTarget: "Resolve the live [35C4]+50 method body and converted stream state.",
    actorBest: actorBest?.id || "",
    actorBestTies: topActorIds,
    xseBest: xseBest?.id || "",
    currentXseStrictCount: currentXse?.strictCount ?? 0,
  };
}

function buildReport(options = {}) {
  const input = path.resolve(options.input || DEFAULT_INPUT);
  const archive = loadCbeArchive(input);
  const layoutEnds = loadLayoutEnds();
  const actors = ACTOR_FOCUS.map((name) => probeActor(archive, name));
  const scripts = XSE_FOCUS.map((name) => probeXseScript(archive, name, layoutEnds));
  const actorSummary = summarizeActorVariants(actors);
  const xseSummary = summarizeXseVariants(scripts);
  return {
    schema: "nicai.cbe.cursor50VariantProbe.v1",
    generatedAt: new Date().toISOString(),
    input,
    variants: VARIANTS.map((variant) => ({ id: variant.id, label: variant.label, note: variant.note || "" })),
    actors,
    scripts,
    summary: {
      actorVariants: actorSummary,
      xseVariants: xseSummary,
    },
    conclusion: buildConclusion(actorSummary, xseSummary),
  };
}

function mdRow(values) {
  return `| ${values.map((value) => String(value ?? "").replace(/\|/g, "\\|")).join(" | ")} |`;
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# Cursor +0x50 Variant Probe");
  lines.push("");
  lines.push(`- Input CBE: \`${report.input}\``);
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push("");
  lines.push("## Current Conclusion");
  lines.push("");
  lines.push(`- ${report.conclusion.currentFinding}`);
  lines.push(`- ${report.conclusion.emulatorImpact}`);
  lines.push(`- Next: ${report.conclusion.nextTarget}`);
  lines.push("");
  lines.push("## Actor 0x0F222 Oracle");
  lines.push("");
  lines.push(mdRow(["Variant", "Wins", "Plausible actors", "Average score", "Best score"]));
  lines.push(mdRow(["---", "---:", "---:", "---:", "---:"]));
  for (const item of report.summary.actorVariants) {
    lines.push(mdRow([item.id, item.wins, `${item.plausibleActorCount}/${item.actorCount}`, item.averageScore, item.bestScore]));
  }
  for (const actor of report.actors) {
    lines.push("");
    lines.push(`### ${actor.name}`);
    if (actor.missing || actor.missingHeader) {
      lines.push("- missing actor/header");
      continue;
    }
    lines.push(`- Image: ${actor.image} ${actor.imageInfo ? `${actor.imageInfo.width}x${actor.imageInfo.height}` : ""}; stream=${actor.streamOffset}, len=${actor.streamLength}`);
    const bestRows = (actor.variants || []).slice(0, 4);
    for (const row of bestRows) {
      const best = row.best;
      if (!best) {
        lines.push(`- ${row.id}: no parse`);
        continue;
      }
      const fields = (best.fields || []).map((field) => `${field.value}(${field.raw})`).join(" ");
      const grid = best.grid ? `${best.grid.cellW}x${best.grid.cellH} extent=${best.grid.extentW}x${best.grid.extentH} cells=${best.grid.ceilCells}` : "-";
      lines.push(`- ${row.id}: score=${best.score}, table=${best.tableMethod}${best.recordStride ? `/${best.recordStride}` : ""}, fields@${best.fieldsOffset} ${fields}, ${grid}, matrix=${best.matrixRead}/${best.matrixExpected}, bytesToFf=${best.bytesToFfCandidate ?? "-"}`);
    }
  }
  lines.push("");
  lines.push("## XSE 0x112C4 Gate");
  lines.push("");
  lines.push(mdRow(["Variant", "Header ok", "Strict paths", "Aligned paths", "Aligned scripts"]));
  lines.push(mdRow(["---", "---:", "---:", "---:", "---"]));
  for (const item of report.summary.xseVariants) {
    lines.push(mdRow([item.id, `${item.headerOkCount}/${item.scriptCount}`, `${item.strictCount}/${item.scriptCount}`, `${item.alignedCount}/${item.scriptCount}`, item.bestAligned.join(", ")]));
  }
  for (const script of report.scripts) {
    lines.push("");
    lines.push(`### ${script.name}`);
    lines.push(`- Layout end: ${script.layoutBoundary?.objectProbeEnd || "-"}; body=${script.envelope?.bodyOffset || "-"}; XSE0=${script.envelope?.xseMagicOffset || "-"}`);
    const rows = report.summary.xseVariants
      .map((variant) => ({ variant: variant.id, ...variant.perScript.find((item) => item.name === script.name) }))
      .filter((item) => item.name);
    for (const row of rows.slice(0, 5)) {
      const status = row.aligned ? "aligned" : (row.strict ? "strict/shallow" : (row.headerOk ? "header-only" : "blocked"));
      lines.push(`- ${row.variant}: ${status}, group=${row.groupCount ?? "-"}, best=${row.bestEnd || "-"}, delta=${row.bestDelta ?? "-"}, base=${row.bestBase || "-"}`);
    }
  }
  lines.push("");
  lines.push("## Variant Definitions");
  for (const variant of report.variants) {
    lines.push(`- ${variant.id}: ${variant.note || variant.label}`);
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
  const jsonFile = path.join(outDir, "cursor50_variant_probe.json");
  const mdFile = path.join(outDir, "cursor50_variant_probe.md");
  writeJson(jsonFile, report);
  fs.writeFileSync(mdFile, renderMarkdown(report), "utf8");
  console.log(`wrote ${jsonFile}`);
  console.log(`wrote ${mdFile}`);
}

if (require.main === module) {
  main();
}

module.exports = {
  VARIANTS,
  buildReport,
  decodeVariantToken,
  renderMarkdown,
};
