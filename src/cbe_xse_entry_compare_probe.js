const fs = require("fs");
const path = require("path");

const ENTRYPOINT_JSON = path.resolve(__dirname, "out_godwar_xseentrypoint", "xse_entrypoint_probe.json");
const ENTRY_CALLER_JSON = path.resolve(__dirname, "out_godwar_xseentrycallers", "xse_entry_caller_probe.json");
const LAYOUT_JSON = path.resolve(__dirname, "out_godwar_xselayout", "xse_layout_trace.json");
const DEFAULT_OUT = path.resolve(__dirname, "out_godwar_xseentrycompare");

const STRONG_TRANSFORMS = new Set([
  "absLen",
  "absPayload",
  "symbolRelLen",
  "symbolRelPayload",
  "textRelLen",
  "textRelPayload",
  "groupRelLen",
  "groupRelPayload",
]);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function parseHex(text) {
  return typeof text === "string" && /^0x/i.test(text) ? parseInt(text, 16) : NaN;
}

function hex(n, width = 4) {
  if (!Number.isFinite(n) || n < 0) return "";
  return `0x${n.toString(16).toUpperCase().padStart(width, "0")}`;
}

function readAscii(data, offset, limit = 40) {
  if (!Number.isFinite(offset) || offset < 0 || offset >= data.length) return "";
  let end = offset;
  while (end < data.length && end - offset < limit) {
    const value = data[end];
    if (value === 0) break;
    if (value < 0x20 || value > 0x7e) break;
    end += 1;
  }
  return data.subarray(offset, end).toString("ascii");
}

function normalizeRequestedLabel(text) {
  const lower = String(text || "").toLowerCase();
  if (lower.includes("init")) return "INIT";
  if (lower.includes("main")) return "_MAIN";
  return String(text || "").toUpperCase();
}

function pointerProfile(data, caller) {
  const target = parseHex(caller.labelArg?.targetHex);
  const exact = readAscii(data, target);
  const nearby = [];
  for (let offset = target - 6; offset <= target + 6; offset += 1) {
    const text = readAscii(data, offset);
    if (text.length < 2) continue;
    const lower = text.toLowerCase();
    if (!lower.includes("init") && !lower.includes("main") && !lower.includes("label")) continue;
    nearby.push({
      start: hex(offset, 8),
      targetDelta: target - offset,
      text,
      containsTarget: offset <= target && target < offset + text.length,
    });
  }
  nearby.sort((a, b) => {
    const aExact = a.text.toLowerCase() === "init" || a.text.toLowerCase() === "_main" ? 0 : 1;
    const bExact = b.text.toLowerCase() === "init" || b.text.toLowerCase() === "_main" ? 0 : 1;
    return aExact - bExact || Math.abs(a.targetDelta) - Math.abs(b.targetDelta) || a.start.localeCompare(b.start);
  });
  const requested = normalizeRequestedLabel(caller.labelArg?.semanticLabel || nearby[0]?.text || exact);
  return {
    call: caller.callHex,
    helper: caller.targetHex,
    helperRole: caller.targetRole || "",
    target: caller.labelArg?.targetHex || "",
    exactTextAtTarget: exact,
    requestedLabel: requested,
    pointerDeltaToBestLabel: nearby[0]?.targetDelta ?? null,
    nearby: nearby.slice(0, 5),
  };
}

function symbolKind(slot) {
  const text = slot.leadingHit?.text || slot.visible || "";
  if (slot.leadingHit?.kind) return slot.leadingHit.kind;
  if (text === "INIT" || text === "_MAIN") return "label";
  return "slot";
}

function labelSlots(layoutScript, requestedLabels) {
  const wanted = new Set(requestedLabels);
  return (layoutScript?.lengthSlots || [])
    .map((slot) => ({
      text: slot.leadingHit?.text || slot.visible || "",
      visible: slot.visible || "",
      kind: symbolKind(slot),
      lengthOffset: parseHex(slot.offsetHex),
      payloadOffset: parseHex(slot.payloadOffsetHex),
      lengthOffsetHex: slot.offsetHex || "",
      payloadOffsetHex: slot.payloadOffsetHex || "",
    }))
    .filter((slot) => wanted.has(String(slot.text).toUpperCase()));
}

function labelValues(slot, starts) {
  const values = [
    ["absLen", slot.lengthOffset],
    ["absPayload", slot.payloadOffset],
    ["symbolRelLen", slot.lengthOffset - starts.symbol],
    ["symbolRelPayload", slot.payloadOffset - starts.symbol],
    ["textRelLen", slot.lengthOffset - starts.text],
    ["textRelPayload", slot.payloadOffset - starts.text],
    ["groupRelLen", slot.lengthOffset - starts.group],
    ["groupRelPayload", slot.payloadOffset - starts.group],
    ["low8Len", slot.lengthOffset & 0xff],
    ["low8Payload", slot.payloadOffset & 0xff],
    ["low16Len", slot.lengthOffset & 0xffff],
    ["low16Payload", slot.payloadOffset & 0xffff],
  ];
  return values.filter(([, value]) => Number.isFinite(value) && value >= 0);
}

function matchEntryRef(entry, slots, starts) {
  if (!Number.isFinite(entry.ref)) return [];
  const out = [];
  for (const slot of slots) {
    for (const [transform, value] of labelValues(slot, starts)) {
      if (value !== entry.ref) continue;
      out.push({
        label: slot.text,
        transform,
        strength: STRONG_TRANSFORMS.has(transform) ? "strong" : "weak",
        lengthOffset: slot.lengthOffsetHex,
        payloadOffset: slot.payloadOffsetHex,
      });
    }
  }
  return out;
}

function analyzeScript(script, layoutScript, requestedLabels) {
  const starts = {
    group: parseHex(script.groupEnd),
    text: parseHex(layoutScript?.zones?.textAndResourcePool?.start),
    symbol: parseHex(layoutScript?.zones?.labelAndSymbolPool?.start),
  };
  const slots = labelSlots(layoutScript, requestedLabels);
  const candidateRows = [];
  for (const candidate of script.tailCandidates || []) {
    const entries = (candidate.entries || []).map((entry) => {
      const matches = matchEntryRef(entry, slots, starts);
      return {
        index: entry.index,
        offset: entry.offset,
        groupCursor: entry.groupCursor,
        ref: entry.ref,
        safeUnderTrace: entry.run?.writebackRiskCount === 0,
        writebackRiskCount: entry.run?.writebackRiskCount ?? null,
        matches,
      };
    });
    const labelEntries = entries.filter((entry) => entry.matches.length);
    candidateRows.push({
      modes: candidate.modes || {},
      end: candidate.end || "",
      layoutDelta: candidate.layoutDelta ?? null,
      plausibleEntryCount: candidate.plausibleEntryCount || 0,
      safeEntryCount: candidate.safeEntryCount || 0,
      labelEntryCount: labelEntries.length,
      safeLabelEntryCount: labelEntries.filter((entry) => entry.safeUnderTrace).length,
      entries: labelEntries,
    });
  }
  const safeLabelCandidates = candidateRows.filter((candidate) => candidate.safeLabelEntryCount > 0);
  const unsafeLabelCandidates = candidateRows.filter((candidate) => candidate.labelEntryCount > 0 && candidate.safeLabelEntryCount === 0);
  const status = safeLabelCandidates.length
    ? "compare-label-safe"
    : unsafeLabelCandidates.length
    ? "compare-label-unsafe"
    : "compare-label-unmatched";
  return {
    name: script.name,
    executionMode: script.executionMode || "",
    status,
    starts: {
      groupEnd: hex(starts.group),
      textPool: hex(starts.text),
      symbolPool: hex(starts.symbol),
    },
    requestedLabels,
    labels: slots.map((slot) => ({
      text: slot.text,
      lengthOffset: slot.lengthOffsetHex,
      payloadOffset: slot.payloadOffsetHex,
      values: Object.fromEntries(labelValues(slot, starts).map(([name, value]) => [name, value])),
    })),
    safeLabelCandidateCount: safeLabelCandidates.length,
    unsafeLabelCandidateCount: unsafeLabelCandidates.length,
    bestSafeLabelCandidate: safeLabelCandidates[0] || null,
    bestUnsafeLabelCandidate: unsafeLabelCandidates[0] || null,
    candidates: candidateRows,
  };
}

function buildReport() {
  const entrypoint = readJson(ENTRYPOINT_JSON);
  const callers = readJson(ENTRY_CALLER_JSON);
  const layout = readJson(LAYOUT_JSON);
  const cbeInput = callers.input || entrypoint.input;
  const data = fs.existsSync(cbeInput) ? fs.readFileSync(cbeInput) : Buffer.alloc(0);
  const profiles = (callers.calls || [])
    .map((caller) => pointerProfile(data, caller))
    .filter((profile) => profile.requestedLabel);
  const requestedLabels = Array.from(new Set(profiles.map((profile) => profile.requestedLabel))).sort();
  const layoutByName = new Map((layout.scripts || []).map((script) => [script.name, script]));
  const scripts = (entrypoint.scripts || []).map((script) => analyzeScript(script, layoutByName.get(script.name), requestedLabels));
  const safe = scripts.filter((script) => script.status === "compare-label-safe");
  const unsafe = scripts.filter((script) => script.status === "compare-label-unsafe");
  const pointerDeltas = profiles.map((profile) => profile.pointerDeltaToBestLabel).filter((value) => value !== null);
  const nonZeroDeltas = pointerDeltas.filter((value) => value !== 0);
  return {
    schema: "nicai.cbe.xseEntryCompareProbe.v1",
    generatedAt: new Date().toISOString(),
    inputs: {
      entrypoint: ENTRYPOINT_JSON,
      entryCallers: ENTRY_CALLER_JSON,
      layout: LAYOUT_JSON,
      cbe: cbeInput,
    },
    summary: {
      status: safe.length ? "entry-compare-partial" : "entry-compare-unresolved",
      requestedLabels,
      scriptCount: scripts.length,
      safeLabelScripts: safe.map((script) => script.name),
      unsafeLabelScripts: unsafe.map((script) => script.name),
      callerPointerNonZeroDeltaCount: nonZeroDeltas.length,
      currentFinding: safe.length
        ? `${safe.length}/${scripts.length} focused scripts have a safe +0x64 entry whose record+0x10 matches a caller-requested label transform.`
        : `${unsafe.length}/${scripts.length} focused scripts have only unsafe caller-label matches, and ${scripts.length - safe.length - unsafe.length}/${scripts.length} have no caller-label match under current +0x64 modes.`,
      emulatorImpact: "0x12326 should be modeled as selecting Init/_main records, but no focused script is ready for visible effects until the compare service and ref width produce a safe label match.",
      nextTarget: "Reverse or emulate the [sb+0x35C4]+0x50 compare method well enough to normalize ADR label pointers and script+0x64 record+0x10 refs.",
    },
    callerLabelProfiles: profiles,
    scripts,
  };
}

function mdRow(cells) {
  return `| ${cells.map((cell) => String(cell ?? "").replace(/\|/g, "\\|")).join(" | ")} |`;
}

function renderEntry(entry) {
  const matches = entry.matches.map((match) => `${match.label}:${match.transform}@${match.lengthOffset}`).join(",");
  return `entry${entry.index} ref=${entry.ref} cursor=${entry.groupCursor} safe=${entry.safeUnderTrace ? "yes" : "no"} ${matches}`;
}

function renderCandidate(candidate) {
  if (!candidate) return "-";
  return `74=${candidate.modes.ref74Mode || "-"},64=${candidate.modes.ref64Mode || "-"} delta=${candidate.layoutDelta} ${candidate.entries.map(renderEntry).join("; ")}`;
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# XSE Entry Compare Probe");
  lines.push("");
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Status: ${report.summary.status}`);
  lines.push(`- Requested labels: ${report.summary.requestedLabels.join(", ") || "none"}`);
  lines.push(`- Finding: ${report.summary.currentFinding}`);
  lines.push(`- Emulator impact: ${report.summary.emulatorImpact}`);
  lines.push(`- Next target: ${report.summary.nextTarget}`);
  lines.push("");
  lines.push("## Caller Label Pointers");
  lines.push("");
  lines.push(mdRow(["Call", "Helper", "Requested", "ADR target", "Exact text", "Best delta", "Nearby"]));
  lines.push(mdRow(["---", "---", "---", "---", "---", "---:", "---"]));
  for (const profile of report.callerLabelProfiles) {
    lines.push(mdRow([
      profile.call,
      profile.helper,
      profile.requestedLabel,
      profile.target,
      profile.exactTextAtTarget || "-",
      profile.pointerDeltaToBestLabel ?? "-",
      profile.nearby.slice(0, 2).map((item) => `${item.start}:${item.text} delta=${item.targetDelta}`).join("; ") || "-",
    ]));
  }
  lines.push("");
  lines.push("## Script Label Binding");
  lines.push("");
  lines.push(mdRow(["Script", "Status", "Labels", "Safe label candidates", "Unsafe label candidates", "Best safe", "Best unsafe"]));
  lines.push(mdRow(["---", "---", "---", "---:", "---:", "---", "---"]));
  for (const script of report.scripts) {
    lines.push(mdRow([
      script.name,
      script.status,
      script.labels.map((label) => `${label.text}@${label.lengthOffset}/${label.payloadOffset}`).join(", "),
      script.safeLabelCandidateCount,
      script.unsafeLabelCandidateCount,
      renderCandidate(script.bestSafeLabelCandidate),
      renderCandidate(script.bestUnsafeLabelCandidate),
    ]));
  }
  for (const script of report.scripts) {
    lines.push("");
    lines.push(`### ${script.name}`);
    lines.push(`- Starts: groupEnd=${script.starts.groupEnd}, textPool=${script.starts.textPool}, symbolPool=${script.starts.symbolPool}`);
    for (const label of script.labels) {
      lines.push(`- ${label.text}: len=${label.lengthOffset}, payload=${label.payloadOffset}, symbolRel=${label.values.symbolRelLen ?? "-"}/${label.values.symbolRelPayload ?? "-"}, textRel=${label.values.textRelLen ?? "-"}/${label.values.textRelPayload ?? "-"}`);
    }
    for (const candidate of script.candidates.filter((item) => item.labelEntryCount > 0).slice(0, 6)) {
      lines.push(`- 74=${candidate.modes.ref74Mode || "-"},64=${candidate.modes.ref64Mode || "-"} end=${candidate.end} delta=${candidate.layoutDelta} labelEntries=${candidate.labelEntryCount}, safe=${candidate.safeLabelEntryCount}`);
      for (const entry of candidate.entries.slice(0, 4)) {
        lines.push(`  - ${renderEntry(entry)}`);
      }
    }
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

function main(argv = process.argv.slice(2)) {
  const outDir = path.resolve(argv[0] || DEFAULT_OUT);
  fs.mkdirSync(outDir, { recursive: true });
  const report = buildReport();
  const jsonFile = path.join(outDir, "xse_entry_compare_probe.json");
  const mdFile = path.join(outDir, "xse_entry_compare_probe.md");
  writeJson(jsonFile, report);
  fs.writeFileSync(mdFile, renderMarkdown(report), "utf8");
  console.log(`wrote ${jsonFile}`);
  console.log(`wrote ${mdFile}`);
  console.log(`${report.summary.status}: ${report.summary.currentFinding}`);
}

if (require.main === module) {
  main();
}

module.exports = {
  buildReport,
  renderMarkdown,
};
