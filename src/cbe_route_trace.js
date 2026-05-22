const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const DEFAULT_TEXT_DUMP = path.join(process.cwd(), "out_godwar_text", "xse_text.txt");
const DEFAULT_OUT = path.join(process.cwd(), "out_godwar_routes");

const ROUTES = [
  {
    id: "common_opening",
    title: "Common Opening / Selection Setup",
    scripts: ["s_01.xse", "s_02.xse", "s_03.xse", "s_04.xse"],
    terms: ["巴尔德", "霍德尔", "奥丁", "南娜", "洛基", "兄弟", "神界", "人界", "圣灵村", "zhongli.sce"],
  },
  {
    id: "light_route",
    title: "Light Route (gm_*)",
    scripts: ["gm_dialog.xse", "gm_maintask.xse", "gm_taskpro.xse", "gm_monster.xse"],
    terms: ["巴尔德", "光明", "南娜", "奥丁", "霍德尔", "赫尔", "洛基", "光明神殿", "冥界", "死亡之国"],
  },
  {
    id: "dark_route",
    title: "Dark Route (ha_*)",
    scripts: ["ha_dialog.xse", "ha_maintask.xse", "ha_taskpro.xse", "ha_monster.xse"],
    terms: ["霍德尔", "黑暗", "巴尔德", "赫尔", "洛基", "光明神之死", "背叛奥丁", "冥界", "黑暗神殿"],
  },
  {
    id: "shared_dialog",
    title: "Shared Boss / NPC Tables",
    scripts: ["boss_dialog.xse", "npc.xse"],
    terms: ["巴尔德", "霍德尔", "赫尔", "南娜", "洛基", "芙莉嘉", "赫尔莫德", "伐利"],
  },
];

const SKIP_LINES = new Set([
  "对白编号",
  "任务名称",
  "等级要求",
  "所在关卡",
  "获得经验",
  "关联任务",
  "占地空间",
  "防御力",
  "活动范围",
  "移动速度",
  "携带经验",
  "掉落物品概",
  "闪避率2",
]);

const TASK_TITLE_HINTS = {
  "gm_maintask.xse": [
    "杀死狼群",
    "噩梦惊魂",
    "心灵神药",
    "万物灵符",
    "寻找普拉神咒",
    "伐拉的预言",
    "抢夺器具",
    "救治南娜",
    "真假灵符1",
    "火神传说",
    "寻找机关",
    "破解魔咒",
    "终极命运",
  ],
  "gm_taskpro.xse": [
    "杀死狼群",
    "心灵神药",
    "万物灵符",
    "普拉神咒",
    "玲珑之火",
    "八角银器",
    "开启魔法机关",
    "九转龙潭剂",
  ],
  "ha_maintask.xse": [
    "杀死狼群",
    "勾结冥王",
    "将计就计",
    "天魔神符",
    "离间洛基",
    "找到死亡灵符",
    "光明神之死",
    "控制冥界",
    "背叛奥丁",
    "封印瓦宫",
    "威胁",
  ],
  "ha_taskpro.xse": [
    "杀死狼群",
    "天魔神符",
    "死亡灵",
    "破解魔法机关",
    "普拉神咒",
  ],
};

function cleanName(rel) {
  return path.basename(String(rel || "")).replace(/^[0-9]{4}_/, "");
}

async function loadTextDump(file) {
  const text = await fsp.readFile(file, "utf8");
  const sections = [];
  let current = null;
  let lastLine = null;
  for (const line of text.split(/\r?\n/)) {
    const section = /^##\s+(.+)$/.exec(line);
    if (section) {
      current = { rel: section[1], cleanName: cleanName(section[1]), lines: [] };
      sections.push(current);
      lastLine = null;
      continue;
    }
    const hit = /^(0x[0-9A-Fa-f]+)\s+(.+)$/.exec(line);
    if (hit && current) {
      lastLine = { offset: hit[1], text: hit[2] };
      current.lines.push(lastLine);
      continue;
    }
    const continuationChinese = (line.match(/[\u3400-\u4dbf\u4e00-\u9fff]/gu) || []).length;
    if (current && lastLine && line.trim() && !/^size=/.test(line) && continuationChinese >= 2) {
      lastLine.text += `\n${line.trim()}`;
    }
  }
  return sections;
}

function sectionByCleanName(sections, wanted) {
  const target = wanted.toLowerCase();
  return sections.find((section) => section.cleanName.toLowerCase() === target) || null;
}

function hasTerm(text, terms) {
  return terms.some((term) => String(text || "").includes(term));
}

function isUsefulLine(line) {
  const text = String(line.text || "").trim();
  if (!text || SKIP_LINES.has(text)) return false;
  if (/^[0-9]+$/.test(text)) return false;
  if (/^[A-Za-z0-9_./-]+\.(?:actor|sce|xse|gif|map)$/.test(text)) return true;
  const chinese = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff]/gu) || []).length;
  return chinese >= 2 || text.includes("[") || text.includes("]");
}

function isTaskScript(section) {
  return /(?:maintask|taskpro)\.xse$/i.test(section.cleanName);
}

function normalizeTaskText(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .replace(/^\s*\d+\s*\n\s*/, "")
    .replace(/\s+/g, "")
    .replace(/^[&:>,<]+/, "")
    .replace(/[;,，。？！：]+$/g, "")
    .trim();
}

function taskCandidate(line) {
  const text = normalizeTaskText(line.text);
  const chinese = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff]/gu) || []).length;
  if (SKIP_LINES.has(text) || chinese < 2) return false;
  if (text.includes("[") || text.includes("]") || /[%\\"]/.test(text)) return false;
  if (/等级要求|商城购买|通关成功|返回|途径/.test(text)) return false;
  if (text.length > 18) return false;
  if (/[。？！：，,]/.test(text)) return false;
  return true;
}

function titleHintSet(section) {
  const hints = TASK_TITLE_HINTS[section.cleanName.toLowerCase()] || [];
  return new Set(hints.map(normalizeTaskText));
}

function summarizeSection(section, route) {
  if (!section) return null;
  const useful = section.lines.filter(isUsefulLine);
  const termHits = useful.filter((line) => hasTerm(line.text, route.terms));
  const hints = titleHintSet(section);
  const taskLines = isTaskScript(section)
    ? useful
      .map((line) => ({ ...line, displayText: normalizeTaskText(line.text) }))
      .filter((line) => hints.has(line.displayText) || (!hints.size && taskCandidate(line)))
    : [];
  return {
    rel: section.rel,
    cleanName: section.cleanName,
    lineCount: section.lines.length,
    usefulLines: useful,
    termHits,
    taskCandidates: taskLines,
  };
}

function summarizeRoute(sections, route) {
  const scriptSummaries = route.scripts
    .map((script) => summarizeSection(sectionByCleanName(sections, script), route))
    .filter(Boolean);
  return {
    id: route.id,
    title: route.title,
    terms: route.terms,
    scripts: scriptSummaries,
    keyHits: scriptSummaries.flatMap((script) => script.termHits.map((line) => ({
      rel: script.rel,
      offset: line.offset,
      text: line.text,
    }))),
    taskCandidates: scriptSummaries.flatMap((script) => script.taskCandidates.map((line) => ({
      rel: script.rel,
      offset: line.offset,
      text: line.text,
      displayText: line.displayText,
    }))),
  };
}

function mdList(items, render) {
  if (!items.length) return "- none\n";
  return items.map((item) => `- ${render(item)}`).join("\n") + "\n";
}

function renderText(text) {
  return String(text || "").replace(/\s*\n\s*/g, " / ").trim();
}

function renderLine(line) {
  return `${line.offset}: ${renderText(line.text)}`;
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# God War Route Trace");
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push("");
  lines.push("## Reading Notes");
  lines.push("");
  lines.push("- This report reconstructs story/quest route evidence from recovered XSE text, not from a completed VM decompiler.");
  lines.push("- `gm_*` and `ha_*` file prefixes are treated as strong route buckets because their dialogue and task text repeatedly name the light and dark protagonists.");
  lines.push("- Garbled partial lines are left out of task candidates but may still appear in source text dumps for byte-level follow-up.");
  lines.push("");
  lines.push("## Route Conclusions");
  lines.push("");
  lines.push("- Common opening scripts `s_02.xse` and `s_03.xse` contain the pre-selection bridge: 南娜/巴尔德, `zhongli.sce`, 奥丁, the brothers, and `让我去吧！`.");
  lines.push("- The light route is anchored by `gm_dialog.xse` and `gm_maintask.xse`: 巴尔德, 南娜, 奥丁, prophecy about 霍德尔, and tasks returning to 光明神殿.");
  lines.push("- The dark route is anchored by `ha_dialog.xse` and `ha_maintask.xse`: 霍德尔, 赫尔, killing 巴尔德, `光明神之死`, and later conflict with 奥丁/神界.");
  lines.push("- These are story-route anchors only. Input control, battle state, and exact branch predicates still need XSE VM reference decoding.");
  for (const route of report.routes) {
    lines.push("");
    lines.push(`## ${route.title}`);
    lines.push("");
    lines.push("### Scripts");
    lines.push("");
    lines.push(mdList(route.scripts, (script) => `${script.cleanName}: ${script.lineCount} text runs, ${script.termHits.length} route-term hits, ${script.taskCandidates.length} task/title candidates`));
    lines.push("### Recovered Task Titles / Tokens");
    lines.push("");
    lines.push(mdList(route.taskCandidates.slice(0, 60), (hit) => `${hit.rel} ${hit.offset}: ${renderText(hit.displayText || hit.text)}`));
    lines.push("### Key Text Hits");
    lines.push("");
    lines.push(mdList(route.keyHits.slice(0, 80), (hit) => `${hit.rel} ${hit.offset}: ${renderText(hit.text)}`));
  }
  return lines.join("\n");
}

async function main() {
  const textDump = path.resolve(process.argv[2] || DEFAULT_TEXT_DUMP);
  const outDir = path.resolve(process.argv[3] || DEFAULT_OUT);
  const sections = await loadTextDump(textDump);
  const report = {
    schema: "nicai.cbe.routeTrace.v1",
    generatedAt: new Date().toISOString(),
    textDump,
    routes: ROUTES.map((route) => summarizeRoute(sections, route)),
  };
  await fsp.mkdir(outDir, { recursive: true });
  await fsp.writeFile(path.join(outDir, "route_trace.json"), JSON.stringify(report, null, 2), "utf8");
  await fsp.writeFile(path.join(outDir, "route_trace.md"), renderMarkdown(report), "utf8");
  console.log(`Output: ${outDir}`);
  for (const route of report.routes) {
    console.log(`${route.id}: hits=${route.keyHits.length} tasks=${route.taskCandidates.length}`);
  }
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
