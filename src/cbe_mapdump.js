const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { summarizeFile } = require("./cbe_struct");

const DEFAULT_INPUT = path.resolve(process.cwd(), "out_godwar");
const DEFAULT_OUT = path.resolve(process.cwd(), "out_godwar_mapdump");

function usage() {
  console.log(`Usage:
  node src/cbe_mapdump.js [unpacked_dir_or_file] [output_dir]

Examples:
  node src/cbe_mapdump.js .\\out_godwar .\\out_godwar_mapdump
  node src/cbe_mapdump.js .\\out_godwar\\section_1_39BCD\\0317_1map01.map .\\out_godwar_mapdump`);
}

function walk(input) {
  const stat = fs.statSync(input);
  if (stat.isFile()) return [input];

  const out = [];
  for (const name of fs.readdirSync(input)) {
    const file = path.join(input, name);
    const childStat = fs.statSync(file);
    if (childStat.isDirectory()) {
      out.push(...walk(file));
    } else {
      out.push(file);
    }
  }
  return out;
}

function relFrom(base, file) {
  return path.relative(base, file).split(path.sep).join("/");
}

function compactTokenLine(token) {
  if (!token) return "-";
  return `${token.offset}:${token.value}(${token.raw})`;
}

function probeLines(probe) {
  if (!probe?.attempts?.length && !probe?.ffTokenCandidate) return ["templateProbe=-"];
  const lines = [];
  const ff = probe.ffTokenCandidate ? `${probe.ffTokenCandidate.markerBytes} @ ${probe.ffTokenCandidate.offset}` : "-";
  lines.push(`templateProbeNote=${probe.note || "diagnostic only"}`);
  lines.push(`templateProbeFfToken=${ff}`);
  for (const [index, attempt] of (probe.attempts || []).slice(0, 4).entries()) {
    const fields = (attempt.fields || []).map(compactTokenLine).join(" ");
    const grid = attempt.grid
      ? `${attempt.grid.cellW}x${attempt.grid.cellH} extent=${attempt.grid.width}x${attempt.grid.height} matrix=${attempt.grid.columns}x${attempt.grid.rows}/${attempt.grid.cells}`
      : "-";
    const firstMatrix = (attempt.firstMatrixTokens || []).slice(0, 8).map(compactTokenLine).join(" ");
    lines.push(`templateAttempt#${index + 1}=score:${attempt.score} count:${attempt.count}/${attempt.countRead} stride:${attempt.recordStride} fields@${attempt.fieldsOffset} ${fields || "-"} grid:${grid} matrixEnd:${attempt.matrixEnd} bytesToFf:${attempt.bytesToFfCandidate ?? "-"} canvasDelta:${attempt.targetDelta ?? "-"} swapped:${attempt.targetDeltaSwapped ?? "-"} firstMatrix:${firstMatrix || "-"}`);
  }
  return lines;
}

function f222LayoutLines(probe) {
  if (!probe) return ["f222LayoutProbe=-"];
  const lines = [];
  const ff = probe.ffTokenCandidate ? `${probe.ffTokenCandidate.markerBytes} @ ${probe.ffTokenCandidate.offset}` : "-";
  const fields = (probe.fields || []).map((field) => `${field.objectOffset}:${field.value}(${field.raw}) ${field.role}`).join(" ");
  const grid = probe.grid
    ? `extent=${probe.grid.extentW}x${probe.grid.extentH} cell=${probe.grid.cellW}x${probe.grid.cellH} floor=${probe.grid.floorColumns}x${probe.grid.floorRows}/${probe.grid.floorCells} ceil=${probe.grid.ceilColumns}x${probe.grid.ceilRows}/${probe.grid.ceilCells}`
    : "-";
  const image = probe.image
    ? ` image=${probe.image.width}x${probe.image.height} extentDelta=${probe.image.extentDelta ?? "-"} cellDelta=${probe.image.cellDelta ?? "-"}`
    : "";
  lines.push(`f222LayoutNote=${probe.note || "diagnostic only"}`);
  lines.push(`f222Table=count:${probe.count} raw:${probe.countRaw} complete:${probe.tableComplete} after:${probe.tableAfterOffset} approx:${probe.referenceTableApproximation}`);
  if (!probe.tableComplete) lines.push(`f222TableTruncated=${probe.tableTruncatedReason || probe.tableTruncatedAtRecord}`);
  lines.push(`f222Fields@${probe.fieldsOffset} ${fields || "-"}${image}`);
  lines.push(`f222Grid=${grid}`);
  lines.push(`f222Matrix=read:${probe.matrixRead}/${probe.matrixExpected ?? "-"} end:${probe.matrixEndOffset} bytesToFf:${probe.bytesToFfCandidate ?? "-"} ff:${ff}`);
  const matrix = (probe.firstMatrixTokens || []).slice(0, 10).map((token) => (
    `${token.offset}:${token.value}(${token.raw}) slot:${token.pictureSlot} payload:${token.payload24}`
  )).join(" ");
  lines.push(`f222MatrixHead=${matrix || "-"}`);
  return lines;
}

function lineForMap(item) {
  const map = item.summary.specific.map;
  const canvas = map.canvas ? `${map.canvas.width}x${map.canvas.height}` : "?";
  const stream = map.stream || {};
  const template = map.pictureTemplate || {};
  const compact = map.compactProbe || {};
  const topBytes = (stream.topBytes || []).slice(0, 8).map((entry) => `${entry.byte}:${entry.count}`).join(" ");
  const topPairs = (stream.topPairs || []).slice(0, 6).map((entry) => `${entry.pair}:${entry.count}`).join(" ");
  const compactTags = (compact.tagCounts || []).slice(0, 8).map((entry) => `${entry.tag}:${entry.count}`).join(" ");
  return [
    `## ${item.rel}`,
    `canvas=${canvas} source=${map.canvasSource || "-"} tileset=${map.tilesetHint || "-"}`,
    `pictureTemplate=${template.compactName || "-"} header=${template.headerBytes || "-"} word0=${template.headerWord0 ?? "-"} stream=${template.streamOffset || "-"}`,
    `dataOffset=${map.dataOffset} payload=${map.payloadLength} drawOffset=${map.drawStreamOffset || "-"} draw=${map.drawStreamLength ?? "-"} density16=${stream.bytesPer16Cell ?? "-"} highBit=${stream.highBitPercent ?? "-"}% zero=${stream.zeroPercent ?? "-"}% alignedNibble=${stream.alignedNibblePercent ?? "-"}%`,
    `header=${map.headerDimension ? `${map.headerDimension.encoding} @ ${map.headerDimension.offset}${map.headerDimension.ignoredForSceneCanvas ? " (diagnostic)" : ""}` : "-"}`,
    `leadHeader=${map.leadHeader ? `${map.leadHeader.encoding} @ ${map.leadHeader.offset} -> ${map.leadHeader.drawStreamOffset}` : "-"}`,
    `topBytes=${topBytes}`,
    `topPairs=${topPairs}`,
    `compactProbe=${compact.tokenCount ? `${compact.tokenCount} tokens consumed=${compact.consumedBytes} tags=${compactTags || "-"}` : "-"}`,
    ...f222LayoutLines(map.f222LayoutProbe),
    ...probeLines(map.templateStreamProbe),
    "",
  ].join("\n");
}

async function dump(input, outDir) {
  const rootStat = fs.statSync(input);
  const root = rootStat.isDirectory() ? input : path.dirname(input);
  const files = walk(input)
    .filter((file) => path.extname(file).toLowerCase() === ".map")
    .sort((a, b) => relFrom(root, a).localeCompare(relFrom(root, b), "zh-Hans-CN"));

  fs.mkdirSync(outDir, { recursive: true });
  const items = [];
  for (const file of files) {
    const rel = relFrom(root, file);
    const summary = await summarizeFile(file, {
      name: path.basename(file).replace(/^[0-9]{4}_/, ""),
      catalog: files.map((entry) => ({ name: path.basename(entry), rel: relFrom(root, entry) })),
    });
    items.push({ file, rel, summary });
  }

  const report = {
    input,
    generatedAt: new Date().toISOString(),
    maps: items,
  };
  await fsp.writeFile(path.join(outDir, "map_streams.json"), JSON.stringify(report, null, 2), "utf8");
  await fsp.writeFile(path.join(outDir, "map_streams.txt"), items.map(lineForMap).join("\n"), "utf8");

  console.log(`Input: ${input}`);
  console.log(`Output: ${outDir}`);
  console.log(`Maps: ${items.length}`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    usage();
    return;
  }
  await dump(path.resolve(args[0] || DEFAULT_INPUT), path.resolve(args[1] || DEFAULT_OUT));
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
