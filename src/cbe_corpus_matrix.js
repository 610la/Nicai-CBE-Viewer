const fs = require("fs");
const path = require("path");
const { fixupPayload, loadCbeArchive } = require("./cbe_unpack");
const { buildResourceProfile, extOf } = require("./cbe_profile");

const DEFAULT_INPUT_DIR = path.resolve(__dirname, "..", "cbe file");
const DEFAULT_OUT = path.resolve(process.cwd(), "out_cbe_corpus");

function addCount(map, key, by = 1) {
  map[key] = (map[key] || 0) + by;
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

function summarizeFixups(archive) {
  let fixedImages = 0;
  let fixedBytesDelta = 0;
  const samples = [];
  for (const entry of archive.entries) {
    const raw = archive.rawPayload(entry);
    const fixed = fixupPayload(entry.name, raw);
    if (!fixed.note) continue;
    fixedImages += 1;
    fixedBytesDelta += fixed.payload.length - raw.length;
    if (samples.length < 8) {
      samples.push({
        name: entry.name,
        note: fixed.note,
        rawSize: raw.length,
        fixedSize: fixed.payload.length,
      });
    }
  }
  return { fixedImages, fixedBytesDelta, samples };
}

function summarizeArchive(file) {
  const archive = loadCbeArchive(file);
  const profile = buildResourceProfile(archive.entries);
  const firstScene = archive.entries.find((entry) => extOf(entry.name) === ".sce") || null;
  const firstScript = archive.entries.find((entry) => extOf(entry.name) === ".xse") || null;
  const firstActor = archive.entries.find((entry) => extOf(entry.name) === ".actor") || null;
  const fixups = summarizeFixups(archive);
  return {
    file,
    game: path.basename(file, path.extname(file)),
    status: "standard-cbe",
    size: archive.size,
    sectionCount: archive.sections.length,
    resourceCount: archive.entries.length,
    totalRawBytes: profile.totalRawBytes,
    extCounts: profile.extCounts,
    kindCounts: profile.kindCounts,
    structuralCounts: profile.structuralCounts,
    capabilities: profile.capabilities,
    hasScene: profile.flags.hasScene,
    hasMap: profile.flags.hasMap,
    hasActor: profile.flags.hasActor,
    hasXse: profile.flags.hasXse,
    firstScene: firstScene?.name || "",
    firstScript: firstScript?.name || "",
    firstActor: firstActor?.name || "",
    largest: profile.largest,
    fixups,
  };
}

function buildReport(options = {}) {
  const input = path.resolve(options.input || DEFAULT_INPUT_DIR);
  const files = listCbeFiles(input);
  const games = [];
  for (const file of files) {
    try {
      games.push(summarizeArchive(file));
    } catch (err) {
      games.push({
        file,
        game: path.basename(file, path.extname(file)),
        status: "unsupported-or-nonstandard",
        error: err.message || String(err),
      });
    }
  }

  const globalExtCounts = {};
  for (const game of games) {
    for (const [ext, count] of Object.entries(game.extCounts || {})) {
      addCount(globalExtCounts, ext, count);
    }
  }
  const standardGames = games.filter((game) => game.status === "standard-cbe");
  const sceneGames = standardGames.filter((game) => game.hasScene);
  const xseGames = standardGames.filter((game) => game.hasXse);
  const actorGames = standardGames.filter((game) => game.hasActor);
  const mapGames = standardGames.filter((game) => game.hasMap);
  return {
    schema: "nicai.cbe.corpusMatrix.v1",
    generatedAt: new Date().toISOString(),
    input,
    summary: {
      fileCount: games.length,
      standardCount: standardGames.length,
      unsupportedCount: games.length - standardGames.length,
      totalResources: standardGames.reduce((sum, game) => sum + game.resourceCount, 0),
      sceneGameCount: sceneGames.length,
      mapGameCount: mapGames.length,
      actorGameCount: actorGames.length,
      xseGameCount: xseGames.length,
      globalExtCounts,
      currentFinding: `${standardGames.length}/${games.length} CBE files expose standard resource sections; ${sceneGames.length} include .sce scenes and ${xseGames.length} include .xse scripts.`,
      emulatorImpact: "The loader and web shell must stay corpus-first: not every valid CBE has the RPG-style .sce/.map/.actor/.xse stack, so compatibility must be feature-flagged by resource profile.",
      nextTarget: "Promote archive/image/resource listing into generic core APIs, then run scene/VM probes only for games whose resource profile supports them.",
    },
    games,
  };
}

function mdRow(cells) {
  return `| ${cells.map((cell) => String(cell ?? "").replace(/\|/g, "\\|")).join(" | ")} |`;
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# CBE Corpus Matrix");
  lines.push("");
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Input: \`${report.input}\``);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Status: ${report.summary.standardCount}/${report.summary.fileCount} standard CBE files`);
  lines.push(`- Finding: ${report.summary.currentFinding}`);
  lines.push(`- Emulator impact: ${report.summary.emulatorImpact}`);
  lines.push(`- Next target: ${report.summary.nextTarget}`);
  lines.push("");
  lines.push("## Extension Totals");
  lines.push("");
  const extRows = Object.entries(report.summary.globalExtCounts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  for (const [ext, count] of extRows) {
    lines.push(`- \`${ext}\`: ${count}`);
  }
  lines.push("");
  lines.push("## Games");
  lines.push("");
  lines.push(mdRow(["Game", "Status", "Sections", "Resources", "Scene/Map/Actor/XSE", "Fixups", "First scene", "Error"]));
  lines.push(mdRow(["---", "---", "---:", "---:", "---", "---:", "---", "---"]));
  for (const game of report.games) {
    const flags = game.status === "standard-cbe"
      ? `${game.hasScene ? "S" : "-"}${game.hasMap ? "M" : "-"}${game.hasActor ? "A" : "-"}${game.hasXse ? "X" : "-"}`
      : "-";
    lines.push(mdRow([
      game.game,
      game.status,
      game.sectionCount ?? "",
      game.resourceCount ?? "",
      flags,
      game.fixups?.fixedImages ?? "",
      game.firstScene || "",
      game.error || "",
    ]));
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

function main(argv = process.argv.slice(2)) {
  const input = path.resolve(argv[0] || DEFAULT_INPUT_DIR);
  const outDir = path.resolve(argv[1] || DEFAULT_OUT);
  fs.mkdirSync(outDir, { recursive: true });
  const report = buildReport({ input });
  const jsonFile = path.join(outDir, "cbe_corpus_matrix.json");
  const mdFile = path.join(outDir, "cbe_corpus_matrix.md");
  writeJson(jsonFile, report);
  fs.writeFileSync(mdFile, renderMarkdown(report), "utf8");
  console.log(`wrote ${jsonFile}`);
  console.log(`wrote ${mdFile}`);
  console.log(`${report.summary.standardCount}/${report.summary.fileCount} standard CBE files; ${report.summary.sceneGameCount} scene games; ${report.summary.xseGameCount} XSE games`);
}

if (require.main === module) {
  main();
}

module.exports = {
  buildReport,
  renderMarkdown,
};
