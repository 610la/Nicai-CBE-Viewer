const fs = require("fs");
const path = require("path");
const { summarizeFile } = require("./cbe_struct");

const DEFAULT_INPUT = path.resolve(process.cwd(), "out_godwar", "section_1_39BCD", "0401_heermode.actor");

function cleanName(name) {
  return String(name || "").replace(/^[0-9]{4}_/, "");
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

function findRoot(file) {
  let dir = path.dirname(path.resolve(file));
  while (dir && dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "manifest.json"))) return dir;
    dir = path.dirname(dir);
  }
  return path.dirname(path.resolve(file));
}

function loadCatalog(root) {
  const manifestPath = path.join(root, "manifest.json");
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return manifest.files
      .filter((file) => file.name && file.output)
      .map((file) => ({
        name: file.name,
        rel: relFrom(root, file.output),
        output: file.output,
      }));
  }

  return walk(root).map((file) => ({
    name: cleanName(path.basename(file)),
    rel: relFrom(root, file),
    output: file,
  }));
}

function readU16LE(buf, offset) {
  if (offset + 2 > buf.length) return null;
  return { value: buf.readUInt16LE(offset), next: offset + 2, raw: hexBytes(buf.subarray(offset, offset + 2)) };
}

function byteHex(byte) {
  return `0x${byte.toString(16).toUpperCase().padStart(2, "0")}`;
}

function hexBytes(buf) {
  return Array.from(buf).map(byteHex).join(" ");
}

function hx(value, width = 4) {
  return `0x${value.toString(16).toUpperCase().padStart(width, "0")}`;
}

function tokenAt(buf, offset, mode) {
  if (mode === "u16le") return readU16LE(buf, offset);
  if (offset >= buf.length) return null;
  const tag = buf[offset];
  if (tag < 0x80) return { value: tag, next: offset + 1, raw: byteHex(tag) };
  if ((tag === 0x80 || tag === 0x81) && offset + 1 < buf.length) {
    return { value: buf[offset + 1], next: offset + 2, raw: hexBytes(buf.subarray(offset, offset + 2)) };
  }
  if (tag === 0x82 && offset + 2 < buf.length) {
    return { value: buf.readInt16BE(offset + 1), unsigned: buf.readUInt16BE(offset + 1), next: offset + 3, raw: hexBytes(buf.subarray(offset, offset + 3)) };
  }
  if (tag === 0x83 && offset + 3 < buf.length) {
    return { value: buf.readIntBE(offset + 1, 3), unsigned: (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3], next: offset + 4, raw: hexBytes(buf.subarray(offset, offset + 4)) };
  }
  if ((tag === 0x84 || tag === 0x85) && offset + 4 < buf.length) {
    return { value: buf.readInt32LE(offset + 1), next: offset + 5, raw: hexBytes(buf.subarray(offset, offset + 5)) };
  }
  if (tag > 0x85) {
    return { value: tag - 0x100, next: offset + 1, raw: byteHex(tag) };
  }
  return { value: tag, next: offset + 1, raw: byteHex(tag), truncated: true };
}

function readValue(buf, cursorRef, mode) {
  const token = tokenAt(buf, cursorRef.value, mode);
  if (!token) return null;
  const out = {
    offset: cursorRef.value,
    value: token.value,
    raw: token.raw,
    truncated: token.truncated || false,
  };
  cursorRef.value = token.next;
  return out;
}

function ceilDiv(a, b) {
  if (!b) return 0;
  return Math.ceil(a / b);
}

function readSimulation(stream, mode, tableEntryBytes, expected = {}) {
  const cursor = { value: 0 };
  const count = readValue(stream, cursor, mode);
  if (!count || count.value <= 0 || count.value > 512) return null;

  const table = [];
  for (let i = 0; i < count.value; i += 1) {
    if (cursor.value + tableEntryBytes > stream.length) return null;
    table.push({
      offset: cursor.value,
      raw: hexBytes(stream.subarray(cursor.value, cursor.value + tableEntryBytes)),
      u16: tableEntryBytes >= 2 ? stream.readUInt16LE(cursor.value) : null,
    });
    cursor.value += tableEntryBytes;
  }

  const fields = [];
  for (let i = 0; i < 4; i += 1) {
    const token = readValue(stream, cursor, mode);
    if (!token || token.truncated) return null;
    fields.push(token);
  }
  const [cellW, cellH, width, height] = fields.map((field) => field.value);
  const positive = [cellW, cellH, width, height].every((value) => value > 0 && value <= 4096);
  const columns = positive ? ceilDiv(width, cellW) : 0;
  const rows = positive ? ceilDiv(height, cellH) : 0;
  const cells = columns * rows;
  const matrix = [];
  if (positive && cells > 0 && cells <= 4096) {
    for (let i = 0; i < cells; i += 1) {
      const token = readValue(stream, cursor, mode);
      if (!token || token.truncated) break;
      matrix.push(token);
    }
  }

  const widthDelta = expected.width && expected.height
    ? Math.abs(width - expected.width) + Math.abs(height - expected.height)
    : null;
  const swappedDelta = expected.width && expected.height
    ? Math.abs(width - expected.height) + Math.abs(height - expected.width)
    : null;
  const ffOffset = stream.indexOf(Buffer.from([0xff, 0xff, 0xff]));
  let score = 0;
  if (positive) score += 20;
  if (matrix.length === cells && cells > 0) score += 20;
  if (ffOffset >= 0) {
    const diff = Math.abs(ffOffset - cursor.value);
    if (diff === 0) score += 80;
    else if (diff <= 4) score += 45;
    else if (cursor.value <= ffOffset) score += Math.max(0, 25 - Math.floor((ffOffset - cursor.value) / 8));
  }
  if (widthDelta != null) {
    const best = Math.min(widthDelta, swappedDelta);
    if (best <= 16) score += 55;
    else if (best <= 48) score += 30;
    else if (best <= 96) score += 12;
  }

  return {
    mode,
    tableEntryBytes,
    count,
    tableHead: table.slice(0, 10),
    fields,
    grid: positive ? { cellW, cellH, width, height, columns, rows, cells } : null,
    matrixHead: matrix.slice(0, 16),
    matrixRead: matrix.length,
    cursor: cursor.value,
    bytesToFf: ffOffset >= 0 ? ffOffset - cursor.value : null,
    widthDelta,
    swappedDelta,
    score,
  };
}

function streamFromSummary(summary, file) {
  const buf = fs.readFileSync(file);
  const ext = path.extname(file).toLowerCase();
  if (ext === ".actor") {
    const off = Number.parseInt(String(summary.specific.actor.streamOffset || "0").replace(/^0x/i, ""), 16);
    return {
      stream: buf.subarray(off),
      expected: summary.specific.actor.imageInfo || {},
      streamOffset: off,
    };
  }
  if (ext === ".map") {
    const off = Number.parseInt(String(summary.specific.map.drawStreamOffset || summary.specific.map.dataOffset || "0").replace(/^0x/i, ""), 16);
    return {
      stream: buf.subarray(off),
      expected: summary.specific.map.canvas || {},
      streamOffset: off,
    };
  }
  return { stream: Buffer.alloc(0), expected: {}, streamOffset: 0 };
}

async function inspect(file) {
  const root = findRoot(file);
  const catalog = loadCatalog(root);
  const summary = await summarizeFile(file, {
    name: cleanName(path.basename(file)),
    catalog,
  });
  const { stream, expected, streamOffset } = streamFromSummary(summary, file);
  const attempts = [];
  for (const mode of ["compact", "u16le"]) {
    for (const tableEntryBytes of [1, 2, 4, 6, 8]) {
      const attempt = readSimulation(stream, mode, tableEntryBytes, expected);
      if (attempt) attempts.push(attempt);
    }
  }
  attempts.sort((a, b) => b.score - a.score || Math.abs(a.bytesToFf ?? 999999) - Math.abs(b.bytesToFf ?? 999999));
  return {
    file,
    rel: relFrom(root, file),
    ext: path.extname(file).toLowerCase(),
    streamOffset: hx(streamOffset),
    streamLength: stream.length,
    expected,
    attempts: attempts.slice(0, 10),
  };
}

function printReport(report) {
  console.log(`# ${report.rel}`);
  console.log(`stream=${report.streamOffset} len=${report.streamLength} expected=${report.expected.width || "-"}x${report.expected.height || "-"}`);
  for (const [index, attempt] of report.attempts.entries()) {
    const fields = attempt.fields.map((field) => `${hx(field.offset)}:${field.value}(${field.raw})`).join(" ");
    const grid = attempt.grid
      ? `${attempt.grid.cellW}x${attempt.grid.cellH} extent=${attempt.grid.width}x${attempt.grid.height} matrix=${attempt.grid.columns}x${attempt.grid.rows}/${attempt.grid.cells}`
      : "-";
    const matrix = attempt.matrixHead.map((field) => `${hx(field.offset)}:${field.value}`).join(" ");
    console.log(`## ${index + 1} score=${attempt.score} mode=${attempt.mode} tableEntryBytes=${attempt.tableEntryBytes}`);
    console.log(`count=${attempt.count.value} raw=${attempt.count.raw} tableHead=${attempt.tableHead.map((entry) => `${hx(entry.offset)}:${entry.raw}`).join(" | ")}`);
    console.log(`fields=${fields}`);
    console.log(`grid=${grid}`);
    console.log(`matrixRead=${attempt.matrixRead} cursor=${hx(attempt.cursor)} bytesToFf=${attempt.bytesToFf ?? "-"} delta=${attempt.widthDelta ?? "-"} swapped=${attempt.swappedDelta ?? "-"}`);
    console.log(`matrixHead=${matrix || "-"}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const input = path.resolve(args[0] || DEFAULT_INPUT);
  const files = walk(input)
    .filter((file) => [".actor", ".map"].includes(path.extname(file).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
  for (const file of files) {
    const report = await inspect(file);
    printReport(report);
    console.log("");
  }
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
