const path = require("path");

const STRUCTURAL_EXTS = new Set([".sce", ".map", ".actor", ".xse"]);
const IMAGE_EXTS = new Set([".gif", ".png", ".jpg", ".jpeg", ".bmp", ".webp"]);
const AUDIO_EXTS = new Set([".mp3", ".mid", ".wav", ".ogg"]);
const TEXT_EXTS = new Set([".txt", ".ini", ".json", ".xml", ".csv"]);

function extOf(name) {
  return path.extname(name || "").toLowerCase() || "(none)";
}

function addCount(map, key, by = 1) {
  map[key] = (map[key] || 0) + by;
}

function cleanName(name) {
  return path.basename(String(name || "").replace(/\\/g, "/")).replace(/^[0-9]{4}_/, "");
}

function classifyResource(name) {
  const ext = extOf(name);
  if (IMAGE_EXTS.has(ext)) return "image";
  if (AUDIO_EXTS.has(ext)) return "audio";
  if (STRUCTURAL_EXTS.has(ext)) return "structure";
  if (TEXT_EXTS.has(ext)) return "text";
  return "other";
}

function buildResourceProfile(entries) {
  const extCounts = {};
  const kindCounts = {};
  const structuralCounts = {};
  const samples = {};
  let totalRawBytes = 0;
  let largest = null;

  for (const entry of entries || []) {
    const ext = extOf(entry.name);
    const kind = classifyResource(entry.name);
    addCount(extCounts, ext);
    addCount(kindCounts, kind);
    if (STRUCTURAL_EXTS.has(ext)) addCount(structuralCounts, ext);
    if (!samples[ext]) samples[ext] = cleanName(entry.name);
    totalRawBytes += entry.size || 0;
    if (!largest || (entry.size || 0) > largest.size) {
      largest = {
        name: cleanName(entry.name),
        ext,
        size: entry.size || 0,
        offset: entry.offsetHex || "",
      };
    }
  }

  const hasScene = Boolean(structuralCounts[".sce"]);
  const hasMap = Boolean(structuralCounts[".map"]);
  const hasActor = Boolean(structuralCounts[".actor"]);
  const hasXse = Boolean(structuralCounts[".xse"]);
  const hasImage = (kindCounts.image || 0) > 0;
  const hasAudio = (kindCounts.audio || 0) > 0;

  return {
    extCounts,
    kindCounts,
    structuralCounts,
    samples,
    totalRawBytes,
    largest,
    capabilities: {
      archive: true,
      imagePreview: hasImage,
      audioPreview: hasAudio,
      sceneGraphEvidence: hasScene && hasMap,
      actorEvidence: hasActor,
      xseTraceVmCandidate: hasXse,
      rpgStack: hasScene && hasMap && hasActor && hasXse,
    },
    flags: {
      hasScene,
      hasMap,
      hasActor,
      hasXse,
      hasImage,
      hasAudio,
    },
  };
}

module.exports = {
  AUDIO_EXTS,
  IMAGE_EXTS,
  STRUCTURAL_EXTS,
  buildResourceProfile,
  classifyResource,
  cleanName,
  extOf,
};
