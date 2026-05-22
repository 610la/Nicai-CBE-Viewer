const fs = require("fs");
const path = require("path");

const MAGIC = Buffer.from([0xfe, 0xfe, 0xfe, 0xfe, 0xfe, 0xfe, 0xfe, 0xfe]);
const DEFAULT_INPUT = path.resolve(__dirname, "..", "cbe file", "众神之战.CBE");
const DEFAULT_OUT = path.resolve(process.cwd(), "out_cbe");

function usage() {
  console.log(`Usage:
  node src/cbe_unpack.js [input.cbe] [output_dir]

Examples:
  node src/cbe_unpack.js
  node src/cbe_unpack.js "./cbe file/众神之战.CBE" out_godwar`);
}

function hex(n) {
  return "0x" + n.toString(16).toUpperCase();
}

function sanitizeName(name) {
  return name
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/[\x00-\x1f]/g, "_")
    .replace(/^\.+$/, "_")
    .trim();
}

function ensureUnique(name, used) {
  const parsed = path.parse(name);
  let out = name;
  let i = 2;
  while (used.has(out.toLowerCase())) {
    out = `${parsed.name}_${i}${parsed.ext}`;
    i += 1;
  }
  used.add(out.toLowerCase());
  return out;
}

function isProbablyNameChar(c) {
  return (c >= 0x30 && c <= 0x39) ||
    (c >= 0x41 && c <= 0x5a) ||
    (c >= 0x61 && c <= 0x7a) ||
    c === 0x2e || c === 0x5f || c === 0x2d;
}

function looksLikeResourceSection(buf, off) {
  if (off + 40 >= buf.length || !buf.subarray(off, off + 8).equals(MAGIC)) return false;
  const marker = buf.readUInt32LE(off + 8);
  const count = buf.readUInt32LE(off + 12);
  const one = buf.readUInt32LE(off + 16);
  const firstDataRel = buf.readUInt32LE(off + 20);
  const dataLen = buf.readUInt32LE(off + 24);

  if (marker !== 8 || count < 1 || count > 10000 || one !== 1) return false;
  if (firstDataRel < 0x18 || dataLen < 1 || firstDataRel + dataLen > buf.length - off + 0x1000) return false;

  const namesStart = off + 36 + Math.max(0, count - 1) * 4;
  if (namesStart >= buf.length) return false;

  let pos = namesStart;
  let checked = 0;
  while (checked < Math.min(count, 16) && pos < buf.length) {
    const len = buf[pos];
    if (len < 1 || len > 96 || pos + 1 + len > buf.length) return false;
    const name = buf.subarray(pos + 1, pos + 1 + len);
    if (![...name].every(isProbablyNameChar)) return false;
    pos += 1 + len;
    checked += 1;
  }
  return checked > 0;
}

function parseSection(buf, off, sectionIndex) {
  const count = buf.readUInt32LE(off + 12);
  const dataRel = buf.readUInt32LE(off + 20);
  const dataLen = buf.readUInt32LE(off + 24);
  const ends = [];
  let tablePos = off + 36;
  for (let i = 0; i < count - 1; i += 1) {
    ends.push(buf.readUInt32LE(tablePos));
    tablePos += 4;
  }

  const names = [];
  let namePos = off + 36 + Math.max(0, count - 1) * 4;
  for (let i = 0; i < count; i += 1) {
    const len = buf[namePos];
    const raw = buf.subarray(namePos + 1, namePos + 1 + len).toString("ascii");
    names.push(raw);
    namePos += 1 + len;
  }

  const dataStart = off + dataRel + 0x18;
  const dataEnd = Math.min(dataStart + dataLen, buf.length);
  const entries = names.map((name, i) => {
    const startRel = i === 0 ? 0 : ends[i - 1];
    const endRel = i < ends.length ? ends[i] : dataLen;
    const start = dataStart + startRel;
    const end = dataStart + endRel;
    return {
      section: sectionIndex,
      index: i,
      name,
      offset: start,
      end,
      size: Math.max(0, end - start),
    };
  });

  return {
    section: sectionIndex,
    offset: off,
    count,
    dataRel,
    dataLen,
    namesStart: off + 36 + Math.max(0, count - 1) * 4,
    dataStart,
    dataEnd,
    entries,
  };
}

function findSections(buf) {
  const out = [];
  for (let off = 0; off < buf.length - 40; off += 1) {
    if (looksLikeResourceSection(buf, off)) {
      out.push(parseSection(buf, off, out.length));
      off += 12;
    }
  }
  return out;
}

function extOf(name) {
  const ext = path.extname(name).toLowerCase();
  return ext.startsWith(".") ? ext.slice(1) : ext;
}

function rgb565ToRgb888(v) {
  const r5 = (v >> 11) & 0x1f;
  const g6 = (v >> 5) & 0x3f;
  const b5 = v & 0x1f;
  return [
    (r5 << 3) | (r5 >> 2),
    (g6 << 2) | (g6 >> 4),
    (b5 << 3) | (b5 >> 2),
  ];
}

function log2Int(n) {
  return Math.round(Math.log2(n));
}

function fixupPayload(name, payload) {
  const ext = extOf(name);
  if (ext === "gif" && !payload.subarray(0, 6).equals(Buffer.from("GIF89a")) && !payload.subarray(0, 6).equals(Buffer.from("GIF87a"))) {
    // CBE stores GIF resources as:
    //   8-byte CBE image metadata, RGB565 global palette, then normal GIF blocks.
    const gce = payload.indexOf(Buffer.from([0x21, 0xf9, 0x04]));
    const image = gce >= 0 ? gce + 8 : -1;
    const paletteBytes = gce - 8;
    const colorCount = paletteBytes > 0 ? paletteBytes / 2 : 0;
    const colorBits = colorCount > 0 ? log2Int(colorCount) : 0;
    if (
      gce >= 10 &&
      image + 10 < payload.length &&
      payload[image] === 0x2c &&
      Number.isInteger(colorCount) &&
      colorCount >= 2 &&
      colorCount <= 256 &&
      2 ** colorBits === colorCount
    ) {
      const width = payload.readUInt16LE(image + 5);
      const height = payload.readUInt16LE(image + 7);
      if (width > 0 && width <= 4096 && height > 0 && height <= 4096) {
        const header = Buffer.alloc(13);
        const palette = Buffer.alloc(colorCount * 3);
        header.write("GIF89a", 0, "ascii");
        header.writeUInt16LE(width, 6);
        header.writeUInt16LE(height, 8);
        header[10] = 0x80 | 0x70 | (colorBits - 1);
        header[11] = 0x00;
        header[12] = 0x00;
        for (let i = 0; i < colorCount; i += 1) {
          const rgb = rgb565ToRgb888(payload.readUInt16BE(8 + i * 2));
          palette[i * 3] = rgb[0];
          palette[i * 3 + 1] = rgb[1];
          palette[i * 3 + 2] = rgb[2];
        }
        return {
          payload: Buffer.concat([header, palette, payload.subarray(gce)]),
          note: `rebuilt_gif_rgb565_palette_${colorCount}`,
        };
      }
    }
  }
  return { payload, note: "" };
}

function assertValidEntryRange(buf, entry) {
  if (!entry || !Number.isFinite(entry.offset) || !Number.isFinite(entry.end)) {
    throw new Error("Invalid CBE resource entry");
  }
  if (entry.end <= entry.offset || entry.offset < 0 || entry.end > buf.length) {
    throw new Error(`Invalid CBE resource range for ${entry.name || "(unnamed)"}`);
  }
}

function rawPayloadForEntry(buf, entry) {
  assertValidEntryRange(buf, entry);
  return buf.subarray(entry.offset, entry.end);
}

function makePublicEntry(entry) {
  return {
    section: entry.section,
    index: entry.index,
    name: entry.name,
    ext: path.extname(entry.name || "").toLowerCase(),
    offset: entry.offset,
    end: entry.end,
    offsetHex: hex(entry.offset),
    endHex: hex(entry.end),
    size: entry.size,
  };
}

function loadCbeArchive(input) {
  const resolvedInput = path.resolve(input || DEFAULT_INPUT);
  const buf = fs.readFileSync(resolvedInput);
  const sections = findSections(buf);

  if (!sections.length) {
    throw new Error(`No CBE resource sections found in ${resolvedInput}`);
  }

  const entries = sections.flatMap((section) => section.entries.map((entry) => ({
    ...makePublicEntry(entry),
    sectionOffset: section.offset,
    sectionOffsetHex: hex(section.offset),
  })));

  function entriesByName(name) {
    const target = String(name || "").toLowerCase();
    return entries.filter((entry) => entry.name.toLowerCase() === target);
  }

  function findEntry(name) {
    const target = String(name || "").toLowerCase();
    return entries.find((entry) => entry.name.toLowerCase() === target) || null;
  }

  function findEntries(predicate) {
    if (typeof predicate === "function") return entries.filter(predicate);
    const text = String(predicate || "").toLowerCase();
    return entries.filter((entry) => entry.name.toLowerCase().includes(text));
  }

  function rawPayload(entryOrName) {
    const entry = typeof entryOrName === "string" ? findEntry(entryOrName) : entryOrName;
    if (!entry) throw new Error(`CBE resource not found: ${entryOrName}`);
    return rawPayloadForEntry(buf, entry);
  }

  function payload(entryOrName, options = {}) {
    const entry = typeof entryOrName === "string" ? findEntry(entryOrName) : entryOrName;
    if (!entry) throw new Error(`CBE resource not found: ${entryOrName}`);
    const raw = rawPayloadForEntry(buf, entry);
    return options.raw ? { payload: raw, note: "" } : fixupPayload(entry.name, raw);
  }

  return {
    input: resolvedInput,
    size: buf.length,
    buffer: buf,
    sections,
    entries,
    entriesByName,
    findEntry,
    findEntries,
    rawPayload,
    payload,
  };
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

function unpackFile(input, outDir) {
  const archive = loadCbeArchive(input);
  const buf = archive.buffer;
  const sections = archive.sections;

  if (!sections.length) {
    throw new Error(`No CBE resource sections found in ${input}`);
  }

  fs.mkdirSync(outDir, { recursive: true });
  const used = new Set();
  const manifest = {
    input,
    size: buf.length,
    generatedAt: new Date().toISOString(),
    sections: sections.map((s) => ({
      section: s.section,
      offset: hex(s.offset),
      count: s.count,
      dataRel: hex(s.dataRel),
      dataLen: hex(s.dataLen),
      namesStart: hex(s.namesStart),
      dataStart: hex(s.dataStart),
      dataEnd: hex(s.dataEnd),
    })),
    files: [],
  };

  for (const section of sections) {
    const sectionDir = path.join(outDir, `section_${section.section}_${hex(section.offset).slice(2)}`);
    fs.mkdirSync(sectionDir, { recursive: true });
    for (const entry of section.entries) {
      if (entry.end <= entry.offset || entry.offset < 0 || entry.end > buf.length) {
        manifest.files.push({ ...entry, offset: hex(entry.offset), end: hex(entry.end), skipped: "invalid_range" });
        continue;
      }
      const safe = ensureUnique(`${String(entry.index).padStart(4, "0")}_${sanitizeName(entry.name)}`, used);
      const raw = buf.subarray(entry.offset, entry.end);
      const fixed = fixupPayload(entry.name, raw);
      const output = path.join(sectionDir, safe);
      fs.writeFileSync(output, fixed.payload);
      manifest.files.push({
        section: entry.section,
        index: entry.index,
        name: entry.name,
        output,
        offset: hex(entry.offset),
        end: hex(entry.end),
        rawSize: raw.length,
        writtenSize: fixed.payload.length,
        note: fixed.note,
      });
    }
  }

  writeJson(path.join(outDir, "manifest.json"), manifest);
  console.log(`Input: ${input}`);
  console.log(`Output: ${outDir}`);
  console.log(`Sections: ${sections.length}`);
  console.log(`Files: ${manifest.files.length}`);
  for (const section of sections) {
    console.log(`  section ${section.section}: offset=${hex(section.offset)} count=${section.count} data=${hex(section.dataStart)}..${hex(section.dataEnd)}`);
  }
  return manifest;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    usage();
    return;
  }

  const input = path.resolve(args[0] || DEFAULT_INPUT);
  const outDir = path.resolve(args[1] || DEFAULT_OUT);

  const stat = fs.statSync(input);
  if (stat.isDirectory()) {
    fs.mkdirSync(outDir, { recursive: true });
    const files = fs.readdirSync(input)
      .filter((name) => /\.cbe$/i.test(name))
      .sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
    if (!files.length) throw new Error(`No .CBE files found in ${input}`);
    const summary = [];
    for (const file of files) {
      const source = path.join(input, file);
      const target = path.join(outDir, sanitizeName(path.basename(file, path.extname(file))));
      console.log(`\n== ${file} ==`);
      try {
        const manifest = unpackFile(source, target);
        summary.push({ file: source, output: target, sections: manifest.sections.length, files: manifest.files.length });
      } catch (err) {
        console.error(`Failed: ${err.message}`);
        summary.push({ file: source, output: target, error: err.message });
      }
    }
    writeJson(path.join(outDir, "batch_manifest.json"), summary);
    console.log(`\nBatch complete: ${files.length} CBE files`);
  } else {
    unpackFile(input, outDir);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  DEFAULT_INPUT,
  DEFAULT_OUT,
  MAGIC,
  ensureUnique,
  findSections,
  fixupPayload,
  hex,
  loadCbeArchive,
  looksLikeResourceSection,
  parseSection,
  rawPayloadForEntry,
  sanitizeName,
  unpackFile,
};
