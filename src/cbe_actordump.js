const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { summarizeFile } = require("./cbe_struct");

const DEFAULT_INPUT = path.resolve(process.cwd(), "out_godwar");
const DEFAULT_OUT = path.resolve(process.cwd(), "out_godwar_actordump");

function usage() {
  console.log(`Usage:
  node src/cbe_actordump.js [unpacked_dir_or_actor_file] [output_dir]

Examples:
  node src/cbe_actordump.js .\\out_godwar .\\out_godwar_actordump
  node src/cbe_actordump.js .\\out_godwar\\section_1_39BCD\\0401_heermode.actor .\\out_godwar_actordump`);
}

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

function markerFamily(markerBytes) {
  const bytes = String(markerBytes || "").split(/\s+/);
  if (bytes.length >= 5 && bytes[2] === "0xFF" && bytes[3] === "0xFF" && bytes[4] === "0xFF") {
    return `${bytes[0]} ${bytes[1]} FF FF FF`;
  }
  if (bytes.length >= 3 && bytes[0] === "0xFF" && bytes[1] === "0xFF" && bytes[2] === "0xFF") {
    return "FF FF FF";
  }
  return markerBytes || "-";
}

function compactTokenLine(token) {
  if (!token) return "-";
  return `${token.offset}:${token.value}(${token.raw})`;
}

function probeLines(probe, targetLabel = "gif") {
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
    lines.push(`templateAttempt#${index + 1}=score:${attempt.score} count:${attempt.count}/${attempt.countRead} stride:${attempt.recordStride} fields@${attempt.fieldsOffset} ${fields || "-"} grid:${grid} matrixEnd:${attempt.matrixEnd} bytesToFf:${attempt.bytesToFfCandidate ?? "-"} ${targetLabel}Delta:${attempt.targetDelta ?? "-"} swapped:${attempt.targetDeltaSwapped ?? "-"} firstMatrix:${firstMatrix || "-"}`);
  }
  return lines;
}

function frameTableLines(probe) {
  if (!probe?.records?.length) return ["frameTableProbe=-"];
  const lines = [];
  const columns = (probe.columns || []).map((column, index) => `c${index}:${column.min ?? "-"}..${column.max ?? "-"} u${column.unique ?? "-"}`).join(" ");
  const image = probe.image ? ` image=${probe.image.width}x${probe.image.height} coordHit=${probe.image.valuesWithinImagePercent}%` : "";
  lines.push(`pictureRefTableApprox=count:${probe.count} raw:${probe.countRaw} after:${probe.afterRecordsOffset} records:${probe.recordCount} ${columns}${image}`);
  lines.push(`pictureRefTableNote=${probe.note || "diagnostic only"}`);
  for (const record of probe.records.slice(0, 8)) {
    lines.push(`pictureRefApprox#${record.index}=${record.offset} values:${record.values.join(",")} raw:${record.raw}`);
  }
  const next = (probe.nextTokens || []).slice(0, 8).map(compactTokenLine).join(" ");
  lines.push(`pictureRefNext=${next || "-"}`);
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

function textFor(report) {
  const lines = [];
  lines.push(`# actor dump`);
  lines.push(`input=${report.input}`);
  lines.push(`actors=${report.actors.length} withToken=${report.stats.withToken} withoutToken=${report.stats.withoutToken}`);
  lines.push(`tokenFamilies=${report.stats.tokenFamilies.map((item) => `${item.family}:${item.count}`).join(" ")}`);
  lines.push("");

  for (const item of report.actors) {
    const actor = item.summary.specific.actor || {};
    const header = actor.header || {};
    const info = actor.imageInfo || {};
    const stream = actor.stream || {};
    const token = stream.divider || {};
    lines.push(`## ${item.rel}`);
    lines.push(`gif=${actor.primaryImage || "-"} size=${info.width ? `${info.width}x${info.height}` : "-"} descriptors=${info.frames ?? "-"} sheetLike=${Boolean(info.sheetLike)}`);
    lines.push(`headerWord0=${header.headerWord0 ?? "-"} nameLen=${header.declaredNameLength ?? "-"} stream=${actor.streamOffset || "-"} len=${actor.streamLength ?? "-"}`);
    lines.push(`token=${token.markerBytes || "-"} offset=${token.offset || "-"} pre=${token.preDataLength ?? "-"} post=${token.postLength ?? "-"}`);
    lines.push(`topBytes=${(stream.topBytes || []).slice(0, 8).map((entry) => `${entry.byte}:${entry.count}`).join(" ")}`);
    lines.push(...frameTableLines(actor.frameTableProbe));
    lines.push(...f222LayoutLines(actor.f222LayoutProbe));
    lines.push(...probeLines(actor.templateStreamProbe, "gif"));
    lines.push("");
  }
  return lines.join("\n");
}

function summarizeStats(actors) {
  const families = new Map();
  let withToken = 0;
  for (const item of actors) {
    const token = item.summary.specific.actor?.stream?.divider || null;
    if (!token) continue;
    withToken += 1;
    const family = markerFamily(token.markerBytes);
    families.set(family, (families.get(family) || 0) + 1);
  }
  return {
    withToken,
    withoutToken: actors.length - withToken,
    tokenFamilies: Array.from(families, ([family, count]) => ({ family, count }))
      .sort((a, b) => b.count - a.count || a.family.localeCompare(b.family)),
  };
}

async function dump(input, outDir) {
  const inputStat = fs.statSync(input);
  const root = inputStat.isDirectory() ? input : findRoot(input);
  const catalog = loadCatalog(root);
  const files = walk(input)
    .filter((file) => path.extname(file).toLowerCase() === ".actor")
    .sort((a, b) => relFrom(root, a).localeCompare(relFrom(root, b), "zh-Hans-CN"));

  const actors = [];
  for (const file of files) {
    const rel = relFrom(root, file);
    const summary = await summarizeFile(file, {
      name: cleanName(path.basename(file)),
      catalog,
    });
    actors.push({ file, rel, summary });
  }

  const report = {
    input,
    generatedAt: new Date().toISOString(),
    stats: summarizeStats(actors),
    actors,
  };

  await fsp.mkdir(outDir, { recursive: true });
  await fsp.writeFile(path.join(outDir, "actor_streams.json"), JSON.stringify(report, null, 2), "utf8");
  await fsp.writeFile(path.join(outDir, "actor_streams.txt"), textFor(report), "utf8");

  console.log(`Input: ${input}`);
  console.log(`Output: ${outDir}`);
  console.log(`Actors: ${actors.length}`);
  console.log(`With FF-token candidate: ${report.stats.withToken}`);
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
