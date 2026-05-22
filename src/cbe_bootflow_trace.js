const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { parseGifInfo, scanTextRuns } = require("./cbe_struct");

const DEFAULT_GAME_ROOT = path.join(process.cwd(), "out_batch", "众神之战");
const DEFAULT_OUT = path.join(process.cwd(), "out_godwar_bootflow");

const FLOW_STEPS = [
  {
    id: "cold_loading_tip",
    title: "Cold start loading tip",
    observed: "First screen shows a random-looking gameplay tip plus a progress bar. Example: 可通过连续点击攻击按键产生连击的动作，连续伤害到敌人可累计连击次数",
    resourceTerms: ["loading", "lianji", "anjian", "xitongziti", "wenzikuang", "jindutiao"],
    textTerms: ["可通过", "连续", "连击", "攻击按键", "进度"],
  },
  {
    id: "pre_title_intro_dark",
    title: "Pre-title intro, dark protagonist",
    observed: "Animated image: sky burning, dark protagonist swings sword, then dark-side skill animation.",
    resourceTerms: ["kaichang", "heian", "heianshen", "heianshenjineng", "heianjitexiao", "jineng_heian", "dao", "huo", "zhanhun"],
    textTerms: ["黑暗", "霍德尔"],
  },
  {
    id: "pre_title_intro_light",
    title: "Pre-title intro, light protagonist",
    observed: "Animated image: land/storm, light protagonist attacks, then light-side skill animation.",
    resourceTerms: ["kaichang", "guangming", "guangmin", "guangmingshen", "daoguang_guangmin", "dao_guangmin", "jineng_guangming", "zhongliqu"],
    textTerms: ["光明", "巴尔德"],
  },
  {
    id: "pre_title_caption_cards",
    title: "Pre-title caption cards",
    observed: "Captions include: 在此天地交接之处，无尽遥远的彼方; 战争不断的持续，这属于神之间的战斗; 即将开始.",
    resourceTerms: ["kaichang", "ziti", "zi", "xiaozi", "xitongziti", "wenzikuang"],
    textTerms: ["天地", "彼方", "战争", "神之间", "即将", "开始"],
  },
  {
    id: "title_menu",
    title: "Title/menu",
    observed: "Title background is the cover image with falling snow, then menu button images such as 新的游戏 / 读取进度.",
    resourceTerms: ["fengmian", "zhucaidan", "caidan", "chucun", "zi", "ziti"],
    textTerms: ["新的游戏", "读取进度", "保存", "游戏进度"],
  },
  {
    id: "new_game_loading",
    title: "New game loading",
    observed: "After choosing new game/load, the loading screen with tip text and progress bar appears again.",
    resourceTerms: ["loading", "lianji", "anjian", "xitongziti", "wenzikuang"],
    textTerms: ["进度", "连击", "攻击"],
  },
  {
    id: "opening_story_text",
    title: "Opening story narration",
    observed: "Narration begins with 光明神巴尔德和黑暗神霍德尔是诸神之王奥丁...; skip button appears at lower right.",
    resourceTerms: ["tiaoguo", "queding", "xitongziti", "wenzikuang"],
    textTerms: ["光明神", "巴尔德", "黑暗神", "霍德尔", "奥丁", "茉莉", "孪生"],
  },
  {
    id: "opening_scene_order",
    title: "Opening scene/map order",
    observed: "Opening visuals use zhongliqu_2.gif then zhongliqu_1.gif, followed by dialogue and animation.",
    resourceTerms: ["zhongliqu_2", "zhongliqu_1", "zhongli", "guangmingshendian", "heianshendian"],
    textTerms: ["zhongli.sce", "光明神殿", "黑暗神殿"],
  },
  {
    id: "protagonist_choice",
    title: "Protagonist choice",
    observed: "Player later chooses between light and dark protagonists.",
    resourceTerms: ["xuanzetouxiang", "tx_guangmin", "tx_heian", "touxiang", "jineng_guangming", "jineng_heian", "guangmingshen", "heianshen"],
    textTerms: ["选择", "光明", "黑暗", "巴尔德", "霍德尔"],
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

function safeRead(file) {
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

function resourceNameHit(entry, terms) {
  const haystack = `${entry.cleanName} ${entry.rel}`.toLowerCase();
  return terms.some((term) => haystack.includes(term.toLowerCase()));
}

function resourceCandidates(catalog, terms, limit = 32) {
  return catalog
    .filter((entry) => resourceNameHit(entry, terms))
    .map((entry) => ({
      ...entry,
      imageInfo: entry.ext === ".gif" ? parseGifInfo(entry.output) : null,
    }))
    .sort((a, b) => {
      const ai = a.ext === ".gif" ? 0 : a.ext === ".sce" ? 1 : a.ext === ".actor" ? 2 : 3;
      const bi = b.ext === ".gif" ? 0 : b.ext === ".sce" ? 1 : b.ext === ".actor" ? 2 : 3;
      return ai - bi || a.rel.localeCompare(b.rel);
    })
    .slice(0, limit);
}

function textHits(catalog, terms, limit = 80) {
  const exts = new Set([".xse", ".sce", ".map", ".actor", ".dat", ".sav"]);
  const hits = [];
  for (const entry of catalog) {
    if (!exts.has(entry.ext)) continue;
    const buf = safeRead(entry.output);
    if (!buf) continue;
    const runs = scanTextRuns(buf, 3, 500);
    for (const run of runs) {
      const matched = terms.filter((term) => run.text.includes(term));
      if (!matched.length) continue;
      hits.push({
        rel: entry.rel,
        offset: `0x${run.offset.toString(16).toUpperCase().padStart(4, "0")}`,
        matched,
        text: run.text,
      });
      if (hits.length >= limit) return hits;
    }
  }
  return hits;
}

function refHits(catalog) {
  const refs = [];
  const regex = /[A-Za-z0-9_./-]+\.(?:sce|xse|map|actor|gif)/ig;
  for (const entry of catalog.filter((item) => item.ext === ".xse" || item.ext === ".sce")) {
    const buf = safeRead(entry.output);
    if (!buf) continue;
    const text = buf.toString("latin1");
    let match;
    while ((match = regex.exec(text)) !== null) {
      refs.push({
        rel: entry.rel,
        offset: `0x${match.index.toString(16).toUpperCase().padStart(4, "0")}`,
        ref: match[0],
      });
    }
  }
  return refs;
}

function exactResources(catalog) {
  const wanted = [
    "LOADING.gif",
    "fengmian.gif",
    "zhucaidan1.gif",
    "zhongliqu_2.gif",
    "zhongliqu_1.gif",
    "xuanzetouxiang.gif",
    "tx_guangmin.gif",
    "tx_heian.gif",
    "jineng_guangming.gif",
    "jineng_heian.gif",
    "guangmingshen.actor",
    "heianshen.actor",
    "kaichang.sce",
    "guangmingshendian.sce",
    "heianshendian.sce",
    "zhongli.sce",
    "gm_dialog.xse",
    "ha_dialog.xse",
    "gm_maintask.xse",
    "ha_maintask.xse",
    "s_01.xse",
    "s_02.xse",
    "s_03.xse",
    "s_04.xse",
  ];
  return wanted.map((name) => {
    const entry = catalog.find((item) => item.cleanName.toLowerCase() === name.toLowerCase());
    if (!entry) return { name, missing: true };
    return {
      name,
      rel: entry.rel,
      ext: entry.ext,
      size: entry.size,
      imageInfo: entry.ext === ".gif" ? parseGifInfo(entry.output) : null,
    };
  });
}

function renderResource(item) {
  const info = item.imageInfo ? ` ${item.imageInfo.width}x${item.imageInfo.height} frames=${item.imageInfo.frames}` : "";
  return `${item.rel || item.name}${item.missing ? " (missing)" : ` (${item.ext}, ${item.size} bytes${info})`}`;
}

function mdList(items, render) {
  if (!items.length) return "- none\n";
  return items.map((item) => `- ${render(item)}`).join("\n") + "\n";
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# God War Boot Flow Trace");
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push("");
  lines.push("## Ground Truth From Device/Video");
  lines.push("");
  lines.push("- Cold start shows a random gameplay tip and a progress bar.");
  lines.push("- A skippable pre-title animation alternates dark-side and light-side imagery, skill animations, and caption cards.");
  lines.push("- The cover/title screen appears after that, with falling snow and image-rendered menu buttons.");
  lines.push("- New/load enters another loading tip screen, then opening narration and intro scenes.");
  lines.push("- The player later chooses between light and dark protagonists.");
  lines.push("");
  lines.push("## Exact Resource Anchors");
  lines.push("");
  lines.push(mdList(report.exactResources, renderResource));
  lines.push("## Flow Nodes");
  for (const step of report.steps) {
    lines.push("");
    lines.push(`### ${step.title}`);
    lines.push("");
    lines.push(`Observed: ${step.observed}`);
    lines.push("");
    lines.push("Resource candidates:");
    lines.push(mdList(step.resources.slice(0, 18), renderResource));
    lines.push("Text hits:");
    lines.push(mdList(step.textHits.slice(0, 18), (hit) => `${hit.rel} ${hit.offset} [${hit.matched.join(", ")}]: ${hit.text}`));
  }
  lines.push("");
  lines.push("## Script/Scene References");
  lines.push("");
  lines.push(mdList(report.refs.slice(0, 120), (hit) => `${hit.rel} ${hit.offset}: ${hit.ref}`));
  lines.push("## Current Conclusions");
  lines.push("");
  lines.push("- The exact cold-start tip sentence was not found in extracted `.xse` text, but `cbe_bootdata_trace.js` now finds it in the raw pre-resource CBE boot data at `0x0359CE`.");
  lines.push("- The specific pre-title caption strings and `读取进度` are still unresolved in text scans; they may be image-rendered, compressed, or encoded through a table the current scanners do not decode.");
  lines.push("- `LOADING.gif`, `fengmian.gif`, `zhucaidan1.gif`, `kaichang.sce`, `zhongliqu_2.gif`, `zhongliqu_1.gif`, `xuanzetouxiang.gif`, `tx_guangmin.gif`, and `tx_heian.gif` are direct resource anchors or strong containers for the user-described flow.");
  lines.push("- `s_02.xse` references `zhongli.sce`; `zhongli.sce` links `s_03.xse`; structural summaries also connect `zhongli` back toward the light/dark temple scenes. These scripts are the next decompile targets for the opening route and protagonist choice.");
  lines.push("- Emulator implementation remains paused until this boot and story graph is reconstructed.");
  return lines.join("\n");
}

async function main() {
  const gameRoot = path.resolve(process.argv[2] || DEFAULT_GAME_ROOT);
  const outDir = path.resolve(process.argv[3] || DEFAULT_OUT);
  const catalog = loadCatalog(gameRoot);
  const report = {
    schema: "nicai.cbe.bootFlowTrace.v1",
    generatedAt: new Date().toISOString(),
    gameRoot,
    exactResources: exactResources(catalog),
    steps: FLOW_STEPS.map((step) => ({
      ...step,
      resources: resourceCandidates(catalog, step.resourceTerms),
      textHits: textHits(catalog, step.textTerms),
    })),
    refs: refHits(catalog),
  };
  await fsp.mkdir(outDir, { recursive: true });
  await fsp.writeFile(path.join(outDir, "boot_flow_trace.json"), JSON.stringify(report, null, 2), "utf8");
  await fsp.writeFile(path.join(outDir, "boot_flow_trace.md"), renderMarkdown(report), "utf8");
  console.log(`Output: ${path.join(outDir, "boot_flow_trace.md")}`);
  console.log(`Flow nodes: ${report.steps.length}`);
  console.log(`Refs: ${report.refs.length}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.stack || err.message || String(err));
    process.exitCode = 1;
  });
}
