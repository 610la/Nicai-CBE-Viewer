const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const {
  KNOWN_SCRIPT_COMMANDS,
  asciiRuns,
  hexBytes,
  parseResourceEnvelope,
  probe112C4ResourceBuffer,
  scanTextRuns,
} = require("./cbe_struct");

const DEFAULT_GAME_ROOT = path.join(process.cwd(), "out_batch", "众神之战");
const DEFAULT_OUT = path.join(process.cwd(), "out_godwar_xselayout");
const FOCUS = ["s_01.xse", "s_02.xse", "s_03.xse", "s_04.xse"];

const FRAGMENT_HINTS = new Map([
  ["SCREENSIZE", "GETSCREENSIZE"],
  ["RAMODE", "SETCAMERAMODE"],
  ["ROLEPOS", "SETROLEPOS"],
  ["MOVETO", "ROLEMOVETO"],
  ["RTDIALOG", "STARTDIALOG"],
  ["SHOW", "SHOWDIALOG"],
  ["CHANG", "CHANGESCENE"],
  ["ENE", "CHANGESCENE"],
  ["LIGHT", "LOADLIGHTGOD"],
  ["DARK", "LOADDARKGOD"],
  ["MONSTER", "LOADMONSTER"],
  ["CLOSE", "CLOSESCRIPT"],
  ["IPT", "CLOSESCRIPT"],
  ["CR", "LOADCR/OPENCR/ISCR"],
  ["ONWUDI", "ROLEONWUDI"],
  ["ATTACK", "ROLEATTACK"],
  ["SKILL", "ROLESKILL/ISFINISHSKILL"],
  ["ISF", "ISFINISHSKILL"],
  ["SWORD", "SETROLESWORD"],
  ["HUR", "HURTROLE"],
  ["END", "ENDDIALOG/ENDSCRIPT"],
]);

const POOL_LABELS = ["INIT", "_MAIN"];

function cleanName(name) {
  return String(name || "").replace(/^[0-9]{4}_/, "");
}

function relFrom(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function hex(n, width = 4) {
  if (!Number.isFinite(n) || n < 0) return "";
  return `0x${n.toString(16).toUpperCase().padStart(width, "0")}`;
}

function numericHex(value) {
  if (!value) return -1;
  const parsed = Number.parseInt(String(value).replace(/^0x/i, ""), 16);
  return Number.isFinite(parsed) ? parsed : -1;
}

function loadCatalog(gameRoot) {
  const manifest = JSON.parse(fs.readFileSync(path.join(gameRoot, "manifest.json"), "utf8"));
  return manifest.files
    .filter((file) => file.output && !file.skipped)
    .map((file) => ({
      name: file.name,
      cleanName: cleanName(file.name),
      output: file.output,
      rel: relFrom(gameRoot, file.output),
      size: file.rawSize || file.writtenSize || file.size || 0,
    }));
}

function findEntry(catalog, name) {
  const target = name.toLowerCase();
  return catalog.find((entry) => entry.cleanName.toLowerCase() === target) || null;
}

function printable(byte) {
  return byte >= 0x20 && byte <= 0x7E ? String.fromCharCode(byte) : ".";
}

function visibleAscii(bytes) {
  return Array.from(bytes).map(printable).join("");
}

function asciiSegments(bytes, min = 3) {
  const out = [];
  let start = -1;
  for (let index = 0; index <= bytes.length; index += 1) {
    const byte = index < bytes.length ? bytes[index] : 0;
    const ok = byte >= 0x20 && byte <= 0x7E;
    if (ok && start < 0) start = index;
    if (!ok && start >= 0) {
      if (index - start >= min) {
        out.push({
          offset: start,
          text: bytes.subarray(start, index).toString("ascii"),
        });
      }
      start = -1;
    }
  }
  return out;
}

function commandAtoms(buf, start = 0) {
  const atoms = [];
  const all = [
    ...KNOWN_SCRIPT_COMMANDS.map((command) => ({ text: command, command, kind: "full" })),
    ...[...FRAGMENT_HINTS.entries()].map(([text, command]) => ({ text, command, kind: "fragment" })),
    ...POOL_LABELS.map((text) => ({ text, command: text, kind: "label" })),
  ];
  for (const item of all) {
    const needle = Buffer.from(item.text, "ascii");
    let offset = Math.max(-1, start - 1);
    while ((offset = buf.indexOf(needle, offset + 1)) >= 0) {
      atoms.push({
        ...item,
        offset,
        end: offset + needle.length,
        offsetHex: hex(offset),
        lenByte: offset > 0 && buf[offset - 1] === item.text.length,
      });
    }
  }
  atoms.sort((a, b) => a.offset - b.offset || b.end - b.offset - (a.end - a.offset));
  const selected = [];
  for (const atom of atoms) {
    if (selected.some((item) => atom.offset < item.end && atom.end > item.offset)) continue;
    selected.push(atom);
  }
  return selected;
}

function commandNamesInPayload(bytes) {
  const visible = visibleAscii(bytes);
  const hits = [];
  for (const command of KNOWN_SCRIPT_COMMANDS) {
    if (visible.includes(command)) hits.push({ text: command, command, kind: "full" });
  }
  for (const [fragment, command] of FRAGMENT_HINTS.entries()) {
    if (visible.includes(fragment)) hits.push({ text: fragment, command, kind: "fragment" });
  }
  for (const label of POOL_LABELS) {
    if (visible.includes(label)) hits.push({ text: label, command: label, kind: "label" });
  }
  return hits;
}

function scorePoolPayload(bytes) {
  const segments = asciiSegments(bytes, 3);
  const atomHits = commandNamesInPayload(bytes);
  const visible = visibleAscii(bytes);
  const leadingHit = [
    ...KNOWN_SCRIPT_COMMANDS.map((command) => ({ text: command, command, kind: "full" })),
    ...POOL_LABELS.map((text) => ({ text, command: text, kind: "label" })),
  ].find((hit) => visible.startsWith(hit.text)) || null;
  const upper = segments
    .filter((segment) => /^[A-Z_]{3,}$/.test(segment.text))
    .map((segment) => segment.text);
  const refs = segments
    .filter((segment) => /\.[A-Za-z0-9]{2,4}$/.test(segment.text))
    .map((segment) => segment.text);
  return {
    segments,
    atomHits,
    leadingHit,
    upper,
    refs,
    score: atomHits.length * 8 + upper.length * 4 + refs.length * 6 + segments.length + (leadingHit ? 40 : 0),
  };
}

function scanLengthSlots(buf, start, end) {
  const rows = [];
  for (let offset = Math.max(0, start); offset < Math.min(end, buf.length); offset += 1) {
    const length = buf[offset];
    if (length < 3 || length > 20 || offset + 1 + length > end) continue;
    const payload = buf.subarray(offset + 1, offset + 1 + length);
    const scored = scorePoolPayload(payload);
    if (scored.score < 5) continue;
    const asciiBytes = payload.filter((byte) => byte >= 0x20 && byte <= 0x7E).length;
    rows.push({
      offset,
      offsetHex: hex(offset),
      payloadOffsetHex: hex(offset + 1),
      length,
      end: offset + 1 + length,
      endHex: hex(offset + 1 + length),
      kind: asciiBytes === payload.length ? "plain" : "mixed",
      visible: visibleAscii(payload),
      raw: hexBytes(payload),
      score: scored.score,
      leadingHit: scored.leadingHit,
      segments: scored.segments.map((segment) => ({
        offset: hex(offset + 1 + segment.offset),
        text: segment.text,
      })),
      atomHits: scored.atomHits,
    });
  }
  rows.sort((a, b) => b.score - a.score || Number(Boolean(b.leadingHit)) - Number(Boolean(a.leadingHit)) || a.offset - b.offset);
  const selected = [];
  for (const row of rows) {
    if (selected.some((item) => row.offset < item.end && row.end > item.offset)) continue;
    selected.push(row);
  }
  return selected.sort((a, b) => a.offset - b.offset);
}

function isMostlyUsefulText(run) {
  const text = run.text || "";
  const chinese = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff]/gu) || []).length;
  const punctuation = (text.match(/[，。！？：；（）【】《》]/gu) || []).length;
  const hasSpeaker = text.includes("[") || text.includes("]") || text.includes("：");
  const hasRef = /\.[A-Za-z0-9]{2,4}/.test(text);
  return hasRef || hasSpeaker || punctuation > 0 || chinese >= 4;
}

function summarizeTextRuns(buf, start, end) {
  return scanTextRuns(buf, 3, 500)
    .filter((run) => run.offset >= start && run.offset < end)
    .filter(isMostlyUsefulText)
    .map((run) => ({
      offset: run.offset,
      offsetHex: hex(run.offset),
      length: run.length,
      text: run.text,
    }));
}

function summarizeAsciiRefs(buf, start, end) {
  return asciiRuns(buf, 3, 500)
    .filter((run) => run.offset >= start && run.offset < end)
    .filter((run) => /\.(?:actor|gif|map|sce|xse|mp3)\b/i.test(run.text) || POOL_LABELS.includes(run.text))
    .map((run) => ({
      offset: run.offset,
      offsetHex: hex(run.offset),
      text: run.text,
    }));
}

function inferZones(buf, probe, atoms, textRuns) {
  const envelope = parseResourceEnvelope(buf);
  const xseOffset = buf.indexOf(Buffer.from("XSE0", "ascii"));
  const probeStart = numericHex(probe.best?.cursorStart);
  const probeEnd = numericHex(probe.best?.endOffset);
  const initAtom = atoms.find((atom) => atom.text === "INIT") || null;
  const mainAtom = atoms.find((atom) => atom.text === "_MAIN") || null;
  const firstUsefulText = textRuns.find((run) => run.offset >= Math.max(0, probeEnd)) || null;
  const poolStart = firstUsefulText?.offset ?? (probeEnd > 0 ? probeEnd : envelope.bodyOffset);
  const symbolStart = initAtom?.offset ?? mainAtom?.offset ?? -1;
  return {
    envelope: {
      start: hex(0),
      end: hex(Math.min(envelope.bodyOffset, buf.length)),
      declaredBodyLength: envelope.declaredBodyLength,
      bodyOffset: hex(envelope.bodyOffset),
      lengthMatches: envelope.lengthMatches,
    },
    magic: {
      xse0Offset: hex(xseOffset),
      raw: xseOffset >= 0 ? hexBytes(buf.subarray(xseOffset, xseOffset + 4)) : "",
    },
    objectProbe: {
      start: hex(probeStart),
      end: hex(probeEnd),
      confidence: probe.confidence,
      reader: probe.best?.groupIdReader || "",
      groups: probe.best?.groupCount ?? null,
      records: probe.best?.totalRecords ?? null,
      recordByteSize: probe.best?.header?.recordByteSize ?? null,
      knownOpcodePercent: probe.best?.knownOpcodePercent ?? null,
    },
    postProbeBytes: {
      start: hex(probeEnd),
      end: hex(poolStart),
      length: Math.max(0, poolStart - probeEnd),
    },
    textAndResourcePool: {
      start: hex(poolStart),
      end: hex(symbolStart >= 0 ? symbolStart : buf.length),
      length: Math.max(0, (symbolStart >= 0 ? symbolStart : buf.length) - poolStart),
    },
    labelAndSymbolPool: {
      start: hex(symbolStart),
      end: hex(buf.length),
      length: symbolStart >= 0 ? buf.length - symbolStart : 0,
      initOffset: initAtom ? initAtom.offsetHex : "",
      mainOffset: mainAtom ? mainAtom.offsetHex : "",
    },
  };
}

function analyzeScript(entry) {
  const buf = fs.readFileSync(entry.output);
  const probe = probe112C4ResourceBuffer(buf, { resourceName: entry.cleanName });
  const probeEnd = numericHex(probe.best?.endOffset);
  const atoms = commandAtoms(buf, Math.max(0, probeEnd));
  const allTextRuns = scanTextRuns(buf, 3, 500)
    .map((run) => ({ ...run, offsetHex: hex(run.offset) }));
  const zones = inferZones(buf, probe, atoms, allTextRuns);
  const textStart = numericHex(zones.textAndResourcePool.start);
  const textEnd = numericHex(zones.textAndResourcePool.end) || buf.length;
  const symbolStart = numericHex(zones.labelAndSymbolPool.start);
  const symbolEnd = numericHex(zones.labelAndSymbolPool.end) || buf.length;
  const lengthSlots = symbolStart >= 0 ? scanLengthSlots(buf, Math.max(0, symbolStart - 8), symbolEnd) : [];

  return {
    name: entry.cleanName,
    rel: entry.rel,
    size: buf.length,
    zones,
    probeSummary: {
      confidence: probe.confidence,
      best: probe.best ? {
        score: probe.best.score,
        ok: probe.best.ok,
        groupIdReader: probe.best.groupIdReader,
        cursorStart: probe.best.cursorStart,
        endOffset: probe.best.endOffset,
        groupCount: probe.best.groupCount,
        parsedGroupCount: probe.best.parsedGroupCount,
        totalRecords: probe.best.totalRecords,
        recordByteSize: probe.best.header?.recordByteSize ?? null,
        opcodeHistogram: probe.best.opcodeHistogram,
      } : null,
      attempts: probe.attempts,
    },
    textRuns: summarizeTextRuns(buf, Math.max(0, textStart), textEnd),
    asciiRefs: summarizeAsciiRefs(buf, Math.max(0, textStart), textEnd),
    atoms: atoms.map((atom) => ({
      offset: atom.offset,
      offsetHex: atom.offsetHex,
      text: atom.text,
      command: atom.command,
      kind: atom.kind,
      lenByte: atom.lenByte,
    })),
    lengthSlots: lengthSlots.slice(0, 80),
    tailWindow: symbolStart >= 0 ? {
      start: hex(Math.max(0, symbolStart - 24)),
      bytes: hexBytes(buf.subarray(Math.max(0, symbolStart - 24), Math.min(buf.length, symbolStart + 160))),
      visible: visibleAscii(buf.subarray(Math.max(0, symbolStart - 24), Math.min(buf.length, symbolStart + 160))),
    } : null,
  };
}

function renderSlot(slot) {
  const hits = slot.atomHits.map((hit) => `${hit.text}->${hit.command}`).join(", ");
  const segs = slot.segments.map((segment) => `${segment.offset}:${segment.text}`).join(" | ");
  const leading = slot.leadingHit ? ` leading=${slot.leadingHit.text}` : "";
  return `- ${slot.offsetHex} len=${slot.length} ${slot.kind}${leading} visible=\`${slot.visible}\`${hits ? ` hits=[${hits}]` : ""}${segs ? ` segments=${segs}` : ""}`;
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# God War XSE Layout Trace");
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push("");
  lines.push("## Reading Notes");
  lines.push("");
  lines.push("- This report separates the XSE file into likely object/table bytes, text/resource pool bytes, and tail label/symbol-pool bytes.");
  lines.push("- The tail command-name hits are evidence for available script symbols, not proof that the bytes appear in final execution order.");
  lines.push("- Mixed length slots such as `...SCREENSIZE` or `...RAMODE` explain why plain ASCII scans see command fragments instead of complete command names.");
  lines.push("- `0x112C4` probe fields are structural anchors from the CBE initializer. They are still diagnostic, not a full VM decompiler.");
  for (const script of report.scripts) {
    lines.push("");
    lines.push(`## ${script.name}`);
    lines.push("");
    lines.push(`Rel: ${script.rel}`);
    lines.push(`Size: ${script.size}`);
    lines.push("");
    lines.push("### Zones");
    lines.push("");
    lines.push(`- envelope: ${script.zones.envelope.start}..${script.zones.envelope.end} bodyOffset=${script.zones.envelope.bodyOffset} declared=${script.zones.envelope.declaredBodyLength} matches=${script.zones.envelope.lengthMatches}`);
    lines.push(`- magic: XSE0 at ${script.zones.magic.xse0Offset}`);
    lines.push(`- object/table probe: ${script.zones.objectProbe.start}..${script.zones.objectProbe.end} reader=${script.zones.objectProbe.reader} groups=${script.zones.objectProbe.groups} records=${script.zones.objectProbe.records} confidence=${script.zones.objectProbe.confidence}`);
    lines.push(`- post-probe bytes: ${script.zones.postProbeBytes.start}..${script.zones.postProbeBytes.end} length=${script.zones.postProbeBytes.length}`);
    lines.push(`- text/resource pool: ${script.zones.textAndResourcePool.start}..${script.zones.textAndResourcePool.end} length=${script.zones.textAndResourcePool.length}`);
    lines.push(`- label/symbol pool: ${script.zones.labelAndSymbolPool.start}..${script.zones.labelAndSymbolPool.end} length=${script.zones.labelAndSymbolPool.length} INIT=${script.zones.labelAndSymbolPool.initOffset} _MAIN=${script.zones.labelAndSymbolPool.mainOffset}`);
    lines.push("");
    lines.push("### Text/Resource Pool");
    lines.push("");
    if (script.asciiRefs.length) {
      lines.push("Refs:");
      for (const ref of script.asciiRefs.slice(0, 16)) lines.push(`- ${ref.offsetHex}: ${ref.text}`);
    }
    if (script.textRuns.length) {
      lines.push("Text runs:");
      for (const run of script.textRuns.slice(0, 16)) lines.push(`- ${run.offsetHex}: ${run.text}`);
    }
    if (!script.asciiRefs.length && !script.textRuns.length) lines.push("- none");
    lines.push("");
    lines.push("### Tail Symbol Slots");
    lines.push("");
    for (const slot of script.lengthSlots.slice(0, 28)) lines.push(renderSlot(slot));
    lines.push("");
    lines.push("### Tail Atom Hits");
    lines.push("");
    for (const atom of script.atoms.slice(0, 40)) {
      lines.push(`- ${atom.offsetHex}: ${atom.kind} ${atom.text}->${atom.command}${atom.lenByte ? " lenByte" : ""}`);
    }
  }
  lines.push("");
  lines.push("## Current Conclusions");
  lines.push("");
  lines.push("- The focused XSE files have a stable pattern: resource envelope, `XSE0`, a 0x112C4-style object/table region, then embedded dialogue/resource strings, then `INIT`/`_MAIN` and script symbol slots.");
  lines.push("- Because the symbol slots can be mixed binary-plus-ASCII payloads, fragment rows in older scans should be treated as symbol-pool evidence, not as decoded commands.");
  lines.push("- The next reverse step is correlating object/table references with these pool offsets so the actual VM execution order can be reconstructed.");
  return lines.join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  const gameRoot = path.resolve(args[0] || DEFAULT_GAME_ROOT);
  const outDir = path.resolve(args[1] || DEFAULT_OUT);
  const focus = args.slice(2).length ? args.slice(2) : FOCUS;
  const catalog = loadCatalog(gameRoot);
  const scripts = focus
    .map((name) => findEntry(catalog, name))
    .filter(Boolean)
    .map(analyzeScript);
  const report = {
    gameRoot,
    generatedAt: new Date().toISOString(),
    scripts,
  };
  fs.mkdirSync(outDir, { recursive: true });
  await fsp.writeFile(path.join(outDir, "xse_layout_trace.json"), JSON.stringify(report, null, 2), "utf8");
  await fsp.writeFile(path.join(outDir, "xse_layout_trace.md"), renderMarkdown(report), "utf8");
  console.log(`Output: ${outDir}`);
  console.log(`Scripts: ${scripts.length}`);
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
