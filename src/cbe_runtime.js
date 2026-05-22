const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { analyzeMapBuffer, analyzeMapFile } = require("./cbe_maptrace");
const { parseGifInfo, parseGifInfoBuffer, summarizeBuffer, summarizeFile } = require("./cbe_struct");

const DEFAULT_SCENE = path.resolve(process.cwd(), "out_godwar", "section_1_39BCD", "0312_guangmingshendian.sce");
const DEFAULT_OUT = path.resolve(process.cwd(), "out_godwar_runtime");
const DEFAULT_SCREEN = { width: 240, height: 400 };
const DEFAULT_XSE_OBJECT_JSON = path.join(process.cwd(), "out_godwar_xseobject", "xse_object_trace.json");
const DEFAULT_XSE_SKELETON_JSON = path.join(process.cwd(), "out_godwar_xseskel", "xse_skeleton.json");
const DEFAULT_XSE_REF_JSON = path.join(process.cwd(), "out_godwar_xseref", "xse_ref_correlation.json");
const DEFAULT_ROUTE_JSON = path.join(process.cwd(), "out_godwar_routes", "route_trace.json");
const DEFAULT_XSE_FLOW_JSON = path.join(process.cwd(), "out_godwar_xseflow", "xse_flow_trace.json");
const DEFAULT_BOOT_FLOW_JSON = path.join(process.cwd(), "out_godwar_bootflow", "boot_flow_trace.json");
const DEFAULT_BOOT_DATA_JSON = path.join(process.cwd(), "out_godwar_bootdata", "boot_data_trace.json");

function cleanName(name) {
  return String(name || "").replace(/^[0-9]{4}_/, "");
}

function stripIndexPrefix(name) {
  return cleanName(path.basename(name || ""));
}

function relFrom(base, file) {
  return path.relative(base, file).split(path.sep).join("/");
}

function resolveManifestOutput(root, output) {
  const literal = path.resolve(output);
  const normalized = String(output || "").replace(/\\/g, "/");
  const escapedRootName = path.basename(root).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const markers = [
    new RegExp(`/${escapedRootName}/`, "i"),
    /\/out_batch\/[^/]+\//i,
  ];
  for (const marker of markers) {
    const match = normalized.match(marker);
    if (!match) continue;
    const suffix = normalized.slice(match.index + match[0].length).split("/");
    const candidate = path.join(root, ...suffix);
    if (fs.existsSync(candidate)) return candidate;
  }
  return literal;
}

function walk(input) {
  const stat = fs.statSync(input);
  if (stat.isFile()) return [input];
  const out = [];
  for (const name of fs.readdirSync(input)) {
    const file = path.join(input, name);
    const child = fs.statSync(file);
    if (child.isDirectory()) out.push(...walk(file));
    else out.push(file);
  }
  return out;
}

function findRoot(fileOrDir) {
  let dir = fs.statSync(fileOrDir).isDirectory() ? path.resolve(fileOrDir) : path.dirname(path.resolve(fileOrDir));
  while (dir && dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "manifest.json"))) return dir;
    dir = path.dirname(dir);
  }
  return fs.statSync(fileOrDir).isDirectory() ? path.resolve(fileOrDir) : path.dirname(path.resolve(fileOrDir));
}

function loadCatalog(root) {
  const manifestPath = path.join(root, "manifest.json");
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return manifest.files
      .filter((file) => file.name && file.output && !file.skipped)
      .map((file) => {
        const output = resolveManifestOutput(root, file.output);
        return {
          name: file.name,
          rel: relFrom(root, output),
          output,
          ext: path.extname(file.name).toLowerCase(),
        };
      });
  }

  return walk(root).map((file) => ({
    name: cleanName(path.basename(file)),
    rel: relFrom(root, file),
    output: file,
    ext: path.extname(file).toLowerCase(),
  }));
}

function withOutputPaths(root, catalog) {
  return (catalog || []).map((entry) => ({
    ...entry,
    output: entry.output || (entry.rel ? path.join(root, entry.rel) : ""),
    ext: entry.ext || path.extname(entry.name || entry.rel || "").toLowerCase(),
  }));
}

function findEntry(catalog, name) {
  const target = stripIndexPrefix(name).toLowerCase();
  if (!target) return null;
  return catalog.find((entry) => stripIndexPrefix(entry.name || entry.rel).toLowerCase() === target) || null;
}

function safeReadJson(file) {
  try {
    if (!file || !fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function byCleanName(items, nameField = "name") {
  const out = new Map();
  for (const item of items || []) {
    const name = cleanName(item[nameField] || item.cleanName || path.basename(item.rel || "")).toLowerCase();
    if (name) out.set(name, item);
  }
  return out;
}

function loadXseEvidence(options = {}) {
  const objectReport = safeReadJson(options.xseObjectJson || DEFAULT_XSE_OBJECT_JSON);
  const skeletonReport = safeReadJson(options.xseSkeletonJson || DEFAULT_XSE_SKELETON_JSON);
  const refReport = safeReadJson(options.xseRefJson || DEFAULT_XSE_REF_JSON);
  const routeReport = safeReadJson(options.routeJson || DEFAULT_ROUTE_JSON);
  return {
    objectByName: byCleanName(objectReport?.scripts || []),
    skeletonByName: byCleanName(skeletonReport?.scripts || []),
    refByName: byCleanName(refReport?.scripts || []),
    routes: routeReport?.routes || [],
  };
}

function loadFlowEvidence(options = {}) {
  const flowReport = safeReadJson(options.xseFlowJson || DEFAULT_XSE_FLOW_JSON);
  return {
    nodes: flowReport?.nodes || [],
    edges: flowReport?.edges || [],
  };
}

function findFlowNode(flow, rel) {
  const target = String(rel || "").replace(/\\/g, "/").toLowerCase();
  if (!target) return null;
  return (flow.nodes || []).find((node) => String(node.rel || "").replace(/\\/g, "/").toLowerCase() === target) || null;
}

function uniqueByRel(items) {
  const seen = new Set();
  const out = [];
  for (const item of items || []) {
    const key = String(item.rel || item.to || item.label || "").toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function flowTransitionsForScene(sceneRel, scripts, flow) {
  const current = String(sceneRel || "").replace(/\\/g, "/");
  const scriptRels = new Set((scripts || []).map((script) => script.rel).filter(Boolean));
  const outgoing = [];
  const sceneTransitions = [];

  for (const edge of flow.edges || []) {
    const from = String(edge.from || "").replace(/\\/g, "/");
    const to = String(edge.to || "").replace(/\\/g, "/");
    if (from !== current && !scriptRels.has(from)) continue;
    const target = findFlowNode(flow, to);
    const row = {
      from,
      to,
      rel: to,
      label: edge.label || target?.name || stripIndexPrefix(to),
      offset: edge.offset || "",
      kind: target?.kind || path.extname(to).replace(".", "") || "",
      source: from === current ? "scene" : "linked-script",
    };
    outgoing.push(row);
    if (/\.sce$/i.test(to)) sceneTransitions.push(row);
  }

  return {
    status: sceneTransitions.length ? "linked scene transitions found" : "no executable transition decoded yet",
    outgoing: uniqueByRel(outgoing),
    scenes: uniqueByRel(sceneTransitions),
    note: "derived from xse_flow_trace edges; actual branch predicates remain pending until XSE VM refs decode",
  };
}

function routeBucketsForScript(routes, scriptName) {
  const target = cleanName(scriptName).toLowerCase();
  const out = [];
  for (const route of routes || []) {
    const hit = (route.scripts || []).find((script) => cleanName(script.cleanName || script.rel).toLowerCase() === target);
    if (hit) {
      out.push({
        id: route.id,
        title: route.title,
        termHits: (hit.termHits || []).slice(0, 5),
        usefulLines: (hit.usefulLines || []).slice(0, 5),
      });
    }
  }
  return out;
}

function xseEvidenceForScript(scriptName, evidence) {
  const key = cleanName(scriptName).toLowerCase();
  const object = evidence.objectByName.get(key) || null;
  const skeleton = evidence.skeletonByName.get(key) || null;
  const ref = evidence.refByName.get(key) || null;
  const best = object?.attempts?.[0] || null;
  const commandRows = (skeleton?.rows || [])
    .filter((row) => row.kind === "full")
    .slice(0, 12)
    .map((row) => ({
      offset: row.offsetHex,
      command: row.command,
      region: row.region,
      target: row.meta?.target || "",
      note: row.region === "symbol-pool" ? "symbol atom; not proven execution order" : "",
    }));
  return {
    status: "linked; VM execution pending",
    object: best ? {
      mode: best.shortMode,
      groups: best.parsedGroupCount,
      records: best.totalRecords,
      groupEnd: best.absoluteGroupEndHex,
      tailEnd: best.absoluteTailEndHex,
      tailOk: best.tail?.ok ?? null,
      tailMode: best.tail?.modes || null,
      warning: (best.warnings || []).concat(best.tail?.warnings || [])[0] || "",
    } : null,
    symbols: skeleton ? {
      commands: commandRows,
      guardrail: "visible command rows are symbol-pool atoms unless later callback decoding proves execution order",
    } : null,
    refs: ref ? {
      directMatches: ref.directMatchedCount,
      directMatchPercent: ref.directMatchPercent,
      weakMatches: ref.weakMatchedCount,
      note: "direct pool-offset correlation is a guardrail only; unresolved refs stay symbolic",
    } : null,
    routes: routeBucketsForScript(evidence.routes, scriptName),
  };
}

function findBootDataHit(report, groupId, predicate = null) {
  const group = (report?.groups || []).find((item) => item.id === groupId);
  if (!group) return null;
  const hits = group.hits || [];
  if (predicate) return hits.find(predicate) || hits[0] || null;
  return hits[0] || null;
}

function imageAsset(game, entry, note = "") {
  if (!entry) return null;
  const info = [".gif", ".png", ".jpg", ".jpeg"].includes(entry.ext || path.extname(entry.name || "").toLowerCase())
    ? parseGifInfo(entry.output)
    : null;
  return {
    name: stripIndexPrefix(entry.name || entry.rel),
    rel: entry.rel,
    imageUrl: assetUrl(game, entry.rel),
    imageInfo: info,
    note,
  };
}

function imageAssetFromCore(core, entry, note = "") {
  if (!entry) return null;
  const ext = entry.ext || path.extname(entry.name || "").toLowerCase();
  let info = null;
  if ([".gif", ".png", ".jpg", ".jpeg"].includes(ext)) {
    info = coreImageInfo(core, entry);
  }
  return {
    name: stripIndexPrefix(entry.name || entry.rel),
    rel: entry.rel,
    imageUrl: coreAssetUrl(core, entry.rel),
    imageInfo: info,
    note,
  };
}

function findBootEntry(catalog, name) {
  return findEntry(catalog, name) ||
    (catalog || []).find((entry) => stripIndexPrefix(entry.name || entry.rel).toLowerCase() === String(name || "").toLowerCase()) ||
    null;
}

function hasGodwarBootEvidenceScope(catalog) {
  const names = new Set((catalog || []).map((entry) => stripIndexPrefix(entry.name || entry.rel).toLowerCase()));
  return [
    "guangmingshendian.sce",
    "heianshendian.sce",
    "tx_guangmin.gif",
    "tx_heian.gif",
    "xuanzetouxiang.gif",
  ].some((name) => names.has(name));
}

function buildBootFlow(catalog, game, options = {}) {
  const useExternalEvidence = options.useExternalBootEvidence ?? hasGodwarBootEvidenceScope(catalog);
  if (!useExternalEvidence) {
    return {
      schema: "nicai.cbe.bootFlowRuntime.v1",
      status: "generic boot flow pending",
      reportGeneratedAt: "",
      steps: [],
      unresolved: {
        preTitleCaptions: "title-specific boot/story evidence is not available for this CBE",
        textHitCount: 0,
      },
      guardrail: "generic CBE boot flow stays empty unless title-specific evidence is available",
    };
  }
  const flowReport = safeReadJson(options.bootFlowJson || DEFAULT_BOOT_FLOW_JSON);
  const dataReport = safeReadJson(options.bootDataJson || DEFAULT_BOOT_DATA_JSON);
  const loadingTip = findBootDataHit(dataReport, "loading_tips", (hit) => String(hit.offset).toUpperCase() === "0X0359CE") ||
    findBootDataHit(dataReport, "loading_tips", (hit) => (hit.matched || []).includes("连击"));
  const saveMessage = findBootDataHit(dataReport, "title_save_menu", (hit) => String(hit.offset).toUpperCase() === "0X022D0E");
  const narration = findBootDataHit(dataReport, "opening_narration", (hit) => String(hit.offset).toUpperCase() === "0X037FC2");
  const manual = findBootDataHit(dataReport, "dual_protagonist_manual");
  const unresolvedCaptions = findBootDataHit(dataReport, "unresolved_caption_strings");

  const loading = findBootEntry(catalog, "LOADING.gif");
  const title = findBootEntry(catalog, "fengmian.gif");
  const menu = findBootEntry(catalog, "zhucaidan1.gif");
  const introFar = findBootEntry(catalog, "zhongliqu_2.gif");
  const introNear = findBootEntry(catalog, "zhongliqu_1.gif");
  const chooser = findBootEntry(catalog, "xuanzetouxiang.gif");
  const lightPortrait = findBootEntry(catalog, "tx_guangmin.gif");
  const darkPortrait = findBootEntry(catalog, "tx_heian.gif");
  const lightScene = findBootEntry(catalog, "guangmingshendian.sce");
  const darkScene = findBootEntry(catalog, "heianshendian.sce");

  const steps = [
    {
      id: "cold_loading_tip",
      mode: "loading",
      title: "Cold start loading tip",
      text: loadingTip?.text || "",
      evidenceOffset: loadingTip?.offset || "",
      image: imageAsset(game, loading, "LOADING.gif anchor"),
    },
    {
      id: "title_menu",
      mode: "title",
      title: "Title/menu",
      text: saveMessage?.text || "title/menu resource anchor",
      evidenceOffset: saveMessage?.offset || "",
      image: imageAsset(game, title, "fengmian.gif title anchor"),
      overlays: [imageAsset(game, menu, "menu button image")].filter(Boolean),
    },
    {
      id: "opening_narration",
      mode: "story",
      title: "Opening narration",
      text: narration?.text || "",
      evidenceOffset: narration?.offset || "",
      images: [
        imageAsset(game, introFar, "zhongliqu_2.gif opening visual"),
        imageAsset(game, introNear, "zhongliqu_1.gif opening visual"),
      ].filter(Boolean),
    },
    {
      id: "protagonist_choice",
      mode: "choice",
      title: "Light/Dark protagonist choice",
      text: manual?.text ? "游戏中分为光明神和黑暗神两个主角，剧情各不相同，任务承前启后。" : "",
      evidenceOffset: manual?.offset || "",
      image: imageAsset(game, chooser, "choice panel anchor"),
      choices: [
        {
          id: "light",
          title: "Light route",
          protagonist: "巴尔德 / 光明神",
          sceneRel: lightScene?.rel || "",
          image: imageAsset(game, lightPortrait, "tx_guangmin.gif portrait"),
          status: "route evidence linked; branch predicate pending",
        },
        {
          id: "dark",
          title: "Dark route",
          protagonist: "霍德尔 / 黑暗神",
          sceneRel: darkScene?.rel || "",
          image: imageAsset(game, darkPortrait, "tx_heian.gif portrait"),
          status: "route evidence linked; branch predicate pending",
        },
      ],
    },
  ].filter((step) => step.text || step.image || step.images?.length || step.choices?.length);

  return {
    schema: "nicai.cbe.bootFlowRuntime.v1",
    status: steps.length ? "evidence-linked boot flow" : "boot flow reports not found",
    reportGeneratedAt: flowReport?.generatedAt || "",
    steps,
    unresolved: {
      preTitleCaptions: "specific caption strings and load-progress label remain unresolved",
      textHitCount: unresolvedCaptions?.hits?.length || 0,
    },
    guardrail: "boot flow is reconstructed from resource/text evidence; exact VM timing and branch predicates remain pending",
  };
}

function buildBootFlowFromCore(core, catalog, options = {}) {
  const useExternalEvidence = options.useExternalBootEvidence ?? hasGodwarBootEvidenceScope(catalog);
  if (!useExternalEvidence) {
    return {
      schema: "nicai.cbe.bootFlowRuntime.v1",
      status: "generic boot flow pending",
      reportGeneratedAt: "",
      steps: [],
      unresolved: {
        preTitleCaptions: "title-specific boot/story evidence is not available for this CBE",
        textHitCount: 0,
      },
      guardrail: "generic CBE boot flow stays empty unless title-specific evidence is available",
    };
  }
  const flowReport = safeReadJson(options.bootFlowJson || DEFAULT_BOOT_FLOW_JSON);
  const dataReport = safeReadJson(options.bootDataJson || DEFAULT_BOOT_DATA_JSON);
  const loadingTip = findBootDataHit(dataReport, "loading_tips", (hit) => String(hit.offset).toUpperCase() === "0X0359CE") ||
    findBootDataHit(dataReport, "loading_tips", (hit) => (hit.matched || []).includes("连击"));
  const saveMessage = findBootDataHit(dataReport, "title_save_menu", (hit) => String(hit.offset).toUpperCase() === "0X022D0E");
  const narration = findBootDataHit(dataReport, "opening_narration", (hit) => String(hit.offset).toUpperCase() === "0X037FC2");
  const manual = findBootDataHit(dataReport, "dual_protagonist_manual");
  const unresolvedCaptions = findBootDataHit(dataReport, "unresolved_caption_strings");

  const loading = findBootEntry(catalog, "LOADING.gif");
  const title = findBootEntry(catalog, "fengmian.gif");
  const menu = findBootEntry(catalog, "zhucaidan1.gif");
  const introFar = findBootEntry(catalog, "zhongliqu_2.gif");
  const introNear = findBootEntry(catalog, "zhongliqu_1.gif");
  const chooser = findBootEntry(catalog, "xuanzetouxiang.gif");
  const lightPortrait = findBootEntry(catalog, "tx_guangmin.gif");
  const darkPortrait = findBootEntry(catalog, "tx_heian.gif");
  const lightScene = findBootEntry(catalog, "guangmingshendian.sce");
  const darkScene = findBootEntry(catalog, "heianshendian.sce");

  const steps = [
    {
      id: "cold_loading_tip",
      mode: "loading",
      title: "Cold start loading tip",
      text: loadingTip?.text || "",
      evidenceOffset: loadingTip?.offset || "",
      image: imageAssetFromCore(core, loading, "LOADING.gif anchor"),
    },
    {
      id: "title_menu",
      mode: "title",
      title: "Title/menu",
      text: saveMessage?.text || "title/menu resource anchor",
      evidenceOffset: saveMessage?.offset || "",
      image: imageAssetFromCore(core, title, "fengmian.gif title anchor"),
      overlays: [imageAssetFromCore(core, menu, "menu button image")].filter(Boolean),
    },
    {
      id: "opening_narration",
      mode: "story",
      title: "Opening narration",
      text: narration?.text || "",
      evidenceOffset: narration?.offset || "",
      images: [
        imageAssetFromCore(core, introFar, "zhongliqu_2.gif opening visual"),
        imageAssetFromCore(core, introNear, "zhongliqu_1.gif opening visual"),
      ].filter(Boolean),
    },
    {
      id: "protagonist_choice",
      mode: "choice",
      title: "Light/Dark protagonist choice",
      text: manual?.text ? "游戏中分为光明神和黑暗神两个主角，剧情各不相同，任务承前启后。" : "",
      evidenceOffset: manual?.offset || "",
      image: imageAssetFromCore(core, chooser, "choice panel anchor"),
      choices: [
        {
          id: "light",
          title: "Light route",
          protagonist: "巴尔德 / 光明神",
          sceneRel: lightScene?.rel || "",
          image: imageAssetFromCore(core, lightPortrait, "tx_guangmin.gif portrait"),
          status: "route evidence linked; branch predicate pending",
        },
        {
          id: "dark",
          title: "Dark route",
          protagonist: "霍德尔 / 黑暗神",
          sceneRel: darkScene?.rel || "",
          image: imageAssetFromCore(core, darkPortrait, "tx_heian.gif portrait"),
          status: "route evidence linked; branch predicate pending",
        },
      ],
    },
  ].filter((step) => step.text || step.image || step.images?.length || step.choices?.length);

  return {
    schema: "nicai.cbe.bootFlowRuntime.v1",
    status: steps.length ? "evidence-linked boot flow" : "boot flow reports not found",
    reportGeneratedAt: flowReport?.generatedAt || "",
    steps,
    unresolved: {
      preTitleCaptions: "specific caption strings and load-progress label remain unresolved",
      textHitCount: unresolvedCaptions?.hits?.length || 0,
    },
    guardrail: "boot flow is reconstructed from resource/text evidence; exact VM timing and branch predicates remain pending",
  };
}

function findByRel(catalog, rel) {
  const target = String(rel || "").replace(/\\/g, "/").toLowerCase();
  if (!target) return null;
  return catalog.find((entry) => String(entry.rel || "").replace(/\\/g, "/").toLowerCase() === target) || null;
}

function parseHex(value, fallback = 0) {
  if (Number.isFinite(value)) return value;
  const parsed = Number.parseInt(String(value || "").replace(/^0x/i, ""), 16);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampCamera(sceneCanvas, requested = {}, screen = DEFAULT_SCREEN) {
  const width = screen.width || DEFAULT_SCREEN.width;
  const height = screen.height || DEFAULT_SCREEN.height;
  const maxX = Math.max(0, (sceneCanvas?.width || width) - width);
  const maxY = Math.max(0, (sceneCanvas?.height || height) - height);
  return {
    x: Math.max(0, Math.min(maxX, requested.x || 0)),
    y: Math.max(0, Math.min(maxY, requested.y || 0)),
    width,
    height,
  };
}

function assetUrl(game, rel) {
  if (!game || !rel) return "";
  return `/asset?game=${encodeURIComponent(game)}&rel=${encodeURIComponent(rel)}`;
}

function coreAssetUrl(core, rel) {
  if (!core?.input || !rel) return "";
  return `/cbe-asset?input=${encodeURIComponent(core.input)}&rel=${encodeURIComponent(rel)}`;
}

function coreImageInfo(core, entry) {
  if (!core || !entry) return null;
  try {
    return parseGifInfoBuffer(core.readResource(entry).fixed);
  } catch {
    return null;
  }
}

function statSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function scoreBootImage(entry) {
  const name = stripIndexPrefix(entry.name || entry.rel).toLowerCase();
  const ext = entry.ext || path.extname(name).toLowerCase();
  if (![".gif", ".png", ".jpg", ".jpeg", ".bmp"].includes(ext)) return null;

  const rules = [
    { pattern: /^fengmian\.gif$/i, score: 120, reason: "exact title filename fengmian.gif" },
    { pattern: /fengmian/i, score: 110, reason: "title/cover filename hint" },
    { pattern: /title|startup|splash|start/i, score: 90, reason: "startup filename hint" },
    { pattern: /logo/i, score: 70, reason: "logo filename hint" },
    { pattern: /zhucaidan|mainmenu|menu/i, score: 55, reason: "menu filename hint" },
    { pattern: /loading/i, score: 30, reason: "loading filename hint" },
  ];
  const match = rules.find((rule) => rule.pattern.test(name));
  if (!match) return null;

  let score = match.score;
  if (/btn|button|icon|cursor|arrow|select|small|an?niu/i.test(name)) score -= 35;
  if (ext === ".gif") score += 5;
  score += Math.min(20, Math.floor(statSize(entry.output) / 8192));
  return { ...entry, bootScore: score, bootReason: match.reason };
}

function findBootImage(catalog) {
  const candidates = (catalog || [])
    .map(scoreBootImage)
    .filter(Boolean)
    .sort((a, b) => b.bootScore - a.bootScore || String(a.rel).localeCompare(String(b.rel)));
  return candidates[0] || null;
}

function scoreLoadingImage(entry) {
  const name = stripIndexPrefix(entry.name || entry.rel).toLowerCase();
  const ext = entry.ext || path.extname(name).toLowerCase();
  if (![".gif", ".png", ".jpg", ".jpeg", ".bmp"].includes(ext)) return null;
  if (!/loading|load|jiazai|duqu|progress/i.test(name)) return null;
  let score = /^loading\.gif$/i.test(name) ? 100 : 70;
  if (/btn|button|icon|cursor|arrow|select|small|an?niu/i.test(name)) score -= 35;
  if (ext === ".gif") score += 5;
  score += Math.min(12, Math.floor(statSize(entry.output) / 8192));
  return { ...entry, loadingScore: score, loadingReason: /^loading\.gif$/i.test(name) ? "exact loading filename" : "loading filename hint" };
}

function findLoadingImage(catalog) {
  const candidates = (catalog || [])
    .map(scoreLoadingImage)
    .filter(Boolean)
    .sort((a, b) => b.loadingScore - a.loadingScore || String(a.rel).localeCompare(String(b.rel)));
  return candidates[0] || null;
}

async function summarizeIfExists(file, catalog, name = "") {
  if (!file || !fs.existsSync(file)) return null;
  return summarizeFile(file, {
    name: cleanName(name || path.basename(file)),
    catalog,
  });
}

function firstMapRecordFromSce(sce, catalog) {
  const tableRecord = sce?.mapTable?.records?.[0] || null;
  if (tableRecord) return { ...tableRecord, source: "map-table" };
  for (const ref of sce?.lengthPrefixedRefs || []) {
    const entry = findEntry(catalog, ref.text);
    if (entry?.ext === ".map" || /\.map$/i.test(ref.text || "")) {
      return {
        offset: ref.offset,
        fields: "",
        rawFields: "",
        name: ref.text,
        source: "length-prefixed-ref",
      };
    }
  }
  return null;
}

function summarizeCoreResource(core, entryOrName, options = {}) {
  const entry = typeof entryOrName === "string" ? core.findResource(entryOrName) : entryOrName;
  if (!entry) return null;
  const resource = core.readResource(entry, { raw: options.raw === true });
  return summarizeBuffer(resource.name, resource.fixed, {
    ...options,
    catalog: options.catalog || core.catalog,
    source: "raw-cbe-core",
  });
}

function slimMapTemplateProbe(probe) {
  if (!probe) return null;
  return {
    nearCanvas: probe.nearCanvas,
    bestCanvasDelta: probe.bestCanvasDelta,
    best: probe.best ? {
      score: probe.best.score,
      reason: probe.best.reason,
      fieldsOffset: probe.best.fieldsOffset,
      grid: probe.best.grid,
      matrixRead: probe.best.matrixRead,
      matrixExpected: probe.best.matrixExpected,
      matrixEndOffset: probe.best.matrixEndOffset,
      bytesRemaining: probe.best.bytesRemaining,
    } : null,
  };
}

function slimMapTraceForRuntime(trace) {
  if (!trace?.map) return null;
  const drawCandidates = (trace.evidence?.drawCandidates || []).slice(0, 3).map((candidate) => ({
    key: candidate.key,
    label: candidate.label,
    parser: candidate.parser,
    atlasTileSize: candidate.atlasTileSize,
    coordScale: candidate.coordScale,
    records: candidate.records,
    consumedBytes: candidate.consumedBytes,
    drawableRecords: candidate.drawableRecords,
    drawablePercent: candidate.drawablePercent,
    validTilePercent: candidate.validTilePercent,
    coverage: candidate.coverage,
    bounds: candidate.bounds,
    score: candidate.score,
    samples: (candidate.samples || []).slice(0, 8),
  }));
  const rleCandidates = (trace.evidence?.rleCandidates || []).slice(0, 3).map((candidate) => ({
    key: candidate.key,
    label: candidate.label,
    tileSize: candidate.tileSize,
    columns: candidate.columns,
    rows: candidate.rows,
    cells: candidate.cells,
    cursor: candidate.cursor,
    writes: candidate.writes,
    skips: candidate.skips,
    fillPercent: candidate.fillPercent,
    fullGrid: candidate.fullGrid,
    gridError: candidate.gridError,
    score: candidate.score,
    truncated: candidate.truncated,
  }));
  return {
    source: "cbe-maptrace-buffer",
    status: trace.map.atlas?.size
      ? "map stream analyzed from raw CBE buffer; renderer still gated until bytecode semantics are proven"
      : "map stream analyzed from raw CBE buffer; atlas unresolved",
    canvas: trace.map.canvas || null,
    atlas: trace.map.atlas || null,
    dataOffset: trace.map.dataOffset || "",
    drawStreamOffset: trace.map.drawStreamOffset || "",
    drawStreamLength: trace.map.drawStreamLength || 0,
    drawStreamReason: trace.map.drawStreamReason || "",
    skippedHeaderBytes: trace.map.skippedHeaderBytes || "",
    leadHeader: trace.map.leadHeader || null,
    leadFields: trace.map.leadFields || [],
    candidateScores: (trace.evidence?.candidateScores || []).slice(0, 4),
    rleCandidates,
    drawCandidates,
    bestDrawCandidate: drawCandidates[0] || null,
    bestRleCandidate: rleCandidates[0] || null,
    tileGridCandidate: trace.evidence?.rlePreviewGrid ? {
      source: trace.evidence.rlePreviewGrid.source,
      key: trace.evidence.rlePreviewGrid.key,
      label: trace.evidence.rlePreviewGrid.label,
      tileSize: trace.evidence.rlePreviewGrid.tileSize,
      columns: trace.evidence.rlePreviewGrid.columns,
      rows: trace.evidence.rlePreviewGrid.rows,
      cells: trace.evidence.rlePreviewGrid.cells,
      atlasColumns: trace.evidence.rlePreviewGrid.atlasColumns,
      atlasTiles: trace.evidence.rlePreviewGrid.atlasTiles,
      writes: trace.evidence.rlePreviewGrid.writes,
      skips: trace.evidence.rlePreviewGrid.skips,
      fillPercent: trace.evidence.rlePreviewGrid.fillPercent,
      score: trace.evidence.rlePreviewGrid.score,
      confidence: trace.evidence.rlePreviewGrid.confidence,
      tileCells: trace.evidence.rlePreviewGrid.tileCells,
    } : null,
    mapTemplateProbe: slimMapTemplateProbe(trace.evidence?.mapTemplateProbe),
    compactProbe: trace.evidence?.compactProbe ? {
      tokenCount: trace.evidence.compactProbe.tokenCount,
      consumedBytes: trace.evidence.compactProbe.consumedBytes,
      tagCounts: (trace.evidence.compactProbe.tagCounts || []).slice(0, 8),
    } : null,
    pairStats: trace.evidence?.pairStats || null,
  };
}

function analyzeCoreMapBuffer(core, mapEntry, canvas) {
  if (!core || !mapEntry) return null;
  const resource = core.readResource(mapEntry);
  const trace = analyzeMapBuffer(resource.name, resource.fixed, {
    input: `${core.input}:${resource.rel}`,
    rel: resource.rel,
    catalog: core.catalog,
    sceneCanvas: canvas,
    source: "raw-cbe-core",
    readImageInfo: (entry) => coreImageInfo(core, entry),
    readResource: (entry) => core.readResource(entry).fixed,
    includeRlePreviewGrid: true,
  });
  return slimMapTraceForRuntime(trace);
}

async function buildActorNode(placement, root, catalog, game) {
  const actorEntry = placement.rel
    ? findByRel(catalog, placement.rel)
    : findEntry(catalog, placement.matched || placement.name);
  const actorFile = actorEntry?.output || "";
  const actorSummary = await summarizeIfExists(actorFile, catalog, actorEntry?.name || placement.matched);
  const actor = actorSummary?.specific?.actor || null;
  const imageEntry = actor?.primaryImageRel
    ? findByRel(catalog, actor.primaryImageRel)
    : findEntry(catalog, actor?.primaryImage);

  return {
    id: `actor:${placement.offset || placement.name}`,
    type: "actor",
    name: placement.name,
    matched: placement.matched,
    recordType: placement.recordType,
    x: placement.x,
    y: placement.y,
    anchor: placement.anchor || "origin",
    source: {
      offset: placement.offset,
      stringOffset: placement.stringOffset,
      matchReason: placement.matchReason || "",
      rel: actorEntry?.rel || placement.rel || "",
    },
    actor: actor ? {
      rel: actorEntry?.rel || "",
      primaryImage: actor.primaryImage,
      primaryImageRel: imageEntry?.rel || actor.primaryImageRel || "",
      imageUrl: assetUrl(game, imageEntry?.rel || actor.primaryImageRel || ""),
      imageInfo: actor.imageInfo || null,
      streamOffset: actor.streamOffset,
      streamLength: actor.streamLength,
      f222: actor.f222LayoutProbe ? {
        tableMethod: actor.f222LayoutProbe.tableMethod,
        recordStride: actor.f222LayoutProbe.recordStride,
        score: actor.f222LayoutProbe.score,
        fieldsOffset: actor.f222LayoutProbe.fieldsOffset,
        grid: actor.f222LayoutProbe.grid,
        matrixRead: actor.f222LayoutProbe.matrixRead,
        matrixExpected: actor.f222LayoutProbe.matrixExpected,
        bytesToFfCandidate: actor.f222LayoutProbe.bytesToFfCandidate,
      } : null,
    } : null,
  };
}

function buildActorNodeFromCore(placement, core, catalog) {
  const actorEntry = placement.rel
    ? findByRel(catalog, placement.rel)
    : findEntry(catalog, placement.matched || placement.name);
  const actorSummary = actorEntry ? summarizeCoreResource(core, actorEntry, {
    name: actorEntry.name || placement.matched,
  }) : null;
  const actor = actorSummary?.specific?.actor || null;
  const imageEntry = actor?.primaryImageRel
    ? findByRel(catalog, actor.primaryImageRel)
    : findEntry(catalog, actor?.primaryImage);

  return {
    id: `actor:${placement.offset || placement.name}`,
    type: "actor",
    name: placement.name,
    matched: placement.matched,
    recordType: placement.recordType,
    x: placement.x,
    y: placement.y,
    anchor: placement.anchor || "origin",
    source: {
      offset: placement.offset,
      stringOffset: placement.stringOffset,
      matchReason: placement.matchReason || "",
      rel: actorEntry?.rel || placement.rel || "",
    },
    actor: actor ? {
      rel: actorEntry?.rel || "",
      primaryImage: actor.primaryImage,
      primaryImageRel: imageEntry?.rel || actor.primaryImageRel || "",
      imageUrl: coreAssetUrl(core, imageEntry?.rel || actor.primaryImageRel || ""),
      imageInfo: imageEntry ? imageAssetFromCore(core, imageEntry)?.imageInfo || actor.imageInfo || null : actor.imageInfo || null,
      streamOffset: actor.streamOffset,
      streamLength: actor.streamLength,
      f222: actor.f222LayoutProbe ? {
        tableMethod: actor.f222LayoutProbe.tableMethod,
        recordStride: actor.f222LayoutProbe.recordStride,
        score: actor.f222LayoutProbe.score,
        fieldsOffset: actor.f222LayoutProbe.fieldsOffset,
        grid: actor.f222LayoutProbe.grid,
        matrixRead: actor.f222LayoutProbe.matrixRead,
        matrixExpected: actor.f222LayoutProbe.matrixExpected,
        bytesToFfCandidate: actor.f222LayoutProbe.bytesToFfCandidate,
      } : null,
    } : null,
  };
}

async function buildRuntimeScene(sceneFile, options = {}) {
  const root = options.root || findRoot(sceneFile);
  const catalog = withOutputPaths(root, options.catalog || loadCatalog(root));
  const game = options.game || "";
  const sceneSummary = await summarizeFile(sceneFile, {
    name: cleanName(path.basename(sceneFile)),
    catalog,
  });
  const sce = sceneSummary.specific?.sce || {};
  const sceneRel = relFrom(root, sceneFile);
  const canvas = sce.canvas || null;
  const bootEntry = findBootImage(catalog);
  const bootInfo = bootEntry?.output ? parseGifInfo(bootEntry.output) : null;
  const loadingEntry = findLoadingImage(catalog);
  const loadingInfo = loadingEntry?.output ? parseGifInfo(loadingEntry.output) : null;
  const screen = bootInfo?.width && bootInfo?.height
    ? { width: bootInfo.width, height: bootInfo.height }
    : DEFAULT_SCREEN;
  const mapRecord = firstMapRecordFromSce(sce, catalog);
  const mapEntry = mapRecord ? findEntry(catalog, mapRecord.name) : null;
  const mapFile = mapEntry?.output || "";
  const mapSummary = await summarizeIfExists(mapFile, catalog, mapEntry?.name);
  const mapTrace = mapFile ? await analyzeMapFile(mapFile, { root, catalog, includeRlePreviewGrid: true }) : null;
  const mapRenderHint = mapTrace ? slimMapTraceForRuntime(mapTrace) : null;
  const map = mapEntry ? {
    name: mapEntry.name,
    rel: mapEntry.rel,
    record: mapRecord ? {
      offset: mapRecord.offset,
      fields: mapRecord.fields,
      rawFields: mapRecord.rawFields,
      source: mapRecord.source || "",
    } : null,
    canvas: mapSummary?.specific?.map?.canvas || canvas,
    tileset: mapSummary?.specific?.map?.tilesetHint || mapTrace?.map?.atlas?.name || "",
    tilesetRel: mapTrace?.map?.atlas?.rel || "",
    tilesetUrl: assetUrl(game, mapTrace?.map?.atlas?.rel || ""),
    leadHeader: mapSummary?.specific?.map?.leadHeader || null,
    drawStreamOffset: mapSummary?.specific?.map?.drawStreamOffset || mapTrace?.map?.drawStreamOffset || "",
    decodeStatus: mapRenderHint ? "terrain bytecode analyzed; renderer pending" : "terrain bytecode pending",
    renderHint: mapRenderHint,
    mapTemplateProbe: mapSummary?.specific?.map?.mapTemplateProbe?.best ? {
      nearCanvas: mapSummary.specific.map.mapTemplateProbe.nearCanvas,
      bestCanvasDelta: mapSummary.specific.map.mapTemplateProbe.bestCanvasDelta,
      best: {
        score: mapSummary.specific.map.mapTemplateProbe.best.score,
        reason: mapSummary.specific.map.mapTemplateProbe.best.reason,
        fieldsOffset: mapSummary.specific.map.mapTemplateProbe.best.fieldsOffset,
        grid: mapSummary.specific.map.mapTemplateProbe.best.grid,
      },
    } : null,
  } : null;

  const actors = [];
  for (const placement of sce.placements || []) {
    actors.push(await buildActorNode(placement, root, catalog, game));
  }

  const controlCandidates = actors.map((entity) => ({
    id: entity.id,
    name: entity.matched || entity.name || "",
    matched: entity.matched || "",
    x: entity.x || 0,
    y: entity.y || 0,
    anchor: entity.anchor || "origin",
    image: entity.actor?.primaryImage || "",
    imageRel: entity.actor?.primaryImageRel || "",
    reason: entity.source?.matchReason || "",
  }));

  const scriptRefs = (sce.lengthPrefixedRefs || [])
    .map((ref) => ({ ...ref, entry: findEntry(catalog, ref.text) }))
    .filter((ref) => /\.xse$/i.test(ref.text) || ref.entry?.ext === ".xse")
    .map((ref) => ({
      offset: ref.offset,
      name: ref.text,
      matched: ref.entry?.name || "",
      rel: ref.entry?.rel || "",
    }));
  const xseEvidence = loadXseEvidence(options);
  const scriptRefsWithEvidence = scriptRefs.map((ref) => ({
    ...ref,
    evidence: xseEvidenceForScript(ref.matched || ref.name, xseEvidence),
  }));
  const flowEvidence = loadFlowEvidence(options);
  const transitions = flowTransitionsForScene(sceneRel, scriptRefsWithEvidence, flowEvidence);
  const bootFlow = buildBootFlow(catalog, game, options);

  return {
    schema: "nicai.cbe.runtimeScene.v1",
    generatedAt: new Date().toISOString(),
    source: {
      root,
      sceneRel,
      sceneFile,
      game,
    },
    screen,
    boot: bootEntry ? {
      state: "title",
      name: stripIndexPrefix(bootEntry.name || bootEntry.rel),
      rel: bootEntry.rel,
      imageUrl: assetUrl(game, bootEntry.rel),
      imageInfo: bootInfo,
      confidence: bootEntry.bootReason,
      score: bootEntry.bootScore,
      note: "initial title screen candidate",
    } : null,
    loading: loadingEntry ? {
      state: "loading",
      name: stripIndexPrefix(loadingEntry.name || loadingEntry.rel),
      rel: loadingEntry.rel,
      imageUrl: assetUrl(game, loadingEntry.rel),
      imageInfo: loadingInfo,
      confidence: loadingEntry.loadingReason,
      score: loadingEntry.loadingScore,
      note: "loading/progress screen candidate",
    } : null,
    bootFlow,
    scene: {
      name: cleanName(path.basename(sceneFile)),
      rel: sceneRel,
      magicOffset: sce.magicOffset || "",
      canvas,
      streamOffset: sce.mapTable?.streamOffset || "",
      map,
      scripts: scriptRefsWithEvidence,
      transitions,
    },
    camera: clampCamera(canvas, options.camera, screen),
    control: {
      enabled: false,
      mode: "camera",
      entityId: "",
      candidates: controlCandidates,
      reason: "disabled until story roles, dual-protagonist logic, input scripts, and collision are understood",
    },
    entities: actors,
    runtimeStatus: {
      stage: "scene graph ready",
      terrain: map?.renderHint ? "map bytecode analyzed; not yet executed as terrain" : (map ? "map bytecode not yet executed" : "no map resource"),
      actorAnimation: actors.length ? "actor templates parsed as metadata; animation VM pending" : "no actors",
      input: controlCandidates.length
        ? "camera pan available; actor follow is selectable in the viewer"
        : "disabled; actor control inference paused for story/script analysis",
      scriptVm: scriptRefsWithEvidence.length
        ? "script resources linked with symbolic XSE evidence; VM execution pending"
        : "no linked script",
      bootFlow: bootFlow.steps?.length ? "boot/title/opening flow linked from evidence reports" : "boot flow evidence missing",
    },
  };
}

async function buildRuntimeSceneFromCore(core, sceneNameOrRel, options = {}) {
  const catalog = core.catalog;
  const game = options.game || path.basename(core.input || "", path.extname(core.input || ""));
  const requestedScene = sceneNameOrRel || options.scene || "";
  const sceneEntry = requestedScene
    ? core.findResource(requestedScene)
    : (core.listResources({ ext: ".sce", limit: 1 })[0] || null);
  if (!sceneEntry) throw new Error(`Core runtime scene not found: ${requestedScene || "(first .sce)"}`);
  const sceneResource = core.readResource(sceneEntry);
  const sceneSummary = summarizeBuffer(sceneResource.name, sceneResource.fixed, {
    catalog,
    source: "raw-cbe-core",
  });
  const sce = sceneSummary.specific?.sce || {};
  const sceneRel = sceneEntry.rel;
  const canvas = sce.canvas || null;
  const bootEntry = findBootImage(catalog);
  const bootInfo = coreImageInfo(core, bootEntry);
  const loadingEntry = findLoadingImage(catalog);
  const loadingInfo = coreImageInfo(core, loadingEntry);
  const screen = bootInfo?.width && bootInfo?.height
    ? { width: bootInfo.width, height: bootInfo.height }
    : DEFAULT_SCREEN;
  const mapRecord = firstMapRecordFromSce(sce, catalog);
  const mapEntry = mapRecord ? findEntry(catalog, mapRecord.name) : null;
  const mapSummary = mapEntry ? summarizeCoreResource(core, mapEntry, {
    sceneCanvas: canvas,
  }) : null;
  const mapRenderHint = mapEntry ? analyzeCoreMapBuffer(core, mapEntry, canvas) : null;
  const tilesetName = mapSummary?.specific?.map?.tilesetHint || mapRenderHint?.atlas?.name || "";
  const tilesetEntry = tilesetName
    ? findEntry(catalog, tilesetName) || findByRel(catalog, mapRenderHint?.atlas?.rel || "")
    : findByRel(catalog, mapRenderHint?.atlas?.rel || "");
  const map = mapEntry ? {
    name: mapEntry.name,
    rel: mapEntry.rel,
    record: mapRecord ? {
      offset: mapRecord.offset,
      fields: mapRecord.fields,
      rawFields: mapRecord.rawFields,
      source: mapRecord.source || "",
    } : null,
    canvas: mapSummary?.specific?.map?.canvas || canvas,
    tileset: tilesetName,
    tilesetRel: tilesetEntry?.rel || mapRenderHint?.atlas?.rel || "",
    tilesetUrl: coreAssetUrl(core, tilesetEntry?.rel || mapRenderHint?.atlas?.rel || ""),
    leadHeader: mapSummary?.specific?.map?.leadHeader || null,
    drawStreamOffset: mapSummary?.specific?.map?.drawStreamOffset || mapRenderHint?.drawStreamOffset || "",
    decodeStatus: mapRenderHint
      ? "terrain bytecode analyzed from raw CBE core buffers; renderer pending"
      : "terrain bytecode pending; built from raw CBE core buffers",
    renderHint: mapRenderHint,
    mapTemplateProbe: mapSummary?.specific?.map?.mapTemplateProbe?.best ? {
      nearCanvas: mapSummary.specific.map.mapTemplateProbe.nearCanvas,
      bestCanvasDelta: mapSummary.specific.map.mapTemplateProbe.bestCanvasDelta,
      best: {
        score: mapSummary.specific.map.mapTemplateProbe.best.score,
        reason: mapSummary.specific.map.mapTemplateProbe.best.reason,
        fieldsOffset: mapSummary.specific.map.mapTemplateProbe.best.fieldsOffset,
        grid: mapSummary.specific.map.mapTemplateProbe.best.grid,
      },
    } : null,
  } : null;

  const actors = [];
  for (const placement of sce.placements || []) {
    actors.push(buildActorNodeFromCore(placement, core, catalog));
  }

  const controlCandidates = actors.map((entity) => ({
    id: entity.id,
    name: entity.matched || entity.name || "",
    matched: entity.matched || "",
    x: entity.x || 0,
    y: entity.y || 0,
    anchor: entity.anchor || "origin",
    image: entity.actor?.primaryImage || "",
    imageRel: entity.actor?.primaryImageRel || "",
    reason: entity.source?.matchReason || "",
  }));

  const scriptRefs = (sce.lengthPrefixedRefs || [])
    .map((ref) => ({ ...ref, entry: findEntry(catalog, ref.text) }))
    .filter((ref) => /\.xse$/i.test(ref.text) || ref.entry?.ext === ".xse")
    .map((ref) => ({
      offset: ref.offset,
      name: ref.text,
      matched: ref.entry?.name || "",
      rel: ref.entry?.rel || "",
    }));
  const xseEvidence = loadXseEvidence(options);
  const scriptRefsWithEvidence = scriptRefs.map((ref) => ({
    ...ref,
    evidence: xseEvidenceForScript(ref.matched || ref.name, xseEvidence),
  }));
  const flowEvidence = loadFlowEvidence(options);
  const transitions = flowTransitionsForScene(sceneRel, scriptRefsWithEvidence, flowEvidence);
  const bootFlow = buildBootFlowFromCore(core, catalog, options);

  return {
    schema: "nicai.cbe.runtimeScene.v1",
    generatedAt: new Date().toISOString(),
    source: {
      mode: "raw-cbe-core",
      input: core.input,
      sceneRel,
      sceneFile: sceneEntry.name,
      game,
      resourceCount: catalog.length,
    },
    screen,
    boot: bootEntry ? {
      state: "title",
      name: stripIndexPrefix(bootEntry.name || bootEntry.rel),
      rel: bootEntry.rel,
      imageUrl: coreAssetUrl(core, bootEntry.rel),
      imageInfo: bootInfo,
      confidence: bootEntry.bootReason,
      score: bootEntry.bootScore,
      note: "initial title screen candidate from raw CBE core",
    } : null,
    loading: loadingEntry ? {
      state: "loading",
      name: stripIndexPrefix(loadingEntry.name || loadingEntry.rel),
      rel: loadingEntry.rel,
      imageUrl: coreAssetUrl(core, loadingEntry.rel),
      imageInfo: loadingInfo,
      confidence: loadingEntry.loadingReason,
      score: loadingEntry.loadingScore,
      note: "loading/progress screen candidate from raw CBE core",
    } : null,
    bootFlow,
    scene: {
      name: sceneEntry.cleanName || cleanName(sceneEntry.name),
      rel: sceneRel,
      magicOffset: sce.magicOffset || "",
      canvas,
      streamOffset: sce.mapTable?.streamOffset || "",
      map,
      scripts: scriptRefsWithEvidence,
      transitions,
    },
    camera: clampCamera(canvas, options.camera, screen),
    control: {
      enabled: false,
      mode: "camera",
      entityId: "",
      candidates: controlCandidates,
      reason: "disabled until story roles, dual-protagonist logic, input scripts, and collision are understood",
    },
    entities: actors,
    runtimeStatus: {
      stage: "scene graph ready from raw CBE core",
      terrain: map?.renderHint ? "map bytecode analyzed from raw CBE core; not yet executed as terrain" : (map ? "map bytecode not yet executed" : "no map resource"),
      actorAnimation: actors.length ? "actor templates parsed as metadata; animation VM pending" : "no actors",
      input: controlCandidates.length
        ? "camera pan available; actor follow is selectable in the viewer"
        : "disabled; actor control inference paused for story/script analysis",
      scriptVm: scriptRefsWithEvidence.length
        ? "script resources linked with symbolic XSE evidence; VM execution pending"
        : "no linked script",
      bootFlow: bootFlow.steps?.length ? "boot/title/opening flow linked from evidence reports" : "boot flow evidence missing",
    },
  };
}

async function main() {
  const args = process.argv.slice(2);
  const input = path.resolve(args[0] || DEFAULT_SCENE);
  const outDir = path.resolve(args[1] || DEFAULT_OUT);
  const runtime = await buildRuntimeScene(input);
  await fsp.mkdir(outDir, { recursive: true });
  await fsp.writeFile(path.join(outDir, "runtime_scene.json"), JSON.stringify(runtime, null, 2), "utf8");
  console.log(`Input: ${input}`);
  console.log(`Output: ${path.join(outDir, "runtime_scene.json")}`);
  console.log(`Scene: ${runtime.scene.name} ${runtime.scene.canvas ? `${runtime.scene.canvas.width}x${runtime.scene.canvas.height}` : "-"}`);
  console.log(`Entities: ${runtime.entities.length}`);
  console.log(`Map: ${runtime.scene.map?.name || "-"}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.stack || err.message || String(err));
    process.exitCode = 1;
  });
}

module.exports = {
  buildRuntimeScene,
  buildRuntimeSceneFromCore,
  loadCatalog,
};
