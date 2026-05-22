const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { CbeRuntimeCore } = require("./cbe_runtime_core");
const { sanitizeName } = require("./cbe_unpack");
const { cleanName, extOf } = require("./cbe_profile");
const { parseGifInfoBuffer, summarizeBuffer } = require("./cbe_struct");
const { buildRuntimeSceneFromCore } = require("./cbe_runtime");

const DEFAULT_INPUT = path.resolve(__dirname, "..", "cbe file", "众神之战.CBE");
const DEFAULT_OUT = path.resolve(process.cwd(), "out_cbe_ui_asset");

const CATEGORY_RULES = [
  {
    id: "top-left-hud",
    label: "Top-left HUD/status overlay",
    tokens: [
      ["touxiang", 5],
      ["touxiangkuang", 6],
      ["touxiangbiaoshuzhi", 6],
      ["honggang", 5],
      ["hongzi", 4],
      ["jibie", 5],
      ["jibieziti", 6],
      ["jinbi", 5],
      ["jinbiziti", 6],
      ["gongjvtiao", 4],
      ["shuzi_xue", 4],
      ["fuhao", 2],
      ["ziti", 1],
    ],
    note: "Matches the portrait, HP/MP/EXP bars, level text, and coin counter visible in the device reference.",
  },
  {
    id: "bottom-softbar",
    label: "Bottom menu/task/skill softbar",
    tokens: [
      ["caidan", 6],
      ["candan", 5],
      ["renwu", 6],
      ["jinengkuang", 6],
      ["jineng_guangming", 6],
      ["jineng_heian", 5],
      ["jinenglan", 6],
      ["guangminshenlan", 6],
      ["heianshen_jinenglan", 5],
      ["anjian", 4],
      ["direc", 3],
      ["zicaidan", 4],
      ["queding", 2],
      ["xiaokuang", 2],
      ["xuankuang", 3],
      ["tubiao", 3],
    ],
    note: "Matches the unpacked texture style of the bottom menu, task button, and A/B/C/D/E skill slots.",
  },
  {
    id: "light-temple-scene",
    label: "Light-temple scene and actor candidates",
    tokens: [
      ["guangming", 5],
      ["guangmingshen", 6],
      ["zhongliqu", 6],
      ["shuitai", 6],
      ["shidui", 6],
      ["shijiezhishu", 5],
      ["shu", 2],
      ["diaoxiang", 5],
      ["nanna", 5],
      ["heer", 4],
      ["heermode", 5],
      ["fali", 5],
      ["lang", 5],
      ["tielangan", 3],
      ["chuansongmen", 3],
      ["jingling", 3],
      ["xianling", 3],
    ],
    note: "Matches the real reference map: ice/water temple floor, staircase/objects, player/NPC/monster sprites.",
  },
  {
    id: "transition-loading",
    label: "Loading and transition compositor candidates",
    tokens: [
      ["loading", 6],
      ["load", 4],
      ["fengmian", 5],
      ["zhucaidan", 4],
      ["kaichang", 5],
      ["cloud", 2],
      ["xuanzetouxiang", 3],
      ["guangmingjitexiao", 2],
      ["heianjitexiao", 2],
      ["baojixiaoguo", 2],
    ],
    note: "Related to loading/opening visuals; the grid/shutter wipe is currently treated as compositor behavior, not map terrain.",
  },
  {
    id: "numeric-fonts",
    label: "Bitmap numeric/font assets",
    tokens: [
      ["ziti", 5],
      ["shuzi", 5],
      ["jinbiziti", 6],
      ["jibieziti", 6],
      ["hongzi", 5],
      ["xitongziti", 4],
      ["maopao_shuzi", 5],
      ["touxiangbiaoshuzhi", 4],
    ],
    note: "Text in the real UI is image-rendered in several places, so these are renderer/font-atlas evidence.",
  },
];

const REFERENCE_OBSERVATIONS = [
  {
    id: "reference-light-temple-map",
    status: "visual-anchor",
    observation: "The supplied device screenshots show a light/ice temple map with gray stone floor, water/ice edges, stairs, large tree, crystals/statues, NPC/player/monster sprites, and a full HUD/softbar overlay.",
    implication: "The diagnostic RLE tile-grid preview is not a true terrain renderer and must remain hidden unless explicitly requested.",
  },
  {
    id: "reference-ui-textures",
    status: "visual-anchor",
    observation: "The HUD and bottom softbar in the device screenshots match unpacked CBE texture names such as caidan*, renwu*, jineng*, jinbi*, jibie*, honggang/hongzi, and touxiang*.",
    implication: "The web runtime needs a resource-composited UI layer driven by CBE state, not hand-redrawn web controls.",
  },
  {
    id: "reference-grid-shutter-transition",
    status: "visual-anchor",
    observation: "The black screen with bright grid/shutter reveal appears during scene switching/loading.",
    implication: "Track it as a screen-transition/compositor effect; do not promote it as map decoding evidence.",
  },
  {
    id: "reference-15fps",
    status: "hypothesis",
    observation: "The user reports the real game appears to run at roughly 15 fps.",
    implication: "Treat 15 fps as an emulator timing hypothesis until actor/map scheduling, engine timer code, or measured video frames prove it.",
  },
];

function usage() {
  console.log("Usage: node src/cbe_ui_asset_probe.js [input.CBE] [out_dir]");
}

function compactGifInfo(info) {
  if (!info) return null;
  return {
    width: info.width,
    height: info.height,
    frames: info.frames,
    graphicControls: info.graphicControls,
    sheetLike: info.sheetLike,
    delaysCentiseconds: info.delaysCentiseconds || [],
    uniqueDelaysCentiseconds: info.uniqueDelaysCentiseconds || [],
    dominantDelayCentiseconds: info.dominantDelayCentiseconds || null,
    nominalFps: info.nominalFps || null,
    imageDescriptors: info.imageDescriptors || [],
  };
}

function scoreByRule(asset, rule) {
  const name = asset.cleanName.toLowerCase();
  const hits = [];
  let score = 0;
  for (const [token, weight] of rule.tokens) {
    if (!name.includes(token.toLowerCase())) continue;
    hits.push(token);
    score += weight;
  }
  if (asset.info?.width && asset.info?.height) {
    const area = asset.info.width * asset.info.height;
    if (rule.id.includes("hud") && area <= 240 * 90) score += 1;
    if (rule.id.includes("softbar") && asset.info.height <= 80) score += 1;
    if (rule.id.includes("scene") && area >= 20 * 20) score += 1;
  }
  if (asset.cleanName.toLowerCase() === "g.gif" && rule.id === "top-left-hud") {
    hits.push("G.gif");
    score += 2;
  }
  return { score, hits };
}

function topCandidates(assets, rule, limit = 28) {
  return assets
    .map((asset) => ({ ...asset, match: scoreByRule(asset, rule) }))
    .filter((asset) => asset.match.score > 0)
    .sort((a, b) => b.match.score - a.match.score || a.index - b.index)
    .slice(0, limit);
}

function delayHistogram(assets) {
  const hist = {};
  for (const asset of assets) {
    for (const delay of asset.info?.uniqueDelaysCentiseconds || []) {
      hist[delay] = (hist[delay] || 0) + 1;
    }
  }
  return Object.entries(hist)
    .map(([delay, count]) => ({
      delayCentiseconds: Number(delay),
      approximateFps: Number(delay) > 0 ? Number((100 / Number(delay)).toFixed(2)) : null,
      assetCount: count,
    }))
    .sort((a, b) => a.delayCentiseconds - b.delayCentiseconds);
}

function stem(name) {
  return cleanName(name).replace(/\.[^.]+$/, "").toLowerCase();
}

function actorImageLinks(core, imageByStem) {
  const catalog = core.catalog.map((entry) => ({
    ...entry,
    base: cleanName(entry.name),
  }));
  const actors = [];
  for (const entry of core.listResources({ ext: ".actor" })) {
    let summary = null;
    try {
      const resource = core.readResource(entry);
      summary = summarizeBuffer(entry.name, resource.fixed, { catalog });
    } catch {
      summary = null;
    }
    const actor = summary?.specific?.actor || {};
    const imageStem = stem(actor.primaryImage || entry.name);
    const image = imageByStem.get(imageStem) || imageByStem.get(stem(entry.name));
    actors.push({
      name: cleanName(entry.name),
      rel: entry.rel,
      primaryImage: actor.primaryImage || "",
      primaryImageRel: actor.primaryImageRel || image?.rel || "",
      imageInfo: image?.info || compactGifInfo(actor.imageInfo),
      streamOffset: actor.streamOffset || "",
      streamLength: actor.streamLength || 0,
      imageMatchReason: actor.header?.imageMatchReason || "",
      imageMatchScore: actor.header?.imageMatchScore ?? null,
    });
  }
  return actors.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
}

async function buildSceneAnchor(core) {
  const preferred = core.findResource("guangmingshendian.sce") || core.listResources({ ext: ".sce", limit: 1 })[0] || null;
  if (!preferred) return null;
  try {
    const runtime = await buildRuntimeSceneFromCore(core, preferred.rel);
    return {
      scene: runtime.scene?.name || cleanName(preferred.name),
      rel: preferred.rel,
      canvas: runtime.scene?.canvas || null,
      map: runtime.scene?.map ? {
        name: runtime.scene.map.name,
        rel: runtime.scene.map.rel,
        atlas: runtime.scene.map.renderHint?.atlas || runtime.scene.map.tileset || null,
        drawCandidateCount: runtime.scene.map.renderHint?.drawCandidates?.length || 0,
        rleCandidateCount: runtime.scene.map.renderHint?.rleCandidates?.length || 0,
        firstDrawCandidate: runtime.scene.map.renderHint?.drawCandidates?.[0] ? {
          key: runtime.scene.map.renderHint.drawCandidates[0].key,
          label: runtime.scene.map.renderHint.drawCandidates[0].label,
          records: runtime.scene.map.renderHint.drawCandidates[0].records,
          score: runtime.scene.map.renderHint.drawCandidates[0].score,
        } : null,
        firstRleCandidate: runtime.scene.map.renderHint?.rleCandidates?.[0] ? {
          key: runtime.scene.map.renderHint.rleCandidates[0].key,
          label: runtime.scene.map.renderHint.rleCandidates[0].label,
          score: runtime.scene.map.renderHint.rleCandidates[0].score,
        } : null,
        tileGridCandidate: runtime.scene.map.renderHint?.tileGridCandidate
          ? {
              columns: runtime.scene.map.renderHint.tileGridCandidate.columns,
              rows: runtime.scene.map.renderHint.tileGridCandidate.rows,
              hiddenByDefault: true,
            }
          : null,
      } : null,
      entities: (runtime.entities || []).map((entity) => ({
        id: entity.id,
        actor: entity.actor?.name || "",
        image: entity.actor?.primaryImage || "",
        x: entity.x,
        y: entity.y,
      })),
      scripts: runtime.scene?.scripts || [],
    };
  } catch (err) {
    return { scene: cleanName(preferred.name), rel: preferred.rel, error: err.message };
  }
}

function assetLine(asset) {
  const info = asset.info;
  const size = info ? `${info.width}x${info.height}` : "-";
  const timing = info?.dominantDelayCentiseconds
    ? ` delay=${info.dominantDelayCentiseconds}cs~${info.nominalFps}fps`
    : "";
  return `- ${asset.cleanName} (${size}, frames=${info?.frames ?? "-"}) score=${asset.match?.score ?? "-"} hits=${(asset.match?.hits || []).join(",") || "-"}${timing}`;
}

function textReport(report) {
  const lines = [];
  lines.push("# CBE UI/Visual Asset Probe");
  lines.push("");
  lines.push(`input=${report.input}`);
  lines.push(`resources=${report.resourceCount} images=${report.imageCount} actors=${report.actorCount}`);
  lines.push("");
  lines.push("## Device Reference Observations");
  for (const item of report.referenceObservations) {
    lines.push(`- ${item.id} [${item.status}]: ${item.observation}`);
    lines.push(`  implication: ${item.implication}`);
  }
  lines.push("");
  lines.push("## Timing Evidence");
  lines.push(`graphicControlGifs=${report.timing.graphicControlGifCount} multiFrameGifs=${report.timing.multiFrameGifCount} positiveDelayGifs=${report.timing.positiveDelayGifCount}`);
  lines.push(`delayHistogram=${report.timing.delayHistogram.map((row) => `${row.delayCentiseconds}cs:${row.assetCount}@${row.approximateFps || "-"}fps`).join(" ") || "-"}`);
  lines.push(`timingConclusion=${report.timing.conclusion}`);
  lines.push("");
  if (report.sceneAnchor) {
    lines.push("## Scene Anchor");
    lines.push(`scene=${report.sceneAnchor.scene} rel=${report.sceneAnchor.rel}`);
    if (report.sceneAnchor.canvas) lines.push(`canvas=${report.sceneAnchor.canvas.width}x${report.sceneAnchor.canvas.height}`);
    if (report.sceneAnchor.map) {
      const map = report.sceneAnchor.map;
      lines.push(`map=${map.name} rel=${map.rel} atlas=${map.atlas?.name || map.atlas || "-"} drawCandidates=${map.drawCandidateCount} rleCandidates=${map.rleCandidateCount}`);
      if (map.firstDrawCandidate) lines.push(`firstDrawCandidate=${map.firstDrawCandidate.key} records=${map.firstDrawCandidate.records} score=${map.firstDrawCandidate.score}`);
      if (map.firstRleCandidate) lines.push(`firstRleCandidate=${map.firstRleCandidate.key} score=${map.firstRleCandidate.score}`);
      if (map.tileGridCandidate) {
        lines.push(`tileGridCandidate=${map.tileGridCandidate.columns}x${map.tileGridCandidate.rows} hiddenByDefault=${map.tileGridCandidate.hiddenByDefault}`);
      }
    }
    for (const entity of (report.sceneAnchor.entities || []).slice(0, 8)) {
      lines.push(`entity=${entity.actor || entity.id} image=${entity.image || "-"} @${entity.x},${entity.y}`);
    }
    lines.push("");
  }
  lines.push("## Screenshot-Grounded Asset Candidates");
  for (const category of report.categories) {
    lines.push(`### ${category.label}`);
    lines.push(category.note);
    for (const asset of category.candidates.slice(0, 18)) lines.push(assetLine(asset));
    lines.push("");
  }
  lines.push("## Actor/Image Links");
  for (const actor of report.actorImageLinks.slice(0, 40)) {
    const info = actor.imageInfo;
    const size = info ? `${info.width}x${info.height}` : "-";
    lines.push(`- ${actor.name} -> ${actor.primaryImage || actor.primaryImageRel || "-"} (${size}) stream=${actor.streamOffset || "-"} len=${actor.streamLength || "-"}`);
  }
  lines.push("");
  return lines.join("\n");
}

async function probe(input, outDir) {
  const core = new CbeRuntimeCore({ input });
  const images = [];
  for (const entry of core.listResources({ kind: "image" })) {
    const resource = core.readResource(entry);
    const info = compactGifInfo(extOf(entry.name) === ".gif" ? parseGifInfoBuffer(resource.fixed) : null);
    images.push({
      section: entry.section,
      index: entry.index,
      name: entry.name,
      cleanName: cleanName(entry.name),
      rel: entry.rel,
      ext: entry.ext,
      rawSize: entry.rawSize,
      fixedSize: resource.fixed.length,
      fixupNote: resource.fixupNote || "",
      info,
    });
  }
  const imageByStem = new Map(images.map((asset) => [stem(asset.name), asset]));
  const categories = CATEGORY_RULES.map((rule) => ({
    id: rule.id,
    label: rule.label,
    note: rule.note,
    candidates: topCandidates(images, rule),
  }));
  const graphicControlAssets = images.filter((asset) => (asset.info?.graphicControls || 0) > 0);
  const multiFrameAssets = images.filter((asset) => (asset.info?.frames || 0) > 1);
  const positiveDelayAssets = images.filter((asset) => (asset.info?.uniqueDelaysCentiseconds || []).some((delay) => delay > 0));
  const timingHistogram = delayHistogram(images);
  const positiveDelayHistogram = timingHistogram.filter((row) => row.delayCentiseconds > 0);
  const timingConclusion = positiveDelayHistogram.length
    ? "Positive GIF delays would only describe image-container timing; actor/map animation still needs engine evidence."
    : "All observed GIF control delays are 0cs, so these files behave as static sprite/terrain atlases; keep 15fps as an actor/map engine hypothesis.";
  const links = actorImageLinks(core, imageByStem);
  const sceneAnchor = await buildSceneAnchor(core);
  const report = {
    schema: "nicai.cbe.uiAssetProbe.v1",
    generatedAt: new Date().toISOString(),
    input: core.input,
    resourceCount: core.catalog.length,
    imageCount: images.length,
    actorCount: links.length,
    referenceObservations: REFERENCE_OBSERVATIONS,
    timing: {
      graphicControlGifCount: graphicControlAssets.length,
      multiFrameGifCount: multiFrameAssets.length,
      positiveDelayGifCount: positiveDelayAssets.length,
      delayHistogram: timingHistogram,
      positiveDelayHistogram,
      sampleGraphicControlAssets: graphicControlAssets.slice(0, 24),
      samplePositiveDelayAssets: positiveDelayAssets.slice(0, 24),
      hypothesis: {
        targetFps: 15,
        status: "unverified-reference-hypothesis",
        source: "device/video observation supplied by user",
      },
      conclusion: timingConclusion,
    },
    sceneAnchor,
    categories,
    actorImageLinks: links,
    images,
  };

  await fsp.mkdir(outDir, { recursive: true });
  await fsp.writeFile(path.join(outDir, "ui_asset_probe.json"), JSON.stringify(report, null, 2), "utf8");
  await fsp.writeFile(path.join(outDir, "ui_asset_probe.md"), textReport(report), "utf8");
  return report;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    usage();
    return;
  }
  const input = path.resolve(args[0] || DEFAULT_INPUT);
  const outDir = path.resolve(args[1] || DEFAULT_OUT);
  const report = await probe(input, outDir);
  console.log("cbe-ui-asset-probe-ready");
  console.log(`Input: ${report.input}`);
  console.log(`Output: ${outDir}`);
  console.log(`Images: ${report.imageCount}`);
  console.log(`Actors: ${report.actorCount}`);
  console.log(`Graphic-control GIFs: ${report.timing.graphicControlGifCount}`);
  console.log(`Positive-delay GIFs: ${report.timing.positiveDelayGifCount}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.stack || err.message || String(err));
    process.exitCode = 1;
  });
}

module.exports = {
  probe,
};
