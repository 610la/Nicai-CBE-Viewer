const fs = require("fs");
const path = require("path");
const { DEFAULT_INPUT, fixupPayload, loadCbeArchive } = require("./cbe_unpack");
const { hexBytes, parseResourceEnvelope } = require("./cbe_struct");

const DEFAULT_OUT = path.resolve(__dirname, "out_godwar_xsestreamprep");
const VM_GATE_JSON = path.resolve(__dirname, "out_godwar_xsevmgate", "xse_vm_gate_probe.json");
const SLOT_AUDIT_JSON = path.resolve(__dirname, "out_godwar_xseslotaudit", "xse_slot_audit.json");
const FACADE_NORM_JSON = path.resolve(__dirname, "out_godwar_xsefacadenorm", "xse_facade_normalized_probe.json");
const FOCUS_RESOURCES = ["s_02.xse", "guangmingshendian.sce", "guangmingshendian.map"];

function hex(n, width = 4) {
  if (!Number.isFinite(n) || n < 0) return "";
  return `0x${n.toString(16).toUpperCase().padStart(width, "0")}`;
}

function cleanName(name) {
  return path.basename(String(name || "").replace(/\\/g, "/")).replace(/^[0-9]{4}_/, "");
}

function normalizeName(name) {
  return cleanName(name).toLowerCase();
}

function findEntry(archive, name) {
  const target = normalizeName(name);
  return archive.entries.find((entry) => normalizeName(entry.name) === target) || null;
}

function readResource(archive, entry) {
  const raw = archive.rawPayload(entry);
  const fixed = fixupPayload(entry.name, raw);
  return {
    raw,
    fixed: fixed.payload,
    fixupNote: fixed.note || "",
  };
}

function readU32LE(buf, offset) {
  if (offset < 0 || offset + 4 > buf.length) return null;
  return buf.readUInt32LE(offset);
}

function literalPoolEvidence(buf) {
  const pools = [
    { offset: 0x115F2, label: "0x112C4 reader service global" },
    { offset: 0x1160E, label: "0x112C4 stream conversion global" },
    { offset: 0x10BAA, label: "0x10800 SCE reader/open service global" },
    { offset: 0x10BAE, label: "0x10800 SCE stream conversion global" },
    { offset: 0xF5DA, label: "0xF224 reader service global" },
    { offset: 0xF5DE, label: "0xF224 stream conversion global" },
    { offset: 0x16172, label: "0x1607C reader/open service global" },
    { offset: 0x16176, label: "0x1607C stream conversion global" },
  ];
  return pools.map((pool) => ({
    ...pool,
    offsetHex: hex(pool.offset, 8),
    u32le: hex(readU32LE(buf, pool.offset), 4),
    bytes: hexBytes(buf.subarray(pool.offset, pool.offset + 4)),
  }));
}

function resourceEvidence(archive, name) {
  const entry = findEntry(archive, name);
  if (!entry) return { name, missing: true };
  const resource = readResource(archive, entry);
  const buf = resource.fixed;
  const envelope = parseResourceEnvelope(buf);
  const xseMagic = buf.indexOf(Buffer.from("XSE0", "ascii"));
  const sceMagic = buf.indexOf(Buffer.from("SCE2", "ascii"));
  return {
    name,
    archiveEntry: entry.name,
    size: buf.length,
    envelope: {
      tag: envelope.tag,
      bodyOffset: hex(envelope.bodyOffset),
      declaredBodyLength: envelope.declaredBodyLength,
      bodyLength: envelope.bodyLength,
      lengthMatches: envelope.lengthMatches,
    },
    prefixByteAtBody: buf.length > envelope.bodyOffset ? hex(buf[envelope.bodyOffset], 2) : "",
    magic: {
      xse0Offset: xseMagic >= 0 ? hex(xseMagic) : "",
      sce2Offset: sceMagic >= 0 ? hex(sceMagic) : "",
      magicOffset: xseMagic >= 0 ? hex(xseMagic) : (sceMagic >= 0 ? hex(sceMagic) : ""),
    },
    first32: hexBytes(buf.subarray(0, Math.min(32, buf.length))),
  };
}

function loadVmGate(file = VM_GATE_JSON) {
  try {
    const report = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      file,
      available: true,
      scripts: (report.scripts || []).map((script) => ({
        name: script.name,
        bases: script.streamPrepEvidence?.testedBaseCandidates || [],
      })),
    };
  } catch (err) {
    return {
      file,
      available: false,
      reason: err.message || String(err),
      scripts: [],
    };
  }
}

function loadSlotAudit(file = SLOT_AUDIT_JSON) {
  try {
    const report = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      file,
      available: true,
      currentBlocker: report.conclusion?.currentBlocker || "",
      newFalsification: report.conclusion?.newFalsification || "",
      nextTarget: report.conclusion?.nextTarget || "",
      plus50Rows: (report.slotWrites || [])
        .filter((row) => row.slot === 0x50)
        .map((row) => {
          const first = row.candidates?.[0] || null;
          return {
            store: hex(row.store, 8),
            base: row.base,
            bestTarget: first ? hex(first.thumb, 8) : "",
            bestStatus: first?.verdict?.status || "",
            bestReason: first?.verdict?.reason || "",
          };
        }),
    };
  } catch (err) {
    return {
      file,
      available: false,
      reason: err.message || String(err),
      plus50Rows: [],
    };
  }
}

function loadFacadeNormalized(file = FACADE_NORM_JSON) {
  try {
    const report = JSON.parse(fs.readFileSync(file, "utf8"));
    const summary = report.summary || [];
    return {
      file,
      available: true,
      looseStrict: summary.filter((row) => row.loose50Strict).length,
      looseAligned: summary.filter((row) => row.loose50Aligned).length,
      currentAligned: summary.filter((row) => row.current50Aligned).length,
      scriptCount: summary.length,
      rows: summary.map((row) => ({
        name: row.name,
        current50Aligned: Boolean(row.current50Aligned),
        loose50Strict: Boolean(row.loose50Strict),
        loose50Aligned: Boolean(row.loose50Aligned),
        bestLooseEnd: row.bestLooseEnd || "",
        layoutEnd: row.layoutEnd || "",
        bestLooseDelta: row.bestLooseDelta ?? null,
      })),
    };
  } catch (err) {
    return {
      file,
      available: false,
      reason: err.message || String(err),
      rows: [],
    };
  }
}

function buildReport(options = {}) {
  const input = path.resolve(options.input || DEFAULT_INPUT);
  const archive = loadCbeArchive(input);
  const vmGate = loadVmGate();
  const slotAudit = loadSlotAudit();
  const facadeNormalized = loadFacadeNormalized();
  return {
    schema: "nicai.cbe.xseStreamPrepTrace.v1",
    generatedAt: new Date().toISOString(),
    input,
    archiveEntryCount: archive.entries.length,
    literalPools: literalPoolEvidence(archive.buffer),
    chains: [
      {
        name: "XSE 0x112C4 stream prep",
        window: "0x112FE-0x11310",
        open: "[sb+0x35C4]+0x40",
        convert: "[sb+0x35C0]+0x50",
        resultRegister: "r4",
        cursorInit: 6,
        evidence: "After conversion, r4 is passed to [sb+0x35C4]+0x50 with cursor pointer sp+4. No direct XSE0 magic check is present in this window.",
      },
      {
        name: "SCE-style parser comparison",
        window: "0x10810-0x10846",
        open: "[sb+0x35C4]+0x40",
        convert: "[sb+0x35C0]+0x50",
        resultRegister: "r4",
        cursorInit: "caller offset; incremented by 4 when SCE2 is present",
        evidence: "The parser uses the same [0x35C4]+0x40 open plus [0x35C0]+0x50 conversion shape, then checks r4[0..3] == SCE2 immediately after conversion. Raw guangmingshendian.sce stores SCE2 at offset 0x0A, while the envelope body prefix is at 0x09.",
      },
      {
        name: "0xF224 resource parser comparison",
        window: "0xEEDC-0xF1C2",
        open: "[sb+0x35C4]+0x40",
        convert: "[sb+0x35C0]+0x50",
        resultRegister: "r6",
        cursorInit: 0,
        evidence: "This parser uses the same [0x35C4]+0x40 open plus [0x35C0]+0x50 conversion shape as XSE, then reads counts through [sb+0x35C4]+0x50/+0x64.",
      },
      {
        name: "0x1607C nested-table parser comparison",
        window: "0x1607C-0x16154",
        open: "[sb+0x35C4]+0x40",
        convert: "[sb+0x35C0]+0x50",
        resultRegister: "r6",
        cursorInit: 0,
        evidence: "This method-table parser repeats the same open/convert pair, reads a small matrix through [sb+0x35C4]+0x50, and closes the converted stream through [sb+0x35C4]+0x38.",
      },
    ],
    resources: FOCUS_RESOURCES.map((name) => resourceEvidence(archive, name)),
    vmGate,
    slotAudit,
    facadeNormalized,
    conclusion: {
      currentBlocker: "The stream-base question is narrower but not solved: XSE base 0x09 and XSE0 base 0x0A both fail the strict opcode gate under the current +0x50/+0x4C model, and facade-normalized loose +0x50 produces only shallow opcode-only paths.",
      nextTarget: "Resolve the shared [sb+0x35C4]+0x40 open and [sb+0x35C0]+0x50 conversion pair across XSE/SCE/sibling parsers, then replay 0x112C4 with the exact converted stream object and [sb+0x35C4]+0x50 cursor semantics.",
    },
  };
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

function mdRow(values) {
  return `| ${values.map((value) => String(value ?? "").replace(/\|/g, "\\|")).join(" | ")} |`;
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# XSE Stream Prep Trace");
  lines.push("");
  lines.push(`- Input CBE: \`${report.input}\``);
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push("");
  lines.push("## Current Conclusion");
  lines.push("");
  lines.push(`- ${report.conclusion.currentBlocker}`);
  lines.push(`- ${report.conclusion.nextTarget}`);
  lines.push("");
  lines.push("## Prep Chains");
  lines.push("");
  for (const chain of report.chains) {
    lines.push(`### ${chain.name}`);
    lines.push("");
    lines.push(`- Window: ${chain.window}`);
    lines.push(`- Open: ${chain.open}`);
    lines.push(`- Convert: ${chain.convert}`);
    lines.push(`- Result: ${chain.resultRegister}, cursor init: ${chain.cursorInit}`);
    lines.push(`- Evidence: ${chain.evidence}`);
    lines.push("");
  }
  lines.push("## Resource Offsets");
  lines.push("");
  lines.push(mdRow(["Resource", "Body", "Prefix", "Magic", "Length OK", "First bytes"]));
  lines.push(mdRow(["---", "---", "---", "---", "---", "---"]));
  for (const resource of report.resources) {
    const magic = resource.magic?.magicOffset || "";
    lines.push(mdRow([
      resource.name,
      resource.envelope?.bodyOffset || "",
      resource.prefixByteAtBody || "",
      magic,
      resource.envelope?.lengthMatches ?? "",
      resource.first32 || "",
    ]));
  }
  lines.push("");
  lines.push("## Literal Pools");
  lines.push("");
  for (const pool of report.literalPools) {
    lines.push(`- ${pool.offsetHex}: ${pool.label} -> ${pool.u32le} (${pool.bytes})`);
  }
  lines.push("");
  lines.push("## VM Gate Base Tests");
  lines.push("");
  if (!report.vmGate.available) {
    lines.push(`- VM gate report unavailable: ${report.vmGate.reason}`);
  } else {
    lines.push(mdRow(["Script", "Base", "Record Size", "Groups", "Strict", "Aligned", "Best", "Delta"]));
    lines.push(mdRow(["---", "---", "---:", "---:", "---", "---", "---", "---:"]));
    for (const script of report.vmGate.scripts) {
      for (const base of script.bases || []) {
        lines.push(mdRow([
          script.name,
          `${base.label} ${base.baseOffset}`,
          base.headerRecordByteSize,
          base.headerGroupCount,
          base.anyStrictOpcodePath,
          base.layoutAlignedStrictPath,
          base.bestEndOffset || "",
          base.bestLayoutDelta ?? "",
        ]));
      }
    }
  }
  lines.push("");
  lines.push("## Service Slot Audit");
  lines.push("");
  if (!report.slotAudit.available) {
    lines.push(`- Slot audit unavailable: ${report.slotAudit.reason}`);
  } else {
    lines.push(`- ${report.slotAudit.newFalsification}`);
    lines.push(`- ${report.slotAudit.nextTarget}`);
    lines.push("");
    lines.push(mdRow(["Store", "Base", "Best +0x50 target", "Status", "Reason"]));
    lines.push(mdRow(["---", "---", "---", "---", "---"]));
    for (const row of report.slotAudit.plus50Rows || []) {
      lines.push(mdRow([row.store, row.base, row.bestTarget, row.bestStatus, row.bestReason]));
    }
  }
  lines.push("");
  lines.push("## Facade-Normalized Gate Crosscheck");
  lines.push("");
  if (!report.facadeNormalized.available) {
    lines.push(`- Facade-normalized report unavailable: ${report.facadeNormalized.reason}`);
  } else {
    lines.push(`- Current +0x50 aligned paths: ${report.facadeNormalized.currentAligned}/${report.facadeNormalized.scriptCount}`);
    lines.push(`- Loose +0x50 shallow paths: ${report.facadeNormalized.looseStrict}/${report.facadeNormalized.scriptCount}`);
    lines.push(`- Loose +0x50 aligned paths: ${report.facadeNormalized.looseAligned}/${report.facadeNormalized.scriptCount}`);
    lines.push("");
    lines.push(mdRow(["Script", "Loose +0x50", "Best loose end", "Layout end", "Delta"]));
    lines.push(mdRow(["---", "---", "---", "---", "---:"]));
    for (const row of report.facadeNormalized.rows || []) {
      const result = row.loose50Aligned ? "aligned" : (row.loose50Strict ? "shallow" : "blocked");
      lines.push(mdRow([row.name, result, row.bestLooseEnd, row.layoutEnd, row.bestLooseDelta ?? ""]));
    }
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function main(argv = process.argv.slice(2)) {
  const input = path.resolve(argv[0] || DEFAULT_INPUT);
  const outDir = path.resolve(argv[1] || DEFAULT_OUT);
  fs.mkdirSync(outDir, { recursive: true });
  const report = buildReport({ input });
  const jsonFile = path.join(outDir, "xse_stream_prep_trace.json");
  const mdFile = path.join(outDir, "xse_stream_prep_trace.md");
  writeJson(jsonFile, report);
  fs.writeFileSync(mdFile, renderMarkdown(report), "utf8");
  console.log(`wrote ${jsonFile}`);
  console.log(`wrote ${mdFile}`);
}

if (require.main === module) {
  main();
}

module.exports = {
  buildReport,
  renderMarkdown,
};
