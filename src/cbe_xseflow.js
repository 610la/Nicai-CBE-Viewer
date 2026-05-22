const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const {
  KNOWN_SCRIPT_COMMANDS,
  scanLengthPrefixedRefs,
  scanTextRuns,
  summarizeFile,
} = require("./cbe_struct");

const DEFAULT_GAME_ROOT = path.join(process.cwd(), "out_batch", "众神之战");
const DEFAULT_OUT = path.join(process.cwd(), "out_godwar_xseflow");

const FOCUS_NAMES = [
  "s_01.xse",
  "s_02.xse",
  "s_03.xse",
  "s_04.xse",
  "gm_dialog.xse",
  "gm_maintask.xse",
  "ha_dialog.xse",
  "ha_maintask.xse",
  "kaichang.sce",
  "guangmingshendian.sce",
  "heianshendian.sce",
  "zhongli.sce",
];

function cleanName(name) {
  return String(name || "").replace(/^[0-9]{4}_/, "");
}

function relFrom(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function extOf(name) {
  return path.extname(name || "").toLowerCase();
}

function hex(n, width = 4) {
  return `0x${n.toString(16).toUpperCase().padStart(width, "0")}`;
}

function hexBytes(buf) {
  return Array.from(buf).map((byte) => byte.toString(16).toUpperCase().padStart(2, "0")).join(" ");
}

function loadCatalog(gameRoot) {
  const manifest = JSON.parse(fs.readFileSync(path.join(gameRoot, "manifest.json"), "utf8"));
  return manifest.files
    .filter((file) => file.output && !file.skipped)
    .map((file) => ({
      name: file.name,
      cleanName: cleanName(file.name),
      rel: relFrom(gameRoot, file.output),
      output: file.output,
      ext: extOf(file.name),
      size: file.writtenSize || file.rawSize || file.size || 0,
    }));
}

function findEntry(catalog, name) {
  const target = cleanName(name).toLowerCase();
  return catalog.find((entry) => entry.cleanName.toLowerCase() === target) || null;
}

function resolveEntry(catalog, name) {
  const exact = findEntry(catalog, name);
  if (exact) return exact;
  const target = cleanName(path.basename(name || "")).toLowerCase();
  if (!target || target.length < 5) return null;
  const suffixes = catalog.filter((entry) => entry.cleanName.toLowerCase().endsWith(target));
  return suffixes.length === 1 ? suffixes[0] : null;
}

function refRegex() {
  return /[A-Za-z0-9_./-]+\.(?:sce|xse|map|actor|gif|mp3)/ig;
}

function scanAsciiRefs(buf) {
  const text = buf.toString("latin1");
  const refs = [];
  let match;
  const regex = refRegex();
  while ((match = regex.exec(text)) !== null) {
    refs.push({ offset: match.index, text: match[0] });
  }
  return refs;
}

function scanCommands(buf) {
  const commands = [];
  for (const name of KNOWN_SCRIPT_COMMANDS) {
    const needle = Buffer.from(name, "ascii");
    let offset = -1;
    while ((offset = buf.indexOf(needle, offset + 1)) >= 0) {
      commands.push({ offset, name });
    }
  }
  return commands.sort((a, b) => a.offset - b.offset || a.name.localeCompare(b.name));
}

function windowFor(buf, offset, before = 18, after = 48) {
  const start = Math.max(0, offset - before);
  const end = Math.min(buf.length, offset + after);
  return {
    start: hex(start),
    end: hex(end),
    bytes: hexBytes(buf.subarray(start, end)),
  };
}

function nearestBefore(items, offset) {
  let best = null;
  for (const item of items) {
    if (item.offset > offset) continue;
    if (!best || item.offset > best.offset) best = item;
  }
  return best;
}

function nearestAfter(items, offset) {
  let best = null;
  for (const item of items) {
    if (item.offset < offset) continue;
    if (!best || item.offset < best.offset) best = item;
  }
  return best;
}

function enrichRefs(catalog, refs) {
  const seen = new Set();
  const out = [];
  for (const ref of refs) {
    const clean = String(ref.text || "").replace(/^[^A-Za-z0-9_./-]+|[^A-Za-z0-9_./-]+$/g, "");
    const key = `${ref.offset}:${clean.toLowerCase()}`;
    if (!clean || seen.has(key)) continue;
    seen.add(key);
    const entry = resolveEntry(catalog, path.basename(clean));
    out.push({
      offset: ref.offset,
      offsetHex: hex(ref.offset),
      text: clean,
      matched: entry?.cleanName || "",
      rel: entry?.rel || "",
      ext: entry?.ext || extOf(clean),
    });
  }
  return out.sort((a, b) => a.offset - b.offset);
}

function commandEvidence(buf, commands, refs, textRuns) {
  return commands.map((command) => {
    const refAfter = nearestAfter(refs, command.offset);
    const refBefore = nearestBefore(refs, command.offset);
    const textAfter = nearestAfter(textRuns, command.offset);
    const textBefore = nearestBefore(textRuns, command.offset);
    return {
      offset: command.offset,
      offsetHex: hex(command.offset),
      name: command.name,
      window: windowFor(buf, command.offset),
      nearestRefBefore: refBefore ? { offset: refBefore.offsetHex, text: refBefore.text, rel: refBefore.rel } : null,
      nearestRefAfter: refAfter ? { offset: refAfter.offsetHex, text: refAfter.text, rel: refAfter.rel } : null,
      nearestTextBefore: textBefore ? { offset: hex(textBefore.offset), text: textBefore.text } : null,
      nearestTextAfter: textAfter ? { offset: hex(textAfter.offset), text: textAfter.text } : null,
    };
  });
}

async function analyzeXse(entry, catalog) {
  const buf = fs.readFileSync(entry.output);
  const textRuns = scanTextRuns(buf, 3, 240).map((run) => ({
    offset: run.offset,
    offsetHex: hex(run.offset),
    text: run.text,
  }));
  const lengthRefs = scanLengthPrefixedRefs(buf, 2, 64).map((ref) => ({
    offset: ref.recordOffset,
    text: ref.text,
  }));
  const refs = enrichRefs(catalog, [...scanAsciiRefs(buf), ...lengthRefs]);
  const commands = scanCommands(buf);
  return {
    kind: "xse",
    name: entry.cleanName,
    rel: entry.rel,
    size: entry.size,
    magicOffset: hex(buf.indexOf(Buffer.from("XSE0", "ascii"))),
    commands: commandEvidence(buf, commands, refs, textRuns),
    refs,
    textRuns,
  };
}

async function analyzeSce(entry, catalog) {
  const summary = await summarizeFile(entry.output, {
    name: entry.cleanName,
    catalog,
  });
  const sce = summary.specific?.sce || {};
  return {
    kind: "sce",
    name: entry.cleanName,
    rel: entry.rel,
    size: entry.size,
    canvas: sce.canvas || null,
    mapRecords: (sce.mapTable?.records || []).map((record) => ({
      ...(() => {
        const resolved = resolveEntry(catalog, record.name);
        return { matched: resolved?.cleanName || record.matched || "", rel: resolved?.rel || record.rel || "" };
      })(),
      offset: record.offset,
      name: record.name,
      fields: record.fields,
    })),
    scripts: (sce.lengthPrefixedRefs || [])
      .filter((ref) => /\.xse$/i.test(ref.text))
      .map((ref) => ({
        ...(() => {
          const resolved = resolveEntry(catalog, ref.text);
          return { matched: resolved?.cleanName || ref.matched || "", rel: resolved?.rel || ref.rel || "" };
        })(),
        offset: ref.offset,
        name: ref.text,
      })),
    placements: (sce.placements || []).map((placement) => ({
      ...(() => {
        const resolved = resolveEntry(catalog, placement.matched || placement.name);
        return { matched: resolved?.cleanName || placement.matched || "", rel: resolved?.rel || placement.rel || "" };
      })(),
      offset: placement.offset,
      name: placement.name,
      x: placement.x,
      y: placement.y,
      recordType: placement.recordType,
    })),
  };
}

function buildEdges(nodes) {
  const edges = [];
  for (const node of nodes) {
    if (node.kind === "xse") {
      for (const ref of node.refs) {
        if (ref.rel) edges.push({ from: node.rel, to: ref.rel, label: ref.text, offset: ref.offsetHex });
      }
    }
    if (node.kind === "sce") {
      for (const script of node.scripts) {
        if (script.rel) edges.push({ from: node.rel, to: script.rel, label: script.name, offset: script.offset });
      }
      for (const map of node.mapRecords) {
        if (map.rel) edges.push({ from: node.rel, to: map.rel, label: map.name, offset: map.offset });
      }
      for (const placement of node.placements) {
        if (placement.rel) edges.push({ from: node.rel, to: placement.rel, label: placement.name, offset: placement.offset });
      }
    }
  }
  return edges;
}

function renderTextRuns(textRuns, limit = 12) {
  if (!textRuns.length) return "- none\n";
  return textRuns.slice(0, limit).map((run) => `- ${run.offsetHex}: ${run.text}`).join("\n") + "\n";
}

function renderRefs(refs) {
  if (!refs.length) return "- none\n";
  return refs.map((ref) => `- ${ref.offsetHex}: ${ref.text}${ref.rel ? ` -> ${ref.rel}` : ""}`).join("\n") + "\n";
}

function renderCommands(commands) {
  if (!commands.length) return "- none\n";
  return commands.map((command) => {
    const after = command.nearestRefAfter ? `; nextRef=${command.nearestRefAfter.text}` : "";
    const text = command.nearestTextAfter ? `; nextText=${command.nearestTextAfter.text.slice(0, 32)}` : "";
    return `- ${command.offsetHex}: ${command.name}${after}${text}`;
  }).join("\n") + "\n";
}

function renderSce(node) {
  const lines = [];
  lines.push(`Canvas: ${node.canvas ? `${node.canvas.width}x${node.canvas.height}` : "-"}`);
  lines.push("");
  lines.push("Maps:");
  lines.push(node.mapRecords.length ? node.mapRecords.map((item) => `- ${item.offset}: ${item.name} -> ${item.rel || item.matched || "-"}`).join("\n") : "- none");
  lines.push("");
  lines.push("Scripts:");
  lines.push(node.scripts.length ? node.scripts.map((item) => `- ${item.offset}: ${item.name} -> ${item.rel || item.matched || "-"}`).join("\n") : "- none");
  lines.push("");
  lines.push("Placements:");
  lines.push(node.placements.length ? node.placements.map((item) => `- ${item.offset}: ${item.name} -> ${item.rel || item.matched || "-"} @ ${item.x},${item.y} type=${item.recordType}`).join("\n") : "- none");
  return lines.join("\n") + "\n";
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# God War XSE Flow Trace");
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push("");
  lines.push("## Focus");
  lines.push("");
  lines.push("- Opening-route scripts: `s_02.xse`, `zhongli.sce`, `s_03.xse`.");
  lines.push("- Light/dark branch evidence: `gm_dialog`, `ha_dialog`, `gm_maintask`, `ha_maintask`, `s_01`, `s_04`.");
  lines.push("- This is a trace, not a decompiled VM yet.");
  lines.push("");
  lines.push("## Edges");
  lines.push("");
  lines.push(report.edges.length ? report.edges.map((edge) => `- ${edge.from} --${edge.label}@${edge.offset}--> ${edge.to}`).join("\n") : "- none");
  for (const node of report.nodes) {
    lines.push("");
    lines.push(`## ${node.name}`);
    lines.push("");
    lines.push(`Rel: ${node.rel}`);
    lines.push("");
    if (node.kind === "sce") {
      lines.push(renderSce(node));
      continue;
    }
    lines.push("Commands:");
    lines.push(renderCommands(node.commands));
    lines.push("Resource refs:");
    lines.push(renderRefs(node.refs));
    lines.push("Text runs:");
    lines.push(renderTextRuns(node.textRuns, 18));
  }
  lines.push("");
  lines.push("## Working Notes");
  lines.push("");
  lines.push("- `s_02.xse` is attached to `guangmingshendian.sce` and contains `LOADLIGHTGOD`, `SETROLEPOS`, and a direct `zhongli.sce` reference.");
  lines.push("- `zhongli.sce` attaches `s_03.xse`, so the observed opening chain has a concrete resource path.");
  lines.push("- `s_03.xse` contains `LOADDARKGOD` and dialogue about the brothers deciding who goes to the human village, which makes it a strong protagonist-choice/branch target.");
  lines.push("- Full interpretation still requires decoding the XSE VM record format, command arguments, and branch predicates.");
  return lines.join("\n");
}

async function main() {
  const gameRoot = path.resolve(process.argv[2] || DEFAULT_GAME_ROOT);
  const outDir = path.resolve(process.argv[3] || DEFAULT_OUT);
  const catalog = loadCatalog(gameRoot);
  const nodes = [];
  for (const name of FOCUS_NAMES) {
    const entry = findEntry(catalog, name);
    if (!entry) continue;
    if (entry.ext === ".xse") nodes.push(await analyzeXse(entry, catalog));
    if (entry.ext === ".sce") nodes.push(await analyzeSce(entry, catalog));
  }
  const report = {
    schema: "nicai.cbe.xseFlowTrace.v1",
    generatedAt: new Date().toISOString(),
    gameRoot,
    focusNames: FOCUS_NAMES,
    nodes,
    edges: buildEdges(nodes),
  };
  await fsp.mkdir(outDir, { recursive: true });
  await fsp.writeFile(path.join(outDir, "xse_flow_trace.json"), JSON.stringify(report, null, 2), "utf8");
  await fsp.writeFile(path.join(outDir, "xse_flow_trace.md"), renderMarkdown(report), "utf8");
  console.log(`Output: ${path.join(outDir, "xse_flow_trace.md")}`);
  console.log(`Nodes: ${nodes.length}`);
  console.log(`Edges: ${report.edges.length}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.stack || err.message || String(err));
    process.exitCode = 1;
  });
}
