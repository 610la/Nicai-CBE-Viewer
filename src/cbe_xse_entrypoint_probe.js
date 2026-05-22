const fs = require("fs");
const path = require("path");
const { DEFAULT_INPUT, fixupPayload, loadCbeArchive } = require("./cbe_unpack");
const { decodeCompactToken, hexBytes } = require("./cbe_struct");

const SWITCH_REPLAY_JSON = path.resolve(__dirname, "out_godwar_xseswitchreplay", "xse_switch_replay_probe.json");
const RUNTIME_DISPATCH_JSON = path.resolve(__dirname, "out_godwar_xsedispatch", "xse_runtime_dispatch_probe.json");
const CASE_JSON = path.resolve(__dirname, "out_godwar_xsedispatchcases", "xse_dispatch_case_probe.json");
const OPERAND_BINDING_JSON = path.resolve(__dirname, "out_godwar_xseoperandbinding", "xse_operand_binding_probe.json");
const DEFAULT_OUT = path.resolve(__dirname, "out_godwar_xseentrypoint");

const REF_MODES = ["compact", "raw1", "raw2le", "raw2be", "raw3le", "raw3be", "raw4le", "raw4be", "fixed5", "fixed8"];
const WRITEBACK_TARGETS = new Set(["0x011D4C", "0x011ED4"]);
const POINTER_TYPES = new Set([3, 4, 8]);

const ENTRY_HELPER_CONTRACT = {
  entry: "0x012364",
  role: "external/script-label entry helper",
  selection: "0x12326 scans script+0x64 records and compares record+0x10 against the requested label/ref",
  activation: "0x11A4A copies the selected +0x64 record, adjusts +0x5C/+0x60 through 0x11252, restores record+0x00 into script+0x50, then 0x12364 calls 0x11C3C",
  emulatorImpact: "A true emulator must support label/tail entry selection; the trace-only cursor-0 walk is only the fresh scheduler hypothesis.",
};

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function hex(n, width = 4) {
  if (!Number.isFinite(n) || n < 0) return "";
  return `0x${n.toString(16).toUpperCase().padStart(width, "0")}`;
}

function byteHex(value) {
  return hex(value, 2);
}

function parseHex(text) {
  return typeof text === "string" && /^0x/i.test(text) ? parseInt(text, 16) : NaN;
}

function normalizeName(name) {
  return path.basename(String(name || "").replace(/\\/g, "/")).replace(/^[0-9]{4}_/, "").toLowerCase();
}

function findEntry(archive, name) {
  const target = normalizeName(name);
  return archive.entries.find((entry) => normalizeName(entry.name) === target) || null;
}

function readResource(archive, entry) {
  const raw = archive.rawPayload(entry);
  const fixed = fixupPayload(entry.name, raw);
  return fixed.payload;
}

function compactAt(buf, cursor, label, limit = 0x7fffffff) {
  const start = cursor.value;
  const token = decodeCompactToken(buf, start);
  if (!token || token.truncated || Math.abs(token.value) > limit) {
    throw new Error(`${label} compact read failed at ${hex(start)}`);
  }
  cursor.value = token.next;
  return {
    label,
    offset: start,
    offsetHex: hex(start),
    next: token.next,
    nextHex: hex(token.next),
    width: token.next - start,
    value: token.value,
    raw: token.raw,
    tag: token.tag,
  };
}

function raw8At(buf, cursor, label) {
  const start = cursor.value;
  if (start >= buf.length) throw new Error(`${label} raw8 read failed at ${hex(start)}`);
  cursor.value += 1;
  return {
    label,
    offset: start,
    offsetHex: hex(start),
    next: cursor.value,
    nextHex: hex(cursor.value),
    width: 1,
    value: buf[start],
    raw: byteHex(buf[start]),
    tag: "raw8",
  };
}

function refModeByteCount(mode) {
  if (mode === "compact") return 0;
  const fixed = mode.match(/^fixed(\d+)$/);
  if (fixed) return Number(fixed[1]);
  return ({ raw1: 1, raw2le: 2, raw2be: 2, raw3le: 3, raw3be: 3, raw4le: 4, raw4be: 4 }[mode] || 0);
}

function readRefMode(buf, cursor, mode, label) {
  if (mode === "compact") return compactAt(buf, cursor, label);
  const width = refModeByteCount(mode);
  const start = cursor.value;
  if (!width || start + width > buf.length) throw new Error(`${label} ${mode} failed at ${hex(start)}`);
  let value = null;
  if (mode === "raw1") value = buf[start];
  else if (mode === "raw2le") value = buf.readUInt16LE(start);
  else if (mode === "raw2be") value = buf.readUInt16BE(start);
  else if (mode === "raw3le") value = buf.readUIntLE(start, 3);
  else if (mode === "raw3be") value = buf.readUIntBE(start, 3);
  else if (mode === "raw4le") value = buf.readUInt32LE(start);
  else if (mode === "raw4be") value = buf.readUInt32BE(start);
  else value = null;
  cursor.value += width;
  return {
    label,
    offset: start,
    offsetHex: hex(start),
    next: cursor.value,
    nextHex: hex(cursor.value),
    width,
    value,
    raw: hexBytes(buf.subarray(start, start + width)),
    tag: mode,
  };
}

function parseTailEntries(buf, startOffset, modes) {
  const cursor = { value: startOffset };
  const steps = [];
  const warnings = [];
  let ok = true;
  let backfillCount = 0;
  let entryCount = 0;
  let finalRefCount = 0;
  const entries = [];

  try {
    const backfill = compactAt(buf, cursor, "0x115B8 opcode2 backfill +0x74 refs count", 256);
    backfillCount = backfill.value;
    steps.push({ label: backfill.label, offset: backfill.offsetHex, value: backfill.value, raw: backfill.raw, tag: backfill.tag });
    for (let index = 0; index < backfillCount; index += 1) {
      readRefMode(buf, cursor, modes.ref74Mode, `0x115B8 opcode2 backfill +0x74 refs[${index}]`);
    }

    const count = compactAt(buf, cursor, "0x11672 script+0x64 entry/range count", 256);
    entryCount = count.value;
    steps.push({ label: count.label, offset: count.offsetHex, value: count.value, raw: count.raw, tag: count.tag });
    for (let index = 0; index < entryCount; index += 1) {
      const start = compactAt(buf, cursor, "entry+00 group cursor");
      const kind = raw8At(buf, cursor, "entry+04 raw/kind");
      const span = compactAt(buf, cursor, "entry+08 opcode-stack span");
      const ref = readRefMode(buf, cursor, modes.ref64Mode, "entry+10 +0x64 label/ref");
      entries.push({
        index,
        offset: start.offsetHex,
        groupCursor: start.value,
        kind: kind.value,
        stackSpan: span.value,
        inclusiveEnd: kind.value + span.value + 1,
        ref: ref.value,
        raw: [start.raw, kind.raw, span.raw, ref.raw].join(" | "),
      });
    }

    const finalCount = compactAt(buf, cursor, "0x11752 final +0x64 refs count", 256);
    finalRefCount = finalCount.value;
    steps.push({ label: finalCount.label, offset: finalCount.offsetHex, value: finalCount.value, raw: finalCount.raw, tag: finalCount.tag });
    for (let index = 0; index < finalRefCount; index += 1) {
      readRefMode(buf, cursor, modes.ref64Mode, `0x11752 final +0x64 refs[${index}]`);
    }
  } catch (err) {
    ok = false;
    warnings.push(err.message || String(err));
  }

  return {
    modes,
    ok,
    start: startOffset,
    startHex: hex(startOffset),
    end: cursor.value,
    endHex: hex(cursor.value),
    consumed: cursor.value - startOffset,
    backfillCount,
    entryCount,
    finalRefCount,
    entries,
    steps,
    warnings,
  };
}

function targetForGroup(caseProbe, groupId) {
  for (const item of caseProbe.caseWindows || []) {
    if ((item.groupIds || []).includes(groupId)) return item.target;
  }
  return caseProbe.dispatcher?.primaryDefaultTarget || "0x011FE0";
}

function operand0Type(group) {
  return group?.records?.[0]?.opcode ?? null;
}

function groupWritebackRisk(group, caseProbe) {
  const groupId = group?.id?.value;
  const direct = Number.isInteger(groupId) && groupId >= 0 && groupId <= 0x20;
  const target = direct ? targetForGroup(caseProbe, groupId) : caseProbe.dispatcher?.primaryDefaultTarget || "0x011FE0";
  if (!WRITEBACK_TARGETS.has(target)) {
    return {
      target,
      writeback: false,
      risk: false,
      operand0Type: operand0Type(group),
      reason: direct ? "direct case has no value-op writeback" : "default group has no value-op writeback",
    };
  }
  const op0 = operand0Type(group);
  const resolves = POINTER_TYPES.has(op0);
  return {
    target,
    writeback: true,
    risk: !resolves,
    operand0Type: op0,
    reason: resolves ? "operand0 is a pointer-producing 3/4/8 type" : "operand0 is not a pointer-producing 3/4/8 type",
  };
}

function simulateFromCursor(groups, startCursor, caseProbe) {
  const steps = [];
  let cursor = startCursor;
  let active = true;
  while (active && cursor >= 0 && cursor < groups.length && steps.length < 32) {
    const group = groups[cursor];
    const risk = groupWritebackRisk(group, caseProbe);
    const groupId = group?.id?.value;
    steps.push({
      cursor,
      groupId,
      target: risk.target,
      writeback: risk.writeback,
      risk: risk.risk,
      operand0Type: risk.operand0Type,
      reason: risk.reason,
    });
    if (risk.target === "0x01223E") active = false;
    cursor += 1;
  }
  return {
    startCursor,
    steps,
    writebackRiskCount: steps.filter((step) => step.risk).length,
    writebackCount: steps.filter((step) => step.writeback).length,
    finalCursor: cursor,
    active,
  };
}

function scoreTail(tail, attempt, layoutEnd, caseProbe) {
  const groupCount = attempt.header?.groupCount ?? (attempt.groups || []).length;
  const layoutDelta = Number.isFinite(layoutEnd) ? tail.end - layoutEnd : null;
  const allEntryRuns = tail.entries.map((entry) => {
    const plausible = Number.isInteger(entry.groupCursor) && entry.groupCursor >= 0 && entry.groupCursor < groupCount;
    return {
      ...entry,
      plausible,
      run: plausible ? simulateFromCursor(attempt.groups || [], entry.groupCursor, caseProbe) : null,
    };
  });
  const entryRuns = allEntryRuns.filter((entry) => entry.plausible).map((entry) => ({
    ...entry,
  }));
  const safeEntries = entryRuns.filter((entry) => entry.run.writebackRiskCount === 0);
  const minRisk = entryRuns.length ? Math.min(...entryRuns.map((entry) => entry.run.writebackRiskCount)) : null;
  const score =
    (tail.ok ? 100 : -80)
    + entryRuns.length * 90
    + safeEntries.length * 60
    - (minRisk == null ? 30 : minRisk * 25)
    - Math.min(Math.abs(layoutDelta ?? 250), 250)
    - ((tail.modes.ref74Mode === "compact" ? 0 : 3) + (tail.modes.ref64Mode === "compact" ? 0 : 3));
  return {
    ...tail,
    layoutDelta,
    plausibleEntryCount: entryRuns.length,
    safeEntryCount: safeEntries.length,
    minEntryWritebackRisk: minRisk,
    allEntryRuns,
    entryRuns,
    score,
  };
}

function modeForScript(dispatch, name, fallback) {
  const row = (dispatch.scripts || []).find((script) => script.name === name);
  return row?.executionBest?.mode || row?.dispatchBest?.mode || fallback || "";
}

function formatEntryRun(entry) {
  return {
    index: entry.index,
    offset: entry.offset,
    groupCursor: entry.groupCursor,
    plausible: entry.plausible !== false,
    kind: entry.kind,
    stackSpan: entry.stackSpan,
    ref: entry.ref,
    raw: entry.raw,
    run: entry.run
      ? {
        writebackRiskCount: entry.run.writebackRiskCount,
        writebackCount: entry.run.writebackCount,
        firstSteps: entry.run.steps.slice(0, 6),
      }
      : null,
  };
}

function buildScriptReport(script, dispatch, caseProbe, archive, options = {}) {
  const entry = findEntry(archive, script.resource || script.name);
  const buf = entry ? readResource(archive, entry) : null;
  const fallback = script.best?.shortMode || "";
  const executionMode = modeForScript(dispatch, script.name, fallback);
  const attempt = (script.attempts || []).find((item) => item.ok && item.shortMode === executionMode) || script.best || null;
  if (!buf || !attempt) {
    return {
      name: script.name,
      executionMode,
      status: "missing-resource-or-attempt",
      tailCandidates: [],
    };
  }
  const layoutEnd = parseHex(script.layoutHint?.objectEnd);
  const groupEnd = attempt.groupEnd ?? parseHex(attempt.groupEndHex);
  const candidates = [];
  for (const ref74Mode of REF_MODES) {
    for (const ref64Mode of REF_MODES) {
      const tail = parseTailEntries(buf, groupEnd, { ref74Mode, ref64Mode });
      candidates.push(scoreTail(tail, attempt, layoutEnd, caseProbe));
    }
  }
  candidates.sort((a, b) => b.score - a.score || Math.abs(a.layoutDelta ?? 0) - Math.abs(b.layoutDelta ?? 0));
  const candidateLimit = Number.isInteger(options.candidateLimit) ? options.candidateLimit : 12;
  const top = candidates.slice(0, candidateLimit).map((candidate) => ({
    modes: candidate.modes,
    ok: candidate.ok,
    start: candidate.startHex,
    end: candidate.endHex,
    layoutDelta: candidate.layoutDelta,
    backfillCount: candidate.backfillCount,
    entryCount: candidate.entryCount,
    finalRefCount: candidate.finalRefCount,
    plausibleEntryCount: candidate.plausibleEntryCount,
    safeEntryCount: candidate.safeEntryCount,
    minEntryWritebackRisk: candidate.minEntryWritebackRisk,
    score: candidate.score,
    entryScanCoverage: options.includeAllEntries ? "all-records" : "plausible-sample",
    entries: (options.includeAllEntries ? candidate.allEntryRuns : candidate.entryRuns.slice(0, 8)).map(formatEntryRun),
    warnings: candidate.warnings,
  }));
  const best = top[0] || null;
  return {
    name: script.name,
    executionMode,
    groupCount: attempt.header?.groupCount ?? (attempt.groups || []).length,
    groupIds: (attempt.groups || []).map((group) => group.id?.value),
    groupEnd: attempt.groupEndHex,
    layoutEnd: script.layoutHint?.objectEnd || "",
    status: best?.plausibleEntryCount ? "entry-candidates-found" : "entry-tail-binding-unresolved",
    bestEntry: best,
    tailCandidates: top,
  };
}

function buildReport(options = {}) {
  const input = path.resolve(options.input || DEFAULT_INPUT);
  const archive = loadCbeArchive(input);
  const switchReplay = readJson(SWITCH_REPLAY_JSON);
  const dispatch = readJson(RUNTIME_DISPATCH_JSON);
  const caseProbe = readJson(CASE_JSON);
  const operandBinding = readJson(OPERAND_BINDING_JSON);
  const scripts = (switchReplay.scripts || []).map((script) => buildScriptReport(script, dispatch, caseProbe, archive, options));
  const scriptsWithEntries = scripts.filter((script) => script.bestEntry?.plausibleEntryCount > 0);
  const scriptsWithSafeEntries = scripts.filter((script) => script.bestEntry?.safeEntryCount > 0);
  return {
    schema: "nicai.cbe.xseEntrypointProbe.v1",
    generatedAt: new Date().toISOString(),
    input,
    inputs: {
      switchReplay: SWITCH_REPLAY_JSON,
      runtimeDispatch: RUNTIME_DISPATCH_JSON,
      caseProbe: CASE_JSON,
      operandBinding: OPERAND_BINDING_JSON,
    },
    entryHelperContract: ENTRY_HELPER_CONTRACT,
    summary: {
      status: scriptsWithEntries.length ? "entrypoint-candidates-found" : "entrypoint-tail-binding-unresolved",
      scriptCount: scripts.length,
      scriptsWithPlausibleEntries: scriptsWithEntries.map((script) => script.name),
      scriptsWithSafeEntries: scriptsWithSafeEntries.map((script) => script.name),
      currentFinding: scriptsWithEntries.length
        ? `${scriptsWithEntries.length}/${scripts.length} focused scripts have at least one +0x64 entry candidate whose field+0x00 is a plausible group cursor; ${scriptsWithSafeEntries.length} have a candidate that avoids current writeback risks under the trace model.`
        : `No focused script has a top-ranked +0x64 tail parse whose entry field+0x00 is a plausible group cursor; the 0x12364/0x11A4A label-entry path is real, but +0x64/+0x74 reader binding is still unresolved.`,
      emulatorImpact: "A generic emulator should enter scripts through the label/tail entry helper when callers provide a label/ref, not by forcing cursor 0. Current tail parsing is not yet strong enough to replace the cursor-0 trace.",
      nextTarget: scriptsWithEntries.length
        ? "Use entry candidates as execution hypotheses and cross-check their label refs against script symbol pools and caller strings before enabling effects."
        : "Bind +0x64/+0x74 tail reader semantics and symbol/ref pools so 0x12364 can select real script entry records.",
      operandBindingFinding: operandBinding.summary?.currentFinding || "",
    },
    scripts,
  };
}

function mdRow(cells) {
  return `| ${cells.map((cell) => String(cell ?? "").replace(/\|/g, "\\|")).join(" | ")} |`;
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# XSE Entrypoint Probe");
  lines.push("");
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Input CBE: \`${report.input}\``);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Status: ${report.summary.status}`);
  lines.push(`- Finding: ${report.summary.currentFinding}`);
  lines.push(`- Emulator impact: ${report.summary.emulatorImpact}`);
  lines.push(`- Next target: ${report.summary.nextTarget}`);
  lines.push(`- Operand binding context: ${report.summary.operandBindingFinding}`);
  lines.push("");
  lines.push("## Entry Helper Contract");
  lines.push("");
  lines.push(`- ${report.entryHelperContract.entry}: ${report.entryHelperContract.role}.`);
  lines.push(`- Selection: ${report.entryHelperContract.selection}.`);
  lines.push(`- Activation: ${report.entryHelperContract.activation}.`);
  lines.push("");
  lines.push(mdRow(["Script", "Mode", "Groups", "Best tail", "Entry candidates", "Safe entries", "Min risk", "Status"]));
  lines.push(mdRow(["---", "---", "---", "---", "---:", "---:", "---:", "---"]));
  for (const script of report.scripts) {
    const best = script.bestEntry || {};
    lines.push(mdRow([
      script.name,
      script.executionMode,
      script.groupIds?.join(",") || "",
      best.modes ? `${best.end} delta=${best.layoutDelta} 74=${best.modes.ref74Mode}/64=${best.modes.ref64Mode}` : "-",
      best.plausibleEntryCount ?? 0,
      best.safeEntryCount ?? 0,
      best.minEntryWritebackRisk ?? "-",
      script.status,
    ]));
  }
  for (const script of report.scripts) {
    lines.push("");
    lines.push(`### ${script.name}`);
    for (const candidate of script.tailCandidates.slice(0, 5)) {
      lines.push(`- modes 74=${candidate.modes.ref74Mode},64=${candidate.modes.ref64Mode}: ok=${candidate.ok}, end=${candidate.end}, delta=${candidate.layoutDelta}, entries=${candidate.plausibleEntryCount}/${candidate.entryCount}, safe=${candidate.safeEntryCount}, minRisk=${candidate.minEntryWritebackRisk ?? "-"}, finalRefs=${candidate.finalRefCount}, score=${candidate.score}${candidate.warnings.length ? `, warn=${candidate.warnings.join("; ")}` : ""}`);
      for (const entry of candidate.entries.slice(0, 4)) {
        const run = entry.run.firstSteps.map((step) => `${step.cursor}:${step.groupId}->${step.target}${step.risk ? "/risk" : ""}`).join(" ");
        lines.push(`  - entry${entry.index}@${entry.offset}: cursor=${entry.groupCursor}, kind=${entry.kind}, span=${entry.stackSpan}, ref=${entry.ref}, risk=${entry.run.writebackRiskCount}/${entry.run.writebackCount}, run=${run}`);
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
  const input = path.resolve(argv[0] || DEFAULT_INPUT);
  const outDir = path.resolve(argv[1] || DEFAULT_OUT);
  fs.mkdirSync(outDir, { recursive: true });
  const report = buildReport({ input });
  const jsonFile = path.join(outDir, "xse_entrypoint_probe.json");
  const mdFile = path.join(outDir, "xse_entrypoint_probe.md");
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
