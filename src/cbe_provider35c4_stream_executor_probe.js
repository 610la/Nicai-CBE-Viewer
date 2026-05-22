const fs = require("fs");
const path = require("path");
const { DEFAULT_INPUT, fixupPayload, loadCbeArchive } = require("./cbe_unpack");
const { decodeCompactToken, hexBytes, parseResourceEnvelope } = require("./cbe_struct");
const { Provider35C4ServiceObject } = require("./cbe_provider35c4_service_object_probe");
const { buildReport: buildLiveCallReport } = require("./cbe_provider35c4_live_call_probe");

const DEFAULT_OUT = path.resolve(__dirname, "out_godwar_provider35c4streamexec");
const XSE_REF64_LOADER_JSON = path.resolve(__dirname, "out_godwar_xseref64loader", "xse_ref64_loader_probe.json");
const FOCUS_XSE = ["s_01.xse", "s_02.xse", "s_03.xse", "s_04.xse"];

function hex(n, width = 4) {
  if (!Number.isFinite(n) || n < 0) return "";
  return `0x${n.toString(16).toUpperCase().padStart(width, "0")}`;
}

function parseHex(text) {
  return typeof text === "string" && /^0x/i.test(text) ? parseInt(text, 16) : NaN;
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

function mdRow(values) {
  return `| ${values.map((value) => String(value ?? "").replace(/\|/g, "\\|")).join(" | ")} |`;
}

function normalizeLabel(label) {
  return String(label || "").trim().toLowerCase();
}

function findEntry(archive, name) {
  const target = normalizeName(name);
  return archive.entries.find((entry) => normalizeName(entry.name) === target) || null;
}

function readResource(archive, entry) {
  const raw = archive.rawPayload(entry);
  const fixed = fixupPayload(entry.name, raw);
  return {
    name: entry.name,
    raw,
    fixed: fixed.payload,
    fixupNote: fixed.note || "",
  };
}

function loadProviderRefSamples(file = XSE_REF64_LOADER_JSON) {
  const report = JSON.parse(fs.readFileSync(file, "utf8"));
  const map = new Map();
  for (const script of report.scripts || []) {
    const top = script.candidates?.[0] || null;
    const rows = [];
    const selected = top?.samples?.selectedEntry;
    if (selected?.refOffset) {
      rows.push({
        role: "range selected entry ref",
        context: "xse-range-entry-ref",
        entry: selected.index,
        refOffset: selected.refOffset,
        raw: selected.refRaw || "",
        lengthTextStatus: selected.lengthTextStatus || "",
      });
    }
    for (const entry of top?.samples?.firstEntries || []) {
      if (!entry?.refOffset || rows.some((row) => row.refOffset === entry.refOffset && row.context === "xse-range-entry-ref")) continue;
      rows.push({
        role: "range sample entry ref",
        context: "xse-range-entry-ref",
        entry: entry.index,
        refOffset: entry.refOffset,
        raw: entry.refRaw || "",
        lengthTextStatus: entry.lengthTextStatus || "",
      });
      if (rows.filter((row) => row.context === "xse-range-entry-ref").length >= 3) break;
    }
    for (const ref of top?.finalRefSamples || []) {
      rows.push({
        role: "final ref table sample",
        context: "xse-final-ref",
        entry: ref.index,
        refOffset: ref.offset,
        raw: ref.raw || "",
        lengthTextStatus: ref.lengthTextStatus || "",
      });
      if (rows.filter((row) => row.context === "xse-final-ref").length >= 2) break;
    }
    map.set(normalizeName(script.name), rows);
  }
  return { file, map };
}

class ProviderRefAllocator {
  constructor() {
    this.refs = [];
    this.byKey = new Map();
  }

  key(ref) {
    return [
      ref.context || "",
      ref.resource || "",
      ref.policy || "",
      ref.offset || "",
      ref.rawSample || ref.text || "",
    ].join("|");
  }

  register(ref) {
    const key = this.key(ref);
    let row = this.byKey.get(key);
    if (!row) {
      row = {
        providerRefId: `ref${String(this.refs.length + 1).padStart(3, "0")}`,
        ...ref,
      };
      this.refs.push(row);
      this.byKey.set(key, row);
    }
    row.observedCount = (row.observedCount || 0) + 1;
    return row;
  }
}

class ParsedProvider35C4StreamExecutor {
  constructor(options = {}) {
    this.service = options.service || new Provider35C4ServiceObject({
      observedMatches: options.observedMatches || [],
      observationSink: options.observationSink,
    });
    this.refAllocator = new ProviderRefAllocator();
    this.rows = [];
    this.callSeq = 0;
    this.streams = [];
  }

  nextSeq() {
    this.callSeq += 1;
    return this.callSeq;
  }

  recordRow(event, result, opBefore) {
    const op = this.service.operations[opBefore] || {};
    this.rows.push({
      callSeq: event.sourceSeq,
      method: event.slot,
      dispatchShape: op.dispatchShape || "",
      capturePointId: event.capturePointId || "",
      resource: event.resource || "",
      policy: event.policy || "",
      context: event.context || "",
      role: event.role || "",
      offset: event.offset || "",
      providerRefId: event.providerRefId || result?.providerRefId || "",
      callerLabel: event.callerLabel || "",
      serviceReturnValue: event.tapeKind === "label-ref-consumer" ? result : op.resultValue,
      resultValue: op.resultValue,
      opSeq: op.opSeq,
      status: "parsed-stream-call-ok",
    });
  }

  emitRef(event) {
    const opBefore = this.service.operations.length;
    const result = this.service.readProviderRef(event);
    this.recordRow(event, result, opBefore);
    return result;
  }

  emitCursorRead(event) {
    const opBefore = this.service.operations.length;
    const result = this.service.readCursor(event);
    this.recordRow(event, result, opBefore);
    return result;
  }

  emitCompare(event) {
    const opBefore = this.service.operations.length;
    const result = this.service.compareLabelRef(event);
    this.recordRow(event, result, opBefore);
    return result;
  }

  open(resource) {
    const opened = {
      resourceName: resource.name,
      raw: resource.fixed,
      envelope: parseResourceEnvelope(resource.fixed),
    };
    this.streams.push({
      action: "open",
      resource: resource.name,
      bodyOffset: hex(opened.envelope.bodyOffset),
      first16: hexBytes(resource.fixed.subarray(0, 16)),
    });
    return opened;
  }

  candidateBases(opened) {
    const raw = opened.raw;
    const sceMagic = raw.indexOf(Buffer.from("SCE2", "ascii"));
    const xseMagic = raw.indexOf(Buffer.from("XSE0", "ascii"));
    const out = [];
    if (sceMagic >= 0) {
      out.push({
        policy: "sce-magic",
        baseOffset: sceMagic,
        magic: "SCE2",
      });
    }
    if (xseMagic >= 0) {
      out.push({
        policy: "xse-body-prefix",
        baseOffset: opened.envelope.bodyOffset,
        magic: raw.subarray(xseMagic, xseMagic + 4).toString("ascii"),
      });
      out.push({
        policy: "xse-magic-pointer",
        baseOffset: xseMagic,
        magic: "XSE0",
      });
    }
    if (!out.length) {
      out.push({
        policy: "envelope-body",
        baseOffset: opened.envelope.bodyOffset,
        magic: "",
      });
    }
    return out;
  }

  convert(opened, policy) {
    const selected = this.candidateBases(opened).find((candidate) => candidate.policy === policy);
    if (!selected) throw new Error(`conversion policy ${policy} not available for ${opened.resourceName}`);
    const converted = {
      resourceName: opened.resourceName,
      raw: opened.raw,
      envelope: opened.envelope,
      baseOffset: selected.baseOffset,
      baseOffsetHex: hex(selected.baseOffset),
      policy: selected.policy,
      magic: selected.magic,
    };
    this.streams.push({
      action: "convert",
      resource: opened.resourceName,
      policy: converted.policy,
      baseOffset: converted.baseOffsetHex,
      magic: converted.magic,
    });
    return converted;
  }

  readU16(converted, cursor) {
    const offset = converted.baseOffset + cursor.value;
    if (offset + 2 > converted.raw.length) throw new Error(`truncated u16 at ${hex(offset)}`);
    const value = converted.raw.readUInt16LE(offset);
    cursor.value += 2;
    return value;
  }

  readRawByte(converted, cursor) {
    const offset = converted.baseOffset + cursor.value;
    if (offset >= converted.raw.length) throw new Error(`truncated byte at ${hex(offset)}`);
    const value = converted.raw[offset];
    cursor.value += 1;
    return value;
  }

  readCompact(converted, cursor, role, capturePointId = "provider35c4-stream-read-1", limit = 0x7fffffff) {
    const offset = converted.baseOffset + cursor.value;
    const token = decodeCompactToken(converted.raw, offset);
    if (!token || token.truncated || Math.abs(token.value) > limit) {
      throw new Error(`compact read failed at ${hex(offset)} for ${role}`);
    }
    const event = {
      sourceSeq: this.nextSeq(),
      tapeKind: "cursor-read",
      slot: "+0x50",
      capturePointId,
      resource: converted.resourceName,
      policy: converted.policy,
      role,
      cursorBefore: hex(token.offset - converted.baseOffset),
      offset: hex(offset),
      rawSample: token.raw,
      value: token.value,
      nextCursor: hex(token.next - converted.baseOffset),
    };
    this.emitCursorRead(event);
    cursor.value = token.next - converted.baseOffset;
    return {
      offset: hex(offset),
      cursorBefore: hex(token.offset - converted.baseOffset),
      nextCursor: hex(cursor.value),
      tag: token.tag,
      value: token.value,
      raw: token.raw,
    };
  }

  readSceResourceRef(converted, cursor, role) {
    const offset = converted.baseOffset + cursor.value;
    if (offset >= converted.raw.length) throw new Error(`truncated ref length at ${hex(offset)}`);
    const length = converted.raw[offset];
    const start = offset + 1;
    const end = start + length;
    if (end > converted.raw.length) throw new Error(`truncated ref body at ${hex(start)}`);
    const text = converted.raw.subarray(start, end).toString("ascii");
    const ref = this.refAllocator.register({
      context: "sce-resource-name",
      resource: converted.resourceName,
      policy: converted.policy,
      role,
      cursorBefore: hex(cursor.value),
      offset: hex(offset),
      text,
      rawSample: "",
    });
    const event = {
      sourceSeq: this.nextSeq(),
      tapeKind: "ref-producer",
      slot: "+0x64",
      capturePointId: "provider35c4-sce-resource-ref",
      resource: converted.resourceName,
      policy: converted.policy,
      context: ref.context,
      providerRefId: ref.providerRefId,
      cursorBefore: ref.cursorBefore,
      offset: ref.offset,
      rawSample: "",
      text,
    };
    this.emitRef(event);
    cursor.value += 1 + length;
    return text;
  }

  readOpaqueProviderRef(converted, cursorValue, sample) {
    const offset = converted.baseOffset + cursorValue;
    const rawSample = hexBytes(converted.raw.subarray(offset, Math.min(converted.raw.length, offset + 12)));
    const capturePointId = sample.context === "xse-final-ref"
      ? "provider35c4-xse-final-ref"
      : "provider35c4-xse-range-ref";
    const ref = this.refAllocator.register({
      context: sample.context,
      resource: converted.resourceName,
      policy: converted.policy,
      role: sample.role || "",
      cursorBefore: hex(cursorValue),
      offset: hex(offset),
      rawSample,
      text: "",
    });
    const event = {
      sourceSeq: this.nextSeq(),
      tapeKind: "ref-producer",
      slot: "+0x64",
      capturePointId,
      resource: converted.resourceName,
      policy: converted.policy,
      context: ref.context,
      providerRefId: ref.providerRefId,
      cursorBefore: ref.cursorBefore,
      offset: ref.offset,
      rawSample,
      text: "",
    };
    this.emitRef(event);
    return {
      ...ref,
      rawSample,
    };
  }

  compareLabelRef(converted, ref, label, role, metadata = {}) {
    const event = {
      sourceSeq: this.nextSeq(),
      tapeKind: "label-ref-consumer",
      slot: "+0x50",
      capturePointId: "provider35c4-label-ref-compare-1",
      resource: converted.resourceName,
      policy: converted.policy,
      context: ref.context,
      providerRefId: ref.providerRefId,
      callerLabel: label,
      normalizedLabel: normalizeLabel(label),
      offset: ref.offset,
      rawSample: ref.rawSample || "",
      returnValue: 1,
      role,
      ...metadata,
    };
    return this.emitCompare(event);
  }
}

function readXseHeaderViaParsedStream(executor, converted) {
  const cursor = { value: 6 };
  const reads = [];
  function compact(label, limit = 4096) {
    try {
      const token = executor.readCompact(converted, cursor, label, "provider35c4-stream-read-1", limit);
      reads.push({ label, ...token });
      return token;
    } catch (err) {
      reads.push({ label, error: err.message || String(err), cursor: hex(cursor.value) });
      return null;
    }
  }
  function raw(label) {
    try {
      const value = executor.readRawByte(converted, cursor);
      reads.push({ label, value, raw: byteHex(value), nextCursor: hex(cursor.value) });
      return value;
    } catch (err) {
      reads.push({ label, error: err.message || String(err), cursor: hex(cursor.value) });
      return null;
    }
  }

  const slotCapacityToken = compact("0x1131A +0x50 object+58 slot capacity");
  const field04 = slotCapacityToken ? compact("0x1136A +0x50 object+04") : null;
  const field08Byte = field04 ? raw("0x11382 raw object+08 byte") : null;
  const field0C = field08Byte != null ? compact("0x11392 +0x50 object+0C") : null;
  const typeByte = field0C ? raw("0x113A8 raw type byte") : null;
  let recordByteSizeToken = null;
  let recordByteSize = null;
  if (typeByte != null) {
    recordByteSize = { 1: 0x14, 2: 0x28, 3: 0x50 }[typeByte] || null;
    if (recordByteSize == null) {
      recordByteSizeToken = compact("0x113B2 +0x50 explicit record byte size");
      recordByteSize = recordByteSizeToken?.value ?? null;
    }
  }
  const groupCount = recordByteSizeToken || recordByteSize != null
    ? compact("0x113F2 +0x50 group count")
    : null;
  return {
    ok: Boolean(slotCapacityToken && field04 && field08Byte != null && field0C && typeByte != null && recordByteSize != null && groupCount),
    cursorAfterHeader: hex(cursor.value),
    recordByteSize,
    groupCount: groupCount?.value,
    reads,
  };
}

function replaySce(archive, executor, name = "guangmingshendian.sce") {
  const entry = findEntry(archive, name);
  if (!entry) return { status: "missing", name };
  const resource = readResource(archive, entry);
  const opened = executor.open(resource);
  const converted = executor.convert(opened, "sce-magic");
  const cursor = { value: 4 };
  const width = executor.readU16(converted, cursor);
  const height = executor.readU16(converted, cursor);
  const mapCount = executor.readU16(converted, cursor);
  const maps = [];
  for (let i = 0; i < mapCount && i < 8; i += 1) {
    const mapName = executor.readSceResourceRef(converted, cursor, `map ${i} resource`);
    const fields = [
      executor.readU16(converted, cursor),
      executor.readU16(converted, cursor),
      executor.readU16(converted, cursor),
      executor.readU16(converted, cursor),
    ];
    maps.push({ name: mapName, fields });
  }
  return {
    status: converted.magic === "SCE2" && width > 0 && height > 0 ? "parsed-sce-stream-ok" : "parsed-sce-stream-risk",
    resource: entry.name,
    converted: {
      policy: converted.policy,
      baseOffset: converted.baseOffsetHex,
      magic: converted.magic,
    },
    fields: { width, height, mapCount },
    maps,
    cursorEnd: hex(cursor.value),
  };
}

function replayXse(archive, executor, providerRefSamples) {
  const scripts = [];
  for (const name of FOCUS_XSE) {
    const entry = findEntry(archive, name);
    if (!entry) {
      scripts.push({ name, missing: true });
      continue;
    }
    const resource = readResource(archive, entry);
    const opened = executor.open(resource);
    const candidates = executor.candidateBases(opened).filter((candidate) => candidate.policy.startsWith("xse-"));
    scripts.push({
      name,
      resource: entry.name,
      candidates: candidates.map((candidate) => {
        const converted = executor.convert(opened, candidate.policy);
        const beforeOps = executor.service.operations.length;
        const header = readXseHeaderViaParsedStream(executor, converted);
        const samples = (providerRefSamples.map.get(normalizeName(name)) || []).map((sample) => {
          const refOffset = parseHex(sample.refOffset);
          const cursorValue = refOffset - converted.baseOffset;
          if (!Number.isFinite(refOffset) || cursorValue < 0 || refOffset >= converted.raw.length) {
            return {
              ...sample,
              status: "ref-sample-out-of-converted-range",
              convertedBase: converted.baseOffsetHex,
            };
          }
          const ref = executor.readOpaqueProviderRef(converted, cursorValue, sample);
          const compareSamples = sample.context === "xse-range-entry-ref"
            ? ["Init", "_main"].map((label) => ({
              label,
              returnValue: executor.compareLabelRef(converted, ref, label, `sample ${sample.context} compare`),
            }))
            : [];
          return {
            ...sample,
            status: "parsed-provider-ref-sampled",
            convertedBase: converted.baseOffsetHex,
            cursorBefore: ref.cursorBefore,
            serviceOffset: ref.offset,
            rawSample: ref.rawSample,
            providerRefId: ref.providerRefId,
            compareSamples,
          };
        });
        return {
          policy: candidate.policy,
          baseOffset: hex(candidate.baseOffset),
          magic: candidate.magic,
          header,
          providerRefContextSamples: samples,
          serviceOperationCount: executor.service.operations.length - beforeOps,
        };
      }),
    });
  }
  return {
    status: "parsed-xse-stream-sampled",
    scripts,
  };
}

function rowSignature(rows) {
  return rows.map((row) => [
    row.method,
    row.dispatchShape,
    row.providerRefId || "",
    row.callerLabel || "",
    row.serviceReturnValue ?? "",
  ].join("|")).join("\n");
}

function operationSignature(ops) {
  return ops.map((op) => [
    op.method,
    op.dispatchShape,
    op.providerRefId || "",
    op.callerLabel || "",
    op.resultValue ?? "",
    op.offset || "",
  ].join("|")).join("\n");
}

function buildInvariant(id, passed, details, impact = "") {
  return { id, passed: Boolean(passed), details, impact };
}

function buildReport(options = {}) {
  const input = path.resolve(options.input || DEFAULT_INPUT);
  const archive = loadCbeArchive(input);
  const providerRefSamples = loadProviderRefSamples();
  const executor = new ParsedProvider35C4StreamExecutor({
    observationSink: options.observationSink,
    observedMatches: options.observedMatches || [],
  });
  const sce = replaySce(archive, executor);
  const xse = replayXse(archive, executor, providerRefSamples);
  const liveCall = buildLiveCallReport({ input });
  const expectedRows = liveCall.replayRows || [];
  const producerOps = executor.service.operations.filter((op) => op.dispatchShape === "provider-ref-producer");
  const cursorReadOps = executor.service.operations.filter((op) => op.dispatchShape === "stream-cursor-read");
  const compareOps = executor.service.operations.filter((op) => op.dispatchShape === "label-ref-compare");
  const methodShapes = Array.from(new Set(executor.service.operations.map((op) => `${op.method}:${op.dispatchShape}`))).sort();
  const return0CompareOps = compareOps.filter((op) => op.resultValue === 0);
  const missingRefs = compareOps.filter((op) => !op.refKnown);
  const lateRefs = compareOps.filter((op) => op.refKnown && !(op.refProducerSeq < op.sourceSeq));
  const rowParity = rowSignature(executor.rows) === rowSignature(expectedRows);
  const operationParity = operationSignature(executor.service.operations) === operationSignature(liveCall.operations || []);
  const invariants = [
    buildInvariant(
      "parsed-stream-generates-live-call-count",
      executor.rows.length === expectedRows.length,
      `${executor.rows.length} parsed call(s), ${expectedRows.length} ABI-shim live-call row(s)`,
      "The parsed stream executor should cover the same current provider 0x35C4 method surface before replacing the trace feeder."
    ),
    buildInvariant(
      "parsed-stream-signature-parity",
      rowParity && operationParity,
      `rowSignature=${rowParity ? "same" : "different"}, operationSignature=${operationParity ? "same" : "different"}`,
      "The direct raw-resource stream path must match the prior ABI-shim call feeder without reading traceEvents as input."
    ),
    buildInvariant(
      "plus50-shapes-stay-split",
      methodShapes.includes("+0x50:stream-cursor-read") && methodShapes.includes("+0x50:label-ref-compare"),
      methodShapes.join(", "),
      "The parsed executor must preserve the +0x50 argument-shape branch."
    ),
    buildInvariant(
      "compare-refs-known-and-prior",
      missingRefs.length === 0 && lateRefs.length === 0,
      `${compareOps.length} compare op(s), ${missingRefs.length} missing ref(s), ${lateRefs.length} late ref(s)`,
      "Parsed label/ref compare calls must consume prior +0x64 provider handles."
    ),
    buildInvariant(
      "empty-feed-keeps-parsed-stream-nonmatch",
      return0CompareOps.length === 0,
      `${return0CompareOps.length} return-0 compare(s)`,
      "Visible XSE effects remain disabled until real provider observations produce return-0 compares."
    ),
  ];
  const failures = invariants.filter((item) => !item.passed);
  return {
    schema: "nicai.cbe.provider35c4StreamExecutorProbe.v1",
    generatedAt: new Date().toISOString(),
    input,
    inputs: {
      rawCbeArchive: input,
      provider35c4ServiceObject: "Provider35C4ServiceObject",
      providerRefSamples: providerRefSamples.file,
      liveCallParityOnly: "cbe_provider35c4_live_call_probe.buildReport({ input })",
    },
    streamContract: {
      sourceMode: "parsed-resource-stream-feeder",
      serviceGlobal: executor.service.global,
      allowedMethods: ["+0x64", "+0x50"],
      methodShapes,
      traceEventsUsedAsInput: false,
      parityReportUsedOnlyForCheck: true,
      resolverMode: "observed-match-feed-empty",
    },
    counts: {
      parsedCallCount: executor.rows.length,
      expectedLiveCallCount: expectedRows.length,
      serviceOperationCount: executor.service.operations.length,
      producerOperationCount: producerOps.length,
      cursorReadOperationCount: cursorReadOps.length,
      compareOperationCount: compareOps.length,
      knownRefCount: executor.service.refs.size,
      allocatedRefCount: executor.refAllocator.refs.length,
      return0CompareCount: return0CompareOps.length,
      missingCompareRefCount: missingRefs.length,
      lateCompareRefCount: lateRefs.length,
      rowParity,
      operationParity,
    },
    replays: { sce, xse },
    streamRows: executor.rows,
    operations: executor.service.operations.slice(0, 160),
    refLedger: executor.refAllocator.refs,
    streamEvents: executor.streams,
    invariants,
    summary: {
      status: failures.length ? "provider35c4-parsed-stream-feeder-risk" : "provider35c4-parsed-stream-feeder-ready",
      currentFinding: "The provider 0x35C4 service object can now be driven from parsed raw CBE SCE/XSE streams instead of ABI-shim traceEvents, while matching the prior live-call feeder signature.",
      emulatorImpact: "This is the first runtime-loop-shaped feeder for the generic CBE emulator: resource parsing calls the 0x35C4 service object directly, with the ABI trace retained only as a parity oracle.",
      nextTarget: "Move the parsed feeder from sampled XSE ref offsets into the full 0x112C4 table walk, then bind real provider +0x50 return-0 observations before enabling entry promotion.",
      visibleEffectsEnabled: false,
      failureCount: failures.length,
      parsedCallCount: executor.rows.length,
      producerOperationCount: producerOps.length,
      cursorReadOperationCount: cursorReadOps.length,
      compareOperationCount: compareOps.length,
      knownRefCount: executor.service.refs.size,
      rowParity,
      operationParity,
      return0CompareCount: return0CompareOps.length,
    },
  };
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# Provider 0x35C4 Stream Executor Probe");
  lines.push("");
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Input CBE: \`${report.input}\``);
  lines.push(`- Status: ${report.summary.status}`);
  lines.push(`- Finding: ${report.summary.currentFinding}`);
  lines.push(`- Emulator impact: ${report.summary.emulatorImpact}`);
  lines.push(`- Next target: ${report.summary.nextTarget}`);
  lines.push("");
  lines.push("## Stream Contract");
  lines.push("");
  lines.push(mdRow(["Field", "Value"]));
  lines.push(mdRow(["---", "---"]));
  for (const [key, value] of Object.entries(report.streamContract)) {
    lines.push(mdRow([key, Array.isArray(value) ? value.join(", ") : value]));
  }
  lines.push("");
  lines.push("## Counts");
  lines.push("");
  lines.push(mdRow(["Field", "Value"]));
  lines.push(mdRow(["---", "---:"]));
  for (const [key, value] of Object.entries(report.counts)) lines.push(mdRow([key, value]));
  lines.push("");
  lines.push("## Replay Head");
  lines.push("");
  lines.push(mdRow(["Call", "Method", "Shape", "Resource", "Policy", "Ref", "Label", "Return", "Status"]));
  lines.push(mdRow(["---:", "---", "---", "---", "---", "---", "---", "---:", "---"]));
  for (const row of report.streamRows.slice(0, 64)) {
    lines.push(mdRow([
      row.callSeq,
      row.method,
      row.dispatchShape,
      row.resource,
      row.policy,
      row.providerRefId,
      row.callerLabel,
      row.serviceReturnValue,
      row.status,
    ]));
  }
  lines.push("");
  lines.push("## Invariants");
  lines.push("");
  lines.push(mdRow(["Invariant", "Pass", "Details", "Impact"]));
  lines.push(mdRow(["---", "---", "---", "---"]));
  for (const invariant of report.invariants) {
    lines.push(mdRow([invariant.id, invariant.passed ? "yes" : "no", invariant.details, invariant.impact]));
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
  const jsonFile = path.join(outDir, "provider35c4_stream_executor_probe.json");
  const mdFile = path.join(outDir, "provider35c4_stream_executor_probe.md");
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
  ParsedProvider35C4StreamExecutor,
  buildReport,
  renderMarkdown,
};
