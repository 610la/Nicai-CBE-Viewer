let state = {
  index: null,
  selectedGame: null,
  selectedFile: null,
  kindFilter: "all",
  search: "",
  showErrors: false,
  previewToken: 0,
};

const el = (id) => document.getElementById(id);

const nodes = {
  summary: el("summary"),
  gameCount: el("gameCount"),
  gameList: el("gameList"),
  fileScope: el("fileScope"),
  fileCount: el("fileCount"),
  fileList: el("fileList"),
  previewTitle: el("previewTitle"),
  previewMeta: el("previewMeta"),
  previewBody: el("previewBody"),
  searchInput: el("searchInput"),
  errorsToggle: el("errorsToggle"),
  typeFilters: el("typeFilters"),
  refreshBtn: el("refreshBtn"),
};

const kinds = [
  ["all", "All"],
  ["image", "Images"],
  ["data", "Data"],
  ["text", "Text"],
  ["other", "Other"],
];

function fmtBytes(n) {
  if (!n && n !== 0) return "-";
  const units = ["B", "KB", "MB"];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  return `${v.toFixed(v < 10 && u ? 1 : 0)} ${units[u]}`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getGames() {
  if (!state.index) return [];
  return state.index.games.slice().sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
}

function getCurrentGame() {
  return getGames().find((g) => g.name === state.selectedGame) || getGames()[0] || null;
}

function getCurrentGameFiles() {
  return getCurrentGame()?.files || [];
}

function preferredFileForGame(game, files = game?.files || []) {
  if (!game || !files.length) return null;
  return files.find((file) => file.ext === ".sce") || files[0] || null;
}

function fileNameFromRel(rel) {
  return String(rel || "").split("/").pop() || "";
}

function displayNameFromRel(rel) {
  return fileNameFromRel(rel).replace(/^[0-9]{4}_/, "");
}

function stemOf(name) {
  return String(name || "")
    .replace(/^[0-9]{4}_/, "")
    .replace(/\.[^.]+$/, "")
    .toLowerCase();
}

function findCurrentFileByRel(rel) {
  return getCurrentGameFiles().find((file) => file.rel === rel) || null;
}

function findCurrentFileByName(name) {
  const target = String(name || "").toLowerCase();
  return getCurrentGameFiles().find((file) => file.name.toLowerCase() === target || displayNameFromRel(file.rel).toLowerCase() === target) || null;
}

function findSiblingByExt(file, ext) {
  const targetStem = stemOf(file.name);
  return getCurrentGameFiles().find((candidate) => candidate.ext === ext && stemOf(candidate.name) === targetStem) || null;
}

function assetUrlByName(name) {
  const file = findCurrentFileByName(name);
  return file ? `/asset?game=${encodeURIComponent(state.selectedGame)}&rel=${encodeURIComponent(file.rel)}` : "";
}

function readRoute() {
  const params = new URLSearchParams(window.location.search);
  return {
    game: params.get("game") || "",
    rel: params.get("rel") || "",
  };
}

function writeRoute() {
  const params = new URLSearchParams();
  if (state.selectedGame) params.set("game", state.selectedGame);
  if (state.selectedFile) params.set("rel", state.selectedFile);
  const next = `${window.location.pathname}?${params.toString()}`;
  window.history.replaceState(null, "", next);
}

function getFiles(game) {
  if (!game) return [];
  let files = game.files.slice();
  if (!state.showErrors) files = files.filter((f) => !f.skipped);
  if (state.kindFilter !== "all") files = files.filter((f) => f.kind === state.kindFilter);
  const q = state.search.trim().toLowerCase();
  if (q) files = files.filter((f) => `${f.name} ${f.rel}`.toLowerCase().includes(q));
  return files;
}

function renderGames() {
  const games = getGames();
  nodes.gameCount.textContent = `${games.length} games`;
  nodes.gameList.innerHTML = games.map((game) => {
    const active = game.name === state.selectedGame ? "active" : "";
    const error = game.error ? `<div class="game-error">${escapeHtml(game.error)}</div>` : "";
    const flags = game.profile?.flags || {};
    const capabilityText = [
      flags.hasScene ? "scene" : "",
      flags.hasMap ? "map" : "",
      flags.hasActor ? "actor" : "",
      flags.hasXse ? "xse" : "",
      flags.hasAudio ? "audio" : "",
    ].filter(Boolean).join(" · ") || "resources";
    return `
      <button class="game-row ${active}" data-game="${escapeHtml(game.name)}">
        <div class="game-name">${escapeHtml(game.name)}</div>
        <div class="game-stats">${game.files.length} files · ${escapeHtml(capabilityText)}</div>
        ${error}
      </button>
    `;
  }).join("");
}

function renderFilters() {
  nodes.typeFilters.innerHTML = kinds.map(([kind, label]) => {
    const active = kind === state.kindFilter ? "active" : "";
    return `<button class="chip ${active}" data-kind="${kind}">${label}</button>`;
  }).join("");
}

function previewThumb(file) {
  const src = `/asset?game=${encodeURIComponent(state.selectedGame)}&rel=${encodeURIComponent(file.rel)}`;
  if (file.kind === "image") {
    return `<div class="hero-preview"><img src="${src}" alt="${escapeHtml(file.name)}"></div>`;
  }
  const label = file.ext.replace(".", "") || "bin";
  return `<div class="hero-preview"><div class="file-icon">${escapeHtml(label)}</div></div>`;
}

function hexPreview(bytes) {
  const rows = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const slice = bytes.slice(i, i + 16);
    const hex = slice.map((b) => b.toString(16).padStart(2, "0")).join(" ");
    const ascii = slice.map((b) => (b >= 32 && b <= 126 ? String.fromCharCode(b) : ".")).join("");
    rows.push(`${i.toString(16).padStart(8, "0")}  ${hex.padEnd(47)}  ${ascii}`);
  }
  return rows.join("\n");
}

function decodeBytes(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  for (const encoding of ["gb18030", "gbk", "utf-8"]) {
    try {
      return new TextDecoder(encoding).decode(data);
    } catch {
      continue;
    }
  }
  return new TextDecoder().decode(data);
}

function isAsciiText(byte) {
  return byte === 0x09 || byte === 0x0a || byte === 0x0d || (byte >= 0x20 && byte <= 0x7e);
}

function isGbkTextPair(lead, trail) {
  const commonHan = lead >= 0xb0 && lead <= 0xf7 && trail >= 0xa1 && trail <= 0xfe;
  const commonPunctuation = (lead === 0xa1 || lead === 0xa3) && trail >= 0xa1 && trail <= 0xfe;
  return commonHan || commonPunctuation;
}

function isAllowedTextChar(ch) {
  return /[\u3400-\u4dbf\u4e00-\u9fff，。！？、：；（）【】《》“”‘’·—￥％]/u.test(ch) ||
    /[A-Za-z0-9_ .,:;!?()[\]<>+\-*/\\'"#@$%&=\r\n]/.test(ch);
}

function scanTextRuns(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  const runs = [];
  let pos = 0;

  while (pos < data.length) {
    let i = pos;
    let text = "";

    while (i < data.length) {
      const byte = data[i];
      if (isAsciiText(byte)) {
        const ch = String.fromCharCode(byte);
        if (!isAllowedTextChar(ch)) break;
        text += ch;
        i += 1;
        continue;
      }

      const next = data[i + 1];
      if (isGbkTextPair(byte, next)) {
        const ch = decodeBytes(data.slice(i, i + 2));
        if (ch.length !== 1 || !isAllowedTextChar(ch)) break;
        text += ch;
        i += 2;
        continue;
      }

      break;
    }

    const clean = text
      .replace(/[\r\n\t]+/g, "\n")
      .replace(/[ ]{2,}/g, " ")
      .replace(/^[A-Za-z0-9#@$%&*?=.+\- ]{1,5}(?=\[)/, "")
      .replace(/([。！？）])\s*[A-Za-z0-9#@$%&*?=.+\-]$/, "$1")
      .trim();
    const chinese = (clean.match(/[\u3400-\u4dbf\u4e00-\u9fff]/gu) || []).length;
    const ascii = (clean.match(/[A-Za-z0-9_./\\]/g) || []).length;
    const punctuation = (clean.match(/[，。！？、：；（）【】《》“”\[\]]/gu) || []).length;
    const score = clean.length + chinese * 2 + punctuation;
    if (clean.length >= 4 && score >= 9 && (chinese >= 2 || ascii >= 4)) {
      runs.push({
        offset: pos,
        text: clean,
      });
      if (runs.length >= 90) break;
    }

    pos = i > pos ? i : pos + 1;
  }

  return runs;
}

function formatTextRuns(runs) {
  return runs.map((run) => `${run.offset.toString(16).padStart(6, "0")}  ${run.text}`).join("\n");
}

async function loadBytes(game, rel, limit = 4096) {
  const res = await fetch(`/api/bytes?game=${encodeURIComponent(game)}&rel=${encodeURIComponent(rel)}&limit=${limit}`);
  return await res.json();
}

async function loadStruct(game, rel) {
  const res = await fetch(`/api/struct?game=${encodeURIComponent(game)}&rel=${encodeURIComponent(rel)}`);
  return await res.json();
}

async function loadMapTrace(game, rel) {
  const res = await fetch(`/api/maptrace?game=${encodeURIComponent(game)}&rel=${encodeURIComponent(rel)}`);
  return await res.json();
}

async function loadRuntimeScene(game, rel) {
  const res = await fetch(`/api/runtime?game=${encodeURIComponent(game)}&rel=${encodeURIComponent(rel)}`);
  return await res.json();
}

async function loadCoreRuntimeScene(game, rel) {
  const res = await fetch(`/api/cbe-runtime?game=${encodeURIComponent(game)}&rel=${encodeURIComponent(rel)}`);
  if (!res.ok) return null;
  return await res.json();
}

async function loadCoreEmulatorScene(game, rel) {
  const actions = "confirm,confirm,confirm,confirm";
  const res = await fetch(`/api/cbe-emulator?game=${encodeURIComponent(game)}&rel=${encodeURIComponent(rel)}&actions=${encodeURIComponent(actions)}`);
  if (!res.ok) return null;
  return await res.json();
}

async function loadTrueRuntimeScene(game, rel) {
  if (!String(game || "").includes("众神之战")) return null;
  const res = await fetch(`/api/true-runtime?game=${encodeURIComponent(game)}&rel=${encodeURIComponent(rel)}`);
  if (!res.ok) return null;
  return await res.json();
}

function isStructExt(ext) {
  return [".actor", ".map", ".sce", ".xse"].includes(ext);
}

function compactHead(values) {
  return values.slice(0, 12).map((item) => `${item.offset}:${item.value}`).join("  ");
}

function renderRefList(title, refs, mode = "direct") {
  if (!refs || !refs.length) return "";
  const items = refs.slice(0, 16).map((ref) => {
    const label = mode === "candidate"
      ? `${ref.fragment} -> ${ref.name} (${ref.reason})`
      : `${ref.text}${ref.matched ? ` -> ${ref.matched}` : ""}`;
    const jump = ref.rel ? ` data-jump-rel="${escapeHtml(ref.rel)}"` : "";
    const cls = ref.rel ? " class=\"jumpable\"" : "";
    return `<li${cls}${jump}><span>${escapeHtml(ref.offset || "")}</span>${escapeHtml(label)}</li>`;
  }).join("");
  return `<div class="subhead">${escapeHtml(title)}</div><ul class="ref-list">${items}</ul>`;
}

function renderRuntimeScriptEvidence(scripts) {
  const withEvidence = (scripts || []).filter((script) => script.evidence);
  if (!withEvidence.length) return "";
  const panels = withEvidence.map((script) => {
    const ev = script.evidence || {};
    const object = ev.object || {};
    const refs = ev.refs || {};
    const commands = ev.symbols?.commands || ev.commandAtoms || [];
    const commandText = commands.length
      ? commands.slice(0, 8).map((cmd) => cmd.command || cmd.name || cmd.text || "").filter(Boolean).join("  ")
      : "no visible command atoms";
    const routeLines = (ev.routes || [])
      .flatMap((route) => route.usefulLines || route.termHits || [])
      .slice(0, 4)
      .map((line) => `<li><span>${escapeHtml(line.offset || "")}</span>${escapeHtml(line.text || "")}</li>`)
      .join("");
    const objectText = [
      object.mode ? `mode ${object.mode}` : "",
      Number.isFinite(object.groups) ? `${object.groups} groups` : "",
      Number.isFinite(object.records) ? `${object.records} records` : "",
      object.tailEnd ? `tail ${object.tailEnd}` : "",
      object.tailOk === false ? "tail unresolved" : "",
    ].filter(Boolean).join(" · ");
    return `
      <div class="evidence-panel">
        <div class="evidence-title">${escapeHtml(script.name || script.matched || "script")} <span>${escapeHtml(ev.status || "linked evidence")}</span></div>
        <dl class="kv compact-kv evidence-kv">
          <dt>Object</dt><dd>${escapeHtml(objectText || "no object summary")}</dd>
          <dt>Symbols</dt><dd>${escapeHtml(commandText)}</dd>
          <dt>Refs</dt><dd>${escapeHtml(`direct ${refs.directMatches ?? 0}; weak ${refs.weakMatches ?? 0}; unresolved refs stay symbolic`)}</dd>
          ${object.warning ? `<dt>Warning</dt><dd>${escapeHtml(object.warning)}</dd>` : ""}
        </dl>
        ${routeLines ? `<ul class="ref-list evidence-lines">${routeLines}</ul>` : ""}
        <p class="note-text">${escapeHtml(ev.symbols?.guardrail || refs.note || "Visible commands are symbolic evidence until the script VM reader is proven.")}</p>
      </div>
    `;
  }).join("");
  return `<div class="subhead">Linked XSE Evidence</div><div class="evidence-stack">${panels}</div>`;
}

function relationFromFile(file, role, confidence = "") {
  if (!file) return null;
  return {
    role,
    name: file.name,
    rel: file.rel,
    ext: file.ext,
    kind: file.kind,
    confidence,
  };
}

function relationFromRef(ref, role) {
  if (!ref?.rel) return null;
  const file = findCurrentFileByRel(ref.rel);
  return {
    role,
    name: ref.matched || ref.name || ref.text || displayNameFromRel(ref.rel),
    rel: ref.rel,
    ext: file?.ext || `.${String(ref.rel).split(".").pop()}`,
    kind: file?.kind || "data",
    confidence: ref.reason || "",
  };
}

function collectRelations(file, summary) {
  const items = [];
  const add = (item) => {
    if (!item?.rel || items.some((existing) => existing.rel === item.rel)) return;
    items.push(item);
  };

  if (file.ext === ".sce") add(relationFromFile(findSiblingByExt(file, ".map"), "matching map", "same stem"));
  if (file.ext === ".map") add(relationFromFile(findSiblingByExt(file, ".sce"), "matching scene", "same stem"));

  for (const ref of summary?.refs?.direct || []) add(relationFromRef(ref, "direct ref"));
  for (const ref of summary?.refs?.candidates || []) {
    if ((ref.score || 0) >= 70) add(relationFromRef(ref, "likely ref"));
  }

  const actorImage = summary?.specific?.actor?.primaryImage;
  if (actorImage) add(relationFromFile(findCurrentFileByName(actorImage), "primary image", "actor"));

  return items.slice(0, 18);
}

function findMapForScene(file, summary) {
  const direct = (summary?.refs?.direct || []).find((ref) => /\.map$/i.test(ref.matched || ref.text || "") && ref.rel);
  if (direct?.rel) return findCurrentFileByRel(direct.rel);
  const hint = summary?.specific?.sce?.mapHints?.find((item) => /\.map$/i.test(item.text || ""));
  if (hint?.text) return findCurrentFileByName(hint.text);
  return findSiblingByExt(file, ".map");
}

function renderRelationCard(item) {
  const isImage = item.kind === "image" || [".gif", ".png", ".jpg", ".jpeg"].includes(item.ext);
  const thumb = isImage
    ? `<img src="/asset?game=${encodeURIComponent(state.selectedGame)}&rel=${encodeURIComponent(item.rel)}" alt="${escapeHtml(item.name)}">`
    : `<div class="mini-icon">${escapeHtml((item.ext || "").replace(".", "") || "bin")}</div>`;
  return `
    <button class="relation-card" data-jump-rel="${escapeHtml(item.rel)}">
      <div class="relation-thumb">${thumb}</div>
      <div class="relation-info">
        <div class="relation-role">${escapeHtml(item.role)}</div>
        <div class="relation-name">${escapeHtml(item.name)}</div>
        <div class="relation-meta">${escapeHtml(item.confidence || item.ext || "")}</div>
      </div>
    </button>
  `;
}

function renderRelations(file, summary) {
  const relations = collectRelations(file, summary);
  if (!relations.length) return "";
  return `
    <div class="subhead">Resource Links</div>
    <div class="relation-grid">
      ${relations.map(renderRelationCard).join("")}
    </div>
  `;
}

function parseHexOffset(value) {
  if (!value) return 0;
  return Number.parseInt(String(value).replace(/^0x/i, ""), 16) || 0;
}

function parseHexInt(value) {
  return Number.parseInt(String(value || "").replace(/^0x/i, ""), 16) || 0;
}

function findCompanionMapForTrace(trace) {
  const rel = trace?.map?.companion?.rel;
  if (rel) {
    const file = findCurrentFileByRel(rel);
    if (file) return file;
  }
  return null;
}

function mapTilesetRelation(summary) {
  return (summary?.refs?.candidates || []).find((ref) => /\.gif$/i.test(ref.name || "") && ref.rel) ||
    (summary?.refs?.direct || []).find((ref) => /\.gif$/i.test(ref.matched || ref.text || "") && ref.rel) ||
    null;
}

function formatStreamTop(items, key) {
  return (items || []).slice(0, 8).map((item) => `${item[key]}:${item.count}`).join("  ");
}

function renderMapStreamSummary(stream) {
  if (!stream) return "";
  const lines = [
    `length     ${fmtBytes(stream.length || 0)}`,
    `density    ${stream.bytesPer16Cell ?? "-"} bytes / 16px cell`,
    `top bytes  ${formatStreamTop(stream.topBytes, "byte")}`,
    `high bytes ${formatStreamTop(stream.topHighBytes, "byte")}`,
    `top pairs  ${formatStreamTop(stream.topPairs, "pair")}`,
  ].filter((line) => !line.endsWith(" "));
  return `<div class="subhead">Map Stream</div><pre class="code small-code">${escapeHtml(lines.join("\n"))}</pre>`;
}

function formatCompactToken(token) {
  if (!token) return "-";
  return `${token.offset}:${token.value}(${token.tag} ${token.raw})`;
}

function renderCompactProbe(probe) {
  if (!probe) return "";
  const tags = (probe.tagCounts || []).slice(0, 10).map((entry) => `${entry.tag}:${entry.count}`).join("  ");
  const firstTokens = (probe.firstTokens || []).slice(0, 28).map(formatCompactToken).join("  ");
  const windows = (probe.windows || []).slice(0, 8).map((window) => {
    const tokens = (window.tokens || []).map(formatCompactToken).join("  ");
    return `${window.center}\n  ${tokens}`;
  }).join("\n");
  const attempts = (probe.layoutAttempts || []).slice(0, 6).map((attempt, index) => {
    const records = (attempt.sampleRecords || []).slice(0, 4).join("\n  ");
    return [
      `#${index + 1} startToken=${attempt.startToken} tuple=${attempt.tupleSize} records=${attempt.records} small=${attempt.smallPercent}% mixed=${attempt.mixedPercent}% wide=${attempt.widePercent}% score=${attempt.score}`,
      records ? `  ${records}` : "",
    ].filter(Boolean).join("\n");
  }).join("\n");
  return `
    <div class="subhead">Compact Token Probe</div>
    <p class="note-text">${escapeHtml(probe.note || "Diagnostic only; not a proven renderer.")}</p>
    <pre class="code small-code">${escapeHtml([
      `tokens ${probe.tokenCount ?? "-"} consumed=${probe.consumedBytes ?? "-"}`,
      `tags   ${tags || "-"}`,
      "first tokens",
      firstTokens || "-",
      "wide/control windows",
      windows || "-",
      "tuple layout probes",
      attempts || "-",
    ].join("\n"))}</pre>
  `;
}

function formatProbeToken(token) {
  if (!token) return "-";
  return `${token.offset}:${token.value}(${token.raw})`;
}

function formatF222MatrixToken(token) {
  if (!token) return "-";
  const slot = token.pictureSlot == null ? "-" : token.pictureSlot;
  const payload = token.payload24 == null ? "-" : token.payload24;
  return `${token.offset}:${token.value}(${token.raw}) slot=${slot} payload=${payload}`;
}

function renderF222LayoutProbe(probe, title = "F222 Layout Probe", targetLabel = "target") {
  if (!probe) return "";
  const ff = probe.ffTokenCandidate
    ? `${probe.ffTokenCandidate.markerBytes} @ ${probe.ffTokenCandidate.offset}`
    : "-";
  const fields = (probe.fields || []).map((field) => (
    `${field.objectOffset || ""}:${field.value}(${field.raw}) ${field.role || ""}`.trim()
  )).join("  ");
  const grid = probe.grid
    ? `extent ${probe.grid.extentW} x ${probe.grid.extentH}, cell ${probe.grid.cellW} x ${probe.grid.cellH}, ceil matrix ${probe.grid.ceilColumns} x ${probe.grid.ceilRows}=${probe.grid.ceilCells}, floor ${probe.grid.floorColumns} x ${probe.grid.floorRows}=${probe.grid.floorCells}`
    : "-";
  const image = probe.image
    ? `${targetLabel} ${probe.image.width} x ${probe.image.height}, extentDelta=${probe.image.extentDelta ?? "-"}, cellDelta=${probe.image.cellDelta ?? "-"}`
    : "-";
  const head = (probe.firstMatrixTokens || []).slice(0, 12).map(formatF222MatrixToken).join("  ");
  const attempts = (probe.attempts || []).slice(0, 5).map((attempt, index) => {
    const attemptGrid = attempt.grid
      ? `extent ${attempt.grid.extentW}x${attempt.grid.extentH}, cell ${attempt.grid.cellW}x${attempt.grid.cellH}, ceil ${attempt.grid.ceilColumns}x${attempt.grid.ceilRows}/${attempt.grid.ceilCells}`
      : "-";
    const attemptFields = (attempt.fields || []).map((field) => `${field.objectOffset || ""}:${field.value}(${field.raw}) ${field.role || ""}`.trim()).join("  ");
    const attemptMatrix = (attempt.firstMatrixTokens || []).slice(0, 8).map(formatF222MatrixToken).join("  ");
    return [
      `#${index + 1} score=${attempt.score} table=${attempt.tableMethod || "-"} stride=${attempt.recordStride ?? "-"} complete=${attempt.tableComplete ?? "-"} after=${attempt.tableAfterOffset}`,
      `  fields@${attempt.fieldsOffset} ${attemptFields || "-"}`,
      `  grid ${attemptGrid}`,
      `  matrix ${attempt.matrixRead}/${attempt.matrixExpected ?? "-"} end=${attempt.matrixEndOffset} bytesToFf=${attempt.bytesToFfCandidate ?? "-"}`,
      `  head ${attemptMatrix || "-"}`,
    ].join("\n");
  }).join("\n");
  return `
    <div class="subhead">${escapeHtml(title)}</div>
    <p class="note-text">${escapeHtml(probe.note || "Code-anchored diagnostic; renderer still being reversed.")}</p>
    <pre class="code small-code">${escapeHtml([
      `table count=${probe.count ?? "-"} raw=${probe.countRaw ?? "-"} complete=${probe.tableComplete ?? "-"} after=${probe.tableAfterOffset || "-"} method=${probe.referenceTableApproximation || "-"}`,
      `fields@${probe.fieldsOffset || "-"} ${fields || "-"}`,
      `grid ${grid}`,
      image,
      `matrix read=${probe.matrixRead ?? "-"}/${probe.matrixExpected ?? "-"} end=${probe.matrixEndOffset || "-"} bytesToFf=${probe.bytesToFfCandidate ?? "-"} ff=${ff}`,
      `matrix head ${head || "-"}`,
      "scored alternatives",
      attempts || "-",
    ].join("\n"))}</pre>
  `;
}

function renderMapTemplateProbe(probe) {
  if (!probe) return "";
  const tableCandidates = (probe.tableCandidates || []).slice(0, 8).map((table) => (
    `${table.method} count=${table.count} after=${table.afterOffset} recordBytes=${table.recordBytes ?? "-"} tokenEnd=${table.tokenEnd ?? "-"}`
  )).join("\n");
  const firstTokens = (probe.firstTokens || []).slice(0, 32).map(formatCompactToken).join("  ");
  const best = probe.best;
  const verdict = probe.nearCanvas
    ? "candidate near scene canvas"
    : "no canvas-sized candidate yet; current best is counter-evidence, not a decoded map";
  const bestLines = best ? (() => {
    const fields = (best.fields || []).map((field) => (
      `${field.objectOffset}:${field.value}(${field.raw}) ${field.role}`
    )).join("  ");
    const matrix = (best.firstMatrixTokens || []).slice(0, 12).map(formatF222MatrixToken).join("  ");
    const grid = best.grid
      ? `extent ${best.grid.extentW} x ${best.grid.extentH}, cell ${best.grid.cellW} x ${best.grid.cellH}, matrix ${best.grid.columns} x ${best.grid.rows}=${best.grid.cells}`
      : "-";
    return [
      `best score=${best.score} startToken=${best.startToken} fields=${best.fieldsOffset}`,
      `  verdict ${verdict}${probe.bestCanvasDelta != null ? ` delta=${probe.bestCanvasDelta}` : ""}`,
      `  ${best.reason || "-"}`,
      `  table ${best.tableCandidate ? `${best.tableCandidate.method} count=${best.tableCandidate.count} after=${best.tableCandidate.afterOffset}` : "-"}`,
      `  fields ${fields || "-"}`,
      `  grid ${grid} canvasDelta=${best.canvasDelta ?? "-"} swapped=${best.canvasDeltaSwapped ?? "-"}`,
      `  matrix ${best.matrixRead}/${best.matrixExpected} ${best.matrixStartOffset} -> ${best.matrixEndOffset} remaining=${best.bytesRemaining}`,
      `  head ${matrix || "-"}`,
    ];
  })() : ["best -"];
  const candidates = (probe.candidates || []).slice(0, 6).map((candidate, index) => {
    const grid = candidate.grid
      ? `extent ${candidate.grid.extentW}x${candidate.grid.extentH}, cell ${candidate.grid.cellW}x${candidate.grid.cellH}, matrix ${candidate.grid.columns}x${candidate.grid.rows}/${candidate.grid.cells}`
      : "-";
    return `#${index + 1} score=${candidate.score} startToken=${candidate.startToken} fields=${candidate.fieldsOffset} ${grid} matrix=${candidate.matrixRead}/${candidate.matrixExpected} remain=${candidate.bytesRemaining}`;
  }).join("\n");
  return `
    <div class="subhead">Map Template Probe</div>
    <p class="note-text">${escapeHtml(probe.note || "Code-anchored diagnostic; not final terrain rendering.")}</p>
    <pre class="code small-code">${escapeHtml([
      `drawStream ${probe.drawStreamOffset || "-"} tokens=${probe.tokenCount ?? "-"}`,
      "table candidates",
      tableCandidates || "-",
      ...bestLines,
      "scored candidates",
      candidates || "-",
      "first tokens",
      firstTokens || "-",
    ].join("\n"))}</pre>
  `;
}

function renderTemplateStreamProbe(probe, title = "Template Stream Probe", targetLabel = "target") {
  if (!probe?.attempts?.length && !probe?.ffTokenCandidate) return "";
  const ff = probe.ffTokenCandidate
    ? `${probe.ffTokenCandidate.markerBytes} @ ${probe.ffTokenCandidate.offset}`
    : "-";
  const attempts = (probe.attempts || []).slice(0, 8).map((attempt, index) => {
    const fields = (attempt.fields || []).map(formatProbeToken).join("  ");
    const grid = attempt.grid
      ? `${attempt.grid.cellW}x${attempt.grid.cellH} cells, extent ${attempt.grid.width}x${attempt.grid.height}, matrix ${attempt.grid.columns}x${attempt.grid.rows}=${attempt.grid.cells}`
      : "-";
    const firstMatrix = (attempt.firstMatrixTokens || []).slice(0, 10).map(formatProbeToken).join("  ");
    return [
      `#${index + 1} score=${attempt.score} count=${attempt.count} (${attempt.countRead}) stride=${attempt.recordStride} tableBytes=${attempt.tableBytes}`,
      `  fields@${attempt.fieldsOffset} ${fields || "-"}`,
      `  grid ${grid}`,
      `  matrixEnd=${attempt.matrixEnd} bytesToFf=${attempt.bytesToFfCandidate ?? "-"} ${targetLabel}Delta=${attempt.targetDelta ?? "-"} swapped=${attempt.targetDeltaSwapped ?? "-"}`,
      `  firstMatrix ${firstMatrix || "-"}`,
    ].join("\n");
  }).join("\n");
  return `
    <div class="subhead">${escapeHtml(title)}</div>
    <p class="note-text">${escapeHtml(probe.note || "Diagnostic only; not a proven renderer.")}</p>
    <pre class="code small-code">${escapeHtml([
      `ff token candidate  ${ff}`,
      attempts || "-",
    ].join("\n"))}</pre>
  `;
}

function renderActorFrameTableProbe(probe) {
  if (!probe?.records?.length) return "";
  const records = probe.records.slice(0, 16).map((record) => (
    `${String(record.index).padStart(2, "0")} ${record.offset} values=${record.values.join(",")} raw=${record.raw}`
  )).join("\n");
  const next = (probe.nextTokens || []).slice(0, 12).map(formatProbeToken).join("  ");
  const columns = (probe.columns || []).map((column, index) => (
    `c${index}: min=${column.min ?? "-"} max=${column.max ?? "-"} unique=${column.unique ?? "-"}`
  )).join("  ");
  const image = probe.image ? `image ${probe.image.width}x${probe.image.height}, coordinate-window hit ${probe.image.valuesWithinImagePercent}%` : "-";
  return `
    <div class="subhead">Actor Frame Table Probe</div>
    <p class="note-text">${escapeHtml(probe.note || "Diagnostic only.")}</p>
    <pre class="code small-code">${escapeHtml([
      `count ${probe.count} raw=${probe.countRaw} afterRecords=${probe.afterRecordsOffset} shown=${Math.min(probe.records.length, 16)}/${probe.recordCount}`,
      `columns ${columns}`,
      image,
      "records",
      records,
      `next tokens ${next || "-"}`,
    ].join("\n"))}</pre>
  `;
}

function renderSceMapTable(summary) {
  const table = summary?.specific?.sce?.mapTable;
  if (!table?.records?.length) return "";
  const rows = table.records.map((record) => {
    return `${record.offset} ${record.name} fields=${record.fields.join(",")} raw=${record.rawFields}`;
  }).join("\n");
  return `
    <div class="subhead">SCE Map Table</div>
    <pre class="code small-code">${escapeHtml([
      `canvas ${table.width} x ${table.height}`,
      `records ${table.count} · scene stream starts ${table.streamOffset}`,
      rows,
    ].join("\n"))}</pre>
  `;
}

function renderSceneObjectProbe(summary) {
  const probe = summary?.specific?.sce?.sceneObjectProbe;
  if (!probe) return "";
  const refs = (probe.resourceRefs || []).slice(0, 18).map((ref) => {
    const target = ref.matched ? ` -> ${ref.matched}` : "";
    const rel = ref.rel ? ` ${ref.rel}` : "";
    const post = (ref.postU16LE || []).slice(0, 4).map((item) => `${item.offset}:${item.value}`).join(" ");
    return `${ref.offset} ${ref.text}${target}${rel}${post ? ` postU16=${post}` : ""}`;
  }).join("\n");
  const external = (probe.externalProbes || []).map((externalProbe) => {
    const best = externalProbe.probe?.best;
    if (!best) {
      return `${externalProbe.refOffset} ${externalProbe.text}: ${externalProbe.error || "no 0x112C4 probe"}`;
    }
    const header = best.header || {};
    const opcodes = (best.opcodeHistogram || []).slice(0, 12).map((item) => `${item.key}:${item.count}`).join("  ");
    const groups = (best.groups || []).slice(0, 4).map((group) => {
      const sample = (group.sampleRecords || []).slice(0, 4).map((record) => {
        const fields = (record.fields || []).filter((field) => field.tag !== "const")
          .map((field) => `${field.label || "field"}=${field.value}(${field.raw})`).join(",");
        return `${record.offset}:op${record.opcode}${fields ? `[${fields}]` : ""}`;
      }).join("  ");
      return `  group#${group.index} @${group.offset} id=${group.id} count=${group.recordCount} ${sample}`;
    }).join("\n");
    const warnings = (best.warnings || []).slice(0, 4).join(" | ");
    return [
      `${externalProbe.refOffset} ${externalProbe.text} -> ${externalProbe.matched || "-"} confidence=${externalProbe.probe?.confidence || "-"} score=${best.score} ok=${best.ok}`,
      `  cursor ${best.cursorStart} -> ${best.endOffset} consumed=${best.consumedBytes} reader=${best.groupIdReader}`,
      `  header slots=${header.slotCapacityAllocated ?? "-"} type=${header.typeByte?.value ?? "-"} recordSize=${header.recordByteSize ?? "-"} groups=${best.groupCount} records=${best.totalRecords} knownOpcode=${best.knownOpcodePercent}%`,
      `  opcodes ${opcodes || "-"}`,
      groups || "  groups -",
      warnings ? `  warnings ${warnings}` : "",
    ].filter(Boolean).join("\n");
  }).join("\n\n");
  return `
    <div class="subhead">Scene Object Bytecode Probe</div>
    <p class="note-text">${escapeHtml(probe.note || "Diagnostic, code-anchored; not a rendered map.")}</p>
    <pre class="code small-code">${escapeHtml([
      `stream ${probe.sceneStreamOffset} · ${fmtBytes(probe.sceneStreamLength || 0)} · refs ${probe.resourceRefCount || 0}`,
      "scene resource refs",
      refs || "-",
      "0x112C4 external resource probes",
      external || "-",
    ].join("\n"))}</pre>
  `;
}

function renderMapTrace(trace) {
  if (!trace?.map) return "";
  const map = trace.map;
  const leadHeader = map.leadHeader || null;
  const compactProbe = trace.evidence?.compactProbe || map.compactProbe || null;
  const rows = [
    ["Map World", map.canvas ? `${map.canvas.width} x ${map.canvas.height}${map.canvas.scene ? ` · from ${map.canvas.scene}` : ""}` : "-"],
    ["Map Header", leadHeader ? `${leadHeader.encoding} @ ${leadHeader.offset} -> draw ${leadHeader.drawStreamOffset}` : "-"],
    ["Header Bytes", leadHeader?.bytes || map.skippedHeaderBytes || "-"],
    ["Draw Offset", `${map.drawStreamOffset} · ${fmtBytes(map.drawStreamLength)}`],
    ["Draw Reason", map.drawStreamReason],
    ["Tileset Atlas", map.atlas?.size ? `${map.atlas.name} · ${map.atlas.size.width} x ${map.atlas.size.height} · ${map.atlas.tiles16} 16px tiles` : (map.atlas?.name || "-")],
    ["Companion", map.companion ? `${map.companion.rel} · draw prefix ${map.companion.commonDrawPrefixBytes ?? map.companion.commonPayloadPrefixBytes} bytes` : "-"],
    ["Lead Fields", (map.leadFields || []).map((field) => `${field.name}=${field.value}`).join("  ") || "-"],
    ["Compact Probe", compactProbe ? `${compactProbe.tokenCount} tokens · ${fmtBytes(compactProbe.consumedBytes || 0)} consumed` : "-"],
  ];
  const bytes = (trace.evidence?.firstDrawBytes || []).slice(0, 6).join("\n");
  const pairs = (trace.evidence?.topPairs || []).slice(0, 8).map((entry) => `${entry.bytes}:${entry.count}`).join("  ");
  const tokenDiff = map.companion?.compactTokenDiff;
  const diffText = tokenDiff ? [
    `common token prefix ${tokenDiff.commonTokenPrefix} · left ${tokenDiff.leftDivergenceOffset || "-"} · right ${tokenDiff.rightDivergenceOffset || "-"}`,
    ...(tokenDiff.sample || []).slice(0, 14).map((row) => (
      `${String(row.index).padStart(3, "0")} ${row.same ? "=" : "!"}  left ${row.left}  |  right ${row.right}`
    )),
  ].join("\n") : "";
  return `
    <div class="subhead">Map Trace</div>
    <dl class="kv compact-kv">${rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join("")}</dl>
    <p class="note-text">${escapeHtml("The map stream is treated as compact bytecode/records. Old grid-stitch previews are intentionally not shown as reconstruction because they do not match the original scene.")}</p>
    ${diffText ? `<div class="subhead">Companion Token Diff</div><pre class="code small-code">${escapeHtml(diffText)}</pre>` : ""}
    ${renderMapTemplateProbe(trace.evidence?.mapTemplateProbe || map.mapTemplateProbe)}
    ${renderCompactProbe(compactProbe)}
    ${renderF222LayoutProbe(trace.evidence?.f222LayoutProbe, "Map F222 Layout Probe", "canvas")}
    <pre class="code small-code">${escapeHtml([
      `top pairs  ${pairs}`,
      "first draw bytes",
      bytes,
    ].join("\n"))}</pre>
  `;
}

function renderDrawProjection(candidate, atlasUrl, atlasSize, canvas) {
  const pieces = (candidate.placements || []).map((placement) => {
    return `<span class="draw-piece" style="left:${placement.x}px;top:${placement.y}px;width:${placement.size}px;height:${placement.size}px;background-image:url('${escapeHtml(atlasUrl)}');background-size:${atlasSize.width}px ${atlasSize.height}px;background-position:-${placement.sx}px -${placement.sy}px"></span>`;
  }).join("");
  const width = Math.max(1, canvas.width || candidate.bounds?.width || 1);
  const height = Math.max(1, canvas.height || candidate.bounds?.height || 1);
  return `<div class="draw-grid" style="width:${width}px;height:${height}px;">${pieces}</div>`;
}

function renderDrawCandidates(file, trace) {
  const map = trace?.map;
  const candidates = trace?.evidence?.drawCandidates || [];
  if (!map?.canvas || !map?.atlas?.rel || !map.atlas?.size || !candidates.length) return "";
  const panels = candidates.slice(0, 4).map((candidate, index) => {
    const coverage = candidate.coverage ? `${candidate.coverage.widthPercent}% x ${candidate.coverage.heightPercent}%` : "-";
    const tag = index === 0 ? "best" : `#${index + 1}`;
    const samples = (candidate.samples || []).slice(0, 8)
      .map((sample) => `${sample.offset} tile=${sample.tile} raw=${sample.rawX},${sample.rawY} xy=${sample.x},${sample.y} valid=${sample.validTile} inCanvas=${sample.inCanvas}`)
      .join("\n");
    return `
      <section class="tile-hypothesis">
        <div class="tile-hypothesis-head">
          <span>${escapeHtml(`${tag} ${candidate.label}`)}</span>
          <span>${escapeHtml(`${candidate.drawableRecords}/${candidate.records}`)}</span>
        </div>
        <div class="candidate-meta">${escapeHtml(`coverage ${coverage} · bounds ${candidate.bounds.width} x ${candidate.bounds.height} · score ${candidate.score}`)}</div>
        <pre class="candidate-records">${escapeHtml(samples || "-")}</pre>
      </section>
    `;
  }).join("");
  return `<div class="subhead">Draw Record Candidates</div><div class="tile-hypotheses draw-hypotheses">${panels}</div>`;
}

function mapPackedTile(byte, atlasTiles, transform) {
  if (transform === "shift2") return (byte >> 2) % atlasTiles;
  if (transform === "low6") return (byte & 0x3f) % atlasTiles;
  return byte % atlasTiles;
}

function decodeMapCells(bytes, trace, mode, tileSize = 16, options = {}) {
  const map = trace?.map || {};
  const canvas = map.canvas || {};
  const atlas = map.atlas || {};
  const atlasSize = atlas.size || {};
  const columns = Math.max(1, Math.ceil((canvas.width || 0) / tileSize));
  const rows = Math.max(1, Math.ceil((canvas.height || 0) / tileSize));
  const cells = columns * rows;
  const atlasColumns = Math.max(1, Math.floor((atlasSize.width || tileSize) / tileSize));
  const atlasTiles = Math.max(1, atlasColumns * Math.floor((atlasSize.height || tileSize) / tileSize));
  const out = new Array(cells).fill(options.defaultTile ?? null);
  const written = new Array(cells).fill(false);
  const transform = options.tileTransform || "";
  let cursor = 0;
  let writes = 0;
  let skipped = 0;

  if (mode === "raw") {
    for (let i = 0; i < Math.min(cells, bytes.length); i += 1) {
      out[i] = mapPackedTile(bytes[i], atlasTiles, transform);
      written[i] = true;
      writes += 1;
    }
  } else if (mode === "rawMod") {
    for (let i = 0; i < Math.min(cells, bytes.length); i += 1) {
      out[i] = mapPackedTile(bytes[i], atlasTiles, transform);
      written[i] = true;
      writes += 1;
    }
  } else if (mode === "low7") {
    for (let i = 0; i < Math.min(cells, bytes.length); i += 1) {
      out[i] = bytes[i] & 0x7f;
      written[i] = true;
      writes += 1;
    }
  } else if (mode === "zeroSkip") {
    for (let i = 0; i < bytes.length && cursor < cells; i += 1) {
      const byte = bytes[i];
      if ((byte === 0x00 || byte === 0xff) && i + 1 < bytes.length) {
        cursor += bytes[i + 1];
        skipped += bytes[i + 1];
        i += 1;
        continue;
      }
      out[cursor] = mapPackedTile(byte, atlasTiles, transform);
      written[cursor] = true;
      cursor += 1;
      writes += 1;
    }
  } else if (mode === "zeroSkipMod") {
    for (let i = 0; i < bytes.length && cursor < cells; i += 1) {
      const byte = bytes[i];
      if ((byte === 0x00 || byte === 0xff) && i + 1 < bytes.length) {
        cursor += bytes[i + 1];
        skipped += bytes[i + 1];
        i += 1;
        continue;
      }
      out[cursor] = mapPackedTile(byte, atlasTiles, transform);
      written[cursor] = true;
      cursor += 1;
      writes += 1;
    }
  } else if (mode === "zeroRunFFSkip" || mode === "zeroRun0FFSkip" || mode === "zeroSkipFFRunPrev") {
    let lastTile = 0;
    for (let i = 0; i < bytes.length && cursor < cells; i += 1) {
      const byte = bytes[i];
      if ((byte === 0x00 || byte === 0xff) && i + 1 < bytes.length) {
        const count = bytes[i + 1];
        const isSkip =
          (mode === "zeroRunFFSkip" && byte === 0xff) ||
          (mode === "zeroRun0FFSkip" && byte === 0xff) ||
          (mode === "zeroSkipFFRunPrev" && byte === 0x00);
        if (isSkip) {
          cursor += count;
          skipped += count;
        } else {
          const tile = mode === "zeroRun0FFSkip" && byte === 0x00 ? 0 : mapPackedTile(lastTile, atlasTiles, transform);
          for (let k = 0; k < count && cursor < cells; k += 1) {
            out[cursor] = tile;
            written[cursor] = true;
            cursor += 1;
            writes += 1;
          }
        }
        i += 1;
        continue;
      }
      out[cursor] = mapPackedTile(byte, atlasTiles, transform);
      written[cursor] = true;
      lastTile = byte;
      cursor += 1;
      writes += 1;
    }
  }

  return { cells: out, written, columns, rows, atlasColumns, tileSize, writes, skipped, cursor, defaultTile: options.defaultTile ?? null, tileTransform: transform };
}

function mergeDecodedLayers(base, overlay) {
  if (!base || !overlay) return base || overlay;
  const merged = {
    ...base,
    cells: base.cells.slice(),
    written: base.written ? base.written.slice() : new Array(base.cells.length).fill(false),
    writes: base.writes + overlay.writes,
    skipped: base.skipped + overlay.skipped,
    overlays: 0,
  };
  for (let i = 0; i < Math.min(merged.cells.length, overlay.cells.length); i += 1) {
    if (!overlay.written?.[i]) continue;
    merged.cells[i] = overlay.cells[i];
    merged.written[i] = true;
    merged.overlays += 1;
  }
  return merged;
}

function renderTileGrid(decoded, atlasUrl, atlasSize) {
  const tiles = decoded.cells.map((tile, index) => {
    if (tile == null) return "";
    const col = index % decoded.columns;
    const row = Math.floor(index / decoded.columns);
    const sx = (tile % decoded.atlasColumns) * decoded.tileSize;
    const sy = Math.floor(tile / decoded.atlasColumns) * decoded.tileSize;
    return `<span class="tile-piece" style="left:${col * decoded.tileSize}px;top:${row * decoded.tileSize}px;width:${decoded.tileSize}px;height:${decoded.tileSize}px;background-image:url('${escapeHtml(atlasUrl)}');background-size:${atlasSize.width}px ${atlasSize.height}px;background-position:-${sx}px -${sy}px"></span>`;
  }).join("");
  return `<div class="tile-grid" style="width:${decoded.columns * decoded.tileSize}px;height:${decoded.rows * decoded.tileSize}px;">${tiles}</div>`;
}

function renderPhoneViewport(decoded, atlasUrl, atlasSize, actors, sceneCanvas) {
  const viewportW = Math.min(240, sceneCanvas.width || 240);
  const viewportH = Math.min(400, sceneCanvas.height || 400);
  const cameraX = 0;
  const cameraY = 0;
  return `
    <div class="phone-viewport">
      <div class="phone-stage" style="width:${viewportW}px;height:${viewportH}px;">
        <div class="phone-layer" style="left:-${cameraX}px;top:-${cameraY}px;width:${sceneCanvas.width}px;height:${sceneCanvas.height}px;">
          ${renderTileGrid(decoded, atlasUrl, atlasSize)}
          ${actors}
        </div>
      </div>
      <div class="map-caption">${escapeHtml(`${viewportW} x ${viewportH} camera candidate @ ${cameraX},${cameraY}`)}</div>
    </div>
  `;
}

function renderSceneCompositeFromDecoded(file, summary, trace, mapBytes, companionTrace = null, companionBytes = null) {
  const sce = summary?.specific?.sce;
  const map = trace?.map;
  if (!sce?.canvas || !map?.atlas?.rel || !map.atlas?.size || !map?.drawStreamOffset) return "";
  const drawOffset = parseHexInt(map.drawStreamOffset);
  const mode = "zeroRunFFSkip";
  const modeLabel = "FF skip / 00 fill previous";
  const defaultTile = 105;
  const decodedBase = decodeMapCells(mapBytes.slice(drawOffset), trace, mode, 16, {
    tileTransform: "shift2",
    defaultTile,
  });
  let decoded = decodedBase;
  let companionLabel = "";
  if (companionTrace?.map?.drawStreamOffset && companionBytes) {
    const companionMode = "zeroRunFFSkip";
    const companionOffset = parseHexInt(companionTrace.map.drawStreamOffset);
    const decodedOverlay = decodeMapCells(companionBytes.slice(companionOffset), companionTrace, companionMode, 16, {
      tileTransform: "shift2",
    });
    decoded = mergeDecodedLayers(decodedBase, decodedOverlay);
    companionLabel = ` + overlay ${companionTrace.map.name} (${companionMode})`;
  }
  const atlasUrl = `/asset?game=${encodeURIComponent(file.game)}&rel=${encodeURIComponent(map.atlas.rel)}`;
  const actors = (sce.placements || []).map((placement) => {
    const imgUrl = placementGifUrl(placement);
    const sprite = imgUrl
      ? `<img class="scene-composite-sprite" src="${escapeHtml(imgUrl)}" alt="${escapeHtml(placement.matched || placement.name)}">`
      : `<span class="scene-dot"></span>`;
    return `
      <div class="scene-composite-actor${placement.anchor === "top-left" ? " top-left" : ""}" style="left:${Math.max(0, placement.x)}px;top:${Math.max(0, placement.y)}px;">
        ${sprite}
        <span>${escapeHtml(placement.name)}</span>
      </div>
    `;
  }).join("");
  return `
    <div class="subhead">Decoded Scene Candidate</div>
    ${renderPhoneViewport(decoded, atlasUrl, map.atlas.size, actors, sce.canvas)}
    <div class="scene-composite-wrap">
      <div class="scene-composite" style="width:${sce.canvas.width}px;height:${sce.canvas.height}px;">
        ${renderTileGrid(decoded, atlasUrl, map.atlas.size)}
        ${actors}
      </div>
    </div>
    <div class="map-caption">${escapeHtml(`${decoded.writes} tile writes + ${decoded.skipped} skips from ${map.name}${companionLabel}; tile byte >> 2; default floor tile ${defaultTile}; actors from ${file.name}; mode ${modeLabel}`)}</div>
  `;
}

function renderMapTileHypotheses(file, fullBytes, trace) {
  return [
    renderDrawCandidates(file, trace),
  ].filter(Boolean).join("");
}

function renderActorStructure(summary) {
  const actor = summary?.specific?.actor;
  if (!actor?.primaryImage) return "";
  const info = actor.imageInfo;
  const header = actor.header || null;
  const rows = [
    ["Primary GIF", actor.primaryImage],
    ["GIF Match", header?.imageMatchReason ? `${header.imageMatchReason} · score ${header.imageMatchScore}` : "-"],
    ["GIF Size", info ? `${info.width} x ${info.height}` : "-"],
    ["GIF Frames", info ? `${info.frames} image descriptor(s), ${info.graphicControls} graphic control block(s)` : "-"],
    ["Actor Header", header ? `${header.headerBytes} · word0 ${header.headerWord0}` : "-"],
    ["Name Field", header ? `${header.nameOffset} · len ${header.declaredNameLength} · ${header.rawNameText}` : "-"],
    ["Actor Stream", `${actor.streamOffset || "-"} · ${fmtBytes(actor.streamLength || 0)}`],
    ["FF Token Candidate", actor.stream?.divider ? `${actor.stream.divider.markerBytes} @ stream ${actor.stream.divider.offset}` : "-"],
    ["Token Probe Split", actor.stream?.divider ? `${fmtBytes(actor.stream.divider.preDataLength)} before · ${fmtBytes(actor.stream.divider.postLength)} after` : "-"],
    ["High-Bit Bytes", actor.stream?.highBitPercent != null ? `${actor.stream.highBitPercent}%` : "-"],
  ];
  const topBytes = (actor.stream?.topBytes || []).slice(0, 10).map((item) => `${item.byte}:${item.count}`).join("  ");
  const firstBytes = actor.stream?.firstBytes || "";
  const dividerCandidates = (actor.stream?.dividerCandidates || [])
    .slice(0, 6)
    .map((divider) => `${divider.offset} token=${divider.markerBytes} pre=${divider.preDataLength} post=${divider.postLength}`)
    .join("\n");
  const tokenProbe = (actor.stream?.tokenProbe || [])
    .slice(0, 16)
    .map((token) => {
      const value = token.signed32 != null ? `s32=${token.signed32}` : `value=${token.value}`;
      return `${token.offset} tag=${token.tag} ${value} raw=${token.raw}`;
    })
    .join("\n");
  const sections = (actor.stream?.sections || []).slice(0, 8).map((section) => `${section.name} ${section.offset} len=${section.length}\n${section.firstBytes}`).join("\n");
  const postHeader = actor.stream?.postDividerHeader
    ? [
        `${actor.stream.postDividerHeader.offset} len=${actor.stream.postDividerHeader.length}`,
        actor.stream.postDividerHeader.firstBytes,
        `u16 ${actor.stream.postDividerHeader.u16Head.map((word) => `${word.offset}:${word.value}`).join("  ")}`,
      ].join("\n")
    : "-";
  const nameSegments = (header?.printableSegments || []).map((segment) => `${segment.offset} ${segment.text}`).join("  ");
  const embeddedAssets = (actor.embeddedAssets || [])
    .map((asset) => `${asset.offset} ${asset.text} => ${asset.matched} (${asset.reason})`)
    .join("\n");
  return `
    <div class="subhead">Actor Decode Notes</div>
    <dl class="kv compact-kv">${rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join("")}</dl>
    <p class="note-text">${escapeHtml("The referenced GIF is a complete sprite/sheet image. The actor stream is metadata/animation bytecode; FF-heavy patterns are token/sentinel candidates, not proven image cut boundaries.")}</p>
    <pre class="code small-code">${escapeHtml([
      `name segments  ${nameSegments || "-"}`,
      `raw name bytes  ${header?.rawNameBytes || "-"}`,
      `top bytes      ${topBytes}`,
      "FF token candidates",
      dividerCandidates || "-",
      "compact token probe",
      tokenProbe || "-",
      "post-token header probe",
      postHeader,
      "embedded asset fragments",
      embeddedAssets || "-",
      "first actor stream bytes",
      firstBytes,
      "actor stream sections",
      sections || "-",
    ].join("\n"))}</pre>
    ${renderActorFrameTableProbe(actor.frameTableProbe)}
    ${renderF222LayoutProbe(actor.f222LayoutProbe, "Actor F222 Layout Probe", "gif")}
    ${renderTemplateStreamProbe(actor.templateStreamProbe, "Actor Template Stream Probe", "gif")}
  `;
}

function renderScenePlacementPreview(summary) {
  const sce = summary?.specific?.sce;
  if (!sce?.canvas || !sce?.placements?.length) return "";
  const width = sce.canvas.width;
  const height = sce.canvas.height;
  const caption = `${width} x ${height} · ${sce.placements.length} decoded scene placements`;
  const plot = sce.placements.map((placement, index) => {
    const x = Math.max(0, placement.x);
    const y = Math.max(0, placement.y);
    const hue = (index * 67) % 360;
    const imgUrl = placementGifUrl(placement);
    const sprite = imgUrl
      ? `<img class="scene-sprite" src="${escapeHtml(imgUrl)}" alt="${escapeHtml(placement.matched || placement.name)}">`
      : `<span class="scene-dot" style="background:hsl(${hue} 62% 38%)"></span>`;
    return `
      <div class="scene-node${placement.anchor === "top-left" ? " top-left" : ""}" style="left:${x}px; top:${y}px;">
        ${sprite}
        <div class="scene-label">${escapeHtml(`${placement.name} (${placement.x},${placement.y})`)}</div>
      </div>
    `;
  }).join("");
  const viewportW = Math.min(240, width);
  const viewportH = Math.min(320, height);
  return `
    <div class="subhead">Scene Object Layer</div>
    <div class="placement-preview">
      <div class="scene-plot" style="width:${width}px; height:${height}px;">
        <div class="scene-viewport-frame" style="width:${viewportW}px;height:${viewportH}px;"></div>
        ${plot}
      </div>
      <div class="map-caption">${escapeHtml(`${caption} · phone viewport is ${viewportW} x ${viewportH}; camera position is separate from map size`)}</div>
    </div>
  `;
}

function renderRuntimeActor(entity, inViewport = false) {
  const actor = entity.actor || {};
  const image = actor.imageUrl
    ? `<img class="scene-composite-sprite" src="${escapeHtml(actor.imageUrl)}" alt="${escapeHtml(entity.matched || entity.name)}">`
    : `<span class="scene-dot"></span>`;
  const label = inViewport ? "" : `<span>${escapeHtml(entity.name || entity.matched || "actor")}</span>`;
  const classes = [
    "scene-composite-actor",
    entity.anchor === "top-left" ? "top-left" : "",
    entity.controllable || entity.controlled ? "controlled" : "",
  ].filter(Boolean).join(" ");
  return `
    <div class="${classes}" data-emulator-entity-id="${escapeHtml(entity.id || "")}" data-emulator-x="${Math.max(0, entity.x || 0)}" data-emulator-y="${Math.max(0, entity.y || 0)}" style="left:${Math.max(0, entity.x || 0)}px;top:${Math.max(0, entity.y || 0)}px;">
      ${image}
      ${label}
    </div>
  `;
}

function renderEmulatorActors(runtime) {
  return (runtime.entities || []).map((entity) => renderRuntimeActor(entity, true)).join("");
}

function renderRuntimeMapTiles(map) {
  const params = new URLSearchParams(window.location.search);
  if (params.get("mapCandidate") !== "1") return "";
  const grid = map?.renderHint?.tileGridCandidate || null;
  const atlas = map?.renderHint?.atlas || null;
  const atlasSize = atlas?.size || null;
  const atlasUrl = map?.tilesetUrl || "";
  const cells = grid?.tileCells || [];
  if (!grid || !atlasSize?.width || !atlasSize?.height || !atlasUrl || !Array.isArray(cells) || !cells.length) return "";
  const tileSize = grid.tileSize || 16;
  const columns = grid.columns || 0;
  const rows = grid.rows || 0;
  const atlasColumns = grid.atlasColumns || Math.max(1, Math.floor(atlasSize.width / tileSize));
  const tiles = cells.map((tile, index) => {
    if (tile == null) return "";
    const col = index % columns;
    const row = Math.floor(index / columns);
    const sx = (tile % atlasColumns) * tileSize;
    const sy = Math.floor(tile / atlasColumns) * tileSize;
    return `<span class="tile-piece" style="left:${col * tileSize}px;top:${row * tileSize}px;width:${tileSize}px;height:${tileSize}px;background-image:url('${escapeHtml(atlasUrl)}');background-size:${atlasSize.width}px ${atlasSize.height}px;background-position:-${sx}px -${sy}px"></span>`;
  }).join("");
  const label = `${grid.label || grid.key || "RLE"} · score ${grid.score ?? "-"} · ${grid.confidence || "candidate"}`;
  return `<div class="tile-grid runtime-tile-grid" data-map-render-candidate="${escapeHtml(grid.key || "")}" title="${escapeHtml(label)}" style="width:${columns * tileSize}px;height:${rows * tileSize}px;">${tiles}</div>`;
}

function renderRuntimeBoot(runtime) {
  const boot = runtime?.boot;
  if (!boot?.imageUrl) return "";
  const info = boot.imageInfo || {};
  const size = info.width && info.height ? `${info.width} x ${info.height}` : "unknown size";
  const frames = Number.isFinite(info.frames) ? ` · ${info.frames} frame${info.frames === 1 ? "" : "s"}` : "";
  return `
    <div class="subhead">Initial Screen</div>
    <div class="runtime-boot">
      <div class="runtime-phone-screen" style="width:${runtime.screen?.width || 240}px;height:${runtime.screen?.height || 400}px;">
        <img src="${escapeHtml(boot.imageUrl)}" alt="${escapeHtml(boot.name || "initial screen")}">
      </div>
      <div class="map-caption">${escapeHtml(`${boot.name || "startup image"} · ${size}${frames} · ${boot.confidence || "startup candidate"}`)}</div>
    </div>
  `;
}

function renderEmulatorImageFrame(name, image, active) {
  if (!image?.imageUrl) return "";
  return `
    <div class="emulator-frame${active ? " active" : ""}" data-emulator-frame="${escapeHtml(name)}">
      <img src="${escapeHtml(image.imageUrl)}" alt="${escapeHtml(image.name || name)}">
    </div>
  `;
}

function renderFlowImage(image, className = "flow-image") {
  if (!image?.imageUrl) return "";
  const size = image.imageInfo?.width && image.imageInfo?.height
    ? `${image.imageInfo.width} x ${image.imageInfo.height}`
    : image.note || "";
  return `
    <figure class="${className}">
      <img src="${escapeHtml(image.imageUrl)}" alt="${escapeHtml(image.name || "flow image")}">
      <figcaption>${escapeHtml(image.name || size || "")}</figcaption>
    </figure>
  `;
}

function renderBootFlowChoices(choices) {
  if (!choices?.length) return "";
  return `
    <div class="flow-choices">
      ${choices.map((choice, index) => `
        <button class="flow-choice ${index === 0 ? "selected" : ""}" data-emulator-input="choice" data-choice-index="${index}" data-choice-id="${escapeHtml(choice.id || "")}" data-scene-rel="${escapeHtml(choice.sceneRel || "")}">
          ${renderFlowImage(choice.image, "flow-choice-image")}
          <span>${escapeHtml(choice.title || choice.id || "choice")}</span>
          <small>${escapeHtml(choice.protagonist || choice.status || "")}</small>
        </button>
      `).join("")}
    </div>
  `;
}

function renderBootFlowFrame(step, index, active) {
  const images = [step.image, ...(step.images || [])].filter(Boolean);
  const imageGrid = images.length
    ? `<div class="flow-images">${images.map((image) => renderFlowImage(image)).join("")}</div>`
    : "";
  const text = step.text ? `<div class="flow-text">${escapeHtml(step.text)}</div>` : "";
  const evidence = step.evidenceOffset ? `<div class="flow-evidence">${escapeHtml(step.evidenceOffset)}</div>` : "";
  return `
    <div class="emulator-frame boot-flow-frame${active ? " active" : ""}" data-emulator-frame="flow-${index}" data-flow-index="${index}" data-flow-mode="${escapeHtml(step.mode || "")}" data-flow-title="${escapeHtml(step.title || step.id || "")}">
      <div class="flow-card">
        <div class="flow-step">${escapeHtml(`${index + 1}`.padStart(2, "0"))}</div>
        <h3>${escapeHtml(step.title || step.id || "Boot flow")}</h3>
        ${imageGrid}
        ${text}
        ${renderBootFlowChoices(step.choices || [])}
        ${evidence}
      </div>
    </div>
  `;
}

function renderBootFlowFrames(runtime, active) {
  const steps = runtime?.bootFlow?.steps || [];
  return steps.map((step, index) => renderBootFlowFrame(step, index, active && index === 0)).join("");
}

function renderEmulatorPanel(runtime) {
  if (!runtime?.screen) return "";
  const screen = runtime.screen;
  const canvas = runtime.scene?.canvas || screen;
  const camera = runtime.camera || { x: 0, y: 0, width: screen.width, height: screen.height };
  const flowSteps = runtime.bootFlow?.steps || [];
  const startsOnFlow = flowSteps.length > 0;
  const startsOnBoot = Boolean(runtime.boot?.imageUrl);
  const startsOnScene = !startsOnFlow && !startsOnBoot;
  const sceneActors = renderEmulatorActors(runtime);
  const sceneMapTiles = renderRuntimeMapTiles(runtime.scene?.map || {});
  const mapPlaneClass = `runtime-map-plane${sceneMapTiles ? " has-tiles" : ""}`;
  const controlCandidates = runtime.control?.candidates || runtime.entities || [];
  const firstChoiceRow = flowSteps.find((step) => step.mode === "choice")?.choices?.[0] || null;
  const firstChoice = firstChoiceRow?.id || "";
  const firstChoiceScene = firstChoiceRow?.sceneRel || "";
  const entityOptions = controlCandidates.map((entity) => {
    const label = `${entity.matched || entity.name || entity.id} @ ${entity.x},${entity.y}`;
    return `<option value="${escapeHtml(entity.id || "")}">${escapeHtml(label)}</option>`;
  }).join("");
  const actorControls = controlCandidates.length ? `
    <label class="emulator-select">
      <span>Follow</span>
      <select data-emulator-follow>
        <option value="">Camera only</option>
        ${entityOptions}
      </select>
    </label>
  ` : "";
  return `
    <div class="subhead">Emulator</div>
    <div class="emulator" data-emulator data-mode="${startsOnFlow ? "flow-0" : startsOnBoot ? "boot" : "scene"}" data-flow-count="${flowSteps.length}" data-route-choice="${escapeHtml(firstChoice)}" data-route-scene-rel="${escapeHtml(firstChoiceScene)}" data-camera-x="${camera.x}" data-camera-y="${camera.y}" data-canvas-width="${canvas.width || screen.width}" data-canvas-height="${canvas.height || screen.height}" data-screen-width="${screen.width}" data-screen-height="${screen.height}" data-control-entity-id="${escapeHtml(runtime.control?.entityId || "")}" data-step="${runtime.control?.step || 16}">
      <div class="emulator-screen" tabindex="0" style="width:${screen.width}px;height:${screen.height}px;">
        ${startsOnFlow ? renderBootFlowFrames(runtime, true) : renderEmulatorImageFrame("boot", runtime.boot, startsOnBoot)}
        ${startsOnFlow ? "" : renderEmulatorImageFrame("loading", runtime.loading || runtime.boot, false)}
        <div class="emulator-frame emulator-scene${startsOnScene ? " active" : ""}" data-emulator-frame="scene">
          <div class="${mapPlaneClass}" data-emulator-map-plane style="left:-${camera.x}px;top:-${camera.y}px;width:${canvas.width || screen.width}px;height:${canvas.height || screen.height}px;">${sceneMapTiles}</div>
          <div class="phone-layer" data-emulator-scene-layer style="left:-${camera.x}px;top:-${camera.y}px;width:${canvas.width || screen.width}px;height:${canvas.height || screen.height}px;">
            ${sceneActors}
          </div>
        </div>
        <div class="emulator-status" data-emulator-status>${startsOnFlow ? escapeHtml(flowSteps[0]?.title || "BOOT FLOW") : startsOnBoot ? "TITLE" : "SCENE"} · ${screen.width}x${screen.height}</div>
      </div>
      <div class="emulator-modebar">
        ${actorControls}
        <button class="emu-action" data-emulator-input="center" title="Center camera">Center</button>
        <button class="emu-action" data-emulator-input="scene" title="Jump to scene">Scene</button>
      </div>
      <div class="emulator-controls">
        <button class="emu-key" data-emulator-input="up" title="Up">↑</button>
        <button class="emu-key" data-emulator-input="left" title="Left">←</button>
        <button class="emu-key emu-key-main" data-emulator-input="confirm" title="OK">OK</button>
        <button class="emu-key" data-emulator-input="right" title="Right">→</button>
        <button class="emu-key" data-emulator-input="down" title="Down">↓</button>
        <button class="emu-key" data-emulator-input="back" title="Back">↩</button>
      </div>
    </div>
  `;
}

function renderRuntimeTransitions(transitions) {
  const scenes = transitions?.scenes || [];
  if (!scenes.length) return "";
  return `
    <div class="subhead">Scene Transitions</div>
    <div class="relation-grid">
      ${scenes.map((item) => `
        <button class="relation-card" data-jump-rel="${escapeHtml(item.rel || item.to || "")}">
          <div class="relation-thumb"><div class="mini-icon">SCE</div></div>
          <div class="relation-info">
            <div class="relation-role">${escapeHtml(item.source === "linked-script" ? "script transition" : "scene edge")}</div>
            <div class="relation-name">${escapeHtml(item.label || displayNameFromRel(item.rel || item.to))}</div>
            <div class="relation-meta">${escapeHtml(`${item.offset || ""} · ${transitions.note || ""}`)}</div>
          </div>
        </button>
      `).join("")}
    </div>
  `;
}

function renderTrueRuntimeProbe(probe) {
  if (!probe?.source) return "";
  const xse = probe.xseVm || {};
  const gate = xse.vmGate || {};
  const reader = xse.readerService || {};
  const prep = xse.streamPrep || {};
  const streamService = xse.streamService || {};
  const providerService = xse.providerService || {};
  const providerReplay = xse.providerReplay || {};
  const cursor50Variants = xse.cursor50Variants || {};
  const providerAbi = xse.providerAbi || {};
  const providerAbiShim = xse.providerAbiShim || {};
  const switchReplay = xse.xseSwitchReplay || {};
  const runtimeDispatch = xse.xseRuntimeDispatch || {};
  const dispatchCases = xse.xseDispatchCases || {};
  const traceVm = xse.xseTraceVm || {};
  const writeback = xse.xseWriteback || {};
  const cursorInit = xse.xseCursorInit || {};
  const slotLifecycle = xse.xseSlotLifecycle || {};
  const operandBinding = xse.xseOperandBinding || {};
  const entrypoint = xse.xseEntrypoint || {};
  const entryLabel = xse.xseEntryLabel || {};
  const entryCaller = xse.xseEntryCaller || {};
  const entryCompare = xse.xseEntryCompare || {};
  const labelPointer = xse.xseLabelPointer || {};
  const refEncoding = xse.xseRefEncoding || {};
  const compareNormalization = xse.xseCompareNormalization || {};
  const tailBoundary = xse.xseTailBoundary || {};
  const compareService = xse.xseCompareService || {};
  const compareShim = xse.xseCompareShim || {};
  const activation = xse.xseActivation || {};
  const activatedDispatch = xse.xseActivatedDispatch || {};
  const activatedOperand = xse.xseActivatedOperand || {};
  const highOpcode = xse.xseHighOpcode || {};
  const entrySafety = xse.xseEntrySafety || {};
  const refWidthSafety = xse.xseRefWidthSafety || {};
  const compareAbi = xse.xseCompareAbi || {};
  const refNamespace = xse.xseRefNamespace || {};
  const ref64Loader = xse.xseRef64Loader || {};
  const providerRefContext = xse.providerRefContext || {};
  const compareResolver = xse.xseCompareResolver || {};
  const providerResolverHook = xse.providerResolverHook || {};
  const provider35c4Tape = xse.provider35c4Tape || {};
  const provider35c4Feed = xse.provider35c4Feed || {};
  const provider35c4Capture = xse.provider35c4Capture || {};
  const provider35c4Source = xse.provider35c4Source || {};
  const provider35c4Emu = xse.provider35c4Emu || {};
  const provider35c4SvcObj = xse.provider35c4SvcObj || {};
  const provider35c4SvcResolver = xse.provider35c4SvcResolver || {};
  const provider35c4LiveCall = xse.provider35c4LiveCall || {};
  const provider35c4StreamExec = xse.provider35c4StreamExec || {};
  const provider35c4TableWalk = xse.provider35c4TableWalk || {};
  const provider35c4CountMode = xse.provider35c4CountMode || {};
  const provider35c4S02Source = xse.provider35c4S02Source || {};
  const provider35c4SelectedTable = xse.provider35c4SelectedTable || {};
  const provider35c4SelectedFeed = xse.provider35c4SelectedFeed || {};
  const provider35c4PromotionFrontier = xse.provider35c4PromotionFrontier || {};
  const provider35c4FrontierModeScan = xse.provider35c4FrontierModeScan || {};
  const provider35c4Return0Priority = xse.provider35c4Return0Priority || {};
  const provider35c4Return0Injection = xse.provider35c4Return0Injection || {};
  const provider35c4Return0Capture = xse.provider35c4Return0Capture || {};
  const provider35c4CapturedFeed = xse.provider35c4CapturedFeed || {};
  const provider35c4ObservationRecorder = xse.provider35c4ObservationRecorder || {};
  const provider35c4RuntimeSink = xse.provider35c4RuntimeSink || {};
  const cbeRuntimeCore = xse.cbeRuntimeCore || {};
  const cbeRuntimeCoreScene = xse.cbeRuntimeCoreScene || {};
  const copyHelper = xse.copyHelper || {};
  const slotAudit = xse.slotAudit || {};
  const lifecycle = xse.serviceLifecycle || {};
  const loaderCallers = xse.loaderCallers || {};
  const wrapperFacade = xse.wrapperFacade || {};
  const facadeSlots = xse.facadeSlots || {};
  const managerRoot = xse.managerRoot || {};
  const facadeEquivalence = xse.facadeEquivalence || {};
  const facadeNormalized = xse.facadeNormalized || {};
  const dispatchScripts = runtimeDispatch.scripts || [];
  const switchScripts = switchReplay.scripts || [];
  const gateScripts = gate.scripts || [];
  const scriptRows = dispatchScripts.length ? dispatchScripts.map((script) => {
    const tail = script.tailBest || {};
    const run = script.dispatchBest || {};
    const exec = script.executionBest || {};
    const tailText = `${tail.mode || "-"} ${tail.directGroups ?? "-"}/${tail.defaultGroups ?? "-"} delta=${tail.layoutDelta ?? "-"}`;
    const runText = `${run.mode || "-"} ${run.directGroups ?? "-"}/${run.defaultGroups ?? "-"} score=${run.dispatchScore ?? "-"}`;
    const execText = `${exec.mode || "-"} ${exec.directGroups ?? "-"}/${exec.defaultGroups ?? "-"} score=${exec.executionScore ?? "-"}`;
    return `<li><span>${escapeHtml(script.name)}</span>${escapeHtml(`tail ${tailText} -> dispatch ${runText} -> exec ${execText}${script.executionCorrection ? " · corrected" : ""}${script.tension ? " · tension" : ""}`)}</li>`;
  }).join("") : switchScripts.length ? switchScripts.map((script) => {
    const tail = script.tailEnd && script.layoutEnd
      ? `tail ${script.tailEnd}/${script.layoutEnd} delta=${script.layoutDelta ?? "-"}`
      : "tail pending";
    const meta = `mode=${script.mode || "-"} records=${script.records ?? "-"} high>=9=${script.highOpcodePercent ?? "-"}%`;
    return `<li><span>${escapeHtml(script.name)}</span>${escapeHtml(`${tail} · ${meta}`)}</li>`;
  }).join("") : gateScripts.length ? gateScripts.map((script) => {
    const status = script.layoutAlignedStrictPath
      ? "strict path"
      : (script.anyStrictOpcodePath ? `shallow ${script.bestEndOffset || ""} delta=${script.bestLayoutDelta ?? "-"}` : "blocked");
    const meta = `opcode=${script.baselineKnownOpcodePercent}% recordSize=${script.headerRecordByteSize ?? "-"} groups=${script.headerGroupCount ?? "-"}`;
    return `<li><span>${escapeHtml(script.name)}</span>${escapeHtml(`${status} · ${meta}`)}</li>`;
  }).join("") : "";
  const readerText = reader.available
    ? `${reader.status || ""} ${reader.blockingSlot ? `slot ${reader.blockingSlot}` : ""}`.trim()
    : (reader.reason || "-");
  const gateText = gate.available
    ? `legacy strict-gate ${gate.alignedCount || 0}/${gate.scriptCount || 0} layout-aligned; ${gate.shallowCount || 0} shallow`
    : (gate.reason || "-");
  const prepText = prep.available
    ? prep.currentBlocker || "-"
    : prep.reason || "-";
  const streamServiceText = streamService.available
    ? streamService.currentFinding || "-"
    : streamService.reason || "-";
  const streamServiceFocus = streamService.available && Array.isArray(streamService.chains)
    ? streamService.chains.map((chain) => `${chain.name}:${chain.open || "open?"}->${chain.convert || "convert?"}`).join(" · ")
    : "";
  const providerServiceText = providerService.available
    ? providerService.serviceSplit || providerService.currentFinding || "-"
    : providerService.reason || "-";
  const providerServiceFocus = providerService.available && Array.isArray(providerService.assignments)
    ? providerService.assignments
      .filter((item) => item.global === "0x35C0" || item.global === "0x35C4" || item.global === "0x35E0")
      .map((item) => `${item.global}@${item.store} <= ${item.source}`)
      .join(" · ")
    : "";
  const providerReplayText = providerReplay.available
    ? providerReplay.currentFinding || "-"
    : providerReplay.reason || "-";
  const providerReplayFocus = providerReplay.available
    ? [
      providerReplay.sce?.status ? `SCE ${providerReplay.sce.status} ${providerReplay.sce.fields?.width || "?"}x${providerReplay.sce.fields?.height || "?"}` : "",
      providerReplay.xse?.status ? `XSE ${providerReplay.xse.status}` : "",
    ].filter(Boolean).join(" · ")
    : "";
  const cursor50Text = cursor50Variants.available
    ? cursor50Variants.currentFinding || "-"
    : cursor50Variants.reason || "-";
  const cursor50Focus = cursor50Variants.available
    ? [
      cursor50Variants.actorBest ? `actor ${cursor50Variants.actorBest}` : "",
      cursor50Variants.topXse ? `XSE aligned ${cursor50Variants.topXse.alignedCount || 0}/${cursor50Variants.topXse.scriptCount || 0}` : "",
      cursor50Variants.topXse ? `strict ${cursor50Variants.topXse.strictCount || 0}/${cursor50Variants.topXse.scriptCount || 0}` : "",
    ].filter(Boolean).join(" · ")
    : "";
  const providerAbiText = providerAbi.available
    ? providerAbi.currentFinding || "-"
    : providerAbi.reason || "-";
  const providerAbiFocus = providerAbi.available && Array.isArray(providerAbi.criticalReturns)
    ? providerAbi.criticalReturns.map((item) => `${item.method}->${item.target}`).join(" · ")
    : "";
  const providerAbiShimText = providerAbiShim.available
    ? providerAbiShim.currentFinding || "-"
    : providerAbiShim.reason || "-";
  const providerAbiShimFocus = providerAbiShim.available
    ? [
      providerAbiShim.sce?.status ? `SCE ${providerAbiShim.sce.status} ${providerAbiShim.sce.fields?.width || "?"}x${providerAbiShim.sce.fields?.height || "?"}` : "",
      providerAbiShim.xse?.status ? `XSE ${providerAbiShim.xse.status}` : "",
      providerAbiShim.xse ? `aligned ${providerAbiShim.xse.alignedCandidateCount || 0}` : "",
      providerAbiShim.xse ? `strict ${providerAbiShim.xse.strictCandidateCount || 0}` : "",
      providerAbiShim.providerRefSamples?.sampledScriptCount ? `refctx ${providerAbiShim.providerRefSamples.sampledScriptCount}` : "",
      providerAbiShim.providerRefNamespace ? `ns refs ${providerAbiShim.providerRefNamespace.refCount || 0}` : "",
      providerAbiShim.providerRefNamespace ? `ns cmp ${providerAbiShim.providerRefNamespace.compareCount || 0}` : "",
      providerAbiShim.resolverHook?.mode ? `hook ${providerAbiShim.resolverHook.bound ? "bound" : "unbound"}` : "",
    ].filter(Boolean).join(" · ")
    : "";
  const switchReplayText = switchReplay.available
    ? switchReplay.currentFinding || "-"
    : switchReplay.reason || "-";
  const switchReplayFocus = switchReplay.available
    ? [
      switchReplay.status || "",
      `ok ${switchReplay.okScripts || 0}/${switchReplay.scriptCount || 0}`,
      `close tails ${switchReplay.closeTailScripts || 0}/${switchReplay.scriptCount || 0}`,
    ].filter(Boolean).join(" · ")
    : "";
  const dispatchText = runtimeDispatch.available
    ? runtimeDispatch.currentFinding || "-"
    : runtimeDispatch.reason || "-";
  const dispatchFocus = runtimeDispatch.available
    ? [
      runtimeDispatch.status || "",
      `tension ${runtimeDispatch.tensionCount || 0}/${runtimeDispatch.scriptCount || 0}`,
      `exec corrections ${runtimeDispatch.executionCorrectionCount || 0}/${runtimeDispatch.scriptCount || 0}`,
      runtimeDispatch.tensionScripts?.length ? runtimeDispatch.tensionScripts.join(", ") : "",
    ].filter(Boolean).join(" · ")
    : "";
  const dispatchCaseText = dispatchCases.available
    ? dispatchCases.currentFinding || "-"
    : dispatchCases.reason || "-";
  const dispatchCaseFocus = dispatchCases.available
    ? [
      dispatchCases.status || "",
      dispatchCases.focusedDirect?.length ? `direct ${dispatchCases.focusedDirect.join(",")}` : "",
      dispatchCases.focusedTargets?.length ? dispatchCases.focusedTargets.join(", ") : "",
    ].filter(Boolean).join(" · ")
    : "";
  const traceVmText = traceVm.available
    ? traceVm.currentFinding || "-"
    : traceVm.reason || "-";
  const traceVmFocus = traceVm.available
    ? [
      traceVm.status || "",
      `steps ${traceVm.stepCount || 0}`,
      `defaults ${traceVm.highOpcodeOperandDefaultSteps || 0}`,
      `writeback blockers ${traceVm.writebackTargetBlockedSteps || 0}`,
      `shape suspects ${traceVm.registerShapeSuspectSteps || 0}`,
      traceVm.avoidedRegisterShapeSuspects?.length ? `avoided shape ${traceVm.avoidedRegisterShapeSuspects.length}` : "",
    ].filter(Boolean).join(" · ")
    : "";
  const writebackText = writeback.available
    ? writeback.currentFinding || "-"
    : writeback.reason || "-";
  const writebackFocus = writeback.available
    ? [
      writeback.status || "",
      writeback.writebackSite ? `site ${writeback.writebackSite}` : "",
      writeback.writebackSite ? `guard ${writeback.nullGuardedWritebackSite ? "yes" : "no"}` : "",
      `risks ${writeback.executionWritebackRiskCount || 0}`,
      writeback.directLowRiskScripts?.length ? `direct-safe ${writeback.directLowRiskScripts.length}` : "",
      writeback.executionRiskScripts?.length ? writeback.executionRiskScripts.join(", ") : "",
    ].filter(Boolean).join(" · ")
    : "";
  const cursorInitText = cursorInit.available
    ? cursorInit.currentFinding || "-"
    : cursorInit.reason || "-";
  const cursorInitFocus = cursorInit.available
    ? [
      cursorInit.status || "",
      `not-seeded ${cursorInit.executionNotSeededCount || 0}/${cursorInit.scripts?.length || 0}`,
      `seedable ${cursorInit.executionSeedableCount || 0}/${cursorInit.scripts?.length || 0}`,
    ].filter(Boolean).join(" · ")
    : "";
  const slotLifecycleText = slotLifecycle.available
    ? slotLifecycle.currentFinding || "-"
    : slotLifecycle.reason || "-";
  const slotLifecycleFocus = slotLifecycle.available
    ? [
      slotLifecycle.status || "",
      `+50 not-seeded ${slotLifecycle.executionGroupCursorNotSeededCount || 0}/${slotLifecycle.scripts?.length || 0}`,
      `cursor0 first ${slotLifecycle.cursorZeroFirstBlockerCount || 0}`,
      `blockers ${slotLifecycle.writebackBlockerCount || 0}`,
      slotLifecycle.firstBlockerScripts?.length ? slotLifecycle.firstBlockerScripts.join(", ") : "",
    ].filter(Boolean).join(" · ")
    : "";
  const operandBindingText = operandBinding.available
    ? operandBinding.currentFinding || "-"
    : operandBinding.reason || "-";
  const operandBindingFocus = operandBinding.available
    ? [
      operandBinding.status || "",
      `op0 pointers ${operandBinding.operand0PointerTypeCount || 0}/${operandBinding.writebackBlockerCount || 0}`,
      `stack-seed ${operandBinding.stackSeedRelevantBlockerCount || 0}/${operandBinding.writebackBlockerCount || 0}`,
      operandBinding.operand0Types?.length ? `op0 ${operandBinding.operand0Types.join(",")}` : "",
    ].filter(Boolean).join(" · ")
    : "";
  const entrypointText = entrypoint.available
    ? entrypoint.currentFinding || "-"
    : entrypoint.reason || "-";
  const entrypointFocus = entrypoint.available
    ? [
      entrypoint.status || "",
      `plausible ${(entrypoint.scriptsWithPlausibleEntries || []).length}/${entrypoint.scriptCount || 0}`,
      `safe ${(entrypoint.scriptsWithSafeEntries || []).length}/${entrypoint.scriptCount || 0}`,
      entrypoint.scriptsWithPlausibleEntries?.length ? entrypoint.scriptsWithPlausibleEntries.join(", ") : "",
    ].filter(Boolean).join(" · ")
    : "";
  const entryLabelText = entryLabel.available
    ? entryLabel.currentFinding || "-"
    : entryLabel.reason || "-";
  const entryLabelFocus = entryLabel.available
    ? [
      entryLabel.status || "",
      `label ${(entryLabel.labelConfirmedScripts || []).length}/${entryLabel.scriptCount || 0}`,
      `command-only ${(entryLabel.commandOnlyScripts || []).length}/${entryLabel.scriptCount || 0}`,
      entryLabel.commandOnlyScripts?.length ? entryLabel.commandOnlyScripts.join(", ") : "",
    ].filter(Boolean).join(" · ")
    : "";
  const entryCallerText = entryCaller.available
    ? entryCaller.currentFinding || "-"
    : entryCaller.reason || "-";
  const entryCallerFocus = entryCaller.available
    ? [
      entryCaller.status || "",
      `calls ${entryCaller.callCount || 0}`,
      `dispatch ${entryCaller.dispatchingCallCount || 0}`,
      `select ${entryCaller.selectOnlyCallCount || 0}`,
      entryCaller.semanticLabels?.length ? entryCaller.semanticLabels.join(", ") : "",
    ].filter(Boolean).join(" · ")
    : "";
  const entryCompareText = entryCompare.available
    ? entryCompare.currentFinding || "-"
    : entryCompare.reason || "-";
  const entryCompareFocus = entryCompare.available
    ? [
      entryCompare.status || "",
      entryCompare.requestedLabels?.length ? `labels ${entryCompare.requestedLabels.join(", ")}` : "",
      `safe ${(entryCompare.safeLabelScripts || []).length}/${entryCompare.scriptCount || 0}`,
      `unsafe ${(entryCompare.unsafeLabelScripts || []).length}/${entryCompare.scriptCount || 0}`,
      `ptr-delta ${entryCompare.callerPointerNonZeroDeltaCount || 0}`,
    ].filter(Boolean).join(" · ")
    : "";
  const labelPointerText = labelPointer.available
    ? labelPointer.currentFinding || "-"
    : labelPointer.reason || "-";
  const labelPointerFocus = labelPointer.available
    ? [
      labelPointer.status || "",
      `exact-full ${labelPointer.exactFullLabelCount || 0}/${labelPointer.profileCount || 0}`,
      `suffix ${labelPointer.suffixPointerCount || 0}`,
      `pretarget ${labelPointer.pretargetMismatchCount || 0}`,
      `pc+2 ${(labelPointer.pcPlus2FullLabelCount || 0)}/${labelPointer.profileCount || 0}`,
      `exactADR ${labelPointer.exactAdrSelectedCount || 0}`,
    ].filter(Boolean).join(" · ")
    : "";
  const refEncodingText = refEncoding.available
    ? refEncoding.currentFinding || "-"
    : refEncoding.reason || "-";
  const refEncodingFocus = refEncoding.available
    ? [
      refEncoding.status || "",
      `safe-label ${(refEncoding.safeLabelScripts || []).length}/${refEncoding.scriptCount || 0}`,
      `risky-label ${(refEncoding.riskyLabelScripts || []).length}/${refEncoding.scriptCount || 0}`,
      refEncoding.topRef64Modes?.length ? `ref64 ${refEncoding.topRef64Modes.join("/")}` : "",
    ].filter(Boolean).join(" · ")
    : "";
  const compareNormalizationText = compareNormalization.available
    ? compareNormalization.currentFinding || "-"
    : compareNormalization.reason || "-";
  const compareNormalizationFocus = compareNormalization.available
    ? [
      compareNormalization.status || "",
      `exact ${(compareNormalization.exactRequestedCoverage || 0)}/${compareNormalization.profileCount || 0}`,
      `pc+2 ${(compareNormalization.pcPlus2RequestedCoverage || 0)}/${compareNormalization.profileCount || 0}`,
      `target+/-2 ${(compareNormalization.targetPlusMinus2RequestedCoverage || 0)}/${compareNormalization.profileCount || 0}`,
      `safe ${(compareNormalization.primarySafeScripts || []).length}`,
      `risk ${(compareNormalization.primaryRiskScripts || []).length}`,
    ].filter(Boolean).join(" · ")
    : "";
  const tailBoundaryText = tailBoundary.available
    ? tailBoundary.currentFinding || "-"
    : tailBoundary.reason || "-";
  const tailBoundaryFocus = tailBoundary.available
    ? [
      tailBoundary.status || "",
      `clean ${(tailBoundary.cleanTextPayloadScripts || []).length}/${tailBoundary.scriptCount || 0}`,
      `safe ${(tailBoundary.cleanTextPayloadSafeScripts || []).length}/${tailBoundary.scriptCount || 0}`,
      `cross ${(tailBoundary.crossingOnlyTextPayloadScripts || []).length}/${tailBoundary.scriptCount || 0}`,
    ].filter(Boolean).join(" · ")
    : "";
  const compareServiceText = compareService.available
    ? compareService.currentFinding || "-"
    : compareService.reason || "-";
  const compareServiceFocus = compareService.available
    ? [
      compareService.status || "",
      `roles ${compareService.plus50RoleCount || 0}`,
      compareService.compareReturnsZeroOnMatch ? "return0 match" : "",
      compareService.plus50Roles?.length ? compareService.plus50Roles.join(" / ") : "",
    ].filter(Boolean).join(" · ")
    : "";
  const compareShimText = compareShim.available
    ? compareShim.currentFinding || "-"
    : compareShim.reason || "-";
  const compareShimFocus = compareShim.available
    ? [
      compareShim.status || "",
      compareShim.primaryModel ? `model ${compareShim.primaryModel}` : "",
      `safe ${(compareShim.selectedSafeScripts || []).length}/${compareShim.scriptCount || 0}`,
      `risk ${(compareShim.selectedWritebackRiskScripts || []).length}/${compareShim.scriptCount || 0}`,
      `all-strong implausible ${(compareShim.allStrongImplausibleScripts || []).length}/${compareShim.scriptCount || 0}`,
      `exact ${(compareShim.exactAdrSelectedCount || 0)}/${compareShim.scriptCount || 0}`,
    ].filter(Boolean).join(" · ")
    : "";
  const activationText = activation.available
    ? activation.currentFinding || "-"
    : activation.reason || "-";
  const activationFocus = activation.available
    ? [
      activation.status || "",
      `selected ${(activation.primarySelectedScripts || []).length}/${activation.scriptCount || 0}`,
      `safe ${(activation.primarySafeScripts || []).length}/${activation.scriptCount || 0}`,
      `risk ${(activation.primaryRiskScripts || []).length}/${activation.scriptCount || 0}`,
      `broad-invalid ${(activation.broadInvalidScripts || []).length}/${activation.scriptCount || 0}`,
    ].filter(Boolean).join(" · ")
    : "";
  const activatedDispatchText = activatedDispatch.available
    ? activatedDispatch.currentFinding || "-"
    : activatedDispatch.reason || "-";
  const activatedDispatchFocus = activatedDispatch.available
    ? [
      activatedDispatch.status || "",
      `selected ${activatedDispatch.primarySelectedCount || 0}/${activatedDispatch.scriptCount || 0}`,
      `steps ${activatedDispatch.primaryActivatedStepCount || 0}/${activatedDispatch.primarySelectedCount || 0}`,
      `writeback ${(activatedDispatch.primaryWritebackBlockedCount || 0)}/${activatedDispatch.primarySelectedCount || 0}`,
      `stack-seed ${(activatedDispatch.primaryStackSeedRelevantCount || 0)}/${activatedDispatch.primarySelectedCount || 0}`,
      activatedDispatch.blockedScripts?.length ? activatedDispatch.blockedScripts.join(", ") : "",
    ].filter(Boolean).join(" · ")
    : "";
  const activatedOperandText = activatedOperand.available
    ? activatedOperand.currentFinding || "-"
    : activatedOperand.reason || "-";
  const activatedOperandFocus = activatedOperand.available
    ? [
      activatedOperand.status || "",
      `stable ${activatedOperand.stableBoundaryCount || 0}/${activatedOperand.blockedPrimaryCount || 0}`,
      activatedOperand.rows?.length ? activatedOperand.rows.map((row) => `${row.script}:${row.dispatch?.operand0?.typeHex || "-"}`).join(", ") : "",
    ].filter(Boolean).join(" · ")
    : "";
  const highOpcodeText = highOpcode.available
    ? highOpcode.currentFinding || "-"
    : highOpcode.reason || "-";
  const highOpcodeFocus = highOpcode.available
    ? [
      highOpcode.status || "",
      `high-wb ${highOpcode.highOpcodeWritebackRiskCount || 0}/${highOpcode.writebackRiskCount || 0}`,
      `numeric-default ${highOpcode.numericDefaultHighOperandCount || 0}/${highOpcode.highOperandUseCount || 0}`,
      `activated ${highOpcode.activatedHighOpcodeBlockedCount || 0}/${highOpcode.activatedHighOpcodeCount || 0}`,
      highOpcode.activatedRows?.length ? highOpcode.activatedRows.map((row) => `${row.script}:${row.operand0?.typeHex || "-"}`).join(", ") : "",
    ].filter(Boolean).join(" · ")
    : "";
  const entrySafetyText = entrySafety.available
    ? entrySafety.currentFinding || "-"
    : entrySafety.reason || "-";
  const entrySafetyFocus = entrySafety.available
    ? [
      entrySafety.status || "",
      `selected ${entrySafety.primarySelectedCount || 0}/${entrySafety.scriptCount || 0}`,
      `promotable ${entrySafety.promotablePrimaryCount || 0}/${entrySafety.scriptCount || 0}`,
      `high-demoted ${entrySafety.demotedHighOpcodeWritebackCount || 0}`,
      `unmatched ${entrySafety.unmatchedPrimaryCount || 0}/${entrySafety.scriptCount || 0}`,
      entrySafety.demotedHighOpcodeWritebackScripts?.length ? entrySafety.demotedHighOpcodeWritebackScripts.join(", ") : "",
    ].filter(Boolean).join(" · ")
    : "";
  const refWidthSafetyText = refWidthSafety.available
    ? refWidthSafety.currentFinding || "-"
    : refWidthSafety.reason || "-";
  const refWidthSafetyFocus = refWidthSafety.available
    ? [
      refWidthSafety.status || "",
      `scans ${refWidthSafety.totalCandidateScans || 0}`,
      `first-safe ${refWidthSafety.firstSafeMatchCount || 0}`,
      `safe ${refWidthSafety.safeMatchCount || 0}`,
      `unsafe ${refWidthSafety.unsafeMatchCount || 0}`,
      refWidthSafety.matchedScripts?.length ? `matched ${refWidthSafety.matchedScripts.join(", ")}` : "",
    ].filter(Boolean).join(" · ")
    : "";
  const compareAbiText = compareAbi.available
    ? compareAbi.currentFinding || "-"
    : compareAbi.reason || "-";
  const compareAbiFocus = compareAbi.available
    ? [
      compareAbi.status || "",
      `stream ${compareAbi.streamCursorReadCount || 0}`,
      `compare ${compareAbi.labelRefCompareCount || 0}`,
      compareAbi.compareReturnsZeroOnMatch ? "return0 match" : "",
      compareAbi.compareBranchMissingFromShim ? "shim branch missing" : "",
    ].filter(Boolean).join(" · ")
    : "";
  const refNamespaceText = refNamespace.available
    ? refNamespace.currentFinding || "-"
    : refNamespace.reason || "-";
  const refNamespaceFocus = refNamespace.available
    ? [
      refNamespace.status || "",
      `scalar-safe ${refNamespace.scalarSafeMatchCount || 0}`,
      `unsafe ${refNamespace.unsafeScalarCollisionCount || 0}`,
      `resolver ${refNamespace.resolverBound ? "bound" : "unbound"}`,
      refNamespace.visibleEffectsEnabled ? "effects enabled" : "effects disabled",
      refNamespace.primarySelections?.length ? refNamespace.primarySelections.map((row) => `${row.script}:${row.selected ? `entry${row.entry}` : "unmatched"}`).join(", ") : "",
    ].filter(Boolean).join(" · ")
    : "";
  const ref64LoaderText = ref64Loader.available
    ? ref64Loader.currentFinding || "-"
    : ref64Loader.reason || "-";
  const ref64LoaderFocus = ref64Loader.available
    ? [
      ref64Loader.status || "",
      `selected-text ${ref64Loader.selectedInlineTextCount || 0}/${ref64Loader.selectedEntryCount || 0}`,
      ref64Loader.rangeRefCallSite ? `range ${ref64Loader.rangeRefCallSite}` : "",
      ref64Loader.finalRefCallSite ? `final ${ref64Loader.finalRefCallSite}` : "",
      ref64Loader.scripts?.length ? ref64Loader.scripts.map((script) => {
        const selected = script.topCandidate?.selectedEntry;
        return `${script.name}:${selected ? `entry${selected.index} ${selected.lengthTextStatus}` : script.status}`;
      }).join(", ") : "",
    ].filter(Boolean).join(" · ")
    : "";
  const providerRefContextText = providerRefContext.available
    ? providerRefContext.currentFinding || "-"
    : providerRefContext.reason || "-";
  const providerRefContextFocus = providerRefContext.available
    ? [
      providerRefContext.status || "",
      `contexts ${providerRefContext.contextCount || 0}`,
      `text ${providerRefContext.textSafeContextCount || 0}`,
      `opaque ${providerRefContext.opaqueContextCount || 0}`,
      providerRefContext.visibleEffectsEnabled ? "effects enabled" : "effects disabled",
      providerRefContext.contexts?.length ? providerRefContext.contexts.map((context) => `${context.id}:${context.safeToParseAsText ? "text" : "opaque"}`).join(", ") : "",
    ].filter(Boolean).join(" · ")
    : "";
  const compareResolverText = compareResolver.available
    ? compareResolver.currentFinding || "-"
    : compareResolver.reason || "-";
  const compareResolverFocus = compareResolver.available
    ? [
      compareResolver.status || "",
      compareResolver.providerReaderGlobal ? `${compareResolver.providerReaderGlobal}${compareResolver.compareSlot || ""}` : "",
      `samples ${compareResolver.shimCompareSampleCount || 0}`,
      `unbound ${compareResolver.shimUnboundSampleCount || 0}`,
      compareResolver.ledgerRefCount ? `ledger refs ${compareResolver.ledgerRefCount}` : "",
      compareResolver.ledgerCompareCount ? `ledger cmp ${compareResolver.ledgerCompareCount}` : "",
      compareResolver.resolverHookMode ? `hook ${compareResolver.resolverHookBound ? "bound" : "unbound"}` : "",
      compareResolver.visibleEffectsEnabled ? "effects enabled" : "effects disabled",
    ].filter(Boolean).join(" · ")
    : "";
  const providerResolverHookText = providerResolverHook.available
    ? providerResolverHook.currentFinding || "-"
    : providerResolverHook.reason || "-";
  const providerResolverHookFocus = providerResolverHook.available
    ? [
      providerResolverHook.status || "",
      `checks ${providerResolverHook.checkCount || 0}`,
      `fail ${providerResolverHook.failureCount || 0}`,
      providerResolverHook.exactObservedPairMatches ? "exact pair match" : "",
      providerResolverHook.sameLabelWrongRefMatches ? "same-label wrong-ref matched" : "same-label wrong-ref no",
      providerResolverHook.wrongLabelSameRefMatches ? "wrong-label same-ref matched" : "wrong-label same-ref no",
      providerResolverHook.visibleEffectsEnabled ? "effects enabled" : "effects disabled",
    ].filter(Boolean).join(" · ")
    : "";
  const provider35c4TapeText = provider35c4Tape.available
    ? provider35c4Tape.currentFinding || "-"
    : provider35c4Tape.reason || "-";
  const provider35c4TapeFocus = provider35c4Tape.available
    ? [
      provider35c4Tape.status || "",
      `events ${provider35c4Tape.providerEventCount || 0}`,
      `prod ${provider35c4Tape.producerEventCount || 0}`,
      `read ${provider35c4Tape.cursorReadEventCount || 0}`,
      `cmp ${provider35c4Tape.labelCompareEventCount || 0}`,
      `feed ${provider35c4Tape.hookFeedObservedMatchCount || 0}`,
      `fail ${provider35c4Tape.failureCount || 0}`,
      provider35c4Tape.visibleEffectsEnabled ? "effects enabled" : "effects disabled",
    ].filter(Boolean).join(" · ")
    : "";
  const provider35c4FeedText = provider35c4Feed.available
    ? provider35c4Feed.currentFinding || "-"
    : provider35c4Feed.reason || "-";
  const provider35c4FeedFocus = provider35c4Feed.available
    ? [
      provider35c4Feed.status || "",
      `obs ${provider35c4Feed.observedMatchCount || 0}`,
      `replay ${provider35c4Feed.resolverReplayCount || 0}`,
      `match ${provider35c4Feed.resolverMatchedCount || 0}`,
      `promote ${provider35c4Feed.promotionEligibleCount || 0}`,
      `entry ${provider35c4Feed.entrySafetyPromotableCount || 0}`,
      `fail ${provider35c4Feed.failureCount || 0}`,
      provider35c4Feed.visibleEffectsEnabled ? "effects enabled" : "effects disabled",
    ].filter(Boolean).join(" · ")
    : "";
  const provider35c4CaptureText = provider35c4Capture.available
    ? provider35c4Capture.currentFinding || "-"
    : provider35c4Capture.reason || "-";
  const provider35c4CaptureFocus = provider35c4Capture.available
    ? [
      provider35c4Capture.status || "",
      `points ${provider35c4Capture.readyCapturePointCount || 0}/${provider35c4Capture.capturePointCount || 0}`,
      `feedpts ${provider35c4Capture.feedEligibleCapturePointCount || 0}`,
      `obs ${provider35c4Capture.observedMatchCount || 0}`,
      `promote ${provider35c4Capture.promotionEligibleCount || 0}`,
      `fail ${provider35c4Capture.failureCount || 0}`,
      provider35c4Capture.visibleEffectsEnabled ? "effects enabled" : "effects disabled",
    ].filter(Boolean).join(" · ")
    : "";
  const provider35c4SourceText = provider35c4Source.available
    ? provider35c4Source.currentFinding || "-"
    : provider35c4Source.reason || "-";
  const provider35c4SourceFocus = provider35c4Source.available
    ? [
      provider35c4Source.status || "",
      `events ${provider35c4Source.captureEventCount || 0}`,
      `prod ${provider35c4Source.producerEventCount || 0}`,
      `read ${provider35c4Source.cursorReadEventCount || 0}`,
      `cmp ${provider35c4Source.labelCompareEventCount || 0}`,
      `linked ${provider35c4Source.linkedCompareCount || 0}/${provider35c4Source.labelCompareEventCount || 0}`,
      `feed ${provider35c4Source.observedFeedEventCount || 0}`,
      `points ${provider35c4Source.observedCapturePointCount || 0}/${provider35c4Source.planCapturePointCount || 0}`,
      `fail ${provider35c4Source.failureCount || 0}`,
      provider35c4Source.visibleEffectsEnabled ? "effects enabled" : "effects disabled",
    ].filter(Boolean).join(" · ")
    : "";
  const provider35c4EmuText = provider35c4Emu.available
    ? provider35c4Emu.currentFinding || "-"
    : provider35c4Emu.reason || "-";
  const provider35c4EmuFocus = provider35c4Emu.available
    ? [
      provider35c4Emu.status || "",
      `events ${provider35c4Emu.captureEventCount || 0}`,
      `adapter ${provider35c4Emu.adapterProviderOwnedEventCount || 0}/${provider35c4Emu.adapterEventCount || 0}`,
      `handoff ${provider35c4Emu.adapterConversionHandoffCount || 0}`,
      `linked ${provider35c4Emu.linkedCompareCount || 0}/${provider35c4Emu.labelCompareEventCount || 0}`,
      `feed ${provider35c4Emu.observedFeedEventCount || 0}`,
      provider35c4Emu.adapterParity ? "parity" : "no parity",
      `fail ${provider35c4Emu.failureCount || 0}`,
      provider35c4Emu.visibleEffectsEnabled ? "effects enabled" : "effects disabled",
    ].filter(Boolean).join(" · ")
    : "";
  const provider35c4SvcObjText = provider35c4SvcObj.available
    ? provider35c4SvcObj.currentFinding || "-"
    : provider35c4SvcObj.reason || "-";
  const provider35c4SvcObjFocus = provider35c4SvcObj.available
    ? [
      provider35c4SvcObj.status || "",
      `replay ${provider35c4SvcObj.replayRowCount || 0}`,
      `prod ${provider35c4SvcObj.producerOperationCount || 0}`,
      `read ${provider35c4SvcObj.cursorReadOperationCount || 0}`,
      `cmp ${provider35c4SvcObj.compareOperationCount || 0}`,
      `refs ${provider35c4SvcObj.knownRefCount || 0}`,
      `feed ${provider35c4SvcObj.observedFeedCount || 0}`,
      `ret0 ${provider35c4SvcObj.observedReturn0CompareCount || 0}`,
      `handoff ${provider35c4SvcObj.adapterConversionHandoffCount || 0}`,
      `fail ${provider35c4SvcObj.failureCount || 0}`,
      provider35c4SvcObj.visibleEffectsEnabled ? "effects enabled" : "effects disabled",
    ].filter(Boolean).join(" · ")
    : "";
  const provider35c4SvcResolverText = provider35c4SvcResolver.available
    ? provider35c4SvcResolver.currentFinding || "-"
    : provider35c4SvcResolver.reason || "-";
  const provider35c4SvcResolverFocus = provider35c4SvcResolver.available
    ? [
      provider35c4SvcResolver.status || "",
      `checks ${provider35c4SvcResolver.passedCheckCount || 0}/${provider35c4SvcResolver.checkCount || 0}`,
      provider35c4SvcResolver.exactObservedPairMatches ? "exact ret0" : "exact no",
      provider35c4SvcResolver.sameLabelWrongRefMatches ? "same-label risk" : "same-label reject",
      provider35c4SvcResolver.wrongLabelSameRefMatches ? "same-ref risk" : "same-ref reject",
      `prodfeed ${provider35c4SvcResolver.productionObservedFeedCount || 0}`,
      `fail ${provider35c4SvcResolver.failureCount || 0}`,
      provider35c4SvcResolver.visibleEffectsEnabled ? "effects enabled" : "effects disabled",
    ].filter(Boolean).join(" · ")
    : "";
  const provider35c4LiveCallText = provider35c4LiveCall.available
    ? provider35c4LiveCall.currentFinding || "-"
    : provider35c4LiveCall.reason || "-";
  const provider35c4LiveCallFocus = provider35c4LiveCall.available
    ? [
      provider35c4LiveCall.status || "",
      `calls ${provider35c4LiveCall.callRequestCount || 0}`,
      `prod ${provider35c4LiveCall.producerOperationCount || 0}`,
      `read ${provider35c4LiveCall.cursorReadOperationCount || 0}`,
      `cmp ${provider35c4LiveCall.compareOperationCount || 0}`,
      `refs ${provider35c4LiveCall.knownRefCount || 0}`,
      provider35c4LiveCall.serviceObjectParity ? "parity" : "no parity",
      `ret0 ${provider35c4LiveCall.return0CompareCount || 0}`,
      `fail ${provider35c4LiveCall.failureCount || 0}`,
      provider35c4LiveCall.visibleEffectsEnabled ? "effects enabled" : "effects disabled",
    ].filter(Boolean).join(" · ")
    : "";
  const provider35c4StreamExecText = provider35c4StreamExec.available
    ? provider35c4StreamExec.currentFinding || "-"
    : provider35c4StreamExec.reason || "-";
  const provider35c4StreamExecFocus = provider35c4StreamExec.available
    ? [
      provider35c4StreamExec.status || "",
      `calls ${provider35c4StreamExec.parsedCallCount || 0}`,
      `prod ${provider35c4StreamExec.producerOperationCount || 0}`,
      `read ${provider35c4StreamExec.cursorReadOperationCount || 0}`,
      `cmp ${provider35c4StreamExec.compareOperationCount || 0}`,
      `refs ${provider35c4StreamExec.knownRefCount || 0}`,
      provider35c4StreamExec.rowParity ? "row parity" : "row diff",
      provider35c4StreamExec.operationParity ? "op parity" : "op diff",
      `ret0 ${provider35c4StreamExec.return0CompareCount || 0}`,
      `fail ${provider35c4StreamExec.failureCount || 0}`,
      provider35c4StreamExec.visibleEffectsEnabled ? "effects enabled" : "effects disabled",
    ].filter(Boolean).join(" · ")
    : "";
  const provider35c4TableWalkText = provider35c4TableWalk.available
    ? provider35c4TableWalk.currentFinding || "-"
    : provider35c4TableWalk.reason || "-";
  const provider35c4TableWalkFocus = provider35c4TableWalk.available
    ? [
      provider35c4TableWalk.status || "",
      `lanes ${provider35c4TableWalk.expandedLaneCount || 0}/${provider35c4TableWalk.laneCount || 0}`,
      `guard ${provider35c4TableWalk.guardedLaneCount || 0}`,
      `refs ${provider35c4TableWalk.tableEntryRefCount || 0}`,
      `read ${provider35c4TableWalk.cursorReadOperationCount || 0}`,
      `cmp ${provider35c4TableWalk.compareOperationCount || 0}`,
      `ret0 ${provider35c4TableWalk.return0CompareCount || 0}`,
      `fail ${provider35c4TableWalk.failureCount || 0}`,
      provider35c4TableWalk.visibleEffectsEnabled ? "effects enabled" : "effects disabled",
    ].filter(Boolean).join(" · ")
    : "";
  const provider35c4CountModeText = provider35c4CountMode.available
    ? provider35c4CountMode.currentFinding || "-"
    : provider35c4CountMode.reason || "-";
  const provider35c4CountModeFocus = provider35c4CountMode.available
    ? [
      provider35c4CountMode.status || "",
      `selected ${provider35c4CountMode.selectedScriptCount || 0}`,
      `changed ${provider35c4CountMode.changedSelectionCount || 0}`,
      `unresolved ${provider35c4CountMode.unresolvedScriptCount || 0}`,
      `topguard ${provider35c4CountMode.topGuardedCandidateCount || 0}`,
      `fail ${provider35c4CountMode.failureCount || 0}`,
      provider35c4CountMode.visibleEffectsEnabled ? "effects enabled" : "effects disabled",
    ].filter(Boolean).join(" · ")
    : "";
  const provider35c4S02SourceText = provider35c4S02Source.available
    ? provider35c4S02Source.currentFinding || "-"
    : provider35c4S02Source.reason || "-";
  const provider35c4S02SourceSelected = provider35c4S02Source.selected
    ? `${provider35c4S02Source.selected.start || "-"} ${provider35c4S02Source.selected.modeKey || "-"}`
    : "";
  const provider35c4S02SourceFocus = provider35c4S02Source.available
    ? [
      provider35c4S02Source.status || "",
      provider35c4S02SourceSelected ? `selected ${provider35c4S02SourceSelected}` : "",
      `tail ${provider35c4S02Source.tailEndCandidateCount || 0}`,
      `lanes ${provider35c4S02Source.laneCount || 0}`,
      `guard ${provider35c4S02Source.guardedLaneCount || 0}`,
      `refs ${provider35c4S02Source.producerOperationCount || 0}`,
      `read ${provider35c4S02Source.cursorReadOperationCount || 0}`,
      `cmp ${provider35c4S02Source.compareOperationCount || 0}`,
      `ret0 ${provider35c4S02Source.return0CompareCount || 0}`,
      `fail ${provider35c4S02Source.failureCount || 0}`,
      provider35c4S02Source.visibleEffectsEnabled ? "effects enabled" : "effects disabled",
    ].filter(Boolean).join(" · ")
    : "";
  const provider35c4SelectedTableText = provider35c4SelectedTable.available
    ? provider35c4SelectedTable.currentFinding || "-"
    : provider35c4SelectedTable.reason || "-";
  const provider35c4SelectedTableFocus = provider35c4SelectedTable.available
    ? [
      provider35c4SelectedTable.status || "",
      `lanes ${provider35c4SelectedTable.expandedLaneCount || 0}/${provider35c4SelectedTable.laneCount || 0}`,
      `guard ${provider35c4SelectedTable.guardedLaneCount || 0}`,
      `blocked ${provider35c4SelectedTable.blockedScriptCount || 0}`,
      `refs ${provider35c4SelectedTable.producerOperationCount || 0}`,
      `read ${provider35c4SelectedTable.cursorReadOperationCount || 0}`,
      `cmp ${provider35c4SelectedTable.compareOperationCount || 0}`,
      `ret0 ${provider35c4SelectedTable.return0CompareCount || 0}`,
      `fail ${provider35c4SelectedTable.failureCount || 0}`,
      provider35c4SelectedTable.visibleEffectsEnabled ? "effects enabled" : "effects disabled",
    ].filter(Boolean).join(" · ")
    : "";
  const provider35c4SelectedFeedText = provider35c4SelectedFeed.available
    ? provider35c4SelectedFeed.currentFinding || "-"
    : provider35c4SelectedFeed.reason || "-";
  const provider35c4SelectedFeedFocus = provider35c4SelectedFeed.available
    ? [
      provider35c4SelectedFeed.status || "",
      `cmp ${provider35c4SelectedFeed.selectedCompareCount || 0}`,
      `observed ${provider35c4SelectedFeed.observedMatchCount || 0}`,
      `match ${provider35c4SelectedFeed.resolverMatchedCount || 0}`,
      `promote ${provider35c4SelectedFeed.promotionEligibleCount || 0}`,
      `entry ${provider35c4SelectedFeed.entrySafetyPromotableCount || 0}`,
      `fail ${provider35c4SelectedFeed.failureCount || 0}`,
      provider35c4SelectedFeed.visibleEffectsEnabled ? "effects enabled" : "effects disabled",
    ].filter(Boolean).join(" · ")
    : "";
  const provider35c4PromotionFrontierText = provider35c4PromotionFrontier.available
    ? provider35c4PromotionFrontier.currentFinding || "-"
    : provider35c4PromotionFrontier.reason || "-";
  const provider35c4PromotionFrontierFocus = provider35c4PromotionFrontier.available
    ? [
      provider35c4PromotionFrontier.status || "",
      `cmp ${provider35c4PromotionFrontier.selectedCompareCount || 0}`,
      `valid ${provider35c4PromotionFrontier.validCursorCompareCount || 0}`,
      `sched ${provider35c4PromotionFrontier.schedulerCandidateIfObservedCount || 0}`,
      `direct ${provider35c4PromotionFrontier.promotionEligibleIfObservedCount || 0}`,
      `ret0 ${provider35c4PromotionFrontier.sourceReturn0CompareCount || 0}`,
      `fail ${provider35c4PromotionFrontier.failureCount || 0}`,
      provider35c4PromotionFrontier.visibleEffectsEnabled ? "effects enabled" : "effects disabled",
    ].filter(Boolean).join(" · ")
    : "";
  const provider35c4FrontierModeScanText = provider35c4FrontierModeScan.available
    ? provider35c4FrontierModeScan.currentFinding || "-"
    : provider35c4FrontierModeScan.reason || "-";
  const provider35c4FrontierModeScanFocus = provider35c4FrontierModeScan.available
    ? [
      provider35c4FrontierModeScan.status || "",
      `scan ${provider35c4FrontierModeScan.scannedCandidateCount || 0}`,
      `pool ${provider35c4FrontierModeScan.poolCleanCandidateCount || 0}`,
      `sched ${provider35c4FrontierModeScan.schedulerCandidateModeCount || 0}`,
      `direct ${provider35c4FrontierModeScan.directPromotionCandidateModeCount || 0}`,
      `fail ${provider35c4FrontierModeScan.failureCount || 0}`,
      provider35c4FrontierModeScan.visibleEffectsEnabled ? "effects enabled" : "effects disabled",
    ].filter(Boolean).join(" · ")
    : "";
  const provider35c4Return0PriorityText = provider35c4Return0Priority.available
    ? provider35c4Return0Priority.currentFinding || "-"
    : provider35c4Return0Priority.reason || "-";
  const provider35c4Return0PriorityFocus = provider35c4Return0Priority.available
    ? [
      provider35c4Return0Priority.status || "",
      `p1 ${provider35c4Return0Priority.selectedPriorityRowCount || 0}`,
      `mode ${provider35c4Return0Priority.modePriorityRowCount || 0}`,
      `known ${provider35c4Return0Priority.knownProviderRefRowCount || 0}`,
      `direct ${provider35c4Return0Priority.directCasePriorityRowCount || 0}`,
      `fail ${provider35c4Return0Priority.failureCount || 0}`,
      provider35c4Return0Priority.visibleEffectsEnabled ? "effects enabled" : "effects disabled",
    ].filter(Boolean).join(" · ")
    : "";
  const provider35c4Return0InjectionText = provider35c4Return0Injection.available
    ? provider35c4Return0Injection.currentFinding || "-"
    : provider35c4Return0Injection.reason || "-";
  const provider35c4Return0InjectionFocus = provider35c4Return0Injection.available
    ? [
      provider35c4Return0Injection.status || "",
      `synthetic ${provider35c4Return0Injection.syntheticObservedMatchCount || 0}`,
      `match ${provider35c4Return0Injection.resolverMatchedCount || 0}`,
      `direct ${provider35c4Return0Injection.directCaseRowCount || 0}`,
      `exec ${provider35c4Return0Injection.executableRowCount || 0}`,
      `fail ${provider35c4Return0Injection.failureCount || 0}`,
      provider35c4Return0Injection.visibleEffectsEnabled ? "effects enabled" : "effects disabled",
    ].filter(Boolean).join(" · ")
    : "";
  const provider35c4Return0CaptureText = provider35c4Return0Capture.available
    ? provider35c4Return0Capture.currentFinding || "-"
    : provider35c4Return0Capture.reason || "-";
  const provider35c4Return0CaptureFocus = provider35c4Return0Capture.available
    ? [
      provider35c4Return0Capture.status || "",
      `import ${provider35c4Return0Capture.importedObservationCount || 0}`,
      `feed ${provider35c4Return0Capture.observedFeedRowCount || 0}`,
      `p1 ${provider35c4Return0Capture.p1MatchedCount || 0}/${provider35c4Return0Capture.p1PriorityRowCount || 0}`,
      `direct ${provider35c4Return0Capture.directCaseObservedCount || 0}`,
      `exec ${provider35c4Return0Capture.executableObservedCount || 0}`,
      `fail ${provider35c4Return0Capture.failureCount || 0}`,
      provider35c4Return0Capture.visibleEffectsEnabled ? "effects enabled" : "effects disabled",
    ].filter(Boolean).join(" · ")
    : "";
  const provider35c4CapturedFeedText = provider35c4CapturedFeed.available
    ? provider35c4CapturedFeed.currentFinding || "-"
    : provider35c4CapturedFeed.reason || "-";
  const provider35c4CapturedFeedFocus = provider35c4CapturedFeed.available
    ? [
      provider35c4CapturedFeed.status || "",
      `sel ${provider35c4CapturedFeed.selectedCompareCount || 0}/${provider35c4CapturedFeed.expectedCompareCount || 0}`,
      `feed ${provider35c4CapturedFeed.observedFeedRowCount || 0}`,
      `match ${provider35c4CapturedFeed.resolverMatchedCount || 0}`,
      `direct ${provider35c4CapturedFeed.directMatchedCount || 0}`,
      `exec ${provider35c4CapturedFeed.executableMatchedCount || 0}`,
      `fail ${provider35c4CapturedFeed.failureCount || 0}`,
      provider35c4CapturedFeed.visibleEffectsEnabled ? "effects enabled" : "effects disabled",
    ].filter(Boolean).join(" · ")
    : "";
  const provider35c4ObservationRecorderText = provider35c4ObservationRecorder.available
    ? provider35c4ObservationRecorder.currentFinding || "-"
    : provider35c4ObservationRecorder.reason || "-";
  const provider35c4ObservationRecorderFocus = provider35c4ObservationRecorder.available
    ? [
      provider35c4ObservationRecorder.status || "",
      `sel ${provider35c4ObservationRecorder.selectedObservationCount || 0}/${provider35c4ObservationRecorder.selectedExpectedCompareCount || 0}`,
      `stream ${provider35c4ObservationRecorder.streamObservationCount || 0}/${provider35c4ObservationRecorder.streamExpectedCompareCount || 0}`,
      `events ${provider35c4ObservationRecorder.totalObservationCount || 0}`,
      `feed ${provider35c4ObservationRecorder.observedFeedRowCount || 0}`,
      `nonmatch ${provider35c4ObservationRecorder.nonMatchObservationCount || 0}`,
      `fail ${provider35c4ObservationRecorder.failureCount || 0}`,
      provider35c4ObservationRecorder.visibleEffectsEnabled ? "effects enabled" : "effects disabled",
    ].filter(Boolean).join(" · ")
    : "";
  const provider35c4RuntimeSinkText = provider35c4RuntimeSink.available
    ? provider35c4RuntimeSink.currentFinding || "-"
    : provider35c4RuntimeSink.reason || "-";
  const provider35c4RuntimeSinkFocus = provider35c4RuntimeSink.available
    ? [
      provider35c4RuntimeSink.status || "",
      `sel ${provider35c4RuntimeSink.selectedObservationCount || 0}/${provider35c4RuntimeSink.selectedExpectedCompareCount || 0}`,
      `stream ${provider35c4RuntimeSink.streamObservationCount || 0}/${provider35c4RuntimeSink.streamExpectedCompareCount || 0}`,
      `events ${provider35c4RuntimeSink.totalObservationCount || 0}`,
      `feed ${provider35c4RuntimeSink.observedFeedRowCount || 0}`,
      `nonmatch ${provider35c4RuntimeSink.nonMatchObservationCount || 0}`,
      `fail ${provider35c4RuntimeSink.failureCount || 0}`,
      provider35c4RuntimeSink.visibleEffectsEnabled ? "effects enabled" : "effects disabled",
    ].filter(Boolean).join(" · ")
    : "";
  const cbeRuntimeCoreText = cbeRuntimeCore.available
    ? cbeRuntimeCore.currentFinding || "-"
    : cbeRuntimeCore.reason || "-";
  const cbeRuntimeCoreFocus = cbeRuntimeCore.available
    ? [
      cbeRuntimeCore.status || "",
      `corpus ${cbeRuntimeCore.corpusReadyCount || 0}/${cbeRuntimeCore.corpusFileCount || 0}`,
      `resources ${cbeRuntimeCore.resourceCount || 0}`,
      `sel ${cbeRuntimeCore.selectedObservationCount || 0}/${cbeRuntimeCore.selectedExpectedCompareCount || 0}`,
      `stream ${cbeRuntimeCore.streamObservationCount || 0}/${cbeRuntimeCore.streamExpectedCompareCount || 0}`,
      `events ${cbeRuntimeCore.totalObservationCount || 0}`,
      `feed ${cbeRuntimeCore.observedFeedRowCount || 0}`,
      `nonmatch ${cbeRuntimeCore.nonMatchObservationCount || 0}`,
      `fail ${cbeRuntimeCore.failureCount || 0}`,
      cbeRuntimeCore.visibleEffectsEnabled ? "effects enabled" : "effects disabled",
    ].filter(Boolean).join(" · ")
    : "";
  const cbeRuntimeCoreSceneText = cbeRuntimeCoreScene.available
    ? cbeRuntimeCoreScene.currentFinding || "-"
    : cbeRuntimeCoreScene.reason || "-";
  const cbeRuntimeCoreSceneFocus = cbeRuntimeCoreScene.available
    ? [
      cbeRuntimeCoreScene.status || "",
      `scene games ${cbeRuntimeCoreScene.readySceneGameCount || 0}/${cbeRuntimeCoreScene.sceneGameCount || 0}`,
      `scenes ${cbeRuntimeCoreScene.readySceneResourceCount || 0}/${cbeRuntimeCoreScene.sceneResourceCount || 0}`,
      `canvas ${cbeRuntimeCoreScene.canvasReadyCount || 0}`,
      `frames ${cbeRuntimeCoreScene.finalSceneFrameCount || 0}`,
      `input ${cbeRuntimeCoreScene.inputSceneFrameCount || 0}`,
      `map ${cbeRuntimeCoreScene.mapLinkedSceneCount || 0}`,
      `mapRef ${cbeRuntimeCoreScene.lengthPrefixedMapSceneCount || 0}`,
      `mapTrace ${cbeRuntimeCoreScene.mapTraceSceneCount || 0}`,
      `atlas ${cbeRuntimeCoreScene.mapAtlasSizedSceneCount || 0}`,
      `draw ${cbeRuntimeCoreScene.mapDrawCandidateSceneCount || 0}`,
      `tileGrid ${cbeRuntimeCoreScene.mapTileGridCandidateSceneCount || 0}`,
      `entity ${cbeRuntimeCoreScene.entitySceneCount || 0}`,
      `script ${cbeRuntimeCoreScene.scriptLinkedSceneCount || 0}`,
      `files ${cbeRuntimeCoreScene.coreReadyCount || 0}/${cbeRuntimeCoreScene.fileCount || 0}`,
      `fail ${cbeRuntimeCoreScene.failureCount || 0}`,
      cbeRuntimeCoreScene.visibleEffectsEnabled ? "effects enabled" : "effects disabled",
    ].filter(Boolean).join(" · ")
    : "";
  const copyHelperText = copyHelper.available
    ? copyHelper.currentFinding || "-"
    : copyHelper.reason || "-";
  const copyHelperFocus = copyHelper.available
    ? [
      copyHelper.status || "",
      `calls ${copyHelper.copyCallCount || 0}`,
      `writeback guard ${copyHelper.writebackLocalNullGuard ? "yes" : "no"}`,
      `helper null-safe ${copyHelper.helperNullSafeProven ? "yes" : "no"}`,
    ].filter(Boolean).join(" · ")
    : "";
  const slotAuditText = slotAudit.available
    ? slotAudit.newFalsification || slotAudit.currentBlocker || "-"
    : slotAudit.reason || "-";
  const lifecycleText = lifecycle.available
    ? [lifecycle.currentFinding, lifecycle.falsePositive].filter(Boolean).join(" ")
    : lifecycle.reason || "-";
  const lifecycleServices = lifecycle.available && Array.isArray(lifecycle.services)
    ? lifecycle.services.map((service) => `${service.target}:${service.hitCount}`).join(" · ")
    : "";
  const loaderCallerText = loaderCallers.available
    ? `${loaderCallers.finding || ""} ${loaderCallers.x112c4CallSites?.length ? `sites ${loaderCallers.x112c4CallSites.join(", ")}` : ""}`.trim()
    : loaderCallers.reason || "-";
  const loaderWrapperText = loaderCallers.available && Array.isArray(loaderCallers.wrapperRefs)
    ? loaderCallers.wrapperRefs.map((ref) => `${ref.target}:${ref.count}`).join(" · ")
    : "";
  const facadeText = wrapperFacade.available
    ? wrapperFacade.facadeMap || wrapperFacade.finding || "-"
    : wrapperFacade.reason || "-";
  const facadeFocus = wrapperFacade.available && Array.isArray(wrapperFacade.focusWrappers)
    ? wrapperFacade.focusWrappers.map((wrapper) => `${wrapper.start} ${wrapper.group}/${wrapper.methodSlot} refs=${wrapper.directBranchCount}`).join(" · ")
    : "";
  const facadeSlotText = facadeSlots.available
    ? facadeSlots.finding || "-"
    : facadeSlots.reason || "-";
  const facadeSlotFocus = facadeSlots.available && Array.isArray(facadeSlots.facadeResolutions)
    ? facadeSlots.facadeResolutions.map((item) => `${item.wrapper}@${item.offset} ${item.status}${item.bestTarget ? ` -> ${item.bestTarget}` : ""}`).join(" · ")
    : "";
  const managerRootText = managerRoot.available
    ? managerRoot.finding || "-"
    : managerRoot.reason || "-";
  const managerRootAssign = managerRoot.available && Array.isArray(managerRoot.assignments)
    ? managerRoot.assignments.filter((item) => item.targetGlobal === "0x35E0").map((item) => `${item.site} <= ${item.source}`).join(" · ")
    : "";
  const facadeEquivText = facadeEquivalence.available
    ? facadeEquivalence.finding || "-"
    : facadeEquivalence.reason || "-";
  const facadeEquivFocus = facadeEquivalence.available && Array.isArray(facadeEquivalence.equivalences)
    ? facadeEquivalence.equivalences.slice(0, 2).map((item) => `${item.wrapper} -> ${item.directService}`).join(" · ")
    : "";
  const facadeNormText = facadeNormalized.available
    ? facadeNormalized.finding || "-"
    : facadeNormalized.reason || "-";
  const facadeNormFocus = facadeNormalized.available && Array.isArray(facadeNormalized.scripts)
    ? facadeNormalized.scripts.map((script) => `${script.name}:${script.loose50Aligned ? "aligned" : (script.loose50Strict ? "shallow" : "blocked")}`).join(" · ")
    : "";
  return `
    <div class="subhead">Raw CBE VM Gate</div>
    <p class="note-text">${escapeHtml(xse.executionStatus || "raw CBE runtime probe pending")}</p>
    <dl class="kv compact-kv">
      <dt>Source</dt><dd>${escapeHtml(`${probe.source.mode || "raw-cbe"} · ${probe.source.resourceCount || 0} resources`)}</dd>
      <dt>Scene</dt><dd>${escapeHtml(`${probe.scene?.name || "-"} · ${probe.scene?.summary?.specific?.sce?.canvas ? `${probe.scene.summary.specific.sce.canvas.width} x ${probe.scene.summary.specific.sce.canvas.height}` : "-"}`)}</dd>
      <dt>Reader</dt><dd>${escapeHtml(readerText)}</dd>
      <dt>VM Gate</dt><dd>${escapeHtml(gateText)}</dd>
      <dt>Stream Prep</dt><dd>${escapeHtml(prepText)}</dd>
      <dt>Stream Service</dt><dd>${escapeHtml(streamServiceFocus ? `${streamServiceText} · ${streamServiceFocus}` : streamServiceText)}</dd>
      <dt>Provider Service</dt><dd>${escapeHtml(providerServiceFocus ? `${providerServiceText} · ${providerServiceFocus}` : providerServiceText)}</dd>
      <dt>Provider Replay</dt><dd>${escapeHtml(providerReplayFocus ? `${providerReplayText} · ${providerReplayFocus}` : providerReplayText)}</dd>
      <dt>Cursor +50</dt><dd>${escapeHtml(cursor50Focus ? `${cursor50Text} · ${cursor50Focus}` : cursor50Text)}</dd>
      <dt>Provider ABI</dt><dd>${escapeHtml(providerAbiFocus ? `${providerAbiText} · ${providerAbiFocus}` : providerAbiText)}</dd>
      <dt>ABI Shim</dt><dd>${escapeHtml(providerAbiShimFocus ? `${providerAbiShimText} · ${providerAbiShimFocus}` : providerAbiShimText)}</dd>
      <dt>Switch Replay</dt><dd>${escapeHtml(switchReplayFocus ? `${switchReplayText} · ${switchReplayFocus}` : switchReplayText)}</dd>
      <dt>Dispatch</dt><dd>${escapeHtml(dispatchFocus ? `${dispatchText} · ${dispatchFocus}` : dispatchText)}</dd>
      <dt>Case Map</dt><dd>${escapeHtml(dispatchCaseFocus ? `${dispatchCaseText} · ${dispatchCaseFocus}` : dispatchCaseText)}</dd>
      <dt>Trace VM</dt><dd>${escapeHtml(traceVmFocus ? `${traceVmText} · ${traceVmFocus}` : traceVmText)}</dd>
      <dt>Writeback</dt><dd>${escapeHtml(writebackFocus ? `${writebackText} · ${writebackFocus}` : writebackText)}</dd>
      <dt>Cursor Init</dt><dd>${escapeHtml(cursorInitFocus ? `${cursorInitText} · ${cursorInitFocus}` : cursorInitText)}</dd>
      <dt>Slot Lifecycle</dt><dd>${escapeHtml(slotLifecycleFocus ? `${slotLifecycleText} · ${slotLifecycleFocus}` : slotLifecycleText)}</dd>
      <dt>Operand Binding</dt><dd>${escapeHtml(operandBindingFocus ? `${operandBindingText} · ${operandBindingFocus}` : operandBindingText)}</dd>
      <dt>Entrypoint</dt><dd>${escapeHtml(entrypointFocus ? `${entrypointText} · ${entrypointFocus}` : entrypointText)}</dd>
      <dt>Entry Labels</dt><dd>${escapeHtml(entryLabelFocus ? `${entryLabelText} · ${entryLabelFocus}` : entryLabelText)}</dd>
      <dt>Entry Callers</dt><dd>${escapeHtml(entryCallerFocus ? `${entryCallerText} · ${entryCallerFocus}` : entryCallerText)}</dd>
      <dt>Entry Compare</dt><dd>${escapeHtml(entryCompareFocus ? `${entryCompareText} · ${entryCompareFocus}` : entryCompareText)}</dd>
      <dt>Label Ptr</dt><dd>${escapeHtml(labelPointerFocus ? `${labelPointerText} · ${labelPointerFocus}` : labelPointerText)}</dd>
      <dt>Ref Encoding</dt><dd>${escapeHtml(refEncodingFocus ? `${refEncodingText} · ${refEncodingFocus}` : refEncodingText)}</dd>
      <dt>Compare Norm</dt><dd>${escapeHtml(compareNormalizationFocus ? `${compareNormalizationText} · ${compareNormalizationFocus}` : compareNormalizationText)}</dd>
      <dt>Tail Boundary</dt><dd>${escapeHtml(tailBoundaryFocus ? `${tailBoundaryText} · ${tailBoundaryFocus}` : tailBoundaryText)}</dd>
      <dt>Compare Svc</dt><dd>${escapeHtml(compareServiceFocus ? `${compareServiceText} · ${compareServiceFocus}` : compareServiceText)}</dd>
      <dt>Compare Shim</dt><dd>${escapeHtml(compareShimFocus ? `${compareShimText} · ${compareShimFocus}` : compareShimText)}</dd>
      <dt>Activation</dt><dd>${escapeHtml(activationFocus ? `${activationText} · ${activationFocus}` : activationText)}</dd>
      <dt>Activated Dispatch</dt><dd>${escapeHtml(activatedDispatchFocus ? `${activatedDispatchText} · ${activatedDispatchFocus}` : activatedDispatchText)}</dd>
      <dt>Activated Operand</dt><dd>${escapeHtml(activatedOperandFocus ? `${activatedOperandText} · ${activatedOperandFocus}` : activatedOperandText)}</dd>
      <dt>High Opcode</dt><dd>${escapeHtml(highOpcodeFocus ? `${highOpcodeText} · ${highOpcodeFocus}` : highOpcodeText)}</dd>
      <dt>Entry Safety</dt><dd>${escapeHtml(entrySafetyFocus ? `${entrySafetyText} · ${entrySafetyFocus}` : entrySafetyText)}</dd>
      <dt>Ref Width Safety</dt><dd>${escapeHtml(refWidthSafetyFocus ? `${refWidthSafetyText} · ${refWidthSafetyFocus}` : refWidthSafetyText)}</dd>
      <dt>Compare ABI</dt><dd>${escapeHtml(compareAbiFocus ? `${compareAbiText} · ${compareAbiFocus}` : compareAbiText)}</dd>
      <dt>Ref Namespace</dt><dd>${escapeHtml(refNamespaceFocus ? `${refNamespaceText} · ${refNamespaceFocus}` : refNamespaceText)}</dd>
      <dt>Ref64 Loader</dt><dd>${escapeHtml(ref64LoaderFocus ? `${ref64LoaderText} · ${ref64LoaderFocus}` : ref64LoaderText)}</dd>
      <dt>Ref Context</dt><dd>${escapeHtml(providerRefContextFocus ? `${providerRefContextText} · ${providerRefContextFocus}` : providerRefContextText)}</dd>
      <dt>Compare Resolver</dt><dd>${escapeHtml(compareResolverFocus ? `${compareResolverText} · ${compareResolverFocus}` : compareResolverText)}</dd>
      <dt>Resolver Hook</dt><dd>${escapeHtml(providerResolverHookFocus ? `${providerResolverHookText} · ${providerResolverHookFocus}` : providerResolverHookText)}</dd>
      <dt>Provider Tape</dt><dd>${escapeHtml(provider35c4TapeFocus ? `${provider35c4TapeText} · ${provider35c4TapeFocus}` : provider35c4TapeText)}</dd>
      <dt>Provider Feed</dt><dd>${escapeHtml(provider35c4FeedFocus ? `${provider35c4FeedText} · ${provider35c4FeedFocus}` : provider35c4FeedText)}</dd>
      <dt>Provider Capture</dt><dd>${escapeHtml(provider35c4CaptureFocus ? `${provider35c4CaptureText} · ${provider35c4CaptureFocus}` : provider35c4CaptureText)}</dd>
      <dt>Provider Source</dt><dd>${escapeHtml(provider35c4SourceFocus ? `${provider35c4SourceText} · ${provider35c4SourceFocus}` : provider35c4SourceText)}</dd>
      <dt>Provider Emu</dt><dd>${escapeHtml(provider35c4EmuFocus ? `${provider35c4EmuText} · ${provider35c4EmuFocus}` : provider35c4EmuText)}</dd>
      <dt>Provider Object</dt><dd>${escapeHtml(provider35c4SvcObjFocus ? `${provider35c4SvcObjText} · ${provider35c4SvcObjFocus}` : provider35c4SvcObjText)}</dd>
      <dt>Provider Resolver</dt><dd>${escapeHtml(provider35c4SvcResolverFocus ? `${provider35c4SvcResolverText} · ${provider35c4SvcResolverFocus}` : provider35c4SvcResolverText)}</dd>
      <dt>Provider Calls</dt><dd>${escapeHtml(provider35c4LiveCallFocus ? `${provider35c4LiveCallText} · ${provider35c4LiveCallFocus}` : provider35c4LiveCallText)}</dd>
      <dt>Provider Stream</dt><dd>${escapeHtml(provider35c4StreamExecFocus ? `${provider35c4StreamExecText} · ${provider35c4StreamExecFocus}` : provider35c4StreamExecText)}</dd>
      <dt>Provider Table</dt><dd>${escapeHtml(provider35c4TableWalkFocus ? `${provider35c4TableWalkText} · ${provider35c4TableWalkFocus}` : provider35c4TableWalkText)}</dd>
      <dt>Provider Count</dt><dd>${escapeHtml(provider35c4CountModeFocus ? `${provider35c4CountModeText} · ${provider35c4CountModeFocus}` : provider35c4CountModeText)}</dd>
      <dt>Provider s_02</dt><dd>${escapeHtml(provider35c4S02SourceFocus ? `${provider35c4S02SourceText} · ${provider35c4S02SourceFocus}` : provider35c4S02SourceText)}</dd>
      <dt>Provider Selected</dt><dd>${escapeHtml(provider35c4SelectedTableFocus ? `${provider35c4SelectedTableText} · ${provider35c4SelectedTableFocus}` : provider35c4SelectedTableText)}</dd>
      <dt>Provider SelFeed</dt><dd>${escapeHtml(provider35c4SelectedFeedFocus ? `${provider35c4SelectedFeedText} · ${provider35c4SelectedFeedFocus}` : provider35c4SelectedFeedText)}</dd>
      <dt>Provider Frontier</dt><dd>${escapeHtml(provider35c4PromotionFrontierFocus ? `${provider35c4PromotionFrontierText} · ${provider35c4PromotionFrontierFocus}` : provider35c4PromotionFrontierText)}</dd>
      <dt>Provider ModeScan</dt><dd>${escapeHtml(provider35c4FrontierModeScanFocus ? `${provider35c4FrontierModeScanText} · ${provider35c4FrontierModeScanFocus}` : provider35c4FrontierModeScanText)}</dd>
      <dt>Provider Return0</dt><dd>${escapeHtml(provider35c4Return0PriorityFocus ? `${provider35c4Return0PriorityText} · ${provider35c4Return0PriorityFocus}` : provider35c4Return0PriorityText)}</dd>
      <dt>Return0 Inject</dt><dd>${escapeHtml(provider35c4Return0InjectionFocus ? `${provider35c4Return0InjectionText} · ${provider35c4Return0InjectionFocus}` : provider35c4Return0InjectionText)}</dd>
      <dt>Return0 Capture</dt><dd>${escapeHtml(provider35c4Return0CaptureFocus ? `${provider35c4Return0CaptureText} · ${provider35c4Return0CaptureFocus}` : provider35c4Return0CaptureText)}</dd>
      <dt>Captured Feed</dt><dd>${escapeHtml(provider35c4CapturedFeedFocus ? `${provider35c4CapturedFeedText} · ${provider35c4CapturedFeedFocus}` : provider35c4CapturedFeedText)}</dd>
      <dt>Provider Recorder</dt><dd>${escapeHtml(provider35c4ObservationRecorderFocus ? `${provider35c4ObservationRecorderText} · ${provider35c4ObservationRecorderFocus}` : provider35c4ObservationRecorderText)}</dd>
      <dt>Runtime Sink</dt><dd>${escapeHtml(provider35c4RuntimeSinkFocus ? `${provider35c4RuntimeSinkText} · ${provider35c4RuntimeSinkFocus}` : provider35c4RuntimeSinkText)}</dd>
      <dt>Runtime Core</dt><dd>${escapeHtml(cbeRuntimeCoreFocus ? `${cbeRuntimeCoreText} · ${cbeRuntimeCoreFocus}` : cbeRuntimeCoreText)}</dd>
      <dt>Core Scene Corpus</dt><dd>${escapeHtml(cbeRuntimeCoreSceneFocus ? `${cbeRuntimeCoreSceneText} · ${cbeRuntimeCoreSceneFocus}` : cbeRuntimeCoreSceneText)}</dd>
      <dt>Copy Helper</dt><dd>${escapeHtml(copyHelperFocus ? `${copyHelperText} · ${copyHelperFocus}` : copyHelperText)}</dd>
      <dt>Slot Audit</dt><dd>${escapeHtml(slotAuditText)}</dd>
      <dt>Service Life</dt><dd>${escapeHtml(lifecycleServices ? `${lifecycleText} · ${lifecycleServices}` : lifecycleText)}</dd>
      <dt>Loader Callers</dt><dd>${escapeHtml(loaderWrapperText ? `${loaderCallerText} · wrappers ${loaderWrapperText}` : loaderCallerText)}</dd>
      <dt>Wrapper Facade</dt><dd>${escapeHtml(facadeFocus ? `${facadeText} · ${facadeFocus}` : facadeText)}</dd>
      <dt>Facade Slots</dt><dd>${escapeHtml(facadeSlotFocus ? `${facadeSlotText} · ${facadeSlotFocus}` : facadeSlotText)}</dd>
      <dt>Manager Root</dt><dd>${escapeHtml(managerRootAssign ? `${managerRootText} · ${managerRootAssign}` : managerRootText)}</dd>
      <dt>Facade Equiv</dt><dd>${escapeHtml(facadeEquivFocus ? `${facadeEquivText} · ${facadeEquivFocus}` : facadeEquivText)}</dd>
      <dt>Facade Norm</dt><dd>${escapeHtml(facadeNormFocus ? `${facadeNormText} · ${facadeNormFocus}` : facadeNormText)}</dd>
      <dt>Next</dt><dd>${escapeHtml(cbeRuntimeCoreScene.nextTarget || cbeRuntimeCore.nextTarget || provider35c4RuntimeSink.nextTarget || provider35c4ObservationRecorder.nextTarget || provider35c4CapturedFeed.nextTarget || provider35c4Return0Capture.nextTarget || provider35c4Return0Injection.nextTarget || provider35c4Return0Priority.nextTarget || provider35c4FrontierModeScan.nextTarget || provider35c4PromotionFrontier.nextTarget || provider35c4SelectedFeed.nextTarget || provider35c4SelectedTable.nextTarget || provider35c4S02Source.nextTarget || provider35c4CountMode.nextTarget || provider35c4TableWalk.nextTarget || provider35c4StreamExec.nextTarget || provider35c4LiveCall.nextTarget || provider35c4SvcResolver.nextTarget || provider35c4SvcObj.nextTarget || provider35c4Emu.nextTarget || provider35c4Source.nextTarget || provider35c4Capture.nextTarget || provider35c4Feed.nextTarget || provider35c4Tape.nextTarget || providerResolverHook.nextTarget || compareResolver.nextTarget || providerRefContext.nextTarget || ref64Loader.nextTarget || refNamespace.nextTarget || compareAbi.nextTarget || refWidthSafety.nextTarget || entrySafety.nextTarget || highOpcode.nextTarget || tailBoundary.nextTarget || compareNormalization.nextTarget || refEncoding.nextTarget || labelPointer.nextTarget || activatedOperand.nextTarget || activatedDispatch.nextTarget || activation.nextTarget || compareShim.nextTarget || compareService.nextTarget || entryCompare.nextTarget || entryCaller.nextTarget || entryLabel.nextTarget || entrypoint.nextTarget || operandBinding.nextTarget || slotLifecycle.nextTarget || copyHelper.nextTarget || cursorInit.nextTarget || writeback.nextTarget || traceVm.nextTarget || dispatchCases.nextTarget || runtimeDispatch.nextTarget || switchReplay.nextTarget || providerAbiShim.nextTarget || providerAbi.nextTarget || cursor50Variants.nextTarget || providerReplay.nextTarget || providerService.nextTarget || streamService.nextTarget || facadeNormalized.nextTarget || facadeEquivalence.nextTarget || managerRoot.nextTarget || facadeSlots.nextTarget || wrapperFacade.nextTarget || loaderCallers.nextTarget || lifecycle.nextTarget || slotAudit.nextTarget || prep.nextTarget || gate.nextTarget || "reconstruct stream preparation and exact compact-reader semantics")}</dd>
    </dl>
    ${scriptRows ? `<ul class="ref-list">${scriptRows}</ul>` : ""}
  `;
}

function renderRuntimeScene(runtime, trueRuntime = null, coreRuntime = null, coreEmulator = null) {
  const boot = renderRuntimeBoot(runtime);
  if (!runtime?.scene?.canvas) return boot;
  const vmGate = trueRuntime?.xseVm?.vmGate || null;
  const switchReplay = trueRuntime?.xseVm?.xseSwitchReplay || null;
  const runtimeDispatch = trueRuntime?.xseVm?.xseRuntimeDispatch || null;
  const traceVm = trueRuntime?.xseVm?.xseTraceVm || null;
  const vmBlocked = Boolean((switchReplay?.available && switchReplay.status === "switch-replay-ok") || (vmGate?.available && vmGate.alignedCount === 0));
  const vmBlockedText = traceVm?.available
    ? "Raw CBE trace-only VM can walk the real group dispatcher, but visible script effects stay disabled until writeback targets resolve without a null-copy risk; this snapshot remains decoder evidence."
    : runtimeDispatch?.available
    ? "Raw CBE 0x112C4 switch replay now reaches the runtime group dispatcher, but tail-best reader modes disagree with dispatch-plausible modes in some scripts; this snapshot remains decoder evidence."
    : switchReplay?.available
    ? "Raw CBE 0x112C4 object/table switch replay now passes; this snapshot is still decoder evidence because high-opcode handler binding and +0x74/+0x64 tail refs are pending."
    : "Raw CBE script execution is still blocked at the legacy strict XSE VM gate; this snapshot is decoder evidence, not a playable emulator frame.";
  const canvas = runtime.scene.canvas;
  const camera = runtime.camera || { x: 0, y: 0, width: 240, height: 320 };
  const actors = (runtime.entities || []).map((entity) => renderRuntimeActor(entity)).join("");
  const viewportActors = (runtime.entities || []).map((entity) => renderRuntimeActor(entity, true)).join("");
  const map = runtime.scene.map || {};
  const mapHint = map.renderHint || coreRuntime?.scene?.map?.renderHint || null;
  const runtimeMapTiles = renderRuntimeMapTiles(map);
  const runtimeMapPlaneClass = `runtime-map-plane${runtimeMapTiles ? " has-tiles" : ""}`;
  const status = runtime.runtimeStatus || {};
  const mapCandidateOptIn = new URLSearchParams(window.location.search).get("mapCandidate") === "1";
  const mapDecodeText = mapHint ? [
    mapHint.status || "map stream analyzed",
    mapHint.atlas?.size ? `atlas ${mapHint.atlas.name || "-"} ${mapHint.atlas.size.width}x${mapHint.atlas.size.height}` : (mapHint.atlas?.name ? `atlas ${mapHint.atlas.name}` : ""),
    mapHint.bestDrawCandidate ? `draw ${mapHint.bestDrawCandidate.key} score ${mapHint.bestDrawCandidate.score}` : "",
    mapHint.bestRleCandidate ? `rle ${mapHint.bestRleCandidate.key} score ${mapHint.bestRleCandidate.score}` : "",
    mapHint.tileGridCandidate ? `tileGrid candidate ${mapHint.tileGridCandidate.columns}x${mapHint.tileGridCandidate.rows}${mapCandidateOptIn ? "" : " hidden"}` : "",
  ].filter(Boolean).join(" · ") : "";
  const entityRows = (runtime.entities || []).map((entity) => {
    const img = entity.actor?.primaryImage ? ` · ${entity.actor.primaryImage}` : "";
    const f222 = entity.actor?.f222 ? ` · ${entity.actor.f222.tableMethod}${entity.actor.f222.recordStride ? `/${entity.actor.f222.recordStride}` : ""}` : "";
    return `<li class="jumpable" data-jump-rel="${escapeHtml(entity.source?.rel || "")}"><span>${escapeHtml(`${entity.x},${entity.y}`)}</span>${escapeHtml(`${entity.name} -> ${entity.matched}${img}${f222}`)}</li>`;
  }).join("");
  const scriptRefs = (runtime.scene.scripts || []).map((item) => ({
    offset: item.offset,
    text: item.name,
    matched: item.matched,
    rel: item.rel,
  }));
  const scriptEvidence = renderRuntimeScriptEvidence(runtime.scene.scripts || []);
  const transitions = renderRuntimeTransitions(runtime.scene.transitions || {});
  const coreScene = coreRuntime?.scene || {};
  const coreStatus = coreRuntime?.runtimeStatus || {};
  const coreRuntimeText = coreRuntime?.source?.mode
    ? `${coreRuntime.source.mode} · ${coreRuntime.source.resourceCount || 0} resources · scene ${coreScene.canvas ? `${coreScene.canvas.width} x ${coreScene.canvas.height}` : "-"} · map ${coreScene.map?.name || "-"} · entities ${(coreRuntime.entities || []).length} · scripts ${(coreScene.scripts || []).length}`
    : "";
  const coreFrame = coreEmulator?.frame || {};
  const coreState = coreEmulator?.state || {};
  const coreEmulatorText = coreEmulator?.source?.mode
    ? `${coreEmulator.source.mode} · mode ${coreState.mode || "-"} · frame ${coreFrame.kind || "-"} · tick ${coreState.tick ?? "-"} · entities ${(coreFrame.entities || []).length} · camera ${coreFrame.camera ? `${coreFrame.camera.x || 0},${coreFrame.camera.y || 0}` : "-"}`
    : "";
  return `
    ${renderTrueRuntimeProbe(trueRuntime)}
    ${boot}
    ${vmBlocked ? "" : renderEmulatorPanel(runtime)}
    <div class="subhead">Runtime Snapshot</div>
    <p class="note-text">${escapeHtml(vmBlocked ? vmBlockedText : "Scene graph for the first emulator milestone. Terrain bytecode is linked but not executed yet; actors and scripts are resolved as runtime objects.")}</p>
    <dl class="kv">
      <dt>Screen</dt><dd>${runtime.screen.width} x ${runtime.screen.height}</dd>
      <dt>Scene</dt><dd>${canvas.width} x ${canvas.height} · stream ${escapeHtml(runtime.scene.streamOffset || "-")}</dd>
      <dt>Map</dt><dd>${escapeHtml(map.name || "-")} · draw ${escapeHtml(map.drawStreamOffset || "-")}</dd>
      <dt>Tileset</dt><dd>${escapeHtml(map.tileset || "-")}</dd>
      ${mapDecodeText ? `<dt>Map Decode</dt><dd>${escapeHtml(mapDecodeText)}</dd>` : ""}
      <dt>Status</dt><dd>${escapeHtml(`${status.stage || "-"} · ${status.terrain || "-"}`)}</dd>
      ${coreRuntimeText ? `<dt>Core Runtime</dt><dd>${escapeHtml(`${coreRuntimeText} · ${coreStatus.stage || "-"}`)}</dd>` : ""}
      ${coreEmulatorText ? `<dt>Core Emulator</dt><dd>${escapeHtml(coreEmulatorText)}</dd>` : ""}
    </dl>
    <div class="runtime-viewport">
      <div class="phone-stage" style="width:${camera.width}px;height:${camera.height}px;">
        <div class="${runtimeMapPlaneClass}" style="left:-${camera.x}px;top:-${camera.y}px;width:${canvas.width}px;height:${canvas.height}px;">${runtimeMapTiles}</div>
        <div class="phone-layer" style="left:-${camera.x}px;top:-${camera.y}px;width:${canvas.width}px;height:${canvas.height}px;">
          ${viewportActors}
        </div>
      </div>
      <div class="map-caption">${escapeHtml(`camera ${camera.width} x ${camera.height} @ ${camera.x},${camera.y}; ${runtime.entities.length} actor objects`)}</div>
    </div>
    <div class="scene-composite-wrap">
      <div class="scene-composite runtime-scene" style="width:${canvas.width}px;height:${canvas.height}px;">
        <div class="${runtimeMapPlaneClass}" style="left:0;top:0;width:${canvas.width}px;height:${canvas.height}px;">${runtimeMapTiles}</div>
        <div class="scene-viewport-frame" style="left:${camera.x}px;top:${camera.y}px;width:${camera.width}px;height:${camera.height}px;"></div>
        ${actors}
      </div>
    </div>
    ${entityRows ? `<div class="subhead">Runtime Entities</div><ul class="ref-list">${entityRows}</ul>` : ""}
    ${scriptRefs.length ? renderRefList("Runtime Scripts", scriptRefs) : ""}
    ${transitions}
    ${scriptEvidence}
  `;
}

function renderScenePlacements(summary) {
  const placements = summary?.specific?.sce?.placements || [];
  if (!placements.length) return "";
  const items = placements.slice(0, 24).map((placement) => {
    const jump = placement.rel ? ` data-jump-rel="${escapeHtml(placement.rel)}"` : "";
    const cls = placement.rel ? " class=\"jumpable\"" : "";
    const label = `${placement.name} -> ${placement.matched || "-"}  x=${placement.x} y=${placement.y} type=${placement.recordType}`;
    return `<li${cls}${jump}><span>${escapeHtml(placement.offset || "")}</span>${escapeHtml(label)}</li>`;
  }).join("");
  return `<div class="subhead">Scene Placements</div><ul class="ref-list">${items}</ul>`;
}

function placementGifUrl(placement) {
  if (!placement?.rel) return "";
  const stem = stemOf(fileNameFromRel(placement.rel));
  const gif = findCurrentFileByName(`${stem}.gif`);
  return gif ? assetUrlByName(gif.name) : "";
}

function renderStructSummary(summary) {
  if (!summary || summary.error) return "";
  const rows = [];
  const sce = summary.specific?.sce;
  const map = summary.specific?.map;
  const actor = summary.specific?.actor;
  const xse = summary.specific?.xse;
  const mapTemplate = map?.pictureTemplate;
  if (sce?.canvas) rows.push(["SCE Canvas", `${sce.canvas.width} x ${sce.canvas.height}`]);
  if (sce?.placements?.length) rows.push(["Scene Placements", String(sce.placements.length)]);
  if (mapTemplate?.compactName) rows.push(["Map Picture Template", `${mapTemplate.compactName} · ${mapTemplate.headerBytes} · word0 ${mapTemplate.headerWord0}`]);
  if (mapTemplate?.streamOffset) rows.push(["Template Stream", mapTemplate.streamOffset]);
  if (map?.tilesetHint) rows.push(["Map Tileset Hint", map.tilesetHint]);
  if (map?.canvas) rows.push(["Map Canvas", `${map.canvas.width} x ${map.canvas.height}`]);
  if (map?.canvasSource) rows.push(["Canvas Source", map.canvasSource]);
  if (map?.dataOffset) rows.push(["Map Data Offset", map.dataOffset]);
  if (map?.drawStreamOffset) rows.push(["Draw Stream", `${map.drawStreamOffset} · ${fmtBytes(map.drawStreamLength || 0)}`]);
  if (map?.payloadLength) rows.push(["Map Payload", fmtBytes(map.payloadLength)]);
  if (map?.stream?.bytesPer16Cell) rows.push(["Stream Density", `${map.stream.bytesPer16Cell} bytes / 16px cell`]);
  if (map?.stream?.highBitPercent != null) rows.push(["High-Bit Bytes", `${map.stream.highBitPercent}%`]);
  if (map?.headerDimension?.encoding) rows.push(["Header Dimensions", `${map.headerDimension.encoding} @ ${map.headerDimension.offset}`]);
  if (map?.leadHeader?.encoding) rows.push(["Map Lead Header", `${map.leadHeader.encoding} @ ${map.leadHeader.offset} -> ${map.leadHeader.drawStreamOffset}`]);
  if (map?.tileGrid) rows.push(["16px Grid", `${map.tileGrid.columns16} x ${map.tileGrid.rows16}`]);
  if (actor?.primaryImage) rows.push(["Actor Primary Image", actor.primaryImage]);
  if (actor?.imageInfo) rows.push(["Actor GIF Size", `${actor.imageInfo.width} x ${actor.imageInfo.height} · ${actor.imageInfo.frames} frame(s)`]);
  if (actor?.streamLength) rows.push(["Actor Stream", `${actor.streamOffset} · ${fmtBytes(actor.streamLength)}`]);
  if (xse?.magicOffset) rows.push(["XSE Magic", xse.magicOffset]);
  if (xse?.commands?.length) rows.push(["Script Commands", String(xse.commands.length)]);
  if (summary.refs?.direct?.length) rows.push(["Direct Refs", String(summary.refs.direct.length)]);
  if (summary.refs?.candidates?.length) rows.push(["Candidate Refs", String(summary.refs.candidates.length)]);

  let html = `<div class="subhead">Structure</div>`;
  if (rows.length) {
    html += `<dl class="kv compact-kv">${rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join("")}</dl>`;
  }
  if (map?.stream) html += renderMapStreamSummary(map.stream);
  if (map?.mapTemplateProbe) html += renderMapTemplateProbe(map.mapTemplateProbe);
  if (map?.f222LayoutProbe) html += renderF222LayoutProbe(map.f222LayoutProbe, "Map F222 Layout Probe", "canvas");
  if (map?.templateStreamProbe) html += renderTemplateStreamProbe(map.templateStreamProbe, "Map Template Stream Probe", "canvas");
  html += renderSceMapTable(summary);
  html += renderSceneObjectProbe(summary);
  html += renderScenePlacements(summary);
  if (xse?.commands?.length) {
    html += `<div class="subhead">Script Commands</div><ul class="ref-list">${
      xse.commands.map((cmd) => `<li><span>${escapeHtml(cmd.offset)}</span>${escapeHtml(cmd.name)}</li>`).join("")
    }</ul>`;
  }
  html += renderRefList("Direct Resource Refs", summary.refs?.direct || []);
  html += renderRefList("Likely Resource Refs", summary.refs?.candidates || [], "candidate");
  if (summary.u16Head?.length) {
    html += `<div class="subhead">Header u16</div><pre class="code small-code">${escapeHtml(compactHead(summary.u16Head))}</pre>`;
  }
  return html;
}

async function renderPreview(file) {
  const token = ++state.previewToken;
  nodes.previewTitle.textContent = file ? file.name : "Preview";
  nodes.previewMeta.textContent = file ? `${file.ext} · ${fmtBytes(file.writtenSize)}${file.note ? ` · ${file.note}` : ""}` : "";
  if (!file) {
    nodes.previewBody.innerHTML = `<div class="empty">Pick a resource.</div>`;
    return;
  }

  let body = file.ext === ".map" ? "" : previewThumb(file);
  body += `
    <dl class="kv">
      <dt>Game</dt><dd>${escapeHtml(file.game)}</dd>
      <dt>Rel</dt><dd>${escapeHtml(file.rel)}</dd>
      <dt>Offset</dt><dd>${escapeHtml(file.offset || "-")}</dd>
      <dt>Size</dt><dd>${fmtBytes(file.writtenSize || file.rawSize || 0)}</dd>
      <dt>Kind</dt><dd>${escapeHtml(file.kind)}</dd>
      <dt>Note</dt><dd>${escapeHtml(file.note || "-")}</dd>
    </dl>
  `;

  let struct = null;
  let mapTrace = null;
  let runtime = null;
  let trueRuntime = null;
  let coreRuntime = null;
  let coreEmulator = null;
  if (file.kind !== "image") {
    const previewLimit = Math.min(Math.max(file.writtenSize || file.rawSize || 8192, 8192), 65536);
    const [bytes, loadedStruct, loadedMapTrace, loadedRuntime, loadedTrueRuntime, loadedCoreRuntime, loadedCoreEmulator] = await Promise.all([
      loadBytes(file.game, file.rel, previewLimit),
      isStructExt(file.ext) ? loadStruct(file.game, file.rel) : Promise.resolve(null),
      file.ext === ".map" ? loadMapTrace(file.game, file.rel) : Promise.resolve(null),
      file.ext === ".sce" ? loadRuntimeScene(file.game, file.rel) : Promise.resolve(null),
      file.ext === ".sce" ? loadTrueRuntimeScene(file.game, file.rel) : Promise.resolve(null),
      file.ext === ".sce" ? loadCoreRuntimeScene(file.game, file.rel) : Promise.resolve(null),
      file.ext === ".sce" ? loadCoreEmulatorScene(file.game, file.rel) : Promise.resolve(null),
    ]);
    struct = loadedStruct;
    mapTrace = loadedMapTrace;
    runtime = loadedRuntime;
    trueRuntime = loadedTrueRuntime;
    coreRuntime = loadedCoreRuntime;
    coreEmulator = loadedCoreEmulator;
    if (token !== state.previewToken) return;
    const runs = scanTextRuns(bytes.bytes);
    if (mapTrace) {
      body += renderMapTrace(mapTrace);
    }
    if (struct) {
      if (file.ext === ".sce") {
        body += renderRuntimeScene(runtime, trueRuntime, coreRuntime, coreEmulator);
        body += renderScenePlacementPreview(struct);
      }
      if (file.ext === ".actor") body += renderActorStructure(struct);
      body += renderRelations(file, struct);
      body += renderStructSummary(struct);
    }
    body += `<div class="subhead">Hex</div><pre class="code">${escapeHtml(hexPreview(bytes.bytes.slice(0, 512)))}</pre>`;
    if (runs.length) {
      body += `<div class="subhead">Readable Text</div><pre class="code text-code">${escapeHtml(formatTextRuns(runs))}</pre>`;
    }
  }
  if (token !== state.previewToken) return;
  nodes.previewBody.innerHTML = body;
}

function renderFiles() {
  const game = getCurrentGame();
  const files = getFiles(game);
  nodes.fileScope.textContent = game ? game.name : "Files";
  nodes.fileCount.textContent = `${files.length} items`;

  if (!game) {
    nodes.fileList.innerHTML = `<div class="empty">No game selected.</div>`;
    nodes.previewBody.innerHTML = `<div class="empty">Pick a resource.</div>`;
    return;
  }

  if (!state.selectedFile && files.length) {
    state.selectedFile = (preferredFileForGame(game, files) || files[0]).rel;
  }

  nodes.fileList.innerHTML = `
    <div class="grid">
      ${files.map((file) => {
        const active = state.selectedFile === file.rel ? "active" : "";
        const src = file.kind === "image"
          ? `/asset?game=${encodeURIComponent(game.name)}&rel=${encodeURIComponent(file.rel)}`
          : "";
        return `
          <button class="tile ${active}" data-rel="${escapeHtml(file.rel)}">
            <div class="thumb">${file.kind === "image" ? `<img src="${src}" alt="${escapeHtml(file.name)}">` : `<div class="file-icon">${escapeHtml((file.ext || "").replace(".", "") || "bin")}</div>`}</div>
            <div class="tile-info">
              <div class="tile-name">${escapeHtml(file.name)}</div>
              <div class="tile-meta">${escapeHtml(file.kind)} · ${fmtBytes(file.writtenSize || file.rawSize || 0)}</div>
            </div>
          </button>
        `;
      }).join("")}
    </div>
  `;

  const selected = files.find((f) => f.rel === state.selectedFile) || preferredFileForGame(game, files) || files[0] || null;
  if (selected) renderPreview(selected);
}

function jumpToResource(rel) {
  const target = findCurrentFileByRel(rel);
  if (!target) return;
  state.kindFilter = "all";
  state.search = "";
  state.selectedFile = rel;
  nodes.searchInput.value = "";
  renderFilters();
  renderFiles();
  writeRoute();
}

function emulatorSetMode(root, mode) {
  if (!root) return;
  root.dataset.mode = mode;
  root.querySelectorAll("[data-emulator-frame]").forEach((frame) => {
    frame.classList.toggle("active", frame.dataset.emulatorFrame === mode);
  });
  updateEmulatorStatus(root, mode);
}

function updateEmulatorStatus(root, mode = root?.dataset.mode || "scene") {
  const status = root.querySelector("[data-emulator-status]");
  if (status) {
    const screen = `${root.dataset.screenWidth || 240}x${root.dataset.screenHeight || 400}`;
    if (String(mode).startsWith("flow-")) {
      const frame = Array.from(root.querySelectorAll("[data-emulator-frame]"))
        .find((node) => node.dataset.emulatorFrame === mode);
      const choice = root.dataset.routeChoice ? ` · ${root.dataset.routeChoice}` : "";
      status.textContent = `${frame?.dataset.flowTitle || "BOOT FLOW"} · ${screen}${choice}`;
      return;
    }
    const camera = `${root.dataset.cameraX || 0},${root.dataset.cameraY || 0}`;
    const player = emulatorControlledActor(root);
    const pos = player ? ` · player ${Math.round(Number(player.dataset.emulatorX || 0))},${Math.round(Number(player.dataset.emulatorY || 0))}` : "";
    status.textContent = mode === "scene" ? `SCENE · ${screen} · ${camera}${pos}` : `${mode.toUpperCase()} · ${screen}`;
  }
}

function emulatorControlledActor(root) {
  const id = root?.dataset.controlEntityId || "";
  if (!id) return null;
  return Array.from(root.querySelectorAll("[data-emulator-entity-id]"))
    .find((node) => node.dataset.emulatorEntityId === id) || null;
}

function emulatorClampCamera(root, x, y) {
  const canvasW = Number(root.dataset.canvasWidth || root.dataset.screenWidth || 240);
  const canvasH = Number(root.dataset.canvasHeight || root.dataset.screenHeight || 400);
  const screenW = Number(root.dataset.screenWidth || 240);
  const screenH = Number(root.dataset.screenHeight || 400);
  const maxX = Math.max(0, canvasW - screenW);
  const maxY = Math.max(0, canvasH - screenH);
  return {
    x: Math.max(0, Math.min(maxX, x)),
    y: Math.max(0, Math.min(maxY, y)),
  };
}

function emulatorSetCamera(root, x, y) {
  const next = emulatorClampCamera(root, x, y);
  const mapPlane = root.querySelector("[data-emulator-map-plane]");
  const layer = root.querySelector("[data-emulator-scene-layer]");
  if (mapPlane) {
    mapPlane.style.left = `${-next.x}px`;
    mapPlane.style.top = `${-next.y}px`;
  }
  if (layer) {
    layer.style.left = `${-next.x}px`;
    layer.style.top = `${-next.y}px`;
  }
  root.dataset.cameraX = String(next.x);
  root.dataset.cameraY = String(next.y);
  emulatorSetMode(root, "scene");
}

function emulatorSelectControlled(root, id) {
  root.dataset.controlEntityId = id || "";
  root.querySelectorAll("[data-emulator-entity-id]").forEach((node) => {
    node.classList.toggle("controlled", Boolean(id) && node.dataset.emulatorEntityId === id);
  });
  const actor = emulatorControlledActor(root);
  if (actor) {
    emulatorSetCamera(root, Math.round(Number(actor.dataset.emulatorX || 0) - Number(root.dataset.screenWidth || 240) / 2), Math.round(Number(actor.dataset.emulatorY || 0) - Number(root.dataset.screenHeight || 400) / 2));
  } else {
    updateEmulatorStatus(root);
  }
}

function emulatorCenter(root) {
  const actor = emulatorControlledActor(root);
  if (actor) {
    emulatorSetCamera(root, Math.round(Number(actor.dataset.emulatorX || 0) - Number(root.dataset.screenWidth || 240) / 2), Math.round(Number(actor.dataset.emulatorY || 0) - Number(root.dataset.screenHeight || 400) / 2));
    return;
  }
  const canvasW = Number(root.dataset.canvasWidth || root.dataset.screenWidth || 240);
  const canvasH = Number(root.dataset.canvasHeight || root.dataset.screenHeight || 400);
  const screenW = Number(root.dataset.screenWidth || 240);
  const screenH = Number(root.dataset.screenHeight || 400);
  emulatorSetCamera(root, Math.round((canvasW - screenW) / 2), Math.round((canvasH - screenH) / 2));
}

function emulatorPan(root, dx, dy) {
  emulatorSetCamera(root, Number(root.dataset.cameraX || 0) + dx, Number(root.dataset.cameraY || 0) + dy);
}

function emulatorActiveFlowFrame(root) {
  const mode = root?.dataset.mode || "";
  if (!mode.startsWith("flow-")) return null;
  return Array.from(root.querySelectorAll("[data-emulator-frame]"))
    .find((node) => node.dataset.emulatorFrame === mode) || null;
}

function emulatorSetFlowChoice(root, index) {
  const frame = emulatorActiveFlowFrame(root);
  if (!frame) return false;
  const choices = Array.from(frame.querySelectorAll("[data-choice-index]"));
  if (!choices.length) return false;
  const nextIndex = Math.max(0, Math.min(choices.length - 1, index));
  choices.forEach((choice, choiceIndex) => {
    choice.classList.toggle("selected", choiceIndex === nextIndex);
  });
  root.dataset.routeChoice = choices[nextIndex]?.dataset.choiceId || "";
  root.dataset.routeSceneRel = choices[nextIndex]?.dataset.sceneRel || "";
  updateEmulatorStatus(root);
  return true;
}

function emulatorNudgeFlowChoice(root, delta) {
  const frame = emulatorActiveFlowFrame(root);
  if (!frame) return false;
  const choices = Array.from(frame.querySelectorAll("[data-choice-index]"));
  if (!choices.length) return false;
  const current = Math.max(0, choices.findIndex((choice) => choice.classList.contains("selected")));
  return emulatorSetFlowChoice(root, current + delta);
}

function emulatorAdvanceFlow(root) {
  const frame = emulatorActiveFlowFrame(root);
  if (!frame) return false;
  const index = Number(frame.dataset.flowIndex || 0);
  const count = Number(root.dataset.flowCount || 0);
  if (index + 1 < count) {
    emulatorSetMode(root, `flow-${index + 1}`);
  } else {
    const targetScene = root.dataset.routeSceneRel || "";
    if (targetScene && findCurrentFileByRel(targetScene)) {
      jumpToResource(targetScene);
    } else {
      emulatorSetMode(root, "scene");
    }
  }
  return true;
}

function emulatorBackFlow(root) {
  const frame = emulatorActiveFlowFrame(root);
  if (!frame) return false;
  const index = Number(frame.dataset.flowIndex || 0);
  if (index > 0) emulatorSetMode(root, `flow-${index - 1}`);
  return true;
}

function emulatorMoveControlled(root, input) {
  const actor = emulatorControlledActor(root);
  if (!actor) return false;
  const step = Number(root.dataset.step || 16);
  const canvasW = Number(root.dataset.canvasWidth || root.dataset.screenWidth || 240);
  const canvasH = Number(root.dataset.canvasHeight || root.dataset.screenHeight || 400);
  const screenW = Number(root.dataset.screenWidth || 240);
  const screenH = Number(root.dataset.screenHeight || 400);
  const dx = input === "left" ? -step : input === "right" ? step : 0;
  const dy = input === "up" ? -step : input === "down" ? step : 0;
  const x = Math.max(0, Math.min(canvasW, Number(actor.dataset.emulatorX || 0) + dx));
  const y = Math.max(0, Math.min(canvasH, Number(actor.dataset.emulatorY || 0) + dy));
  actor.dataset.emulatorX = String(x);
  actor.dataset.emulatorY = String(y);
  actor.dataset.direction = input;
  actor.style.left = `${x}px`;
  actor.style.top = `${y}px`;
  emulatorSetCamera(root, Math.round(x - screenW / 2), Math.round(y - screenH / 2));
  return true;
}

function handleEmulatorInput(target) {
  const root = target.closest("[data-emulator]");
  if (!root) return;
  const input = target.dataset.emulatorInput;
  const mode = root.dataset.mode || "boot";
  if (mode.startsWith("flow-")) {
    if (input === "choice") {
      emulatorSetFlowChoice(root, Number(target.dataset.choiceIndex || 0));
      return;
    }
    if (input === "left" && emulatorNudgeFlowChoice(root, -1)) return;
    if (input === "right" && emulatorNudgeFlowChoice(root, 1)) return;
    if (input === "back") {
      emulatorBackFlow(root);
      return;
    }
    if (input === "scene") {
      emulatorSetMode(root, "scene");
      return;
    }
    if (input === "confirm" || input === "center" || input === "up" || input === "down") {
      emulatorAdvanceFlow(root);
      return;
    }
    return;
  }
  if (input === "confirm" && mode === "boot") {
    const hasLoading = Boolean(root.querySelector('[data-emulator-frame="loading"]'));
    if (hasLoading) {
      emulatorSetMode(root, "loading");
      window.setTimeout(() => emulatorSetMode(root, "scene"), 450);
    } else {
      emulatorSetMode(root, "scene");
    }
    return;
  }
  if (input === "confirm" && mode === "loading") {
    emulatorSetMode(root, "scene");
    return;
  }
  if (input === "back") {
    emulatorSetMode(root, root.querySelector('[data-emulator-frame="boot"]') ? "boot" : "scene");
    return;
  }
  if (input === "scene") {
    emulatorSetMode(root, "scene");
    return;
  }
  if (mode !== "scene") return;
  if (input === "center") {
    emulatorCenter(root);
    return;
  }
  if (["left", "right", "up", "down"].includes(input) && emulatorMoveControlled(root, input)) return;
  if (input === "left") emulatorPan(root, -16, 0);
  if (input === "right") emulatorPan(root, 16, 0);
  if (input === "up") emulatorPan(root, 0, -16);
  if (input === "down") emulatorPan(root, 0, 16);
}

function updateSummary() {
  if (!state.index) {
    nodes.summary.textContent = "Loading";
    return;
  }
  const games = getGames();
  const files = games.reduce((sum, g) => sum + g.files.length, 0);
  nodes.summary.textContent = `${games.length} games · ${files} files`;
}

function bindEvents() {
  nodes.refreshBtn.addEventListener("click", refresh);
  nodes.searchInput.addEventListener("input", () => {
    state.search = nodes.searchInput.value;
    renderFiles();
  });
  nodes.errorsToggle.addEventListener("change", () => {
    state.showErrors = nodes.errorsToggle.checked;
    renderFiles();
  });
  nodes.typeFilters.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-kind]");
    if (!btn) return;
    state.kindFilter = btn.dataset.kind;
    renderFilters();
    renderFiles();
  });
  nodes.gameList.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-game]");
    if (!btn) return;
    state.selectedGame = btn.dataset.game;
    state.selectedFile = null;
    renderGames();
    renderFiles();
    writeRoute();
  });
  nodes.fileList.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-rel]");
    if (!btn) return;
    state.selectedFile = btn.dataset.rel;
    renderFiles();
    writeRoute();
  });
  nodes.previewBody.addEventListener("click", (event) => {
    const emu = event.target.closest("[data-emulator-input]");
    if (emu) {
      handleEmulatorInput(emu);
      return;
    }
    const btn = event.target.closest("[data-jump-rel]");
    if (!btn) return;
    jumpToResource(btn.dataset.jumpRel);
  });
  nodes.previewBody.addEventListener("change", (event) => {
    const select = event.target.closest("[data-emulator-follow]");
    if (!select) return;
    const root = select.closest("[data-emulator]");
    emulatorSelectControlled(root, select.value);
  });
  nodes.previewBody.addEventListener("keydown", (event) => {
    const root = event.target.closest("[data-emulator]");
    if (!root) return;
    const keyMap = {
      ArrowUp: "up",
      ArrowDown: "down",
      ArrowLeft: "left",
      ArrowRight: "right",
      Enter: "confirm",
      " ": "confirm",
      Escape: "back",
      Backspace: "back",
    };
    const input = keyMap[event.key];
    if (!input) return;
    event.preventDefault();
    handleEmulatorInput({ dataset: { emulatorInput: input }, closest: () => root });
  });
}

async function refresh() {
  const res = await fetch("/api/index");
  state.index = await res.json();
  const route = readRoute();
  const games = getGames();
  const routeGame = games.find((game) => game.name === route.game)?.name || "";
  const routeFileGame = route.rel ? games.find((game) => game.files.some((file) => file.rel === route.rel))?.name || "" : "";
  state.selectedGame = routeGame ||
    routeFileGame ||
    state.selectedGame ||
    games.find((game) => game.name.includes("众神之战"))?.name ||
    games[0]?.name ||
    null;
  state.selectedFile = route.rel && findCurrentFileByRel(route.rel) ? route.rel : state.selectedFile;
  updateSummary();
  renderFilters();
  renderGames();
  renderFiles();
}

bindEvents();
refresh().catch((err) => {
  nodes.summary.textContent = err.message;
});
