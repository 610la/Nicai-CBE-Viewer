const fs = require("fs/promises");
const fssync = require("fs");
const path = require("path");
const { TextDecoder } = require("util");

const DATA_EXTS = new Set([".actor", ".map", ".sce", ".xse"]);
const REF_EXTS = ["actor", "gif", "map", "mp3", "sce", "xse"];
const KNOWN_SCRIPT_COMMANDS = [
  "SHOWDIALOG",
  "LOADMONSTER",
  "SETMONSTERACTION",
  "CANSAY",
  "STARTDIALOG",
  "ENDDIALOG",
  "LOADLIGHTGOD",
  "LOADDARKGOD",
  "SETROLEPOS",
  "SETCAMERAMODE",
  "ROLEMOVETO",
  "ROLESKILL",
  "KILLMONSTER",
  "ISFINISHSKILL",
  "LOADHERERSKILL",
  "HEEREMITSKILL",
  "GETGAMESTATE",
  "CLOSESCRIPT",
  "ISROLEDIE",
  "CHANGESCENE",
  "MOVEMONSTERTO",
  "ROLEATTACK",
  "ROLEONWUDI",
  "ROLEOFFWUDI",
  "LOADCR",
  "OPENCR",
  "ISCR",
  "SETROLESWORD",
  "ENDSCRIPT",
  "HURTROLE",
  "KILLROLE",
  "GETSCREENSIZE",
];
const gbDecoder = new TextDecoder("gb18030");

function hex(n, width = 0) {
  return `0x${n.toString(16).toUpperCase().padStart(width, "0")}`;
}

function extOf(name) {
  return path.extname(name || "").toLowerCase();
}

function stripIndexPrefix(name) {
  return String(name || "").replace(/^[0-9]{4}_/, "");
}

function resourceStem(name) {
  const base = path.basename(stripIndexPrefix(name || ""));
  return normalizeStem(base.slice(0, base.length - path.extname(base).length));
}

function cleanAsciiRef(text) {
  return String(text || "")
    .replace(/^[^A-Za-z0-9_./-]+/, "")
    .replace(/[^A-Za-z0-9_./-]+$/, "");
}

function asciiRuns(buf, min = 3, limit = 240) {
  const out = [];
  let start = -1;
  for (let i = 0; i <= buf.length; i += 1) {
    const c = i < buf.length ? buf[i] : 0;
    const ok = c >= 0x20 && c <= 0x7e;
    if (ok && start < 0) start = i;
    if (!ok && start >= 0) {
      if (i - start >= min) {
        out.push({
          offset: start,
          text: buf.subarray(start, i).toString("ascii"),
        });
        if (out.length >= limit) break;
      }
      start = -1;
    }
  }
  return out;
}

function isAsciiText(byte) {
  return byte === 0x09 || byte === 0x0a || byte === 0x0d || (byte >= 0x20 && byte <= 0x7e);
}

function isGbkTextPair(lead, trail) {
  const commonHan = lead >= 0xb0 && lead <= 0xf7 && trail >= 0xa1 && trail <= 0xfe;
  const commonPunctuation = (lead === 0xa1 || lead === 0xa3) && trail >= 0xa1 && trail <= 0xfe;
  return commonHan || commonPunctuation;
}

function isAllowedTextChar(ch) {
  return /[\u3400-\u4dbf\u4e00-\u9fff，。！？、：；（）【】《》“”‘’·—￥％]/u.test(ch) ||
    /[A-Za-z0-9_ .,:;!?()[\]<>+\-*/\\'"#@$%&=\r\n]/.test(ch);
}

function cleanText(text) {
  return text
    .replace(/[\r\n\t]+/g, "\n")
    .replace(/[ ]{2,}/g, " ")
    .replace(/^[A-Za-z0-9#@$%&*?=.+\- ]{1,5}(?=\[)/, "")
    .replace(/([。！？）])\s*[A-Za-z0-9#@$%&*?=.+\-]$/, "$1")
    .trim();
}

function scanTextRuns(buf, minChars = 4, limit = 90) {
  const runs = [];
  let pos = 0;
  while (pos < buf.length) {
    let i = pos;
    let text = "";

    while (i < buf.length) {
      const byte = buf[i];
      if (isAsciiText(byte)) {
        const ch = String.fromCharCode(byte);
        if (!isAllowedTextChar(ch)) break;
        text += ch;
        i += 1;
        continue;
      }

      const next = buf[i + 1];
      if (isGbkTextPair(byte, next)) {
        const ch = gbDecoder.decode(buf.subarray(i, i + 2));
        if (ch.length !== 1 || !isAllowedTextChar(ch)) break;
        text += ch;
        i += 2;
        continue;
      }

      break;
    }

    const clean = cleanText(text);
    const chinese = (clean.match(/[\u3400-\u4dbf\u4e00-\u9fff]/gu) || []).length;
    const ascii = (clean.match(/[A-Za-z0-9_./\\]/g) || []).length;
    const punctuation = (clean.match(/[，。！？、：；（）【】《》“”\[\]]/gu) || []).length;
    const score = clean.length + chinese * 2 + punctuation;
    if (clean.length >= minChars && score >= 9 && (chinese >= 2 || ascii >= 4)) {
      runs.push({ offset: pos, length: i - pos, text: clean });
      if (runs.length >= limit) break;
    }

    pos = i > pos ? i : pos + 1;
  }
  return runs;
}

function readU16Head(buf, count = 24) {
  const out = [];
  for (let i = 0; i < count && i * 2 + 1 < buf.length; i += 1) {
    out.push({ offset: hex(i * 2, 4), value: buf.readUInt16LE(i * 2) });
  }
  return out;
}

function readU32Head(buf, count = 12) {
  const out = [];
  for (let i = 0; i < count && i * 4 + 3 < buf.length; i += 1) {
    out.push({ offset: hex(i * 4, 4), value: buf.readUInt32LE(i * 4) });
  }
  return out;
}

function byteHex(value) {
  return hex(value, 2);
}

function hexBytes(bytes) {
  return Array.from(bytes).map(byteHex).join(" ");
}

function topByteCounts(bytes, limit = 10, predicate = () => true) {
  const counts = new Map();
  for (const byte of bytes) {
    if (!predicate(byte)) continue;
    counts.set(byte, (counts.get(byte) || 0) + 1);
  }
  return Array.from(counts, ([byte, count]) => ({
    byte: byteHex(byte),
    count,
    percent: bytes.length ? Number(((count / bytes.length) * 100).toFixed(2)) : 0,
  }))
    .sort((a, b) => b.count - a.count || a.byte.localeCompare(b.byte))
    .slice(0, limit);
}

function topPairCounts(bytes, limit = 10) {
  const counts = new Map();
  for (let i = 0; i + 1 < bytes.length; i += 1) {
    const key = `${byteHex(bytes[i])} ${byteHex(bytes[i + 1])}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return Array.from(counts, ([pair, count]) => ({
    pair,
    count,
    percent: bytes.length > 1 ? Number(((count / (bytes.length - 1)) * 100).toFixed(2)) : 0,
  }))
    .sort((a, b) => b.count - a.count || a.pair.localeCompare(b.pair))
    .slice(0, limit);
}

function refRegex() {
  return new RegExp(`[A-Za-z0-9_./-]+\\.(${REF_EXTS.join("|")})`, "ig");
}

function extractInlineRefs(runs) {
  const refs = [];
  const seen = new Set();
  for (const run of runs) {
    const regex = refRegex();
    let match;
    while ((match = regex.exec(run.text)) !== null) {
      const text = cleanAsciiRef(match[0]);
      const key = text.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        refs.push({ offset: run.offset + match.index, text });
      }
    }
  }
  return refs;
}

function normalizeStem(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/^[0-9]{4}_/, "")
    .replace(/[^a-z0-9_.-]/g, "");
}

function buildCatalog(entries = []) {
  return entries
    .map((entry) => {
      const name = typeof entry === "string" ? entry : entry.name || path.basename(entry.rel || entry.output || "");
      const rel = typeof entry === "string" ? "" : entry.rel || "";
      const base = path.basename(name);
      const parsed = path.parse(base);
      return {
        name,
        rel,
        output: typeof entry === "string" ? "" : entry.output || "",
        base,
        ext: parsed.ext.toLowerCase(),
        stem: parsed.name.toLowerCase(),
        baseNorm: normalizeStem(base),
        stemNorm: normalizeStem(parsed.name),
      };
    })
    .filter((entry) => entry.base);
}

function matchCatalogRefs(runs, inlineRefs, catalogEntries) {
  const catalog = buildCatalog(catalogEntries);
  if (!catalog.length) {
    return { direct: inlineRefs, candidates: [] };
  }

  const byBase = new Map(catalog.map((entry) => [entry.baseNorm, entry]));
  const direct = [];
  const directSeen = new Set();
  for (const ref of inlineRefs) {
    const key = normalizeStem(path.basename(ref.text));
    const matched = byBase.get(key);
    const item = {
      ...ref,
      matched: matched ? matched.name : "",
      rel: matched ? matched.rel : "",
    };
    const seenKey = `${item.text}|${item.matched}`;
    if (!directSeen.has(seenKey)) {
      directSeen.add(seenKey);
      direct.push(item);
    }
  }

  const fragments = [];
  for (const run of runs) {
    const parts = String(run.text).split(/[^A-Za-z0-9_.-]+/);
    for (const part of parts) {
      const frag = normalizeStem(part);
      if (
        frag.length < 4 ||
        frag === "sce2" ||
        frag.startsWith(".") ||
        REF_EXTS.includes(frag)
      ) {
        continue;
      }
      fragments.push({ offset: run.offset, text: part, norm: frag });
    }
  }

  const candidateMap = new Map();
  for (const entry of catalog) {
    let best = null;
    for (const frag of fragments) {
      if (!frag.norm || frag.norm === entry.baseNorm || frag.norm === entry.stemNorm) continue;
      let score = 0;
      let reason = "";
      if (entry.stemNorm.startsWith(frag.norm)) {
        score = 80;
        reason = "prefix";
      } else if (entry.baseNorm.endsWith(frag.norm) || entry.stemNorm.endsWith(frag.norm)) {
        score = 70;
        reason = "suffix";
      } else if (entry.stemNorm.includes(frag.norm) && frag.norm.length >= 5) {
        score = 45;
        reason = "contains";
      }
      if (score && (!best || score > best.score || frag.norm.length > best.fragment.length)) {
        best = { score, reason, fragment: frag.text, offset: frag.offset };
      }
    }

    if (!best) continue;
    for (const frag of fragments) {
      if (
        frag.norm !== best.fragment.toLowerCase() &&
        entry.stemNorm.startsWith(normalizeStem(best.fragment)) &&
        (entry.baseNorm.endsWith(frag.norm) || entry.stemNorm.endsWith(frag.norm)) &&
        frag.norm.length >= 4
      ) {
        best = {
          score: 95,
          reason: "prefix+suffix",
          fragment: `${best.fragment} ... ${frag.text}`,
          offset: Math.min(best.offset, frag.offset),
        };
      }
    }
    candidateMap.set(entry.baseNorm, {
      name: entry.name,
      rel: entry.rel,
      offset: best.offset,
      fragment: best.fragment,
      reason: best.reason,
      score: best.score,
    });
  }

  const directNames = new Set(direct.map((item) => normalizeStem(path.basename(item.matched || item.text))));
  const candidates = Array.from(candidateMap.values())
    .filter((item) => !directNames.has(normalizeStem(path.basename(item.name))))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, 40);

  return { direct, candidates };
}

function isResourceTextChar(byte) {
  return (byte >= 0x30 && byte <= 0x39) ||
    (byte >= 0x41 && byte <= 0x5a) ||
    (byte >= 0x61 && byte <= 0x7a) ||
    byte === 0x2e || byte === 0x5f || byte === 0x2d;
}

function scanLengthPrefixedRefs(buf, min = 3, max = 48) {
  const out = [];
  for (let offset = 0; offset + 1 < buf.length; offset += 1) {
    const length = buf[offset];
    if (length < min || length > max || offset + 1 + length > buf.length) continue;

    let ok = true;
    for (let i = 0; i < length; i += 1) {
      if (!isResourceTextChar(buf[offset + 1 + i])) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;

    const text = buf.subarray(offset + 1, offset + 1 + length).toString("ascii");
    if (!/[A-Za-z]/.test(text)) continue;
    out.push({
      recordOffset: offset,
      stringOffset: offset + 1,
      length,
      text,
    });
  }
  return out;
}

function stemFromRefText(text) {
  const clean = cleanAsciiRef(text);
  const ext = path.extname(clean);
  const base = path.basename(clean, ext);
  return normalizeStem(base);
}

function matchSceneAsset(text, catalogEntries = []) {
  const stem = stemFromRefText(text);
  if (!stem || stem.length < 3) return null;

  const catalog = buildCatalog(catalogEntries);
  const exactActor = catalog.find((entry) => entry.ext === ".actor" && entry.stemNorm === stem);
  if (exactActor) return { ...exactActor, reason: "exact actor stem" };

  const exactGif = catalog.find((entry) => entry.ext === ".gif" && entry.stemNorm === stem);
  if (exactGif) return { ...exactGif, reason: "exact gif stem" };

  if (stem.length >= 5) {
    const actorPrefixes = catalog
      .filter((entry) => entry.ext === ".actor" && entry.stemNorm.startsWith(stem))
      .sort((a, b) => a.stemNorm.length - b.stemNorm.length || a.base.localeCompare(b.base));
    if (actorPrefixes.length === 1) return { ...actorPrefixes[0], reason: "unique actor prefix" };
  }

  return null;
}

function scenePlacementFromAnchor(buf, ref, canvas, catalogEntries, seen) {
  const asset = matchSceneAsset(ref.text, catalogEntries);
  if (!asset) return null;

  const ext = path.extname(ref.text).toLowerCase();
  if ([".map", ".sce", ".xse"].includes(ext)) return null;
  if (ref.recordOffset < 6) return null;

  const kind = buf.readUInt16LE(ref.recordOffset - 6);
  if (kind < 1 || kind > 64) return null;
  const x = buf.readUInt16LE(ref.recordOffset - 4);
  const y = buf.readUInt16LE(ref.recordOffset - 2);
  const width = canvas?.width || 4096;
  const height = canvas?.height || 4096;
  const pad = 192;
  if (x > width + pad || y > height + pad) return null;

  const key = `${ref.recordOffset}:${x}:${y}:${asset.baseNorm}`;
  if (seen.has(key)) return null;
  seen.add(key);

  const beforeStart = Math.max(0, ref.recordOffset - 12);
  const afterEnd = Math.min(buf.length, ref.stringOffset + ref.text.length + 12);
  return {
    offset: hex(ref.recordOffset, 4),
    stringOffset: hex(ref.stringOffset, 4),
    name: ref.text,
    recordType: kind,
    x,
    y,
    matched: asset.base,
    rel: asset.rel || "",
    matchReason: asset.reason,
    rawBefore: Array.from(buf.subarray(beforeStart, ref.recordOffset)).map(byteHex).join(" "),
    rawAfter: Array.from(buf.subarray(ref.stringOffset + ref.text.length, afterEnd)).map(byteHex).join(" "),
  };
}

function parseScePlacements(buf, runs, canvas, catalogEntries = []) {
  const seen = new Set();
  const refs = scanLengthPrefixedRefs(buf);

  for (const run of runs) {
    const pre = run.offset > 0 ? buf[run.offset - 1] : 0;
    if (run.text.length >= 3 && pre >= run.text.length && pre <= 48) {
      refs.push({
        recordOffset: run.offset - 1,
        stringOffset: run.offset,
        length: pre,
        text: cleanAsciiRef(run.text),
      });
    }
  }

  return refs
    .map((ref) => ref.forcePlacement || scenePlacementFromAnchor(buf, ref, canvas, catalogEntries, seen))
    .filter(Boolean)
    .sort((a, b) => parseInt(a.offset.slice(2), 16) - parseInt(b.offset.slice(2), 16));
}

function numericOffset(value, fallback = 0) {
  if (Number.isFinite(value)) return value;
  if (typeof value === "string" && value) {
    const parsed = Number.parseInt(value.replace(/^0x/i, ""), 16);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function catalogEntryForSceneRef(text, catalogEntries = []) {
  const exact = findCatalogEntryByName(text, catalogEntries);
  if (exact) return { entry: exact, reason: "exact filename" };
  const sceneAsset = matchSceneAsset(text, catalogEntries);
  return sceneAsset ? { entry: sceneAsset, reason: sceneAsset.reason || "scene asset match" } : null;
}

function resolveCatalogEntryPath(entry, options = {}) {
  if (!entry) return "";
  const direct = catalogOutputPath(entry);
  if (direct && fssync.existsSync(direct)) return direct;

  const roots = [
    options.root,
    options.gameRoot,
    options.resourceRoot,
    options.filePath ? path.dirname(options.filePath) : "",
    options.resourceDir,
  ].filter(Boolean);
  for (const root of roots) {
    const rel = entry.rel || entry.name || "";
    if (rel) {
      const candidate = path.resolve(root, rel);
      if (fssync.existsSync(candidate)) return candidate;
    }
    const sibling = findSiblingResource(root, entry.name || entry.base || "");
    if (sibling) return sibling;
  }
  return "";
}

function rawByteToken(stream, cursorRef) {
  if (cursorRef.value >= stream.length) return null;
  const offset = cursorRef.value;
  const value = stream[offset];
  cursorRef.value += 1;
  return {
    offset: hex(offset, 4),
    tag: "raw8",
    value,
    raw: byteHex(value),
  };
}

function read112C4Short(stream, cursorRef, mode) {
  if (mode === "compact") return readCompactTokenAt(stream, cursorRef, 0x7fffffff);
  if (cursorRef.value + 2 > stream.length) return null;
  const offset = cursorRef.value;
  const bytes = stream.subarray(offset, offset + 2);
  const value = mode === "u16be" ? stream.readUInt16BE(offset) : stream.readUInt16LE(offset);
  cursorRef.value += 2;
  return {
    offset: hex(offset, 4),
    tag: mode || "u16le",
    value,
    raw: hexBytes(bytes),
  };
}

function read112C4Compact(stream, cursorRef, label, warnings, limit = 0x7fffffff) {
  const token = readCompactTokenAt(stream, cursorRef, limit);
  if (!token) warnings.push(`truncated compact read: ${label}`);
  return token ? { ...token, label } : null;
}

function addHistogram(histogram, key) {
  histogram.set(key, (histogram.get(key) || 0) + 1);
}

function topHistogram(histogram, limit = 16) {
  return Array.from(histogram, ([key, count]) => ({ key: String(key), count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, limit);
}

function parse112C4Record(stream, cursorRef, groupIdMode, warnings) {
  const opcode = rawByteToken(stream, cursorRef);
  if (!opcode) return null;
  const fields = [];

  function compactField(name) {
    const token = read112C4Compact(stream, cursorRef, name, warnings);
    if (token) fields.push(token);
  }

  function shortField(name) {
    const token = read112C4Short(stream, cursorRef, groupIdMode);
    if (!token) warnings.push(`truncated short read: ${name}`);
    else fields.push({ ...token, label: name });
  }

  switch (opcode.value) {
    case 0:
      compactField("field08");
      break;
    case 1:
      shortField("field0C");
      break;
    case 2:
      compactField("field08");
      fields.push({ label: "forcedType", tag: "const", value: 2, raw: "" });
      break;
    case 3:
      compactField("field14");
      break;
    case 4:
      compactField("field14");
      compactField("field04");
      break;
    case 5:
      compactField("field18");
      break;
    case 6:
      compactField("field1C");
      break;
    case 7:
      compactField("field20");
      break;
    case 8:
      compactField("field24");
      break;
    default:
      break;
  }

  return {
    offset: opcode.offset,
    opcode: opcode.value,
    opcodeHex: opcode.raw,
    fields,
  };
}

function parse112C4Attempt(stream, baseOffset, groupIdMode, options = {}) {
  const cursor = { value: baseOffset + 6 };
  const warnings = [];
  const groups = [];
  const samples = [];
  const opcodeHistogram = new Map();
  const maxGroups = options.maxGroups || 64;
  const maxTotalRecords = options.maxTotalRecords || 4096;
  const maxSamples = options.maxSamples || 32;
  let ok = true;
  let totalRecords = 0;

  function compactHeader(label, limit = 0x7fffffff) {
    return read112C4Compact(stream, cursor, label, warnings, limit);
  }

  const slotCapacityToken = compactHeader("object+58 slot capacity", 4096);
  if (!slotCapacityToken) ok = false;
  const slotCapacity = slotCapacityToken?.value === 0 ? 0x80 : slotCapacityToken?.value;
  const field04 = ok ? compactHeader("object+04") : null;
  const field08Byte = ok ? rawByteToken(stream, cursor) : null;
  const field0C = ok ? compactHeader("object+0C") : null;
  const typeByte = ok ? rawByteToken(stream, cursor) : null;
  let recordByteSizeToken = null;
  let recordByteSize = null;
  if (ok && typeByte) {
    recordByteSize = { 1: 0x14, 2: 0x28, 3: 0x50 }[typeByte.value] || null;
    if (recordByteSize == null) {
      recordByteSizeToken = compactHeader("object+1C record byte size", 4096);
      recordByteSize = recordByteSizeToken?.value ?? null;
    }
  }
  const groupCountToken = ok ? compactHeader("object+4C group count", 4096) : null;
  const groupCount = groupCountToken?.value ?? null;
  if (!Number.isFinite(groupCount) || groupCount < 0 || groupCount > maxGroups) {
    ok = false;
    warnings.push(`implausible group count: ${groupCount}`);
  }

  for (let groupIndex = 0; ok && groupIndex < groupCount; groupIndex += 1) {
    const groupOffset = cursor.value;
    const idToken = read112C4Short(stream, cursor, groupIdMode);
    const recordCountToken = rawByteToken(stream, cursor);
    if (!idToken || !recordCountToken) {
      ok = false;
      warnings.push(`truncated group header ${groupIndex}`);
      break;
    }
    const recordCount = recordCountToken.value;
    if (totalRecords + recordCount > maxTotalRecords) {
      ok = false;
      warnings.push(`record budget exceeded at group ${groupIndex}: ${totalRecords + recordCount}`);
      break;
    }

    const groupSampleRecords = [];
    for (let recordIndex = 0; recordIndex < recordCount; recordIndex += 1) {
      const record = parse112C4Record(stream, cursor, groupIdMode, warnings);
      if (!record) {
        ok = false;
        warnings.push(`truncated record ${recordIndex} in group ${groupIndex}`);
        break;
      }
      addHistogram(opcodeHistogram, record.opcode);
      if (groupSampleRecords.length < 6) groupSampleRecords.push(record);
      if (samples.length < maxSamples) samples.push({ groupIndex, recordIndex, ...record });
    }
    totalRecords += recordCount;
    groups.push({
      index: groupIndex,
      offset: hex(groupOffset, 4),
      id: idToken.value,
      idRaw: idToken.raw,
      idReader: idToken.tag,
      recordCount,
      recordCountRaw: recordCountToken.raw,
      sampleRecords: groupSampleRecords,
    });
  }

  const tail = {};
  if (ok && cursor.value < stream.length) {
    const linkCount = compactHeader("opcode2 backfill +0x74 ref count", 2048);
    if (linkCount) {
      tail.linkCount = linkCount.value;
      tail.linkCountRaw = linkCount.raw;
      tail.linkSamples = [];
      if (linkCount.value >= 0 && linkCount.value <= 256) {
        for (let i = 0; i < linkCount.value && i < 16; i += 1) {
          const token = readCompactTokenAt(stream, cursor, 0x7fffffff);
          if (!token) {
            warnings.push(`truncated opcode2 backfill ref ${i}`);
            break;
          }
          tail.linkSamples.push(token);
        }
      } else {
        warnings.push(`skipped implausible opcode2 backfill ref table count ${linkCount.value}`);
      }
    }
  }
  if (ok && cursor.value < stream.length) {
    const rangeCount = compactHeader("object+68 range count", 2048);
    if (rangeCount) {
      tail.rangeCount = rangeCount.value;
      tail.rangeCountRaw = rangeCount.raw;
      tail.rangeSamples = [];
      if (rangeCount.value >= 0 && rangeCount.value <= 256) {
        for (let i = 0; i < rangeCount.value && i < 12; i += 1) {
          const start = read112C4Compact(stream, cursor, "range+00", warnings);
          const kind = rawByteToken(stream, cursor);
          const span = read112C4Compact(stream, cursor, "range+08", warnings);
          const ref = readCompactTokenAt(stream, cursor, 0x7fffffff);
          if (!start || !kind || !span || !ref) {
            warnings.push(`truncated object+68 range ${i}`);
            break;
          }
          tail.rangeSamples.push({
            index: i,
            offset: start.offset,
            start: start.value,
            kind: kind.value,
            span: span.value,
            inclusiveEnd: kind.value + span.value + 1,
            ref: ref.value,
            raw: [start.raw, kind.raw, span.raw, ref.raw].join(" | "),
          });
        }
      } else {
        warnings.push(`skipped implausible object+68 range count ${rangeCount.value}`);
      }
    }
  }
  if (ok && cursor.value < stream.length) {
    const u32RefCount = compactHeader("object+70 count / object+6C final ref count", 2048);
    if (u32RefCount) {
      tail.u32RefCount = u32RefCount.value;
      tail.u32RefCountRaw = u32RefCount.raw;
      tail.u32RefSamples = [];
      if (u32RefCount.value >= 0 && u32RefCount.value <= 256) {
        for (let i = 0; i < u32RefCount.value && i < 16; i += 1) {
          const token = readCompactTokenAt(stream, cursor, 0x7fffffff);
          if (!token) {
            warnings.push(`truncated object+6C final ref ${i}`);
            break;
          }
          tail.u32RefSamples.push(token);
        }
      } else {
        warnings.push(`skipped implausible object+70/object+6C final ref table count ${u32RefCount.value}`);
      }
    }
  }

  const consumed = Math.max(0, cursor.value - (baseOffset + 6));
  const opcodeTotal = Array.from(opcodeHistogram.values()).reduce((sum, value) => sum + value, 0);
  const knownOpcodes = Array.from(opcodeHistogram)
    .filter(([opcode]) => opcode >= 0 && opcode <= 8)
    .reduce((sum, [, value]) => sum + value, 0);
  let score = 0;
  if (ok) score += 40;
  if (slotCapacity != null && slotCapacity > 0 && slotCapacity <= 4096) score += 10;
  if (groupCount > 0) score += 35;
  if (groupCount > 0 && groupCount <= 16) score += 12;
  if (totalRecords > 0) score += 20;
  if (consumed > 24) score += 12;
  if (baseOffset === options.preferredBaseOffset) score += 35;
  if (baseOffset === options.magicPrefixOffset) score += 20;
  if (!ok) score -= 40;
  if (groupCount === 0) score -= 45;
  if (opcodeTotal) score += Math.round((knownOpcodes / opcodeTotal) * 16);
  if (cursor.value > stream.length) score -= 80;

  return {
    score,
    ok,
    groupIdReader: groupIdMode,
    baseOffset: hex(baseOffset, 4),
    cursorStart: hex(baseOffset + 6, 4),
    endOffset: hex(Math.min(cursor.value, stream.length), 4),
    consumedBytes: consumed,
    remainingBytes: Math.max(0, stream.length - cursor.value),
    header: {
      slotCapacityRead: slotCapacityToken,
      slotCapacityAllocated: slotCapacity,
      field04,
      field08Byte,
      field0C,
      typeByte,
      recordByteSize,
      recordByteSizeToken,
      groupCount: groupCountToken,
    },
    groupCount,
    groups: groups.slice(0, 12),
    parsedGroupCount: groups.length,
    totalRecords,
    opcodeHistogram: topHistogram(opcodeHistogram),
    knownOpcodePercent: opcodeTotal ? Number(((knownOpcodes / opcodeTotal) * 100).toFixed(2)) : 0,
    recordSamples: samples,
    tail,
    warnings: warnings.slice(0, 12),
  };
}

function probe112C4ResourceBuffer(buf, options = {}) {
  const envelope = parseResourceEnvelope(buf);
  const xseMagic = buf.indexOf(Buffer.from("XSE0", "ascii"));
  const sceMagic = buf.indexOf(Buffer.from("SCE2", "ascii"));
  const bodyOffset = envelope.bodyOffset;
  const magicPrefixOffset = xseMagic > 0 ? xseMagic - 1 : (sceMagic > 0 ? sceMagic - 1 : null);
  const starts = new Set([0]);
  if (bodyOffset >= 0 && bodyOffset < buf.length) starts.add(bodyOffset);
  if (magicPrefixOffset != null && magicPrefixOffset >= 0 && magicPrefixOffset < buf.length) starts.add(magicPrefixOffset);
  if (xseMagic >= 0) starts.add(xseMagic);
  if (sceMagic >= 0) starts.add(sceMagic);

  const preferredBaseOffset = magicPrefixOffset ?? bodyOffset;
  const attempts = [];
  for (const baseOffset of starts) {
    for (const groupIdMode of ["u16le", "compact", "u16be"]) {
      attempts.push(parse112C4Attempt(buf, baseOffset, groupIdMode, {
        ...options,
        preferredBaseOffset,
        magicPrefixOffset,
      }));
    }
  }
  attempts.sort((a, b) => b.score - a.score || b.consumedBytes - a.consumedBytes);
  const best = attempts[0] || null;
  const invalidOpcodes = (best?.opcodeHistogram || [])
    .map((item) => ({ opcode: Number(item.key), count: item.count }))
    .filter((item) => !Number.isInteger(item.opcode) || item.opcode < 0 || item.opcode > 8);
  const strictOpcodeGate = {
    passed: Boolean(
      best?.ok &&
      best.groupCount > 0 &&
      best.parsedGroupCount === best.groupCount &&
      best.totalRecords > 0 &&
      best.knownOpcodePercent === 100 &&
      invalidOpcodes.length === 0
    ),
    knownOpcodePercent: best?.knownOpcodePercent ?? 0,
    invalidOpcodes,
  };

  return {
    note: "Diagnostic, code-anchored from CBE 0x112C4: the engine opens a referenced resource, starts reading at resource-base + 6, allocates object slots of 0x74 bytes, then builds 0x0C group records, 0x28 opcode records, 0x14 range records, and u32 reference arrays. This probes scene/script object structure only; it is not the .map terrain renderer.",
    resourceName: options.resourceName || "",
    resourceSize: buf.length,
    envelope: {
      declaredBodyLength: envelope.declaredBodyLength,
      bodyOffset: hex(envelope.bodyOffset, 4),
      lengthMatches: envelope.lengthMatches,
    },
    magic: {
      xse0Offset: xseMagic >= 0 ? hex(xseMagic, 4) : "",
      sce2Offset: sceMagic >= 0 ? hex(sceMagic, 4) : "",
      magicPrefixOffset: magicPrefixOffset != null ? hex(magicPrefixOffset, 4) : "",
    },
    strictOpcodeGate,
    confidence: strictOpcodeGate.passed && best?.score >= 100 ? "high" : "low",
    best,
    attempts: attempts.slice(0, 6).map((attempt) => ({
      score: attempt.score,
      ok: attempt.ok,
      groupIdReader: attempt.groupIdReader,
      baseOffset: attempt.baseOffset,
      cursorStart: attempt.cursorStart,
      endOffset: attempt.endOffset,
      consumedBytes: attempt.consumedBytes,
      groupCount: attempt.groupCount,
      parsedGroupCount: attempt.parsedGroupCount,
      totalRecords: attempt.totalRecords,
      knownOpcodePercent: attempt.knownOpcodePercent,
      opcodeHistogram: attempt.opcodeHistogram,
      warnings: attempt.warnings,
    })),
  };
}

function probeSceSceneObjects(buf, mapTable, options = {}) {
  const streamOffset = numericOffset(mapTable?.streamOffset, 0);
  const catalogEntries = options.catalog || [];
  const refs = scanLengthPrefixedRefs(buf)
    .filter((ref) => ref.recordOffset >= streamOffset)
    .map((ref) => {
      const matched = catalogEntryForSceneRef(ref.text, catalogEntries);
      const entry = matched?.entry || null;
      const after = ref.stringOffset + ref.length;
      const postU16LE = [];
      for (let offset = after; offset + 1 < buf.length && postU16LE.length < 6; offset += 2) {
        postU16LE.push({
          offset: hex(offset, 4),
          value: buf.readUInt16LE(offset),
        });
      }
      return {
        offset: hex(ref.recordOffset, 4),
        stringOffset: hex(ref.stringOffset, 4),
        length: ref.length,
        text: ref.text,
        matched: entry ? entry.name : "",
        rel: entry ? entry.rel || "" : "",
        ext: entry ? entry.ext || path.extname(entry.name || "").toLowerCase() : path.extname(ref.text).toLowerCase(),
        matchReason: matched?.reason || "",
        preBytes: hexBytes(buf.subarray(Math.max(0, ref.recordOffset - 10), ref.recordOffset)),
        postBytes: hexBytes(buf.subarray(after, Math.min(buf.length, after + 24))),
        postU16LE,
      };
    });

  const externalProbes = [];
  for (const ref of refs) {
    if (externalProbes.length >= 6) break;
    if (ref.ext !== ".xse") continue;
    const matched = catalogEntryForSceneRef(ref.text, catalogEntries);
    const resourcePath = resolveCatalogEntryPath(matched?.entry, options);
    const external = {
      refOffset: ref.offset,
      text: ref.text,
      matched: ref.matched,
      rel: ref.rel,
      ext: ref.ext,
      resourcePath: resourcePath || "",
    };
    if (resourcePath) {
      try {
        const resourceBytes = fssync.readFileSync(resourcePath);
        external.probe = probe112C4ResourceBuffer(resourceBytes, {
          resourceName: ref.matched || ref.text,
        });
      } catch (err) {
        external.error = err.message || String(err);
      }
    } else {
      external.error = "matched resource file not found on disk";
    }
    externalProbes.push(external);
  }

  return {
    note: "Diagnostic, not a rendered map: this lists SCE scene-stream resource records and probes resources that match the 0x112C4 object/script initializer. It is intended to find real object tables before map terrain decoding.",
    sceneStreamOffset: hex(streamOffset, 4),
    sceneStreamLength: Math.max(0, buf.length - streamOffset),
    sceneStreamFirstBytes: hexBytes(buf.subarray(streamOffset, Math.min(buf.length, streamOffset + 64))),
    resourceRefs: refs.slice(0, 32),
    resourceRefCount: refs.length,
    externalProbes,
  };
}

function parseSceMapRecords(buf, magic) {
  if (magic < 0 || magic + 10 > buf.length) return null;
  let offset = magic + 4;
  const width = buf.readUInt16LE(offset);
  const height = buf.readUInt16LE(offset + 2);
  const count = buf.readUInt16LE(offset + 4);
  offset += 6;

  if (!isPlausibleDimension(width) || !isPlausibleDimension(height) || count < 0 || count > 16) return null;

  const records = [];
  for (let i = 0; i < count; i += 1) {
    if (offset >= buf.length) return null;
    const nameLength = buf[offset];
    if (nameLength < 1 || nameLength > 96 || offset + 1 + nameLength + 8 > buf.length) return null;
    const nameOffset = offset + 1;
    const nameBytes = buf.subarray(nameOffset, nameOffset + nameLength);
    if (!Array.from(nameBytes).every(isResourceTextChar)) return null;
    const name = nameBytes.toString("ascii");
    offset = nameOffset + nameLength;
    const fields = [
      buf.readUInt16LE(offset),
      buf.readUInt16LE(offset + 2),
      buf.readUInt16LE(offset + 4),
      buf.readUInt16LE(offset + 6),
    ];
    records.push({
      index: i,
      offset: hex(nameOffset - 1, 4),
      name,
      nameLength,
      fields,
      rawFields: Array.from(buf.subarray(offset, offset + 8)).map(byteHex).join(" "),
    });
    offset += 8;
  }

  return {
    width,
    height,
    count,
    records,
    streamOffset: hex(offset, 4),
    streamFirstBytes: Array.from(buf.subarray(offset, Math.min(buf.length, offset + 48))).map(byteHex).join(" "),
  };
}

function parseSce(buf, runs, options = {}) {
  const magic = buf.indexOf(Buffer.from("SCE2", "ascii"));
  const out = { magicOffset: magic >= 0 ? hex(magic, 4) : "" };
  if (magic >= 0 && magic + 8 < buf.length) {
    out.canvas = {
      width: buf.readUInt16LE(magic + 4),
      height: buf.readUInt16LE(magic + 6),
    };
  }
  const mapTable = parseSceMapRecords(buf, magic);
  if (mapTable) out.mapTable = mapTable;
  const mapHints = runs
    .filter((run) => /^\d*map\d+\.?$/i.test(run.text) || /\.map$/i.test(run.text))
    .map((run) => ({ offset: hex(run.offset, 4), text: run.text }));
  if (mapHints.length) out.mapHints = mapHints;
  out.lengthPrefixedRefs = scanLengthPrefixedRefs(buf)
    .slice(0, 40)
    .map((ref) => ({
      offset: hex(ref.recordOffset, 4),
      stringOffset: hex(ref.stringOffset, 4),
      length: ref.length,
      text: ref.text,
    }));
  const placements = parseScePlacements(buf, runs, out.canvas, options.catalog || []);
  if (placements.length) out.placements = placements;
  if (mapTable) out.sceneObjectProbe = probeSceSceneObjects(buf, mapTable, options);
  return out;
}

function findGifRef(runs) {
  for (const run of runs) {
    const match = /[A-Za-z0-9_./-]+\.gif/i.exec(run.text);
    if (match) {
      return {
        offset: run.offset + match.index,
        end: run.offset + match.index + match[0].length,
        text: cleanAsciiRef(match[0]),
      };
    }
  }
  return null;
}

function isPlausibleDimension(value) {
  return value >= 120 && value <= 4096 && value % 16 === 0;
}

function findMapDimensionEncoding(buf, startOffset, knownCanvas) {
  const begin = Math.max(0, startOffset - 2);
  const end = Math.min(buf.length - 2, startOffset + 24);
  const knownWidth = knownCanvas?.width || 0;
  const knownHeight = knownCanvas?.height || 0;

  if (knownWidth && knownHeight) {
    for (let offset = begin; offset <= end && offset + 8 <= buf.length; offset += 1) {
      if (buf.readUInt32LE(offset) === knownWidth && buf.readUInt32LE(offset + 4) === knownHeight) {
        return { offset, dataOffset: offset + 8, encoding: "u32 width + u32 height", width: knownWidth, height: knownHeight };
      }
    }
    for (let offset = begin; offset <= end && offset + 6 <= buf.length; offset += 1) {
      if (buf.readUInt32LE(offset) === knownWidth && buf.readUInt16LE(offset + 4) === knownHeight) {
        return { offset, dataOffset: offset + 6, encoding: "u32 width + u16 height", width: knownWidth, height: knownHeight };
      }
    }
    for (let offset = begin; offset <= end && offset + 4 <= buf.length; offset += 1) {
      if (buf.readUInt16LE(offset) === knownWidth && buf.readUInt16LE(offset + 2) === knownHeight) {
        return { offset, dataOffset: offset + 4, encoding: "u16 width + u16 height", width: knownWidth, height: knownHeight };
      }
    }
    for (let offset = begin; offset <= end && offset + 4 <= buf.length; offset += 1) {
      if (buf.readUInt32LE(offset) === knownWidth) {
        return { offset, dataOffset: offset + 4, encoding: "u32 width only", width: knownWidth, height: null };
      }
    }
    for (let offset = begin; offset <= end && offset + 2 <= buf.length; offset += 1) {
      if (buf.readUInt16LE(offset) === knownWidth) {
        return { offset, dataOffset: offset + 2, encoding: "u16 width only", width: knownWidth, height: null };
      }
    }
  }

  for (let offset = begin; offset <= end && offset + 8 <= buf.length; offset += 1) {
    const width = buf.readUInt32LE(offset);
    const height = buf.readUInt32LE(offset + 4);
    if (isPlausibleDimension(width) && isPlausibleDimension(height)) {
      return { offset, dataOffset: offset + 8, encoding: "u32 width + u32 height", width, height };
    }
  }
  for (let offset = begin; offset <= end && offset + 6 <= buf.length; offset += 1) {
    const width = buf.readUInt32LE(offset);
    const height = buf.readUInt16LE(offset + 4);
    if (isPlausibleDimension(width) && isPlausibleDimension(height)) {
      return { offset, dataOffset: offset + 6, encoding: "u32 width + u16 height", width, height };
    }
  }
  return null;
}

function analyzeMapStream(payload, canvas) {
  let highBitBytes = 0;
  let zeroBytes = 0;
  let alignedNibbleBytes = 0;
  for (const byte of payload) {
    if (byte >= 0x80) highBitBytes += 1;
    if (byte === 0) zeroBytes += 1;
    if ((byte & 0x0f) === 0) alignedNibbleBytes += 1;
  }

  const cells16 = canvas ? Math.ceil(canvas.width / 16) * Math.ceil(canvas.height / 16) : 0;
  const cells8 = canvas ? Math.ceil(canvas.width / 8) * Math.ceil(canvas.height / 8) : 0;
  return {
    length: payload.length,
    bytesPer16Cell: cells16 ? Number((payload.length / cells16).toFixed(3)) : null,
    bytesPer8Cell: cells8 ? Number((payload.length / cells8).toFixed(3)) : null,
    highBitBytes,
    highBitPercent: payload.length ? Number(((highBitBytes / payload.length) * 100).toFixed(2)) : 0,
    zeroBytes,
    zeroPercent: payload.length ? Number(((zeroBytes / payload.length) * 100).toFixed(2)) : 0,
    alignedNibblePercent: payload.length ? Number(((alignedNibbleBytes / payload.length) * 100).toFixed(2)) : 0,
    topBytes: topByteCounts(payload),
    topHighBytes: topByteCounts(payload, 10, (byte) => byte >= 0x80),
    topPairs: topPairCounts(payload),
  };
}

function topValueCounts(values, limit = 12) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return Array.from(counts, ([value, count]) => ({
    value,
    count,
    percent: values.length ? Number(((count / values.length) * 100).toFixed(2)) : 0,
  }))
    .sort((a, b) => b.count - a.count || String(a.value).localeCompare(String(b.value)))
    .slice(0, limit);
}

function summarizeCompactToken(token) {
  return {
    offset: hex(token.offset, 4),
    tag: token.tag,
    value: token.value,
    raw: token.raw,
    unsigned32: token.unsigned32 ?? null,
    truncated: Boolean(token.truncated),
  };
}

function probeCompactTupleLayouts(tokens) {
  const attempts = [];
  for (let startToken = 0; startToken < Math.min(4, tokens.length); startToken += 1) {
    for (let tupleSize = 2; tupleSize <= 6; tupleSize += 1) {
      let total = 0;
      let small = 0;
      let mixed = 0;
      let wide = 0;
      const samples = [];

      for (let i = startToken; i + tupleSize <= tokens.length && total < 32; i += tupleSize) {
        const slice = tokens.slice(i, i + tupleSize);
        const absValues = slice.map((token) => Math.abs(Number(token.value || 0)));
        const smallCount = absValues.filter((value) => value <= 4096).length;
        const hasWide = slice.some((token) => token.tag === "0x82" || token.tag === "0x83" || token.tag === "0x84" || token.tag === "0x85");

        total += 1;
        if (smallCount === tupleSize) small += 1;
        if (smallCount >= Math.ceil(tupleSize / 2)) mixed += 1;
        if (hasWide) wide += 1;
        if (samples.length < 6) {
          samples.push(slice.map((token) => `${hex(token.offset, 4)}:${token.value}(${token.tag})`).join(" "));
        }
      }

      if (!total) continue;
      const smallPercent = Number(((small / total) * 100).toFixed(2));
      const mixedPercent = Number(((mixed / total) * 100).toFixed(2));
      const widePercent = Number(((wide / total) * 100).toFixed(2));
      const score = Number(((smallPercent * 0.6) + (mixedPercent * 0.25) + (widePercent * 0.15)).toFixed(2));
      attempts.push({
        startToken,
        tupleSize,
        records: total,
        smallPercent,
        mixedPercent,
        widePercent,
        score,
        sampleRecords: samples,
      });
    }
  }

  return attempts
    .sort((a, b) => b.score - a.score || b.smallPercent - a.smallPercent || a.startToken - b.startToken || a.tupleSize - b.tupleSize)
    .slice(0, 8);
}

function probeCompactStream(stream, canvas = null, limit = 192) {
  const tokens = [];
  let cursor = 0;
  while (cursor < stream.length && tokens.length < limit) {
    const token = decodeCompactToken(stream, cursor);
    if (!token) break;
    tokens.push({
      offset: token.offset,
      tag: token.tag,
      value: token.value,
      raw: token.raw,
      unsigned32: token.unsigned32,
      truncated: token.truncated,
    });
    cursor = token.next;
  }

  const windows = [];
  for (let i = 0; i < tokens.length && windows.length < 12; i += 1) {
    const token = tokens[i];
    if (token.tag === "raw" && token.value >= 0 && token.value < 0x80) continue;
    const start = Math.max(0, i - 3);
    const end = Math.min(tokens.length, i + 5);
    windows.push({
      center: hex(token.offset, 4),
      tokens: tokens.slice(start, end).map(summarizeCompactToken),
    });
  }

  return {
    note: "Diagnostic only: compact tokens from the map draw stream. This is structural evidence, not a proven renderer.",
    tokenCount: tokens.length,
    consumedBytes: cursor,
    firstTokens: tokens.slice(0, 64).map(summarizeCompactToken),
    tagCounts: topValueCounts(tokens.map((token) => token.tag), 12).map((entry) => ({
      tag: entry.value,
      count: entry.count,
      percent: entry.percent,
    })),
    windows,
    layoutAttempts: probeCompactTupleLayouts(tokens, canvas),
  };
}

function summarizeTemplateHeader(header) {
  if (!header) return null;
  return {
    bodyOffset: hex(header.bodyOffset, 4),
    headerBytes: header.headerBytes,
    headerWord0: header.headerWord0,
    declaredNameLength: header.declaredNameLength,
    nameOffset: hex(header.nameOffset, 4),
    rawNameBytes: header.rawNameBytes,
    rawNameText: header.rawNameText,
    compactName: header.compactName,
    streamOffset: hex(header.streamOffset, 4),
  };
}

function decodeCompactToken(stream, offset) {
  if (offset >= stream.length) return null;
  const tag = stream[offset];
  if (tag < 0x80) {
    return { offset, next: offset + 1, tag: "raw", value: tag, raw: byteHex(tag) };
  }
  if ((tag === 0x80 || tag === 0x81) && offset + 1 < stream.length) {
    return {
      offset,
      next: offset + 2,
      tag: byteHex(tag),
      value: stream[offset + 1],
      raw: hexBytes(stream.subarray(offset, offset + 2)),
    };
  }
  if (tag === 0x82 && offset + 2 < stream.length) {
    return {
      offset,
      next: offset + 3,
      tag: byteHex(tag),
      value: stream.readInt16BE(offset + 1),
      unsigned32: stream.readUInt16BE(offset + 1),
      raw: hexBytes(stream.subarray(offset, offset + 3)),
    };
  }
  if (tag === 0x83 && offset + 3 < stream.length) {
    return {
      offset,
      next: offset + 4,
      tag: byteHex(tag),
      value: stream.readIntBE(offset + 1, 3),
      unsigned32: (stream[offset + 1] << 16) | (stream[offset + 2] << 8) | stream[offset + 3],
      raw: hexBytes(stream.subarray(offset, offset + 4)),
    };
  }
  if ((tag === 0x84 || tag === 0x85) && offset + 4 < stream.length) {
    return {
      offset,
      next: offset + 5,
      tag: byteHex(tag),
      value: stream.readInt32LE(offset + 1),
      unsigned32: stream.readUInt32LE(offset + 1),
      raw: hexBytes(stream.subarray(offset, offset + 5)),
    };
  }
  if (tag > 0x85) {
    return {
      offset,
      next: offset + 1,
      tag: "s8",
      value: tag - 0x100,
      raw: byteHex(tag),
    };
  }
  return { offset, next: offset + 1, tag: byteHex(tag), value: tag, raw: byteHex(tag), truncated: true };
}

function readCompactTokens(stream, offset, count, limitValue = 0x100000) {
  const tokens = [];
  let cursor = offset;
  for (let i = 0; i < count; i += 1) {
    const token = decodeCompactToken(stream, cursor);
    if (!token) return null;
    tokens.push({
      offset: hex(token.offset, 4),
      tag: token.tag,
      value: token.value,
      raw: token.raw,
    });
    if (token.truncated || Math.abs(token.value) > limitValue) return null;
    cursor = token.next;
  }
  return { tokens, cursor };
}

function probeTemplateStream(stream, options = {}) {
  const ffCandidate = findActorStreamDividers(stream)[0] || null;
  const ffOffset = ffCandidate ? ffCandidate.markerStart : -1;
  const expectedWidth = options.imageInfo?.width || options.canvas?.width || 0;
  const expectedHeight = options.imageInfo?.height || options.canvas?.height || 0;
  const attempts = [];
  const maxRecordStride = Math.min(16, Math.max(1, Math.floor(stream.length / Math.max(1, stream[0] || 1))));

  for (const countRead of ["raw8", "compact"]) {
    const countToken = countRead === "raw8" ? { value: stream[0], next: 1, raw: byteHex(stream[0] || 0), tag: "raw" } : decodeCompactToken(stream, 0);
    if (!countToken || countToken.value <= 0 || countToken.value > 512) continue;
    for (let recordStride = 1; recordStride <= maxRecordStride; recordStride += 1) {
      let cursor = countToken.next + countToken.value * recordStride;
      if (cursor >= stream.length) continue;
      const fields = readCompactTokens(stream, cursor, 4, 4096);
      if (!fields) continue;
      cursor = fields.cursor;
      const values = fields.tokens.map((token) => token.value);
      const [cellW, cellH, width, height] = values;
      const positive = values.every((value) => value > 0 && value <= 4096);
      const gridW = positive ? Math.ceil(width / cellW) : 0;
      const gridH = positive ? Math.ceil(height / cellH) : 0;
      const matrixCells = gridW * gridH;
      const targetDelta = expectedWidth && expectedHeight && positive
        ? Math.abs(width - expectedWidth) + Math.abs(height - expectedHeight)
        : null;
      const targetDeltaSwapped = expectedWidth && expectedHeight && positive
        ? Math.abs(width - expectedHeight) + Math.abs(height - expectedWidth)
        : null;
      let matrix = null;
      if (positive && matrixCells > 0 && matrixCells <= 4096) {
        matrix = readCompactTokens(stream, cursor, matrixCells, 0x7fffffff);
      }
      const matrixEnd = matrix?.cursor ?? cursor;
      let score = 0;
      if (positive) score += 20;
      if (recordStride >= 2 && recordStride <= 8) score += 5;
      if (ffOffset >= 0) {
        const diff = Math.abs(ffOffset - matrixEnd);
        if (diff === 0) score += 80;
        else if (diff <= 4) score += 50;
        else if (matrixEnd < ffOffset) score += Math.max(0, 25 - Math.floor((ffOffset - matrixEnd) / 8));
      }
      if (matrix && matrix.cursor <= stream.length) score += 10;
      if (targetDelta != null) {
        const bestDelta = Math.min(targetDelta, targetDeltaSwapped);
        if (bestDelta <= 16) score += 55;
        else if (bestDelta <= 48) score += 30;
        else if (bestDelta <= 96) score += 12;
      }
      attempts.push({
        countRead,
        count: countToken.value,
        recordStride,
        tableBytes: countToken.value * recordStride,
        fieldsOffset: hex(countToken.next + countToken.value * recordStride, 4),
        fields: fields.tokens,
        grid: positive ? { cellW, cellH, width, height, columns: gridW, rows: gridH, cells: matrixCells } : null,
        targetDelta,
        targetDeltaSwapped,
        matrixEnd: hex(matrixEnd, 4),
        bytesToFfCandidate: ffOffset >= 0 ? ffOffset - matrixEnd : null,
        firstMatrixTokens: matrix ? matrix.tokens.slice(0, 12) : [],
        score,
      });
    }
  }

  attempts.sort((a, b) => b.score - a.score || Math.abs(a.bytesToFfCandidate ?? 999999) - Math.abs(b.bytesToFfCandidate ?? 999999));
  return {
    note: "Diagnostic only: candidate parse inspired by CBE 0x0F222. Field order follows the disassembly: cellW, cellH, extentW, extentH. This still scans record strides and is not a proven renderer.",
    ffTokenCandidate: ffCandidate ? actorDividerSummary(stream, ffCandidate) : null,
    attempts: attempts.slice(0, 8),
  };
}

function readCompactTokenAt(stream, cursorRef, limitValue = 0x7fffffff) {
  const token = decodeCompactToken(stream, cursorRef.value);
  if (!token || token.truncated || Math.abs(token.value) > limitValue) return null;
  const out = {
    offset: hex(token.offset, 4),
    tag: token.tag,
    value: token.value,
    unsigned32: token.unsigned32 ?? null,
    raw: token.raw,
  };
  cursorRef.value = token.next;
  return out;
}

function readFourCompactReferenceTable(stream) {
  const cursor = { value: 0 };
  const countToken = readCompactTokenAt(stream, cursor, 1024);
  if (!countToken || countToken.value <= 0 || countToken.value > 512) return null;

  const records = [];
  let truncatedAtRecord = null;
  let truncatedReason = "";
  for (let i = 0; i < countToken.value; i += 1) {
    const fields = [];
    for (let field = 0; field < 4; field += 1) {
      const token = readCompactTokenAt(stream, cursor, 0x7fffffff);
      if (!token) {
        truncatedAtRecord = i;
        truncatedReason = `record ${i} field ${field}`;
        break;
      }
      fields.push(token);
    }
    if (truncatedAtRecord != null) break;
    records.push({
      index: i,
      offset: fields[0]?.offset || "",
      values: fields.map((field) => field.value),
      raw: fields.map((field) => field.raw).join(" | "),
      fields,
    });
  }

  const afterRecords = cursor.value;
  return {
    countToken,
    records,
    afterRecords,
    truncatedAtRecord,
    truncatedReason,
  };
}

function readFixedStrideReferenceTable(stream, stride) {
  const cursor = { value: 0 };
  const countToken = readCompactTokenAt(stream, cursor, 1024);
  if (!countToken || countToken.value <= 0 || countToken.value > 512) return null;
  const start = cursor.value;
  const afterRecords = start + countToken.value * stride;
  if (afterRecords > stream.length) {
    return {
      countToken,
      records: [],
      afterRecords: stream.length,
      truncatedAtRecord: Math.max(0, Math.floor((stream.length - start) / stride)),
      truncatedReason: `fixed stride ${stride} exceeds stream length`,
      method: `fixed${stride}`,
      stride,
    };
  }

  const records = [];
  for (let i = 0; i < countToken.value; i += 1) {
    const offset = start + i * stride;
    records.push({
      index: i,
      offset: hex(offset, 4),
      values: [],
      raw: hexBytes(stream.subarray(offset, offset + stride)),
      fields: [],
    });
  }
  return {
    countToken,
    records,
    afterRecords,
    truncatedAtRecord: null,
    truncatedReason: "",
    method: `fixed${stride}`,
    stride,
  };
}

function decodeTemplateMatrixToken(token, slotCount = 0) {
  const unsigned = token.unsigned32 == null ? (token.value >>> 0) : token.unsigned32 >>> 0;
  const pictureSlot = (unsigned >>> 28) & 0x0f;
  return {
    ...token,
    pictureSlot,
    payload24: unsigned & 0x00ffffff,
    slotInTable: slotCount ? pictureSlot < slotCount : null,
  };
}

function readCompactTokenSequence(stream, offset = 0, limit = 256) {
  const tokens = [];
  let cursor = offset;
  while (cursor < stream.length && tokens.length < limit) {
    const token = decodeCompactToken(stream, cursor);
    if (!token) break;
    tokens.push({
      offset: hex(token.offset, 4),
      numericOffset: token.offset,
      tag: token.tag,
      value: token.value,
      unsigned32: token.unsigned32 ?? null,
      raw: token.raw,
      byteLength: token.next - token.offset,
      next: token.next,
      truncated: Boolean(token.truncated),
    });
    cursor = token.next;
  }
  return { tokens, cursor };
}

function buildF222Attempt(stream, table, imageInfo, ffCandidate) {
  if (!table) return null;
  const fieldsCursor = { value: table.afterRecords };
  const fields = [];
  let truncatedField = null;
  for (let i = 0; i < 4; i += 1) {
    const token = readCompactTokenAt(stream, fieldsCursor, 4096);
    if (!token) {
      truncatedField = i;
      break;
    }
    fields.push(token);
  }

  const values = fields.map((field) => field.value);
  const [cellW, cellH, extentW, extentH] = values;
  const positive = values.length === 4 && values.every((value) => value > 0 && value <= 4096);
  const floorColumns = positive && cellW ? Math.trunc(extentW / cellW) : 0;
  const floorRows = positive && cellH ? Math.trunc(extentH / cellH) : 0;
  const ceilColumns = positive && cellW ? Math.ceil(extentW / cellW) : 0;
  const ceilRows = positive && cellH ? Math.ceil(extentH / cellH) : 0;
  const floorCells = floorColumns * floorRows;
  const ceilCells = ceilColumns * ceilRows;

  const matrixCursor = { value: fieldsCursor.value };
  const matrix = [];
  let matrixTruncatedAt = null;
  const matrixCells = ceilCells;
  if (positive && matrixCells > 0 && matrixCells <= 4096) {
    for (let i = 0; i < matrixCells; i += 1) {
      const token = readCompactTokenAt(stream, matrixCursor, 0x7fffffff);
      if (!token) {
        matrixTruncatedAt = i;
        break;
      }
      matrix.push(decodeTemplateMatrixToken(token, table.countToken.value));
    }
  }

  const matrixEnd = matrixCursor.value;
  const image = imageInfo?.width && imageInfo?.height ? {
    width: imageInfo.width,
    height: imageInfo.height,
    extentDelta: positive ? Math.abs(extentW - imageInfo.width) + Math.abs(extentH - imageInfo.height) : null,
    cellDelta: positive ? Math.abs(cellW - imageInfo.width) + Math.abs(cellH - imageInfo.height) : null,
  } : null;
  const targetDelta = image?.extentDelta ?? null;

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

  return {
    score,
    referenceTableApproximation: table.method === "compact4" ? "four compact tokens per +0x64 entry" : `${table.stride} raw bytes per +0x64 entry`,
    tableMethod: table.method,
    recordStride: table.stride ?? null,
    count: table.countToken.value,
    countRaw: table.countToken.raw,
    tableComplete: table.truncatedAtRecord == null && table.records.length === table.countToken.value,
    tableAfterOffset: hex(table.afterRecords, 4),
    tableTruncatedAtRecord: table.truncatedAtRecord,
    tableTruncatedReason: table.truncatedReason,
    fieldsOffset: hex(table.afterRecords, 4),
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
      floorColumns,
      floorRows,
      floorCells,
      ceilColumns,
      ceilRows,
      ceilCells,
    } : null,
    matrixEndOffset: hex(matrixEnd, 4),
    matrixRead: matrix.length,
    matrixExpected: matrixCells,
    matrixTruncatedAt,
    firstMatrixTokens: matrix.slice(0, 16),
    ffTokenCandidate: ffCandidate ? actorDividerSummary(stream, ffCandidate) : null,
    bytesToFfCandidate: ffCandidate ? ffCandidate.markerStart - matrixEnd : null,
    image,
  };
}

function probeF222Layout(stream, imageInfo = null) {
  const compactTable = readFourCompactReferenceTable(stream);
  const ffCandidate = findActorStreamDividers(stream)[0] || null;
  const tables = [];
  if (compactTable) tables.push({ ...compactTable, method: "compact4", stride: null });
  for (const stride of [4, 6, 8, 10, 12, 16]) {
    const table = readFixedStrideReferenceTable(stream, stride);
    if (table && table.truncatedAtRecord == null) tables.push(table);
  }

  const attempts = tables
    .map((table) => buildF222Attempt(stream, table, imageInfo, ffCandidate))
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || Math.abs(a.bytesToFfCandidate ?? 999999) - Math.abs(b.bytesToFfCandidate ?? 999999));
  const best = attempts[0] || null;
  if (!best) return null;

  return {
    note: "Diagnostic, code-anchored: CBE 0x0F222 reads a count table via reader +0x64, converts entries through PictureLibrary +0x1c, then reads object+0/+4/+8/+0C and a 2D matrix via reader +0x50. 0x0F222 proves +0/+4 are cell divisors and +8/+0C are extents; 0x0F326 proves matrix token high nibble is the picture slot and low 24 bits are payload. The +0x64 record consumer is still selected by scored candidates until that reader method is fully reversed.",
    attempts: attempts.slice(0, 6).map((attempt) => ({
      score: attempt.score,
      tableMethod: attempt.tableMethod,
      recordStride: attempt.recordStride,
      referenceTableApproximation: attempt.referenceTableApproximation,
      tableAfterOffset: attempt.tableAfterOffset,
      fieldsOffset: attempt.fieldsOffset,
      fields: attempt.fields,
      grid: attempt.grid,
      matrixEndOffset: attempt.matrixEndOffset,
      matrixRead: attempt.matrixRead,
      matrixExpected: attempt.matrixExpected,
      bytesToFfCandidate: attempt.bytesToFfCandidate,
      image: attempt.image,
      firstMatrixTokens: attempt.firstMatrixTokens.slice(0, 8),
    })),
    ...best,
  };
}

function compactTokenSummaryLine(token, absoluteBase = 0) {
  if (!token) return "-";
  return `${hex(absoluteBase + token.numericOffset, 4)}:${token.value}(${token.raw})`;
}

function scoreMapTemplateWindow(fields, startToken, tokenCount, matrixEnd, streamLength, canvas, tableCandidate) {
  const values = fields.map((field) => field.value);
  const [cellW, cellH, extentW, extentH] = values;
  const positive = values.length === 4 && values.every((value) => Number.isFinite(value) && value > 0 && value <= 4096);
  if (!positive) return { score: -200, reason: "non-positive fields" };

  const columns = Math.ceil(extentW / cellW);
  const rows = Math.ceil(extentH / cellH);
  const cells = columns * rows;
  let score = 0;
  const reasons = [];

  if (cellW >= 4 && cellW <= 64 && cellH >= 4 && cellH <= 64) {
    score += 24;
    reasons.push("cell size plausible");
  } else if (cellW <= 128 && cellH <= 128) {
    score += 8;
    reasons.push("large cell size");
  } else {
    score -= 18;
    reasons.push("cell size implausible");
  }

  if (cells >= 16 && cells <= 4096) {
    score += 24;
    reasons.push("matrix cell count plausible");
  } else if (cells > 0 && cells < 16) {
    score -= 24;
    reasons.push("matrix too small for terrain");
  } else {
    score -= 40;
    reasons.push("matrix too large");
  }

  if (canvas?.width && canvas?.height) {
    const delta = Math.abs(extentW - canvas.width) + Math.abs(extentH - canvas.height);
    const swappedDelta = Math.abs(extentW - canvas.height) + Math.abs(extentH - canvas.width);
    const bestDelta = Math.min(delta, swappedDelta);
    if (bestDelta === 0) {
      score += 90;
      reasons.push("extent matches canvas");
    } else if (bestDelta <= 32) {
      score += 60;
      reasons.push("extent near canvas");
    } else if (bestDelta <= 128) {
      score += 28;
      reasons.push("extent roughly canvas-sized");
    } else if (bestDelta <= 256) {
      score -= 10;
      reasons.push("extent still far from canvas");
    } else if (extentW >= canvas.width * 0.5 && extentH >= canvas.height * 0.5) {
      score += 10;
      reasons.push("extent partially canvas-sized");
    } else {
      score -= 60;
      reasons.push("extent far from canvas");
    }
  }

  const remaining = streamLength - matrixEnd;
  if (remaining >= 0) {
    score += 8;
    if (remaining < 16) {
      score += 12;
      reasons.push("matrix consumes stream tail");
    } else if (remaining < streamLength * 0.35) {
      score += 6;
      reasons.push("small post-matrix tail");
    }
  } else {
    score -= 60;
    reasons.push("matrix overreads stream");
  }

  if (tableCandidate?.method === "compact4") score += 8;
  if (tableCandidate?.method === "fixed8") score -= 4;
  if (startToken > 0 && startToken <= 32) score += 4;
  if (tokenCount >= 16) score += 6;

  return { score, reason: reasons.join("; "), cells, columns, rows };
}

function buildMapTemplateCandidate(stream, tokens, startToken, tableCandidate, canvas, drawStreamOffset = 0) {
  const fields = tokens.slice(startToken, startToken + 4);
  if (fields.length < 4) return null;
  const values = fields.map((field) => field.value);
  const [cellW, cellH, extentW, extentH] = values;
  const positive = values.every((value) => Number.isFinite(value) && value > 0 && value <= 4096);
  const columns = positive ? Math.ceil(extentW / cellW) : 0;
  const rows = positive ? Math.ceil(extentH / cellH) : 0;
  const cells = columns * rows;
  if (!positive || cells <= 0 || cells > 4096) return null;

  const matrixStart = fields[3].next;
  let cursor = matrixStart;
  const matrix = [];
  let truncatedAt = null;
  for (let i = 0; i < cells; i += 1) {
    const token = decodeCompactToken(stream, cursor);
    if (!token) {
      truncatedAt = i;
      break;
    }
    matrix.push(decodeTemplateMatrixToken({
      offset: hex(token.offset, 4),
      numericOffset: token.offset,
      tag: token.tag,
      value: token.value,
      unsigned32: token.unsigned32 ?? null,
      raw: token.raw,
    }, tableCandidate?.count ?? 0));
    cursor = token.next;
  }

  const scored = scoreMapTemplateWindow(fields, startToken, tokens.length, cursor, stream.length, canvas, tableCandidate);
  const delta = canvas?.width && canvas?.height
    ? Math.abs(extentW - canvas.width) + Math.abs(extentH - canvas.height)
    : null;
  const swappedDelta = canvas?.width && canvas?.height
    ? Math.abs(extentW - canvas.height) + Math.abs(extentH - canvas.width)
    : null;

  return {
    score: scored.score,
    reason: scored.reason,
    startToken,
    fieldsOffset: hex(drawStreamOffset + fields[0].numericOffset, 4),
    tableCandidate: tableCandidate ? {
      method: tableCandidate.method,
      count: tableCandidate.count,
      countRaw: tableCandidate.countRaw,
      afterOffset: hex(drawStreamOffset + tableCandidate.afterOffset, 4),
      recordBytes: tableCandidate.recordBytes ?? null,
      tokenEnd: tableCandidate.tokenEnd ?? null,
    } : null,
    fields: fields.map((field, index) => ({
      objectOffset: ["+0x00", "+0x04", "+0x08", "+0x0C"][index],
      role: ["cellW/divisor", "cellH/divisor", "extentW/dividend", "extentH/dividend"][index],
      offset: hex(drawStreamOffset + field.numericOffset, 4),
      tag: field.tag,
      value: field.value,
      raw: field.raw,
    })),
    grid: {
      extentW,
      extentH,
      cellW,
      cellH,
      columns,
      rows,
      cells,
    },
    canvasDelta: delta,
    canvasDeltaSwapped: swappedDelta,
    matrixStartOffset: hex(drawStreamOffset + matrixStart, 4),
    matrixEndOffset: hex(drawStreamOffset + cursor, 4),
    matrixRead: matrix.length,
    matrixExpected: cells,
    matrixTruncatedAt: truncatedAt,
    bytesRemaining: stream.length - cursor,
    firstMatrixTokens: matrix.slice(0, 18).map((token) => ({
      ...token,
      offset: hex(drawStreamOffset + token.numericOffset, 4),
    })),
  };
}

function probeMapTemplateStream(stream, canvas = null, drawStreamOffset = 0) {
  const { tokens } = readCompactTokenSequence(stream, 0, 768);
  const tableCandidates = [];
  const countToken = tokens[0] || null;
  if (countToken && countToken.value > 0 && countToken.value <= 128) {
    for (const stride of [4, 6, 8, 10, 12, 14, 16]) {
      const afterOffset = countToken.byteLength + countToken.value * stride;
      if (afterOffset < stream.length) {
        const tokenIndex = tokens.findIndex((token) => token.numericOffset >= afterOffset);
        if (tokenIndex >= 0) {
          tableCandidates.push({
            method: `fixed${stride}`,
            count: countToken.value,
            countRaw: countToken.raw,
            afterOffset,
            recordBytes: stride,
            tokenEnd: tokenIndex,
          });
        }
      }
    }

    let tokenEnd = 1 + countToken.value * 4;
    if (tokenEnd + 4 <= tokens.length) {
      tableCandidates.push({
        method: "compact4",
        count: countToken.value,
        countRaw: countToken.raw,
        afterOffset: tokens[tokenEnd]?.numericOffset ?? stream.length,
        recordBytes: null,
        tokenEnd,
      });
    }
  }

  const seenStarts = new Map();
  const starts = new Set();
  for (const table of tableCandidates) starts.add(table.tokenEnd);
  for (let index = 0; index + 4 <= Math.min(tokens.length, 96); index += 1) starts.add(index);

  const candidates = [];
  for (const startToken of starts) {
    const matchingTable = tableCandidates.find((table) => table.tokenEnd === startToken) || null;
    const candidate = buildMapTemplateCandidate(stream, tokens, startToken, matchingTable, canvas, drawStreamOffset);
    if (!candidate) continue;
    const key = `${candidate.fieldsOffset}:${candidate.grid.cellW}:${candidate.grid.cellH}:${candidate.grid.extentW}:${candidate.grid.extentH}`;
    const previous = seenStarts.get(key);
    if (!previous || candidate.score > previous.score) seenStarts.set(key, candidate);
  }

  candidates.push(...seenStarts.values());
  candidates.sort((a, b) => b.score - a.score || Math.abs(a.canvasDelta ?? 999999) - Math.abs(b.canvasDelta ?? 999999));
  const best = candidates[0] || null;
  const bestCanvasDelta = best ? Math.min(best.canvasDelta ?? Infinity, best.canvasDeltaSwapped ?? Infinity) : null;

  const prefixTokens = tokens.slice(0, 40).map((token) => ({
    offset: hex(drawStreamOffset + token.numericOffset, 4),
    tag: token.tag,
    value: token.value,
    raw: token.raw,
  }));

  return {
    note: "Code-anchored diagnostic: SCE map records are passed to 0x0F616, which calls 0x0F222. This probe searches the .map post-header compact stream for the object fields and matrix shape that 0x0F222 consumes; candidates are structural evidence, not final terrain rendering.",
    drawStreamOffset: hex(drawStreamOffset, 4),
    tokenCount: tokens.length,
    firstTokens: prefixTokens,
    tableCandidates: tableCandidates.slice(0, 10).map((table) => ({
      ...table,
      afterOffset: hex(drawStreamOffset + table.afterOffset, 4),
    })),
    best,
    bestCanvasDelta,
    nearCanvas: bestCanvasDelta != null && bestCanvasDelta <= 128,
    candidates: candidates.slice(0, 10),
  };
}

function probeActorFrameTable(stream, imageInfo = null) {
  const table = readFourCompactReferenceTable(stream);
  if (!table) return null;

  const cursor = { value: table.afterRecords };
  const nextTokens = [];
  for (let i = 0; i < 16; i += 1) {
    const token = readCompactTokenAt(stream, cursor, 0x7fffffff);
    if (!token) break;
    nextTokens.push(token);
  }

  const columns = [0, 1, 2, 3].map((column) => {
    const values = table.records.map((record) => record.values[column]).filter((value) => Number.isFinite(value));
    return {
      min: values.length ? Math.min(...values) : null,
      max: values.length ? Math.max(...values) : null,
      unique: new Set(values).size,
    };
  });
  const image = imageInfo?.width && imageInfo?.height ? {
    width: imageInfo.width,
    height: imageInfo.height,
    valuesWithinImagePercent: table.records.length
      ? Number(((table.records.filter((record) => (
          record.values[0] >= -imageInfo.width && record.values[0] <= imageInfo.width * 2 &&
          record.values[1] >= -imageInfo.height && record.values[1] <= imageInfo.height * 2
        )).length / table.records.length) * 100).toFixed(2))
      : 0,
  } : null;

  return {
    note: "Diagnostic only: CBE 0x0F222 confirms this leading table is read by reader +0x64 and converted through PictureLibrary +0x1c into u16 picture IDs. The displayed four-compact-value records are an approximation of +0x64 consumption, not proven frame/body-part rectangles.",
    count: table.countToken.value,
    countRaw: table.countToken.raw,
    afterRecordsOffset: hex(table.afterRecords, 4),
    complete: table.truncatedAtRecord == null && table.records.length === table.countToken.value,
    truncatedAtRecord: table.truncatedAtRecord,
    truncatedReason: table.truncatedReason,
    records: table.records.slice(0, 24),
    recordCount: table.records.length,
    columns,
    image,
    nextTokens,
  };
}

function parseMap(buf, runs, options = {}) {
  const firstRun = runs.find((run) => run.offset >= 0x0f);
  const gifRef = findGifRef(runs);
  const templateHeader = parsePictureTemplateHeader(buf);
  const headerEnd = templateHeader?.streamOffset || gifRef?.end || (firstRun ? firstRun.offset + firstRun.text.length : 0x0f);
  const dimension = findMapDimensionEncoding(buf, headerEnd, options.sceneCanvas);
  const leadHeader = inferMapLeadHeader(buf, headerEnd, options.sceneCanvas);
  const headerCanvas = dimension?.height ? { width: dimension.width, height: dimension.height } : null;
  const canvas = options.sceneCanvas || headerCanvas;
  const dataOffset = Math.min(Math.max(options.sceneCanvas ? headerEnd : (dimension?.dataOffset || headerEnd), 0), buf.length);
  const leadDrawOffset = leadHeader?.drawStreamOffset
    ? Number.parseInt(String(leadHeader.drawStreamOffset).replace(/^0x/i, ""), 16)
    : dataOffset;
  const drawStreamOffset = Math.min(Math.max(Number.isFinite(leadDrawOffset) ? leadDrawOffset : dataOffset, dataOffset, 0), buf.length);
  const tileGrid = canvas ? {
    columns16: Math.ceil(canvas.width / 16),
    rows16: Math.ceil(canvas.height / 16),
  } : null;
  const payload = buf.subarray(dataOffset);
  const drawPayload = buf.subarray(drawStreamOffset);
  const compactProbe = probeCompactStream(drawPayload, canvas);

  let tilesetHint = templateHeader?.compactName || gifRef?.text || cleanAsciiRef(firstRun?.text || "");
  if (firstRun && gifRef && firstRun.offset < gifRef.offset && !/\.gif$/i.test(firstRun.text)) {
    tilesetHint = `${cleanAsciiRef(firstRun.text)} ... ${gifRef.text}`;
  }

  return {
    packedLengthHint: buf.length >= 4 ? buf.readUInt16LE(2) : 0,
    firstRunOffset: firstRun ? hex(firstRun.offset, 4) : "",
    tilesetHint,
    pictureTemplate: summarizeTemplateHeader(templateHeader),
    canvas,
    canvasSource: options.sceneCanvas ? "sibling .sce" : (headerCanvas ? "map header" : ""),
    headerDimension: dimension ? {
      offset: hex(dimension.offset, 4),
      encoding: dimension.encoding,
      width: dimension.width,
      height: dimension.height,
      ignoredForSceneCanvas: Boolean(options.sceneCanvas),
    } : null,
    leadHeader,
    dataOffset: hex(dataOffset, 4),
    payloadLength: Math.max(0, buf.length - dataOffset),
    drawStreamOffset: hex(drawStreamOffset, 4),
    drawStreamLength: Math.max(0, buf.length - drawStreamOffset),
    drawStreamReason: leadHeader ? `map lead header: ${leadHeader.encoding}` : "no separate map lead header found",
    tileGrid,
    compactProbe,
    stream: analyzeMapStream(drawPayload, canvas),
    mapTemplateProbe: probeMapTemplateStream(drawPayload, canvas, drawStreamOffset),
    f222LayoutProbe: probeF222Layout(drawPayload, canvas),
    templateStreamProbe: probeTemplateStream(drawPayload, { canvas }),
  };
}

function inferMapLeadHeader(buf, offset, knownCanvas) {
  if (!knownCanvas || offset < 0 || offset + 4 > buf.length) return null;
  const knownWidth = knownCanvas.width || 0;
  const knownHeight = knownCanvas.height || 0;
  if (!knownWidth || !knownHeight) return null;

  const bytes = (end) => Array.from(buf.subarray(offset, Math.min(buf.length, end))).map(byteHex).join(" ");
  const commonDrawStart = (byte) => byte === 0x04 || byte === 0x06 || byte === 0x08 || byte === 0x10 ||
    byte === 0x12 ||
    byte === 0x18 || byte === 0x20 || byte >= 0x80;
  if (offset + 8 <= buf.length && buf.readUInt32LE(offset) === knownWidth && buf.readUInt32LE(offset + 4) === knownHeight) {
    return {
      offset: hex(offset, 4),
      drawStreamOffset: hex(offset + 8, 4),
      length: 8,
      encoding: "u32 width + u32 height",
      width: knownWidth,
      height: knownHeight,
      matchesSceneCanvas: true,
      bytes: bytes(offset + 8),
    };
  }

  if (offset + 6 <= buf.length && buf.readUInt32LE(offset) === knownWidth && buf.readUInt16LE(offset + 4) === knownHeight) {
    return {
      offset: hex(offset, 4),
      drawStreamOffset: hex(offset + 6, 4),
      length: 6,
      encoding: "u32 width + u16 height",
      width: knownWidth,
      height: knownHeight,
      matchesSceneCanvas: true,
      bytes: bytes(offset + 6),
    };
  }

  if (offset + 6 <= buf.length) {
    const storedWidth = buf.readUInt16LE(offset);
    const flags = buf.readUInt16LE(offset + 2);
    const height = buf.readUInt16LE(offset + 4);
    const widthBias = storedWidth - knownWidth;
    const hasZeroTerminator = offset + 8 <= buf.length && buf[offset + 6] === 0x00 && buf[offset + 7] === 0x00;
    if ((widthBias === 0x500 || widthBias === 0x600) && height === knownHeight && (flags & 0x8000)) {
      const length = hasZeroTerminator ? 8 : 6;
      return {
        offset: hex(offset, 4),
        drawStreamOffset: hex(offset + length, 4),
        length,
        encoding: "biased u16 width + flags + u16 height",
        width: knownWidth,
        height,
        storedWidth,
        widthBias,
        flags: hex(flags, 4),
        matchesSceneCanvas: true,
        bytes: bytes(offset + length),
      };
    }
  }

  if (offset + 4 <= buf.length && buf.readUInt16LE(offset) === knownWidth && buf.readUInt16LE(offset + 2) === knownHeight) {
    return {
      offset: hex(offset, 4),
      drawStreamOffset: hex(offset + 4, 4),
      length: 4,
      encoding: "u16 width + u16 height",
      width: knownWidth,
      height: knownHeight,
      matchesSceneCanvas: true,
      bytes: bytes(offset + 4),
    };
  }

  if (offset + 4 <= buf.length && buf.readUInt32LE(offset) === knownWidth && commonDrawStart(buf[offset + 4])) {
    return {
      offset: hex(offset, 4),
      drawStreamOffset: hex(offset + 4, 4),
      length: 4,
      encoding: "u32 width only; height from scene",
      width: knownWidth,
      height: knownHeight,
      matchesSceneCanvas: true,
      bytes: bytes(offset + 4),
    };
  }

  if (offset + 8 <= buf.length && buf.readUInt32LE(offset) === knownWidth &&
      buf[offset + 6] === 0x00 && buf[offset + 7] === 0x00 && commonDrawStart(buf[offset + 8])) {
    const field = buf.readUInt16LE(offset + 4);
    return {
      offset: hex(offset, 4),
      drawStreamOffset: hex(offset + 8, 4),
      length: 8,
      encoding: "u32 width + u16 field + zero terminator; height from scene",
      width: knownWidth,
      height: knownHeight,
      field,
      matchesSceneCanvas: true,
      bytes: bytes(offset + 8),
    };
  }

  if (offset + 8 <= buf.length && buf.readUInt16LE(offset) === knownWidth &&
      buf[offset + 6] === 0x00 && buf[offset + 7] === 0x00 && commonDrawStart(buf[offset + 8])) {
    const field = buf.readUInt16LE(offset + 2);
    const possibleHeight = buf.readUInt16LE(offset + 4);
    return {
      offset: hex(offset, 4),
      drawStreamOffset: hex(offset + 8, 4),
      length: 8,
      encoding: "u16 width + two u16 fields + zero terminator; height from scene",
      width: knownWidth,
      height: knownHeight,
      field,
      possibleHeight,
      matchesSceneCanvas: true,
      bytes: bytes(offset + 8),
    };
  }

  if (offset + 4 <= buf.length && buf.readUInt16LE(offset) === knownWidth && commonDrawStart(buf[offset + 4])) {
    const field = buf.readUInt16LE(offset + 2);
    return {
      offset: hex(offset, 4),
      drawStreamOffset: hex(offset + 4, 4),
      length: 4,
      encoding: "u16 width + u16 field; height from scene",
      width: knownWidth,
      height: knownHeight,
      field,
      matchesSceneCanvas: true,
      bytes: bytes(offset + 4),
    };
  }

  if (offset + 2 <= buf.length && buf.readUInt16LE(offset) === knownWidth && commonDrawStart(buf[offset + 2])) {
    return {
      offset: hex(offset, 4),
      drawStreamOffset: hex(offset + 2, 4),
      length: 2,
      encoding: "u16 width only; height from scene",
      width: knownWidth,
      height: knownHeight,
      matchesSceneCanvas: true,
      bytes: bytes(offset + 2),
    };
  }

  if (commonDrawStart(buf[offset])) {
    return {
      offset: hex(offset, 4),
      drawStreamOffset: hex(offset, 4),
      length: 0,
      encoding: "no separate map lead header; draw stream starts after tileset name",
      width: knownWidth,
      height: knownHeight,
      matchesSceneCanvas: true,
      bytes: "",
    };
  }

  return null;
}

function parseResourceEnvelope(buf) {
  const declaredBodyLength = buf.length >= 5 ? buf.readUInt16BE(3) : null;
  return {
    tag: buf.length ? byteHex(buf[0]) : "",
    declaredBodyLength,
    bodyOffset: 9,
    bodyLength: Math.max(0, buf.length - 9),
    lengthMatches: declaredBodyLength === Math.max(0, buf.length - 9),
    headerBytes: Array.from(buf.subarray(0, Math.min(16, buf.length))).map(byteHex).join(" "),
  };
}

function findCatalogEntryByName(name, catalogEntries = []) {
  const target = stripIndexPrefix(path.basename(cleanAsciiRef(name || ""))).toLowerCase();
  if (!target) return null;
  return catalogEntries.find((entry) => {
    const base = stripIndexPrefix(path.basename(entry.name || entry.rel || "")).toLowerCase();
    return base === target;
  }) || null;
}

function catalogOutputPath(entry) {
  if (!entry) return "";
  return entry.output || "";
}

function findSiblingResource(resourceDir, name) {
  if (!resourceDir || !name) return "";
  try {
    const target = stripIndexPrefix(path.basename(name)).toLowerCase();
    const match = fssync.readdirSync(resourceDir)
      .find((entry) => stripIndexPrefix(entry).toLowerCase() === target);
    return match ? path.join(resourceDir, match) : "";
  } catch {
    return "";
  }
}

function printableResourceSegments(bytes, min = 2) {
  const segments = [];
  let start = -1;
  for (let i = 0; i <= bytes.length; i += 1) {
    const byte = i < bytes.length ? bytes[i] : 0;
    const ok = isResourceTextChar(byte);
    if (ok && start < 0) start = i;
    if (!ok && start >= 0) {
      if (i - start >= min) {
        segments.push({
          offset: start,
          text: bytes.subarray(start, i).toString("ascii"),
        });
      }
      start = -1;
    }
  }
  return segments;
}

function compactResourceText(bytes) {
  return printableResourceSegments(bytes, 1).map((segment) => segment.text).join("");
}

function visibleBytesText(bytes) {
  return Array.from(bytes).map((byte) => (byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : ".")).join("");
}

function parsePictureTemplateHeader(buf) {
  const bodyOffset = 9;
  const nameLengthOffset = bodyOffset + 5;
  const nameOffset = bodyOffset + 6;
  if (buf.length <= nameLengthOffset) return null;

  const declaredNameLength = buf[nameLengthOffset];
  if (declaredNameLength < 3 || declaredNameLength > 64 || nameOffset + declaredNameLength > buf.length) return null;

  const rawName = buf.subarray(nameOffset, nameOffset + declaredNameLength);
  const gifNeedle = Buffer.from(".gif", "ascii");
  const gifAt = rawName.indexOf(gifNeedle);
  const logicalNameLength = gifAt >= 0 ? gifAt + gifNeedle.length : declaredNameLength;
  const logicalName = rawName.subarray(0, logicalNameLength);
  const streamOffset = nameOffset + logicalNameLength;

  return {
    bodyOffset,
    headerBytes: Array.from(buf.subarray(bodyOffset, nameLengthOffset)).map(byteHex).join(" "),
    headerWord0: buf.length >= bodyOffset + 2 ? buf.readUInt16LE(bodyOffset) : null,
    declaredNameLength,
    nameOffset,
    rawNameBytes: Array.from(rawName).map(byteHex).join(" "),
    rawNameText: visibleBytesText(rawName),
    compactName: cleanAsciiRef(compactResourceText(logicalName)),
    printableSegments: printableResourceSegments(logicalName, 2).map((segment) => ({
      offset: hex(nameOffset + segment.offset, 4),
      text: segment.text,
    })),
    streamOffset,
    trailingNameBytes: declaredNameLength > logicalNameLength
      ? Array.from(rawName.subarray(logicalNameLength)).map(byteHex).join(" ")
      : "",
  };
}

function parseActorHeader(buf) {
  return parsePictureTemplateHeader(buf);
}

function scoreActorImageCandidate(entry, actorHeader, actorStem) {
  if (!entry || entry.ext !== ".gif") return null;

  const compact = normalizeStem(actorHeader?.compactName || "");
  const compactStem = compact.replace(/\.gif$/i, "");
  const segments = (actorHeader?.printableSegments || [])
    .map((segment) => normalizeStem(segment.text).replace(/\.gif$/i, ""))
    .filter((segment) => segment && segment !== "gif");
  const prefix = segments.find((segment) => segment.length >= 3 && !segment.startsWith(".")) || "";
  const suffix = segments.slice().reverse().find((segment) => segment.length >= 1 && !segment.startsWith(".")) || "";

  let score = 0;
  let reason = "";
  if (compact && entry.baseNorm === compact) {
    score = 1000;
    reason = "actor header exact gif";
  } else if (compactStem && entry.stemNorm === compactStem) {
    score = 980;
    reason = "actor header exact stem";
  } else if (actorStem && entry.stemNorm === actorStem) {
    score = 920;
    reason = "actor file stem fallback";
  } else if (prefix && suffix && prefix !== suffix && entry.stemNorm.startsWith(prefix) && entry.stemNorm.endsWith(suffix)) {
    score = 860 + Math.min(80, prefix.length + suffix.length);
    reason = "actor header prefix+suffix";
  } else if (prefix && entry.stemNorm.startsWith(prefix)) {
    score = 620 + Math.min(80, prefix.length);
    reason = "actor header prefix";
  } else if (compactStem && compactStem.length >= 5 && entry.stemNorm.includes(compactStem)) {
    score = 480 + Math.min(60, compactStem.length);
    reason = "actor header contains";
  }

  if (!score) return null;
  return { entry, score, reason };
}

function findActorImageEntry(actorHeader, options = {}) {
  const catalog = buildCatalog(options.catalog || []);
  const actorStem = resourceStem(options.name || "");
  const scored = catalog
    .map((entry) => scoreActorImageCandidate(entry, actorHeader, actorStem))
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || a.entry.base.localeCompare(b.entry.base));
  return scored[0] || null;
}

function matchActorAssetFragment(text, catalogEntries = [], actorStem = "") {
  const fragment = normalizeStem(cleanAsciiRef(text || ""));
  if (!fragment || fragment.length < 3) return null;
  const catalog = buildCatalog(catalogEntries)
    .filter((entry) => entry.ext === ".gif" || entry.ext === ".actor");

  let best = null;
  for (const entry of catalog) {
    let score = 0;
    let reason = "";
    if (entry.stemNorm === fragment || entry.baseNorm === fragment) {
      score = 100;
      reason = "exact";
    } else if (actorStem && fragment.length >= 4 && entry.stemNorm.startsWith(actorStem) && entry.stemNorm.endsWith(fragment)) {
      score = 94;
      reason = "actor stem + suffix";
    } else if (actorStem && fragment.length >= 4 && entry.stemNorm.includes(actorStem) && entry.stemNorm.includes(fragment)) {
      score = 88;
      reason = "same actor family";
    } else if (entry.stemNorm.startsWith(fragment) && fragment.length >= 6) {
      score = 82;
      reason = "prefix";
    } else if (entry.stemNorm.endsWith(fragment) && fragment.length >= 4) {
      score = 72;
      reason = "suffix";
    } else if (entry.stemNorm.includes(fragment) && fragment.length >= 5) {
      score = 56;
      reason = "contains";
    }
    if (score && (!best || score > best.score || entry.stemNorm.length < best.entry.stemNorm.length)) {
      best = { entry, score, reason };
    }
  }

  return best && best.score >= 72 ? best : null;
}

function findActorEmbeddedAssets(buf, streamOffset, catalogEntries = [], actorStem = "") {
  const streamRuns = asciiRuns(buf.subarray(streamOffset), 3, 80)
    .map((run) => ({ offset: streamOffset + run.offset, text: cleanAsciiRef(run.text) }))
    .filter((run) => /[A-Za-z]/.test(run.text));
  const seen = new Set();
  const out = [];
  for (const run of streamRuns) {
    const match = matchActorAssetFragment(run.text, catalogEntries, actorStem);
    if (!match) continue;
    const key = `${match.entry.baseNorm}:${run.offset}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      offset: hex(run.offset, 4),
      text: run.text,
      matched: match.entry.base,
      rel: match.entry.rel || "",
      reason: match.reason,
      score: match.score,
    });
    if (out.length >= 16) break;
  }
  return out;
}

function parseGifInfoBuffer(data) {
  try {
    if (data.length < 13 || data.subarray(0, 3).toString("ascii") !== "GIF") return null;
    let offset = 6;
    const width = data.readUInt16LE(offset);
    const height = data.readUInt16LE(offset + 2);
    const packed = data[offset + 4];
    offset += 7;
    if (packed & 0x80) offset += 3 * (1 << ((packed & 0x07) + 1));

    let graphicControls = 0;
    const graphicControlDetails = [];
    const delaysCentiseconds = [];
    const imageDescriptors = [];
    while (offset < data.length) {
      const block = data[offset++];
      if (block === 0x3b) break;
      if (block === 0x21) {
        const label = data[offset++];
        if (label === 0xf9) {
          const size = data[offset++];
          if (size === 4 && offset + 4 <= data.length) {
            const packedControl = data[offset];
            const delayCentiseconds = data.readUInt16LE(offset + 1);
            const transparentIndex = data[offset + 3];
            graphicControls += 1;
            graphicControlDetails.push({
              delayCentiseconds,
              disposalMethod: (packedControl >> 2) & 0x07,
              transparentColorFlag: Boolean(packedControl & 0x01),
              transparentIndex,
            });
            delaysCentiseconds.push(delayCentiseconds);
            offset += 4;
            if (offset < data.length && data[offset] === 0) {
              offset += 1;
            } else {
              while (offset < data.length) {
                const subSize = data[offset++];
                if (!subSize) break;
                offset += subSize;
              }
            }
            continue;
          }
          graphicControls += 1;
          offset += Math.max(0, size || 0);
          while (offset < data.length) {
            const subSize = data[offset++];
            if (!subSize) break;
            offset += subSize;
          }
          continue;
        }
        while (offset < data.length) {
          const size = data[offset++];
          if (!size) break;
          offset += size;
        }
        continue;
      }
      if (block === 0x2c && offset + 8 < data.length) {
        const x = data.readUInt16LE(offset);
        const y = data.readUInt16LE(offset + 2);
        const frameWidth = data.readUInt16LE(offset + 4);
        const frameHeight = data.readUInt16LE(offset + 6);
        const imagePacked = data[offset + 8];
        offset += 9;
        if (imagePacked & 0x80) offset += 3 * (1 << ((imagePacked & 0x07) + 1));
        offset += 1;
        while (offset < data.length) {
          const size = data[offset++];
          if (!size) break;
          offset += size;
        }
        imageDescriptors.push({ x, y, width: frameWidth, height: frameHeight });
        continue;
      }
      break;
    }

    const positiveDelays = delaysCentiseconds.filter((value) => value > 0);
    const delayCounts = new Map();
    for (const value of positiveDelays) delayCounts.set(value, (delayCounts.get(value) || 0) + 1);
    const dominantDelayCentiseconds = Array.from(delayCounts.entries())
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] || null;

    return {
      width,
      height,
      frames: imageDescriptors.length,
      graphicControls,
      graphicControlDetails: graphicControlDetails.slice(0, 8),
      delaysCentiseconds: delaysCentiseconds.slice(0, 16),
      uniqueDelaysCentiseconds: Array.from(new Set(delaysCentiseconds)).sort((a, b) => a - b),
      dominantDelayCentiseconds,
      nominalFps: dominantDelayCentiseconds ? Number((100 / dominantDelayCentiseconds).toFixed(2)) : null,
      imageDescriptors: imageDescriptors.slice(0, 8),
      sheetLike: imageDescriptors.length === 1,
    };
  } catch {
    return null;
  }
}

function parseGifInfo(file) {
  if (!file) return null;
  try {
    return parseGifInfoBuffer(fssync.readFileSync(file));
  } catch {
    return null;
  }
}

function findActorStreamDividers(stream) {
  const dividers = [];
  for (let i = 0; i + 2 < stream.length; i += 1) {
    if (stream[i] !== 0xff || stream[i + 1] !== 0xff || stream[i + 2] !== 0xff) continue;
    if (i > 0 && stream[i - 1] === 0xff) continue;
    const controlOffset = i >= 2 && stream[i - 2] >= 0x80 && stream[i - 1] >= 0x80 ? i - 2 : null;
    dividers.push({
      tripleOffset: i,
      controlOffset,
      markerStart: controlOffset == null ? i : controlOffset,
      markerEnd: i + 3,
    });
  }
  return dividers.sort((a, b) => {
    const ac = a.controlOffset == null ? 1 : 0;
    const bc = b.controlOffset == null ? 1 : 0;
    return ac - bc || a.tripleOffset - b.tripleOffset;
  });
}

function actorDividerSummary(stream, divider) {
  const contextStart = Math.max(0, divider.markerStart - 14);
  const contextEnd = Math.min(stream.length, divider.markerEnd + 28);
  return {
    offset: hex(divider.markerStart, 4),
    tripleOffset: hex(divider.tripleOffset, 4),
    controlOffset: divider.controlOffset == null ? "" : hex(divider.controlOffset, 4),
    markerLength: divider.markerEnd - divider.markerStart,
    markerBytes: hexBytes(stream.subarray(divider.markerStart, divider.markerEnd)),
    controlBytes: divider.controlOffset == null ? "" : hexBytes(stream.subarray(divider.controlOffset, divider.tripleOffset)),
    preDataLength: divider.markerStart,
    postOffset: hex(divider.markerEnd, 4),
    postLength: Math.max(0, stream.length - divider.markerEnd),
    context: hexBytes(stream.subarray(contextStart, contextEnd)),
  };
}

function actorStreamSection(stream, name, start, end) {
  return {
    name,
    offset: hex(start, 4),
    length: Math.max(0, end - start),
    firstBytes: hexBytes(stream.subarray(start, Math.min(end, start + 56))),
  };
}

function splitActorStreamSections(stream, divider) {
  if (!divider) {
    return [actorStreamSection(stream, "whole stream (no divider found)", 0, stream.length)];
  }

  const sections = [];
  if (divider.markerStart > 0) {
    sections.push(actorStreamSection(stream, "pre-token-candidate data", 0, divider.markerStart));
  }
  sections.push(actorStreamSection(stream, "ff-token candidate", divider.markerStart, divider.markerEnd));
  if (divider.markerEnd < stream.length) {
    sections.push(actorStreamSection(stream, "post-token-candidate data", divider.markerEnd, stream.length));
  }
  return sections;
}

function summarizeActorPostDivider(stream, divider) {
  if (!divider || divider.markerEnd >= stream.length) return null;
  const post = stream.subarray(divider.markerEnd);
  const words = [];
  for (let i = 0; i + 1 < post.length && words.length < 10; i += 2) {
    words.push({
      offset: hex(divider.markerEnd + i, 4),
      value: post.readUInt16LE(i),
    });
  }
  return {
    offset: hex(divider.markerEnd, 4),
    length: post.length,
    firstBytes: hexBytes(post.subarray(0, Math.min(64, post.length))),
    u16Head: words,
  };
}

function summarizeActorStream(stream) {
  const dividers = findActorStreamDividers(stream);
  const divider = dividers[0] || null;
  return {
    offsetLength: stream.length,
    highBitPercent: stream.length ? Number(((Array.from(stream).filter((byte) => byte >= 0x80).length / stream.length) * 100).toFixed(2)) : 0,
    zeroPercent: stream.length ? Number(((Array.from(stream).filter((byte) => byte === 0x00).length / stream.length) * 100).toFixed(2)) : 0,
    firstBytes: hexBytes(stream.subarray(0, Math.min(96, stream.length))),
    divider: divider ? actorDividerSummary(stream, divider) : null,
    dividerCandidates: dividers.slice(0, 8).map((item) => actorDividerSummary(stream, item)),
    sections: splitActorStreamSections(stream, divider),
    postDividerHeader: summarizeActorPostDivider(stream, divider),
    tokenProbe: probeActorTokens(stream),
    topBytes: topByteCounts(stream, 14),
    topPairs: topPairCounts(stream, 12),
  };
}

function probeActorTokens(stream, limit = 24) {
  const out = [];
  for (let i = 0; i < stream.length && out.length < limit;) {
    const token = decodeCompactToken(stream, i);
    if (!token) break;
    out.push({
      offset: hex(token.offset, 4),
      tag: token.tag,
      value: token.value,
      unsigned32: token.unsigned32,
      raw: token.raw,
      truncated: token.truncated || undefined,
    });
    i = token.next;
  }
  return out;
}

function parseActor(buf, inlineRefs, options = {}) {
  const imageRefs = inlineRefs.filter((ref) => /\.gif$/i.test(ref.text));
  const actorHeader = parseActorHeader(buf);
  const actorStem = resourceStem(options.name || "");
  const headerImage = findActorImageEntry(actorHeader, options);
  const primary = imageRefs[0] || null;
  const catalogEntry = headerImage?.entry || (primary ? findCatalogEntryByName(primary.text, options.catalog || []) : null);
  const imageName = catalogEntry?.base || actorHeader?.compactName || primary?.text || "";
  const imageFile = catalogOutputPath(catalogEntry) || findSiblingResource(options.resourceDir, imageName || primary?.text || "");
  const imageInfo = options.imageInfo || parseGifInfo(imageFile);
  const streamOffset = actorHeader?.streamOffset || (primary ? primary.offset + primary.text.length : 0);
  const stream = buf.subarray(Math.min(streamOffset, buf.length));
  return {
    header: actorHeader ? {
      bodyOffset: hex(actorHeader.bodyOffset, 4),
      headerBytes: actorHeader.headerBytes,
      headerWord0: actorHeader.headerWord0,
      declaredNameLength: actorHeader.declaredNameLength,
      nameOffset: hex(actorHeader.nameOffset, 4),
      rawNameBytes: actorHeader.rawNameBytes,
      rawNameText: actorHeader.rawNameText,
      compactName: actorHeader.compactName,
      printableSegments: actorHeader.printableSegments,
      trailingNameBytes: actorHeader.trailingNameBytes,
      imageMatchReason: headerImage?.reason || "",
      imageMatchScore: headerImage?.score || null,
    } : null,
    primaryImage: imageName,
    primaryImageRel: catalogEntry?.rel || "",
    imageRefs: imageRefs.map((ref) => ref.text),
    imageInfo,
    streamOffset: hex(streamOffset, 4),
    streamLength: stream.length,
    stream: summarizeActorStream(stream),
    frameTableProbe: probeActorFrameTable(stream, imageInfo),
    f222LayoutProbe: probeF222Layout(stream, imageInfo),
    templateStreamProbe: probeTemplateStream(stream, { imageInfo }),
    embeddedAssets: findActorEmbeddedAssets(buf, streamOffset, options.catalog || [], actorStem),
  };
}

function parseXse(buf) {
  const magic = buf.indexOf(Buffer.from("XSE0", "ascii"));
  const commands = [];
  for (const name of KNOWN_SCRIPT_COMMANDS) {
    let offset = -1;
    const needle = Buffer.from(name, "ascii");
    while ((offset = buf.indexOf(needle, offset + 1)) >= 0) {
      commands.push({ offset: hex(offset, 4), name });
    }
  }
  commands.sort((a, b) => Number.parseInt(a.offset.slice(2), 16) - Number.parseInt(b.offset.slice(2), 16));

  return {
    magicOffset: magic >= 0 ? hex(magic, 4) : "",
    declaredLengthHint: buf.length >= 4 ? buf.readUInt16LE(2) : 0,
    commands,
  };
}

function summarizeBuffer(name, buf, options = {}) {
  const ext = extOf(name);
  const runs = asciiRuns(buf);
  const inlineRefs = extractInlineRefs(runs);
  const refs = matchCatalogRefs(runs, inlineRefs, options.catalog || []);
  const textRuns = scanTextRuns(buf, 4, 80);
  const summary = {
    name,
    ext,
    size: buf.length,
    envelope: parseResourceEnvelope(buf),
    u16Head: readU16Head(buf),
    u32Head: readU32Head(buf),
    asciiRuns: runs.slice(0, 80).map((run) => ({ offset: hex(run.offset, 4), text: run.text })),
    refs: {
      direct: refs.direct.map((ref) => ({
        offset: hex(ref.offset, 4),
        text: ref.text,
        matched: ref.matched || "",
        rel: ref.rel || "",
      })),
      candidates: refs.candidates.map((ref) => ({
        offset: hex(ref.offset, 4),
        name: ref.name,
        rel: ref.rel,
        fragment: ref.fragment,
        reason: ref.reason,
        score: ref.score,
      })),
    },
    textRuns: textRuns.map((run) => ({ offset: hex(run.offset, 4), text: run.text })),
    specific: {},
  };

  if (ext === ".sce") summary.specific.sce = parseSce(buf, runs, options);
  if (ext === ".map") summary.specific.map = parseMap(buf, runs, options);
  if (ext === ".actor") summary.specific.actor = parseActor(buf, inlineRefs, { ...options, name });
  if (ext === ".xse") summary.specific.xse = parseXse(buf);

  return summary;
}

async function loadSiblingSceneCanvas(file, mapName) {
  const dir = path.dirname(file);
  const mapStem = resourceStem(mapName || file);
  if (!mapStem) return null;

  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch {
    return null;
  }

  const scenes = entries
    .filter((entry) => extOf(entry) === ".sce")
    .map((entry) => ({ entry, stem: resourceStem(entry) }));
  const match = scenes.find((entry) => entry.stem === mapStem) ||
    (mapStem.endsWith("d") ? scenes.find((entry) => entry.stem === mapStem.slice(0, -1)) : null);
  if (!match) return null;

  try {
    const buf = await fs.readFile(path.join(dir, match.entry));
    const summary = parseSce(buf, asciiRuns(buf));
    return summary.canvas ? { ...summary.canvas, scene: match.entry } : null;
  } catch {
    return null;
  }
}

async function summarizeFile(file, options = {}) {
  const buf = await fs.readFile(file);
  const name = options.name || path.basename(file);
  const ext = extOf(name);
  const sceneCanvas = ext === ".map" ? await loadSiblingSceneCanvas(file, name) : null;
  return summarizeBuffer(name, buf, { ...options, sceneCanvas, filePath: file, resourceDir: path.dirname(file) });
}

module.exports = {
  DATA_EXTS,
  KNOWN_SCRIPT_COMMANDS,
  asciiRuns,
  analyzeMapStream,
  buildCatalog,
  decodeCompactToken,
  findActorStreamDividers,
  hexBytes,
  parseActorHeader,
  parseGifInfo,
  parseGifInfoBuffer,
  parsePictureTemplateHeader,
  parseResourceEnvelope,
  parseSce,
  probe112C4ResourceBuffer,
  probeF222Layout,
  readCompactTokenAt,
  scanLengthPrefixedRefs,
  scanTextRuns,
  summarizeBuffer,
  summarizeFile,
};
