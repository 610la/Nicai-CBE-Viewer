const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const DEFAULT_GAME_ROOT = path.join(process.cwd(), "out_batch", "众神之战");
const DEFAULT_TEXT_DUMP = path.join(process.cwd(), "out_godwar_text", "xse_text.txt");
const DEFAULT_OUT = path.join(process.cwd(), "out_godwar_storytrace");

const TERM_GROUPS = [
  {
    id: "light",
    label: "Light line",
    textTerms: ["光明", "巴尔德"],
    nameTerms: ["guangming", "guangmin", "guangmingshen", "guangmingshendian", "tx_guangmin"],
  },
  {
    id: "dark",
    label: "Dark line",
    textTerms: ["黑暗", "霍德尔"],
    nameTerms: ["heian", "heianshen", "heianshendian", "tx_heian"],
  },
  {
    id: "story",
    label: "Story names",
    textTerms: ["奥丁", "洛基", "赫尔", "南娜", "孪生", "兄弟", "冥界", "神殿"],
    nameTerms: ["aoding", "luoji", "nanna", "mingwangdian", "youan", "zhongli"],
  },
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

async function loadManifest(gameRoot) {
  const manifest = JSON.parse(await fsp.readFile(path.join(gameRoot, "manifest.json"), "utf8"));
  return manifest.files
    .filter((file) => file.output && !file.skipped)
    .map((file) => ({
      name: file.name,
      cleanName: cleanName(file.name),
      rel: relFrom(gameRoot, file.output),
      ext: extOf(file.name),
      size: file.writtenSize || file.rawSize || file.size || 0,
    }));
}

async function loadTextDump(file) {
  const text = await fsp.readFile(file, "utf8");
  const lines = text.split(/\r?\n/);
  const sections = [];
  let current = null;
  for (const line of lines) {
    const section = /^##\s+(.+)$/.exec(line);
    if (section) {
      current = { rel: section[1], lines: [] };
      sections.push(current);
      continue;
    }
    const hit = /^(0x[0-9A-Fa-f]+)\s+(.+)$/.exec(line);
    if (hit && current) {
      current.lines.push({ offset: hit[1], text: hit[2] });
    }
  }
  return sections;
}

function includesAny(value, terms) {
  const lower = String(value || "").toLowerCase();
  return terms.some((term) => lower.includes(term.toLowerCase()));
}

function groupForResource(entry) {
  return TERM_GROUPS.filter((group) => includesAny(entry.cleanName, group.nameTerms));
}

function groupForText(text) {
  return TERM_GROUPS.filter((group) => includesAny(text, group.textTerms));
}

function countTerms(values, terms) {
  const counts = Object.fromEntries(terms.map((term) => [term, 0]));
  for (const value of values) {
    for (const term of terms) {
      const matches = String(value || "").match(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"));
      if (matches) counts[term] += matches.length;
    }
  }
  return counts;
}

function summarizeResources(entries) {
  const buckets = Object.fromEntries(TERM_GROUPS.map((group) => [group.id, []]));
  for (const entry of entries) {
    for (const group of groupForResource(entry)) {
      buckets[group.id].push(entry);
    }
  }
  return buckets;
}

function summarizeText(sections) {
  const hits = Object.fromEntries(TERM_GROUPS.map((group) => [group.id, []]));
  const allText = [];
  for (const section of sections) {
    for (const line of section.lines) {
      allText.push(line.text);
      for (const group of groupForText(line.text)) {
        hits[group.id].push({ rel: section.rel, offset: line.offset, text: line.text });
      }
    }
  }
  return {
    hits,
    counts: Object.fromEntries(TERM_GROUPS.map((group) => [
      group.id,
      countTerms(allText, group.textTerms),
    ])),
  };
}

function top(entries, n = 24) {
  return entries.slice(0, n);
}

function mdList(items, render) {
  if (!items.length) return "- none\n";
  return items.map((item) => `- ${render(item)}`).join("\n") + "\n";
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# God War Story Trace");
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push("");
  lines.push("## Current Position");
  lines.push("");
  lines.push("- Emulator work is paused.");
  lines.push("- `heermode`, `heer`, `guangmingshen`, and `heianshen` are actor/resource names, not proven playable roles.");
  lines.push("- User memory says the game has two protagonists: one light and one dark. Treat this as a guiding correction until script evidence proves the exact mapping.");
  lines.push("");
  lines.push("## Text Term Counts");
  lines.push("");
  for (const group of TERM_GROUPS) {
    const counts = report.text.counts[group.id];
    lines.push(`### ${group.label}`);
    lines.push("");
    lines.push(mdList(Object.entries(counts), ([term, count]) => `${term}: ${count}`));
  }
  lines.push("## Resource Evidence");
  lines.push("");
  for (const group of TERM_GROUPS) {
    lines.push(`### ${group.label}`);
    lines.push("");
    lines.push(mdList(top(report.resources[group.id]), (entry) => `${entry.rel} (${entry.ext}, ${entry.size} bytes)`));
  }
  lines.push("## Script Text Evidence");
  lines.push("");
  for (const group of TERM_GROUPS) {
    lines.push(`### ${group.label}`);
    lines.push("");
    lines.push(mdList(top(report.text.hits[group.id], 40), (hit) => `${hit.rel} ${hit.offset}: ${hit.text}`));
  }
  lines.push("## Working Hypotheses");
  lines.push("");
  lines.push("- `巴尔德` is strongly tied to the light side because the text dump includes `光明神巴尔德`.");
  lines.push("- `霍德尔` is strongly tied to the dark side because the text dump includes `黑暗神霍德尔`.");
  lines.push("- `heer/heermode` appears in both light/dark temple scene placement evidence, so it should not be treated as the sole protagonist without more script context.");
  lines.push("- The pair of portrait resources `tx_guangmin.gif` and `tx_heian.gif`, plus skill panels `jineng_guangming.gif` and `jineng_heian.gif`, are important UI evidence for the dual-protagonist or dual-form structure.");
  lines.push("");
  lines.push("## Next Analysis Targets");
  lines.push("");
  lines.push("- Reconstruct which `.xse` scripts transition between `guangmingshendian.sce`, `heianshendian.sce`, and `zhongli.sce`.");
  lines.push("- Compare `heer.actor`, `heermode.actor`, `guangmingshen.actor`, and `heianshen.actor` as separate role candidates.");
  lines.push("- Decode menu/portrait selection assets before assigning input control to any actor.");
  return lines.join("\n");
}

async function main() {
  const gameRoot = path.resolve(process.argv[2] || DEFAULT_GAME_ROOT);
  const textDump = path.resolve(process.argv[3] || DEFAULT_TEXT_DUMP);
  const outDir = path.resolve(process.argv[4] || DEFAULT_OUT);
  const entries = await loadManifest(gameRoot);
  const sections = fs.existsSync(textDump) ? await loadTextDump(textDump) : [];
  const report = {
    schema: "nicai.cbe.storyTrace.v1",
    generatedAt: new Date().toISOString(),
    gameRoot,
    textDump,
    resources: summarizeResources(entries),
    scenes: entries.filter((entry) => entry.ext === ".sce"),
    actors: entries.filter((entry) => entry.ext === ".actor"),
    text: summarizeText(sections),
  };
  await fsp.mkdir(outDir, { recursive: true });
  await fsp.writeFile(path.join(outDir, "story_trace.json"), JSON.stringify(report, null, 2), "utf8");
  await fsp.writeFile(path.join(outDir, "story_trace.md"), renderMarkdown(report), "utf8");
  console.log(`Output: ${path.join(outDir, "story_trace.md")}`);
  console.log(`Light text hits: ${report.text.hits.light.length}`);
  console.log(`Dark text hits: ${report.text.hits.dark.length}`);
  console.log(`Light resources: ${report.resources.light.length}`);
  console.log(`Dark resources: ${report.resources.dark.length}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.stack || err.message || String(err));
    process.exitCode = 1;
  });
}
