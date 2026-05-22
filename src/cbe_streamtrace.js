const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const {
  asciiRuns,
  decodeCompactToken,
  findActorStreamDividers,
  hexBytes,
  parseActorHeader,
  parseGifInfo,
  parsePictureTemplateHeader,
  parseResourceEnvelope,
  parseSce,
  probeF222Layout,
  probe112C4ResourceBuffer,
  scanLengthPrefixedRefs,
} = require("./cbe_struct");

const DEFAULT_FILES = [
  path.resolve(process.cwd(), "out_godwar", "section_1_39BCD", "0312_guangmingshendian.sce"),
  path.resolve(process.cwd(), "out_godwar", "section_1_39BCD", "0347_guangmingshendian.map"),
  path.resolve(process.cwd(), "out_godwar", "section_1_39BCD", "0401_heermode.actor"),
  path.resolve(process.cwd(), "out_godwar", "section_1_39BCD", "0423_nanna.actor"),
  path.resolve(process.cwd(), "out_godwar", "section_1_39BCD", "0392_fali.actor"),
  path.resolve(process.cwd(), "out_godwar", "section_1_39BCD", "0485_s_02.xse"),
];
const DEFAULT_OUT = path.resolve(process.cwd(), "out_godwar_streamtrace");
const DATA_EXTS = new Set([".sce", ".map", ".actor", ".xse"]);

function usage() {
  console.log(`Usage:
  node src/cbe_streamtrace.js [file_or_dir] [output_dir]

Examples:
  node src/cbe_streamtrace.js .\\out_godwar\\section_1_39BCD\\0312_guangmingshendian.sce .\\out_godwar_streamtrace
  node src/cbe_streamtrace.js .\\out_godwar\\section_1_39BCD\\0347_guangmingshendian.map .\\out_godwar_streamtrace
  node src/cbe_streamtrace.js .\\out_godwar .\\out_godwar_streamtrace_all

Without arguments this traces the current God War scene/map/actor focus set.`);
}

function hex(value, width = 0) {
  if (!Number.isFinite(value)) return "";
  return `0x${Number(value).toString(16).toUpperCase().padStart(width, "0")}`;
}

function parseHexOffset(value) {
  const parsed = Number.parseInt(String(value || "0").replace(/^0x/i, ""), 16);
  return Number.isFinite(parsed) ? parsed : 0;
}

function byteHex(value) {
  return hex(value, 2);
}

function cleanName(name) {
  return String(name || "").replace(/^[0-9]{4}_/, "");
}

function stripIndexPrefix(name) {
  return cleanName(path.basename(name || ""));
}

function extOf(name) {
  return path.extname(name || "").toLowerCase();
}

function stemOf(name) {
  const base = stripIndexPrefix(name);
  return base.slice(0, base.length - path.extname(base).length).toLowerCase();
}

function relFrom(base, file) {
  return path.relative(base, file).split(path.sep).join("/");
}

function walk(input) {
  const stat = fs.statSync(input);
  if (stat.isFile()) return [input];

  const out = [];
  for (const name of fs.readdirSync(input)) {
    const file = path.join(input, name);
    const childStat = fs.statSync(file);
    if (childStat.isDirectory()) out.push(...walk(file));
    else out.push(file);
  }
  return out;
}

function findRoot(fileOrDir) {
  let dir = fs.statSync(fileOrDir).isDirectory() ? path.resolve(fileOrDir) : path.dirname(path.resolve(fileOrDir));
  while (dir && dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "manifest.json"))) return dir;
    dir = path.dirname(dir);
  }
  return fs.statSync(fileOrDir).isDirectory() ? path.resolve(fileOrDir) : path.dirname(path.resolve(fileOrDir));
}

function loadCatalog(root) {
  const manifestPath = path.join(root, "manifest.json");
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return manifest.files
      .filter((file) => file.name && file.output)
      .map((file) => {
        const output = path.isAbsolute(file.output) ? file.output : path.resolve(root, file.output);
        return {
          name: file.name,
          clean: stripIndexPrefix(file.name).toLowerCase(),
          stem: stemOf(file.name),
          ext: extOf(file.name),
          rel: relFrom(root, output),
          output,
        };
      });
  }

  return walk(root).map((file) => ({
    name: cleanName(path.basename(file)),
    clean: stripIndexPrefix(file).toLowerCase(),
    stem: stemOf(file),
    ext: extOf(file),
    rel: relFrom(root, file),
    output: file,
  }));
}

function findResource(text, catalog) {
  const clean = stripIndexPrefix(text).toLowerCase();
  const stem = stemOf(text);
  const ext = extOf(text);
  if (!clean && !stem) return null;

  const exact = catalog.find((entry) => entry.clean === clean);
  if (exact) return { ...exact, reason: "exact filename" };

  if (stem) {
    if (!ext) {
      const exactActor = catalog.find((entry) => entry.ext === ".actor" && entry.stem === stem);
      if (exactActor) return { ...exactActor, reason: "exact actor stem" };
    }

    const sameStem = catalog.find((entry) => entry.stem === stem && (!ext || entry.ext === ext));
    if (sameStem) return { ...sameStem, reason: "exact stem" };

    const actorPrefixes = catalog
      .filter((entry) => entry.ext === ".actor" && entry.stem.startsWith(stem))
      .sort((a, b) => a.stem.length - b.stem.length || a.clean.localeCompare(b.clean));
    if (!ext && actorPrefixes.length === 1) return { ...actorPrefixes[0], reason: "unique actor prefix" };
  }

  return null;
}

function findSiblingResource(resourceDir, text) {
  if (!resourceDir || !text) return "";
  try {
    const target = stripIndexPrefix(text).toLowerCase();
    const match = fs.readdirSync(resourceDir)
      .find((entry) => stripIndexPrefix(entry).toLowerCase() === target);
    return match ? path.join(resourceDir, match) : "";
  } catch {
    return "";
  }
}

function resourcePathFor(text, catalog, resourceDir) {
  const match = findResource(text, catalog);
  if (match?.output && fs.existsSync(match.output)) return match.output;
  return findSiblingResource(resourceDir, text);
}

class Trace {
  constructor(file, buf, root, catalog) {
    this.file = file;
    this.root = root;
    this.rel = root ? relFrom(root, file) : file;
    this.name = cleanName(path.basename(file));
    this.ext = extOf(file);
    this.buf = buf;
    this.catalog = catalog || [];
    this.rows = [];
    this.notes = [];
    this.subtraces = [];
  }

  note(text) {
    this.notes.push(text);
  }

  row(offset, method, raw, value, target, anchor = "", note = "") {
    this.rows.push({
      offset: hex(offset, 4),
      method,
      raw,
      value,
      target,
      anchor,
      note,
    });
  }

  rowRange(offset, length, method, value, target, anchor = "", note = "") {
    this.row(offset, method, hexBytes(this.buf.subarray(offset, Math.min(this.buf.length, offset + length))), value, target, anchor, note);
  }
}

class Reader {
  constructor(trace, offset = 0) {
    this.trace = trace;
    this.buf = trace.buf;
    this.cursor = offset;
  }

  eof(length = 1) {
    return this.cursor + length > this.buf.length;
  }

  seek(offset, note = "") {
    this.cursor = Math.max(0, Math.min(this.buf.length, offset));
    if (note) this.trace.row(this.cursor, "seek", "", "", "cursor", "", note);
  }

  readBytes(length, method, target, anchor = "", value = "", note = "") {
    const offset = this.cursor;
    const end = Math.min(this.buf.length, offset + length);
    const raw = hexBytes(this.buf.subarray(offset, end));
    this.cursor = end;
    this.trace.row(offset, method, raw, value, target, anchor, note);
    return this.buf.subarray(offset, end);
  }

  readU8(target, anchor = "", note = "") {
    if (this.eof(1)) return null;
    const offset = this.cursor;
    const value = this.buf[offset];
    this.cursor += 1;
    this.trace.row(offset, "u8", byteHex(value), value, target, anchor, note);
    return value;
  }

  readU16LE(target, anchor = "", note = "") {
    if (this.eof(2)) return null;
    const offset = this.cursor;
    const value = this.buf.readUInt16LE(offset);
    this.cursor += 2;
    this.trace.row(offset, "u16le", hexBytes(this.buf.subarray(offset, offset + 2)), value, target, anchor, note);
    return value;
  }

  readU16BE(target, anchor = "", note = "") {
    if (this.eof(2)) return null;
    const offset = this.cursor;
    const value = this.buf.readUInt16BE(offset);
    this.cursor += 2;
    this.trace.row(offset, "u16be", hexBytes(this.buf.subarray(offset, offset + 2)), value, target, anchor, note);
    return value;
  }

  readU32LE(target, anchor = "", note = "") {
    if (this.eof(4)) return null;
    const offset = this.cursor;
    const value = this.buf.readUInt32LE(offset);
    this.cursor += 4;
    this.trace.row(offset, "u32le", hexBytes(this.buf.subarray(offset, offset + 4)), value, target, anchor, note);
    return value;
  }

  readCompact(target, anchor = "", note = "", limit = 0x7fffffff) {
    const token = decodeCompactToken(this.buf, this.cursor);
    if (!token || token.truncated || Math.abs(token.value) > limit) {
      this.trace.row(this.cursor, "+0x50 compact?", this.cursor < this.buf.length ? byteHex(this.buf[this.cursor]) : "", "", target, anchor, "decode failed");
      return null;
    }
    this.cursor = token.next;
    this.trace.row(token.offset, "+0x50 compact", token.raw, token.value, target, anchor, note || `tag=${token.tag}`);
    return token.value;
  }

  readLengthRef(target, anchor = "", note = "") {
    if (this.eof(1)) return null;
    const offset = this.cursor;
    const length = this.buf[offset];
    if (length < 1 || offset + 1 + length > this.buf.length) {
      this.trace.row(offset, "+0x64 ref?", byteHex(length), "", target, anchor, "invalid length-prefixed reference");
      this.cursor += 1;
      return null;
    }
    const text = this.buf.subarray(offset + 1, offset + 1 + length).toString("ascii");
    const match = findResource(text, this.trace.catalog);
    this.cursor = offset + 1 + length;
    this.trace.row(
      offset,
      "+0x64 ref",
      hexBytes(this.buf.subarray(offset, this.cursor)),
      text,
      target,
      anchor,
      [note, match ? `matches ${match.clean} (${match.reason})` : ""].filter(Boolean).join("; "),
    );
    return { offset, length, text, match };
  }

  readAscii(length, target, anchor = "", note = "") {
    if (this.eof(length)) return null;
    const offset = this.cursor;
    const bytes = this.buf.subarray(offset, offset + length);
    const text = bytes.toString("ascii");
    const match = findResource(text, this.trace.catalog);
    this.cursor += length;
    this.trace.row(
      offset,
      "ascii",
      hexBytes(bytes),
      text,
      target,
      anchor,
      [note, match ? `matches ${match.clean} (${match.reason})` : ""].filter(Boolean).join("; "),
    );
    return { offset, length, text, match };
  }
}

function addEnvelope(trace) {
  const env = parseResourceEnvelope(trace.buf);
  trace.rowRange(0, Math.min(9, trace.buf.length), "envelope", `body=${env.bodyLength} declared=${env.declaredBodyLength}`, "resource envelope", "", env.lengthMatches ? "declared body length matches file size - 9" : "declared length mismatch");
}

function addPictureHeader(trace, kind) {
  const header = parsePictureTemplateHeader(trace.buf);
  if (!header) return null;
  const r = new Reader(trace, header.bodyOffset);
  r.readU16LE(`${kind}.headerWord0`, "", "header word seen before resource name");
  r.readBytes(3, "raw", `${kind}.headerBytes+2..4`, "", "", "unidentified header bytes");
  const nameLength = r.readU8(`${kind}.nameLength`, "", "declared name length byte");
  if (Number.isFinite(nameLength) && nameLength > 0) {
    r.readAscii(nameLength, `${kind}.primaryImageName`, "", `stream starts at ${hex(header.streamOffset, 4)}`);
  }
  return header;
}

function loadCanvasForMap(file, mapName) {
  const dir = path.dirname(file);
  let entries = [];
  try {
    entries = fs.readdirSync(dir).filter((entry) => extOf(entry) === ".sce");
  } catch {
    return null;
  }
  for (const entry of entries) {
    try {
      const sceFile = path.join(dir, entry);
      const buf = fs.readFileSync(sceFile);
      const summary = parseSce(buf, asciiRuns(buf));
      const records = summary.mapTable?.records || [];
      if (records.some((record) => stripIndexPrefix(record.name).toLowerCase() === stripIndexPrefix(mapName).toLowerCase())) {
        return summary.canvas ? { ...summary.canvas, scene: entry } : null;
      }
    } catch {
      // Keep scanning sibling scenes.
    }
  }
  return null;
}

function traceSce(trace) {
  addEnvelope(trace);
  trace.note("SCE trace follows CBE 0x107F6: SCE2 magic, canvas fields, map resource records, then the SCE2 scene stream. The scene-stream compact reader is still being isolated, so embedded refs are indexed by exact file offsets.");
  const magic = trace.buf.indexOf(Buffer.from("SCE2", "ascii"));
  if (magic < 0) {
    trace.note("SCE2 magic not found.");
    return trace;
  }

  const r = new Reader(trace, magic);
  r.readBytes(4, "magic", "SCE2", "scene.magic", "0x10824-0x1083A", "literal compare in DF_Record.c");
  const width = r.readU16LE("scene+0x04 width", "0x10846-0x10854");
  const height = r.readU16LE("scene+0x06 height", "0x10856-0x10860");
  const mapCount = r.readU16LE("scene+0x0A map_count", "0x10862-0x1086C");
  trace.note(`Scene canvas from header: ${width}x${height}; map_count=${mapCount}.`);

  const maps = [];
  for (let i = 0; i < mapCount && i < 16; i += 1) {
    const ref = r.readLengthRef(`map[${i}].resource (+0x64)`, "0x1089A-0x108CA", "0x0F616 is called on this referenced map/template resource");
    const fields = [
      r.readU16LE(`map[${i}].field0`, "0x108E8-0x108FC"),
      r.readU16LE(`map[${i}].field2`, "0x10900-0x10912"),
      r.readU16LE(`map[${i}].field4`, "0x10914-0x10928"),
      r.readU16LE(`map[${i}].field6`, "0x1092A-0x1093E"),
    ];
    maps.push({ ref, fields });
  }

  const sceneStreamOffset = r.cursor;
  trace.note(`Scene stream starts at ${hex(sceneStreamOffset, 4)} after the map table.`);
  traceSceneStream(trace, sceneStreamOffset, { width, height });

  for (const item of maps) {
    if (!item.ref?.text) continue;
    const resourcePath = resourcePathFor(item.ref.text, trace.catalog, path.dirname(trace.file));
    if (!resourcePath || !fs.existsSync(resourcePath)) continue;
    try {
      const sub = traceFile(resourcePath, trace.root, trace.catalog, { sceneCanvas: { width, height }, parent: trace.rel });
      trace.subtraces.push(sub);
    } catch (err) {
      trace.note(`Unable to subtrace ${item.ref.text}: ${err.message || String(err)}`);
    }
  }

  return trace;
}

function refLooksLikePlacement(buf, ref, canvas) {
  if (ref.recordOffset < 6) return null;
  const type = buf.readUInt16LE(ref.recordOffset - 6);
  const x = buf.readUInt16LE(ref.recordOffset - 4);
  const y = buf.readUInt16LE(ref.recordOffset - 2);
  const pad = 256;
  const width = canvas?.width || 4096;
  const height = canvas?.height || 4096;
  if (type < 1 || type > 64 || x > width + pad || y > height + pad) return null;
  return { type, x, y };
}

function compactPreviewRows(trace, start, end, label, limit = 64) {
  let cursor = start;
  let count = 0;
  while (cursor < end && count < limit) {
    const token = decodeCompactToken(trace.buf, cursor);
    if (!token || token.truncated || token.next > end) {
      trace.rowRange(cursor, Math.max(1, end - cursor), "raw gap", "", label, "", "compact preview stopped before the next anchored reference");
      break;
    }
    trace.row(token.offset, "compact preview", token.raw, token.value, label, "", `tag=${token.tag}; diagnostic alignment only`);
    cursor = token.next;
    count += 1;
  }
}

function traceSceneStream(trace, sceneStreamOffset, canvas) {
  const allRefs = scanLengthPrefixedRefs(trace.buf, 2, 64)
    .filter((ref) => ref.recordOffset >= sceneStreamOffset)
    .map((ref) => ({ ...ref, match: findResource(ref.text, trace.catalog), placement: refLooksLikePlacement(trace.buf, ref, canvas) }))
    .filter((ref) => ref.match || ref.placement || /\.(actor|xse|sce|map)$/i.test(ref.text));

  for (const run of asciiRuns(trace.buf, 3, 512).filter((item) => item.offset >= sceneStreamOffset)) {
    const preOffset = run.offset - 1;
    const pre = preOffset >= 0 ? trace.buf[preOffset] : 0;
    if (pre < run.text.length || pre > 64) continue;
    const text = run.text.replace(/[^A-Za-z0-9_./-]+$/g, "");
    if (text.length < 3) continue;
    const ref = {
      recordOffset: preOffset,
      stringOffset: run.offset,
      length: text.length,
      declaredLength: pre,
      text,
    };
    const match = findResource(ref.text, trace.catalog);
    const placement = refLooksLikePlacement(trace.buf, ref, canvas);
    if (match || placement) allRefs.push({ ...ref, match, placement, asciiRunFallback: true });
  }

  const refs = [];
  const seen = new Set();
  for (const ref of allRefs.sort((a, b) => a.recordOffset - b.recordOffset)) {
    const key = `${ref.recordOffset}:${ref.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
  }

  if (!refs.length) {
    compactPreviewRows(trace, sceneStreamOffset, Math.min(trace.buf.length, sceneStreamOffset + 128), "scene stream");
    return;
  }

  let cursor = sceneStreamOffset;
  for (const ref of refs.slice(0, 32)) {
    if (cursor < ref.recordOffset) {
      compactPreviewRows(trace, cursor, ref.recordOffset, "scene-stream tokens before anchored ref", 48);
    }
    if (ref.placement) {
      trace.rowRange(ref.recordOffset - 6, 2, "u16le", ref.placement.type, `placement.type before ${ref.text}`, "placement inferred from SCE bytes", "candidate object/NPC record");
      trace.rowRange(ref.recordOffset - 4, 2, "u16le", ref.placement.x, `placement.x before ${ref.text}`, "placement inferred from SCE bytes", "coordinate is in full scene canvas, not screen pixels only");
      trace.rowRange(ref.recordOffset - 2, 2, "u16le", ref.placement.y, `placement.y before ${ref.text}`, "placement inferred from SCE bytes", "coordinate is in full scene canvas, not screen pixels only");
    }
    trace.rowRange(
      ref.recordOffset,
      1 + ref.length,
      "anchored ref",
      ref.text,
      `scene resource ${ref.match ? ref.match.clean : ""}`.trim(),
      ref.placement ? "placement inferred" : "length-prefixed scan",
      [
        ref.match ? `matches ${ref.match.clean} (${ref.match.reason})` : "",
        ref.asciiRunFallback ? `ascii-run fallback; pre byte declared ${ref.declaredLength}` : "",
      ].filter(Boolean).join("; "),
    );
    cursor = ref.stringOffset + ref.length;
  }
  if (cursor < trace.buf.length) {
    compactPreviewRows(trace, cursor, Math.min(trace.buf.length, cursor + 128), "scene-stream tail", 48);
  }
}

function traceMap(trace, options = {}) {
  addEnvelope(trace);
  trace.note("MAP trace records the picture/template header and the first draw-stream tokens only. It does not render terrain or tile-stitch anything.");
  const header = addPictureHeader(trace, "map");
  if (!header) return trace;

  const canvas = options.sceneCanvas || loadCanvasForMap(trace.file, trace.name);
  if (canvas) trace.note(`Scene canvas anchor: ${canvas.width}x${canvas.height}${canvas.scene ? ` from ${canvas.scene}` : ""}.`);

  const r = new Reader(trace, header.streamOffset);
  if (canvas && r.cursor + 6 <= trace.buf.length) {
    const storedWidth = r.readU16LE("map.lead.storedWidth", "map lead header", "biased width candidate");
    const flags = r.readU16LE("map.lead.flags", "map lead header");
    const height = r.readU16LE("map.lead.height", "map lead header");
    const bias = storedWidth - canvas.width;
    if ((bias === 0x500 || bias === 0x600) && height === canvas.height && (flags & 0x8000)) {
      trace.note(`Lead header proves draw stream starts at ${hex(r.cursor, 4)}: storedWidth=${storedWidth}, bias=${hex(bias)}, realWidth=${canvas.width}, flags=${hex(flags, 4)}, height=${height}.`);
    } else {
      trace.note("Lead header did not match the known biased-width pattern; draw preview still starts after the three lead halfwords.");
    }
  }

  const drawStart = r.cursor;
  let tokenCursor = drawStart;
  for (let i = 0; i < 96 && tokenCursor < trace.buf.length; i += 1) {
    const token = decodeCompactToken(trace.buf, tokenCursor);
    if (!token) break;
    trace.row(
      token.offset,
      "draw compact token",
      token.raw,
      token.value,
      `map.draw[${i}]`,
      "map draw stream",
      `tag=${token.tag}; renderer opcode/operand role not proven`,
    );
    tokenCursor = token.next;
  }
  return trace;
}

function traceActor(trace) {
  addEnvelope(trace);
  trace.note("ACTOR trace follows the 0x0F222 parser shape: a leading count, repeated +0x64 picture/template records, four compact fields at object+0/+4/+8/+0C, then a compact matrix. The +0x64 record consumer is represented by the best scored fixed/compact layout until that reader method is fully reversed.");
  const header = addPictureHeader(trace, "actor");
  if (!header) return trace;

  const imagePath = resourcePathFor(header.compactName, trace.catalog, path.dirname(trace.file));
  const imageInfo = imagePath ? parseGifInfo(imagePath) : null;
  if (imageInfo) trace.note(`Primary GIF is ${header.compactName}: ${imageInfo.width}x${imageInfo.height}, descriptors=${imageInfo.frames}.`);

  traceF222Candidate(trace, header.streamOffset, imageInfo);

  const dividers = findActorStreamDividers(trace.buf.subarray(header.streamOffset));
  const first = dividers[0] || null;
  if (first) {
    const abs = header.streamOffset + first.markerStart;
    trace.rowRange(abs, first.markerEnd - first.markerStart, "ff-heavy token", "", "actor stream marker candidate", "", "stable actor marker candidate; not treated as a hard section divider");
  }
  return trace;
}

function traceF222Candidate(trace, streamOffset, imageInfo) {
  const layout = probeF222Layout(trace.buf.subarray(streamOffset), imageInfo);
  if (layout?.tableMethod) {
    trace.note(`0x0F222 scored layout: table=${layout.tableMethod}${layout.recordStride ? ` stride=${layout.recordStride}` : ""}, score=${layout.score}, streamFields=${layout.fieldsOffset}, matrix=${layout.matrixRead}/${layout.matrixExpected}, streamMatrixEnd=${layout.matrixEndOffset}, bytesToFf=${layout.bytesToFfCandidate ?? "-"}.`);
  }

  const r = new Reader(trace, streamOffset);
  const count = r.readCompact("0x0F222 leading table count", "0x0F24A-0x0F254", "reader +0x50");
  if (!Number.isFinite(count) || count <= 0 || count > 128) {
    trace.note("0x0F222 candidate stopped: implausible leading count.");
    return;
  }

  const recordStride = layout?.recordStride || 8;
  for (let i = 0; i < count && r.cursor + recordStride <= trace.buf.length; i += 1) {
    const start = r.cursor;
    r.readBytes(recordStride, `+0x64 ${layout?.tableMethod || "fixed8"} candidate`, `picture/template ref[${i}]`, "0x0F264-0x0F280", "raw record", layout?.referenceTableApproximation || "actual +0x64 reader still being reversed");
    const local = trace.buf.subarray(start, start + recordStride);
    let cursor = 0;
    const values = [];
    while (cursor < local.length) {
      const token = decodeCompactToken(local, cursor);
      if (!token || token.truncated || token.next > local.length) break;
      values.push(token.value);
      cursor = token.next;
    }
    trace.rows[trace.rows.length - 1].note += values.length ? `; compact preview=[${values.join(",")}]` : "";
  }

  if (layout?.fieldsOffset) {
    const expectedFields = streamOffset + parseHexOffset(layout.fieldsOffset);
    if (r.cursor !== expectedFields) {
      r.seek(expectedFields, `align to 0x0F222 best scored fields offset from ${layout.tableMethod}`);
    }
  }

  const fieldNames = [
    "object+0x00 cell/divisor W",
    "object+0x04 cell/divisor H",
    "object+0x08 extent/dividend W",
    "object+0x0C extent/dividend H",
  ];
  const fields = fieldNames.map((name, index) => r.readCompact(name, `0x0F286-0x0F2B8 field${index}`, "reader +0x50", 4096));
  const [cellW, cellH, extentW, extentH] = fields;
  if (!fields.every((value) => Number.isFinite(value) && value > 0)) return;

  const columns = Math.ceil(extentW / cellW);
  const rows = Math.ceil(extentH / cellH);
  const cells = columns * rows;
  trace.note(`0x0F222 candidate grid math: extent=${extentW}x${extentH}, cell=${cellW}x${cellH}, matrix=${columns}x${rows}/${cells}.`);
  if (imageInfo) {
    trace.note(`Compared with GIF ${imageInfo.width}x${imageInfo.height}: this is metadata evidence, not permission to cut the sprite into uniform tiles.`);
  }

  for (let i = 0; i < cells && i < 512 && r.cursor < trace.buf.length; i += 1) {
    const before = r.cursor;
    const value = r.readCompact(`matrix[${i}]`, "0x0F2E0-0x0F31C", "0x0F326 uses high nibble as picture slot and low 24 bits as payload");
    if (!Number.isFinite(value)) break;
    const unsigned = value >>> 0;
    const slot = (unsigned >>> 28) & 0x0f;
    const payload = unsigned & 0x00ffffff;
    trace.rows[trace.rows.length - 1].note += `; slot=${slot} payload=${payload}`;
    if (r.cursor === before) break;
  }
}

function traceXse(trace) {
  addEnvelope(trace);
  trace.note("XSE trace is code-anchored to 0x112C4, but the script/object bytecode reader is still preliminary. Treat opcode/group results as evidence for parser alignment, not a decompiled script.");
  const magic = trace.buf.indexOf(Buffer.from("XSE", "ascii"));
  if (magic >= 0) trace.rowRange(magic, Math.min(4, trace.buf.length - magic), "magic/search", trace.buf.subarray(magic, Math.min(trace.buf.length, magic + 4)).toString("ascii"), "xse magic", "", "string search only");

  const probe = probe112C4ResourceBuffer(trace.buf, { resourceName: trace.name });
  if (probe?.best) {
    const best = probe.best;
    trace.note(`0x112C4 best current probe: score=${best.score}, ok=${best.ok}, reader=${best.groupIdReader}, groups=${best.groupCount}, records=${best.totalRecords}, cursor=${best.cursorStart}->${best.endOffset}.`);
    for (const sample of (best.samples || []).slice(0, 24)) {
      const offset = Number.parseInt(String(sample.offset || "0").replace(/^0x/i, ""), 16);
      trace.row(offset, "0x112C4 sample", sample.opcodeHex || "", sample.opcode, `group${sample.groupIndex}.record${sample.recordIndex}`, "0x1147A-0x1156E", (sample.fields || []).map((field) => `${field.label}:${field.value}`).join(" "));
    }
  }

  const start = probe?.best?.cursorStart ? Number.parseInt(String(probe.best.cursorStart).replace(/^0x/i, ""), 16) : Math.min(15, trace.buf.length);
  let cursor = Math.max(0, Math.min(trace.buf.length, start));
  for (let i = 0; i < 80 && cursor < trace.buf.length; i += 1) {
    const token = decodeCompactToken(trace.buf, cursor);
    if (!token) break;
    trace.row(token.offset, "compact preview", token.raw, token.value, `xse.preview[${i}]`, "0x112C4 reader alignment", `tag=${token.tag}`);
    cursor = token.next;
  }
  return trace;
}

function traceFile(file, root, catalog, options = {}) {
  const buf = fs.readFileSync(file);
  const trace = new Trace(file, buf, root, catalog);
  if (options.parent) trace.note(`Subtrace reached from ${options.parent}.`);

  if (trace.ext === ".sce") return traceSce(trace);
  if (trace.ext === ".map") return traceMap(trace, options);
  if (trace.ext === ".actor") return traceActor(trace);
  if (trace.ext === ".xse") return traceXse(trace);
  addEnvelope(trace);
  trace.note("No specialized tracer for this extension.");
  return trace;
}

function flattenTrace(trace, out = []) {
  out.push(trace);
  for (const sub of trace.subtraces || []) flattenTrace(sub, out);
  return out;
}

function formatTrace(trace) {
  const lines = [];
  lines.push(`## ${trace.rel}`);
  lines.push(`file=${trace.file}`);
  lines.push(`size=${trace.buf.length}`);
  for (const note of trace.notes) lines.push(`note=${note}`);
  lines.push("");
  lines.push("| offset | method | raw | value | target | anchor | note |");
  lines.push("|---|---|---|---:|---|---|---|");
  for (const row of trace.rows) {
    const cols = [row.offset, row.method, row.raw, String(row.value ?? ""), row.target, row.anchor, row.note]
      .map((text) => String(text || "").replace(/\|/g, "\\|"));
    lines.push(`| ${cols.join(" | ")} |`);
  }
  lines.push("");
  return lines.join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    usage();
    return;
  }

  const input = args[0] ? path.resolve(args[0]) : "";
  const outDir = path.resolve(args[1] || DEFAULT_OUT);
  const files = input
    ? walk(input).filter((file) => DATA_EXTS.has(extOf(file))).sort((a, b) => a.localeCompare(b, "zh-Hans-CN"))
    : DEFAULT_FILES.filter((file) => fs.existsSync(file));
  if (!files.length) throw new Error("No traceable files found.");

  const root = findRoot(input || files[0]);
  const catalog = loadCatalog(root);
  const traces = files.map((file) => traceFile(file, root, catalog));
  const seenFiles = new Set();
  const flat = [];
  for (const trace of traces.flatMap((item) => flattenTrace(item))) {
    const key = path.resolve(trace.file).toLowerCase();
    if (seenFiles.has(key)) continue;
    seenFiles.add(key);
    flat.push(trace);
  }

  await fsp.mkdir(outDir, { recursive: true });
  const jsonReady = flat.map((trace) => ({
    file: trace.file,
    rel: trace.rel,
    name: trace.name,
    ext: trace.ext,
    size: trace.buf.length,
    notes: trace.notes,
    rows: trace.rows,
  }));
  await fsp.writeFile(path.join(outDir, "stream_trace.json"), JSON.stringify({ input: input || "default focus set", generatedAt: new Date().toISOString(), traces: jsonReady }, null, 2), "utf8");
  await fsp.writeFile(path.join(outDir, "stream_trace.txt"), [`# CBE Stream Trace`, "", ...flat.map(formatTrace)].join("\n"), "utf8");
  console.log(`Input: ${input || "default focus set"}`);
  console.log(`Output: ${outDir}`);
  console.log(`Traces: ${flat.length}`);
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
