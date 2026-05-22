const fs = require("fs");
const path = require("path");
const { DEFAULT_INPUT, fixupPayload, loadCbeArchive } = require("./cbe_unpack");
const {
  decodeCompactToken,
  hexBytes,
  parseResourceEnvelope,
} = require("./cbe_struct");
const {
  readStableHeader,
  searchNormalizedGate,
} = require("./cbe_xse_facade_normalized_probe");

const DEFAULT_OUT = path.resolve(__dirname, "out_godwar_providerabishim");
const PROVIDER_ABI_JSON = path.resolve(__dirname, "out_godwar_providerabi", "provider_abi_trace.json");
const LAYOUT_JSON = path.resolve(__dirname, "out_godwar_xselayout", "xse_layout_trace.json");
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

function readProviderAbi(file = PROVIDER_ABI_JSON) {
  try {
    const trace = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      available: true,
      file,
      providerSource: trace.providerSource || {},
      providerReturns: trace.providerReturns || [],
      conclusion: trace.conclusion || {},
    };
  } catch (err) {
    return {
      available: false,
      file,
      providerSource: {},
      providerReturns: [],
      conclusion: {},
      reason: err.message || String(err),
    };
  }
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

function loadProviderRefSamples(file = XSE_REF64_LOADER_JSON) {
  try {
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
  } catch (err) {
    return { file, map: new Map(), error: err.message || String(err) };
  }
}

function normalizeProviderLabel(text) {
  return String(text || "").trim().toLowerCase();
}

function createObservedProviderRefResolver(observedMatches = []) {
  const allowed = new Set((observedMatches || []).map((match) => [
    normalizeProviderLabel(match.label || match.normalizedLabel),
    match.providerRefId || match.refId || "",
  ].join("|")));
  return ({ normalizedLabel, entryRef }) => {
    const key = [normalizeProviderLabel(normalizedLabel), entryRef?.providerRefId || ""].join("|");
    if (allowed.has(key)) {
      return { matched: true, status: "observed-provider-match" };
    }
    return { matched: false, status: "ref-namespace-unbound" };
  };
}

class TraceLog {
  constructor() {
    this.events = [];
  }

  push(event) {
    this.events.push({
      index: this.events.length,
      ...event,
    });
  }

  slice(limit = 80) {
    return this.events.slice(0, limit);
  }
}

class ProviderRefNamespace {
  constructor() {
    this.namespaceId = "provider:0x35C4:+0x64/+0x50";
    this.refs = [];
    this.refByKey = new Map();
    this.compares = [];
  }

  refKey(ref) {
    return [
      ref.context || "",
      ref.resource || "",
      ref.policy || "",
      ref.offset || "",
      ref.rawSample || ref.text || "",
    ].join("|");
  }

  registerRef(ref) {
    const key = this.refKey(ref);
    let row = this.refByKey.get(key);
    if (!row) {
      row = {
        namespaceId: this.namespaceId,
        refId: `ref${String(this.refs.length + 1).padStart(3, "0")}`,
        producerMethod: "[sb+0x35C4]+0x64",
        consumerMethod: "[sb+0x35C4]+0x50",
        context: ref.context || "unknown-provider-ref",
        returnClass: ref.returnClass || "",
        kind: ref.kind || "",
        resource: ref.resource || "",
        policy: ref.policy || "",
        role: ref.role || "",
        cursorBefore: ref.cursorBefore || "",
        offset: ref.offset || "",
        rawSample: ref.rawSample || "",
        text: ref.text || "",
        compareOnly: Boolean(ref.compareOnly),
        cursorAdvanced: Boolean(ref.cursorAdvanced),
        observedCount: 0,
      };
      this.refs.push(row);
      this.refByKey.set(key, row);
    }
    row.observedCount += 1;
    return row;
  }

  registerCompare({ role, callerLabel, normalizedLabel, entryRef, compareStatus, returnValue, matched }) {
    const row = {
      namespaceId: this.namespaceId,
      consumerMethod: "[sb+0x35C4]+0x50",
      role,
      callerLabel,
      normalizedLabel,
      refId: entryRef?.providerRefId || "",
      refContext: entryRef?.context || "",
      refResource: entryRef?.resource || "",
      refPolicy: entryRef?.policy || "",
      refOffset: entryRef?.offset || "",
      compareStatus,
      returnValue,
      matched: Boolean(matched),
    };
    this.compares.push(row);
    return row;
  }

  snapshot() {
    const opaqueRefs = this.refs.filter((ref) => ref.kind === "provider-opaque-ref");
    const textRefs = this.refs.filter((ref) => ref.kind === "resource-name");
    const compareMatches = this.compares.filter((compare) => compare.matched || compare.returnValue === 0);
    const unboundCompares = this.compares.filter((compare) => compare.compareStatus === "ref-namespace-unbound");
    return {
      namespaceId: this.namespaceId,
      refCount: this.refs.length,
      opaqueRefCount: opaqueRefs.length,
      textRefCount: textRefs.length,
      compareCount: this.compares.length,
      compareMatchCount: compareMatches.length,
      unboundCompareCount: unboundCompares.length,
      contexts: Array.from(new Set(this.refs.map((ref) => ref.context).filter(Boolean))).sort(),
      refs: this.refs,
      compares: this.compares,
    };
  }
}

class ReaderService {
  constructor(log) {
    this.kind = "reader/open/cursor service";
    this.global = "0x35C4";
    this.providerMethod = "providerApi+0x64";
    this.log = log;
    this.namespace = new ProviderRefNamespace();
    this.providerRefResolver = null;
    this.resolverMode = "unbound-observed-match-only";
    this.methods = {
      "+0x38": "close converted stream",
      "+0x40": "open resource stream",
      "+0x4C": "read u16/scalar from converted stream",
      "+0x50": "dispatch by argument shape: read compact token from converted stream or compare caller label against +0x64 entry ref",
      "+0x64": "read provider ref by call context: SCE resource names are length-prefixed text; XSE range/final refs and child handles stay opaque until bound",
    };
  }

  setProviderRefResolver(resolver, mode = "observed-match-only") {
    this.providerRefResolver = typeof resolver === "function" ? resolver : null;
    this.resolverMode = this.providerRefResolver ? mode : "unbound-observed-match-only";
  }

  open(resource) {
    const opened = {
      service: "[sb+0x35C4]+0x40",
      resourceName: resource.name,
      raw: resource.fixed,
      envelope: parseResourceEnvelope(resource.fixed),
    };
    this.log.push({
      service: opened.service,
      method: "+0x40",
      role: "open resource stream",
      resource: resource.name,
      bodyOffset: hex(opened.envelope.bodyOffset),
      first16: hexBytes(resource.fixed.subarray(0, 16)),
    });
    return opened;
  }

  close(converted, role = "close converted stream") {
    this.log.push({
      service: "[sb+0x35C4]+0x38",
      method: "+0x38",
      role,
      resource: converted.resourceName,
      policy: converted.policy,
    });
    return true;
  }

  readU16(converted, cursor, role) {
    const offset = converted.baseOffset + cursor.value;
    if (offset + 2 > converted.raw.length) throw new Error(`truncated u16 at ${hex(offset)}`);
    const value = converted.raw.readUInt16LE(offset);
    this.log.push({
      service: "[sb+0x35C4]+0x4C",
      method: "+0x4C",
      role,
      resource: converted.resourceName,
      policy: converted.policy,
      cursorBefore: cursor.value,
      cursorBeforeHex: hex(cursor.value),
      offset: hex(offset),
      raw: hexBytes(converted.raw.subarray(offset, offset + 2)),
      value,
    });
    cursor.value += 2;
    return value;
  }

  readRawByte(converted, cursor, role) {
    const offset = converted.baseOffset + cursor.value;
    if (offset >= converted.raw.length) throw new Error(`truncated byte at ${hex(offset)}`);
    const value = converted.raw[offset];
    this.log.push({
      service: "raw byte in 0x112C4",
      method: "raw8",
      role,
      resource: converted.resourceName,
      policy: converted.policy,
      cursorBefore: cursor.value,
      cursorBeforeHex: hex(cursor.value),
      offset: hex(offset),
      raw: byteHex(value),
      value,
    });
    cursor.value += 1;
    return value;
  }

  readCompact(converted, cursor, role, limit = 0x7fffffff) {
    const offset = converted.baseOffset + cursor.value;
    const token = decodeCompactToken(converted.raw, offset);
    if (!token || token.truncated || Math.abs(token.value) > limit) {
      throw new Error(`compact read failed at ${hex(offset)} for ${role}`);
    }
    this.log.push({
      service: "[sb+0x35C4]+0x50",
      method: "+0x50",
      role,
      resource: converted.resourceName,
      policy: converted.policy,
      cursorBefore: cursor.value,
      cursorBeforeHex: hex(cursor.value),
      offset: hex(offset),
      raw: token.raw,
      tag: token.tag,
      value: token.value,
      nextCursor: token.next - converted.baseOffset,
      nextCursorHex: hex(token.next - converted.baseOffset),
    });
    cursor.value = token.next - converted.baseOffset;
    return {
      offset: hex(offset),
      cursorBefore: hex(token.offset - converted.baseOffset),
      nextCursor: hex(cursor.value),
      tag: token.tag,
      value: token.value,
      raw: token.raw,
      unsigned32: token.unsigned32 ?? null,
    };
  }

  compareLabelRef(callerLabel, entryRef, resolver, role = "label/ref compare") {
    const normalizedLabel = String(callerLabel || "").trim().toLowerCase();
    const activeResolver = typeof resolver === "function" ? resolver : this.providerRefResolver;
    const resolved = typeof activeResolver === "function"
      ? activeResolver({ callerLabel, normalizedLabel, entryRef, namespace: this.namespace.snapshot() })
      : { matched: false, status: "ref-namespace-unbound" };
    const matched = Boolean(resolved?.matched);
    const compareStatus = resolved?.status || (matched ? "matched" : "not-matched");
    const returnValue = matched ? 0 : 1;
    const namespaceCompare = this.namespace.registerCompare({
      role,
      callerLabel,
      normalizedLabel,
      entryRef,
      compareStatus,
      returnValue,
      matched,
    });
    this.log.push({
      service: "[sb+0x35C4]+0x50",
      method: "+0x50",
      role,
      argumentShape: "r0=caller label pointer, r1=script+0x64 record+0x10",
      callerLabel,
      normalizedLabel,
      entryRef,
      providerNamespaceId: this.namespace.namespaceId,
      providerRefId: entryRef?.providerRefId || "",
      namespaceCompareIndex: this.namespace.compares.length - 1,
      resolverMode: this.resolverMode,
      compareStatus,
      returnValue,
      note: "return 0 selects the entry at 0x12326; the ref namespace is still unresolved",
    });
    return namespaceCompare.returnValue;
  }

  inferRefContext(role) {
    const text = String(role || "").toLowerCase();
    if (/map .*resource|resource-name|scene resource/.test(text)) return "sce-resource-name";
    if (/range|entry/.test(text)) return "xse-range-entry-ref";
    if (/final/.test(text)) return "xse-final-ref";
    if (/child|sub-script|script handle/.test(text)) return "xse-child-resource-handle";
    return "unknown-provider-ref";
  }

  readLengthPrefixedRef(converted, cursor, role, context) {
    const offset = converted.baseOffset + cursor.value;
    if (offset >= converted.raw.length) throw new Error(`truncated ref length at ${hex(offset)}`);
    const length = converted.raw[offset];
    const start = offset + 1;
    const end = start + length;
    if (end > converted.raw.length) throw new Error(`truncated ref body at ${hex(start)}`);
    const text = converted.raw.subarray(start, end).toString("ascii");
    const namespaceRef = this.namespace.registerRef({
      kind: "resource-name",
      context,
      returnClass: "length-prefixed resource-name text",
      resource: converted.resourceName,
      policy: converted.policy,
      role,
      cursorBefore: hex(cursor.value),
      offset: hex(offset),
      text,
      cursorAdvanced: true,
    });
    this.log.push({
      service: "[sb+0x35C4]+0x64",
      method: "+0x64",
      role,
      resource: converted.resourceName,
      policy: converted.policy,
      refContext: context,
      returnClass: "length-prefixed resource-name text",
      providerNamespaceId: this.namespace.namespaceId,
      providerRefId: namespaceRef.refId,
      cursorBefore: cursor.value,
      cursorBeforeHex: hex(cursor.value),
      offset: hex(offset),
      length,
      text,
    });
    cursor.value += 1 + length;
    return {
      kind: "resource-name",
      context,
      text,
      length,
      cursorAdvanced: true,
      offset: hex(offset),
      providerNamespaceId: this.namespace.namespaceId,
      providerRefId: namespaceRef.refId,
    };
  }

  readOpaqueProviderRef(converted, cursor, role, context) {
    const offset = converted.baseOffset + cursor.value;
    const sample = converted.raw.subarray(offset, Math.min(converted.raw.length, offset + 12));
    const handle = {
      kind: "provider-opaque-ref",
      context,
      resource: converted.resourceName,
      policy: converted.policy,
      cursorBefore: hex(cursor.value),
      offset: hex(offset),
      rawSample: hexBytes(sample),
      compareOnly: context === "xse-range-entry-ref",
      cursorAdvanced: false,
      blockedReason: "provider +0x64 context is known, but its XSE ref encoding width/namespace is not bound",
    };
    const namespaceRef = this.namespace.registerRef({
      ...handle,
      role,
      returnClass: context === "xse-child-resource-handle" ? "child resource / sub-script handle" : "provider-opaque ref",
    });
    handle.providerNamespaceId = this.namespace.namespaceId;
    handle.providerRefId = namespaceRef.refId;
    this.log.push({
      service: "[sb+0x35C4]+0x64",
      method: "+0x64",
      role,
      resource: converted.resourceName,
      policy: converted.policy,
      refContext: context,
      returnClass: context === "xse-child-resource-handle" ? "child resource / sub-script handle" : "provider-opaque ref",
      providerNamespaceId: this.namespace.namespaceId,
      providerRefId: namespaceRef.refId,
      cursorBefore: cursor.value,
      cursorBeforeHex: hex(cursor.value),
      offset: hex(offset),
      rawSample: handle.rawSample,
      cursorAdvanced: false,
      note: handle.blockedReason,
    });
    return handle;
  }

  readProviderRef(converted, cursor, role, options = {}) {
    const context = options.context || this.inferRefContext(role);
    if (context === "sce-resource-name") {
      return this.readLengthPrefixedRef(converted, cursor, role, context);
    }
    return this.readOpaqueProviderRef(converted, cursor, role, context);
  }

  readRef(converted, cursor, role) {
    const ref = this.readProviderRef(converted, cursor, role, { context: "sce-resource-name" });
    return ref.text;
  }
}

class ConversionService {
  constructor(log) {
    this.kind = "stream conversion service";
    this.global = "0x35C0";
    this.providerMethod = "providerApi+0x5C";
    this.log = log;
    this.methods = {
      "+0x50": "convert opened resource stream into byte cursor base",
    };
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
        note: "SCE parser checks bytes at converted pointer and then advances cursor by 4.",
      });
    }
    if (xseMagic >= 0) {
      out.push({
        policy: "xse-body-prefix",
        baseOffset: opened.envelope.bodyOffset,
        magic: raw.subarray(xseMagic, xseMagic + 4).toString("ascii"),
        note: "Current 0x112C4 header oracle starts at body-prefix + 6, which is raw 0x000F for focused XSE files.",
      });
      out.push({
        policy: "xse-magic-pointer",
        baseOffset: xseMagic,
        magic: "XSE0",
        note: "Control candidate mirroring the SCE magic-pointer conversion; expected to expose the base/cursor mismatch if it fails.",
      });
    }
    if (!out.length) {
      out.push({
        policy: "envelope-body",
        baseOffset: opened.envelope.bodyOffset,
        magic: "",
        note: "No known magic found; fall back to resource envelope body.",
      });
    }
    return out;
  }

  convert(opened, policy) {
    const candidates = this.candidateBases(opened);
    const selected = policy
      ? candidates.find((candidate) => candidate.policy === policy)
      : candidates[0];
    if (!selected) throw new Error(`conversion policy ${policy} not available for ${opened.resourceName}`);
    const converted = {
      service: "[sb+0x35C0]+0x50",
      resourceName: opened.resourceName,
      raw: opened.raw,
      envelope: opened.envelope,
      baseOffset: selected.baseOffset,
      baseOffsetHex: hex(selected.baseOffset),
      policy: selected.policy,
      magic: selected.magic,
      note: selected.note,
    };
    this.log.push({
      service: converted.service,
      method: "+0x50",
      role: "convert opened stream",
      resource: opened.resourceName,
      policy: converted.policy,
      baseOffset: converted.baseOffsetHex,
      magic: converted.magic,
      note: converted.note,
    });
    return converted;
  }
}

class ManagerRootService {
  constructor(log) {
    this.kind = "manager root for wrapper facades";
    this.global = "0x35E0";
    this.providerMethod = "providerApi+0x80+0x04";
    this.log = log;
    this.methods = {
      "0x934 facade": "normalizes to scalar reader [0x35C4]+0x4C at verified 0x112C4 caller sites",
      "0x958 facade": "normalizes to child/ref reader [0x35C4]+0x64 at verified 0x112C4 caller sites",
    };
  }
}

function createHostProviderShim() {
  const log = new TraceLog();
  const conversionService = new ConversionService(log);
  const readerService = new ReaderService(log);
  const managerRoot = new ManagerRootService(log);
  const providerApi = {
    "+0x5C": () => conversionService,
    "+0x64": () => readerService,
    "+0x80+0x04": () => managerRoot,
  };
  return {
    log,
    hostProviderGlobal: "0x35F8",
    apiObjectGlobal: "0x3588",
    providerApi,
    conversionService,
    readerService,
    managerRoot,
  };
}

function bootProviderShim(shim, providerAbi) {
  const globals = {
    "0x35F8": { kind: "host provider pointer" },
    "0x3588": { kind: "provider API object", methods: Object.keys(shim.providerApi) },
  };
  const assignments = [];
  for (const item of providerAbi.providerReturns || []) {
    const method = item.expression;
    let value = null;
    let implemented = false;
    if (method === "providerApi+0x5C") {
      value = shim.providerApi["+0x5C"]();
      implemented = true;
    } else if (method === "providerApi+0x64") {
      value = shim.providerApi["+0x64"]();
      implemented = true;
    } else if (method === "providerApi+0x80+0x04") {
      value = shim.providerApi["+0x80+0x04"]();
      implemented = true;
    }
    const globalName = item.targetGlobalHex || "";
    globals[globalName] = value || { kind: "stub provider return", providerMethod: method };
    assignments.push({
      site: item.siteHex,
      providerMethod: method,
      global: globalName,
      role: item.role,
      implemented,
      serviceKind: value?.kind || "stub provider return",
    });
    shim.log.push({
      service: "provider ABI",
      method,
      role: `boot assignment ${globalName}`,
      global: globalName,
      implemented,
      serviceKind: value?.kind || "stub provider return",
    });
  }
  return { globals, assignments };
}

function replaySce(archive, services, name = "guangmingshendian.sce") {
  const entry = findEntry(archive, name);
  if (!entry) return { status: "missing", name };
  const resource = { name: entry.name, ...readResource(archive, entry) };
  const opened = services.reader.open(resource);
  const converted = services.converter.convert(opened, "sce-magic");
  const cursor = { value: 4 };
  const width = services.reader.readU16(converted, cursor, "scene width");
  const height = services.reader.readU16(converted, cursor, "scene height");
  const mapCount = services.reader.readU16(converted, cursor, "map count");
  const maps = [];
  for (let i = 0; i < mapCount && i < 8; i += 1) {
    const mapName = services.reader.readRef(converted, cursor, `map ${i} resource`);
    const fields = [
      services.reader.readU16(converted, cursor, `map ${i} x/tile field 0`),
      services.reader.readU16(converted, cursor, `map ${i} y/tile field 1`),
      services.reader.readU16(converted, cursor, `map ${i} field 2`),
      services.reader.readU16(converted, cursor, `map ${i} field 3`),
    ];
    maps.push({ name: mapName, fields });
  }
  return {
    status: converted.magic === "SCE2" && width > 0 && height > 0 && mapCount === maps.length
      ? "abi-shim-sce-ok"
      : "abi-shim-sce-suspicious",
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

function readXseHeaderViaShim(converted, reader) {
  const cursor = { value: 6 };
  const reads = [];
  function compact(label, limit = 4096) {
    try {
      const token = reader.readCompact(converted, cursor, label, limit);
      reads.push({ label, ...token });
      return token;
    } catch (err) {
      reads.push({ label, error: err.message || String(err), cursor: hex(cursor.value) });
      return null;
    }
  }
  function raw(label) {
    try {
      const value = reader.readRawByte(converted, cursor, label);
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
  const ok = Boolean(slotCapacityToken && field04 && field08Byte != null && field0C && typeByte != null && recordByteSize != null && groupCount);
  return {
    ok,
    cursorAfterHeader: hex(cursor.value),
    slotCapacity: slotCapacityToken?.value === 0 ? 0x80 : slotCapacityToken?.value,
    field04: field04?.value,
    field08Byte,
    field0C: field0C?.value,
    typeByte,
    recordByteSize,
    groupCount: groupCount?.value,
    reads,
    warning: ok ? "" : "header did not decode through the ABI shim reader",
  };
}

function readXseProviderRefSamplesViaShim(converted, reader, samples) {
  return (samples || []).map((sample) => {
    const refOffset = parseHex(sample.refOffset);
    const cursorValue = refOffset - converted.baseOffset;
    if (!Number.isFinite(refOffset) || cursorValue < 0 || refOffset >= converted.raw.length) {
      return {
        ...sample,
        status: "ref-sample-out-of-converted-range",
        convertedBase: converted.baseOffsetHex,
      };
    }
    const cursor = { value: cursorValue };
    const ref = reader.readProviderRef(converted, cursor, sample.role, { context: sample.context });
    const compareSamples = sample.context === "xse-range-entry-ref"
      ? ["Init", "_main"].map((label) => ({
        label,
        returnValue: reader.compareLabelRef(label, ref, null, `sample ${sample.context} compare`),
        matched: false,
        resolverStatus: "ref-namespace-unbound",
      }))
      : [];
    return {
      ...sample,
      status: "opaque-provider-ref-sampled",
      convertedBase: converted.baseOffsetHex,
      cursorBefore: ref.cursorBefore,
      serviceOffset: ref.offset,
      rawSample: ref.rawSample,
      compareOnly: Boolean(ref.compareOnly),
      cursorAdvanced: Boolean(ref.cursorAdvanced),
      compareSamples,
      blockedReason: ref.blockedReason || "",
    };
  });
}

function replayXse(archive, services, layoutEnds, providerRefSamples) {
  const scripts = [];
  for (const name of FOCUS_XSE) {
    const entry = findEntry(archive, name);
    if (!entry) {
      scripts.push({ name, missing: true });
      continue;
    }
    const resource = { name: entry.name, ...readResource(archive, entry) };
    const opened = services.reader.open(resource);
    const candidates = services.converter.candidateBases(opened)
      .filter((candidate) => candidate.policy.startsWith("xse-"));
    const targetEnd = layoutEnds.map.get(normalizeName(name));
    scripts.push({
      name,
      resource: entry.name,
      targetEnd: Number.isFinite(targetEnd) ? hex(targetEnd) : "",
      candidates: candidates.map((candidate) => {
        const converted = services.converter.convert(opened, candidate.policy);
        const shimHeader = readXseHeaderViaShim(converted, services.reader);
        const stableHeader = readStableHeader(resource.fixed, converted.baseOffset);
        const currentGate = searchNormalizedGate(resource.fixed, stableHeader, targetEnd, "current50");
        const providerRefContextSamples = readXseProviderRefSamplesViaShim(
          converted,
          services.reader,
          providerRefSamples.map.get(normalizeName(name)) || [],
        );
        return {
          policy: candidate.policy,
          baseOffset: hex(candidate.baseOffset),
          magic: candidate.magic,
          note: candidate.note,
          shimHeader,
          providerRefContextSamples,
          currentGate: {
            anyStrictOpcodePath: Boolean(currentGate.anyStrictOpcodePath),
            layoutAlignedStrictPath: Boolean(currentGate.layoutAlignedStrictPath),
            bestEndOffset: currentGate.successes?.[0]?.endOffset || "",
            bestLayoutDelta: currentGate.successes?.[0]?.layoutEndDelta ?? null,
            firstFailure: currentGate.firstFailures?.[0] || null,
          },
        };
      }),
    });
  }
  const aligned = scripts.flatMap((script) => script.candidates || [])
    .filter((candidate) => candidate.currentGate?.layoutAlignedStrictPath).length;
  const strict = scripts.flatMap((script) => script.candidates || [])
    .filter((candidate) => candidate.currentGate?.anyStrictOpcodePath).length;
  return {
    status: aligned ? "abi-shim-xse-has-aligned-candidate" : "abi-shim-xse-blocked",
    strictCandidateCount: strict,
    alignedCandidateCount: aligned,
    scripts,
  };
}

function buildReport(options = {}) {
  const input = path.resolve(options.input || DEFAULT_INPUT);
  const archive = loadCbeArchive(input);
  const providerAbi = readProviderAbi();
  const layoutEnds = loadLayoutEnds();
  const providerRefSamples = loadProviderRefSamples();
  const shim = createHostProviderShim();
  const boot = bootProviderShim(shim, providerAbi);
  const services = {
    converter: boot.globals["0x35C0"],
    reader: boot.globals["0x35C4"],
    managerRoot: boot.globals["0x35E0"],
  };
  const sce = replaySce(archive, services);
  const xse = replayXse(archive, services, layoutEnds, providerRefSamples);
  const criticalAssignments = boot.assignments.filter((item) => ["0x35C0", "0x35C4", "0x35E0"].includes(item.global));
  return {
    schema: "nicai.cbe.providerAbiShimProbe.v1",
    generatedAt: new Date().toISOString(),
    input,
    providerAbi: {
      available: providerAbi.available,
      file: providerAbi.file,
      source: providerAbi.providerSource,
      conclusion: providerAbi.conclusion,
      reason: providerAbi.reason || "",
    },
    boot: {
      hostProviderGlobal: shim.hostProviderGlobal,
      apiObjectGlobal: shim.apiObjectGlobal,
      assignments: boot.assignments,
      criticalAssignments,
    },
    serviceObjects: {
      conversionService: {
        global: services.converter.global,
        providerMethod: services.converter.providerMethod,
        methods: services.converter.methods,
      },
      readerService: {
        global: services.reader.global,
        providerMethod: services.reader.providerMethod,
        methods: services.reader.methods,
        resolverHook: {
          mode: services.reader.resolverMode,
          bound: Boolean(services.reader.providerRefResolver),
          policy: "observed providerRefId + label matches only; no scalar/string fallback",
        },
        providerRefNamespace: services.reader.namespace.snapshot(),
      },
      managerRoot: {
        global: services.managerRoot.global,
        providerMethod: services.managerRoot.providerMethod,
        methods: services.managerRoot.methods,
      },
    },
    replays: {
      sce,
      xse,
    },
    providerRefSamples: {
      file: providerRefSamples.file,
      available: !providerRefSamples.error,
      reason: providerRefSamples.error || "",
      sampledScriptCount: Array.from(providerRefSamples.map.values()).filter((rows) => rows.length).length,
    },
    providerRefNamespace: services.reader.namespace.snapshot(),
    resolverHook: {
      mode: services.reader.resolverMode,
      bound: Boolean(services.reader.providerRefResolver),
      observedMatchCount: 0,
      policy: "Entry promotion requires an observed +0x50 return-0 match for the same providerRefId; guessed scalar/string matches are not accepted.",
    },
    traceEvents: shim.log.slice(160),
    conclusion: {
      currentFinding: "The host-provider ABI shim can materialize 0x35C0/0x35C4/0x35E0 as returned service objects, replay the real SCE parser, sample XSE +0x64 refs as provider-opaque context handles, and track +0x64 producers with +0x50 label/ref consumers in one provider namespace ledger.",
      emulatorImpact: "This replaces static-method-table selection with a runnable provider boot model. XSE refs now flow through readProviderRef(context) and compareLabelRef(label, ref) in the same namespace instead of the SCE text reader, but visible effects still block until the exact +0x50 compare resolver is bound.",
      nextTarget: "Use the provider namespace ledger to emulate or instrument only the 0x35C4 service resolver: observe which providerRefId values match Init/_main through +0x50 before promoting any entry.",
    },
  };
}

function mdRow(values) {
  return `| ${values.map((value) => String(value ?? "").replace(/\|/g, "\\|")).join(" | ")} |`;
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# Provider ABI Shim Probe");
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
  lines.push("## Booted Provider Services");
  lines.push("");
  lines.push(mdRow(["Global", "Provider method", "Service kind", "Implemented"]));
  lines.push(mdRow(["---", "---", "---", "---"]));
  for (const item of report.boot.criticalAssignments) {
    lines.push(mdRow([item.global, item.providerMethod, item.serviceKind, item.implemented ? "yes" : "no"]));
  }
  lines.push("");
  lines.push("## SCE Replay");
  const sce = report.replays.sce;
  lines.push("");
  lines.push(`- Status: ${sce.status}`);
  lines.push(`- Convert: ${sce.converted.policy}, base=${sce.converted.baseOffset}, magic=${sce.converted.magic}`);
  lines.push(`- Fields: ${sce.fields.width}x${sce.fields.height}, maps=${sce.fields.mapCount}`);
  for (const map of sce.maps || []) {
    lines.push(`- Map: ${map.name}, fields=${map.fields.join(",")}`);
  }
  lines.push("");
  lines.push("## XSE Shim Gate");
  lines.push("");
  lines.push(`- Status: ${report.replays.xse.status}`);
  lines.push(`- Strict candidates: ${report.replays.xse.strictCandidateCount}, aligned candidates: ${report.replays.xse.alignedCandidateCount}`);
  lines.push(`- Provider ref samples: ${report.providerRefSamples?.available ? `${report.providerRefSamples.sampledScriptCount} script(s)` : report.providerRefSamples?.reason || "unavailable"}`);
  if (report.providerRefNamespace) {
    const ns = report.providerRefNamespace;
    lines.push(`- Provider namespace: ${ns.namespaceId}; refs=${ns.refCount}, opaque=${ns.opaqueRefCount}, text=${ns.textRefCount}, compares=${ns.compareCount}, matches=${ns.compareMatchCount}, unbound=${ns.unboundCompareCount}`);
  }
  if (report.resolverHook) {
    lines.push(`- Resolver hook: mode=${report.resolverHook.mode}, bound=${report.resolverHook.bound ? "yes" : "no"}, observedMatches=${report.resolverHook.observedMatchCount}; ${report.resolverHook.policy}`);
  }
  for (const script of report.replays.xse.scripts || []) {
    lines.push("");
    lines.push(`### ${script.name}`);
    lines.push(`- Layout end: ${script.targetEnd || "-"}`);
    for (const candidate of script.candidates || []) {
      const header = candidate.shimHeader;
      const gate = candidate.currentGate;
      const gateText = gate.layoutAlignedStrictPath
        ? "aligned"
        : (gate.anyStrictOpcodePath ? `strict shallow ${gate.bestEndOffset} delta=${gate.bestLayoutDelta}` : "blocked");
      lines.push(`- ${candidate.policy}: base=${candidate.baseOffset}, header=${header.ok ? `ok groups=${header.groupCount} recordSize=${header.recordByteSize}` : "failed"}, gate=${gateText}`);
      const refRows = (candidate.providerRefContextSamples || [])
        .slice(0, 4)
        .map((sample) => {
          const compares = (sample.compareSamples || []).map((row) => `${row.label}->${row.returnValue}`).join("/");
          return `${sample.context}@${sample.refOffset} ${sample.status} advanced=${sample.cursorAdvanced ? "yes" : "no"}${compares ? ` compare=${compares}` : ""} raw=${sample.rawSample || sample.raw || "-"}`;
        })
        .join("; ");
      if (refRows) lines.push(`  - +0x64 contexts: ${refRows}`);
    }
  }
  if (report.providerRefNamespace?.refs?.length) {
    const ns = report.providerRefNamespace;
    lines.push("");
    lines.push("## Provider Ref Namespace Ledger");
    lines.push("");
    lines.push(mdRow(["Ref", "Context", "Resource", "Policy", "Offset/Text", "Observed", "Compare-only"]));
    lines.push(mdRow(["---", "---", "---", "---", "---", "---:", "---"]));
    for (const ref of ns.refs.slice(0, 24)) {
      lines.push(mdRow([
        ref.refId,
        ref.context,
        ref.resource,
        ref.policy,
        ref.offset || ref.text,
        ref.observedCount,
        ref.compareOnly ? "yes" : "no",
      ]));
    }
    lines.push("");
    lines.push(mdRow(["Compare", "Label", "Ref", "Status", "Return"]));
    lines.push(mdRow(["---", "---", "---", "---", "---:"]));
    for (const compare of ns.compares.slice(0, 24)) {
      lines.push(mdRow([
        compare.role,
        compare.callerLabel,
        compare.refId,
        compare.compareStatus,
        compare.returnValue,
      ]));
    }
  }
  lines.push("");
  lines.push("## Service Call Trace Head");
  lines.push("");
  for (const event of report.traceEvents.slice(0, 36)) {
    const label = [event.service, event.method, event.role].filter(Boolean).join(" ");
    const detail = [event.global, event.resource, event.policy, event.offset, event.raw || event.text, event.value != null ? `=${event.value}` : ""]
      .filter(Boolean)
      .join(" ");
    lines.push(`- #${event.index} ${label}${detail ? `: ${detail}` : ""}`);
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
  const jsonFile = path.join(outDir, "provider_abi_shim_probe.json");
  const mdFile = path.join(outDir, "provider_abi_shim_probe.md");
  writeJson(jsonFile, report);
  fs.writeFileSync(mdFile, renderMarkdown(report), "utf8");
  console.log(`wrote ${jsonFile}`);
  console.log(`wrote ${mdFile}`);
}

if (require.main === module) {
  main();
}

module.exports = {
  buildReport,
  createObservedProviderRefResolver,
  createHostProviderShim,
  renderMarkdown,
};
