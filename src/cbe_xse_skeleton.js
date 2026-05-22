const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const {
  KNOWN_SCRIPT_COMMANDS,
  decodeCompactToken,
  hexBytes,
} = require("./cbe_struct");

const DEFAULT_GAME_ROOT = path.join(process.cwd(), "out_batch", "众神之战");
const DEFAULT_HANDLER_JSON = path.join(process.cwd(), "out_godwar_scripthandlers", "script_handler_trace.json");
const DEFAULT_OBJECT_JSON = path.join(process.cwd(), "out_godwar_xseobject", "xse_object_trace.json");
const DEFAULT_OUT = path.join(process.cwd(), "out_godwar_xseskel");
const FOCUS = ["s_01.xse", "s_02.xse", "s_03.xse", "s_04.xse"];

const FRAGMENT_HINTS = new Map([
  ["SCREENSIZE", "GETSCREENSIZE"],
  ["RAMODE", "SETCAMERAMODE"],
  ["ROLEPOS", "SETROLEPOS"],
  ["MOVETO", "ROLEMOVETO"],
  ["RTDIALOG", "STARTDIALOG"],
  ["SHOW", "SHOWDIALOG"],
  ["CHANG", "CHANGESCENE"],
  ["ENE", "CHANGESCENE"],
  ["LIGHT", "LOADLIGHTGOD"],
  ["DARK", "LOADDARKGOD"],
  ["MONSTER", "LOADMONSTER"],
  ["CLOSE", "CLOSESCRIPT"],
  ["IPT", "CLOSESCRIPT"],
  ["CR", "LOADCR/OPENCR/ISCR"],
  ["ONWUDI", "ROLEONWUDI"],
  ["ATTACK", "ROLEATTACK"],
  ["SKILL", "ROLESKILL/ISFINISHSKILL"],
  ["ISF", "ISFINISHSKILL"],
  ["SWORD", "SETROLESWORD"],
  ["HUR", "HURTROLE"],
  ["END", "ENDDIALOG/ENDSCRIPT"],
]);

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
  if (!Number.isFinite(n) || n < 0) return "";
  return `0x${n.toString(16).toUpperCase().padStart(width, "0")}`;
}

function loadCatalog(gameRoot) {
  const manifest = JSON.parse(fs.readFileSync(path.join(gameRoot, "manifest.json"), "utf8"));
  return manifest.files
    .filter((file) => file.output && !file.skipped)
    .map((file) => ({
      name: file.name,
      cleanName: cleanName(file.name),
      output: resolveManifestOutput(gameRoot, file.output),
      rel: relFrom(gameRoot, resolveManifestOutput(gameRoot, file.output)),
      size: file.rawSize || file.writtenSize || file.size || 0,
    }));
}

function findEntry(catalog, name) {
  const target = name.toLowerCase();
  return catalog.find((entry) => entry.cleanName.toLowerCase() === target) || null;
}

function commandMetaFromHandlers(handlerJson) {
  const data = JSON.parse(fs.readFileSync(handlerJson, "utf8"));
  const out = new Map();
  for (const command of data.commands || []) {
    const args = new Map();
    for (const call of command.callsFromTarget || []) {
      if (call.argIndex === null || call.argIndex === undefined) continue;
      if (call.kind === "read-number") args.set(call.argIndex, "number");
      if (call.kind === "read-ref/string") args.set(call.argIndex, "ref/string");
    }
    const ordered = [...args.entries()].sort((a, b) => a[0] - b[0]);
    out.set(command.name, {
      target: command.target,
      symbolTarget: command.symbolTarget,
      args: ordered.map(([index, type]) => ({ index, type })),
      advance: (command.callsFromTarget || []).find((call) => call.kind === "vm-advance")?.argIndex ?? null,
      branch: (command.callsFromTarget || []).find((call) => call.kind === "vm-branch/result")?.argIndex ?? null,
    });
  }
  return out;
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

function tokenValueForXse(token) {
  if (!token) return null;
  if (token.tag === "s8" && token.raw) {
    const raw = Number.parseInt(token.raw, 16);
    return { value: token.value, unsigned: raw, raw: token.raw, tag: token.tag };
  }
  return { value: token.value, raw: token.raw, tag: token.tag };
}

function decodeGap(buf, start, end) {
  const out = [];
  let cursor = start;
  while (cursor < end) {
    const token = decodeCompactToken(buf, cursor);
    if (!token || token.next > end || token.truncated) {
      const raw = buf[cursor];
      out.push({
        offset: cursor,
        offsetHex: hex(cursor),
        next: cursor + 1,
        tag: "xse-raw",
        value: raw > 0x7F ? raw - 0x100 : raw,
        unsigned: raw,
        raw: raw.toString(16).toUpperCase().padStart(2, "0"),
      });
      cursor += 1;
    } else {
      out.push({
        offset: token.offset,
        offsetHex: hex(token.offset),
        next: token.next,
        ...tokenValueForXse(token),
      });
      cursor = token.next;
    }
  }
  return cursor === end ? out : [];
}

function displayValue(token) {
  if (!token) return "?";
  if (token.unsigned !== undefined && token.unsigned !== token.value) {
    return `${token.value}/u${token.unsigned}`;
  }
  return String(token.value);
}

function scanAtoms(buf) {
  const atoms = [];
  for (const command of KNOWN_SCRIPT_COMMANDS) {
    const needle = Buffer.from(command, "ascii");
    let offset = -1;
    while ((offset = buf.indexOf(needle, offset + 1)) >= 0) {
      atoms.push({
        offset,
        end: offset + command.length,
        text: command,
        command,
        kind: "full",
        lenByte: offset > 0 && buf[offset - 1] === command.length,
      });
    }
  }
  for (const [fragment, command] of FRAGMENT_HINTS.entries()) {
    const needle = Buffer.from(fragment, "ascii");
    let offset = -1;
    while ((offset = buf.indexOf(needle, offset + 1)) >= 0) {
      atoms.push({
        offset,
        end: offset + fragment.length,
        text: fragment,
        command,
        kind: "fragment",
        lenByte: false,
      });
    }
  }
  atoms.sort((a, b) => a.offset - b.offset || b.end - b.offset - (a.end - a.offset));
  const selected = [];
  for (const atom of atoms) {
    if (selected.some((item) => atom.offset < item.end && atom.end > item.offset)) continue;
    selected.push(atom);
  }
  return selected.sort((a, b) => a.offset - b.offset);
}

function possibleLengthForAtom(atom) {
  if (!atom) return null;
  if (atom.kind === "full") return atom.text.length;
  const command = String(atom.command || "").split("/")[0];
  return command.length || null;
}

function candidateArgs(buf, atom, nextAtom, meta) {
  if (!meta || !meta.args.length || !nextAtom) return null;
  const gapStart = atom.end;
  const gapEnd = nextAtom.offset;
  if (gapEnd <= gapStart || gapEnd - gapStart > 16) return null;

  const rawGap = buf.subarray(gapStart, gapEnd);
  const attempts = [];
  const nextLen = possibleLengthForAtom(nextAtom);
  if (nextLen !== null && rawGap[0] === nextLen) {
    attempts.push({ label: "drop-next-len", start: gapStart + 1 });
  }
  attempts.push({ label: "all-gap", start: gapStart });

  for (const attempt of attempts) {
    const decoded = decodeGap(buf, attempt.start, gapEnd);
    if (decoded.length >= meta.args.length) {
      return {
        mode: attempt.label,
        rawGap: hexBytes(rawGap),
        values: decoded.slice(0, meta.args.length),
      };
    }
  }
  return { mode: "undecoded", rawGap: hexBytes(rawGap), values: [] };
}

function regionForOffset(offset, objectSummary) {
  if (!objectSummary) return "unknown";
  if (objectSummary.symbolPoolStart >= 0 && offset >= objectSummary.symbolPoolStart) return "symbol-pool";
  if (objectSummary.textPoolStart >= 0 && offset >= objectSummary.textPoolStart) return "text/resource-pool";
  if (objectSummary.tailEnd >= 0 && offset >= objectSummary.tailEnd) return "post-object-binary";
  return "object/table";
}

function analyzeScript(entry, handlerMeta, objectSummaries) {
  const buf = fs.readFileSync(entry.output);
  const atoms = scanAtoms(buf);
  const objectSummary = objectSummaries.get(entry.cleanName.toLowerCase()) || null;
  const rows = atoms.map((atom, index) => {
    const next = atoms[index + 1] || null;
    const meta = handlerMeta.get(atom.kind === "full" ? atom.command : String(atom.command).split("/")[0]) || null;
    const args = atom.kind === "full" ? candidateArgs(buf, atom, next, meta) : null;
    return {
      offset: atom.offset,
      offsetHex: hex(atom.offset),
      text: atom.text,
      command: atom.command,
      kind: atom.kind,
      region: regionForOffset(atom.offset, objectSummary),
      lenByte: atom.lenByte,
      nextOffset: next ? hex(next.offset) : "",
      gapAfter: next ? hexBytes(buf.subarray(atom.end, next.offset)) : "",
      meta,
      candidateArgs: args,
    };
  });
  return {
    name: entry.cleanName,
    rel: entry.rel,
    size: entry.size,
    objectSummary,
    rows,
  };
}

function renderArgs(args) {
  if (!args) return "";
  if (!args.values.length) return ` candidateArgs(${args.mode}) raw=${args.rawGap}`;
  return ` candidateArgs(${args.mode}) [${args.values.map(displayValue).join(", ")}] raw=${args.rawGap}`;
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# God War XSE Skeleton");
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push("");
  lines.push("## Notes");
  lines.push("");
  lines.push("- This is a skeleton trace, not a finished XSE VM decompiler.");
  lines.push("- `full` rows are exact command-name hits. `fragment` rows are observed suffix/context atoms only.");
  lines.push("- Rows marked `symbol-pool` are command/symbol atoms near `INIT`/`_MAIN`; `candidateArgs(drop-next-len)` is therefore a pool-adjacent hypothesis, not a decoded VM call.");
  lines.push("- Bare bytes above `0x85` are shown as signed and unsigned, for example `-117/u139`, because XSE screen coordinates appear to use the unsigned value while actor streams often use signed compact values.");
  lines.push("- Object context comes from `out_godwar_xseobject`: the 0x112C4 parser builds group/opcode tables before these visible command atoms.");
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
    for (const row of script.rows) {
      const len = row.lenByte ? " lenByte" : "";
      const meta = row.meta ? ` target=${row.meta.target}` : "";
      const region = row.region ? ` region=${row.region}` : "";
      const gap = row.gapAfter ? ` gapAfter=${row.gapAfter}` : "";
      lines.push(`- ${row.offsetHex}: ${row.kind} ${row.text} -> ${row.command}${len}${region}${meta}${gap}${renderArgs(row.candidateArgs)}`);
    }
  }
  return lines.join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  const gameRoot = path.resolve(args[0] || DEFAULT_GAME_ROOT);
  const handlerJson = path.resolve(args[1] || DEFAULT_HANDLER_JSON);
  const outDir = path.resolve(args[2] || DEFAULT_OUT);
  const catalog = loadCatalog(gameRoot);
  const handlerMeta = commandMetaFromHandlers(handlerJson);
  const objectSummaries = loadObjectSummaries();
  const scripts = FOCUS
    .map((name) => findEntry(catalog, name))
    .filter(Boolean)
    .map((entry) => analyzeScript(entry, handlerMeta, objectSummaries));
  const report = {
    schema: "nicai.cbe.xseSkeleton.v2",
    gameRoot,
    handlerJson,
    objectTrace: DEFAULT_OBJECT_JSON,
    generatedAt: new Date().toISOString(),
    scripts,
  };
  fs.mkdirSync(outDir, { recursive: true });
  await fsp.writeFile(path.join(outDir, "xse_skeleton.json"), JSON.stringify(report, null, 2), "utf8");
  await fsp.writeFile(path.join(outDir, "xse_skeleton.md"), renderMarkdown(report), "utf8");
  console.log(`Output: ${outDir}`);
  console.log(`Scripts: ${scripts.length}`);
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
