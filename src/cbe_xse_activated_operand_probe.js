const fs = require("fs");
const path = require("path");
const { DEFAULT_INPUT, fixupPayload, loadCbeArchive } = require("./cbe_unpack");
const { decodeCompactToken, hexBytes } = require("./cbe_struct");

const ACTIVATED_DISPATCH_JSON = path.resolve(__dirname, "out_godwar_xseactivateddispatch", "xse_activated_dispatch_probe.json");
const SWITCH_REPLAY_JSON = path.resolve(__dirname, "out_godwar_xseswitchreplay", "xse_switch_replay_probe.json");
const DEFAULT_OUT = path.resolve(__dirname, "out_godwar_xseactivatedoperand");

const POINTER_TYPES = new Set([3, 4, 8]);

function hex(n, width = 4) {
  if (!Number.isFinite(n) || n < 0) return "";
  return `0x${n.toString(16).toUpperCase().padStart(width, "0")}`;
}

function byteHex(value) {
  return Number.isInteger(value) ? hex(value, 2) : "";
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
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

function read4C(buf, cursor, mode) {
  const start = cursor.value;
  if (mode === "compact") {
    const token = decodeCompactToken(buf, start);
    if (!token || token.truncated) return null;
    cursor.value = token.next;
    return {
      offset: hex(start),
      next: hex(token.next),
      width: token.next - start,
      value: token.value,
      raw: token.raw,
      tag: token.tag,
    };
  }
  if (start + 2 > buf.length) return null;
  const value = mode === "u16be" ? buf.readUInt16BE(start) : buf.readUInt16LE(start);
  cursor.value += 2;
  return {
    offset: hex(start),
    next: hex(cursor.value),
    width: 2,
    value,
    raw: hexBytes(buf.subarray(start, start + 2)),
    tag: mode,
  };
}

function parseHeaderCandidate(buf, start, mode, expectedFirstStart) {
  if (start < 0 || start >= buf.length) return null;
  const cursor = { value: start };
  const id = read4C(buf, cursor, mode);
  if (!id || cursor.value >= buf.length) return null;
  const countOffset = cursor.value;
  const recordCount = buf[countOffset];
  cursor.value += 1;
  const firstRecordStart = cursor.value;
  const firstOpcode = buf[firstRecordStart];
  return {
    start: hex(start),
    deltaFromExpected: start - expectedFirstStart,
    id,
    recordCount,
    recordCountRaw: byteHex(recordCount),
    firstRecordStart: hex(firstRecordStart),
    firstOpcode: byteHex(firstOpcode),
    firstOpcodePointerType: POINTER_TYPES.has(firstOpcode),
    sameFirstRecordStart: firstRecordStart === expectedFirstStart,
    directGroupId: Number.isInteger(id.value) && id.value >= 0 && id.value <= 0x20,
  };
}

function recordStartCandidates(buf, center, radius = 10) {
  const rows = [];
  for (let delta = -radius; delta <= radius; delta += 1) {
    const offset = center + delta;
    if (offset < 0 || offset >= buf.length) continue;
    const value = buf[offset];
    rows.push({
      offset: hex(offset),
      delta,
      opcode: byteHex(value),
      pointerType: POINTER_TYPES.has(value),
    });
  }
  return rows;
}

function rawWindow(buf, center, before = 12, after = 36) {
  const start = Math.max(0, center - before);
  const end = Math.min(buf.length, center + after);
  const rows = [];
  for (let offset = start; offset < end; offset += 16) {
    const slice = buf.subarray(offset, Math.min(end, offset + 16));
    rows.push(`${hex(offset)}  ${hexBytes(slice)}`);
  }
  return rows;
}

function summarizeRecords(records) {
  return (records || []).slice(0, 12).map((record) => ({
    index: record.recordIndex,
    start: record.startHex,
    end: record.endHex,
    opcode: record.opcode,
    opcodeHex: record.opcodeHex,
    highOpcode: Boolean(record.highOpcode),
    action: record.switchAction || "",
  }));
}

function buildReport() {
  const activated = readJson(ACTIVATED_DISPATCH_JSON);
  const switchReplay = readJson(SWITCH_REPLAY_JSON);
  const archive = loadCbeArchive(DEFAULT_INPUT);
  const switchByName = new Map((switchReplay.scripts || []).map((script) => [script.name, script]));
  const rows = [];

  for (const script of activated.scripts || []) {
    const dispatch = script.primaryDispatch;
    if (!dispatch?.writebackBlocked) continue;
    const switchScript = switchByName.get(script.name);
    const attempt = (switchScript?.attempts || []).find((item) => item.shortMode === dispatch.traceMode) || switchScript?.best || null;
    const group = (attempt?.groups || []).find((item) => item.index === dispatch.activatedCursor) || null;
    if (!switchScript || !attempt || !group) {
      rows.push({
        script: script.name,
        status: "activated-group-missing",
        dispatch,
      });
      continue;
    }

    const entry = findEntry(archive, switchScript.resource || script.name);
    const fixed = entry ? readResource(archive, entry) : null;
    const firstRecordStart = group.records?.[0]?.start ?? null;
    const headerStart = group.start;
    const headerCandidates = fixed && firstRecordStart != null
      ? Array.from({ length: 9 }, (_, index) => headerStart - 4 + index)
        .map((start) => parseHeaderCandidate(fixed, start, attempt.shortMode, firstRecordStart))
        .filter(Boolean)
      : [];
    const stableFirstStarts = headerCandidates
      .filter((item) => item.id.value === dispatch.groupId && item.recordCount === group.recordCount)
      .map((item) => item.firstRecordStart);
    const firstOpcode = fixed && firstRecordStart != null ? fixed[firstRecordStart] : null;
    const exactHeader = headerCandidates.find((item) => item.start === group.startHex) || null;
    const plusOneHeader = headerCandidates.find((item) => item.start === hex(group.start + 1)) || null;
    const boundaryStable = Boolean(
      exactHeader
      && firstOpcode === dispatch.operand0?.type
      && stableFirstStarts.includes(hex(firstRecordStart))
    );

    rows.push({
      script: script.name,
      status: boundaryStable ? "activated-operand0-boundary-stable" : "activated-operand0-boundary-open",
      traceMode: attempt.shortMode,
      group: {
        cursor: dispatch.activatedCursor,
        start: group.startHex,
        id: group.id?.value,
        idRaw: group.id?.raw,
        recordCount: group.recordCount,
        recordCountRaw: group.recordCountRaw,
        firstRecordStart: firstRecordStart == null ? "" : hex(firstRecordStart),
      },
      dispatch: {
        groupId: dispatch.groupId,
        target: dispatch.target,
        caseStatus: dispatch.caseStatus,
        operand0: dispatch.operand0,
        stackDelta: dispatch.stackDelta,
        stackSeedRelevant: Boolean(dispatch.stackSeedRelevant),
      },
      caseOperandContract: {
        target: "0x011ED4",
        readOperand0: "0x11EDA movs r1,#0; 0x11EDC add r0,sp,#0x158; 0x11EDE bl 0x11862",
        writebackOperand0: "0x11FD2 movs r0,#0; 0x11FD4 bl 0x11AE6",
        meaning: "the activated unary/value case reads and writes operand index 0; later pointer-looking records in the same group are not the destination",
      },
      headerCandidates,
      recordStartCandidates: fixed && firstRecordStart != null ? recordStartCandidates(fixed, firstRecordStart) : [],
      firstRecords: summarizeRecords(group.records),
      rawWindow: fixed && firstRecordStart != null ? rawWindow(fixed, firstRecordStart) : [],
      finding: boundaryStable
        ? `Activated group ${dispatch.groupId} first record is stable at ${hex(firstRecordStart)} with opcode ${byteHex(firstOpcode)}; the exact compact-id header and nearby one-byte id view do not move operand0.`
        : "Activated operand0 boundary remains open; inspect header candidates before promoting the trace.",
    });
  }

  const stableRows = rows.filter((row) => row.status === "activated-operand0-boundary-stable");
  return {
    schema: "nicai.cbe.xseActivatedOperandProbe.v1",
    generatedAt: new Date().toISOString(),
    inputs: {
      activatedDispatch: ACTIVATED_DISPATCH_JSON,
      switchReplay: SWITCH_REPLAY_JSON,
      input: DEFAULT_INPUT,
    },
    summary: {
      status: rows.length && rows.length === stableRows.length ? "activated-operand0-boundary-stable" : rows.length ? "activated-operand0-boundary-open" : "activated-operand0-not-needed",
      blockedPrimaryCount: rows.length,
      stableBoundaryCount: stableRows.length,
      currentFinding: rows.length
        ? `${stableRows.length}/${rows.length} activated writeback blocker(s) have a stable operand0 boundary. ${rows[0].finding}`
        : "No activated primary writeback blockers need operand boundary checks.",
      emulatorImpact: "This rules out a cheap alternate-operand-index fix for the current activated blocker; the generic VM still needs correct entry/ref binding or high-opcode/value record semantics before enabling effects.",
      nextTarget: "Recover the concrete +0x64 record+0x10 compare/ref encoding, then demote activated entries whose selected cursor reaches group-6/high-opcode identity writeback without a type 3/4/8 destination.",
    },
    rows,
  };
}

function mdRow(cells) {
  return `| ${cells.map((cell) => String(cell ?? "").replace(/\|/g, "\\|")).join(" | ")} |`;
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# XSE Activated Operand Probe");
  lines.push("");
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Status: ${report.summary.status}`);
  lines.push(`- Finding: ${report.summary.currentFinding}`);
  lines.push(`- Emulator impact: ${report.summary.emulatorImpact}`);
  lines.push(`- Next target: ${report.summary.nextTarget}`);
  lines.push("");
  lines.push("## Operand Boundary");
  lines.push("");
  lines.push(mdRow(["Script", "Group", "Header", "Operand0", "Stack seed", "Status", "Finding"]));
  lines.push(mdRow(["---", "---", "---", "---", "---", "---", "---"]));
  for (const row of report.rows) {
    lines.push(mdRow([
      row.script,
      `cursor=${row.group?.cursor} id=${row.group?.id} count=${row.group?.recordCount}`,
      `${row.group?.start} -> first ${row.group?.firstRecordStart}`,
      row.dispatch?.operand0 ? `${row.dispatch.operand0.typeHex}/${row.dispatch.operand0.pointerKind}` : "-",
      row.dispatch?.stackSeedRelevant ? "yes" : "no",
      row.status,
      row.finding,
    ]));
  }
  lines.push("");
  for (const row of report.rows) {
    lines.push(`## ${row.script} Window`);
    lines.push("");
    lines.push(`- Case operand contract: ${row.caseOperandContract?.meaning || "-"}`);
    lines.push(`- Read evidence: ${row.caseOperandContract?.readOperand0 || "-"}`);
    lines.push(`- Writeback evidence: ${row.caseOperandContract?.writebackOperand0 || "-"}`);
    lines.push("");
    lines.push("Header candidates:");
    lines.push("");
    lines.push(mdRow(["Start", "Id", "Count", "First record", "First opcode", "Same first"]));
    lines.push(mdRow(["---", "---", "---:", "---", "---", "---"]));
    for (const item of row.headerCandidates || []) {
      lines.push(mdRow([
        item.start,
        `${item.id.value} ${item.id.raw}`,
        item.recordCount,
        item.firstRecordStart,
        item.firstOpcode,
        item.sameFirstRecordStart ? "yes" : "no",
      ]));
    }
    lines.push("");
    if (row.rawWindow?.length) {
      lines.push("Raw window:");
      lines.push("");
      lines.push("```text");
      lines.push(...row.rawWindow);
      lines.push("```");
      lines.push("");
    }
  }
  return `${lines.join("\n")}\n`;
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

function main(argv = process.argv.slice(2)) {
  const outDir = path.resolve(argv[0] || DEFAULT_OUT);
  fs.mkdirSync(outDir, { recursive: true });
  const report = buildReport();
  const jsonFile = path.join(outDir, "xse_activated_operand_probe.json");
  const mdFile = path.join(outDir, "xse_activated_operand_probe.md");
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
