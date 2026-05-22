const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const DEFAULT_INPUT = path.resolve(__dirname, "..", "cbe file", "众神之战.CBE");
const DEFAULT_OUT = path.resolve(process.cwd(), "out_godwar_symbols");
const RESOURCE_EXTS = new Set(["actor", "gif", "map", "mp3", "sce", "xse"]);

function usage() {
  console.log(`Usage:
  node src/cbe_symbols.js [cbe_file] [output_dir]

Examples:
  node src/cbe_symbols.js "./cbe file/众神之战.CBE" .\\out_godwar_symbols`);
}

function hex(n, width = 0) {
  return `0x${n.toString(16).toUpperCase().padStart(width, "0")}`;
}

function cleanAscii(text) {
  return String(text || "")
    .replace(/^[^A-Za-z0-9_./:\\-]+/, "")
    .replace(/[^A-Za-z0-9_./:\\-]+$/, "");
}

function asciiStrings(buf, min = 4) {
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
      }
      start = -1;
    }
  }
  return out;
}

function isCommandName(text) {
  return /^[A-Z][A-Z0-9_]{3,31}$/.test(text) && /[AEIOU]/.test(text);
}

function findCommandEntries(buf, strings) {
  const commands = [];
  const seen = new Set();
  for (const item of strings) {
    const text = cleanAscii(item.text);
    if (!isCommandName(text) || item.offset < 4) continue;

    const pointerOffset = item.offset - 4;
    const relative = buf.readInt32LE(pointerOffset);
    const target = pointerOffset + relative;
    const distance = pointerOffset - target;
    if (relative >= 0 || target < 0 || target >= pointerOffset || distance > 0x20000) continue;

    const key = `${text}@${item.offset}`;
    if (seen.has(key)) continue;
    seen.add(key);
    commands.push({
      name: text,
      offset: hex(item.offset, 8),
      pointerOffset: hex(pointerOffset, 8),
      relative,
      handlerOffset: hex(target, 8),
      distance,
    });
  }
  return commands.sort((a, b) => Number.parseInt(a.offset.slice(2), 16) - Number.parseInt(b.offset.slice(2), 16));
}

function classifyStrings(strings) {
  const sources = [];
  const resources = [];
  const misc = [];
  const seenSources = new Set();
  const seenResources = new Set();
  const seenMisc = new Set();

  for (const item of strings) {
    const text = cleanAscii(item.text);
    if (!text) continue;

    if (/[\\/][^\\/]+\.(c|h)$/i.test(text)) {
      const key = text.toLowerCase();
      if (!seenSources.has(key)) {
        seenSources.add(key);
        sources.push({ offset: hex(item.offset, 8), text });
      }
      continue;
    }

    const match = /[A-Za-z0-9_./-]+\.([A-Za-z0-9]+)/.exec(text);
    if (match && RESOURCE_EXTS.has(match[1].toLowerCase())) {
      const key = text.toLowerCase();
      if (!seenResources.has(key)) {
        seenResources.add(key);
        resources.push({ offset: hex(item.offset, 8), text });
      }
      continue;
    }

    if (
      text.length >= 5 &&
      text.length <= 80 &&
      /[A-Za-z]/.test(text) &&
      !/[^\x20-\x7e]/.test(text)
    ) {
      const key = text.toLowerCase();
      if (!seenMisc.has(key)) {
        seenMisc.add(key);
        misc.push({ offset: hex(item.offset, 8), text });
      }
    }
  }

  return { sources, resources, misc };
}

function groupNearbyCommands(commands, maxGap = 64) {
  const groups = [];
  for (const command of commands) {
    const offset = Number.parseInt(command.offset.slice(2), 16);
    const last = groups[groups.length - 1];
    if (!last || offset - last.end > maxGap) {
      groups.push({ start: offset, end: offset, commands: [command] });
    } else {
      last.end = offset;
      last.commands.push(command);
    }
  }
  return groups
    .filter((group) => group.commands.length >= 2)
    .map((group) => ({
      start: hex(group.start, 8),
      end: hex(group.end, 8),
      count: group.commands.length,
      commands: group.commands.map((command) => command.name),
    }));
}

function reportText(report) {
  const lines = [];
  lines.push(`# ${path.basename(report.input)}`);
  lines.push(`size=${report.size} commands=${report.commands.length} sources=${report.sources.length} resources=${report.resources.length}`);
  lines.push("");

  lines.push("## Command Tables");
  for (const group of report.commandGroups) {
    lines.push(`${group.start}-${group.end} count=${group.count}`);
    lines.push(`  ${group.commands.join(", ")}`);
  }
  lines.push("");

  lines.push("## Commands");
  for (const command of report.commands) {
    lines.push(`${command.offset} ${command.name} handler=${command.handlerOffset} rel=${command.relative}`);
  }
  lines.push("");

  lines.push("## Source Paths");
  for (const source of report.sources) {
    lines.push(`${source.offset} ${source.text}`);
  }
  lines.push("");

  lines.push("## Resource Strings");
  for (const resource of report.resources.slice(0, 400)) {
    lines.push(`${resource.offset} ${resource.text}`);
  }
  return lines.join("\n");
}

async function dump(input, outDir) {
  const buf = fs.readFileSync(input);
  const strings = asciiStrings(buf, 4);
  const { sources, resources, misc } = classifyStrings(strings);
  const commands = findCommandEntries(buf, strings);
  const commandGroups = groupNearbyCommands(commands);
  const report = {
    input,
    generatedAt: new Date().toISOString(),
    size: buf.length,
    commands,
    commandGroups,
    sources,
    resources,
    misc: misc.slice(0, 500),
  };

  fs.mkdirSync(outDir, { recursive: true });
  await fsp.writeFile(path.join(outDir, "cbe_symbols.json"), JSON.stringify(report, null, 2), "utf8");
  await fsp.writeFile(path.join(outDir, "cbe_symbols.txt"), reportText(report), "utf8");

  console.log(`Input: ${input}`);
  console.log(`Output: ${outDir}`);
  console.log(`Commands: ${commands.length}`);
  console.log(`Source paths: ${sources.length}`);
  console.log(`Resource strings: ${resources.length}`);
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
