const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { scanTextRuns } = require("./cbe_struct");

const DEFAULT_INPUT = path.resolve(__dirname, "..", "cbe file", "众神之战.CBE");
const DEFAULT_MANIFEST = path.join(process.cwd(), "out_batch", "众神之战", "manifest.json");
const DEFAULT_OUT = path.join(process.cwd(), "out_godwar_bootdata");

const FOCUS_GROUPS = [
  {
    id: "loading_tips",
    title: "Loading tip strings",
    terms: ["连击", "攻击按键", "技能", "魔法消耗", "大关", "保存游戏进度"],
  },
  {
    id: "title_save_menu",
    title: "Title/save/menu strings",
    terms: ["重新开始游戏", "没有游戏存档", "新的游戏", "保存进度", "是否退出"],
  },
  {
    id: "opening_narration",
    title: "Opening narration strings",
    terms: ["光明神巴尔德", "黑暗神霍德尔", "诸神之王奥丁", "孪生子", "神之间的战争", "黑暗神剧情篇章"],
  },
  {
    id: "dual_protagonist_manual",
    title: "Dual-protagonist/manual strings",
    terms: ["操作说明", "光明神和黑暗神两个主角", "剧情各不相同", "任务承前启后"],
  },
  {
    id: "unresolved_caption_strings",
    title: "User-observed pre-title caption search",
    terms: ["在此天地交接之处", "无尽遥远的彼方", "战争不断的持续", "这属于神之间的战斗", "即将开始", "跳过", "读取进度"],
  },
];

function hex(n, width = 0) {
  return `0x${n.toString(16).toUpperCase().padStart(width, "0")}`;
}

function parseHex(text) {
  if (typeof text === "number") return text;
  const s = String(text || "").trim();
  return s.toLowerCase().startsWith("0x") ? Number.parseInt(s.slice(2), 16) : Number.parseInt(s, 10);
}

function loadFirstResourceOffset(manifestPath) {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const offsets = [];
    for (const section of manifest.sections || []) {
      if (section.offset) offsets.push(parseHex(section.offset));
    }
    for (const file of manifest.files || []) {
      if (file.offset) offsets.push(parseHex(file.offset));
    }
    return offsets.length ? Math.min(...offsets) : null;
  } catch {
    return null;
  }
}

function hitGroups(runs, groups) {
  return groups.map((group) => {
    const hits = [];
    const seen = new Set();
    for (const run of runs) {
      const matched = group.terms.filter((term) => run.text.includes(term));
      if (!matched.length) continue;
      const key = `${run.offset}:${run.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({
        offset: hex(run.offset, 6),
        length: run.length,
        matched,
        text: run.text,
      });
    }
    return { ...group, hits };
  });
}

function nearbyRuns(runs, offset, radius = 0x90) {
  return runs
    .filter((run) => Math.abs(run.offset - offset) <= radius)
    .map((run) => ({
      offset: hex(run.offset, 6),
      length: run.length,
      text: run.text,
    }));
}

function buildRegions(groups, runs) {
  const interestingOffsets = new Set();
  for (const group of groups) {
    for (const hit of group.hits) {
      if (group.id === "unresolved_caption_strings") continue;
      interestingOffsets.add(parseHex(hit.offset));
    }
  }
  return Array.from(interestingOffsets)
    .sort((a, b) => a - b)
    .map((offset) => ({
      anchor: hex(offset, 6),
      nearby: nearbyRuns(runs, offset),
    }));
}

function renderHits(group) {
  if (!group.hits.length) return "- none\n";
  return group.hits
    .map((hit) => `- ${hit.offset} [${hit.matched.join(", ")}]: ${hit.text}`)
    .join("\n") + "\n";
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# God War Boot Data Trace");
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Input: ${report.input}`);
  lines.push(`Pre-resource scan range: 0x000000..${hex(report.preResourceEnd, 6)} (${report.preResourceEnd} bytes)`);
  lines.push("");
  lines.push("## Why This Exists");
  lines.push("");
  lines.push("The boot/loading/title and long manual strings live before the unpacked resource sections in the raw CBE file. They are not normal extracted `.xse` resources, so the XSE-only text reports missed them.");
  lines.push("");
  lines.push("## Focus Hits");
  for (const group of report.groups) {
    lines.push("");
    lines.push(`### ${group.title}`);
    lines.push("");
    lines.push(renderHits(group));
  }
  lines.push("");
  lines.push("## Important Regions");
  lines.push("");
  for (const region of report.regions.slice(0, 24)) {
    lines.push(`### Around ${region.anchor}`);
    lines.push("");
    for (const run of region.nearby) {
      lines.push(`- ${run.offset}: ${run.text}`);
    }
    lines.push("");
  }
  lines.push("## Current Conclusions");
  lines.push("");
  lines.push("- The exact user-observed combo tip exists in raw CBE boot data at `0x0359CE`; it was missed because it is not inside the extracted `.xse` resources.");
  lines.push("- The opening narration beginning `光明神巴尔德和黑暗神霍德尔...` exists in raw CBE boot data at `0x037FC2`.");
  lines.push("- The raw manual explicitly says the game has `光明神和黑暗神两个主角`, with different story routes and connected tasks. This directly supports pausing player-control/emulator assumptions until route logic is decoded.");
  lines.push("- The specific pre-title caption strings and `读取进度` still do not appear as raw text hits in this scan; they may be image-rendered, compressed, or encoded through another table.");
  return lines.join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  const input = path.resolve(args[0] || DEFAULT_INPUT);
  const outDir = path.resolve(args[1] || DEFAULT_OUT);
  const manifest = args[2] ? path.resolve(args[2]) : DEFAULT_MANIFEST;
  const data = fs.readFileSync(input);
  const firstResourceOffset = loadFirstResourceOffset(manifest) || data.indexOf(Buffer.from([0xfe, 0xfe, 0xfe, 0xfe, 0xfe, 0xfe, 0xfe, 0xfe]));
  const preResourceEnd = firstResourceOffset > 0 ? firstResourceOffset : data.length;
  const preResource = data.subarray(0, preResourceEnd);
  const runs = scanTextRuns(preResource, 4, 4000);
  const groups = hitGroups(runs, FOCUS_GROUPS);
  const report = {
    input,
    generatedAt: new Date().toISOString(),
    preResourceEnd,
    totalTextRuns: runs.length,
    groups,
    regions: buildRegions(groups, runs),
  };

  fs.mkdirSync(outDir, { recursive: true });
  await fsp.writeFile(path.join(outDir, "boot_data_trace.json"), JSON.stringify(report, null, 2), "utf8");
  await fsp.writeFile(path.join(outDir, "boot_data_trace.md"), renderMarkdown(report), "utf8");

  console.log(`Input: ${input}`);
  console.log(`Output: ${outDir}`);
  console.log(`Pre-resource end: ${hex(preResourceEnd, 6)}`);
  console.log(`Text runs: ${runs.length}`);
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
