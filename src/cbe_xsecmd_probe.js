const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const {
  KNOWN_SCRIPT_COMMANDS,
  decodeCompactToken,
  hexBytes,
} = require("./cbe_struct");

const DEFAULT_GAME_ROOT = path.join(process.cwd(), "out_batch", "众神之战");
const DEFAULT_OUT = path.join(process.cwd(), "out_godwar_xsecmd");
const DEFAULT_OBJECT_JSON = path.join(process.cwd(), "out_godwar_xseobject", "xse_object_trace.json");
const FOCUS = ["s_01.xse", "s_02.xse", "s_03.xse", "s_04.xse"];
const TOKEN_NEEDLES = [
  "XSE0",
  "INIT",
  "_MAIN",
  ...KNOWN_SCRIPT_COMMANDS,
  "SETC",
  "SCREENSIZE",
  "RAMODE",
  "MONSTER",
  "CLOSE",
  "IPT",
  "MOVETO",
  "RTDIALOG",
  "SHOW",
  "END",
  "CHANG",
  "ENE",
  "ROLEPOS",
  "LIGHT",
  "DARK",
  "CR",
  "ONWUDI",
  "ATTACK",
  "SKILL",
  "ISF",
  "SH",
  "FF",
  "SWORD",
  "HUR",
  "ACTION",
];

function cleanName(name) {
  return String(name || "").replace(/^[0-9]{4}_/, "");
}

function relFrom(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function resolveManifestOutput(gameRoot, output) {
  const literal = path.resolve(output);
  const normalized = String(output || "").replace(/\\/g, "/");
  const gameName = path.basename(gameRoot).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const marker = new RegExp(`/out_batch/${gameName}/`, "i");
  const match = normalized.match(marker);
  if (match) {
    const suffix = normalized.slice(match.index + match[0].length).split("/");
    const candidate = path.join(gameRoot, ...suffix);
    if (fs.existsSync(candidate)) return candidate;
  }
  return literal;
}

function hex(n, width = 4) {
  return `0x${n.toString(16).toUpperCase().padStart(width, "0")}`;
}

function loadCatalog(gameRoot) {
  const manifest = JSON.parse(fs.readFileSync(path.join(gameRoot, "manifest.json"), "utf8"));
  return manifest.files
    .filter((file) => file.output && !file.skipped)
    .map((file) => ({
      name: file.name,
      cleanName: cleanName(file.name),
      rel: relFrom(gameRoot, resolveManifestOutput(gameRoot, file.output)),
      output: resolveManifestOutput(gameRoot, file.output),
      size: file.rawSize || file.writtenSize || file.size || 0,
    }));
}

function parseHexString(value) {
  if (typeof value !== "string") return -1;
  const match = value.match(/^0x([0-9a-f]+)$/i);
  return match ? parseInt(match[1], 16) : -1;
}

function loadObjectSummaries(objectJson = DEFAULT_OBJECT_JSON) {
  try {
    const report = JSON.parse(fs.readFileSync(objectJson, "utf8"));
    const summaries = new Map();
    for (const script of report.scripts || []) {
      const best = script.attempts?.[0] || null;
      summaries.set(String(script.name || "").toLowerCase(), {
        shortMode: best?.shortMode || "",
        groupEnd: parseHexString(best?.absoluteGroupEndHex),
        tailEnd: parseHexString(best?.absoluteTailEndHex),
        textPoolStart: parseHexString(script.pools?.textPoolStartHex),
        symbolPoolStart: parseHexString(script.pools?.symbolPoolStartHex),
        recordCount: best?.totalRecords ?? null,
        groupCount: best?.parsedGroupCount ?? null,
        tailOk: best?.tail?.ok ?? null,
        tailWarning: best?.tail?.warnings?.[0] || "",
      });
    }
    return summaries;
  } catch {
    return new Map();
  }
}

function findEntry(catalog, name) {
  const lower = name.toLowerCase();
  return catalog.find((entry) => entry.cleanName.toLowerCase() === lower) || null;
}

function scanTokens(buf) {
  const found = [];
  for (const needleText of TOKEN_NEEDLES) {
    const needle = Buffer.from(needleText, "ascii");
    let offset = -1;
    while ((offset = buf.indexOf(needle, offset + 1)) >= 0) {
      found.push({ offset, text: needleText, len: needle.length, end: offset + needle.length });
    }
  }

  const resourceRegex = /[A-Za-z0-9_./-]+\.(?:sce|xse|actor|map|gif|mp3)/ig;
  const latin = buf.toString("latin1");
  let match;
  while ((match = resourceRegex.exec(latin)) !== null) {
    found.push({ offset: match.index, text: match[0], len: match[0].length, end: match.index + match[0].length });
  }

  const selected = [];
  for (const token of found.sort((a, b) => a.offset - b.offset || b.len - a.len || a.text.localeCompare(b.text))) {
    const overlaps = selected.some((item) => token.offset < item.end && token.end > item.offset);
    if (overlaps) continue;
    selected.push(token);
  }

  return selected
    .sort((a, b) => a.offset - b.offset || b.len - a.len)
    .map((run) => ({
      offset: run.offset,
      offsetHex: hex(run.offset),
      end: run.end,
      text: run.text,
      len: run.len,
      immediateLengthByte: run.offset > 0 && buf[run.offset - 1] === run.len,
      prefixBytes: hexBytes(buf.subarray(Math.max(0, run.offset - 8), run.offset)),
      suffixBytes: hexBytes(buf.subarray(run.end, Math.min(buf.length, run.end + 8))),
    }));
}

function compactDecodeGap(buf) {
  if (!buf.length || buf.length > 16) return [];
  const tokens = [];
  let cursor = 0;
  while (cursor < buf.length) {
    const token = decodeCompactToken(buf, cursor);
    if (!token || token.truncated) break;
    tokens.push({
      offset: cursor,
      raw: token.raw,
      tag: token.tag,
      value: token.value,
      next: token.next,
    });
    cursor = token.next;
  }
  return cursor === buf.length ? tokens : [];
}

function enrichTokenGaps(buf, tokens) {
  return tokens.map((token, index) => {
    const prev = tokens[index - 1] || null;
    const gapStart = prev ? prev.end : Math.max(0, token.offset - 8);
    const gap = buf.subarray(gapStart, token.offset);
    return {
      ...token,
      previousToken: prev?.text || "",
      gapLength: prev ? gap.length : 0,
      gapFromPrevious: prev ? hexBytes(gap) : "",
      compactGap: prev ? compactDecodeGap(gap) : [],
    };
  });
}

function scanCommands(buf) {
  const hits = [];
  for (const command of KNOWN_SCRIPT_COMMANDS) {
    const needle = Buffer.from(command, "ascii");
    let offset = -1;
    while ((offset = buf.indexOf(needle, offset + 1)) >= 0) {
      const start = Math.max(0, offset - 20);
      const end = Math.min(buf.length, offset + needle.length + 36);
      hits.push({
        offset,
        offsetHex: hex(offset),
        command,
        immediateLengthByte: offset > 0 && buf[offset - 1] === command.length,
        windowStart: hex(start),
        windowEnd: hex(end),
        windowBytes: hexBytes(buf.subarray(start, end)),
      });
    }
  }
  return hits.sort((a, b) => a.offset - b.offset || a.command.localeCompare(b.command));
}

function analyzeScript(entry, objectSummaries) {
  const buf = fs.readFileSync(entry.output);
  const tokens = enrichTokenGaps(buf, scanTokens(buf));
  const initIndex = tokens.findIndex((token) => token.text === "INIT");
  const commandArea = initIndex >= 0 ? tokens.slice(Math.max(0, initIndex - 3)) : tokens;
  const objectSummary = objectSummaries.get(entry.cleanName.toLowerCase()) || null;
  return {
    name: entry.cleanName,
    rel: entry.rel,
    size: entry.size,
    objectSummary,
    commands: scanCommands(buf),
    tokens: commandArea.slice(0, 80),
  };
}

function renderCompact(tokens) {
  if (!tokens.length) return "";
  return tokens.map((token) => `${token.raw}:${token.value}`).join(" ");
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# God War XSE Command Probe");
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push("");
  lines.push("## Purpose");
  lines.push("");
  lines.push("This report keeps command-adjacent bytes visible while the XSE VM grammar is still unknown. It is diagnostic evidence, not a bytecode decoder.");
  lines.push("");
  lines.push("## Guardrails");
  lines.push("");
  lines.push("- The visible command strings are in the late label/symbol/script-text area, not proven linear bytecode execution order.");
  lines.push("- The CBE parser around `0x112C4` first builds a per-script record: `sb+0x86DC` has 5 records of `0x74` bytes each, with group records at `+0x48/+0x4C`, opcode records at `+0x54/+0x58`, ranges at `+0x64/+0x68`, and final refs at `+0x6C/+0x70`.");
  lines.push("- Opcode rows are 0x28 bytes. The switch near `0x11492` maps opcode 0..8 to fields `+08`, `+0C`, `+08/type=2`, `+14`, `+14/+04`, `+18`, `+1C`, `+20`, and `+24`.");
  lines.push("- The first post-group `+0x74` references are a temporary opcode-2 backfill array read through a service callback, not script-record field `+0x74`.");
  for (const script of report.scripts) {
    lines.push("");
    lines.push(`## ${script.name}`);
    lines.push("");
    lines.push(`Rel: ${script.rel}`);
    if (script.objectSummary) {
      const summary = script.objectSummary;
      lines.push(`Object table: mode=${summary.shortMode}; groups=${summary.groupCount}; records=${summary.recordCount}; groupEnd=${hex(summary.groupEnd)}; tailEnd=${hex(summary.tailEnd)}; textPool=${hex(summary.textPoolStart)}; symbolPool=${hex(summary.symbolPoolStart)}; tailOk=${summary.tailOk}`);
      if (summary.tailWarning) lines.push(`Object tail warning: ${summary.tailWarning}`);
    }
    lines.push("");
    lines.push("Exact full-command string hits:");
    if (!script.commands.length) {
      lines.push("- none");
    } else {
      for (const hit of script.commands) {
        const len = hit.immediateLengthByte ? " lenByte" : "";
        lines.push(`- ${hit.offsetHex}: ${hit.command}${len}; window ${hit.windowStart}..${hit.windowEnd}: ${hit.windowBytes}`);
      }
    }
    lines.push("");
    lines.push("ASCII/script token sequence from `INIT` onward:");
    if (!script.tokens.length) {
      lines.push("- none");
    } else {
      for (const token of script.tokens) {
        const len = token.immediateLengthByte ? " lenByte" : "";
        const compact = renderCompact(token.compactGap);
        const gap = token.gapFromPrevious
          ? token.gapLength <= 16
            ? ` gap=${token.gapFromPrevious}`
            : ` gapLen=${token.gapLength}`
          : "";
        const compactText = compact ? ` compactGap=${compact}` : "";
        lines.push(`- ${token.offsetHex}: ${token.text}${len}${gap}${compactText}`);
      }
    }
  }
  lines.push("");
  lines.push("## Working Notes");
  lines.push("");
  lines.push("- `LOADLIGHTGOD`, `LOADDARKGOD`, `GETGAMESTATE`, `SETROLEPOS`, `CANSAY`, and `CLOSESCRIPT` often appear as full ASCII atoms.");
  lines.push("- Other commands can appear as suffix fragments mixed with control bytes, such as `SCREENSIZE`, `RAMODE`, `RTDIALOG`, `SHOW`, `ROLEPOS`, `SKILL`, and `ISF`; those are not yet decoded as command calls.");
  lines.push("- Immediate length bytes explain some atoms, but not all; `OPENCR` in `s_03.xse` is one of the important non-immediate cases.");
  lines.push("- The next step is resolving service reader callbacks `+0x64/+0x74`, then connecting object/opcode record references to these symbol-pool atoms and to the command handler arity table.");
  return lines.join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  const gameRoot = path.resolve(args[0] || DEFAULT_GAME_ROOT);
  const outDir = path.resolve(args[1] || DEFAULT_OUT);
  const catalog = loadCatalog(gameRoot);
  const objectSummaries = loadObjectSummaries();
  const scripts = FOCUS
    .map((name) => findEntry(catalog, name))
    .filter(Boolean)
    .map((entry) => analyzeScript(entry, objectSummaries));
  const report = {
    schema: "nicai.cbe.xseCommandProbe.v2",
    gameRoot,
    objectTrace: DEFAULT_OBJECT_JSON,
    generatedAt: new Date().toISOString(),
    scripts,
  };

  fs.mkdirSync(outDir, { recursive: true });
  await fsp.writeFile(path.join(outDir, "xse_command_probe.json"), JSON.stringify(report, null, 2), "utf8");
  await fsp.writeFile(path.join(outDir, "xse_command_probe.md"), renderMarkdown(report), "utf8");
  console.log(`Output: ${outDir}`);
  console.log(`Scripts: ${scripts.length}`);
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
