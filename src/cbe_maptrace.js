const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { parseGifInfoBuffer, summarizeBuffer, summarizeFile } = require("./cbe_struct");

const DEFAULT_INPUT = path.resolve(process.cwd(), "out_godwar", "section_1_39BCD", "0347_guangmingshendian.map");
const DEFAULT_OUT = path.resolve(process.cwd(), "out_godwar_maptrace");

function usage() {
  console.log(`Usage:
  node src/cbe_maptrace.js [map_file_or_unpacked_dir] [output_dir]

Examples:
  node src/cbe_maptrace.js .\\out_godwar\\section_1_39BCD\\0347_guangmingshendian.map .\\out_godwar_maptrace
  node src/cbe_maptrace.js .\\out_godwar .\\out_godwar_maptrace`);
}

function hex(value, width = 0) {
  return `0x${Number(value).toString(16).toUpperCase().padStart(width, "0")}`;
}

function byteHex(value) {
  return hex(value, 2);
}

function cleanName(name) {
  return String(name || "").replace(/^[0-9]{4}_/, "");
}

function extOf(name) {
  return path.extname(name || "").toLowerCase();
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

function byCleanName(catalog) {
  const out = new Map();
  for (const entry of catalog) {
    out.set(cleanName(entry.name).toLowerCase(), entry);
    out.set(cleanName(path.basename(entry.rel)).toLowerCase(), entry);
  }
  return out;
}

function readGifSize(file) {
  try {
    const buf = fs.readFileSync(file);
    if (buf.length >= 10 && buf.subarray(0, 3).toString("ascii") === "GIF") {
      return {
        width: buf.readUInt16LE(6),
        height: buf.readUInt16LE(8),
      };
    }
  } catch {
    return null;
  }
  return null;
}

function normalizeImageSize(info) {
  if (!info?.width || !info?.height) return null;
  return {
    width: info.width,
    height: info.height,
  };
}

function atlasSizeFromEntry(entry, options = {}) {
  if (!entry) return null;
  if (typeof options.readImageInfo === "function") {
    try {
      const info = normalizeImageSize(options.readImageInfo(entry));
      if (info) return info;
    } catch {
      // Fall through to buffer/file probing.
    }
  }
  if (entry.output) return readGifSize(entry.output);
  if (typeof options.readResource === "function") {
    try {
      const resource = options.readResource(entry);
      const bytes = Buffer.isBuffer(resource)
        ? resource
        : resource?.fixed || resource?.payload || resource?.data || null;
      const info = bytes ? normalizeImageSize(parseGifInfoBuffer(bytes)) : null;
      if (info) return info;
    } catch {
      return null;
    }
  }
  return null;
}

function topCounts(items, limit = 12) {
  const counts = new Map();
  for (const item of items) counts.set(item, (counts.get(item) || 0) + 1);
  return Array.from(counts, ([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || String(a.value).localeCompare(String(b.value)))
    .slice(0, limit);
}

function topNgrams(bytes, n, limit = 12) {
  const grams = [];
  for (let i = 0; i + n <= bytes.length; i += 1) {
    grams.push(Array.from(bytes.subarray(i, i + n)).map(byteHex).join(" "));
  }
  return topCounts(grams, limit).map((entry) => ({
    bytes: entry.value,
    count: entry.count,
    percent: bytes.length >= n ? Number(((entry.count / (bytes.length - n + 1)) * 100).toFixed(2)) : 0,
  }));
}

function byteHistogram(bytes, limit = 16) {
  return topCounts(Array.from(bytes).map(byteHex), limit).map((entry) => ({
    byte: entry.value,
    count: entry.count,
    percent: bytes.length ? Number(((entry.count / bytes.length) * 100).toFixed(2)) : 0,
  }));
}

function highNibbleHistogram(bytes) {
  return topCounts(Array.from(bytes).filter((byte) => byte >= 0x80).map((byte) => hex(byte >> 4, 1)), 16)
    .map((entry) => ({
      nibble: entry.value,
      count: entry.count,
      percentOfHigh: bytes.length ? Number(((entry.count / Math.max(1, Array.from(bytes).filter((byte) => byte >= 0x80).length)) * 100).toFixed(2)) : 0,
    }));
}

function contextForByte(bytes, anchor, limit = 10) {
  const before = [];
  const after = [];
  const samples = [];
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] !== anchor) continue;
    if (i > 0) before.push(byteHex(bytes[i - 1]));
    if (i + 1 < bytes.length) after.push(byteHex(bytes[i + 1]));
    if (samples.length < 8) {
      const start = Math.max(0, i - 4);
      const end = Math.min(bytes.length, i + 8);
      samples.push({
        offset: hex(i, 4),
        bytes: Array.from(bytes.subarray(start, end)).map(byteHex).join(" "),
      });
    }
  }
  return {
    byte: byteHex(anchor),
    count: Array.from(bytes).filter((byte) => byte === anchor).length,
    before: topCounts(before, limit),
    after: topCounts(after, limit),
    samples,
  };
}

function readLeadFields(buf, offset) {
  const fields = [];
  const add = (name, bytes, value) => fields.push({ name, bytes, value });
  if (offset + 1 < buf.length) add("u16+0", hex(offset, 4), buf.readUInt16LE(offset));
  if (offset + 3 < buf.length) add("u32+0", hex(offset, 4), buf.readUInt32LE(offset));
  if (offset + 3 < buf.length) add("u16+2", hex(offset + 2, 4), buf.readUInt16LE(offset + 2));
  if (offset + 5 < buf.length) add("u16+4", hex(offset + 4, 4), buf.readUInt16LE(offset + 4));
  if (offset + 7 < buf.length) add("u32+4", hex(offset + 4, 4), buf.readUInt32LE(offset + 4));
  if (offset + 9 < buf.length) add("u16+8", hex(offset + 8, 4), buf.readUInt16LE(offset + 8));
  return fields;
}

function bytesForRange(buf, start, end) {
  return Array.from(buf.subarray(start, end)).map(byteHex).join(" ");
}

function commonDrawStart(byte) {
  return byte === 0x04 || byte === 0x06 || byte === 0x08 || byte === 0x10 ||
    byte === 0x12 || byte === 0x18 || byte === 0x20 || byte >= 0x80;
}

function inferDrawStreamOffset(buf, offset, canvas) {
  if (!canvas) {
    return {
      offset,
      reason: "no scene canvas; keep stream at tileset end",
      skippedBytes: "",
    };
  }

  if (offset + 8 <= buf.length && buf.readUInt32LE(offset) === canvas.width && buf.readUInt32LE(offset + 4) === canvas.height) {
    return {
      offset: offset + 8,
      reason: "leading u32 width + u32 height matches sibling .sce canvas",
      skippedBytes: Array.from(buf.subarray(offset, offset + 8)).map(byteHex).join(" "),
    };
  }

  if (offset + 6 <= buf.length && buf.readUInt32LE(offset) === canvas.width && buf.readUInt16LE(offset + 4) === canvas.height) {
    return {
      offset: offset + 6,
      reason: "leading u32 width + u16 height matches sibling .sce canvas",
      skippedBytes: Array.from(buf.subarray(offset, offset + 6)).map(byteHex).join(" "),
    };
  }

  if (offset + 4 <= buf.length && buf.readUInt16LE(offset) === canvas.width && buf.readUInt16LE(offset + 2) === canvas.height) {
    return {
      offset: offset + 4,
      reason: "leading u16 width + u16 height matches sibling .sce canvas",
      skippedBytes: Array.from(buf.subarray(offset, offset + 4)).map(byteHex).join(" "),
    };
  }

  if (offset + 6 <= buf.length) {
    const biasedWidth = buf.readUInt16LE(offset);
    const flags = buf.readUInt16LE(offset + 2);
    const height = buf.readUInt16LE(offset + 4);
    const widthBias = biasedWidth - canvas.width;
    const hasTerminator = offset + 8 <= buf.length && buf[offset + 6] === 0x00 && buf[offset + 7] === 0x00;
    if ((widthBias === 0x500 || widthBias === 0x600) && height === canvas.height && (flags & 0x8000)) {
      const end = hasTerminator ? offset + 8 : offset + 6;
      return {
        offset: end,
        reason: `leading biased u16 width (+${hex(widthBias)}) + map flags + u16 height matches sibling .sce canvas`,
        skippedBytes: bytesForRange(buf, offset, end),
      };
    }
  }

  if (offset + 8 <= buf.length && buf.readUInt16LE(offset) === canvas.width &&
      buf[offset + 6] === 0x00 && buf[offset + 7] === 0x00 && commonDrawStart(buf[offset + 8])) {
    return {
      offset: offset + 8,
      reason: "leading u16 width + map flags + zero terminator",
      skippedBytes: bytesForRange(buf, offset, offset + 8),
    };
  }

  if (offset + 4 <= buf.length && buf.readUInt16LE(offset) === canvas.width && commonDrawStart(buf[offset + 4])) {
    return {
      offset: offset + 4,
      reason: "leading u16 width + u16 field matches sibling .sce canvas",
      skippedBytes: bytesForRange(buf, offset, offset + 4),
    };
  }

  if (offset + 4 <= buf.length && buf.readUInt32LE(offset) === canvas.width) {
    return {
      offset: offset + 4,
      reason: "leading u32 width-only header matches sibling .sce canvas",
      skippedBytes: bytesForRange(buf, offset, offset + 4),
    };
  }

  if (offset + 2 <= buf.length && buf.readUInt16LE(offset) === canvas.width) {
    return {
      offset: offset + 2,
      reason: "leading u16 width-only header matches sibling .sce canvas",
      skippedBytes: bytesForRange(buf, offset, offset + 2),
    };
  }

  return {
    offset,
    reason: "no exact leading canvas header; treat bytes immediately after tileset as draw stream",
    skippedBytes: "",
  };
}

function scoreRaw(bytes, cells16, atlasTiles) {
  const inAtlas = atlasTiles ? Array.from(bytes).filter((byte) => byte < atlasTiles).length : 0;
  return {
    name: "raw bytes as 1 tile each",
    consumedBytes: bytes.length,
    writes: bytes.length,
    runs: 0,
    literals: bytes.length,
    maxRun: 0,
    tileIdInAtlasPercent: atlasTiles ? Number(((inAtlas / Math.max(1, bytes.length)) * 100).toFixed(2)) : null,
    gridCellError: cells16 ? Number((Math.abs(bytes.length - cells16) / cells16).toFixed(3)) : null,
    accepted: false,
  };
}

function scoreHighBitRle(bytes, cells16, atlasTiles, countBias) {
  let i = 0;
  let writes = 0;
  let runs = 0;
  let literals = 0;
  let maxRun = 0;
  let truncated = false;
  let inAtlas = 0;
  const samples = [];
  while (i < bytes.length) {
    const offset = i;
    const byte = bytes[i];
    i += 1;
    if (byte >= 0x80) {
      if (i >= bytes.length) {
        truncated = true;
        break;
      }
      const count = (byte & 0x7f) + countBias;
      const value = bytes[i];
      i += 1;
      writes += count;
      runs += 1;
      if (atlasTiles && value < atlasTiles) inAtlas += count;
      if (count > maxRun) maxRun = count;
      if (samples.length < 8) samples.push(`${hex(offset, 4)} ${byteHex(byte)} ${byteHex(value)} => ${count}x ${byteHex(value)}`);
    } else {
      writes += 1;
      literals += 1;
      if (atlasTiles && byte < atlasTiles) inAtlas += 1;
    }
  }

  return {
    name: `high-bit byte is run marker, count=(byte&0x7f)+${countBias}`,
    consumedBytes: i,
    writes,
    runs,
    literals,
    maxRun,
    truncated,
    tileIdInAtlasPercent: atlasTiles ? Number(((inAtlas / Math.max(1, writes)) * 100).toFixed(2)) : null,
    gridCellError: cells16 ? Number((Math.abs(writes - cells16) / cells16).toFixed(3)) : null,
    accepted: false,
    samples,
  };
}

function scoreZeroRle(bytes, cells16) {
  let writes = 0;
  let runs = 0;
  let literals = 0;
  let truncated = false;
  const samples = [];
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i];
    if (byte === 0x00 || byte === 0xff) {
      if (i + 1 >= bytes.length) {
        truncated = true;
        break;
      }
      const count = bytes[i + 1];
      writes += count;
      runs += 1;
      if (samples.length < 8) samples.push(`${hex(i, 4)} ${byteHex(byte)} ${byteHex(bytes[i + 1])} => skip/run ${count}`);
      i += 1;
    } else {
      writes += 1;
      literals += 1;
    }
  }
  return {
    name: "0x00/0xff as two-byte skip or run marker",
    consumedBytes: bytes.length,
    writes,
    runs,
    literals,
    maxRun: null,
    gridCellError: cells16 ? Number((Math.abs(writes - cells16) / cells16).toFixed(3)) : null,
    accepted: false,
    truncated,
    samples,
  };
}

function candidateScores(bytes, canvas, atlas) {
  const cells16 = canvas ? Math.ceil(canvas.width / 16) * Math.ceil(canvas.height / 16) : 0;
  const atlasTiles16 = atlas ? Math.floor(atlas.width / 16) * Math.floor(atlas.height / 16) : 0;
  const scores = [
    scoreRaw(bytes, cells16, atlasTiles16),
    scoreHighBitRle(bytes, cells16, atlasTiles16, 0),
    scoreHighBitRle(bytes, cells16, atlasTiles16, 1),
    scoreZeroRle(bytes, cells16),
  ];
  return scores.sort((a, b) => {
    const ae = a.gridCellError == null ? Number.POSITIVE_INFINITY : a.gridCellError;
    const be = b.gridCellError == null ? Number.POSITIVE_INFINITY : b.gridCellError;
    return ae - be;
  });
}

function decodeGridRle(bytes, mode, canvas, atlas, tileSize = 16, options = {}) {
  const columns = canvas ? Math.max(1, Math.ceil(canvas.width / tileSize)) : 0;
  const rows = canvas ? Math.max(1, Math.ceil(canvas.height / tileSize)) : 0;
  const cells = columns * rows;
  const atlasColumns = atlas ? Math.max(1, Math.floor(atlas.width / tileSize)) : 1;
  const atlasTiles = atlas ? Math.max(1, atlasColumns * Math.floor(atlas.height / tileSize)) : 1;
  const out = new Array(cells || 0).fill(null);
  const samples = [];
  let cursor = 0;
  let writes = 0;
  let skips = 0;
  let runs = 0;
  let literals = 0;
  let truncated = false;
  let lastTile = 0;

  for (let i = 0; i < bytes.length && (!cells || cursor < cells); i += 1) {
    const offset = i;
    const byte = bytes[i];
    if ((byte === 0x00 || byte === 0xff) && i + 1 < bytes.length) {
      const count = bytes[i + 1];
      const skip =
        mode === "bothSkip" ||
        (mode === "zeroRunFFSkip" && byte === 0xff) ||
        (mode === "zeroRun0FFSkip" && byte === 0xff) ||
        (mode === "zeroSkipFFRunPrev" && byte === 0x00);
      if (skip) {
        cursor += count;
        skips += count;
        if (samples.length < 10) samples.push(`${hex(offset, 4)} ${byteHex(byte)} ${byteHex(count)} => skip ${count}`);
      } else {
        const tile = mode === "zeroRun0FFSkip" && byte === 0x00 ? 0 : lastTile;
        for (let k = 0; k < count && (!cells || cursor < cells); k += 1) {
          if (cells) out[cursor] = tile % atlasTiles;
          cursor += 1;
          writes += 1;
        }
        runs += count;
        if (samples.length < 10) samples.push(`${hex(offset, 4)} ${byteHex(byte)} ${byteHex(count)} => fill ${count}x ${byteHex(tile)}`);
      }
      i += 1;
      continue;
    }

    if (byte === 0x00 || byte === 0xff) {
      truncated = true;
      break;
    }

    if (cells) out[cursor] = byte % atlasTiles;
    lastTile = byte % atlasTiles;
    cursor += 1;
    writes += 1;
    literals += 1;
  }

  const filled = out.filter((tile) => tile != null).length;
  const fullGrid = cells ? cursor === cells : false;
  const gridError = cells ? Number((Math.abs(cursor - cells) / cells).toFixed(3)) : null;
  const fillPercent = cells ? Number(((filled / cells) * 100).toFixed(2)) : null;
  const score = cells ? Number(((1 - Math.min(1, gridError)) * 0.65 + (filled / cells) * 0.35).toFixed(4)) : 0;

  return {
    key: mode,
    label: {
      bothSkip: "00+FF skip",
      zeroRunFFSkip: "FF skip / 00 fill previous",
      zeroRun0FFSkip: "FF skip / 00 fill tile 0",
      zeroSkipFFRunPrev: "00 skip / FF fill previous",
    }[mode] || mode,
    tileSize,
    columns,
    rows,
    cells,
    atlasColumns,
    atlasTiles,
    cursor,
    writes,
    skips,
    runs,
    literals,
    filled,
    fillPercent,
    fullGrid,
    gridError,
    score,
    truncated,
    samples,
    ...(options.includeCells ? { tileCells: out } : {}),
  };
}

function rleCandidates(bytes, canvas, atlas) {
  if (!canvas || !atlas) return [];
  return ["zeroRunFFSkip", "zeroSkipFFRunPrev", "bothSkip", "zeroRun0FFSkip"]
    .map((mode) => decodeGridRle(bytes, mode, canvas, atlas, 16))
    .sort((a, b) => b.score - a.score || a.gridError - b.gridError);
}

function decodeVarIdRecords(bytes, mode, canvas, atlas) {
  const atlasTileSize = mode.atlasTileSize;
  const coordScale = mode.coordScale;
  const atlasColumns = atlas ? Math.max(1, Math.floor(atlas.width / atlasTileSize)) : 1;
  const atlasRows = atlas ? Math.max(1, Math.floor(atlas.height / atlasTileSize)) : 1;
  const atlasTiles = atlasColumns * atlasRows;
  const records = [];
  const placements = [];
  let i = 0;
  let truncated = false;
  let validTileCount = 0;
  let inCanvasCount = 0;
  let drawableCount = 0;
  let extendedCount = 0;
  let maxX = 0;
  let maxY = 0;

  while (i < bytes.length) {
    const offset = i;
    let first = bytes[i];
    i += 1;
    let tile = first;
    let extended = false;

    if (first >= 0x80) {
      if (i >= bytes.length) {
        truncated = true;
        break;
      }
      tile = ((first & 0x7f) << 8) | bytes[i];
      i += 1;
      extended = true;
      extendedCount += 1;
    }

    if (i + 1 >= bytes.length) {
      truncated = true;
      break;
    }

    const rawX = bytes[i];
    const rawY = bytes[i + 1];
    i += 2;

    const x = rawX * coordScale;
    const y = rawY * coordScale;
    const validTile = tile >= 0 && tile < atlasTiles;
    const inCanvas = !canvas || (
      x >= 0 && y >= 0 &&
      x + atlasTileSize <= canvas.width &&
      y + atlasTileSize <= canvas.height
    );
    const drawable = validTile && inCanvas;
    if (validTile) validTileCount += 1;
    if (inCanvas) inCanvasCount += 1;
    if (drawable) drawableCount += 1;
    if (drawable) {
      maxX = Math.max(maxX, x + atlasTileSize);
      maxY = Math.max(maxY, y + atlasTileSize);
      if (placements.length < 1600) {
        placements.push({
          offset: hex(offset, 4),
          tile,
          x,
          y,
          rawX,
          rawY,
          sx: (tile % atlasColumns) * atlasTileSize,
          sy: Math.floor(tile / atlasColumns) * atlasTileSize,
          size: atlasTileSize,
          extended,
        });
      }
    }
    if (records.length < 24) {
      records.push({
        offset: hex(offset, 4),
        tile,
        rawX,
        rawY,
        x,
        y,
        validTile,
        inCanvas,
        extended,
      });
    }
  }

  const total = Math.max(1, Math.floor(i ? records.length + (drawableCount - placements.length) : 0));
  const recordCount = (() => {
    let count = 0;
    let p = 0;
    while (p < bytes.length) {
      p += bytes[p] >= 0x80 ? 2 : 1;
      if (p + 1 >= bytes.length) break;
      p += 2;
      count += 1;
    }
    return count;
  })();
  const denom = Math.max(1, recordCount);
  const coverage = canvas ? {
    widthPercent: Number(((Math.min(maxX, canvas.width) / Math.max(1, canvas.width)) * 100).toFixed(2)),
    heightPercent: Number(((Math.min(maxY, canvas.height) / Math.max(1, canvas.height)) * 100).toFixed(2)),
  } : null;
  const coverageScore = coverage ? Math.min(coverage.widthPercent, coverage.heightPercent) / 100 : 0;
  const drawableScore = drawableCount / denom;
  const validScore = validTileCount / denom;

  return {
    key: mode.key,
    label: mode.label,
    parser: "var-id + one-byte x/y records",
    atlasTileSize,
    coordScale,
    atlasColumns,
    atlasTiles,
    records: recordCount,
    consumedBytes: i,
    truncated,
    extendedRecords: extendedCount,
    validTilePercent: Number(((validTileCount / denom) * 100).toFixed(2)),
    inCanvasPercent: Number(((inCanvasCount / denom) * 100).toFixed(2)),
    drawablePercent: Number(((drawableCount / denom) * 100).toFixed(2)),
    drawableRecords: drawableCount,
    placementLimit: placements.length,
    bounds: { width: maxX, height: maxY },
    coverage,
    score: Number(((drawableScore * 0.45) + (validScore * 0.2) + (coverageScore * 0.35)).toFixed(4)),
    samples: records,
    placements,
  };
}

function drawCandidates(bytes, canvas, atlas) {
  if (!canvas || !atlas) return [];
  const modes = [
    { key: "var4xy1", label: "var-id atlas 4px, raw xy", atlasTileSize: 4, coordScale: 1 },
    { key: "var4xy2", label: "var-id atlas 4px, xy x2", atlasTileSize: 4, coordScale: 2 },
    { key: "var8xy1", label: "var-id atlas 8px, raw xy", atlasTileSize: 8, coordScale: 1 },
    { key: "var8xy2", label: "var-id atlas 8px, xy x2", atlasTileSize: 8, coordScale: 2 },
    { key: "var16xy1", label: "var-id atlas 16px, raw xy", atlasTileSize: 16, coordScale: 1 },
  ];
  return modes
    .map((mode) => decodeVarIdRecords(bytes, mode, canvas, atlas))
    .sort((a, b) => b.score - a.score);
}

function buildRlePreviewGrid(bytes, canvas, atlas, candidate) {
  if (!canvas || !atlas || !candidate?.key || !candidate.fullGrid) return null;
  const decoded = decodeGridRle(bytes, candidate.key, canvas, atlas, candidate.tileSize || 16, {
    includeCells: true,
  });
  if (!decoded.fullGrid || !decoded.tileCells?.length || decoded.tileCells.length > 20000) return null;
  return {
    source: "best-rle-candidate",
    key: decoded.key,
    label: decoded.label,
    tileSize: decoded.tileSize,
    columns: decoded.columns,
    rows: decoded.rows,
    cells: decoded.cells,
    atlasColumns: decoded.atlasColumns,
    atlasTiles: decoded.atlasTiles,
    writes: decoded.writes,
    skips: decoded.skips,
    fillPercent: decoded.fillPercent,
    score: decoded.score,
    confidence: "diagnostic candidate; terrain VM execution is not proven",
    tileCells: decoded.tileCells,
  };
}

function pairStats(bytes, canvas) {
  let aligned4 = 0;
  let aligned8 = 0;
  let aligned16 = 0;
  let plausibleXY = 0;
  const pairs = [];
  const limitX = canvas?.width || 4096;
  const limitY = canvas?.height || 4096;
  for (let i = 0; i + 3 < bytes.length; i += 2) {
    const a = bytes.readUInt16LE(i);
    const b = bytes.readUInt16LE(i + 2);
    if (a % 4 === 0 && b % 4 === 0) aligned4 += 1;
    if (a % 8 === 0 && b % 8 === 0) aligned8 += 1;
    if (a % 16 === 0 && b % 16 === 0) aligned16 += 1;
    if (a < limitX && b < limitY) plausibleXY += 1;
    if (pairs.length < 24) pairs.push(`${hex(i, 4)} ${a},${b}`);
  }
  const total = Math.max(0, Math.floor((bytes.length - 2) / 2));
  return {
    totalSlidingPairs: total,
    aligned4Percent: total ? Number(((aligned4 / total) * 100).toFixed(2)) : 0,
    aligned8Percent: total ? Number(((aligned8 / total) * 100).toFixed(2)) : 0,
    aligned16Percent: total ? Number(((aligned16 / total) * 100).toFixed(2)) : 0,
    plausibleSceneXYPercent: total ? Number(((plausibleXY / total) * 100).toFixed(2)) : 0,
    firstPairs: pairs,
  };
}

function formatBytes(buf, startOffset, count = 96) {
  const lines = [];
  const end = Math.min(buf.length, startOffset + count);
  for (let offset = startOffset; offset < end; offset += 16) {
    const row = Array.from(buf.subarray(offset, Math.min(offset + 16, end))).map(byteHex).join(" ");
    lines.push(`${hex(offset, 4)}  ${row}`);
  }
  return lines;
}

function findCompanion(file) {
  const dir = path.dirname(file);
  const parsed = path.parse(path.basename(file));
  const clean = cleanName(parsed.name);
  const candidates = clean.endsWith("d")
    ? [clean.slice(0, -1)]
    : [`${clean}d`];

  for (const candidate of candidates) {
    const match = fs.readdirSync(dir).find((entry) => cleanName(path.parse(entry).name).toLowerCase() === candidate.toLowerCase() && extOf(entry) === ".map");
    if (match) return path.join(dir, match);
  }
  return "";
}

function commonPrefix(a, b, fromA = 0, fromB = 0) {
  let count = 0;
  while (fromA + count < a.length && fromB + count < b.length && a[fromA + count] === b[fromB + count]) count += 1;
  return count;
}

function decodeCompactTraceToken(bytes, offset) {
  if (offset >= bytes.length) return null;
  const tag = bytes[offset];
  if (tag < 0x80) {
    return { offset, next: offset + 1, tag: "raw", value: tag, raw: byteHex(tag) };
  }
  if ((tag === 0x80 || tag === 0x81) && offset + 1 < bytes.length) {
    return { offset, next: offset + 2, tag: byteHex(tag), value: bytes[offset + 1], raw: `${byteHex(tag)} ${byteHex(bytes[offset + 1])}` };
  }
  if (tag === 0x82 && offset + 2 < bytes.length) {
    return {
      offset,
      next: offset + 3,
      tag: byteHex(tag),
      value: bytes.readInt16BE(offset + 1),
      raw: Array.from(bytes.subarray(offset, offset + 3)).map(byteHex).join(" "),
    };
  }
  if (tag === 0x83 && offset + 3 < bytes.length) {
    return {
      offset,
      next: offset + 4,
      tag: byteHex(tag),
      value: bytes.readIntBE(offset + 1, 3),
      raw: Array.from(bytes.subarray(offset, offset + 4)).map(byteHex).join(" "),
    };
  }
  if ((tag === 0x84 || tag === 0x85) && offset + 4 < bytes.length) {
    return {
      offset,
      next: offset + 5,
      tag: byteHex(tag),
      value: bytes.readInt32LE(offset + 1),
      raw: Array.from(bytes.subarray(offset, offset + 5)).map(byteHex).join(" "),
    };
  }
  return { offset, next: offset + 1, tag: "s8", value: tag - 0x100, raw: byteHex(tag) };
}

function compactTokens(bytes, limit = 512) {
  const out = [];
  let cursor = 0;
  while (cursor < bytes.length && out.length < limit) {
    const token = decodeCompactTraceToken(bytes, cursor);
    if (!token) break;
    out.push(token);
    cursor = token.next;
  }
  return out;
}

function tokenSignature(token) {
  return token ? `${token.tag}:${token.value}:${token.next - token.offset}` : "";
}

function companionTokenDiff(aBytes, bBytes, absoluteA = 0, absoluteB = 0) {
  const aTokens = compactTokens(aBytes);
  const bTokens = compactTokens(bBytes);
  let common = 0;
  while (common < aTokens.length && common < bTokens.length && tokenSignature(aTokens[common]) === tokenSignature(bTokens[common])) {
    common += 1;
  }
  const sample = [];
  for (let index = Math.max(0, common - 6); index < Math.min(Math.max(aTokens.length, bTokens.length), common + 12); index += 1) {
    const left = aTokens[index];
    const right = bTokens[index];
    sample.push({
      index,
      left: left ? `${hex(absoluteA + left.offset, 4)} ${left.value} ${left.tag} ${left.raw}` : "-",
      right: right ? `${hex(absoluteB + right.offset, 4)} ${right.value} ${right.tag} ${right.raw}` : "-",
      same: tokenSignature(left) === tokenSignature(right),
    });
  }
  return {
    commonTokenPrefix: common,
    leftDivergenceOffset: aTokens[common] ? hex(absoluteA + aTokens[common].offset, 4) : "",
    rightDivergenceOffset: bTokens[common] ? hex(absoluteB + bTokens[common].offset, 4) : "",
    leftTokenCount: aTokens.length,
    rightTokenCount: bTokens.length,
    sample,
  };
}

function findAtlasEntry(map, lookup, root) {
  const hint = cleanName(map.tilesetHint || "").toLowerCase();
  if (!hint) return null;
  const exact = lookup.get(hint);
  if (exact) return exact;

  const compactHint = hint.replace(/[^a-z0-9_.-]/g, "");
  for (const entry of lookup.values()) {
    if (extOf(entry.name) !== ".gif") continue;
    const compactName = cleanName(entry.name).toLowerCase().replace(/[^a-z0-9_.-]/g, "");
    if (compactName === compactHint || compactName.startsWith(compactHint) || compactHint.includes(compactName)) return entry;
  }

  const fragments = hint.split(/\s*\.\.\.\s*/).filter(Boolean);
  if (fragments.length >= 2) {
    return Array.from(lookup.values()).find((entry) => {
      const name = cleanName(entry.name).toLowerCase();
      return extOf(name) === ".gif" && name.startsWith(fragments[0]) && name.endsWith(fragments[fragments.length - 1]);
    }) || null;
  }

  return null;
}

function parseHexOffset(value, fallback = 0) {
  if (Number.isFinite(value)) return value;
  const text = String(value || "").replace(/^0x/i, "");
  const parsed = Number.parseInt(text, 16);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function slimDrawCandidate(candidate, includePlacements = false) {
  if (!candidate) return null;
  return {
    key: candidate.key,
    label: candidate.label,
    parser: candidate.parser,
    atlasTileSize: candidate.atlasTileSize,
    coordScale: candidate.coordScale,
    atlasColumns: candidate.atlasColumns,
    atlasTiles: candidate.atlasTiles,
    records: candidate.records,
    consumedBytes: candidate.consumedBytes,
    truncated: candidate.truncated,
    extendedRecords: candidate.extendedRecords,
    validTilePercent: candidate.validTilePercent,
    inCanvasPercent: candidate.inCanvasPercent,
    drawablePercent: candidate.drawablePercent,
    drawableRecords: candidate.drawableRecords,
    bounds: candidate.bounds,
    coverage: candidate.coverage,
    score: candidate.score,
    samples: candidate.samples || [],
    placements: includePlacements ? candidate.placements || [] : [],
  };
}

function buildMapTraceReport({
  input,
  rel,
  name,
  buf,
  summary,
  map,
  dataOffset,
  draw,
  atlasEntry,
  atlasSize,
  companionReport = null,
  includeDrawPlacements = false,
  includeRlePreviewGrid = false,
}) {
  const drawBytes = buf.subarray(draw.offset);
  const payloadBytes = buf.subarray(dataOffset);
  const anchors = [0x81, 0x82, 0x83, 0x84, 0x85, 0x07, 0x08, 0xfc, 0xf8]
    .filter((byte, index, arr) => arr.indexOf(byte) === index);
  const scoreRows = candidateScores(drawBytes, map.canvas, atlasSize).slice(0, 6);
  const rleRows = rleCandidates(drawBytes, map.canvas, atlasSize).slice(0, 4);
  const drawRecordCandidates = drawCandidates(drawBytes, map.canvas, atlasSize)
    .slice(0, 5)
    .map((candidate) => slimDrawCandidate(candidate, includeDrawPlacements));
  const rlePreviewGrid = includeRlePreviewGrid ? buildRlePreviewGrid(drawBytes, map.canvas, atlasSize, rleRows[0]) : null;

  return {
    input,
    rel,
    generatedAt: new Date().toISOString(),
    envelope: summary.envelope,
    map: {
      name,
      tilesetHint: map.tilesetHint || "",
      atlas: atlasEntry ? {
        name: atlasEntry.name,
        rel: atlasEntry.rel,
        size: atlasSize,
        tiles16: atlasSize ? Math.floor(atlasSize.width / 16) * Math.floor(atlasSize.height / 16) : null,
        tiles8: atlasSize ? Math.floor(atlasSize.width / 8) * Math.floor(atlasSize.height / 8) : null,
      } : null,
      canvas: map.canvas || null,
      dataOffset: map.dataOffset,
      leadHeader: map.leadHeader || null,
      payloadLength: payloadBytes.length,
      drawStreamOffset: hex(draw.offset, 4),
      drawStreamLength: drawBytes.length,
      drawStreamReason: draw.reason,
      skippedHeaderBytes: draw.skippedBytes,
      leadFields: readLeadFields(buf, dataOffset),
      companion: companionReport,
    },
    evidence: {
      firstPayloadBytes: formatBytes(buf, dataOffset),
      firstDrawBytes: formatBytes(buf, draw.offset),
      topBytes: byteHistogram(drawBytes, 18),
      topPairs: topNgrams(drawBytes, 2, 16),
      topTriples: topNgrams(drawBytes, 3, 14),
      topQuads: topNgrams(drawBytes, 4, 12),
      candidateScores: scoreRows,
      rleCandidates: rleRows,
      drawCandidates: drawRecordCandidates,
      rlePreviewGrid,
      highNibbles: highNibbleHistogram(drawBytes),
      byteContexts: anchors.map((byte) => contextForByte(drawBytes, byte)),
      compactProbe: map.compactProbe || null,
      mapTemplateProbe: map.mapTemplateProbe || null,
      f222LayoutProbe: map.f222LayoutProbe || null,
      pairStats: pairStats(drawBytes, map.canvas),
    },
  };
}

function analyzeMapBuffer(name, buffer, options = {}) {
  const catalog = options.catalog || [];
  const lookup = byCleanName(catalog);
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  const clean = cleanName(path.basename(name || "resource.map"));
  const summary = summarizeBuffer(clean, buf, {
    catalog,
    sceneCanvas: options.sceneCanvas || options.canvas || null,
    source: options.source || "raw-cbe-buffer",
  });
  const map = summary.specific.map || {};
  const dataOffset = parseHexOffset(map.dataOffset, 0);
  const draw = map.leadHeader?.drawStreamOffset
    ? {
        offset: parseHexOffset(map.leadHeader.drawStreamOffset, dataOffset),
        reason: `map lead header: ${map.leadHeader.encoding}`,
        skippedBytes: map.leadHeader.bytes || "",
      }
    : inferDrawStreamOffset(buf, dataOffset, map.canvas);
  const atlasEntry = findAtlasEntry(map, lookup);
  const atlasSize = atlasSizeFromEntry(atlasEntry, options);
  return buildMapTraceReport({
    input: options.input || clean,
    rel: options.rel || "",
    name: clean,
    buf,
    summary,
    map,
    dataOffset,
    draw,
    atlasEntry,
    atlasSize,
    includeDrawPlacements: Boolean(options.includeDrawPlacements),
    includeRlePreviewGrid: Boolean(options.includeRlePreviewGrid),
  });
}

async function analyzeMapFile(file, options = {}) {
  const root = options.root || findRoot(file);
  const catalog = options.catalog || loadCatalog(root);
  const lookup = byCleanName(catalog);
  const buf = fs.readFileSync(file);
  const summary = await summarizeFile(file, {
    name: cleanName(path.basename(file)),
    catalog,
  });
  const map = summary.specific.map || {};
  const dataOffset = parseHexOffset(map.dataOffset, 0);
  const draw = map.leadHeader?.drawStreamOffset
    ? {
        offset: parseHexOffset(map.leadHeader.drawStreamOffset, dataOffset),
        reason: `map lead header: ${map.leadHeader.encoding}`,
        skippedBytes: map.leadHeader.bytes || "",
      }
    : inferDrawStreamOffset(buf, dataOffset, map.canvas);
  const atlasEntry = findAtlasEntry(map, lookup, root);
  const atlasSize = atlasSizeFromEntry(atlasEntry, options);
  const drawBytes = buf.subarray(draw.offset);
  const companion = findCompanion(file);
  const companionReport = companion ? (() => {
    const other = fs.readFileSync(companion);
    const commonFromHeader = commonPrefix(buf, other, 9, 9);
    const commonFromPayload = commonPrefix(buf, other, dataOffset, dataOffset);
    const commonFromDraw = commonPrefix(buf, other, draw.offset, draw.offset);
    return {
      rel: relFrom(root, companion),
      commonBodyPrefixBytes: commonFromHeader,
      commonPayloadPrefixBytes: commonFromPayload,
      commonDrawPrefixBytes: commonFromDraw,
      compactTokenDiff: companionTokenDiff(drawBytes, other.subarray(draw.offset), draw.offset, draw.offset),
    };
  })() : null;

  return buildMapTraceReport({
    input: file,
    rel: relFrom(root, file),
    name: cleanName(path.basename(file)),
    buf,
    summary,
    map,
    dataOffset,
    draw,
    atlasEntry,
    atlasSize,
    companionReport,
    includeDrawPlacements: Boolean(options.includeDrawPlacements),
    includeRlePreviewGrid: Boolean(options.includeRlePreviewGrid),
  });
}

function textForReport(report) {
  const lines = [];
  for (const item of report.maps) {
    const map = item.map;
    lines.push(`## ${item.rel}`);
    lines.push(`canvas=${map.canvas ? `${map.canvas.width}x${map.canvas.height}` : "-"} tileset=${map.tilesetHint || "-"} atlas=${map.atlas?.name || "-"}`);
    if (map.atlas?.size) lines.push(`atlasSize=${map.atlas.size.width}x${map.atlas.size.height} tiles16=${map.atlas.tiles16} tiles8=${map.atlas.tiles8}`);
    lines.push(`dataOffset=${map.dataOffset} payload=${map.payloadLength} drawOffset=${map.drawStreamOffset} draw=${map.drawStreamLength}`);
    lines.push(`drawReason=${map.drawStreamReason}`);
    if (map.skippedHeaderBytes) lines.push(`skippedHeader=${map.skippedHeaderBytes}`);
    if (map.companion) {
      lines.push(`companion=${map.companion.rel} bodyPrefix=${map.companion.commonBodyPrefixBytes} payloadPrefix=${map.companion.commonPayloadPrefixBytes} drawPrefix=${map.companion.commonDrawPrefixBytes}`);
      const diff = map.companion.compactTokenDiff;
      if (diff) {
        lines.push(`companionTokenDiff=commonTokens:${diff.commonTokenPrefix} left:${diff.leftDivergenceOffset || "-"} right:${diff.rightDivergenceOffset || "-"}`);
        for (const row of (diff.sample || []).slice(0, 12)) {
          lines.push(`  token#${row.index} ${row.same ? "=" : "!"} left=${row.left} right=${row.right}`);
        }
      }
    }
    lines.push(`leadFields=${map.leadFields.map((field) => `${field.name}@${field.bytes}=${field.value}`).join(" ")}`);
    lines.push(`topBytes=${item.evidence.topBytes.slice(0, 10).map((entry) => `${entry.byte}:${entry.count}`).join(" ")}`);
    lines.push(`topPairs=${item.evidence.topPairs.slice(0, 8).map((entry) => `${entry.bytes}:${entry.count}`).join(" ")}`);
    if (item.evidence.compactProbe) {
      const probe = item.evidence.compactProbe;
      lines.push(`compactTokens=${probe.tokenCount} consumed=${probe.consumedBytes}`);
      lines.push(`compactTags=${(probe.tagCounts || []).slice(0, 10).map((entry) => `${entry.tag}:${entry.count}`).join(" ")}`);
      lines.push("compactLayoutAttempts:");
      for (const attempt of (probe.layoutAttempts || []).slice(0, 4)) {
        lines.push(`  startToken=${attempt.startToken} tuple=${attempt.tupleSize} records=${attempt.records} small=${attempt.smallPercent}% mixed=${attempt.mixedPercent}% wide=${attempt.widePercent}% score=${attempt.score}`);
      }
    }
    if (item.evidence.mapTemplateProbe) {
      const probe = item.evidence.mapTemplateProbe;
      lines.push(`mapTemplateProbe=tokens:${probe.tokenCount} bestScore:${probe.best?.score ?? "-"} fields:${probe.best?.fieldsOffset || "-"} matrix:${probe.best?.matrixRead ?? "-"}/${probe.best?.matrixExpected ?? "-"} end:${probe.best?.matrixEndOffset || "-"}`);
      if (probe.best?.grid) {
        lines.push(`mapTemplateGrid=extent=${probe.best.grid.extentW}x${probe.best.grid.extentH} cell=${probe.best.grid.cellW}x${probe.best.grid.cellH} grid=${probe.best.grid.columns}x${probe.best.grid.rows}/${probe.best.grid.cells} reason=${probe.best.reason || "-"}`);
      }
      for (const candidate of (probe.candidates || []).slice(0, 4)) {
        const grid = candidate.grid ? `${candidate.grid.extentW}x${candidate.grid.extentH} cell=${candidate.grid.cellW}x${candidate.grid.cellH} grid=${candidate.grid.columns}x${candidate.grid.rows}/${candidate.grid.cells}` : "-";
        lines.push(`  candidate score=${candidate.score} startToken=${candidate.startToken} fields=${candidate.fieldsOffset} ${grid} matrix=${candidate.matrixRead}/${candidate.matrixExpected} remain=${candidate.bytesRemaining}`);
      }
    }
    if (item.evidence.f222LayoutProbe) {
      const probe = item.evidence.f222LayoutProbe;
      const grid = probe.grid
        ? `extent=${probe.grid.extentW}x${probe.grid.extentH} cell=${probe.grid.cellW}x${probe.grid.cellH} ceil=${probe.grid.ceilColumns}x${probe.grid.ceilRows}/${probe.grid.ceilCells}`
        : "-";
      lines.push(`f222Layout=count=${probe.count} complete=${probe.tableComplete} fields=${probe.fieldsOffset} matrix=${probe.matrixRead}/${probe.matrixExpected ?? "-"} end=${probe.matrixEndOffset}`);
      lines.push(`f222Grid=${grid}`);
      lines.push(`f222MatrixHead=${(probe.firstMatrixTokens || []).slice(0, 8).map((token) => `${token.offset}:${token.value} slot=${token.pictureSlot} payload=${token.payload24}`).join(" ") || "-"}`);
    }
    lines.push("legacyGridCandidates=omitted; map stream is being treated as compact bytecode until the renderer is proven");
    lines.push("firstDrawBytes:");
    lines.push(...item.evidence.firstDrawBytes.slice(0, 6).map((line) => `  ${line}`));
    lines.push("");
  }
  return lines.join("\n");
}

async function dump(input, outDir) {
  const rootStat = fs.statSync(input);
  const root = rootStat.isDirectory() ? input : findRoot(input);
  const catalog = loadCatalog(root);
  const files = walk(input)
    .filter((file) => extOf(file) === ".map")
    .sort((a, b) => relFrom(root, a).localeCompare(relFrom(root, b), "zh-Hans-CN"));

  const maps = [];
  for (const file of files) {
    maps.push(await analyzeMapFile(file, { root, catalog }));
  }

  const report = {
    input,
    root,
    generatedAt: new Date().toISOString(),
    maps,
  };

  await fsp.mkdir(outDir, { recursive: true });
  await fsp.writeFile(path.join(outDir, "map_trace.json"), JSON.stringify(report, null, 2), "utf8");
  await fsp.writeFile(path.join(outDir, "map_trace.txt"), textForReport(report), "utf8");
  console.log(`Input: ${input}`);
  console.log(`Output: ${outDir}`);
  console.log(`Maps: ${maps.length}`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    usage();
    return;
  }
  await dump(path.resolve(args[0] || DEFAULT_INPUT), path.resolve(args[1] || DEFAULT_OUT));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.stack || err.message || String(err));
    process.exitCode = 1;
  });
}

module.exports = {
  analyzeMapBuffer,
  analyzeMapFile,
};
