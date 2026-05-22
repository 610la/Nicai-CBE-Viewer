const fs = require("fs");
const path = require("path");
const { DEFAULT_INPUT } = require("./cbe_unpack");
const { CbeRuntimeCore } = require("./cbe_runtime_core");
const { buildRuntimeSceneFromCore } = require("./cbe_runtime");
const { createInitialState, frameFromState, stepState } = require("./cbe_emulator");

const DEFAULT_INPUT_DIR = path.resolve(__dirname, "..", "cbe file");
const DEFAULT_OUT = path.resolve(__dirname, "out_cbe_runtime_core_scene");
const DEFAULT_ACTIONS = ["confirm", "confirm", "confirm", "confirm"];
const DEFAULT_INPUT_ACTIONS = ["right", "down", "left", "up", "center"];

function mdRow(values) {
  return `| ${values.map((value) => String(value ?? "").replace(/\|/g, "\\|")).join(" | ")} |`;
}

function listCbeFiles(input) {
  const resolved = path.resolve(input || DEFAULT_INPUT_DIR);
  const stat = fs.statSync(resolved);
  if (stat.isFile()) return [resolved];
  return fs.readdirSync(resolved)
    .filter((name) => /\.cbe$/i.test(name))
    .sort((a, b) => a.localeCompare(b, "zh-Hans-CN"))
    .map((name) => path.join(resolved, name));
}

function runActions(runtime, actions = DEFAULT_ACTIONS) {
  let state = createInitialState(runtime);
  const frames = [{ state, frame: frameFromState(runtime, state) }];
  for (const action of actions) {
    state = stepState(runtime, state, { action });
    frames.push({ action, state, frame: frameFromState(runtime, state) });
  }
  return {
    state,
    frame: frameFromState(runtime, state),
    frames,
  };
}

function chooseAnchorScene(core, game, scenes) {
  if (game === "众神之战") return core.findResource("guangmingshendian.sce") || scenes[0] || null;
  return scenes[0] || null;
}

async function summarizeSceneResource(core, game, scene, actions = DEFAULT_ACTIONS) {
  const runtime = await buildRuntimeSceneFromCore(core, scene.rel, { game });
  const emu = runActions(runtime, actions);
  const inputSmoke = runActions(runtime, [...actions, ...DEFAULT_INPUT_ACTIONS]);
  const mapHint = runtime.scene?.map?.renderHint || null;
  return {
    scene: scene.name,
    sceneRel: scene.rel,
    status: "core-scene-emulator-ready",
    runtimeMode: runtime.source?.mode || "",
    canvas: runtime.scene?.canvas || null,
    mapName: runtime.scene?.map?.name || "",
    mapRel: runtime.scene?.map?.rel || "",
    mapRecordSource: runtime.scene?.map?.record?.source || "",
    tileset: runtime.scene?.map?.tileset || "",
    mapTraceStatus: mapHint?.status || "",
    mapTraceAtlas: mapHint?.atlas?.name || "",
    mapTraceAtlasRel: mapHint?.atlas?.rel || "",
    mapTraceAtlasSize: mapHint?.atlas?.size || null,
    mapDrawStreamOffset: mapHint?.drawStreamOffset || "",
    mapDrawCandidateCount: mapHint?.drawCandidates?.length || 0,
    mapRleCandidateCount: mapHint?.rleCandidates?.length || 0,
    mapTileGridCandidate: Boolean(mapHint?.tileGridCandidate?.tileCells?.length),
    mapTileGridCellCount: mapHint?.tileGridCandidate?.tileCells?.length || 0,
    mapTemplateCandidate: mapHint?.mapTemplateProbe?.best?.score != null ? mapHint.mapTemplateProbe.best.score : null,
    entityCount: runtime.entities?.length || 0,
    scriptCount: runtime.scene?.scripts?.length || 0,
    bootFlowStepCount: runtime.bootFlow?.steps?.length || 0,
    bootFlowStatus: runtime.bootFlow?.status || "",
    initialMode: createInitialState(runtime).mode,
    finalMode: emu.state.mode,
    finalFrameKind: emu.frame.kind,
    finalTick: emu.state.tick,
    frameCount: emu.frames.length,
    inputSmokeActions: DEFAULT_INPUT_ACTIONS,
    inputFinalMode: inputSmoke.state.mode,
    inputFinalFrameKind: inputSmoke.frame.kind,
    inputFinalTick: inputSmoke.state.tick,
    inputCamera: inputSmoke.state.camera || null,
  };
}

async function summarizeSceneGame(file, options = {}) {
  const actions = options.actions || DEFAULT_ACTIONS;
  const game = path.basename(file, path.extname(file));
  const core = new CbeRuntimeCore({ input: file });
  const source = core.sourceSummary();
  const scenes = core.listResources({ ext: ".sce" });
  const anchorScene = chooseAnchorScene(core, game, scenes);
  if (!anchorScene) {
    return {
      file,
      game,
      status: "no-scene",
      resourceCount: source.resourceCount,
      sectionCount: source.sectionCount,
      sceneCount: 0,
    };
  }
  const sceneResults = [];
  for (const scene of scenes) {
    try {
      sceneResults.push(await summarizeSceneResource(core, game, scene, actions));
    } catch (err) {
      sceneResults.push({
        scene: scene.name,
        sceneRel: scene.rel,
        status: "core-scene-emulator-error",
        error: err.message || String(err),
      });
    }
  }
  const readyScenes = sceneResults.filter((scene) => scene.status === "core-scene-emulator-ready");
  const sceneErrors = sceneResults.filter((scene) => scene.status === "core-scene-emulator-error");
  const anchorResult = sceneResults.find((scene) => scene.sceneRel === anchorScene.rel) || sceneResults[0] || {};
  return {
    file,
    game,
    status: sceneErrors.length ? "core-scene-emulator-risk" : "core-scene-emulator-ready",
    resourceCount: source.resourceCount,
    sectionCount: source.sectionCount,
    sceneCount: scenes.length,
    readySceneCount: readyScenes.length,
    sceneErrorCount: sceneErrors.length,
    firstScene: anchorResult.scene || anchorScene.name,
    firstSceneRel: anchorResult.sceneRel || anchorScene.rel,
    runtimeMode: anchorResult.runtimeMode || "",
    canvas: anchorResult.canvas || null,
    mapName: anchorResult.mapName || "",
    mapRel: anchorResult.mapRel || "",
    tileset: anchorResult.tileset || "",
    mapTraceStatus: anchorResult.mapTraceStatus || "",
    mapTraceAtlas: anchorResult.mapTraceAtlas || "",
    mapDrawCandidateCount: anchorResult.mapDrawCandidateCount || 0,
    mapRleCandidateCount: anchorResult.mapRleCandidateCount || 0,
    mapTileGridCandidate: Boolean(anchorResult.mapTileGridCandidate),
    mapTileGridCellCount: anchorResult.mapTileGridCellCount || 0,
    entityCount: anchorResult.entityCount || 0,
    scriptCount: anchorResult.scriptCount || 0,
    bootFlowStepCount: anchorResult.bootFlowStepCount || 0,
    bootFlowStatus: anchorResult.bootFlowStatus || "",
    initialMode: anchorResult.initialMode || "",
    finalMode: anchorResult.finalMode || "",
    finalFrameKind: anchorResult.finalFrameKind || "",
    finalTick: anchorResult.finalTick || 0,
    frameCount: anchorResult.frameCount || 0,
    inputFinalMode: anchorResult.inputFinalMode || "",
    inputFinalFrameKind: anchorResult.inputFinalFrameKind || "",
    inputFinalTick: anchorResult.inputFinalTick || 0,
    inputCamera: anchorResult.inputCamera || null,
    sceneResults,
  };
}

function buildInvariant(id, passed, details, impact = "") {
  return { id, passed: Boolean(passed), details, impact };
}

function countWhere(items, predicate) {
  return (items || []).filter(predicate).length;
}

function summarizeCompatibilityGame(game) {
  const scenes = game.sceneResults || [];
  const readyScenes = scenes.filter((scene) => scene.status === "core-scene-emulator-ready");
  const countReady = (predicate) => countWhere(readyScenes, predicate);
  return {
    game: game.game || "",
    status: game.status || "",
    sceneCount: game.sceneCount || 0,
    readySceneCount: game.readySceneCount || readyScenes.length,
    canvasSceneCount: countReady((scene) => scene.canvas?.width && scene.canvas?.height),
    finalSceneFrameCount: countReady((scene) => scene.finalFrameKind === "scene"),
    inputSceneFrameCount: countReady((scene) => scene.inputFinalFrameKind === "scene"),
    mapLinkedSceneCount: countReady((scene) => Boolean(scene.mapName)),
    mapTableSceneCount: countReady((scene) => scene.mapRecordSource === "map-table"),
    lengthPrefixedMapSceneCount: countReady((scene) => scene.mapRecordSource === "length-prefixed-ref"),
    tilesetLinkedSceneCount: countReady((scene) => Boolean(scene.tileset)),
    mapTraceSceneCount: countReady((scene) => Boolean(scene.mapTraceStatus)),
    mapAtlasSizedSceneCount: countReady((scene) => Boolean(scene.mapTraceAtlasSize?.width && scene.mapTraceAtlasSize?.height)),
    mapDrawCandidateSceneCount: countReady((scene) => (scene.mapDrawCandidateCount || 0) > 0),
    mapRleCandidateSceneCount: countReady((scene) => (scene.mapRleCandidateCount || 0) > 0),
    mapTileGridCandidateSceneCount: countReady((scene) => Boolean(scene.mapTileGridCandidate)),
    entitySceneCount: countReady((scene) => (scene.entityCount || 0) > 0),
    scriptLinkedSceneCount: countReady((scene) => (scene.scriptCount || 0) > 0),
    bootFlowSceneCount: countReady((scene) => (scene.bootFlowStepCount || 0) > 0),
    maxEntityCount: Math.max(0, ...readyScenes.map((scene) => scene.entityCount || 0)),
    maxScriptCount: Math.max(0, ...readyScenes.map((scene) => scene.scriptCount || 0)),
  };
}

function buildCompatibility(games) {
  const gameRows = (games || [])
    .filter((game) => game.sceneCount > 0)
    .map(summarizeCompatibilityGame);
  const sum = (field) => gameRows.reduce((total, game) => total + (game[field] || 0), 0);
  return {
    schema: "nicai.cbe.runtimeCoreSceneCompatibility.v1",
    corpus: {
      sceneGameCount: gameRows.length,
      sceneResourceCount: sum("sceneCount"),
      readySceneResourceCount: sum("readySceneCount"),
      canvasSceneCount: sum("canvasSceneCount"),
      finalSceneFrameCount: sum("finalSceneFrameCount"),
      inputSceneFrameCount: sum("inputSceneFrameCount"),
      mapLinkedSceneCount: sum("mapLinkedSceneCount"),
      mapTableSceneCount: sum("mapTableSceneCount"),
      lengthPrefixedMapSceneCount: sum("lengthPrefixedMapSceneCount"),
      tilesetLinkedSceneCount: sum("tilesetLinkedSceneCount"),
      mapTraceSceneCount: sum("mapTraceSceneCount"),
      mapAtlasSizedSceneCount: sum("mapAtlasSizedSceneCount"),
      mapDrawCandidateSceneCount: sum("mapDrawCandidateSceneCount"),
      mapRleCandidateSceneCount: sum("mapRleCandidateSceneCount"),
      mapTileGridCandidateSceneCount: sum("mapTileGridCandidateSceneCount"),
      entitySceneCount: sum("entitySceneCount"),
      scriptLinkedSceneCount: sum("scriptLinkedSceneCount"),
      bootFlowSceneCount: sum("bootFlowSceneCount"),
    },
    games: gameRows,
    notes: [
      "ready/canvas/frame/input are generic core emulator gates",
      "map/tileset/entity/script/bootFlow are resource-link coverage gates, not proof of VM behavior",
      "mapTrace/atlas/draw/rle/tileGrid count raw-CBE buffer map analysis and diagnostic tile candidates, not final terrain execution",
      "collision remains canvas-bounds only until map bytecode semantics are promoted",
    ],
  };
}

async function buildReport(options = {}) {
  const inputDir = path.resolve(options.inputDir || DEFAULT_INPUT_DIR);
  const outDir = path.resolve(options.outDir || DEFAULT_OUT);
  const actions = options.actions || DEFAULT_ACTIONS;
  const files = listCbeFiles(inputDir);
  const games = [];
  for (const file of files) {
    try {
      games.push(await summarizeSceneGame(file, { actions }));
    } catch (err) {
      games.push({
        file,
        game: path.basename(file, path.extname(file)),
        status: /No CBE resource sections found/i.test(err.message || String(err))
          ? "unsupported-or-nonstandard"
          : "core-scene-emulator-error",
        error: err.message || String(err),
      });
    }
  }
  const readyCore = games.filter((game) => game.status !== "core-scene-emulator-error");
  const sceneGames = games.filter((game) => game.sceneCount > 0 || game.status === "core-scene-emulator-ready");
  const readySceneGames = games.filter((game) => game.status === "core-scene-emulator-ready");
  const sceneErrors = games.filter((game) => game.status === "core-scene-emulator-error");
  const sceneResourceCount = sceneGames.reduce((sum, game) => sum + (game.sceneCount || 0), 0);
  const readySceneResourceCount = sceneGames.reduce((sum, game) => sum + (game.readySceneCount || 0), 0);
  const sceneResourceErrorCount = sceneGames.reduce((sum, game) => sum + (game.sceneErrorCount || 0), 0);
  const sceneResults = sceneGames.flatMap((game) => game.sceneResults || []);
  const finalSceneFrames = sceneResults.filter((scene) => scene.status === "core-scene-emulator-ready" && scene.finalFrameKind === "scene");
  const inputSceneFrames = sceneResults.filter((scene) => scene.status === "core-scene-emulator-ready" && scene.inputFinalFrameKind === "scene");
  const canvasReady = sceneResults.filter((scene) => scene.status === "core-scene-emulator-ready" && scene.canvas?.width && scene.canvas?.height);
  const godwar = readySceneGames.find((game) => game.game === "众神之战") || null;
  const compatibility = buildCompatibility(games);
  const invariants = [
    buildInvariant(
      "core-scene-probe-covers-scene-games",
      sceneErrors.length === 0 && sceneResourceErrorCount === 0 && readySceneGames.length === sceneGames.length,
      `${readySceneGames.length}/${sceneGames.length} scene-bearing CBE file(s) and ${readySceneResourceCount}/${sceneResourceCount} scene resource(s) reached a core runtime scene; errors=${sceneResourceErrorCount}`,
      "The generic core scene builder should not be a single-title path."
    ),
    buildInvariant(
      "core-scene-probe-produces-canvas",
      canvasReady.length === readySceneResourceCount,
      `${canvasReady.length}/${readySceneResourceCount} core runtime scene resource(s) expose canvas dimensions`,
      "A browser emulator needs stable scene dimensions before rendering or input."
    ),
    buildInvariant(
      "core-scene-emulator-produces-frames",
      finalSceneFrames.length === readySceneResourceCount,
      `${finalSceneFrames.length}/${readySceneResourceCount} core emulator run(s) ended on scene frame`,
      "Core-native runtime snapshots must be consumable by the shared emulator state/frame machine."
    ),
    buildInvariant(
      "core-scene-input-smoke-stays-scene",
      inputSceneFrames.length === readySceneResourceCount,
      `${inputSceneFrames.length}/${readySceneResourceCount} core emulator input smoke run(s) stayed on scene frame`,
      "The generic web emulator must accept baseline directional/center inputs after scene entry."
    ),
    buildInvariant(
      "core-maptrace-covers-linked-maps",
      compatibility.corpus.mapTraceSceneCount === compatibility.corpus.mapLinkedSceneCount,
      `${compatibility.corpus.mapTraceSceneCount}/${compatibility.corpus.mapLinkedSceneCount} map-linked scene(s) produced raw-CBE buffer map trace hints; atlas=${compatibility.corpus.mapAtlasSizedSceneCount}, drawCandidates=${compatibility.corpus.mapDrawCandidateSceneCount}, rleCandidates=${compatibility.corpus.mapRleCandidateSceneCount}, tileGrid=${compatibility.corpus.mapTileGridCandidateSceneCount}`,
      "Map rendering work should advance through raw CBE resources rather than unpacked-file assumptions."
    ),
    buildInvariant(
      "godwar-anchor-core-runtime-parity",
      Boolean(godwar && godwar.canvas?.width === 480 && godwar.canvas?.height === 528 && godwar.entityCount === 3 && godwar.scriptCount === 1),
      godwar ? `canvas=${godwar.canvas?.width || 0}x${godwar.canvas?.height || 0}, entities=${godwar.entityCount}, scripts=${godwar.scriptCount}` : "godwar row missing",
      "The corpus probe must preserve the known anchor scene while checking broader CBE coverage."
    ),
  ];
  const failures = invariants.filter((item) => !item.passed);
  return {
    schema: "nicai.cbe.runtimeCoreSceneProbe.v1",
    generatedAt: new Date().toISOString(),
    inputDir,
    output: {
      outDir,
    },
    actions,
    games,
    compatibility,
    counts: {
      fileCount: games.length,
      coreReadyCount: readyCore.length,
      sceneGameCount: sceneGames.length,
      readySceneGameCount: readySceneGames.length,
      sceneErrorCount: sceneErrors.length,
      sceneResourceCount,
      readySceneResourceCount,
      sceneResourceErrorCount,
      canvasReadyCount: canvasReady.length,
      finalSceneFrameCount: finalSceneFrames.length,
      inputSceneFrameCount: inputSceneFrames.length,
    },
    invariants,
    summary: {
      status: failures.length ? "cbe-runtime-core-scene-risk" : "cbe-runtime-core-scene-ready",
      currentFinding: `Core-native scene/emulator path built ${readySceneResourceCount}/${sceneResourceCount} scene resource(s) across ${readySceneGames.length}/${sceneGames.length} scene-bearing CBE file(s), produced ${finalSceneFrames.length} scene frame(s) after ${actions.length} action(s), kept ${inputSceneFrames.length} input smoke run(s) on scene frames, and analyzed ${compatibility.corpus.mapTraceSceneCount}/${compatibility.corpus.mapLinkedSceneCount} linked map stream(s).`,
      emulatorImpact: "This checks the generic CBE web-emulator path across the corpus: raw archive -> CbeRuntimeCore -> buildRuntimeSceneFromCore -> emulator state/frame.",
      nextTarget: "Promote raw-CBE map trace hints into a conservative renderer, then move control and collision internals onto CbeRuntimeCore.",
      visibleEffectsEnabled: false,
      failureCount: failures.length,
      sceneGameCount: sceneGames.length,
      readySceneGameCount: readySceneGames.length,
      sceneResourceCount,
      readySceneResourceCount,
      finalSceneFrameCount: finalSceneFrames.length,
      inputSceneFrameCount: inputSceneFrames.length,
      mapLinkedSceneCount: compatibility.corpus.mapLinkedSceneCount,
      mapTraceSceneCount: compatibility.corpus.mapTraceSceneCount,
      mapAtlasSizedSceneCount: compatibility.corpus.mapAtlasSizedSceneCount,
      mapDrawCandidateSceneCount: compatibility.corpus.mapDrawCandidateSceneCount,
      mapRleCandidateSceneCount: compatibility.corpus.mapRleCandidateSceneCount,
      mapTileGridCandidateSceneCount: compatibility.corpus.mapTileGridCandidateSceneCount,
    },
  };
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# CBE Runtime Core Scene Probe");
  lines.push("");
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Corpus: \`${report.inputDir}\``);
  lines.push(`- Status: ${report.summary.status}`);
  lines.push(`- Finding: ${report.summary.currentFinding}`);
  lines.push(`- Emulator impact: ${report.summary.emulatorImpact}`);
  lines.push(`- Next target: ${report.summary.nextTarget}`);
  lines.push("");
  lines.push("## Counts");
  lines.push("");
  lines.push(mdRow(["Field", "Value"]));
  lines.push(mdRow(["---", "---:"]));
  for (const [key, value] of Object.entries(report.counts)) lines.push(mdRow([key, value]));
  lines.push("");
  lines.push("## Scene Games");
  lines.push("");
  lines.push(mdRow(["Game", "Status", "Scenes", "Ready", "First Scene", "Canvas", "Map", "Entities", "Scripts", "Initial", "Final", "Input", "Error"]));
  lines.push(mdRow(["---", "---", "---:", "---:", "---", "---", "---", "---:", "---:", "---", "---", "---", "---"]));
  for (const game of report.games.filter((row) => row.sceneCount > 0 || row.status !== "no-scene")) {
    lines.push(mdRow([
      game.game,
      game.status,
      game.sceneCount || "",
      game.readySceneCount ?? "",
      game.firstScene || "",
      game.canvas ? `${game.canvas.width}x${game.canvas.height}` : "",
      game.mapName || "",
      game.entityCount ?? "",
      game.scriptCount ?? "",
      game.initialMode || "",
      `${game.finalMode || ""}/${game.finalFrameKind || ""}`,
      `${game.inputFinalMode || ""}/${game.inputFinalFrameKind || ""}`,
      game.error || "",
    ]));
  }
  const sceneErrors = report.games.flatMap((game) => (game.sceneResults || [])
    .filter((scene) => scene.status === "core-scene-emulator-error")
    .map((scene) => ({ game: game.game, ...scene })));
  if (sceneErrors.length) {
    lines.push("");
    lines.push("## Scene Errors");
    lines.push("");
    lines.push(mdRow(["Game", "Scene", "Error"]));
    lines.push(mdRow(["---", "---", "---"]));
    for (const scene of sceneErrors) lines.push(mdRow([scene.game, scene.scene, scene.error || ""]));
  }
  lines.push("");
  lines.push("## Compatibility Matrix");
  lines.push("");
  lines.push(mdRow(["Game", "Scenes", "Ready", "Canvas", "Frame", "Input", "Map", "Map Table", "Map Ref", "Tileset", "Map Trace", "Atlas", "Draw", "RLE", "Tile Grid", "Entity Scenes", "Script Scenes", "Boot Flow"]));
  lines.push(mdRow(["---", "---:", "---:", "---:", "---:", "---:", "---:", "---:", "---:", "---:", "---:", "---:", "---:", "---:", "---:", "---:", "---:", "---:"]));
  for (const game of report.compatibility?.games || []) {
    lines.push(mdRow([
      game.game,
      game.sceneCount,
      game.readySceneCount,
      game.canvasSceneCount,
      game.finalSceneFrameCount,
      game.inputSceneFrameCount,
      game.mapLinkedSceneCount,
      game.mapTableSceneCount,
      game.lengthPrefixedMapSceneCount,
      game.tilesetLinkedSceneCount,
      game.mapTraceSceneCount,
      game.mapAtlasSizedSceneCount,
      game.mapDrawCandidateSceneCount,
      game.mapRleCandidateSceneCount,
      game.mapTileGridCandidateSceneCount,
      game.entitySceneCount,
      game.scriptLinkedSceneCount,
      game.bootFlowSceneCount,
    ]));
  }
  lines.push("");
  lines.push("## Invariants");
  lines.push("");
  lines.push(mdRow(["Invariant", "Pass", "Details", "Impact"]));
  lines.push(mdRow(["---", "---", "---", "---"]));
  for (const invariant of report.invariants) {
    lines.push(mdRow([invariant.id, invariant.passed ? "yes" : "no", invariant.details, invariant.impact]));
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

async function main(argv = process.argv.slice(2)) {
  const inputDir = path.resolve(argv[0] || DEFAULT_INPUT_DIR);
  const outDir = path.resolve(argv[1] || DEFAULT_OUT);
  fs.mkdirSync(outDir, { recursive: true });
  const report = await buildReport({ inputDir, outDir });
  const jsonFile = path.join(outDir, "cbe_runtime_core_scene_probe.json");
  const mdFile = path.join(outDir, "cbe_runtime_core_scene_probe.md");
  fs.writeFileSync(jsonFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  fs.writeFileSync(mdFile, renderMarkdown(report), "utf8");
  console.log(`wrote ${jsonFile}`);
  console.log(`wrote ${mdFile}`);
  console.log(`${report.summary.status}: ${report.summary.currentFinding}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.stack || err.message || String(err));
    process.exitCode = 1;
  });
}

module.exports = {
  buildReport,
  renderMarkdown,
};
