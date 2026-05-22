const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { DATA_EXTS, summarizeFile } = require("./cbe_struct");

const DEFAULT_INPUT = path.resolve(process.cwd(), "out_godwar");
const DEFAULT_OUT = path.resolve(process.cwd(), "out_godwar_struct");

function usage() {
  console.log(`Usage:
  node src/cbe_structdump.js [unpacked_dir_or_file] [output_dir]

Examples:
  node src/cbe_structdump.js .\\out_godwar .\\out_godwar_struct
  node src/cbe_structdump.js .\\out_batch\\众神之战 .\\out_godwar_struct`);
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

function loadCatalog(root, files) {
  const manifestPath = path.join(root, "manifest.json");
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return manifest.files
      .filter((file) => file.name)
      .map((file) => ({
        name: file.name,
        rel: file.output ? relFrom(root, file.output) : "",
      }));
  }
  return files.map((file) => ({ name: path.basename(file), rel: relFrom(root, file) }));
}

function summaryText(items) {
  const lines = [];
  for (const item of items) {
    lines.push(`## ${item.rel}`);
    lines.push(`size=${item.summary.size} ext=${item.summary.ext}`);
    if (item.summary.envelope?.declaredBodyLength != null) {
      lines.push(`envelope.tag=${item.summary.envelope.tag} body=${item.summary.envelope.bodyLength} declared=${item.summary.envelope.declaredBodyLength} match=${item.summary.envelope.lengthMatches}`);
    }
    if (item.summary.specific.sce?.canvas) {
      const canvas = item.summary.specific.sce.canvas;
      lines.push(`sce.canvas=${canvas.width}x${canvas.height}`);
    }
    if (item.summary.specific.sce?.placements?.length) {
      lines.push(`sce.placements=${item.summary.specific.sce.placements.length}`);
      for (const placement of item.summary.specific.sce.placements.slice(0, 16)) {
        lines.push(`  ${placement.offset} ${placement.name} -> ${placement.matched} x=${placement.x} y=${placement.y} type=${placement.recordType} (${placement.matchReason})`);
      }
    }
    if (item.summary.specific.sce?.lengthPrefixedRefs?.length) {
      lines.push("sce.lengthStrings:");
      for (const ref of item.summary.specific.sce.lengthPrefixedRefs.slice(0, 12)) {
        lines.push(`  ${ref.offset} len=${ref.length} ${ref.text}`);
      }
    }
    if (item.summary.specific.map?.tilesetHint) {
      lines.push(`map.tilesetHint=${item.summary.specific.map.tilesetHint}`);
    }
    if (item.summary.specific.map?.canvas) {
      const canvas = item.summary.specific.map.canvas;
      lines.push(`map.canvas=${canvas.width}x${canvas.height}`);
      lines.push(`map.dataOffset=${item.summary.specific.map.dataOffset}`);
    }
    if (item.summary.specific.actor?.primaryImage) {
      lines.push(`actor.primaryImage=${item.summary.specific.actor.primaryImage}`);
    }
    if (item.summary.specific.xse?.commands?.length) {
      lines.push(`xse.commands=${item.summary.specific.xse.commands.map((command) => `${command.offset}:${command.name}`).join(" ")}`);
    }

    const direct = item.summary.refs.direct
      .map((ref) => `${ref.offset} ${ref.text}${ref.matched ? ` -> ${ref.matched}` : ""}`);
    if (direct.length) {
      lines.push("direct refs:");
      lines.push(...direct.map((line) => `  ${line}`));
    }

    const candidates = item.summary.refs.candidates
      .slice(0, 12)
      .map((ref) => `${ref.offset} ${ref.fragment} => ${ref.name} (${ref.reason})`);
    if (candidates.length) {
      lines.push("candidate refs:");
      lines.push(...candidates.map((line) => `  ${line}`));
    }

    const textRuns = item.summary.textRuns.slice(0, 12).map((run) => `${run.offset} ${run.text}`);
    if (textRuns.length) {
      lines.push("text:");
      lines.push(...textRuns.map((line) => `  ${line}`));
    }
    lines.push("");
  }
  return lines.join("\n");
}

async function dump(input, outDir) {
  const rootStat = fs.statSync(input);
  const root = rootStat.isDirectory() ? input : path.dirname(input);
  const files = walk(input)
    .filter((file) => DATA_EXTS.has(path.extname(file).toLowerCase()))
    .sort((a, b) => relFrom(root, a).localeCompare(relFrom(root, b), "zh-Hans-CN"));
  const catalog = loadCatalog(root, walk(root));

  fs.mkdirSync(outDir, { recursive: true });
  const items = [];
  for (const file of files) {
    const rel = relFrom(root, file);
    const summary = await summarizeFile(file, {
      name: path.basename(file).replace(/^[0-9]{4}_/, ""),
      catalog,
    });
    items.push({ file, rel, summary });
  }

  const report = {
    input,
    generatedAt: new Date().toISOString(),
    files: items,
  };
  await fsp.writeFile(path.join(outDir, "resource_summary.json"), JSON.stringify(report, null, 2), "utf8");
  await fsp.writeFile(path.join(outDir, "resource_summary.txt"), summaryText(items), "utf8");

  console.log(`Input: ${input}`);
  console.log(`Output: ${outDir}`);
  console.log(`Data files: ${items.length}`);
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
