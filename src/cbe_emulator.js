const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { buildRuntimeScene } = require("./cbe_runtime");

const DEFAULT_STEP = 16;
const LOADING_TICKS = 2;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function cleanAction(input) {
  if (typeof input === "string") return input.toLowerCase();
  return String(input?.action || input?.key || "").toLowerCase();
}

function entityStateFromRuntime(runtime) {
  return (runtime?.entities || []).map((entity) => ({
    id: entity.id,
    name: entity.name,
    matched: entity.matched,
    x: entity.x || 0,
    y: entity.y || 0,
    direction: "down",
    controlled: entity.id === runtime?.control?.entityId,
  }));
}

function bootSteps(runtime) {
  return Array.isArray(runtime?.bootFlow?.steps) ? runtime.bootFlow.steps : [];
}

function createInitialState(runtime) {
  const steps = bootSteps(runtime);
  const mode = steps.length ? "bootFlow" : runtime?.boot ? "boot" : "scene";
  return {
    schema: "nicai.cbe.emulatorState.v1",
    tick: 0,
    mode,
    bootStep: 0,
    routeChoice: steps.find((step) => step.mode === "choice")?.choices?.[0]?.id || "",
    screen: clone(runtime?.screen || { width: 240, height: 400 }),
    sceneRel: runtime?.scene?.rel || "",
    camera: clone(runtime?.camera || { x: 0, y: 0, width: 240, height: 400 }),
    controlledEntityId: runtime?.control?.entityId || "",
    entities: entityStateFromRuntime(runtime),
    collision: "canvas bounds only; map collision pending",
    loadingTicks: 0,
    lastInput: "",
  };
}

function sceneBounds(runtime, state) {
  const canvas = runtime?.scene?.canvas || state.screen;
  return {
    maxX: Math.max(0, (canvas.width || state.camera.width) - state.camera.width),
    maxY: Math.max(0, (canvas.height || state.camera.height) - state.camera.height),
  };
}

function panCamera(runtime, state, dx, dy) {
  const bounds = sceneBounds(runtime, state);
  return {
    ...state.camera,
    x: clamp((state.camera.x || 0) + dx, 0, bounds.maxX),
    y: clamp((state.camera.y || 0) + dy, 0, bounds.maxY),
  };
}

function controlledEntity(state) {
  if (!state?.controlledEntityId) return null;
  return (state.entities || []).find((entity) => entity.id === state.controlledEntityId) || null;
}

function directionFor(action) {
  return {
    left: "left",
    right: "right",
    up: "up",
    down: "down",
  }[action] || "down";
}

function followCamera(runtime, state, entity) {
  const bounds = sceneBounds(runtime, state);
  return {
    ...state.camera,
    x: clamp(Math.round((entity.x || 0) - state.camera.width / 2), 0, bounds.maxX),
    y: clamp(Math.round((entity.y || 0) - state.camera.height / 2), 0, bounds.maxY),
  };
}

function moveControlledEntity(runtime, state, action) {
  const entity = controlledEntity(state);
  if (!entity) return false;
  const step = runtime?.control?.step || DEFAULT_STEP;
  const canvas = runtime?.scene?.canvas || state.screen;
  const dx = action === "left" ? -step : action === "right" ? step : 0;
  const dy = action === "up" ? -step : action === "down" ? step : 0;
  entity.x = clamp((entity.x || 0) + dx, 0, Math.max(0, canvas.width || state.screen.width));
  entity.y = clamp((entity.y || 0) + dy, 0, Math.max(0, canvas.height || state.screen.height));
  entity.direction = directionFor(action);
  state.camera = followCamera(runtime, state, entity);
  return true;
}

function stepState(runtime, state, input = {}) {
  const action = cleanAction(input);
  const steps = bootSteps(runtime);
  const next = {
    ...clone(state || createInitialState(runtime)),
    tick: (state?.tick || 0) + 1,
    lastInput: action,
  };

  if (next.mode === "bootFlow") {
    const index = clamp(next.bootStep || 0, 0, Math.max(0, steps.length - 1));
    const step = steps[index] || null;
    if (action === "back") {
      if (index > 0) next.bootStep = index - 1;
      return next;
    }
    if (step?.mode === "choice" && ["left", "right"].includes(action)) {
      const choices = step.choices || [];
      const current = Math.max(0, choices.findIndex((choice) => choice.id === next.routeChoice));
      const delta = action === "left" ? -1 : 1;
      const choice = choices[clamp(current + delta, 0, Math.max(0, choices.length - 1))];
      next.routeChoice = choice?.id || next.routeChoice;
      return next;
    }
    if (["confirm", "start", "ok", "soft-right", "tick"].includes(action)) {
      if (index < steps.length - 1) {
        next.bootStep = index + 1;
      } else {
        next.mode = "scene";
      }
    }
    return next;
  }

  if (next.mode === "boot") {
    if (action === "confirm" || action === "start" || action === "ok" || action === "soft-right") {
      next.mode = runtime?.loading ? "loading" : "scene";
      next.loadingTicks = 0;
    }
    return next;
  }

  if (next.mode === "loading") {
    next.loadingTicks = (next.loadingTicks || 0) + 1;
    if (action === "tick" || next.loadingTicks >= LOADING_TICKS || !runtime?.loading) {
      next.mode = "scene";
    }
    return next;
  }

  if (next.mode === "scene") {
    if (action === "back" && runtime?.boot) {
      next.mode = "boot";
      next.loadingTicks = 0;
      return next;
    }
    if (["left", "right", "up", "down"].includes(action)) {
      if (!moveControlledEntity(runtime, next, action)) {
        if (action === "left") next.camera = panCamera(runtime, next, -DEFAULT_STEP, 0);
        if (action === "right") next.camera = panCamera(runtime, next, DEFAULT_STEP, 0);
        if (action === "up") next.camera = panCamera(runtime, next, 0, -DEFAULT_STEP);
        if (action === "down") next.camera = panCamera(runtime, next, 0, DEFAULT_STEP);
      }
    }
  }

  return next;
}

function entitiesForFrame(runtime, state) {
  const stateById = new Map((state?.entities || []).map((entity) => [entity.id, entity]));
  return (runtime?.entities || []).map((entity) => {
    const dynamic = stateById.get(entity.id);
    return {
      ...clone(entity),
      x: dynamic?.x ?? entity.x,
      y: dynamic?.y ?? entity.y,
      direction: dynamic?.direction || "down",
      controlled: entity.id === state?.controlledEntityId || Boolean(entity.controllable),
    };
  });
}

function imageFrame(kind, image) {
  return {
    kind,
    image: image ? {
      name: image.name,
      rel: image.rel,
      imageUrl: image.imageUrl || "",
      imageInfo: image.imageInfo || null,
    } : null,
  };
}

function bootFlowFrame(runtime, state) {
  const steps = bootSteps(runtime);
  const index = clamp(state.bootStep || 0, 0, Math.max(0, steps.length - 1));
  const step = steps[index] || null;
  return {
    kind: "bootFlow",
    stepIndex: index,
    stepCount: steps.length,
    step,
    routeChoice: state.routeChoice || "",
  };
}

function frameFromState(runtime, state) {
  if (state.mode === "bootFlow") return bootFlowFrame(runtime, state);
  if (state.mode === "boot") return imageFrame("boot", runtime?.boot);
  if (state.mode === "loading") return imageFrame("loading", runtime?.loading || runtime?.boot);
  return {
    kind: "scene",
    scene: {
      name: runtime?.scene?.name || "",
      rel: runtime?.scene?.rel || "",
      canvas: runtime?.scene?.canvas || null,
      map: runtime?.scene?.map || null,
    },
    camera: clone(state.camera),
    controlledEntityId: state.controlledEntityId || "",
    entities: entitiesForFrame(runtime, state),
  };
}

async function loadRuntime(input) {
  const file = path.resolve(input);
  if (path.extname(file).toLowerCase() === ".json") {
    return JSON.parse(await fsp.readFile(file, "utf8"));
  }
  return buildRuntimeScene(file);
}

async function main() {
  const args = process.argv.slice(2);
  const input = args[0] || path.join(process.cwd(), "out_verify_runtime_boot", "runtime_scene.json");
  const outDir = path.resolve(args[1] || path.join(process.cwd(), "out_godwar_emulator"));
  const actions = (args[2] || "confirm,confirm,confirm,confirm,right,down").split(",").map((item) => item.trim()).filter(Boolean);
  const runtime = await loadRuntime(input);
  const states = [];
  let state = createInitialState(runtime);
  states.push({ state: clone(state), frame: frameFromState(runtime, state) });
  for (const action of actions) {
    state = stepState(runtime, state, { action });
    states.push({ action, state: clone(state), frame: frameFromState(runtime, state) });
  }

  const snapshot = {
    schema: "nicai.cbe.emulatorSnapshot.v1",
    generatedAt: new Date().toISOString(),
    runtimeSource: runtime?.source || null,
    states,
  };
  await fsp.mkdir(outDir, { recursive: true });
  await fsp.writeFile(path.join(outDir, "emulator_snapshot.json"), JSON.stringify(snapshot, null, 2), "utf8");
  console.log(`Output: ${path.join(outDir, "emulator_snapshot.json")}`);
  console.log(`Frames: ${states.map((entry) => entry.frame.kind).join(" -> ")}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.stack || err.message || String(err));
    process.exitCode = 1;
  });
}

module.exports = {
  createInitialState,
  frameFromState,
  stepState,
};
