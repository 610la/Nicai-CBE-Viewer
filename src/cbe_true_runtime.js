const fs = require("fs");
const path = require("path");
const {
  DEFAULT_INPUT,
  fixupPayload,
  loadCbeArchive,
  sanitizeName,
} = require("./cbe_unpack");
const { buildWireProbe } = require("./cbe_xse_wire_probe");
const {
  asciiRuns,
  probe112C4ResourceBuffer,
  scanLengthPrefixedRefs,
  scanTextRuns,
  summarizeBuffer,
} = require("./cbe_struct");

const DEFAULT_SCENE = "guangmingshendian.sce";
const DEFAULT_OUT = path.resolve(__dirname, "out_godwar_true_runtime");
const HANDLER_JSON = path.resolve(__dirname, "out_godwar_scripthandlers", "script_handler_trace.json");
const READER_SERVICE_JSON = path.resolve(__dirname, "out_godwar_xsereader", "xse_reader_service_trace.json");
const VM_GATE_JSON = path.resolve(__dirname, "out_godwar_xsevmgate", "xse_vm_gate_probe.json");
const STREAM_PREP_JSON = path.resolve(__dirname, "out_godwar_xsestreamprep", "xse_stream_prep_trace.json");
const STREAM_SERVICE_JSON = path.resolve(__dirname, "out_godwar_xsestreamsvc", "xse_stream_service_trace.json");
const SLOT_AUDIT_JSON = path.resolve(__dirname, "out_godwar_xseslotaudit", "xse_slot_audit.json");
const SERVICE_LIFECYCLE_JSON = path.resolve(__dirname, "out_godwar_xseservicelife", "xse_service_lifecycle.json");
const LOADER_CALLERS_JSON = path.resolve(__dirname, "out_godwar_xseloadercallers", "xse_loader_callers.json");
const WRAPPER_FACADE_JSON = path.resolve(__dirname, "out_godwar_xsewrapperfacade", "xse_wrapper_facade_trace.json");
const FACADE_SLOTS_JSON = path.resolve(__dirname, "out_godwar_xsefacadeslots", "xse_facade_slot_trace.json");
const MANAGER_ROOT_JSON = path.resolve(__dirname, "out_godwar_xsemanagerroot", "xse_manager_root_trace.json");
const FACADE_EQUIV_JSON = path.resolve(__dirname, "out_godwar_xsefacadeequiv", "xse_facade_equivalence.json");
const FACADE_NORM_JSON = path.resolve(__dirname, "out_godwar_xsefacadenorm", "xse_facade_normalized_probe.json");
const PROVIDER_SERVICE_JSON = path.resolve(__dirname, "out_godwar_xseprovidersvc", "xse_provider_service_trace.json");
const PROVIDER_REPLAY_JSON = path.resolve(__dirname, "out_godwar_providerreplay", "provider_service_replay_probe.json");
const CURSOR50_VARIANTS_JSON = path.resolve(__dirname, "out_godwar_cursor50variants", "cursor50_variant_probe.json");
const PROVIDER_ABI_JSON = path.resolve(__dirname, "out_godwar_providerabi", "provider_abi_trace.json");
const PROVIDER_ABI_SHIM_JSON = path.resolve(__dirname, "out_godwar_providerabishim", "provider_abi_shim_probe.json");
const XSE_SWITCH_REPLAY_JSON = path.resolve(__dirname, "out_godwar_xseswitchreplay", "xse_switch_replay_probe.json");
const XSE_RUNTIME_DISPATCH_JSON = path.resolve(__dirname, "out_godwar_xsedispatch", "xse_runtime_dispatch_probe.json");
const XSE_DISPATCH_CASES_JSON = path.resolve(__dirname, "out_godwar_xsedispatchcases", "xse_dispatch_case_probe.json");
const XSE_TRACE_VM_JSON = path.resolve(__dirname, "out_godwar_xsetracevm", "xse_trace_vm_probe.json");
const XSE_WRITEBACK_JSON = path.resolve(__dirname, "out_godwar_xsewriteback", "xse_writeback_probe.json");
const XSE_CURSOR_INIT_JSON = path.resolve(__dirname, "out_godwar_xsecursorinit", "xse_cursor_init_probe.json");
const XSE_SLOT_LIFECYCLE_JSON = path.resolve(__dirname, "out_godwar_xseslotlifecycle", "xse_slot_lifecycle_probe.json");
const XSE_OPERAND_BINDING_JSON = path.resolve(__dirname, "out_godwar_xseoperandbinding", "xse_operand_binding_probe.json");
const XSE_ENTRYPOINT_JSON = path.resolve(__dirname, "out_godwar_xseentrypoint", "xse_entrypoint_probe.json");
const XSE_ENTRY_LABEL_JSON = path.resolve(__dirname, "out_godwar_xseentrylabels", "xse_entry_label_probe.json");
const XSE_ENTRY_CALLER_JSON = path.resolve(__dirname, "out_godwar_xseentrycallers", "xse_entry_caller_probe.json");
const XSE_ENTRY_COMPARE_JSON = path.resolve(__dirname, "out_godwar_xseentrycompare", "xse_entry_compare_probe.json");
const XSE_LABEL_POINTER_JSON = path.resolve(__dirname, "out_godwar_xselabelpointer", "xse_label_pointer_probe.json");
const XSE_REF_ENCODING_JSON = path.resolve(__dirname, "out_godwar_xserefencoding", "xse_ref_encoding_probe.json");
const XSE_COMPARE_NORMALIZATION_JSON = path.resolve(__dirname, "out_godwar_xsecomparenormalization", "xse_compare_normalization_probe.json");
const XSE_TAIL_BOUNDARY_JSON = path.resolve(__dirname, "out_godwar_xsetailboundary", "xse_tail_boundary_probe.json");
const XSE_COMPARE_SERVICE_JSON = path.resolve(__dirname, "out_godwar_xsecomparesvc", "xse_compare_service_probe.json");
const XSE_COMPARE_SHIM_JSON = path.resolve(__dirname, "out_godwar_xsecompareshim", "xse_compare_shim_probe.json");
const XSE_ACTIVATION_JSON = path.resolve(__dirname, "out_godwar_xseactivation", "xse_activation_probe.json");
const XSE_ACTIVATED_DISPATCH_JSON = path.resolve(__dirname, "out_godwar_xseactivateddispatch", "xse_activated_dispatch_probe.json");
const XSE_ACTIVATED_OPERAND_JSON = path.resolve(__dirname, "out_godwar_xseactivatedoperand", "xse_activated_operand_probe.json");
const XSE_HIGH_OPCODE_JSON = path.resolve(__dirname, "out_godwar_xsehighopcode", "xse_high_opcode_probe.json");
const XSE_ENTRY_SAFETY_JSON = path.resolve(__dirname, "out_godwar_xseentrysafety", "xse_entry_safety_probe.json");
const XSE_REF_WIDTH_SAFETY_JSON = path.resolve(__dirname, "out_godwar_xserefwidthsafety", "xse_ref_width_safety_probe.json");
const XSE_COMPARE_ABI_JSON = path.resolve(__dirname, "out_godwar_xsecompareabi", "xse_compare_abi_probe.json");
const XSE_REF_NAMESPACE_JSON = path.resolve(__dirname, "out_godwar_xserefnamespace", "xse_ref_namespace_probe.json");
const XSE_REF64_LOADER_JSON = path.resolve(__dirname, "out_godwar_xseref64loader", "xse_ref64_loader_probe.json");
const PROVIDER_REF_CONTEXT_JSON = path.resolve(__dirname, "out_godwar_providerrefcontext", "provider_ref_context_probe.json");
const XSE_COMPARE_RESOLVER_JSON = path.resolve(__dirname, "out_godwar_xsecompareresolver", "xse_compare_resolver_boundary_probe.json");
const PROVIDER_RESOLVER_HOOK_JSON = path.resolve(__dirname, "out_godwar_providerresolverhook", "provider_resolver_hook_probe.json");
const PROVIDER35C4_TAPE_JSON = path.resolve(__dirname, "out_godwar_provider35c4tape", "provider35c4_tape_probe.json");
const PROVIDER35C4_FEED_JSON = path.resolve(__dirname, "out_godwar_provider35c4feed", "provider35c4_feed_probe.json");
const PROVIDER35C4_CAPTURE_JSON = path.resolve(__dirname, "out_godwar_provider35c4capture", "provider35c4_capture_plan_probe.json");
const PROVIDER35C4_CAPTURE_SOURCE_JSON = path.resolve(__dirname, "out_godwar_provider35c4source", "provider35c4_capture_source_probe.json");
const PROVIDER35C4_EMULATED_SOURCE_JSON = path.resolve(__dirname, "out_godwar_provider35c4emu", "provider35c4_emulated_source_probe.json");
const PROVIDER35C4_SERVICE_OBJECT_JSON = path.resolve(__dirname, "out_godwar_provider35c4svcobj", "provider35c4_service_object_probe.json");
const PROVIDER35C4_SERVICE_RESOLVER_JSON = path.resolve(__dirname, "out_godwar_provider35c4svcresolver", "provider35c4_service_resolver_probe.json");
const PROVIDER35C4_LIVE_CALL_JSON = path.resolve(__dirname, "out_godwar_provider35c4livecall", "provider35c4_live_call_probe.json");
const PROVIDER35C4_STREAM_EXECUTOR_JSON = path.resolve(__dirname, "out_godwar_provider35c4streamexec", "provider35c4_stream_executor_probe.json");
const PROVIDER35C4_TABLE_WALK_JSON = path.resolve(__dirname, "out_godwar_provider35c4tablewalk", "provider35c4_table_walk_probe.json");
const PROVIDER35C4_COUNT_MODE_JSON = path.resolve(__dirname, "out_godwar_provider35c4countmode", "provider35c4_count_mode_probe.json");
const PROVIDER35C4_S02_SOURCE_JSON = path.resolve(__dirname, "out_godwar_provider35c4s02source", "provider35c4_s02_source_mode_probe.json");
const PROVIDER35C4_SELECTED_TABLE_JSON = path.resolve(__dirname, "out_godwar_provider35c4selectedtable", "provider35c4_selected_table_walk_probe.json");
const PROVIDER35C4_SELECTED_FEED_JSON = path.resolve(__dirname, "out_godwar_provider35c4selectedfeed", "provider35c4_selected_feed_probe.json");
const PROVIDER35C4_PROMOTION_FRONTIER_JSON = path.resolve(__dirname, "out_godwar_provider35c4frontier", "provider35c4_promotion_frontier_probe.json");
const PROVIDER35C4_FRONTIER_MODE_SCAN_JSON = path.resolve(__dirname, "out_godwar_provider35c4frontiermodes", "provider35c4_frontier_mode_scan_probe.json");
const PROVIDER35C4_RETURN0_PRIORITY_JSON = path.resolve(__dirname, "out_godwar_provider35c4return0priority", "provider35c4_return0_priority_probe.json");
const PROVIDER35C4_RETURN0_INJECTION_JSON = path.resolve(__dirname, "out_godwar_provider35c4return0inject", "provider35c4_return0_injection_probe.json");
const PROVIDER35C4_RETURN0_CAPTURE_JSON = path.resolve(__dirname, "out_godwar_provider35c4return0capture", "provider35c4_return0_capture_adapter_probe.json");
const PROVIDER35C4_CAPTURED_FEED_JSON = path.resolve(__dirname, "out_godwar_provider35c4capturedfeed", "provider35c4_captured_selected_feed_probe.json");
const PROVIDER35C4_OBSERVATION_RECORDER_JSON = path.resolve(__dirname, "out_godwar_provider35c4recorder", "provider35c4_observation_recorder_probe.json");
const PROVIDER35C4_RUNTIME_SINK_JSON = path.resolve(__dirname, "out_godwar_provider35c4runtimesink", "provider35c4_runtime_sink_probe.json");
const CBE_RUNTIME_CORE_JSON = path.resolve(__dirname, "out_cbe_runtime_core", "cbe_runtime_core_probe.json");
const CBE_RUNTIME_CORE_SCENE_JSON = path.resolve(__dirname, "out_cbe_runtime_core_scene", "cbe_runtime_core_scene_probe.json");
const COPY_HELPER_JSON = path.resolve(__dirname, "out_godwar_copyhelper", "copy_helper_probe.json");
const BOOT_RESOURCE_HINTS = [
  "fengmian.gif",
  "loading.gif",
  "s_01.xse",
  "s_02.xse",
  "s_03.xse",
  "s_04.xse",
];

function hex(n, width = 0) {
  if (!Number.isFinite(n) || n < 0) return "";
  return `0x${n.toString(16).toUpperCase().padStart(width, "0")}`;
}

function cleanEntryName(name) {
  return path.basename(String(name || "").replace(/\\/g, "/")).replace(/^[0-9]{4}_/, "");
}

function normalizeName(name) {
  return cleanEntryName(name).toLowerCase();
}

function extOf(name) {
  return path.extname(name || "").toLowerCase();
}

function relForEntry(entry) {
  return [
    `section_${entry.section}_${entry.sectionOffset.toString(16).toUpperCase()}`,
    `${String(entry.index).padStart(4, "0")}_${sanitizeName(entry.name)}`,
  ].join("/");
}

function findEntry(archive, name) {
  const target = normalizeName(name);
  return archive.entries.find((entry) => normalizeName(entry.name) === target) || null;
}

function buildCatalog(archive) {
  return archive.entries.map((entry) => ({
    name: entry.name,
    cleanName: cleanEntryName(entry.name),
    rel: relForEntry(entry),
    ext: extOf(entry.name),
    rawCbe: true,
    section: entry.section,
    index: entry.index,
    offset: entry.offsetHex,
    end: entry.endHex,
  }));
}

function extensionCounts(entries) {
  const counts = {};
  for (const entry of entries) {
    const ext = extOf(entry.name) || "(none)";
    counts[ext] = (counts[ext] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => a[0].localeCompare(b[0])));
}

function parseGifInfoBuffer(buf) {
  if (!buf || buf.length < 13 || buf.subarray(0, 3).toString("ascii") !== "GIF") return null;
  try {
    let offset = 6;
    const width = buf.readUInt16LE(offset);
    const height = buf.readUInt16LE(offset + 2);
    const packed = buf[offset + 4];
    offset += 7;
    if (packed & 0x80) offset += 3 * (1 << ((packed & 0x07) + 1));

    let graphicControls = 0;
    const imageDescriptors = [];
    while (offset < buf.length) {
      const block = buf[offset++];
      if (block === 0x3b) break;
      if (block === 0x21) {
        const label = buf[offset++];
        if (label === 0xf9) graphicControls += 1;
        while (offset < buf.length) {
          const size = buf[offset++];
          if (!size) break;
          offset += size;
        }
        continue;
      }
      if (block === 0x2c && offset + 8 < buf.length) {
        const x = buf.readUInt16LE(offset);
        const y = buf.readUInt16LE(offset + 2);
        const frameWidth = buf.readUInt16LE(offset + 4);
        const frameHeight = buf.readUInt16LE(offset + 6);
        const imagePacked = buf[offset + 8];
        offset += 9;
        if (imagePacked & 0x80) offset += 3 * (1 << ((imagePacked & 0x07) + 1));
        offset += 1;
        while (offset < buf.length) {
          const size = buf[offset++];
          if (!size) break;
          offset += size;
        }
        imageDescriptors.push({ x, y, width: frameWidth, height: frameHeight });
        continue;
      }
      break;
    }
    return {
      width,
      height,
      frames: imageDescriptors.length,
      graphicControls,
      imageDescriptors: imageDescriptors.slice(0, 8),
      sheetLike: imageDescriptors.length === 1,
    };
  } catch {
    return null;
  }
}

function publicEntry(entry) {
  return {
    name: entry.name,
    rel: relForEntry(entry),
    section: entry.section,
    index: entry.index,
    offset: entry.offsetHex,
    end: entry.endHex,
    rawSize: entry.size,
    ext: extOf(entry.name),
  };
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

function summarizeResourceFromCbe(archive, catalog, entry) {
  const resource = readResource(archive, entry);
  return {
    ...publicEntry(entry),
    fixedSize: resource.fixed.length,
    fixupNote: resource.fixupNote,
    summary: summarizeBuffer(entry.name, resource.fixed, {
      catalog,
      source: "raw-cbe",
    }),
  };
}

function strictXseProbe(archive, entry) {
  const resource = readResource(archive, entry);
  const probe = probe112C4ResourceBuffer(resource.fixed, { resourceName: entry.name });
  const best = probe.best || {};
  const invalidOpcodes = (best.opcodeHistogram || [])
    .map((item) => ({ opcode: Number(item.key), count: item.count }))
    .filter((item) => !Number.isInteger(item.opcode) || item.opcode < 0 || item.opcode > 8);
  const warningText = (best.warnings || []).join("; ");
  const ok =
    probe.confidence === "high" &&
    best.ok === true &&
    best.groupCount > 0 &&
    best.parsedGroupCount === best.groupCount &&
    best.totalRecords > 0 &&
    best.knownOpcodePercent === 100 &&
    invalidOpcodes.length === 0 &&
    !/implausible|truncated|budget exceeded/i.test(warningText);

  const reason = ok
    ? "passes strict 0x112C4 object-table guard; still needs command/operand execution binding"
    : [
      probe.confidence !== "high" ? `probe confidence=${probe.confidence || "unknown"}` : "",
      best.knownOpcodePercent !== 100 ? `known opcode percent=${best.knownOpcodePercent ?? "unknown"}` : "",
      invalidOpcodes.length ? `invalid opcodes=${invalidOpcodes.map((item) => `${item.opcode}:${item.count}`).join(",")}` : "",
      warningText ? `warnings=${warningText}` : "",
      best.totalRecords ? "" : "no object records",
    ].filter(Boolean).join("; ");

  return {
    ...publicEntry(entry),
    fixedSize: resource.fixed.length,
    fixupNote: resource.fixupNote,
    strictStatus: ok ? "object-table-candidate" : "blocked",
    strictReason: reason || "probe did not satisfy strict executable-object constraints",
    objectProbe: {
      confidence: probe.confidence,
      magic: probe.magic,
      envelope: probe.envelope,
      best: best ? {
        score: best.score,
        ok: best.ok,
        reader: best.groupIdReader,
        baseOffset: best.baseOffset,
        endOffset: best.endOffset,
        groupCount: best.groupCount,
        parsedGroupCount: best.parsedGroupCount,
        totalRecords: best.totalRecords,
        knownOpcodePercent: best.knownOpcodePercent,
        opcodeHistogram: best.opcodeHistogram,
        warnings: best.warnings,
      } : null,
      attempts: probe.attempts,
    },
  };
}

function refsFromSceneBuffer(buf) {
  const seen = new Set();
  return scanLengthPrefixedRefs(buf)
    .map((ref) => ({
      offset: hex(ref.recordOffset, 4),
      stringOffset: hex(ref.stringOffset, 4),
      length: ref.length,
      text: ref.text,
      ext: extOf(ref.text),
    }))
    .filter((ref) => {
      const key = `${ref.ext}:${normalizeName(ref.text)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function loadHandlerTable(file = HANDLER_JSON) {
  try {
    const report = JSON.parse(fs.readFileSync(file, "utf8"));
    const commands = (report.commands || []).map((command) => ({
      name: command.name,
      target: command.target,
      blockStart: command.blockStart,
      calls: (command.callsFromBlock || []).map((call) => ({
        kind: call.kind,
        slot: call.slot,
        argIndex: call.argIndex,
      })),
    }));
    const slotCounts = {};
    for (const command of commands) {
      for (const call of command.calls) {
        const key = `${call.slot || "?"}:${call.kind || "?"}`;
        slotCounts[key] = (slotCounts[key] || 0) + 1;
      }
    }
    return {
      file,
      registrationsResolved: report.registrationsResolved || commands.length,
      commandCount: commands.length,
      slotCounts,
      commands,
    };
  } catch (err) {
    return { file, error: err.message || String(err), registrationsResolved: 0, commandCount: 0, commands: [] };
  }
}

function loadReaderServiceSummary(file = READER_SERVICE_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "reader service trace has not been generated",
    };
  }
  try {
    const trace = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      available: true,
      file,
      schema: trace.schema,
      focusGlobal: hex(trace.focusGlobal, 4),
      methodWriteCount: trace.methodWriteCount,
      clusterCount: trace.clusterCount,
      blockingSlot: "stream prep / +0x50",
      status: "XSE reader object is confirmed at sb+0x35C4; +0x4C-only widening failed, so the stream-preparation chain remains unresolved.",
      xseCallSites: (trace.xseCallSites || []).map((site) => ({
        site: hex(site.site, 8),
        global35C4: Boolean(site.globalHit),
        slot: Number.isFinite(site.slot) ? `+0x${site.slot.toString(16).toUpperCase()}` : "",
      })),
      topClusters: (trace.topClusters || []).slice(0, 6).map((cluster) => ({
        start: hex(cluster.start, 8),
        end: hex(cluster.end, 8),
        score: cluster.score,
        slots: (cluster.slots || []).map((slot) => `+0x${slot.toString(16).toUpperCase()}`),
      })),
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function loadVmGateSummary(file = VM_GATE_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "XSE VM gate probe has not been generated",
    };
  }
  try {
    const probe = JSON.parse(fs.readFileSync(file, "utf8"));
    const scripts = (probe.scripts || []).map((script) => {
      const baseCandidates = (script.streamPrepEvidence?.testedBaseCandidates || []).map((candidate) => ({
        label: candidate.label,
        baseOffset: candidate.baseOffset,
        groupCount: candidate.headerGroupCount ?? null,
        recordByteSize: candidate.headerRecordByteSize ?? null,
        anyStrictOpcodePath: Boolean(candidate.anyStrictOpcodePath),
        layoutAlignedStrictPath: Boolean(candidate.layoutAlignedStrictPath),
        bestEndOffset: candidate.bestEndOffset || "",
        bestLayoutDelta: candidate.bestLayoutDelta ?? null,
      }));
      const anyStrictOpcodePath = baseCandidates.length
        ? baseCandidates.some((candidate) => candidate.anyStrictOpcodePath)
        : Boolean(script.variable4CSearch?.anyStrictOpcodePath);
      const layoutAlignedStrictPath = baseCandidates.length
        ? baseCandidates.some((candidate) => candidate.layoutAlignedStrictPath)
        : Boolean(script.variable4CSearch?.layoutAlignedStrictPath);
      const best = script.variable4CSearch?.successes?.[0] || null;
      return {
        name: script.name,
        headerOk: Boolean(script.header?.ok),
        headerGroupCount: script.header?.groupCount ?? null,
        headerRecordByteSize: script.header?.recordByteSize ?? null,
        baselineKnownOpcodePercent: script.baseline112C4?.strictOpcodeGate?.knownOpcodePercent ?? 0,
        baselineGatePassed: Boolean(script.baseline112C4?.strictOpcodeGate?.passed),
        anyStrictOpcodePath,
        layoutAlignedStrictPath,
        layoutObjectEnd: script.layoutBoundaryHypothesis?.objectProbeEnd || "",
        bestEndOffset: best?.endOffset || "",
        bestLayoutDelta: best?.layoutEndDelta ?? null,
        bestTotalRecords: best?.totalRecords ?? 0,
        baseCandidates,
        firstFailure: script.variable4CSearch?.firstFailures?.[0] || null,
      };
    });
    const alignedCount = scripts.filter((script) => script.layoutAlignedStrictPath).length;
    const shallowCount = scripts.filter((script) => script.anyStrictOpcodePath && !script.layoutAlignedStrictPath).length;
    return {
      available: true,
      file,
      schema: probe.schema,
      scriptCount: scripts.length,
      alignedCount,
      shallowCount,
      status: alignedCount
        ? "At least one script has a layout-aligned strict opcode path."
        : "No focused script has a layout-aligned strict opcode path when only +0x4C is widened.",
      nextTarget: "stream preparation via [sb+0x35C4]+0x40 and [sb+0x35C0]+0x50, then exact +0x50 compact-reader semantics",
      scripts,
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function loadStreamPrepSummary(file = STREAM_PREP_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "XSE stream prep trace has not been generated",
    };
  }
  try {
    const trace = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      available: true,
      file,
      schema: trace.schema,
      currentBlocker: trace.conclusion?.currentBlocker || "",
      nextTarget: trace.conclusion?.nextTarget || "",
      chains: (trace.chains || []).map((chain) => ({
        name: chain.name,
        window: chain.window,
        open: chain.open,
        convert: chain.convert,
        resultRegister: chain.resultRegister,
        cursorInit: chain.cursorInit,
      })),
      resources: (trace.resources || []).map((resource) => ({
        name: resource.name,
        bodyOffset: resource.envelope?.bodyOffset || "",
        prefixByteAtBody: resource.prefixByteAtBody || "",
        magicOffset: resource.magic?.magicOffset || "",
        lengthMatches: resource.envelope?.lengthMatches ?? null,
      })),
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function loadStreamServiceSummary(file = STREAM_SERVICE_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "XSE stream service trace has not been generated",
    };
  }
  try {
    const trace = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      available: true,
      file,
      schema: trace.schema,
      currentFinding: trace.conclusion?.currentFinding || "",
      emulatorImpact: trace.conclusion?.emulatorImpact || "",
      methodTableStatus: trace.conclusion?.methodTableStatus || "",
      nextTarget: trace.conclusion?.nextTarget || "",
      methodWriteCount: trace.methodWriteCount || 0,
      methodWriteSlotCounts: trace.methodWriteSlotCounts || {},
      sharedOpenConvertChains: trace.conclusion?.sharedOpenConvertChains || [],
      chains: (trace.chains || []).map((chain) => {
        const open = (chain.steps || []).find((step) => step.globalSlot === 0x35C4 && step.methodSlot === 0x40);
        const convert = (chain.steps || []).find((step) => step.globalSlot === 0x35C0 && step.methodSlot === 0x50);
        const cursorReads = (chain.steps || [])
          .filter((step) => !(step.globalSlot === 0x35C4 && step.methodSlot === 0x40) && !(step.globalSlot === 0x35C0 && step.methodSlot === 0x50))
          .map((step) => `${step.siteHex} ${step.serviceShape}`);
        return {
          id: chain.id,
          name: chain.name,
          kind: chain.kind,
          window: chain.window,
          open: open ? `${open.siteHex} ${open.serviceShape}` : "",
          convert: convert ? `${convert.siteHex} ${convert.serviceShape}` : "",
          cursorReads,
        };
      }),
      topClusters: (trace.topMethodTableClusters || []).slice(0, 4).map((cluster) => ({
        start: cluster.startHex,
        end: cluster.endHex,
        score: cluster.score,
        slots: cluster.slotHexes || [],
      })),
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function loadProviderServiceSummary(file = PROVIDER_SERVICE_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "XSE provider-service trace has not been generated",
    };
  }
  try {
    const trace = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      available: true,
      file,
      schema: trace.schema,
      currentFinding: trace.conclusion?.currentFinding || "",
      serviceSplit: trace.conclusion?.serviceSplit || "",
      bootImpact: trace.conclusion?.bootImpact || "",
      emulatorImpact: trace.conclusion?.emulatorImpact || "",
      nextTarget: trace.conclusion?.nextTarget || "",
      assignments: (trace.providerAssignments || []).map((item) => ({
        global: item.globalHex || hex(item.global, 4),
        name: item.name,
        store: item.storeHex || hex(item.store, 8),
        source: item.expression,
        role: item.emulatorRole,
      })),
      bootCalls: (trace.bootCalls || []).map((call) => ({
        site: call.siteHex || hex(call.site, 8),
        target: call.targetHex || hex(call.target, 8),
        meaning: call.meaning,
      })),
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function loadProviderReplaySummary(file = PROVIDER_REPLAY_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "provider service replay probe has not been generated",
    };
  }
  try {
    const replay = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      available: true,
      file,
      schema: replay.schema,
      currentFinding: replay.conclusion?.currentFinding || "",
      emulatorImpact: replay.conclusion?.emulatorImpact || "",
      xseBlocker: replay.conclusion?.xseBlocker || "",
      nextTarget: replay.conclusion?.nextTarget || "",
      sce: {
        status: replay.replays?.sce?.status || "",
        fields: replay.replays?.sce?.fields || {},
        maps: replay.replays?.sce?.maps || [],
        converted: {
          baseOffset: replay.replays?.sce?.converted?.baseOffsetHex || "",
          magic: replay.replays?.sce?.converted?.magic || "",
        },
      },
      xse: {
        status: replay.replays?.xse?.status || "",
        converted: {
          baseOffset: replay.replays?.xse?.converted?.baseOffsetHex || "",
          magic: replay.replays?.xse?.converted?.magic || "",
        },
        currentProbe: replay.replays?.xse?.currentProbe || {},
      },
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function loadCursor50VariantSummary(file = CURSOR50_VARIANTS_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "cursor +0x50 variant probe has not been generated",
    };
  }
  try {
    const probe = JSON.parse(fs.readFileSync(file, "utf8"));
    const actorVariants = (probe.summary?.actorVariants || []).map((item) => ({
      id: item.id,
      label: item.label,
      wins: item.wins || 0,
      actorCount: item.actorCount || 0,
      plausibleActorCount: item.plausibleActorCount || 0,
      averageScore: item.averageScore ?? null,
    }));
    const xseVariants = (probe.summary?.xseVariants || []).map((item) => ({
      id: item.id,
      label: item.label,
      scriptCount: item.scriptCount || 0,
      headerOkCount: item.headerOkCount || 0,
      strictCount: item.strictCount || 0,
      alignedCount: item.alignedCount || 0,
      bestAligned: item.bestAligned || [],
      perScript: item.perScript || [],
    }));
    const topActor = actorVariants[0] || null;
    const topXse = xseVariants[0] || null;
    return {
      available: true,
      file,
      schema: probe.schema,
      currentFinding: probe.conclusion?.currentFinding || "",
      emulatorImpact: probe.conclusion?.emulatorImpact || "",
      nextTarget: probe.conclusion?.nextTarget || "",
      actorBest: probe.conclusion?.actorBest || topActor?.id || "",
      actorBestTies: probe.conclusion?.actorBestTies || [],
      xseBest: probe.conclusion?.xseBest || topXse?.id || "",
      actorVariants,
      xseVariants,
      topActor,
      topXse,
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function loadProviderAbiSummary(file = PROVIDER_ABI_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "provider ABI trace has not been generated",
    };
  }
  try {
    const trace = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      available: true,
      file,
      schema: trace.schema,
      currentFinding: trace.conclusion?.currentFinding || "",
      emulatorImpact: trace.conclusion?.emulatorImpact || "",
      nextTarget: trace.conclusion?.nextTarget || "",
      providerSource: trace.providerSource || {},
      criticalReturns: (trace.providerReturns || [])
        .filter((item) => item.isXseCritical)
        .map((item) => ({
          site: item.siteHex,
          method: item.expression,
          target: item.targetGlobalHex,
          role: item.role,
        })),
      providerReturns: (trace.providerReturns || []).map((item) => ({
        site: item.siteHex,
        method: item.expression,
        target: item.targetGlobalHex,
        role: item.role,
        critical: Boolean(item.isXseCritical),
      })),
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function loadProviderAbiShimSummary(file = PROVIDER_ABI_SHIM_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "provider ABI shim probe has not been generated",
    };
  }
  try {
    const probe = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      available: true,
      file,
      schema: probe.schema,
      currentFinding: probe.conclusion?.currentFinding || "",
      emulatorImpact: probe.conclusion?.emulatorImpact || "",
      nextTarget: probe.conclusion?.nextTarget || "",
      providerRefSamples: probe.providerRefSamples || {},
      resolverHook: probe.resolverHook || probe.serviceObjects?.readerService?.resolverHook || {},
      providerRefNamespace: probe.providerRefNamespace ? {
        namespaceId: probe.providerRefNamespace.namespaceId || "",
        refCount: probe.providerRefNamespace.refCount || 0,
        opaqueRefCount: probe.providerRefNamespace.opaqueRefCount || 0,
        textRefCount: probe.providerRefNamespace.textRefCount || 0,
        compareCount: probe.providerRefNamespace.compareCount || 0,
        compareMatchCount: probe.providerRefNamespace.compareMatchCount || 0,
        unboundCompareCount: probe.providerRefNamespace.unboundCompareCount || 0,
        contexts: probe.providerRefNamespace.contexts || [],
        refs: (probe.providerRefNamespace.refs || []).slice(0, 24),
        compares: (probe.providerRefNamespace.compares || []).slice(0, 24),
      } : null,
      criticalAssignments: probe.boot?.criticalAssignments || [],
      serviceObjects: probe.serviceObjects || {},
      sce: {
        status: probe.replays?.sce?.status || "",
        fields: probe.replays?.sce?.fields || {},
        maps: probe.replays?.sce?.maps || [],
        converted: probe.replays?.sce?.converted || {},
      },
      xse: {
        status: probe.replays?.xse?.status || "",
        strictCandidateCount: probe.replays?.xse?.strictCandidateCount || 0,
        alignedCandidateCount: probe.replays?.xse?.alignedCandidateCount || 0,
        scripts: (probe.replays?.xse?.scripts || []).map((script) => ({
          name: script.name,
          targetEnd: script.targetEnd || "",
          candidates: (script.candidates || []).map((candidate) => ({
            policy: candidate.policy,
            baseOffset: candidate.baseOffset,
            headerOk: Boolean(candidate.shimHeader?.ok),
            groupCount: candidate.shimHeader?.groupCount ?? null,
            recordByteSize: candidate.shimHeader?.recordByteSize ?? null,
            anyStrictOpcodePath: Boolean(candidate.currentGate?.anyStrictOpcodePath),
            layoutAlignedStrictPath: Boolean(candidate.currentGate?.layoutAlignedStrictPath),
            bestEndOffset: candidate.currentGate?.bestEndOffset || "",
            bestLayoutDelta: candidate.currentGate?.bestLayoutDelta ?? null,
            firstFailure: candidate.currentGate?.firstFailure || null,
          })),
        })),
      },
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function loadXseSwitchReplaySummary(file = XSE_SWITCH_REPLAY_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "XSE 0x112C4 switch replay probe has not been generated",
    };
  }
  try {
    const probe = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      available: true,
      file,
      schema: probe.schema,
      status: probe.summary?.status || "",
      currentFinding: probe.summary?.currentFinding || "",
      nextTarget: probe.summary?.nextTarget || "",
      okScripts: probe.summary?.okScripts || 0,
      scriptCount: probe.summary?.scriptCount || 0,
      closeTailScripts: probe.summary?.closeTailScripts || 0,
      correction: probe.disassemblyCorrection || {},
      scripts: (probe.scripts || []).map((script) => {
        const best = script.best || {};
        return {
          name: script.name,
          mode: best.shortMode || "",
          groups: best.header?.groupCount ?? null,
          records: best.totalRecords ?? null,
          highOpcodeRecords: best.highOpcodeRecords ?? null,
          highOpcodePercent: best.highOpcodePercent ?? null,
          groupEnd: best.groupEndHex || "",
          tailEnd: best.bestTail?.endHex || "",
          layoutEnd: script.layoutHint?.objectEnd || "",
          layoutDelta: best.layoutDelta ?? null,
          tailOk: Boolean(best.bestTail?.ok),
          tailModes: best.bestTail?.modes || {},
        };
      }),
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function loadXseRuntimeDispatchSummary(file = XSE_RUNTIME_DISPATCH_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "XSE runtime dispatch probe has not been generated",
    };
  }
  try {
    const probe = JSON.parse(fs.readFileSync(file, "utf8"));
    const scripts = (probe.scripts || []).map((script) => ({
      name: script.name,
      layoutEnd: script.layoutEnd || "",
      tension: Boolean(script.tension),
      executionCorrection: Boolean(script.executionCorrection),
      tailBest: script.tailBest || {},
      dispatchBest: script.dispatchBest || {},
      executionBest: script.executionBest || {},
    }));
    return {
      available: true,
      file,
      schema: probe.schema,
      status: probe.summary?.status || "",
      currentFinding: probe.summary?.currentFinding || "",
      emulatorImpact: probe.summary?.emulatorImpact || "",
      nextTarget: probe.summary?.nextTarget || "",
      tensionScripts: probe.summary?.tensionScripts || [],
      executionCorrections: probe.summary?.executionCorrections || [],
      tensionCount: scripts.filter((script) => script.tension).length,
      executionCorrectionCount: scripts.filter((script) => script.executionCorrection).length,
      scriptCount: scripts.length,
      directCaseCount: probe.primaryGroupDispatch?.cases?.length || 0,
      defaultTarget: probe.primaryGroupDispatch?.defaultTarget || "",
      scripts,
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function loadXseDispatchCaseSummary(file = XSE_DISPATCH_CASES_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "XSE dispatch case probe has not been generated",
    };
  }
  try {
    const probe = JSON.parse(fs.readFileSync(file, "utf8"));
    const focusedDirect = Array.from(new Set((probe.focusedScripts || []).flatMap((script) => script.directGroups || []))).sort((a, b) => a - b);
    const focusedDefault = Array.from(new Set((probe.focusedScripts || []).flatMap((script) => script.defaultGroups || []))).sort((a, b) => a - b);
    const targetSummaries = (probe.caseWindows || []).map((item) => ({
      target: item.target,
      groupIds: item.groupIds || [],
      note: item.note || "",
      helpers: item.helperSummary || [],
      fields: item.scriptFieldSummary || [],
    }));
    const focusedTargets = targetSummaries
      .filter((item) => item.groupIds.some((id) => focusedDirect.includes(id)))
      .map((item) => item.target);
    return {
      available: true,
      file,
      schema: probe.schema,
      status: probe.summary?.status || "",
      currentFinding: probe.summary?.currentFinding || "",
      emulatorImpact: probe.summary?.emulatorImpact || "",
      nextTarget: probe.summary?.nextTarget || "",
      focusedDirect,
      focusedDefault,
      focusedTargets,
      caseCount: targetSummaries.length,
      targetSummaries,
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function loadXseTraceVmSummary(file = XSE_TRACE_VM_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "XSE trace VM probe has not been generated",
    };
  }
  try {
    const probe = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      available: true,
      file,
      schema: probe.schema,
      status: probe.summary?.status || "",
      currentFinding: probe.summary?.currentFinding || "",
      emulatorImpact: probe.summary?.emulatorImpact || "",
      nextTarget: probe.summary?.nextTarget || "",
      scriptCount: probe.summary?.scriptCount || 0,
      stepCount: probe.summary?.stepCount || 0,
      directGroups: probe.summary?.directGroups || [],
      highOpcodeOperandDefaultSteps: probe.summary?.highOpcodeOperandDefaultSteps || 0,
      highOpcodeOperandBlockedSteps: probe.summary?.highOpcodeOperandBlockedSteps || 0,
      runtimeHelperBlockedSteps: probe.summary?.runtimeHelperBlockedSteps || 0,
      registerShapeSuspectSteps: probe.summary?.registerShapeSuspectSteps || 0,
      writebackTargetBlockedSteps: probe.summary?.writebackTargetBlockedSteps || 0,
      concreteTypedValues: probe.summary?.concreteTypedValues || 0,
      defaultTypedValues: probe.summary?.defaultTypedValues || 0,
      symbolicTypedValues: probe.summary?.symbolicTypedValues || 0,
      avoidedRegisterShapeSuspects: probe.summary?.avoidedRegisterShapeSuspects || [],
      scripts: (probe.scripts || []).map((script) => ({
        name: script.name,
        mode: script.mode,
        steps: script.steps?.length || 0,
        directSteps: script.directSteps || 0,
        defaultSteps: script.defaultSteps || 0,
        highOpcodeOperandDefaultSteps: script.highOpcodeOperandDefaultSteps || 0,
        highOpcodeOperandBlockedSteps: script.highOpcodeOperandBlockedSteps || 0,
        runtimeHelperBlockedSteps: script.runtimeHelperBlockedSteps || 0,
        registerShapeSuspectSteps: script.registerShapeSuspectSteps || 0,
        writebackTargetBlockedSteps: script.writebackTargetBlockedSteps || 0,
        concreteTypedValues: script.concreteTypedValues || 0,
        defaultTypedValues: script.defaultTypedValues || 0,
        symbolicTypedValues: script.symbolicTypedValues || 0,
        finalCursor: script.finalCursor ?? null,
        active: Boolean(script.active),
      })),
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function loadXseWritebackSummary(file = XSE_WRITEBACK_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "XSE writeback probe has not been generated",
    };
  }
  try {
    const probe = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      available: true,
      file,
      schema: probe.schema,
      status: probe.summary?.status || "",
      currentFinding: probe.summary?.currentFinding || "",
      emulatorImpact: probe.summary?.emulatorImpact || "",
      nextTarget: probe.summary?.nextTarget || "",
      executionWritebackRiskCount: probe.summary?.executionWritebackRiskCount || 0,
      executionRiskScripts: probe.summary?.executionRiskScripts || [],
      allLowRiskButDefaultOnly: probe.summary?.allLowRiskButDefaultOnly || [],
      directLowRiskScripts: probe.summary?.directLowRiskScripts || [],
      nullGuardedWritebackSite: Boolean(probe.summary?.nullGuardedWritebackSite),
      writebackSite: probe.summary?.writebackSite || "",
      requiredPointerTypes: probe.summary?.requiredPointerTypes || [],
      runtimeContract: probe.runtimeContract || null,
      scripts: (probe.scripts || []).map((script) => ({
        name: script.name,
        executionMode: script.executionMode || "",
        executionRiskCount: script.executionAttempt?.writebackRiskCount || 0,
        lowRiskModes: script.lowRiskModes || [],
      })),
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function loadXseCursorInitSummary(file = XSE_CURSOR_INIT_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "XSE cursor init probe has not been generated",
    };
  }
  try {
    const probe = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      available: true,
      file,
      schema: probe.schema,
      status: probe.summary?.status || "",
      currentFinding: probe.summary?.currentFinding || "",
      emulatorImpact: probe.summary?.emulatorImpact || "",
      nextTarget: probe.summary?.nextTarget || "",
      executionNotSeededCount: probe.summary?.executionNotSeededCount || 0,
      executionSeedableCount: probe.summary?.executionSeedableCount || 0,
      resetEntry: probe.resetContract?.entry || "",
      resetContract: probe.resetContract || null,
      scripts: (probe.scripts || []).map((script) => ({
        name: script.name,
        executionMode: script.executionMode || "",
        cursorSeedStatus: script.executionAttempt?.cursorSeedStatus || "",
        field08Byte: script.executionAttempt?.field08Byte ?? null,
        field0C: script.executionAttempt?.field0C ?? null,
        inferredInitialCursor: script.executionAttempt?.inferredInitialCursor ?? null,
      })),
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function loadXseSlotLifecycleSummary(file = XSE_SLOT_LIFECYCLE_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "XSE slot lifecycle probe has not been generated",
    };
  }
  try {
    const probe = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      available: true,
      file,
      schema: probe.schema,
      status: probe.summary?.status || "",
      currentFinding: probe.summary?.currentFinding || "",
      emulatorImpact: probe.summary?.emulatorImpact || "",
      nextTarget: probe.summary?.nextTarget || "",
      executionGroupCursorNotSeededCount: probe.summary?.executionGroupCursorNotSeededCount || 0,
      writebackBlockerCount: probe.summary?.writebackBlockerCount || 0,
      cursorZeroFirstBlockerCount: probe.summary?.cursorZeroFirstBlockerCount || 0,
      firstBlockerScripts: probe.summary?.firstBlockerScripts || [],
      scripts: (probe.scripts || []).map((script) => ({
        name: script.name,
        executionMode: script.executionMode || "",
        field04: script.field04 ?? null,
        field08Byte: script.field08Byte ?? null,
        field0C: script.field0C ?? null,
        resetGroupCursorSeed: script.resetGroupCursorSeed,
        resetGroupCursorSeeded: Boolean(script.resetGroupCursorSeeded),
        resetOpcodeCursorSeed: script.resetOpcodeCursorSeed || "",
      })),
      writebackBlockers: (probe.writebackBlockers || []).map((row) => ({
        name: row.name,
        mode: row.mode,
        writebackBlockers: row.writebackBlockers || 0,
        firstWritebackCursor: row.firstWritebackCursor ?? null,
        firstGroupId: row.firstGroupId ?? null,
        firstBeforeAnyPriorStep: Boolean(row.firstBeforeAnyPriorStep),
        firstOperand0Type: row.firstOperand0Type ?? null,
        firstOperand0PointerKind: row.firstOperand0PointerKind || "",
      })),
      functions: (probe.functions || []).map((fn) => ({
        entry: fn.entry,
        name: fn.name,
        phase: fn.phase,
        role: fn.role,
        eventCount: fn.events?.length || 0,
      })),
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function loadXseOperandBindingSummary(file = XSE_OPERAND_BINDING_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "XSE operand binding probe has not been generated",
    };
  }
  try {
    const probe = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      available: true,
      file,
      schema: probe.schema,
      status: probe.summary?.status || "",
      currentFinding: probe.summary?.currentFinding || "",
      emulatorImpact: probe.summary?.emulatorImpact || "",
      nextTarget: probe.summary?.nextTarget || "",
      writebackBlockerCount: probe.summary?.writebackBlockerCount || 0,
      operand0PointerTypeCount: probe.summary?.operand0PointerTypeCount || 0,
      stackSeedRelevantBlockerCount: probe.summary?.stackSeedRelevantBlockerCount || 0,
      readerLayoutBlockerCount: probe.summary?.readerLayoutBlockerCount || 0,
      operand0Types: probe.summary?.operand0Types || [],
      operand1ReferenceCount: probe.summary?.operand1ReferenceCount || 0,
      blockers: (probe.blockers || []).map((row) => ({
        script: row.script,
        mode: row.mode,
        cursor: row.cursor,
        groupId: row.groupId,
        operand0Type: row.operand0?.type ?? null,
        operand0PointerKind: row.operand0?.pointerKind || "",
        operand1Type: row.operand1?.type ?? null,
        operand1PointerKind: row.operand1?.pointerKind || "",
        stackSeedRelevant: Boolean(row.stackSeedRelevant),
        requiresReaderLayoutBinding: Boolean(row.requiresReaderLayoutBinding),
      })),
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function loadXseEntrypointSummary(file = XSE_ENTRYPOINT_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "XSE entrypoint probe has not been generated",
    };
  }
  try {
    const probe = JSON.parse(fs.readFileSync(file, "utf8"));
    const scripts = probe.scripts || [];
    return {
      available: true,
      file,
      schema: probe.schema,
      status: probe.summary?.status || "",
      currentFinding: probe.summary?.currentFinding || "",
      emulatorImpact: probe.summary?.emulatorImpact || "",
      nextTarget: probe.summary?.nextTarget || "",
      operandBindingFinding: probe.summary?.operandBindingFinding || "",
      scriptCount: probe.summary?.scriptCount || scripts.length,
      scriptsWithPlausibleEntries: probe.summary?.scriptsWithPlausibleEntries || scripts
        .filter((script) => (script.bestEntry?.plausibleEntryCount || 0) > 0)
        .map((script) => script.name),
      scriptsWithSafeEntries: probe.summary?.scriptsWithSafeEntries || scripts
        .filter((script) => (script.bestEntry?.safeEntryCount || 0) > 0)
        .map((script) => script.name),
      entryHelperContract: probe.entryHelperContract || null,
      scripts: scripts.map((script) => {
        const best = script.bestEntry || null;
        return {
          name: script.name,
          status: script.status || "",
          executionMode: script.executionMode || "",
          groupCount: script.groupCount ?? null,
          groupIds: script.groupIds || [],
          groupEnd: script.groupEnd || "",
          layoutEnd: script.layoutEnd || "",
          bestEntry: best ? {
            modes: best.modes || {},
            start: best.start || "",
            end: best.end || "",
            layoutDelta: best.layoutDelta ?? null,
            entryCount: best.entryCount ?? null,
            finalRefCount: best.finalRefCount ?? null,
            plausibleEntryCount: best.plausibleEntryCount || 0,
            safeEntryCount: best.safeEntryCount || 0,
            minEntryWritebackRisk: best.minEntryWritebackRisk ?? null,
            entries: (best.entries || []).slice(0, 6).map((entry) => ({
              index: entry.index,
              offset: entry.offset,
              groupCursor: entry.groupCursor,
              kind: entry.kind,
              stackSpan: entry.stackSpan,
              ref: entry.ref,
              writebackRiskCount: entry.run?.writebackRiskCount ?? null,
              writebackCount: entry.run?.writebackCount ?? null,
            })),
          } : null,
        };
      }),
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function loadXseEntryLabelSummary(file = XSE_ENTRY_LABEL_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "XSE entry label probe has not been generated",
    };
  }
  try {
    const probe = JSON.parse(fs.readFileSync(file, "utf8"));
    const scripts = probe.scripts || [];
    return {
      available: true,
      file,
      schema: probe.schema,
      status: probe.summary?.status || "",
      currentFinding: probe.summary?.currentFinding || "",
      emulatorImpact: probe.summary?.emulatorImpact || "",
      nextTarget: probe.summary?.nextTarget || "",
      scriptCount: probe.summary?.scriptCount || scripts.length,
      labelConfirmedScripts: probe.summary?.labelConfirmedScripts || [],
      commandOnlyScripts: probe.summary?.commandOnlyScripts || [],
      scripts: scripts.map((script) => ({
        name: script.name,
        status: script.status || "",
        entryStatus: script.entryStatus || "",
        safeLabelCandidateCount: script.safeLabelCandidateCount || 0,
        safeCommandCandidateCount: script.safeCommandCandidateCount || 0,
        labels: script.labels || [],
        bestLabelCandidate: script.bestLabelCandidate || null,
        bestCommandCandidate: script.bestCommandCandidate || null,
      })),
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function loadXseEntryCallerSummary(file = XSE_ENTRY_CALLER_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "XSE entry caller probe has not been generated",
    };
  }
  try {
    const probe = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      available: true,
      file,
      schema: probe.schema,
      status: probe.summary?.status || "",
      currentFinding: probe.summary?.currentFinding || "",
      emulatorImpact: probe.summary?.emulatorImpact || "",
      nextTarget: probe.summary?.nextTarget || "",
      callCount: probe.summary?.callCount || 0,
      dispatchingCallCount: probe.summary?.dispatchingCallCount || 0,
      selectOnlyCallCount: probe.summary?.selectOnlyCallCount || 0,
      semanticLabels: probe.summary?.semanticLabels || [],
      calls: (probe.calls || []).map((call) => ({
        call: call.callHex,
        target: call.targetHex,
        targetRole: call.targetRole || "",
        semanticLabel: call.labelArg?.semanticLabel || "",
        labelTarget: call.labelArg?.targetHex || "",
        nearbyAscii: (call.labelArg?.nearbyAscii || []).slice(0, 3),
      })),
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function loadXseEntryCompareSummary(file = XSE_ENTRY_COMPARE_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "XSE entry compare probe has not been generated",
    };
  }
  try {
    const probe = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      available: true,
      file,
      schema: probe.schema,
      status: probe.summary?.status || "",
      currentFinding: probe.summary?.currentFinding || "",
      emulatorImpact: probe.summary?.emulatorImpact || "",
      nextTarget: probe.summary?.nextTarget || "",
      requestedLabels: probe.summary?.requestedLabels || [],
      scriptCount: probe.summary?.scriptCount || 0,
      safeLabelScripts: probe.summary?.safeLabelScripts || [],
      unsafeLabelScripts: probe.summary?.unsafeLabelScripts || [],
      callerPointerNonZeroDeltaCount: probe.summary?.callerPointerNonZeroDeltaCount || 0,
      callerLabelProfiles: (probe.callerLabelProfiles || []).map((profile) => ({
        call: profile.call,
        helper: profile.helper,
        requestedLabel: profile.requestedLabel,
        target: profile.target,
        exactTextAtTarget: profile.exactTextAtTarget || "",
        pointerDeltaToBestLabel: profile.pointerDeltaToBestLabel ?? null,
      })),
      scripts: (probe.scripts || []).map((script) => ({
        name: script.name,
        status: script.status,
        safeLabelCandidateCount: script.safeLabelCandidateCount || 0,
        unsafeLabelCandidateCount: script.unsafeLabelCandidateCount || 0,
        labels: script.labels || [],
        bestSafeLabelCandidate: script.bestSafeLabelCandidate || null,
        bestUnsafeLabelCandidate: script.bestUnsafeLabelCandidate || null,
      })),
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function loadXseLabelPointerSummary(file = XSE_LABEL_POINTER_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "XSE label pointer probe has not been generated",
    };
  }
  try {
    const probe = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      available: true,
      file,
      schema: probe.schema,
      status: probe.summary?.status || "",
      currentFinding: probe.summary?.currentFinding || "",
      emulatorImpact: probe.summary?.emulatorImpact || "",
      nextTarget: probe.summary?.nextTarget || "",
      profileCount: probe.summary?.profileCount || 0,
      exactFullLabelCount: probe.summary?.exactFullLabelCount || 0,
      nonZeroDeltaCount: probe.summary?.nonZeroDeltaCount || 0,
      suffixPointerCount: probe.summary?.suffixPointerCount || 0,
      pretargetMismatchCount: probe.summary?.pretargetMismatchCount || 0,
      pcPlus2FullLabelCount: probe.summary?.pcPlus2FullLabelCount || 0,
      pcPlus2MismatchCount: probe.summary?.pcPlus2MismatchCount || 0,
      exactAdrSelectedCount: probe.summary?.exactAdrSelectedCount || 0,
      compareShimPrimaryModel: probe.summary?.compareShimPrimaryModel || "",
      compareShimWritebackRiskCount: probe.summary?.compareShimWritebackRiskCount || 0,
      compareShimSafeCount: probe.summary?.compareShimSafeCount || 0,
      pointerProfiles: (probe.pointerProfiles || []).map((profile) => ({
        call: profile.call,
        helper: profile.helper,
        target: profile.target,
        exactTextAtTarget: profile.exactTextAtTarget || "",
        requestedLabel: profile.requestedLabel || "",
        nearestFullLabel: profile.nearestFullLabel || "",
        nearestFullStart: profile.nearestFullStart || "",
        pointerDeltaToFullLabel: profile.pointerDeltaToFullLabel ?? null,
        classification: profile.classification || "",
        adr: profile.adr || null,
        twoBytesBeforeTarget: profile.twoBytesBeforeTarget || "",
      })),
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function loadXseRefEncodingSummary(file = XSE_REF_ENCODING_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "XSE ref encoding probe has not been generated",
    };
  }
  try {
    const probe = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      available: true,
      file,
      schema: probe.schema,
      status: probe.summary?.status || "",
      currentFinding: probe.summary?.currentFinding || "",
      emulatorImpact: probe.summary?.emulatorImpact || "",
      nextTarget: probe.summary?.nextTarget || "",
      scriptCount: probe.summary?.scriptCount || 0,
      requestedLabels: probe.summary?.requestedLabels || [],
      safeLabelScripts: probe.summary?.safeLabelScripts || [],
      riskyLabelScripts: probe.summary?.riskyLabelScripts || [],
      commandOnlyScripts: probe.summary?.commandOnlyScripts || [],
      topRef64Modes: probe.summary?.topRef64Modes || [],
      universalTopRef64: probe.summary?.universalTopRef64 || "",
      compareShimPrimaryModel: probe.summary?.compareShimPrimaryModel || "",
      exactAdrSelectedCount: probe.summary?.exactAdrSelectedCount || 0,
      modeDiversity: probe.modeDiversity || {},
      scripts: (probe.scripts || []).map((script) => ({
        name: script.name,
        status: script.status,
        topMode: script.topMode || "",
        topRef64Mode: script.topRef64Mode || "",
        layoutClosestMode: script.layoutClosestMode || "",
        layoutClosestDelta: script.layoutClosestDelta ?? null,
        requestedCandidateCount: script.requestedCandidateCount || 0,
        safeRequestedCandidateCount: script.safeRequestedCandidateCount || 0,
        commandCandidateCount: script.commandCandidateCount || 0,
        bestScore: script.bestScore || null,
        bestRequested: script.bestRequested || null,
        bestCommand: script.bestCommand || null,
      })),
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function loadXseCompareNormalizationSummary(file = XSE_COMPARE_NORMALIZATION_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "XSE compare normalization probe has not been generated",
    };
  }
  try {
    const probe = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      available: true,
      file,
      schema: probe.schema,
      status: probe.summary?.status || "",
      currentFinding: probe.summary?.currentFinding || "",
      emulatorImpact: probe.summary?.emulatorImpact || "",
      nextTarget: probe.summary?.nextTarget || "",
      profileCount: probe.summary?.profileCount || 0,
      exactRequestedCoverage: probe.summary?.exactRequestedCoverage || 0,
      pcPlus2RequestedCoverage: probe.summary?.pcPlus2RequestedCoverage || 0,
      targetPlusMinus2RequestedCoverage: probe.summary?.targetPlusMinus2RequestedCoverage || 0,
      nearestFullRequestedCoverage: probe.summary?.nearestFullRequestedCoverage || 0,
      fullCoverageStrategies: probe.summary?.fullCoverageStrategies || [],
      primaryStrategy: probe.summary?.primaryStrategy || "",
      primarySafeScripts: probe.summary?.primarySafeScripts || [],
      primaryRiskScripts: probe.summary?.primaryRiskScripts || [],
      primaryUnmatchedScripts: probe.summary?.primaryUnmatchedScripts || [],
      profiles: probe.profiles || [],
      normalizers: (probe.normalizers || []).map((normalizer) => ({
        id: normalizer.id,
        description: normalizer.description || "",
        labels: normalizer.labels || [],
        coverageCount: normalizer.coverageCount || 0,
        requestedCoverageCount: normalizer.requestedCoverageCount || 0,
        refModels: (normalizer.refModels || []).map((model) => ({
          id: model.id,
          selectedSafeScripts: model.selectedSafeScripts || [],
          selectedWritebackRiskScripts: model.selectedWritebackRiskScripts || [],
          selectedImplausibleScripts: model.selectedImplausibleScripts || [],
          unmatchedScripts: model.unmatchedScripts || [],
        })),
      })),
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function loadXseTailBoundarySummary(file = XSE_TAIL_BOUNDARY_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "XSE tail boundary probe has not been generated",
    };
  }
  try {
    const probe = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      available: true,
      file,
      schema: probe.schema,
      status: probe.summary?.status || "",
      currentFinding: probe.summary?.currentFinding || "",
      emulatorImpact: probe.summary?.emulatorImpact || "",
      nextTarget: probe.summary?.nextTarget || "",
      scriptCount: probe.summary?.scriptCount || 0,
      requestedLabels: probe.summary?.requestedLabels || [],
      cleanTextPayloadScripts: probe.summary?.cleanTextPayloadScripts || [],
      cleanTextPayloadSafeScripts: probe.summary?.cleanTextPayloadSafeScripts || [],
      crossingOnlyTextPayloadScripts: probe.summary?.crossingOnlyTextPayloadScripts || [],
      cleanAnyScripts: probe.summary?.cleanAnyScripts || [],
      crossingOnlyAnyScripts: probe.summary?.crossingOnlyAnyScripts || [],
      scripts: (probe.scripts || []).map((script) => ({
        name: script.name,
        status: script.status,
        boundaries: script.boundaries || {},
        labels: script.labels || [],
        candidateCount: script.candidateCount || 0,
        boundaryCleanCandidateCount: script.boundaryCleanCandidateCount || 0,
        crossingCandidateCount: script.crossingCandidateCount || 0,
        topCandidate: script.topCandidate || null,
        models: (script.models || []).map((model) => ({
          id: model.id,
          matchedCount: model.matchedCount || 0,
          boundaryCleanMatchedCount: model.boundaryCleanMatchedCount || 0,
          boundaryCleanSafeCount: model.boundaryCleanSafeCount || 0,
          crossingMatchedCount: model.crossingMatchedCount || 0,
          crossingSafeCount: model.crossingSafeCount || 0,
          bestAny: model.bestAny || null,
          bestBoundaryClean: model.bestBoundaryClean || null,
        })),
      })),
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function loadXseCompareServiceSummary(file = XSE_COMPARE_SERVICE_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "XSE compare service probe has not been generated",
    };
  }
  try {
    const probe = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      available: true,
      file,
      schema: probe.schema,
      status: probe.summary?.status || "",
      currentFinding: probe.summary?.currentFinding || "",
      emulatorImpact: probe.summary?.emulatorImpact || "",
      nextTarget: probe.summary?.nextTarget || "",
      plus50RoleCount: probe.summary?.plus50RoleCount || 0,
      plus50Roles: probe.summary?.plus50Roles || [],
      compareReturnsZeroOnMatch: Boolean(probe.summary?.compareReturnsZeroOnMatch),
      windows: (probe.windows || []).map((window) => ({
        name: window.name,
        slot: window.slot,
        role: window.role,
        shape: window.shape,
        start: window.startHex,
        end: window.endHex,
        hasBlx: Boolean(window.hasBlx),
        hasReturnZeroMatch: Boolean(window.hasReturnZeroMatch),
      })),
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function loadXseCompareShimSummary(file = XSE_COMPARE_SHIM_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "XSE compare shim probe has not been generated",
    };
  }
  try {
    const probe = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      available: true,
      file,
      schema: probe.schema,
      status: probe.summary?.status || "",
      currentFinding: probe.summary?.currentFinding || "",
      emulatorImpact: probe.summary?.emulatorImpact || "",
      nextTarget: probe.summary?.nextTarget || "",
      scriptCount: probe.summary?.scriptCount || 0,
      primaryModel: probe.summary?.primaryModel || "",
      exactAdrSelectedCount: probe.summary?.exactAdrSelectedCount || 0,
      allStrongImplausibleScripts: probe.summary?.allStrongImplausibleScripts || [],
      selectedSafeScripts: probe.summary?.selectedSafeScripts || [],
      selectedImplausibleScripts: probe.summary?.selectedImplausibleScripts || [],
      selectedWritebackRiskScripts: probe.summary?.selectedWritebackRiskScripts || [],
      selectedUnsafeScripts: probe.summary?.selectedUnsafeScripts || [],
      unmatchedScripts: probe.summary?.unmatchedScripts || [],
      pointerModels: probe.pointerModels || [],
      argumentShape: probe.argumentShape || {},
      scripts: (probe.scripts || []).map((script) => ({
        name: script.name,
        primaryStatus: script.primaryStatus,
        primarySelection: script.primarySelection
          ? {
            modes: script.primarySelection.modes || {},
            selectedStatus: script.primarySelection.selectedStatus || "",
            selected: script.primarySelection.selected || null,
          }
          : null,
      })),
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function loadXseActivationSummary(file = XSE_ACTIVATION_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "XSE activation probe has not been generated",
    };
  }
  try {
    const probe = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      available: true,
      file,
      schema: probe.schema,
      status: probe.summary?.status || "",
      currentFinding: probe.summary?.currentFinding || "",
      emulatorImpact: probe.summary?.emulatorImpact || "",
      nextTarget: probe.summary?.nextTarget || "",
      scriptCount: probe.summary?.scriptCount || 0,
      primaryModel: probe.summary?.primaryModel || "",
      primarySelectedScripts: probe.summary?.primarySelectedScripts || [],
      primarySafeScripts: probe.summary?.primarySafeScripts || [],
      primaryRiskScripts: probe.summary?.primaryRiskScripts || [],
      broadInvalidScripts: probe.summary?.broadInvalidScripts || [],
      activationContract: probe.activationContract || {},
      scripts: (probe.scripts || []).map((script) => ({
        name: script.name,
        groupCount: script.groupCount || 0,
        primaryEffect: script.primaryEffect || null,
        broadEffect: script.broadEffect || null,
      })),
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function loadXseActivatedDispatchSummary(file = XSE_ACTIVATED_DISPATCH_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "XSE activated dispatch probe has not been generated",
    };
  }
  try {
    const probe = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      available: true,
      file,
      schema: probe.schema,
      status: probe.summary?.status || "",
      currentFinding: probe.summary?.currentFinding || "",
      emulatorImpact: probe.summary?.emulatorImpact || "",
      nextTarget: probe.summary?.nextTarget || "",
      scriptCount: probe.summary?.scriptCount || 0,
      primarySelectedCount: probe.summary?.primarySelectedCount || 0,
      primaryCursorValidCount: probe.summary?.primaryCursorValidCount || 0,
      primaryActivatedStepCount: probe.summary?.primaryActivatedStepCount || 0,
      primaryWritebackBlockedCount: probe.summary?.primaryWritebackBlockedCount || 0,
      primaryReaderLayoutBlockedCount: probe.summary?.primaryReaderLayoutBlockedCount || 0,
      primaryStackSeedRelevantCount: probe.summary?.primaryStackSeedRelevantCount || 0,
      primaryVisibleSafeCount: probe.summary?.primaryVisibleSafeCount || 0,
      blockedScripts: probe.summary?.blockedScripts || [],
      readerLayoutBlockedScripts: probe.summary?.readerLayoutBlockedScripts || [],
      stackSeedRelevantScripts: probe.summary?.stackSeedRelevantScripts || [],
      activationFinding: probe.summary?.activationFinding || "",
      operandBindingFinding: probe.summary?.operandBindingFinding || "",
      scripts: (probe.scripts || []).map((script) => ({
        name: script.name,
        groupCount: script.groupCount || 0,
        traceMode: script.traceMode || "",
        primaryDispatch: script.primaryDispatch || null,
        broadDispatch: script.broadDispatch || null,
      })),
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function loadXseActivatedOperandSummary(file = XSE_ACTIVATED_OPERAND_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "XSE activated operand probe has not been generated",
    };
  }
  try {
    const probe = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      available: true,
      file,
      schema: probe.schema,
      status: probe.summary?.status || "",
      currentFinding: probe.summary?.currentFinding || "",
      emulatorImpact: probe.summary?.emulatorImpact || "",
      nextTarget: probe.summary?.nextTarget || "",
      blockedPrimaryCount: probe.summary?.blockedPrimaryCount || 0,
      stableBoundaryCount: probe.summary?.stableBoundaryCount || 0,
      rows: (probe.rows || []).map((row) => ({
        script: row.script,
        status: row.status,
        traceMode: row.traceMode || "",
        group: row.group || {},
        dispatch: row.dispatch || {},
        caseOperandContract: row.caseOperandContract || {},
        finding: row.finding || "",
      })),
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function loadXseHighOpcodeSummary(file = XSE_HIGH_OPCODE_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "XSE high opcode probe has not been generated",
    };
  }
  try {
    const probe = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      available: true,
      file,
      schema: probe.schema,
      status: probe.summary?.status || "",
      currentFinding: probe.summary?.currentFinding || "",
      emulatorImpact: probe.summary?.emulatorImpact || "",
      nextTarget: probe.summary?.nextTarget || "",
      writebackRiskCount: probe.summary?.writebackRiskCount || 0,
      highOpcodeWritebackRiskCount: probe.summary?.highOpcodeWritebackRiskCount || 0,
      immediateWritebackRiskCount: probe.summary?.immediateWritebackRiskCount || 0,
      highOperandUseCount: probe.summary?.highOperandUseCount || 0,
      numericDefaultHighOperandCount: probe.summary?.numericDefaultHighOperandCount || 0,
      identityWritebackHighOperandCount: probe.summary?.identityWritebackHighOperandCount || 0,
      activatedHighOpcodeCount: probe.summary?.activatedHighOpcodeCount || 0,
      activatedHighOpcodeBlockedCount: probe.summary?.activatedHighOpcodeBlockedCount || 0,
      highOpcodeHistogram: probe.summary?.highOpcodeHistogram || [],
      activatedRows: (probe.activatedRows || []).map((row) => ({
        script: row.script,
        cursor: row.cursor ?? null,
        groupId: row.groupId ?? null,
        target: row.target || "",
        operand0: row.operand0 || null,
        highOpcodeUse: row.highOpcodeUse || {},
        pointerRecordsInSameGroup: row.pointerRecordsInSameGroup || [],
        finding: row.finding || "",
      })),
      highOperandRows: (probe.highOperandRows || []).map((row) => ({
        script: row.script,
        cursor: row.cursor ?? null,
        groupId: row.groupId ?? null,
        target: row.target || "",
        useKind: row.highOpcodeUse?.kind || "",
        writebackBlocked: Boolean(row.writebackBlocked),
        highRecords: row.highRecords || [],
      })),
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function loadXseEntrySafetySummary(file = XSE_ENTRY_SAFETY_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "XSE entry safety probe has not been generated",
    };
  }
  try {
    const probe = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      available: true,
      file,
      schema: probe.schema,
      status: probe.summary?.status || "",
      currentFinding: probe.summary?.currentFinding || "",
      emulatorImpact: probe.summary?.emulatorImpact || "",
      nextTarget: probe.summary?.nextTarget || "",
      scriptCount: probe.summary?.scriptCount || 0,
      primaryModel: probe.summary?.primaryModel || "",
      primarySelectedCount: probe.summary?.primarySelectedCount || 0,
      promotablePrimaryCount: probe.summary?.promotablePrimaryCount || 0,
      demotedHighOpcodeWritebackCount: probe.summary?.demotedHighOpcodeWritebackCount || 0,
      demotedWritebackCount: probe.summary?.demotedWritebackCount || 0,
      unmatchedPrimaryCount: probe.summary?.unmatchedPrimaryCount || 0,
      invalidBroadCount: probe.summary?.invalidBroadCount || 0,
      promotablePrimaryScripts: probe.summary?.promotablePrimaryScripts || [],
      demotedHighOpcodeWritebackScripts: probe.summary?.demotedHighOpcodeWritebackScripts || [],
      demotedWritebackScripts: probe.summary?.demotedWritebackScripts || [],
      unmatchedPrimaryScripts: probe.summary?.unmatchedPrimaryScripts || [],
      invalidBroadScripts: probe.summary?.invalidBroadScripts || [],
      gateRules: probe.gateRules || [],
      primaryRows: (probe.primaryRows || []).map((row) => ({
        script: row.script,
        model: row.model || "",
        status: row.status || "",
        promotable: Boolean(row.promotable),
        reason: row.reason || "",
        selected: row.selected || null,
        activation: row.activation || null,
        dispatch: row.dispatch || null,
        highOpcode: row.highOpcode || null,
      })),
      broadRows: (probe.broadRows || []).map((row) => ({
        script: row.script,
        model: row.model || "",
        status: row.status || "",
        promotable: Boolean(row.promotable),
        reason: row.reason || "",
        selected: row.selected || null,
        activation: row.activation || null,
        dispatch: row.dispatch || null,
      })),
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function loadXseRefWidthSafetySummary(file = XSE_REF_WIDTH_SAFETY_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "XSE ref width safety probe has not been generated",
    };
  }
  try {
    const probe = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      available: true,
      file,
      schema: probe.schema,
      status: probe.summary?.status || "",
      currentFinding: probe.summary?.currentFinding || "",
      emulatorImpact: probe.summary?.emulatorImpact || "",
      nextTarget: probe.summary?.nextTarget || "",
      scriptCount: probe.summary?.scriptCount || 0,
      candidatesPerScript: probe.summary?.candidatesPerScript || 0,
      totalCandidateScans: probe.summary?.totalCandidateScans || 0,
      matchedScriptCount: probe.summary?.matchedScriptCount || 0,
      firstSafeMatchCount: probe.summary?.firstSafeMatchCount || 0,
      safeMatchCount: probe.summary?.safeMatchCount || 0,
      unsafeMatchCount: probe.summary?.unsafeMatchCount || 0,
      firstSafeScripts: probe.summary?.firstSafeScripts || [],
      laterSafeScripts: probe.summary?.laterSafeScripts || [],
      matchedScripts: probe.summary?.matchedScripts || [],
      requestedLabels: probe.requestedLabels || [],
      scripts: (probe.scripts || []).map((script) => ({
        name: script.name,
        status: script.status || "",
        candidateCount: script.candidateCount || 0,
        models: (script.models || []).map((model) => ({
          id: model.id,
          status: model.status || "",
          matchCount: model.matchCount || 0,
          firstMatchSafeCount: model.firstMatchSafeCount || 0,
          safeMatchCount: model.safeMatchCount || 0,
          boundaryCleanSafeMatchCount: model.boundaryCleanSafeMatchCount || 0,
          ref64ModesWithMatches: model.ref64ModesWithMatches || [],
          firstRows: model.firstRows || [],
        })),
      })),
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function loadXseCompareAbiSummary(file = XSE_COMPARE_ABI_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "XSE compare ABI probe has not been generated",
    };
  }
  try {
    const probe = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      available: true,
      file,
      schema: probe.schema,
      status: probe.summary?.status || "",
      currentFinding: probe.summary?.currentFinding || "",
      emulatorImpact: probe.summary?.emulatorImpact || "",
      nextTarget: probe.summary?.nextTarget || "",
      plus50RoleCount: probe.summary?.plus50RoleCount || 0,
      streamCursorReadCount: probe.summary?.streamCursorReadCount || 0,
      labelRefCompareCount: probe.summary?.labelRefCompareCount || 0,
      compareReturnsZeroOnMatch: Boolean(probe.summary?.compareReturnsZeroOnMatch),
      compareBranchMissingFromShim: Boolean(probe.summary?.compareBranchMissingFromShim),
      refWidthFirstSafeMatchCount: probe.summary?.refWidthFirstSafeMatchCount || 0,
      refWidthSafeMatchCount: probe.summary?.refWidthSafeMatchCount || 0,
      entryPromotableCount: probe.summary?.entryPromotableCount || 0,
      providerReaderService: probe.providerReaderService || {},
      branchContract: probe.branchContract || {},
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function loadXseRefNamespaceSummary(file = XSE_REF_NAMESPACE_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "XSE ref namespace probe has not been generated",
    };
  }
  try {
    const probe = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      available: true,
      file,
      schema: probe.schema,
      status: probe.summary?.status || "",
      currentFinding: probe.summary?.currentFinding || "",
      emulatorImpact: probe.summary?.emulatorImpact || "",
      nextTarget: probe.summary?.nextTarget || "",
      scriptCount: probe.summary?.scriptCount || 0,
      compareBranchDocumented: Boolean(probe.summary?.compareBranchDocumented),
      labelRefCompareCount: probe.summary?.labelRefCompareCount || 0,
      compareReturnsZeroOnMatch: Boolean(probe.summary?.compareReturnsZeroOnMatch),
      exactAdrSelectedCount: probe.summary?.exactAdrSelectedCount || 0,
      callerPointerProfileCount: probe.summary?.callerPointerProfileCount || 0,
      suffixPointerCount: probe.summary?.suffixPointerCount || 0,
      scalarFirstSafeMatchCount: probe.summary?.scalarFirstSafeMatchCount || 0,
      scalarSafeMatchCount: probe.summary?.scalarSafeMatchCount || 0,
      unsafeScalarCollisionCount: probe.summary?.unsafeScalarCollisionCount || 0,
      entryPromotableCount: probe.summary?.entryPromotableCount || 0,
      primarySelectedCount: probe.summary?.primarySelectedCount || 0,
      resolverBound: Boolean(probe.summary?.resolverBound),
      visibleEffectsEnabled: Boolean(probe.summary?.visibleEffectsEnabled),
      hostCompareOracle: probe.hostCompareOracle || {},
      namespaceModels: probe.namespaceModels || [],
      primarySelections: (probe.primarySelections || []).map((row) => ({
        script: row.script,
        selected: Boolean(row.selected),
        modeKey: row.modeKey || "",
        entry: row.entry ?? null,
        cursor: row.cursor ?? null,
        ref: row.ref ?? null,
        refRaw: row.refRaw || "",
        matches: row.matches || [],
        safetyStatus: row.safetyStatus || row.status || "",
      })),
      scripts: (probe.scripts || []).map((script) => ({
        script: script.script,
        refEncodingStatus: script.refEncodingStatus || "",
        topMode: script.topMode || "",
        requestedCandidateCount: script.requestedCandidateCount || 0,
        safeRequestedCandidateCount: script.safeRequestedCandidateCount || 0,
        refWidthMatchCount: script.refWidthMatchCount || 0,
        refWidthSafeCount: script.refWidthSafeCount || 0,
        entrySafetyStatus: script.entrySafetyStatus || "",
      })),
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function loadXseRef64LoaderSummary(file = XSE_REF64_LOADER_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "XSE +0x64 loader probe has not been generated",
    };
  }
  try {
    const probe = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      available: true,
      file,
      schema: probe.schema,
      status: probe.summary?.status || "",
      currentFinding: probe.summary?.currentFinding || "",
      emulatorImpact: probe.summary?.emulatorImpact || "",
      nextTarget: probe.summary?.nextTarget || "",
      scriptCount: probe.summary?.scriptCount || 0,
      rangeRefCallSite: probe.summary?.rangeRefCallSite || "",
      finalRefCallSite: probe.summary?.finalRefCallSite || "",
      derivedField0C: Boolean(probe.summary?.derivedField0C),
      selectedEntryCount: probe.summary?.selectedEntryCount || 0,
      selectedInlineTextCount: probe.summary?.selectedInlineTextCount || 0,
      inlineTextDiagnosticScriptCount: probe.summary?.inlineTextDiagnosticScriptCount || 0,
      loaderAbi: probe.loaderAbi || {},
      scripts: (probe.scripts || []).map((script) => ({
        name: script.name,
        status: script.status || "",
        groupEnd: script.groupEnd || "",
        primarySelection: script.primarySelection || null,
        topCandidate: script.candidates?.[0] ? {
          role: script.candidates[0].role || "",
          modeKey: script.candidates[0].modeKey || "",
          entryCount: script.candidates[0].entryCount ?? null,
          finalRefCount: script.candidates[0].finalRefCount ?? null,
          entryRefTextLikeCount: script.candidates[0].entryRefTextLikeCount || 0,
          finalRefTextLikeCount: script.candidates[0].finalRefTextLikeCount || 0,
          selectedEntry: script.candidates[0].samples?.selectedEntry || null,
        } : null,
      })),
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function loadProviderRefContextSummary(file = PROVIDER_REF_CONTEXT_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "Provider ref context probe has not been generated",
    };
  }
  try {
    const probe = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      available: true,
      file,
      schema: probe.schema,
      status: probe.summary?.status || "",
      currentFinding: probe.summary?.currentFinding || "",
      emulatorImpact: probe.summary?.emulatorImpact || "",
      nextTarget: probe.summary?.nextTarget || "",
      contextCount: probe.summary?.contextCount || 0,
      textSafeContextCount: probe.summary?.textSafeContextCount || 0,
      opaqueContextCount: probe.summary?.opaqueContextCount || 0,
      textSafeContexts: probe.summary?.textSafeContexts || [],
      opaqueContexts: probe.summary?.opaqueContexts || [],
      visibleEffectsEnabled: Boolean(probe.summary?.visibleEffectsEnabled),
      dispatchRule: probe.dispatchRule || {},
      contexts: (probe.contexts || []).map((context) => ({
        id: context.id,
        returnClass: context.returnClass || "",
        safeToParseAsText: Boolean(context.safeToParseAsText),
        callSites: context.callSites || [],
        consumers: context.consumers || [],
        emulatorPolicy: context.emulatorPolicy || "",
        proof: context.proof || "",
      })),
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function loadXseCompareResolverSummary(file = XSE_COMPARE_RESOLVER_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "XSE compare resolver boundary probe has not been generated",
    };
  }
  try {
    const probe = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      available: true,
      file,
      schema: probe.schema,
      status: probe.summary?.status || "",
      currentFinding: probe.summary?.currentFinding || "",
      emulatorImpact: probe.summary?.emulatorImpact || "",
      nextTarget: probe.summary?.nextTarget || "",
      providerReaderGlobal: probe.summary?.providerReaderGlobal || "",
      providerReaderMethod: probe.summary?.providerReaderMethod || "",
      compareSite: probe.summary?.compareSite || "",
      compareSlot: probe.summary?.compareSlot || "",
      shimCompareSampleCount: probe.summary?.shimCompareSampleCount || 0,
      shimMatchedSampleCount: probe.summary?.shimMatchedSampleCount || 0,
      shimUnboundSampleCount: probe.summary?.shimUnboundSampleCount || 0,
      ledgerRefCount: probe.summary?.ledgerRefCount || probe.providerRefNamespace?.refCount || 0,
      ledgerCompareCount: probe.summary?.ledgerCompareCount || probe.providerRefNamespace?.compareCount || 0,
      resolverHookMode: probe.summary?.resolverHookMode || "",
      resolverHookBound: Boolean(probe.summary?.resolverHookBound),
      visibleEffectsEnabled: Boolean(probe.summary?.visibleEffectsEnabled),
      boundary: probe.boundary || {},
      providerRefNamespace: probe.providerRefNamespace || {},
      originChain: probe.originChain || {},
      compareSamples: (probe.compareSamples || []).map((sample) => ({
        script: sample.script,
        policy: sample.policy,
        refContext: sample.refContext,
        refOffset: sample.refOffset,
        label: sample.label,
        returnValue: sample.returnValue,
        resolverStatus: sample.resolverStatus || "",
      })),
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function loadProviderResolverHookSummary(file = PROVIDER_RESOLVER_HOOK_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "Provider resolver hook probe has not been generated",
    };
  }
  try {
    const probe = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      available: true,
      file,
      schema: probe.schema,
      status: probe.summary?.status || "",
      currentFinding: probe.summary?.currentFinding || "",
      emulatorImpact: probe.summary?.emulatorImpact || "",
      nextTarget: probe.summary?.nextTarget || "",
      hookMode: probe.summary?.hookMode || "",
      syntheticObservedMatchCount: probe.summary?.syntheticObservedMatchCount || 0,
      checkCount: probe.summary?.checkCount || 0,
      failureCount: probe.summary?.failureCount || 0,
      exactObservedPairMatches: Boolean(probe.summary?.exactObservedPairMatches),
      sameLabelWrongRefMatches: Boolean(probe.summary?.sameLabelWrongRefMatches),
      wrongLabelSameRefMatches: Boolean(probe.summary?.wrongLabelSameRefMatches),
      visibleEffectsEnabled: Boolean(probe.summary?.visibleEffectsEnabled),
      baseline: probe.baseline || {},
      checks: (probe.checks || []).map((check) => ({
        id: check.id,
        label: check.label,
        refId: check.refId,
        matched: Boolean(check.matched),
        expectedMatched: Boolean(check.expectedMatched),
        status: check.status || "",
        returnValue: check.returnValue,
      })),
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function loadProvider35C4TapeSummary(file = PROVIDER35C4_TAPE_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "Provider 0x35C4 instrumentation tape probe has not been generated",
    };
  }
  try {
    const probe = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      available: true,
      file,
      schema: probe.schema,
      status: probe.summary?.status || "",
      currentFinding: probe.summary?.currentFinding || "",
      emulatorImpact: probe.summary?.emulatorImpact || "",
      nextTarget: probe.summary?.nextTarget || "",
      visibleEffectsEnabled: Boolean(probe.summary?.visibleEffectsEnabled),
      failureCount: probe.summary?.failureCount || 0,
      providerEventCount: probe.summary?.providerEventCount || probe.counts?.providerEventCount || 0,
      producerEventCount: probe.summary?.producerEventCount || probe.counts?.producerEventCount || 0,
      cursorReadEventCount: probe.summary?.cursorReadEventCount || probe.counts?.cursorReadEventCount || 0,
      labelCompareEventCount: probe.summary?.labelCompareEventCount || probe.counts?.labelCompareEventCount || 0,
      observedReturn0CompareCount: probe.summary?.observedReturn0CompareCount || probe.counts?.observedReturn0CompareCount || 0,
      hookFeedObservedMatchCount: probe.summary?.hookFeedObservedMatchCount || probe.counts?.hookFeedObservedMatchCount || 0,
      namespace: probe.namespace || {},
      resolverHook: probe.resolverHook || {},
      invariants: (probe.invariants || []).map((invariant) => ({
        id: invariant.id,
        passed: Boolean(invariant.passed),
        details: invariant.details || "",
        impact: invariant.impact || "",
      })),
      tape: (probe.tape || []).slice(0, 32).map((event) => ({
        seq: event.seq,
        kind: event.kind,
        slot: event.slot,
        resource: event.resource || "",
        context: event.context || "",
        refId: event.refId || "",
        label: event.label || "",
        returnValue: event.returnValue,
        compareStatus: event.compareStatus || "",
      })),
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function loadProvider35C4FeedSummary(file = PROVIDER35C4_FEED_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "Provider 0x35C4 observed feed probe has not been generated",
    };
  }
  try {
    const probe = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      available: true,
      file,
      schema: probe.schema,
      status: probe.summary?.status || "",
      currentFinding: probe.summary?.currentFinding || "",
      emulatorImpact: probe.summary?.emulatorImpact || "",
      nextTarget: probe.summary?.nextTarget || "",
      visibleEffectsEnabled: Boolean(probe.summary?.visibleEffectsEnabled),
      failureCount: probe.summary?.failureCount || 0,
      observedMatchCount: probe.summary?.observedMatchCount || probe.feed?.observedMatchCount || 0,
      resolverReplayCount: probe.summary?.resolverReplayCount || probe.feed?.resolverReplayCount || 0,
      resolverMatchedCount: probe.summary?.resolverMatchedCount || probe.feed?.resolverMatchedCount || 0,
      promotionEligibleCount: probe.summary?.promotionEligibleCount || probe.feed?.promotionEligibleCount || 0,
      entrySafetyPromotableCount: probe.summary?.entrySafetyPromotableCount || probe.feed?.entrySafetyPromotableCount || 0,
      feed: probe.feed || {},
      invariants: (probe.invariants || []).map((invariant) => ({
        id: invariant.id,
        passed: Boolean(invariant.passed),
        details: invariant.details || "",
        impact: invariant.impact || "",
      })),
      observedMatches: (probe.observedMatches || []).slice(0, 16),
      replayedCompares: (probe.replayedCompares || []).slice(0, 32).map((row) => ({
        seq: row.seq,
        resource: row.resource || "",
        label: row.label || "",
        refId: row.refId || "",
        sourceReturnValue: row.sourceReturnValue,
        resolverReturnValue: row.resolverReturnValue,
        resolverStatus: row.resolverStatus || "",
      })),
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function loadProvider35C4CaptureSummary(file = PROVIDER35C4_CAPTURE_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "Provider 0x35C4 capture plan probe has not been generated",
    };
  }
  try {
    const probe = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      available: true,
      file,
      schema: probe.schema,
      status: probe.summary?.status || "",
      currentFinding: probe.summary?.currentFinding || "",
      emulatorImpact: probe.summary?.emulatorImpact || "",
      nextTarget: probe.summary?.nextTarget || "",
      visibleEffectsEnabled: Boolean(probe.summary?.visibleEffectsEnabled),
      failureCount: probe.summary?.failureCount || 0,
      capturePointCount: probe.summary?.capturePointCount || (probe.capturePoints || []).length,
      readyCapturePointCount: probe.summary?.readyCapturePointCount || (probe.capturePoints || []).filter((point) => point.ready).length,
      feedEligibleCapturePointCount: probe.summary?.feedEligibleCapturePointCount || (probe.capturePoints || []).filter((point) => point.feedEligible).length,
      observedMatchCount: probe.summary?.observedMatchCount || probe.currentFeed?.observedMatchCount || 0,
      promotionEligibleCount: probe.summary?.promotionEligibleCount || probe.currentFeed?.promotionEligibleCount || 0,
      serviceOrigin: probe.serviceOrigin || {},
      captureSchema: probe.captureSchema || {},
      currentTape: probe.currentTape || {},
      currentFeed: probe.currentFeed || {},
      invariants: (probe.invariants || []).map((invariant) => ({
        id: invariant.id,
        passed: Boolean(invariant.passed),
        details: invariant.details || "",
        impact: invariant.impact || "",
      })),
      capturePoints: (probe.capturePoints || []).slice(0, 16).map((point) => ({
        id: point.id,
        eventKind: point.eventKind || "",
        service: point.service || "",
        slot: point.slot || "",
        site: point.site || "",
        context: point.context || "",
        feedEligible: Boolean(point.feedEligible),
        ready: Boolean(point.ready),
        currentEvidence: point.currentEvidence || "",
      })),
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function loadProvider35C4CaptureSourceSummary(file = PROVIDER35C4_CAPTURE_SOURCE_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "Provider 0x35C4 capture source probe has not been generated",
    };
  }
  try {
    const probe = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      available: true,
      file,
      schema: probe.schema,
      status: probe.summary?.status || "",
      currentFinding: probe.summary?.currentFinding || "",
      emulatorImpact: probe.summary?.emulatorImpact || "",
      nextTarget: probe.summary?.nextTarget || "",
      visibleEffectsEnabled: Boolean(probe.summary?.visibleEffectsEnabled),
      failureCount: probe.summary?.failureCount || 0,
      captureEventCount: probe.summary?.captureEventCount || probe.counts?.captureEventCount || 0,
      producerEventCount: probe.summary?.producerEventCount || probe.counts?.producerEventCount || 0,
      cursorReadEventCount: probe.summary?.cursorReadEventCount || probe.counts?.cursorReadEventCount || 0,
      labelCompareEventCount: probe.summary?.labelCompareEventCount || probe.counts?.labelCompareEventCount || 0,
      linkedCompareCount: probe.summary?.linkedCompareCount || probe.counts?.linkedCompareCount || 0,
      priorProducerCompareCount: probe.summary?.priorProducerCompareCount || probe.counts?.priorProducerCompareCount || 0,
      observedFeedEventCount: probe.summary?.observedFeedEventCount || probe.counts?.observedFeedEventCount || 0,
      observedCapturePointCount: probe.summary?.observedCapturePointCount || probe.counts?.observedCapturePointCount || 0,
      planCapturePointCount: probe.summary?.planCapturePointCount || probe.counts?.planCapturePointCount || 0,
      sourceContract: probe.sourceContract || {},
      counts: probe.counts || {},
      invariants: (probe.invariants || []).map((invariant) => ({
        id: invariant.id,
        passed: Boolean(invariant.passed),
        details: invariant.details || "",
        impact: invariant.impact || "",
      })),
      pointCoverage: (probe.pointCoverage || []).slice(0, 16).map((point) => ({
        id: point.id,
        eventKind: point.eventKind || "",
        slot: point.slot || "",
        site: point.site || "",
        context: point.context || "",
        ready: Boolean(point.ready),
        observedEventCount: point.observedEventCount || 0,
      })),
      compareLinks: (probe.compareLinks || []).slice(0, 32).map((row) => ({
        sourceSeq: row.sourceSeq,
        callerLabel: row.callerLabel || "",
        providerRefId: row.providerRefId || "",
        producerSeq: row.producerSeq,
        producerContext: row.producerContext || "",
        returnValue: row.returnValue,
        compareStatus: row.compareStatus || "",
        feedEligible: Boolean(row.feedEligible),
      })),
      captureEvents: (probe.captureEvents || []).slice(0, 32).map((event) => ({
        sourceSeq: event.sourceSeq,
        capturePointId: event.capturePointId || "",
        kind: event.kind || "",
        slot: event.slot || "",
        resource: event.resource || "",
        providerRefId: event.providerRefId || "",
        callerLabel: event.callerLabel || "",
        returnValue: event.returnValue,
      })),
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function loadProvider35C4EmulatedSourceSummary(file = PROVIDER35C4_EMULATED_SOURCE_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "Provider 0x35C4 emulated source probe has not been generated",
    };
  }
  try {
    const probe = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      available: true,
      file,
      schema: probe.schema,
      status: probe.summary?.status || "",
      currentFinding: probe.summary?.currentFinding || "",
      emulatorImpact: probe.summary?.emulatorImpact || "",
      nextTarget: probe.summary?.nextTarget || "",
      visibleEffectsEnabled: Boolean(probe.summary?.visibleEffectsEnabled),
      failureCount: probe.summary?.failureCount || 0,
      captureEventCount: probe.summary?.captureEventCount || probe.counts?.captureEventCount || 0,
      adapterEventCount: probe.summary?.adapterEventCount || probe.counts?.adapterEventCount || 0,
      adapterProviderOwnedEventCount: probe.summary?.adapterProviderOwnedEventCount || probe.counts?.adapterProviderOwnedEventCount || 0,
      adapterConversionHandoffCount: probe.summary?.adapterConversionHandoffCount || probe.counts?.adapterConversionHandoffCount || 0,
      producerEventCount: probe.summary?.producerEventCount || probe.counts?.producerEventCount || 0,
      cursorReadEventCount: probe.summary?.cursorReadEventCount || probe.counts?.cursorReadEventCount || 0,
      labelCompareEventCount: probe.summary?.labelCompareEventCount || probe.counts?.labelCompareEventCount || 0,
      linkedCompareCount: probe.summary?.linkedCompareCount || probe.counts?.linkedCompareCount || 0,
      priorProducerCompareCount: probe.summary?.priorProducerCompareCount || probe.counts?.priorProducerCompareCount || 0,
      observedFeedEventCount: probe.summary?.observedFeedEventCount || probe.counts?.observedFeedEventCount || 0,
      observedCapturePointCount: probe.summary?.observedCapturePointCount || probe.counts?.observedCapturePointCount || 0,
      planCapturePointCount: probe.summary?.planCapturePointCount || probe.counts?.planCapturePointCount || 0,
      adapterParity: Boolean(probe.summary?.adapterParity || probe.counts?.adapterParity),
      sourceContract: probe.sourceContract || {},
      counts: probe.counts || {},
      invariants: (probe.invariants || []).map((invariant) => ({
        id: invariant.id,
        passed: Boolean(invariant.passed),
        details: invariant.details || "",
        impact: invariant.impact || "",
      })),
      pointCoverage: (probe.pointCoverage || []).slice(0, 16).map((point) => ({
        id: point.id,
        eventKind: point.eventKind || "",
        slot: point.slot || "",
        site: point.site || "",
        context: point.context || "",
        ready: Boolean(point.ready),
        observedEventCount: point.observedEventCount || 0,
      })),
      compareLinks: (probe.compareLinks || []).slice(0, 32).map((row) => ({
        sourceSeq: row.sourceSeq,
        callerLabel: row.callerLabel || "",
        providerRefId: row.providerRefId || "",
        producerSeq: row.producerSeq,
        producerContext: row.producerContext || "",
        returnValue: row.returnValue,
        compareStatus: row.compareStatus || "",
        feedEligible: Boolean(row.feedEligible),
      })),
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function loadProvider35C4ServiceObjectSummary(file = PROVIDER35C4_SERVICE_OBJECT_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "Provider 0x35C4 service object probe has not been generated",
    };
  }
  try {
    const probe = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      available: true,
      file,
      schema: probe.schema,
      status: probe.summary?.status || "",
      currentFinding: probe.summary?.currentFinding || "",
      emulatorImpact: probe.summary?.emulatorImpact || "",
      nextTarget: probe.summary?.nextTarget || "",
      visibleEffectsEnabled: Boolean(probe.summary?.visibleEffectsEnabled),
      failureCount: probe.summary?.failureCount || 0,
      replayRowCount: probe.summary?.replayRowCount || probe.counts?.replayRowCount || 0,
      producerOperationCount: probe.summary?.producerOperationCount || probe.counts?.producerOperationCount || 0,
      cursorReadOperationCount: probe.summary?.cursorReadOperationCount || probe.counts?.cursorReadOperationCount || 0,
      compareOperationCount: probe.summary?.compareOperationCount || probe.counts?.compareOperationCount || 0,
      knownRefCount: probe.summary?.knownRefCount || probe.counts?.knownRefCount || 0,
      observedFeedCount: probe.summary?.observedFeedCount || probe.counts?.observedFeedCount || 0,
      observedReturn0CompareCount: probe.summary?.observedReturn0CompareCount || probe.counts?.observedReturn0CompareCount || 0,
      adapterConversionHandoffCount: probe.summary?.adapterConversionHandoffCount || probe.counts?.adapterConversionHandoffCount || 0,
      serviceObject: probe.serviceObject || {},
      counts: probe.counts || {},
      invariants: (probe.invariants || []).map((invariant) => ({
        id: invariant.id,
        passed: Boolean(invariant.passed),
        details: invariant.details || "",
        impact: invariant.impact || "",
      })),
      replayRows: (probe.replayRows || []).slice(0, 32).map((row) => ({
        sourceSeq: row.sourceSeq,
        tapeKind: row.tapeKind || "",
        dispatchShape: row.dispatchShape || "",
        providerRefId: row.providerRefId || "",
        callerLabel: row.callerLabel || "",
        sourceReturnValue: row.sourceReturnValue,
        serviceReturnValue: row.serviceReturnValue,
        status: row.status || "",
      })),
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function loadProvider35C4ServiceResolverSummary(file = PROVIDER35C4_SERVICE_RESOLVER_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "Provider 0x35C4 service resolver probe has not been generated",
    };
  }
  try {
    const probe = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      available: true,
      file,
      schema: probe.schema,
      status: probe.summary?.status || "",
      currentFinding: probe.summary?.currentFinding || "",
      emulatorImpact: probe.summary?.emulatorImpact || "",
      nextTarget: probe.summary?.nextTarget || "",
      visibleEffectsEnabled: Boolean(probe.summary?.visibleEffectsEnabled),
      failureCount: probe.summary?.failureCount || 0,
      checkCount: probe.summary?.checkCount || (probe.checks || []).length,
      passedCheckCount: probe.summary?.passedCheckCount || (probe.checks || []).filter((check) => check.passed).length,
      exactObservedPairMatches: Boolean(probe.summary?.exactObservedPairMatches),
      sameLabelWrongRefMatches: Boolean(probe.summary?.sameLabelWrongRefMatches),
      wrongLabelSameRefMatches: Boolean(probe.summary?.wrongLabelSameRefMatches),
      productionObservedFeedCount: probe.summary?.productionObservedFeedCount || 0,
      targetPair: probe.targetPair || null,
      invariants: (probe.invariants || []).map((invariant) => ({
        id: invariant.id,
        passed: Boolean(invariant.passed),
        details: invariant.details || "",
        impact: invariant.impact || "",
      })),
      checks: (probe.checks || []).slice(0, 16).map((check) => ({
        id: check.id,
        label: check.label || "",
        providerRefId: check.providerRefId || "",
        expectedReturnValue: check.expectedReturnValue,
        returnValue: check.returnValue,
        compareStatus: check.compareStatus || "",
        passed: Boolean(check.passed),
      })),
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function loadProvider35C4LiveCallSummary(file = PROVIDER35C4_LIVE_CALL_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "Provider 0x35C4 live call probe has not been generated",
    };
  }
  try {
    const probe = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      available: true,
      file,
      schema: probe.schema,
      status: probe.summary?.status || "",
      currentFinding: probe.summary?.currentFinding || "",
      emulatorImpact: probe.summary?.emulatorImpact || "",
      nextTarget: probe.summary?.nextTarget || "",
      visibleEffectsEnabled: Boolean(probe.summary?.visibleEffectsEnabled),
      failureCount: probe.summary?.failureCount || 0,
      callRequestCount: probe.summary?.callRequestCount || probe.counts?.callRequestCount || 0,
      producerOperationCount: probe.summary?.producerOperationCount || probe.counts?.producerOperationCount || 0,
      cursorReadOperationCount: probe.summary?.cursorReadOperationCount || probe.counts?.cursorReadOperationCount || 0,
      compareOperationCount: probe.summary?.compareOperationCount || probe.counts?.compareOperationCount || 0,
      knownRefCount: probe.summary?.knownRefCount || probe.counts?.knownRefCount || 0,
      return0CompareCount: probe.summary?.return0CompareCount || probe.counts?.return0CompareCount || 0,
      serviceObjectParity: Boolean(probe.summary?.serviceObjectParity || probe.counts?.serviceObjectParity),
      callContract: probe.callContract || {},
      counts: probe.counts || {},
      invariants: (probe.invariants || []).map((invariant) => ({
        id: invariant.id,
        passed: Boolean(invariant.passed),
        details: invariant.details || "",
        impact: invariant.impact || "",
      })),
      replayRows: (probe.replayRows || []).slice(0, 32).map((row) => ({
        sourceSeq: row.sourceSeq,
        method: row.method || "",
        dispatchShape: row.dispatchShape || "",
        providerRefId: row.providerRefId || "",
        callerLabel: row.callerLabel || "",
        requestReturnValue: row.requestReturnValue,
        serviceReturnValue: row.serviceReturnValue,
        status: row.status || "",
      })),
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function loadProvider35C4StreamExecutorSummary(file = PROVIDER35C4_STREAM_EXECUTOR_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "Provider 0x35C4 stream executor probe has not been generated",
    };
  }
  try {
    const probe = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      available: true,
      file,
      schema: probe.schema,
      status: probe.summary?.status || "",
      currentFinding: probe.summary?.currentFinding || "",
      emulatorImpact: probe.summary?.emulatorImpact || "",
      nextTarget: probe.summary?.nextTarget || "",
      visibleEffectsEnabled: Boolean(probe.summary?.visibleEffectsEnabled),
      failureCount: probe.summary?.failureCount || 0,
      parsedCallCount: probe.summary?.parsedCallCount || probe.counts?.parsedCallCount || 0,
      producerOperationCount: probe.summary?.producerOperationCount || probe.counts?.producerOperationCount || 0,
      cursorReadOperationCount: probe.summary?.cursorReadOperationCount || probe.counts?.cursorReadOperationCount || 0,
      compareOperationCount: probe.summary?.compareOperationCount || probe.counts?.compareOperationCount || 0,
      knownRefCount: probe.summary?.knownRefCount || probe.counts?.knownRefCount || 0,
      return0CompareCount: probe.summary?.return0CompareCount || probe.counts?.return0CompareCount || 0,
      rowParity: Boolean(probe.summary?.rowParity || probe.counts?.rowParity),
      operationParity: Boolean(probe.summary?.operationParity || probe.counts?.operationParity),
      streamContract: probe.streamContract || {},
      counts: probe.counts || {},
      invariants: (probe.invariants || []).map((invariant) => ({
        id: invariant.id,
        passed: Boolean(invariant.passed),
        details: invariant.details || "",
        impact: invariant.impact || "",
      })),
      streamRows: (probe.streamRows || []).slice(0, 32).map((row) => ({
        callSeq: row.callSeq,
        method: row.method || "",
        dispatchShape: row.dispatchShape || "",
        resource: row.resource || "",
        policy: row.policy || "",
        providerRefId: row.providerRefId || "",
        callerLabel: row.callerLabel || "",
        serviceReturnValue: row.serviceReturnValue,
        status: row.status || "",
      })),
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function loadProvider35C4TableWalkSummary(file = PROVIDER35C4_TABLE_WALK_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "Provider 0x35C4 table walk probe has not been generated",
    };
  }
  try {
    const probe = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      available: true,
      file,
      schema: probe.schema,
      status: probe.summary?.status || "",
      currentFinding: probe.summary?.currentFinding || "",
      emulatorImpact: probe.summary?.emulatorImpact || "",
      nextTarget: probe.summary?.nextTarget || "",
      visibleEffectsEnabled: Boolean(probe.summary?.visibleEffectsEnabled),
      failureCount: probe.summary?.failureCount || 0,
      laneCount: probe.summary?.laneCount || probe.counts?.laneCount || 0,
      expandedLaneCount: probe.summary?.expandedLaneCount || probe.counts?.expandedLaneCount || 0,
      guardedLaneCount: probe.summary?.guardedLaneCount || probe.counts?.guardedLaneCount || 0,
      producerOperationCount: probe.summary?.producerOperationCount || probe.counts?.producerOperationCount || 0,
      cursorReadOperationCount: probe.summary?.cursorReadOperationCount || probe.counts?.cursorReadOperationCount || 0,
      compareOperationCount: probe.summary?.compareOperationCount || probe.counts?.compareOperationCount || 0,
      knownRefCount: probe.summary?.knownRefCount || probe.counts?.knownRefCount || 0,
      tableEntryRefCount: probe.summary?.tableEntryRefCount || probe.counts?.tableEntryRefCount || 0,
      return0CompareCount: probe.summary?.return0CompareCount || probe.counts?.return0CompareCount || 0,
      tableContract: probe.tableContract || {},
      counts: probe.counts || {},
      invariants: (probe.invariants || []).map((invariant) => ({
        id: invariant.id,
        passed: Boolean(invariant.passed),
        details: invariant.details || "",
        impact: invariant.impact || "",
      })),
      lanes: (probe.lanes || []).slice(0, 16).map((lane) => ({
        laneIndex: lane.laneIndex,
        script: lane.script || "",
        policy: lane.policy || "",
        modeKey: lane.modeKey || "",
        status: lane.status || "",
        rangeEntriesWalked: lane.counts?.rangeEntriesWalked || 0,
        rangeRefsProduced: lane.counts?.rangeRefsProduced || 0,
        labelCompares: lane.counts?.labelCompares || 0,
        guardReasons: lane.guardReasons || [],
      })),
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function loadProvider35C4CountModeSummary(file = PROVIDER35C4_COUNT_MODE_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "Provider 0x35C4 count mode probe has not been generated",
    };
  }
  try {
    const probe = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      available: true,
      file,
      schema: probe.schema,
      status: probe.summary?.status || "",
      currentFinding: probe.summary?.currentFinding || "",
      emulatorImpact: probe.summary?.emulatorImpact || "",
      nextTarget: probe.summary?.nextTarget || "",
      visibleEffectsEnabled: Boolean(probe.summary?.visibleEffectsEnabled),
      failureCount: probe.summary?.failureCount || 0,
      selectedScriptCount: probe.summary?.selectedScriptCount || probe.counts?.selectedScriptCount || 0,
      changedSelectionCount: probe.summary?.changedSelectionCount || probe.counts?.changedSelectionCount || 0,
      unresolvedScriptCount: probe.summary?.unresolvedScriptCount || probe.counts?.unresolvedScriptCount || 0,
      topGuardedCandidateCount: probe.summary?.topGuardedCandidateCount || probe.counts?.topGuardedCandidateCount || 0,
      counts: probe.counts || {},
      invariants: (probe.invariants || []).map((invariant) => ({
        id: invariant.id,
        passed: Boolean(invariant.passed),
        details: invariant.details || "",
        impact: invariant.impact || "",
      })),
      scripts: (probe.scripts || []).slice(0, 16).map((script) => ({
        name: script.name || "",
        status: script.status || "",
        currentTopMode: script.currentTop?.modeKey || "",
        selectedMode: script.selected?.modeKey || "",
        selectedEntryCount: script.selected?.entryCount ?? null,
        selectedFinalRefCount: script.selected?.finalRefCount ?? null,
        promotableCandidateCount: script.promotableCandidateCount || 0,
        blockers: script.blockers || [],
      })),
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function loadProvider35C4SelectedTableSummary(file = PROVIDER35C4_SELECTED_TABLE_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "Provider 0x35C4 selected table walk probe has not been generated",
    };
  }
  try {
    const probe = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      available: true,
      file,
      schema: probe.schema,
      status: probe.summary?.status || "",
      currentFinding: probe.summary?.currentFinding || "",
      emulatorImpact: probe.summary?.emulatorImpact || "",
      nextTarget: probe.summary?.nextTarget || "",
      visibleEffectsEnabled: Boolean(probe.summary?.visibleEffectsEnabled),
      failureCount: probe.summary?.failureCount || 0,
      selectedScriptCount: probe.summary?.selectedScriptCount || probe.counts?.selectedScriptCount || 0,
      blockedScriptCount: probe.summary?.blockedScriptCount || probe.counts?.blockedScriptCount || 0,
      laneCount: probe.summary?.laneCount || probe.counts?.laneCount || 0,
      expandedLaneCount: probe.summary?.expandedLaneCount || probe.counts?.expandedLaneCount || 0,
      guardedLaneCount: probe.summary?.guardedLaneCount || probe.counts?.guardedLaneCount || 0,
      producerOperationCount: probe.summary?.producerOperationCount || probe.counts?.producerOperationCount || 0,
      cursorReadOperationCount: probe.summary?.cursorReadOperationCount || probe.counts?.cursorReadOperationCount || 0,
      compareOperationCount: probe.summary?.compareOperationCount || probe.counts?.compareOperationCount || 0,
      knownRefCount: probe.summary?.knownRefCount || probe.counts?.knownRefCount || 0,
      return0CompareCount: probe.summary?.return0CompareCount || probe.counts?.return0CompareCount || 0,
      selectedContract: probe.selectedContract || {},
      counts: probe.counts || {},
      invariants: (probe.invariants || []).map((invariant) => ({
        id: invariant.id,
        passed: Boolean(invariant.passed),
        details: invariant.details || "",
        impact: invariant.impact || "",
      })),
      lanes: (probe.lanes || []).slice(0, 16).map((lane) => ({
        laneIndex: lane.laneIndex,
        script: lane.script || "",
        policy: lane.policy || "",
        modeKey: lane.modeKey || "",
        status: lane.status || "",
        rangeEntriesWalked: lane.counts?.rangeEntriesWalked || 0,
        rangeRefsProduced: lane.counts?.rangeRefsProduced || 0,
        labelCompares: lane.counts?.labelCompares || 0,
        guardReasons: lane.guardReasons || [],
      })),
      blocked: (probe.blocked || []).map((row) => ({
        script: row.script || "",
        status: row.status || "",
        blockers: row.blockers || [],
      })),
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function loadProvider35C4S02SourceSummary(file = PROVIDER35C4_S02_SOURCE_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "Provider 0x35C4 s_02 source-mode probe has not been generated",
    };
  }
  try {
    const probe = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      available: true,
      file,
      schema: probe.schema,
      status: probe.summary?.status || "",
      currentFinding: probe.summary?.currentFinding || "",
      emulatorImpact: probe.summary?.emulatorImpact || "",
      nextTarget: probe.summary?.nextTarget || "",
      visibleEffectsEnabled: Boolean(probe.summary?.visibleEffectsEnabled),
      failureCount: probe.summary?.failureCount || 0,
      tailEndCandidateCount: probe.counts?.tailEndCandidateCount || 0,
      laneCount: probe.counts?.laneCount || 0,
      guardedLaneCount: probe.counts?.guardedLaneCount || 0,
      producerOperationCount: probe.counts?.producerOperationCount || 0,
      cursorReadOperationCount: probe.counts?.cursorReadOperationCount || 0,
      compareOperationCount: probe.counts?.compareOperationCount || 0,
      knownRefCount: probe.counts?.knownRefCount || 0,
      return0CompareCount: probe.counts?.return0CompareCount || 0,
      bounds: probe.bounds || {},
      selected: probe.selected ? {
        start: probe.selected.start || "",
        end: probe.selected.end || "",
        modeKey: probe.selected.modeKey || "",
        backfillCount: probe.selected.backfillCount || 0,
        entryCount: probe.selected.entryCount || 0,
        finalRefCount: probe.selected.finalRefCount || 0,
        textStartDelta: probe.selected.textStartDelta ?? null,
      } : null,
      attempts: (probe.attempts || []).map((attempt) => ({
        mode: attempt.mode || "",
        groupEnd: attempt.groupEnd || "",
        tailEnd: attempt.tailEnd || "",
        directGroups: attempt.directGroups ?? null,
        defaultGroups: attempt.defaultGroups ?? null,
        groupEndStartsInTextPool: Boolean(attempt.groupEndStartsInTextPool),
      })),
      invariants: (probe.invariants || []).map((invariant) => ({
        id: invariant.id,
        passed: Boolean(invariant.passed),
        details: invariant.details || "",
        impact: invariant.impact || "",
      })),
      lanes: (probe.lanes || []).slice(0, 8).map((lane) => ({
        laneIndex: lane.laneIndex,
        policy: lane.policy || "",
        modeKey: lane.modeKey || "",
        status: lane.status || "",
        rangeEntriesWalked: lane.counts?.rangeEntriesWalked || 0,
        rangeRefsProduced: lane.counts?.rangeRefsProduced || 0,
        labelCompares: lane.counts?.labelCompares || 0,
        guardReasons: lane.guardReasons || [],
      })),
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function loadProvider35C4SelectedFeedSummary(file = PROVIDER35C4_SELECTED_FEED_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "Provider 0x35C4 selected feed probe has not been generated",
    };
  }
  try {
    const probe = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      available: true,
      file,
      schema: probe.schema,
      status: probe.summary?.status || "",
      currentFinding: probe.summary?.currentFinding || "",
      emulatorImpact: probe.summary?.emulatorImpact || "",
      nextTarget: probe.summary?.nextTarget || "",
      visibleEffectsEnabled: Boolean(probe.summary?.visibleEffectsEnabled),
      failureCount: probe.summary?.failureCount || 0,
      selectedCompareCount: probe.summary?.selectedCompareCount || probe.feed?.selectedCompareCount || 0,
      observedMatchCount: probe.summary?.observedMatchCount || probe.feed?.observedMatchCount || 0,
      resolverMatchedCount: probe.summary?.resolverMatchedCount || probe.feed?.resolverMatchedCount || 0,
      promotionEligibleCount: probe.summary?.promotionEligibleCount || probe.feed?.promotionEligibleCount || 0,
      entrySafetyPromotableCount: probe.summary?.entrySafetyPromotableCount || probe.feed?.entrySafetyPromotableCount || 0,
      selectedTable: probe.selectedTable || {},
      feed: probe.feed || {},
      invariants: (probe.invariants || []).map((invariant) => ({
        id: invariant.id,
        passed: Boolean(invariant.passed),
        details: invariant.details || "",
        impact: invariant.impact || "",
      })),
      replayedCompares: (probe.replayedCompares || []).slice(0, 16).map((row) => ({
        seq: row.seq,
        script: row.script || "",
        policy: row.policy || "",
        entryIndex: row.entryIndex,
        label: row.label || "",
        refId: row.refId || "",
        returnValue: row.returnValue,
        resolverReturnValue: row.resolverReturnValue,
        resolverStatus: row.resolverStatus || "",
      })),
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function loadProvider35C4PromotionFrontierSummary(file = PROVIDER35C4_PROMOTION_FRONTIER_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "Provider 0x35C4 promotion frontier probe has not been generated",
    };
  }
  try {
    const probe = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      available: true,
      file,
      schema: probe.schema,
      status: probe.summary?.status || "",
      currentFinding: probe.summary?.currentFinding || "",
      emulatorImpact: probe.summary?.emulatorImpact || "",
      nextTarget: probe.summary?.nextTarget || "",
      visibleEffectsEnabled: Boolean(probe.summary?.visibleEffectsEnabled),
      failureCount: probe.summary?.failureCount || 0,
      selectedCompareCount: probe.summary?.selectedCompareCount || probe.counts?.selectedCompareCount || 0,
      sourceReturn0CompareCount: probe.summary?.sourceReturn0CompareCount || probe.counts?.sourceReturn0CompareCount || 0,
      schedulerCandidateIfObservedCount: probe.summary?.schedulerCandidateIfObservedCount || probe.counts?.schedulerCandidateIfObservedCount || 0,
      promotionEligibleIfObservedCount: probe.summary?.promotionEligibleIfObservedCount || probe.counts?.promotionEligibleIfObservedCount || 0,
      validCursorCompareCount: probe.counts?.validCursorCompareCount || 0,
      directCaseCompareCount: probe.counts?.directCaseCompareCount || 0,
      defaultOnlyCompareCount: probe.counts?.defaultOnlyCompareCount || 0,
      writebackBlockedCompareCount: probe.counts?.writebackBlockedCompareCount || 0,
      counts: probe.counts || {},
      sourceModes: probe.sourceModes || {},
      invariants: (probe.invariants || []).map((invariant) => ({
        id: invariant.id,
        passed: Boolean(invariant.passed),
        details: invariant.details || "",
        impact: invariant.impact || "",
      })),
      schedulerCandidates: (probe.schedulerCandidates || []).slice(0, 16).map((row) => ({
        seq: row.seq,
        script: row.script || "",
        policy: row.policy || "",
        entryIndex: row.entryIndex,
        label: row.label || "",
        providerRefId: row.providerRefId || "",
        field00: row.field00,
        groupId: row.groupId,
        target: row.target || "",
        operand0Hex: row.operand0Hex || "",
        stackDelta: row.stackDelta,
        status: row.status || "",
      })),
      directPromotionCandidates: (probe.directPromotionCandidates || []).slice(0, 16),
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function loadProvider35C4FrontierModeScanSummary(file = PROVIDER35C4_FRONTIER_MODE_SCAN_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "Provider 0x35C4 frontier mode scan probe has not been generated",
    };
  }
  try {
    const probe = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      available: true,
      file,
      schema: probe.schema,
      status: probe.summary?.status || "",
      currentFinding: probe.summary?.currentFinding || "",
      emulatorImpact: probe.summary?.emulatorImpact || "",
      nextTarget: probe.summary?.nextTarget || "",
      visibleEffectsEnabled: Boolean(probe.summary?.visibleEffectsEnabled),
      failureCount: probe.summary?.failureCount || 0,
      scannedCandidateCount: probe.summary?.scannedCandidateCount || probe.counts?.scannedCandidateCount || 0,
      poolCleanCandidateCount: probe.summary?.poolCleanCandidateCount || probe.counts?.poolCleanCandidateCount || 0,
      schedulerCandidateModeCount: probe.summary?.schedulerCandidateModeCount || probe.counts?.schedulerCandidateModeCount || 0,
      directPromotionCandidateModeCount: probe.summary?.directPromotionCandidateModeCount || probe.counts?.directPromotionCandidateModeCount || 0,
      schedulerCandidateScriptCount: probe.counts?.schedulerCandidateScriptCount || 0,
      directPromotionCandidateScriptCount: probe.counts?.directPromotionCandidateScriptCount || 0,
      counts: probe.counts || {},
      invariants: (probe.invariants || []).map((invariant) => ({
        id: invariant.id,
        passed: Boolean(invariant.passed),
        details: invariant.details || "",
        impact: invariant.impact || "",
      })),
      scripts: (probe.scripts || []).map((script) => ({
        name: script.name || "",
        sourceMode: script.sourceMode || {},
        scannedCandidateCount: script.scannedCandidateCount || 0,
        poolCleanCandidateCount: script.poolCleanCandidateCount || 0,
        schedulerCandidateModeCount: script.schedulerCandidateModeCount || 0,
        directPromotionCandidateModeCount: script.directPromotionCandidateModeCount || 0,
        topCandidates: (script.topCandidates || []).slice(0, 4).map((candidate) => ({
          source: candidate.source || "",
          start: candidate.start || "",
          modeKey: candidate.modeKey || "",
          entryCount: candidate.entryCount || 0,
          schedulerCandidateIfObservedCount: candidate.schedulerCandidateIfObservedCount || 0,
          promotionEligibleIfObservedCount: candidate.promotionEligibleIfObservedCount || 0,
          defaultOnlyIfObservedCount: candidate.defaultOnlyIfObservedCount || 0,
        })),
      })),
      schedulerCandidateModes: (probe.scripts || [])
        .flatMap((script) => script.schedulerCandidates || [])
        .slice(0, 16)
        .map((mode) => ({
          script: mode.script || "",
          source: mode.source || "",
          start: mode.start || "",
          modeKey: mode.modeKey || "",
          entryCount: mode.entryCount || 0,
          schedulerCandidateIfObservedCount: mode.schedulerCandidateIfObservedCount || 0,
          promotionEligibleIfObservedCount: mode.promotionEligibleIfObservedCount || 0,
          firstSchedulerRow: mode.schedulerRows?.[0] || null,
        })),
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function loadProvider35C4Return0PrioritySummary(file = PROVIDER35C4_RETURN0_PRIORITY_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "Provider 0x35C4 return-0 priority probe has not been generated",
    };
  }
  try {
    const probe = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      available: true,
      file,
      schema: probe.schema,
      status: probe.summary?.status || "",
      currentFinding: probe.summary?.currentFinding || "",
      emulatorImpact: probe.summary?.emulatorImpact || "",
      nextTarget: probe.summary?.nextTarget || "",
      visibleEffectsEnabled: Boolean(probe.summary?.visibleEffectsEnabled),
      failureCount: probe.summary?.failureCount || 0,
      selectedPriorityRowCount: probe.summary?.selectedPriorityRowCount || probe.counts?.selectedPriorityRowCount || 0,
      selectedKnownProviderRefRowCount: probe.counts?.selectedKnownProviderRefRowCount || 0,
      modePriorityRowCount: probe.summary?.modePriorityRowCount || probe.counts?.modePriorityRowCount || 0,
      modePriorityModeCount: probe.counts?.modePriorityModeCount || 0,
      knownProviderRefRowCount: probe.counts?.knownProviderRefRowCount || 0,
      unknownProviderRefRowCount: probe.counts?.unknownProviderRefRowCount || 0,
      directCasePriorityRowCount: probe.summary?.directCasePriorityRowCount || probe.counts?.directCasePriorityRowCount || 0,
      executablePriorityRowCount: probe.counts?.executablePriorityRowCount || 0,
      priorityScriptCount: probe.counts?.priorityScriptCount || 0,
      capturePoints: probe.capturePoints || {},
      summaryByScript: (probe.summaryByScript || []).map((row) => ({
        script: row.script || "",
        selectedRows: row.selectedRows || 0,
        modeRows: row.modeRows || 0,
        uniqueModeKeyCount: row.uniqueModeKeyCount || 0,
        labels: row.labels || [],
        directRows: row.directRows || 0,
      })),
      selectedPriorities: (probe.selectedPriorities || []).slice(0, 12).map((row) => ({
        priority: row.priority,
        script: row.script || "",
        policy: row.policy || "",
        modeKey: row.modeKey || "",
        entryIndex: row.entryIndex,
        label: row.label || "",
        providerRefId: row.providerRefId || "",
        refRaw: row.refRaw || "",
        cursor: row.cursor,
        groupId: row.groupId,
        target: row.target || "",
        blocker: row.blocker || "",
      })),
      modeScanPriorities: (probe.modeScanPriorities || []).slice(0, 16).map((row) => ({
        priority: row.priority,
        tier: row.tier || "",
        script: row.script || "",
        start: row.start || "",
        modeKey: row.modeKey || "",
        entryIndex: row.entryIndex,
        label: row.label || "",
        refRaw: row.refRaw || "",
        cursor: row.cursor,
        groupId: row.groupId,
        target: row.target || "",
        blocker: row.blocker || "",
      })),
      invariants: (probe.invariants || []).map((invariant) => ({
        id: invariant.id,
        passed: Boolean(invariant.passed),
        details: invariant.details || "",
        impact: invariant.impact || "",
      })),
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function loadProvider35C4Return0InjectionSummary(file = PROVIDER35C4_RETURN0_INJECTION_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "Provider 0x35C4 return-0 injection probe has not been generated",
    };
  }
  try {
    const probe = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      available: true,
      file,
      schema: probe.schema,
      status: probe.summary?.status || "",
      currentFinding: probe.summary?.currentFinding || "",
      emulatorImpact: probe.summary?.emulatorImpact || "",
      nextTarget: probe.summary?.nextTarget || "",
      visibleEffectsEnabled: Boolean(probe.summary?.visibleEffectsEnabled),
      failureCount: probe.summary?.failureCount || 0,
      p1PriorityRowCount: probe.counts?.p1PriorityRowCount || 0,
      syntheticObservedMatchCount: probe.summary?.syntheticObservedMatchCount || probe.counts?.syntheticObservedMatchCount || 0,
      resolverMatchedCount: probe.summary?.resolverMatchedCount || probe.counts?.resolverMatchedCount || 0,
      joinedFrontierRowCount: probe.counts?.joinedFrontierRowCount || 0,
      schedulerOnlyRowCount: probe.counts?.schedulerOnlyRowCount || 0,
      directCaseRowCount: probe.summary?.directCaseRowCount || probe.counts?.directCaseRowCount || 0,
      executableRowCount: probe.summary?.executableRowCount || probe.counts?.executableRowCount || 0,
      replayRows: (probe.replayRows || []).slice(0, 12).map((row) => ({
        priority: row.priority,
        script: row.script || "",
        policy: row.policy || "",
        entryIndex: row.entryIndex,
        label: row.label || "",
        providerRefId: row.providerRefId || "",
        resolverReturnValue: row.resolverReturnValue,
        frontierStatus: row.frontierStatus || "",
        target: row.target || "",
        directCaseIfObserved: Boolean(row.directCaseIfObserved),
      })),
      invariants: (probe.invariants || []).map((invariant) => ({
        id: invariant.id,
        passed: Boolean(invariant.passed),
        details: invariant.details || "",
        impact: invariant.impact || "",
      })),
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function loadProvider35C4Return0CaptureSummary(file = PROVIDER35C4_RETURN0_CAPTURE_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "Provider 0x35C4 return-0 capture adapter probe has not been generated",
    };
  }
  try {
    const probe = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      available: true,
      file,
      schema: probe.schema,
      status: probe.summary?.status || "",
      currentFinding: probe.summary?.currentFinding || "",
      emulatorImpact: probe.summary?.emulatorImpact || "",
      nextTarget: probe.summary?.nextTarget || "",
      visibleEffectsEnabled: Boolean(probe.summary?.visibleEffectsEnabled),
      failureCount: probe.summary?.failureCount || 0,
      importedObservationCount: probe.summary?.importedObservationCount || probe.counts?.importedObservationCount || 0,
      invalidObservationCount: probe.counts?.invalidObservationCount || 0,
      return0ObservationCount: probe.counts?.return0ObservationCount || 0,
      observedFeedRowCount: probe.summary?.observedFeedRowCount || probe.counts?.observedFeedRowCount || 0,
      p1PriorityRowCount: probe.counts?.p1PriorityRowCount || 0,
      p1MatchedCount: probe.summary?.p1MatchedCount || probe.counts?.p1MatchedCount || 0,
      modeScanMatchedCount: probe.summary?.modeScanMatchedCount || probe.counts?.modeScanMatchedCount || 0,
      directCaseObservedCount: probe.summary?.directCaseObservedCount || probe.counts?.directCaseObservedCount || 0,
      executableObservedCount: probe.summary?.executableObservedCount || probe.counts?.executableObservedCount || 0,
      captureSource: probe.captureSource || {},
      p1Replays: (probe.p1Replays || []).slice(0, 12).map((row) => ({
        priority: row.priority,
        script: row.script || "",
        policy: row.policy || "",
        entryIndex: row.entryIndex,
        label: row.label || "",
        providerRefId: row.providerRefId || "",
        resolverReturnValue: row.resolverReturnValue,
        frontierStatus: row.frontierStatus || "",
        directCaseIfObserved: Boolean(row.directCaseIfObserved),
      })),
      observedMatches: (probe.observedMatches || []).slice(0, 12).map((row) => ({
        importSeq: row.importSeq,
        script: row.script || "",
        policy: row.policy || "",
        label: row.label || "",
        providerRefId: row.providerRefId || "",
        returnValue: row.returnValue,
      })),
      invariants: (probe.invariants || []).map((invariant) => ({
        id: invariant.id,
        passed: Boolean(invariant.passed),
        details: invariant.details || "",
        impact: invariant.impact || "",
      })),
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function loadProvider35C4CapturedFeedSummary(file = PROVIDER35C4_CAPTURED_FEED_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "Provider 0x35C4 captured selected feed probe has not been generated",
    };
  }
  try {
    const probe = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      available: true,
      file,
      schema: probe.schema,
      status: probe.summary?.status || "",
      currentFinding: probe.summary?.currentFinding || "",
      emulatorImpact: probe.summary?.emulatorImpact || "",
      nextTarget: probe.summary?.nextTarget || "",
      visibleEffectsEnabled: Boolean(probe.summary?.visibleEffectsEnabled),
      failureCount: probe.summary?.failureCount || 0,
      selectedCompareCount: probe.summary?.selectedCompareCount || probe.counts?.selectedCompareCount || 0,
      expectedCompareCount: probe.counts?.expectedCompareCount || 0,
      observedFeedRowCount: probe.summary?.observedFeedRowCount || probe.counts?.observedFeedRowCount || 0,
      resolverMatchedCount: probe.summary?.resolverMatchedCount || probe.counts?.resolverMatchedCount || 0,
      frontierJoinedCount: probe.counts?.frontierJoinedCount || 0,
      schedulerMatchedCount: probe.counts?.schedulerMatchedCount || 0,
      directMatchedCount: probe.summary?.directMatchedCount || probe.counts?.directMatchedCount || 0,
      executableMatchedCount: probe.summary?.executableMatchedCount || probe.counts?.executableMatchedCount || 0,
      captureAdapter: probe.captureAdapter || {},
      matchedRows: (probe.matchedRows || []).slice(0, 12).map((row) => ({
        seq: row.seq,
        script: row.script || "",
        policy: row.policy || "",
        entryIndex: row.entryIndex,
        label: row.label || "",
        refId: row.refId || "",
        frontierStatus: row.frontierStatus || "",
        directCaseIfObserved: Boolean(row.directCaseIfObserved),
      })),
      invariants: (probe.invariants || []).map((invariant) => ({
        id: invariant.id,
        passed: Boolean(invariant.passed),
        details: invariant.details || "",
        impact: invariant.impact || "",
      })),
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function loadProvider35C4ObservationRecorderSummary(file = PROVIDER35C4_OBSERVATION_RECORDER_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "Provider 0x35C4 observation recorder probe has not been generated",
    };
  }
  try {
    const probe = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      available: true,
      file,
      schema: probe.schema,
      status: probe.summary?.status || "",
      currentFinding: probe.summary?.currentFinding || "",
      emulatorImpact: probe.summary?.emulatorImpact || "",
      nextTarget: probe.summary?.nextTarget || "",
      visibleEffectsEnabled: Boolean(probe.summary?.visibleEffectsEnabled),
      failureCount: probe.summary?.failureCount || 0,
      selectedObservationCount: probe.summary?.selectedObservationCount || probe.counts?.selectedObservationCount || 0,
      selectedExpectedCompareCount: probe.counts?.selectedExpectedCompareCount || 0,
      selectedOperationCompareCount: probe.counts?.selectedOperationCompareCount || 0,
      streamObservationCount: probe.summary?.streamObservationCount || probe.counts?.streamObservationCount || 0,
      streamExpectedCompareCount: probe.counts?.streamExpectedCompareCount || 0,
      totalObservationCount: probe.summary?.totalObservationCount || probe.counts?.totalObservationCount || 0,
      adapterCompatibleObservationCount: probe.counts?.adapterCompatibleObservationCount || 0,
      invalidObservationCount: probe.counts?.invalidObservationCount || 0,
      observedFeedRowCount: probe.summary?.observedFeedRowCount || probe.counts?.observedFeedRowCount || 0,
      nonMatchObservationCount: probe.summary?.nonMatchObservationCount || probe.counts?.nonMatchObservationCount || 0,
      adapterCheck: probe.adapterCheck || {},
      selectedFeedCheck: probe.selectedFeedCheck || {},
      output: probe.output || {},
      capturePoint: probe.capturePoint || {},
      invariants: (probe.invariants || []).map((invariant) => ({
        id: invariant.id,
        passed: Boolean(invariant.passed),
        details: invariant.details || "",
        impact: invariant.impact || "",
      })),
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function loadProvider35C4RuntimeSinkSummary(file = PROVIDER35C4_RUNTIME_SINK_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "Provider 0x35C4 runtime sink probe has not been generated",
    };
  }
  try {
    const probe = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      available: true,
      file,
      schema: probe.schema,
      status: probe.summary?.status || "",
      currentFinding: probe.summary?.currentFinding || "",
      emulatorImpact: probe.summary?.emulatorImpact || "",
      nextTarget: probe.summary?.nextTarget || "",
      visibleEffectsEnabled: Boolean(probe.summary?.visibleEffectsEnabled),
      failureCount: probe.summary?.failureCount || 0,
      selectedObservationCount: probe.summary?.selectedObservationCount || probe.counts?.selectedObservationCount || 0,
      selectedExpectedCompareCount: probe.counts?.selectedExpectedCompareCount || 0,
      streamObservationCount: probe.summary?.streamObservationCount || probe.counts?.streamObservationCount || 0,
      streamExpectedCompareCount: probe.counts?.streamExpectedCompareCount || 0,
      totalObservationCount: probe.summary?.totalObservationCount || probe.counts?.totalObservationCount || 0,
      adapterCompatibleObservationCount: probe.counts?.adapterCompatibleObservationCount || 0,
      invalidObservationCount: probe.counts?.invalidObservationCount || 0,
      observedFeedRowCount: probe.summary?.observedFeedRowCount || probe.counts?.observedFeedRowCount || 0,
      nonMatchObservationCount: probe.summary?.nonMatchObservationCount || probe.counts?.nonMatchObservationCount || 0,
      selectedMissingEntryMetadataCount: probe.counts?.selectedMissingEntryMetadataCount || 0,
      adapterCheck: probe.adapterCheck || {},
      output: probe.output || {},
      invariants: (probe.invariants || []).map((invariant) => ({
        id: invariant.id,
        passed: Boolean(invariant.passed),
        details: invariant.details || "",
        impact: invariant.impact || "",
      })),
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function loadCbeRuntimeCoreSummary(file = CBE_RUNTIME_CORE_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "CBE runtime core probe has not been generated",
    };
  }
  try {
    const probe = JSON.parse(fs.readFileSync(file, "utf8"));
    const counts = probe.provider35c4?.counts || {};
    const adapterCheck = probe.provider35c4?.adapterCheck || {};
    const selectedFeedCheck = probe.provider35c4?.selectedFeedCheck || {};
    return {
      available: true,
      file,
      schema: probe.schema,
      status: probe.summary?.status || "",
      currentFinding: probe.summary?.currentFinding || "",
      emulatorImpact: probe.summary?.emulatorImpact || "",
      nextTarget: probe.summary?.nextTarget || "",
      visibleEffectsEnabled: Boolean(probe.summary?.visibleEffectsEnabled),
      failureCount: probe.summary?.failureCount || 0,
      corpusReadyCount: probe.summary?.corpusReadyCount || probe.corpus?.readyCount || 0,
      corpusFileCount: probe.summary?.corpusFileCount || probe.corpus?.fileCount || 0,
      resourceCount: probe.summary?.resourceCount || probe.source?.resourceCount || 0,
      sectionCount: probe.source?.sectionCount || 0,
      selectedObservationCount: counts.selectedObservationCount || 0,
      selectedExpectedCompareCount: counts.selectedExpectedCompareCount || 0,
      streamObservationCount: counts.streamObservationCount || 0,
      streamExpectedCompareCount: counts.streamExpectedCompareCount || 0,
      totalObservationCount: probe.summary?.providerObservationCount || counts.totalObservationCount || 0,
      adapterCompatibleObservationCount: counts.adapterCompatibleObservationCount || 0,
      invalidObservationCount: counts.invalidObservationCount || 0,
      observedFeedRowCount: probe.summary?.providerFeedRowCount || counts.observedFeedRowCount || 0,
      nonMatchObservationCount: counts.nonMatchObservationCount || 0,
      selectedMissingEntryMetadataCount: counts.selectedMissingEntryMetadataCount || 0,
      adapterCheck,
      selectedFeedCheck,
      output: probe.output || {},
      surfaces: probe.provider35c4?.surfaces || counts.surfaces || {},
      invariants: (probe.invariants || []).map((invariant) => ({
        id: invariant.id,
        passed: Boolean(invariant.passed),
        details: invariant.details || "",
        impact: invariant.impact || "",
      })),
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function loadCbeRuntimeCoreSceneSummary(file = CBE_RUNTIME_CORE_SCENE_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "CBE runtime core scene probe has not been generated",
    };
  }
  try {
    const probe = JSON.parse(fs.readFileSync(file, "utf8"));
    const counts = probe.counts || {};
    const compatibility = probe.compatibility || {};
    const compatibilityCorpus = compatibility.corpus || {};
    const sceneGames = (probe.games || [])
      .filter((game) => game.status === "core-scene-emulator-ready")
      .map((game) => ({
        game: game.game || "",
        status: game.status || "",
        sceneCount: game.sceneCount || 0,
        readySceneCount: game.readySceneCount || 0,
        sceneErrorCount: game.sceneErrorCount || 0,
        firstScene: game.firstScene || "",
        firstSceneRel: game.firstSceneRel || "",
        canvas: game.canvas || null,
        mapName: game.mapName || "",
        tileset: game.tileset || "",
        mapTraceStatus: game.mapTraceStatus || "",
        mapTraceAtlas: game.mapTraceAtlas || "",
        mapDrawCandidateCount: game.mapDrawCandidateCount || 0,
        mapRleCandidateCount: game.mapRleCandidateCount || 0,
        mapTileGridCandidate: Boolean(game.mapTileGridCandidate),
        mapTileGridCellCount: game.mapTileGridCellCount || 0,
        entityCount: game.entityCount || 0,
        scriptCount: game.scriptCount || 0,
        initialMode: game.initialMode || "",
        finalMode: game.finalMode || "",
        finalFrameKind: game.finalFrameKind || "",
        finalTick: game.finalTick || 0,
        inputFinalMode: game.inputFinalMode || "",
        inputFinalFrameKind: game.inputFinalFrameKind || "",
        inputFinalTick: game.inputFinalTick || 0,
      }));
    return {
      available: true,
      file,
      schema: probe.schema,
      status: probe.summary?.status || "",
      currentFinding: probe.summary?.currentFinding || "",
      emulatorImpact: probe.summary?.emulatorImpact || "",
      nextTarget: probe.summary?.nextTarget || "",
      visibleEffectsEnabled: Boolean(probe.summary?.visibleEffectsEnabled),
      failureCount: probe.summary?.failureCount || 0,
      fileCount: counts.fileCount || 0,
      coreReadyCount: counts.coreReadyCount || 0,
      sceneGameCount: probe.summary?.sceneGameCount || counts.sceneGameCount || 0,
      readySceneGameCount: probe.summary?.readySceneGameCount || counts.readySceneGameCount || 0,
      sceneResourceCount: probe.summary?.sceneResourceCount || counts.sceneResourceCount || 0,
      readySceneResourceCount: probe.summary?.readySceneResourceCount || counts.readySceneResourceCount || 0,
      sceneErrorCount: counts.sceneErrorCount || 0,
      sceneResourceErrorCount: counts.sceneResourceErrorCount || 0,
      canvasReadyCount: counts.canvasReadyCount || 0,
      finalSceneFrameCount: probe.summary?.finalSceneFrameCount || counts.finalSceneFrameCount || 0,
      inputSceneFrameCount: probe.summary?.inputSceneFrameCount || counts.inputSceneFrameCount || 0,
      mapLinkedSceneCount: compatibilityCorpus.mapLinkedSceneCount || 0,
      mapTableSceneCount: compatibilityCorpus.mapTableSceneCount || 0,
      lengthPrefixedMapSceneCount: compatibilityCorpus.lengthPrefixedMapSceneCount || 0,
      tilesetLinkedSceneCount: compatibilityCorpus.tilesetLinkedSceneCount || 0,
      mapTraceSceneCount: compatibilityCorpus.mapTraceSceneCount || 0,
      mapAtlasSizedSceneCount: compatibilityCorpus.mapAtlasSizedSceneCount || 0,
      mapDrawCandidateSceneCount: compatibilityCorpus.mapDrawCandidateSceneCount || 0,
      mapRleCandidateSceneCount: compatibilityCorpus.mapRleCandidateSceneCount || 0,
      mapTileGridCandidateSceneCount: compatibilityCorpus.mapTileGridCandidateSceneCount || 0,
      entitySceneCount: compatibilityCorpus.entitySceneCount || 0,
      scriptLinkedSceneCount: compatibilityCorpus.scriptLinkedSceneCount || 0,
      bootFlowSceneCount: compatibilityCorpus.bootFlowSceneCount || 0,
      actions: probe.actions || [],
      sceneGames,
      compatibility,
      godwarAnchor: sceneGames.find((game) => game.game === "众神之战") || null,
      invariants: (probe.invariants || []).map((invariant) => ({
        id: invariant.id,
        passed: Boolean(invariant.passed),
        details: invariant.details || "",
        impact: invariant.impact || "",
      })),
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function loadCopyHelperSummary(file = COPY_HELPER_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "copy helper probe has not been generated",
    };
  }
  try {
    const probe = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      available: true,
      file,
      schema: probe.schema,
      status: probe.summary?.status || "",
      currentFinding: probe.summary?.currentFinding || "",
      emulatorImpact: probe.summary?.emulatorImpact || "",
      nextTarget: probe.summary?.nextTarget || "",
      copyCallCount: probe.summary?.copyCallCount || 0,
      callsByTarget: probe.summary?.callsByTarget || {},
      writebackCopyCall: probe.summary?.writebackCopyCall || "",
      writebackLocalNullGuard: Boolean(probe.summary?.writebackLocalNullGuard),
      copyLikeHelperEvidence: Boolean(probe.summary?.copyLikeHelperEvidence),
      helperNullSafeProven: Boolean(probe.summary?.helperNullSafeProven),
      writebackSite: probe.writebackSite || null,
      helpers: (probe.helpers || []).map((helper) => ({
        target: helper.target,
        helper: helper.helper,
        copyLike: Boolean(helper.copyLike),
        nullSafeProven: Boolean(helper.nullSafeProven),
        firstStoreThroughR0: helper.firstStoreThroughR0 || "",
      })),
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function loadSlotAuditSummary(file = SLOT_AUDIT_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "XSE service-slot audit has not been generated",
    };
  }
  try {
    const audit = JSON.parse(fs.readFileSync(file, "utf8"));
    const plus50Rows = (audit.slotWrites || [])
      .filter((row) => row.slot === 0x50)
      .map((row) => {
        const seen = new Set();
        const notable = [];
        for (const candidate of row.candidates || []) {
          const target = candidate.thumb;
          if (seen.has(target)) continue;
          seen.add(target);
          notable.push({
            target: hex(target, 8),
            kind: candidate.candidateKind,
            status: candidate.verdict?.status || "",
            reason: candidate.verdict?.reason || "",
          });
          if (notable.length >= 3) break;
        }
        return {
          store: hex(row.store, 8),
          base: row.base,
          bestTarget: notable[0]?.target || "",
          bestStatus: notable[0]?.status || "",
          notable,
        };
      });
    return {
      available: true,
      file,
      schema: audit.schema,
      currentBlocker: audit.conclusion?.currentBlocker || "",
      newFalsification: audit.conclusion?.newFalsification || "",
      nextTarget: audit.conclusion?.nextTarget || "",
      slotWriteCount: audit.slotWriteCount || 0,
      plus50WriteCount: audit.plus50WriteCount || plus50Rows.length,
      plus50Rows,
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function loadServiceLifecycleSummary(file = SERVICE_LIFECYCLE_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "XSE service lifecycle trace has not been generated",
    };
  }
  try {
    const trace = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      available: true,
      file,
      schema: trace.schema,
      currentFinding: trace.conclusion?.currentFinding || "",
      bootChain: trace.conclusion?.bootChain || "",
      falsePositive: trace.conclusion?.falsePositive || "",
      nextTarget: trace.conclusion?.nextTarget || "",
      services: (trace.services || []).map((service) => ({
        target: service.targetHex || hex(service.target, 4),
        description: service.description,
        hitCount: service.hitCount || 0,
        classCounts: service.classCounts || {},
        slotCounts: service.slotCounts || {},
        directWriteLikeCount: service.directWriteLikeCount || 0,
      })),
      directBranchRefs: trace.directBranchRefs || [],
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function loadLoaderCallersSummary(file = LOADER_CALLERS_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "XSE loader caller trace has not been generated",
    };
  }
  try {
    const trace = JSON.parse(fs.readFileSync(file, "utf8"));
    const byTarget = new Map((trace.directBranchRefs || []).map((ref) => [ref.targetHex || hex(ref.target, 8), ref]));
    return {
      available: true,
      file,
      schema: trace.schema,
      finding: trace.conclusion?.finding || "",
      serviceCaller: trace.conclusion?.serviceCaller || "",
      wrapperCaller: trace.conclusion?.wrapperCaller || "",
      nextTarget: trace.conclusion?.nextTarget || "",
      x112c4CallSites: byTarget.get("0x000112C4")?.sites || [],
      wrapperRefs: ["0x00000934", "0x00000958"].map((target) => {
        const ref = byTarget.get(target);
        return {
          target,
          count: ref?.count || 0,
          sites: ref?.sites || [],
          truncated: Boolean(ref?.truncated),
        };
      }),
      windows: (trace.windows || []).map((window) => ({
        name: window.name,
        call: window.callHex,
        start: window.startHex,
        shape: window.shape,
      })),
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function loadWrapperFacadeSummary(file = WRAPPER_FACADE_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "XSE wrapper facade trace has not been generated",
    };
  }
  try {
    const trace = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      available: true,
      file,
      schema: trace.schema,
      finding: trace.conclusion?.finding || "",
      literalAlignment: trace.conclusion?.literalAlignment || "",
      facadeMap: trace.conclusion?.facadeMap || "",
      runtimeBridge: trace.conclusion?.runtimeBridge || "",
      nextTarget: trace.conclusion?.nextTarget || "",
      manager: trace.manager || {},
      focusWrappers: (trace.focusWrappers || []).map((wrapper) => ({
        start: wrapper.startHex,
        directBranchCount: wrapper.directBranchCount || 0,
        root: wrapper.managerRootGlobal,
        group: wrapper.groupOffset,
        methodSlot: wrapper.methodLoad?.slotHex || "",
        path: wrapper.dispatchPath || "",
        absoluteMethodOffset: wrapper.absoluteMethodOffset || "",
      })),
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function loadFacadeSlotSummary(file = FACADE_SLOTS_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "XSE facade slot trace has not been generated",
    };
  }
  try {
    const trace = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      available: true,
      file,
      schema: trace.schema,
      finding: trace.conclusion?.finding || "",
      guardrail: trace.conclusion?.guardrail || "",
      nextTarget: trace.conclusion?.nextTarget || "",
      focusHitCount: trace.focusHitCount || 0,
      nearbyHitCount: trace.nearbyHitCount || 0,
      facadeResolutions: (trace.facadeResolutions || []).map((item) => ({
        wrapper: item.wrapperHex,
        offset: item.relativeOffsetHex,
        status: item.status,
        bestTarget: item.bestCandidate?.thumb || "",
        hitCount: item.hitCount || 0,
        store: item.hits?.[0] ? `${item.hits[0].window} ${item.hits[0].storeHex}` : "",
      })),
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function loadManagerRootSummary(file = MANAGER_ROOT_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "XSE manager root trace has not been generated",
    };
  }
  try {
    const trace = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      available: true,
      file,
      schema: trace.schema,
      finding: trace.conclusion?.finding || "",
      bootBridge: trace.conclusion?.bootBridge || "",
      facadeImpact: trace.conclusion?.facadeImpact || "",
      nextTarget: trace.conclusion?.nextTarget || "",
      assignments: (trace.assignments || []).map((item) => ({
        site: item.siteHex,
        targetGlobal: item.targetGlobalHex,
        source: item.source,
        meaning: item.meaning,
      })),
      directBranchRefs: trace.directBranchRefs || [],
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function loadFacadeEquivalenceSummary(file = FACADE_EQUIV_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "XSE facade equivalence trace has not been generated",
    };
  }
  try {
    const trace = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      available: true,
      file,
      schema: trace.schema,
      finding: trace.conclusion?.finding || "",
      emulatorImpact: trace.conclusion?.emulatorImpact || "",
      nextTarget: trace.conclusion?.nextTarget || "",
      equivalences: (trace.equivalences || []).map((item) => ({
        role: item.role,
        directSite: item.directSiteHex,
        directService: item.directService,
        wrapperSite: item.wrapperSiteHex,
        wrapper: item.wrapper,
        semantic: item.semantic,
      })),
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function loadFacadeNormalizedSummary(file = FACADE_NORM_JSON) {
  if (!fs.existsSync(file)) {
    return {
      available: false,
      file,
      reason: "XSE facade-normalized reader probe has not been generated",
    };
  }
  try {
    const probe = JSON.parse(fs.readFileSync(file, "utf8"));
    const scripts = (probe.summary || []).map((script) => ({
      name: script.name,
      baseOffset: script.baseOffset || "",
      headerOk: Boolean(script.headerOk),
      groupCount: script.groupCount ?? null,
      current50Strict: Boolean(script.current50Strict),
      current50Aligned: Boolean(script.current50Aligned),
      loose50Strict: Boolean(script.loose50Strict),
      loose50Aligned: Boolean(script.loose50Aligned),
      bestLooseEnd: script.bestLooseEnd || "",
      layoutEnd: script.layoutEnd || "",
      bestLooseDelta: script.bestLooseDelta ?? null,
    }));
    const currentAligned = scripts.filter((script) => script.current50Aligned).length;
    const looseAligned = scripts.filter((script) => script.loose50Aligned).length;
    const looseStrict = scripts.filter((script) => script.loose50Strict).length;
    return {
      available: true,
      file,
      schema: probe.schema,
      scriptCount: scripts.length,
      currentAligned,
      looseAligned,
      looseStrict,
      normalizedReader: probe.normalizedReader || {},
      finding: `Facade-normalized +0x4C/0x934 replay still has ${currentAligned}/${scripts.length} layout-aligned paths under current +0x50; loose +0x50 gives ${looseStrict}/${scripts.length} shallow opcode-only paths and ${looseAligned}/${scripts.length} aligned paths.`,
      nextTarget: "Resolve the 0x11300..0x1130E stream conversion and exact [sb+0x35C4]+0x50 cursor method before accepting any executable XSE decoder.",
      scripts,
    };
  } catch (err) {
    return {
      available: false,
      file,
      reason: err.message || String(err),
    };
  }
}

function buildWireSummary(input, scriptNames) {
  try {
    const wire = buildWireProbe({ input, names: scriptNames });
    return {
      schema: wire.schema,
      handlerCommands: wire.handlerTable.commandCount,
      dataTablesWithoutXse0: wire.dataTables.map((entry) => entry.name),
      scripts: wire.scripts.map((script) => ({
        name: script.name,
        kind: script.kind,
        textPoolStart: script.pools.textPoolStart,
        symbolPoolStart: script.pools.symbolPoolStart,
        strictOpcodeGate: script.objectProbe?.strictOpcodeGate || null,
        strictCandidateSummary: script.strictRecordCandidates.slice(0, 3).map((candidate) => ({
          start: candidate.start,
          end: candidate.end,
          groups: candidate.groups,
          records: candidate.records,
          gapToPool: candidate.gapToPool,
        })),
        exactHandlerAtoms: script.symbolAtoms
          .filter((atom) => atom.kind === "exact-len-slot")
          .map((atom) => ({
            offset: atom.offset,
            name: atom.name,
            command: atom.command,
            reads: atom.handler?.reads || [],
            controls: atom.handler?.controls || [],
          })),
        fragmentHandlerAtoms: script.symbolAtoms
          .filter((atom) => atom.kind === "fragment-alias")
          .map((atom) => ({
            offset: atom.offset,
            visible: atom.name,
            command: atom.command,
            reads: atom.handler?.reads || [],
            controls: atom.handler?.controls || [],
          })),
      })),
    };
  } catch (err) {
    return { error: err.message || String(err) };
  }
}

function bootPreambleSummary(archive) {
  const firstSection = archive.sections[0];
  const preamble = firstSection ? archive.buffer.subarray(0, firstSection.offset) : Buffer.alloc(0);
  const strings = [
    ...asciiRuns(preamble, 4, 120).map((run) => ({ encoding: "ascii", offset: hex(run.offset, 6), text: run.text })),
    ...scanTextRuns(preamble, 4, 120).map((run) => ({ encoding: "text", offset: hex(run.offset, 6), text: run.text })),
  ];
  const seen = new Set();
  return {
    length: preamble.length,
    lengthHex: hex(preamble.length),
    firstSectionOffset: firstSection ? hex(firstSection.offset) : "",
    strings: strings.filter((run) => {
      const key = `${run.offset}:${run.text}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 40),
  };
}

function buildTrueRuntime(options = {}) {
  const input = path.resolve(options.input || DEFAULT_INPUT);
  const sceneName = options.scene || DEFAULT_SCENE;
  const archive = loadCbeArchive(input);
  const catalog = buildCatalog(archive);
  const sceneEntry = findEntry(archive, sceneName);
  if (!sceneEntry) throw new Error(`Scene not found in raw CBE: ${sceneName}`);

  const scene = summarizeResourceFromCbe(archive, catalog, sceneEntry);
  const scenePayload = readResource(archive, sceneEntry).fixed;
  const sceneRefs = refsFromSceneBuffer(scenePayload);
  const sceneScriptNames = sceneRefs.filter((ref) => ref.ext === ".xse").map((ref) => ref.text);
  const scriptNames = Array.from(new Set([
    ...BOOT_RESOURCE_HINTS.filter((name) => extOf(name) === ".xse"),
    ...sceneScriptNames,
  ].map(normalizeName)));
  const scriptProbes = scriptNames.map((scriptName) => {
    const entry = findEntry(archive, scriptName);
    if (!entry) return { name: scriptName, strictStatus: "missing", strictReason: "script referenced by scene/bootstrap was not found in raw CBE" };
    return strictXseProbe(archive, entry);
  });
  const readerService = loadReaderServiceSummary();
  const vmGate = loadVmGateSummary();
  const streamPrep = loadStreamPrepSummary();
  const streamService = loadStreamServiceSummary();
  const providerService = loadProviderServiceSummary();
  const providerReplay = loadProviderReplaySummary();
  const cursor50Variants = loadCursor50VariantSummary();
  const providerAbi = loadProviderAbiSummary();
  const providerAbiShim = loadProviderAbiShimSummary();
  const xseSwitchReplay = loadXseSwitchReplaySummary();
  const xseRuntimeDispatch = loadXseRuntimeDispatchSummary();
  const xseDispatchCases = loadXseDispatchCaseSummary();
  const xseTraceVm = loadXseTraceVmSummary();
  const xseWriteback = loadXseWritebackSummary();
  const xseCursorInit = loadXseCursorInitSummary();
  const xseSlotLifecycle = loadXseSlotLifecycleSummary();
  const xseOperandBinding = loadXseOperandBindingSummary();
  const xseEntrypoint = loadXseEntrypointSummary();
  const xseEntryLabel = loadXseEntryLabelSummary();
  const xseEntryCaller = loadXseEntryCallerSummary();
  const xseEntryCompare = loadXseEntryCompareSummary();
  const xseLabelPointer = loadXseLabelPointerSummary();
  const xseRefEncoding = loadXseRefEncodingSummary();
  const xseCompareNormalization = loadXseCompareNormalizationSummary();
  const xseTailBoundary = loadXseTailBoundarySummary();
  const xseCompareService = loadXseCompareServiceSummary();
  const xseCompareShim = loadXseCompareShimSummary();
  const xseActivation = loadXseActivationSummary();
  const xseActivatedDispatch = loadXseActivatedDispatchSummary();
  const xseActivatedOperand = loadXseActivatedOperandSummary();
  const xseHighOpcode = loadXseHighOpcodeSummary();
  const xseEntrySafety = loadXseEntrySafetySummary();
  const xseRefWidthSafety = loadXseRefWidthSafetySummary();
  const xseCompareAbi = loadXseCompareAbiSummary();
  const xseRefNamespace = loadXseRefNamespaceSummary();
  const xseRef64Loader = loadXseRef64LoaderSummary();
  const providerRefContext = loadProviderRefContextSummary();
  const xseCompareResolver = loadXseCompareResolverSummary();
  const providerResolverHook = loadProviderResolverHookSummary();
  const provider35c4Tape = loadProvider35C4TapeSummary();
  const provider35c4Feed = loadProvider35C4FeedSummary();
  const provider35c4Capture = loadProvider35C4CaptureSummary();
  const provider35c4Source = loadProvider35C4CaptureSourceSummary();
  const provider35c4Emu = loadProvider35C4EmulatedSourceSummary();
  const provider35c4SvcObj = loadProvider35C4ServiceObjectSummary();
  const provider35c4SvcResolver = loadProvider35C4ServiceResolverSummary();
  const provider35c4LiveCall = loadProvider35C4LiveCallSummary();
  const provider35c4StreamExec = loadProvider35C4StreamExecutorSummary();
  const provider35c4TableWalk = loadProvider35C4TableWalkSummary();
  const provider35c4CountMode = loadProvider35C4CountModeSummary();
  const provider35c4S02Source = loadProvider35C4S02SourceSummary();
  const provider35c4SelectedTable = loadProvider35C4SelectedTableSummary();
  const provider35c4SelectedFeed = loadProvider35C4SelectedFeedSummary();
  const provider35c4PromotionFrontier = loadProvider35C4PromotionFrontierSummary();
  const provider35c4FrontierModeScan = loadProvider35C4FrontierModeScanSummary();
  const provider35c4Return0Priority = loadProvider35C4Return0PrioritySummary();
  const provider35c4Return0Injection = loadProvider35C4Return0InjectionSummary();
  const provider35c4Return0Capture = loadProvider35C4Return0CaptureSummary();
  const provider35c4CapturedFeed = loadProvider35C4CapturedFeedSummary();
  const provider35c4ObservationRecorder = loadProvider35C4ObservationRecorderSummary();
  const provider35c4RuntimeSink = loadProvider35C4RuntimeSinkSummary();
  const cbeRuntimeCore = loadCbeRuntimeCoreSummary();
  const cbeRuntimeCoreScene = loadCbeRuntimeCoreSceneSummary();
  const copyHelper = loadCopyHelperSummary();
  const slotAudit = loadSlotAuditSummary();
  const serviceLifecycle = loadServiceLifecycleSummary();
  const loaderCallers = loadLoaderCallersSummary();
  const wrapperFacade = loadWrapperFacadeSummary();
  const facadeSlots = loadFacadeSlotSummary();
  const managerRoot = loadManagerRootSummary();
  const facadeEquivalence = loadFacadeEquivalenceSummary();
  const facadeNormalized = loadFacadeNormalizedSummary();

  const bootResources = BOOT_RESOURCE_HINTS
    .map((name) => findEntry(archive, name))
    .filter(Boolean)
    .map((entry) => {
      const resource = readResource(archive, entry);
      return {
        ...publicEntry(entry),
        fixedSize: resource.fixed.length,
        fixupNote: resource.fixupNote,
        gif: extOf(entry.name) === ".gif" ? parseGifInfoBuffer(resource.fixed) : null,
      };
    });

  return {
    schema: "nicai.cbe.trueRuntimeProbe.v1",
    generatedAt: new Date().toISOString(),
    source: {
      mode: "raw-cbe",
      input: archive.input,
      size: archive.size,
      sectionCount: archive.sections.length,
      resourceCount: archive.entries.length,
      extCounts: extensionCounts(archive.entries),
      sections: archive.sections.map((section) => ({
        section: section.section,
        offset: hex(section.offset),
        count: section.count,
        dataStart: hex(section.dataStart),
        dataEnd: hex(section.dataEnd),
      })),
    },
    boot: {
      preamble: bootPreambleSummary(archive),
      resources: bootResources,
    },
    scene,
    sceneRefs,
    xseVm: {
      handlerTable: loadHandlerTable(),
      readerService,
      vmGate,
      streamPrep,
      streamService,
      providerService,
      providerReplay,
      cursor50Variants,
      providerAbi,
      providerAbiShim,
      xseSwitchReplay,
      xseRuntimeDispatch,
      xseDispatchCases,
      xseTraceVm,
      xseWriteback,
      xseCursorInit,
      xseSlotLifecycle,
      xseOperandBinding,
      xseEntrypoint,
      xseEntryLabel,
      xseEntryCaller,
      xseEntryCompare,
      xseLabelPointer,
      xseRefEncoding,
      xseCompareNormalization,
      xseTailBoundary,
      xseCompareService,
      xseCompareShim,
      xseActivation,
      xseActivatedDispatch,
      xseActivatedOperand,
      xseHighOpcode,
      xseEntrySafety,
      xseRefWidthSafety,
      xseCompareAbi,
      xseRefNamespace,
      xseRef64Loader,
      providerRefContext,
      xseCompareResolver,
      providerResolverHook,
      provider35c4Tape,
      provider35c4Feed,
      provider35c4Capture,
      provider35c4Source,
      provider35c4Emu,
      provider35c4SvcObj,
      provider35c4SvcResolver,
      provider35c4LiveCall,
      provider35c4StreamExec,
      provider35c4TableWalk,
      provider35c4CountMode,
      provider35c4S02Source,
      provider35c4SelectedTable,
      provider35c4SelectedFeed,
      provider35c4PromotionFrontier,
      provider35c4FrontierModeScan,
      provider35c4Return0Priority,
      provider35c4Return0Injection,
      provider35c4Return0Capture,
      provider35c4CapturedFeed,
      provider35c4ObservationRecorder,
      provider35c4RuntimeSink,
      cbeRuntimeCore,
      cbeRuntimeCoreScene,
      copyHelper,
      slotAudit,
      serviceLifecycle,
      loaderCallers,
      wrapperFacade,
      facadeSlots,
      managerRoot,
      facadeEquivalence,
      facadeNormalized,
      scriptProbes,
      wire: buildWireSummary(input, scriptNames),
      executionStatus: xseWriteback.available && xseWriteback.status === "writeback-target-risk"
        ? `${xseTraceVm.available ? xseTraceVm.currentFinding : "Trace VM is available only as a no-effects walk."} Writeback site ${xseWriteback.writebackSite || "0x11FD2"} has ${xseWriteback.nullGuardedWritebackSite ? "a local null guard" : "no local null guard"}${xseSlotLifecycle.available ? `; slot lifecycle anchors ${xseSlotLifecycle.cursorZeroFirstBlockerCount} first blocker(s) at cursor 0 before in-trace +0x50 mutation` : ""}${xseOperandBinding.available ? `; operand binding shows ${xseOperandBinding.stackSeedRelevantBlockerCount}/${xseOperandBinding.writebackBlockerCount} blockers are stack-seed relevant` : ""}${xseEntrypoint.available ? `; entrypoint probe found plausible +0x64 entries in ${xseEntrypoint.scriptsWithPlausibleEntries.length}/${xseEntrypoint.scriptCount} focused scripts and safe candidates in ${xseEntrypoint.scriptsWithSafeEntries.length}/${xseEntrypoint.scriptCount}` : ""}${xseEntryLabel.available ? `; entry label probe confirms ${xseEntryLabel.labelConfirmedScripts.length}/${xseEntryLabel.scriptCount} safe candidates match INIT/_MAIN labels` : ""}${xseEntryCaller.available ? `; entry callers provide ${xseEntryCaller.semanticLabels.join("/") || "unknown"} labels through ${xseEntryCaller.callCount} helper call(s)` : ""}${xseEntryCompare.available ? `; entry compare has ${xseEntryCompare.safeLabelScripts.length}/${xseEntryCompare.scriptCount} safe caller-label matches` : ""}${xseLabelPointer.available ? `; label pointer probe finds ${xseLabelPointer.nonZeroDeltaCount}/${xseLabelPointer.profileCount} caller pointers off the full label start, including ${xseLabelPointer.suffixPointerCount}, ${xseLabelPointer.pretargetMismatchCount} pretarget pointer, and ${xseLabelPointer.pcPlus2FullLabelCount} pc+2 diagnostic full-label hits` : ""}${xseRefEncoding.available ? `; ref encoding has ${xseRefEncoding.safeLabelScripts.length}/${xseRefEncoding.scriptCount} safe requested-label matches and split top ref64 modes ${xseRefEncoding.topRef64Modes.join("/") || "none"}` : ""}${xseCompareNormalization.available ? `; compare normalization target±2 covers ${xseCompareNormalization.targetPlusMinus2RequestedCoverage}/${xseCompareNormalization.profileCount} callers but yields ${xseCompareNormalization.primarySafeScripts.length} safe and ${xseCompareNormalization.primaryRiskScripts.length} risk selections` : ""}${xseTailBoundary.available ? `; tail boundary has ${xseTailBoundary.cleanTextPayloadScripts.length}/${xseTailBoundary.scriptCount} clean text-payload label matches, ${xseTailBoundary.cleanTextPayloadSafeScripts.length}/${xseTailBoundary.scriptCount} safe, and ${xseTailBoundary.crossingOnlyTextPayloadScripts.length} crossing-only collision(s)` : ""}${xseCompareService.available ? `; +0x50 service has ${xseCompareService.plus50RoleCount} observed role(s) including compare=${xseCompareService.compareReturnsZeroOnMatch ? "return0" : "unknown"}` : ""}${xseCompareShim.available ? `; compare shim ${xseCompareShim.primaryModel || "primary"} first-matches writeback-risk entries in ${xseCompareShim.selectedWritebackRiskScripts.length}/${xseCompareShim.scriptCount}, safe entries in ${xseCompareShim.selectedSafeScripts.length}/${xseCompareShim.scriptCount}, and all-strong collides implausibly in ${xseCompareShim.allStrongImplausibleScripts.length}/${xseCompareShim.scriptCount}` : ""}${xseActivation.available ? `; activation formulas are bound for ${xseActivation.primarySelectedScripts.length}/${xseActivation.scriptCount} primary selections with ${xseActivation.primarySafeScripts.length}/${xseActivation.scriptCount} safe` : ""}${xseActivatedDispatch.available ? `; activated dispatch tests ${xseActivatedDispatch.primaryActivatedStepCount}/${xseActivatedDispatch.primarySelectedCount} primary selections and still blocks ${xseActivatedDispatch.primaryWritebackBlockedCount}` : ""}${xseActivatedOperand.available ? `; activated operand boundary is stable for ${xseActivatedOperand.stableBoundaryCount}/${xseActivatedOperand.blockedPrimaryCount} blockers` : ""}${xseHighOpcode.available ? `; high-opcode contract marks ${xseHighOpcode.highOpcodeWritebackRiskCount}/${xseHighOpcode.writebackRiskCount} writeback risks as high-op non-targets and ${xseHighOpcode.activatedHighOpcodeBlockedCount}/${xseHighOpcode.activatedHighOpcodeCount} activated high-opcode rows as still blocked` : ""}${xseEntrySafety.available ? `; entry safety promotes ${xseEntrySafety.promotablePrimaryCount}/${xseEntrySafety.scriptCount} primary selections and demotes ${xseEntrySafety.demotedHighOpcodeWritebackCount} high-opcode writeback candidate(s)` : ""}${xseRefWidthSafety.available ? `; exhaustive ref-width safety scans ${xseRefWidthSafety.totalCandidateScans} mode candidates and finds ${xseRefWidthSafety.firstSafeMatchCount} first-safe requested-label matches` : ""}${xseCompareAbi.available ? `; compare ABI documents +0x50 branching across ${xseCompareAbi.streamCursorReadCount} stream-read and ${xseCompareAbi.labelRefCompareCount} label/ref compare shape(s)` : ""}${xseRef64Loader.available ? `; +0x64 loader stores opaque range refs at ${xseRef64Loader.rangeRefCallSite || "unknown"} and final refs at ${xseRef64Loader.finalRefCallSite || "unknown"}` : ""}${providerRefContext.available ? `; provider ref context splits ${providerRefContext.contextCount} contexts with ${providerRefContext.textSafeContextCount} text-safe and ${providerRefContext.opaqueContextCount} opaque` : ""}${xseCompareResolver.available ? `; compare resolver is behind provider ${xseCompareResolver.providerReaderGlobal || "0x35C4"}${xseCompareResolver.compareSlot || "+0x50"} with ${xseCompareResolver.shimUnboundSampleCount} unbound shim compare sample(s)` : ""}${providerResolverHook.available ? `; resolver hook is ${providerResolverHook.status} with ${providerResolverHook.failureCount} guard failure(s)` : ""}${provider35c4Tape.available ? `; provider 0x35C4 tape is ${provider35c4Tape.status} with ${provider35c4Tape.producerEventCount} producer(s), ${provider35c4Tape.labelCompareEventCount} label/ref compare(s), and ${provider35c4Tape.hookFeedObservedMatchCount} observed hook-feed row(s)` : ""}${provider35c4Feed.available ? `; provider 0x35C4 feed is ${provider35c4Feed.status} with ${provider35c4Feed.observedMatchCount} observed match(es), ${provider35c4Feed.resolverMatchedCount}/${provider35c4Feed.resolverReplayCount} resolver replay match(es), and ${provider35c4Feed.promotionEligibleCount} promotion candidate(s)` : ""}${provider35c4Capture.available ? `; provider 0x35C4 capture plan is ${provider35c4Capture.status} with ${provider35c4Capture.readyCapturePointCount}/${provider35c4Capture.capturePointCount} ready point(s) and ${provider35c4Capture.feedEligibleCapturePointCount} feed-eligible compare point(s)` : ""}${provider35c4Source.available ? `; provider 0x35C4 capture source is ${provider35c4Source.status} with ${provider35c4Source.captureEventCount} event(s), ${provider35c4Source.linkedCompareCount}/${provider35c4Source.labelCompareEventCount} linked compare(s), and ${provider35c4Source.observedFeedEventCount} observed feed event(s)` : ""}, so visible script effects stay disabled until entry refs, operand layout, and +0x54/+0x60 targets are bound.`
        : xseTraceVm.available && xseTraceVm.status === "trace-vm-dispatch-walk"
        ? `${xseTraceVm.currentFinding} Visible script effects still need concrete value/box semantics and the s_04 group32/register-shape ambiguity resolved.`
        : xseRuntimeDispatch.available && xseRuntimeDispatch.status === "dispatch-reader-tension"
        ? `0x112C4 switch replay passes, but runtime group dispatch disagrees with tail-best +0x4C mode in ${xseRuntimeDispatch.tensionScripts.join(", ")}; command execution needs dispatcher-case and tail-reader binding.`
        : xseSwitchReplay.available && xseSwitchReplay.status === "switch-replay-ok"
        ? "0x112C4 object/table switch replay passes on focused XSE files; command execution still needs high-opcode handler binding and +0x74/+0x64 tail refs."
        : vmGate.available && vmGate.alignedCount === 0
        ? "blocked at strict XSE VM gate; +0x4C-only widening did not recover a layout-aligned opcode stream"
        : scriptProbes.some((probe) => probe.strictStatus === "object-table-candidate")
        ? "object table candidates found; command execution is not wired yet"
        : "blocked before execution; current 0x112C4 decode is misaligned under the strict opcode gate",
    },
  };
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

function renderMarkdown(report) {
  const sceneSummary = report.scene.summary.specific?.sce || {};
  const mapRecords = sceneSummary.mapTable?.records || [];
  const placements = sceneSummary.placements || [];
  const scripts = report.xseVm.scriptProbes || [];
  const candidateCount = scripts.filter((script) => script.strictStatus === "object-table-candidate").length;
  const lines = [];
  lines.push("# CBE True Runtime Probe");
  lines.push("");
  lines.push("This report is built directly from the original `.CBE` file, not from the extracted `out_batch` tree.");
  lines.push("");
  lines.push("## Raw CBE");
  lines.push(`- Input: ${report.source.input}`);
  lines.push(`- Size: ${report.source.size} bytes`);
  lines.push(`- Sections: ${report.source.sectionCount}`);
  lines.push(`- Resources: ${report.source.resourceCount}`);
  lines.push(`- Ext counts: ${Object.entries(report.source.extCounts).map(([ext, count]) => `${ext}=${count}`).join(", ")}`);
  lines.push("");
  lines.push("## Boot Resources");
  for (const resource of report.boot.resources) {
    const gif = resource.gif ? ` ${resource.gif.width}x${resource.gif.height}, frames=${resource.gif.frames}` : "";
    lines.push(`- ${resource.name}: ${resource.rel}, raw=${resource.rawSize}, fixed=${resource.fixedSize}${resource.fixupNote ? `, ${resource.fixupNote}` : ""}${gif}`);
  }
  if (!report.boot.resources.length) lines.push("- none");
  lines.push("");
  lines.push("## Scene");
  lines.push(`- Scene: ${report.scene.name} (${report.scene.rel})`);
  lines.push(`- Canvas: ${sceneSummary.canvas ? `${sceneSummary.canvas.width}x${sceneSummary.canvas.height}` : "unknown"}`);
  lines.push(`- Map records: ${mapRecords.length}`);
  for (const record of mapRecords.slice(0, 8)) {
    lines.push(`  - ${record.name} fields=${record.fields.join(",")} offset=${record.offset}`);
  }
  lines.push(`- Placement records: ${placements.length}`);
  for (const placement of placements.slice(0, 10)) {
    lines.push(`  - ${placement.name} -> ${placement.matched || "-"} x=${placement.x} y=${placement.y} type=${placement.recordType}`);
  }
  lines.push("");
  lines.push("## XSE VM Gate");
  lines.push(`- Handler table: ${report.xseVm.handlerTable.commandCount} commands resolved`);
  lines.push(`- Legacy strict object-table candidates: ${candidateCount}/${scripts.length}`);
  if (report.xseVm.xseSwitchReplay?.available) {
    const replay = report.xseVm.xseSwitchReplay;
    lines.push(`- Corrected switch replay: ${replay.okScripts}/${replay.scriptCount} scripts, close tails ${replay.closeTailScripts}/${replay.scriptCount}`);
  }
  if (report.xseVm.xseRuntimeDispatch?.available) {
    const dispatch = report.xseVm.xseRuntimeDispatch;
    lines.push(`- Runtime dispatch validation: ${dispatch.status}; tension ${dispatch.tensionCount}/${dispatch.scriptCount}${dispatch.tensionScripts.length ? ` (${dispatch.tensionScripts.join(", ")})` : ""}, execution corrections ${dispatch.executionCorrectionCount}/${dispatch.scriptCount}`);
  }
  if (report.xseVm.xseDispatchCases?.available) {
    const cases = report.xseVm.xseDispatchCases;
    lines.push(`- Runtime case map: ${cases.status}; focused direct groups ${cases.focusedDirect.join(", ") || "none"} -> ${cases.focusedTargets.join(", ") || "none"}`);
  }
  if (report.xseVm.xseTraceVm?.available) {
    const vm = report.xseVm.xseTraceVm;
    lines.push(`- Trace VM: ${vm.status}; steps ${vm.stepCount}, direct groups ${vm.directGroups.join(", ") || "none"}, high defaults=${vm.highOpcodeOperandDefaultSteps}, writeback blockers=${vm.writebackTargetBlockedSteps}, register-shape suspects=${vm.registerShapeSuspectSteps}, avoided=${vm.avoidedRegisterShapeSuspects.length}`);
  }
  if (report.xseVm.xseWriteback?.available) {
    const writeback = report.xseVm.xseWriteback;
    lines.push(`- Writeback probe: ${writeback.status}; execution risks=${writeback.executionWritebackRiskCount}${writeback.executionRiskScripts.length ? ` (${writeback.executionRiskScripts.join(", ")})` : ""}; site=${writeback.writebackSite || "?"}, localNullGuard=${writeback.nullGuardedWritebackSite ? "yes" : "no"}`);
  }
  if (report.xseVm.xseCursorInit?.available) {
    const cursorInit = report.xseVm.xseCursorInit;
    lines.push(`- Cursor init probe: ${cursorInit.status}; not-seeded=${cursorInit.executionNotSeededCount}/${cursorInit.scripts.length}, seedable=${cursorInit.executionSeedableCount}/${cursorInit.scripts.length}`);
  }
  if (report.xseVm.xseSlotLifecycle?.available) {
    const lifecycle = report.xseVm.xseSlotLifecycle;
    lines.push(`- Slot lifecycle probe: ${lifecycle.status}; +0x50 not-seeded=${lifecycle.executionGroupCursorNotSeededCount}/${lifecycle.scripts.length}, cursor0 first blockers=${lifecycle.cursorZeroFirstBlockerCount}, writeback blockers=${lifecycle.writebackBlockerCount}`);
  }
  if (report.xseVm.xseOperandBinding?.available) {
    const operand = report.xseVm.xseOperandBinding;
    lines.push(`- Operand binding probe: ${operand.status}; operand0 pointer types=${operand.operand0PointerTypeCount}/${operand.writebackBlockerCount}, stack-seed relevant=${operand.stackSeedRelevantBlockerCount}/${operand.writebackBlockerCount}`);
  }
  if (report.xseVm.xseEntrypoint?.available) {
    const entrypoint = report.xseVm.xseEntrypoint;
    lines.push(`- Entrypoint probe: ${entrypoint.status}; plausible=${entrypoint.scriptsWithPlausibleEntries.length}/${entrypoint.scriptCount}, safe=${entrypoint.scriptsWithSafeEntries.length}/${entrypoint.scriptCount}${entrypoint.scriptsWithPlausibleEntries.length ? ` (${entrypoint.scriptsWithPlausibleEntries.join(", ")})` : ""}`);
  }
  if (report.xseVm.xseEntryLabel?.available) {
    const labels = report.xseVm.xseEntryLabel;
    lines.push(`- Entry label probe: ${labels.status}; label-confirmed=${labels.labelConfirmedScripts.length}/${labels.scriptCount}, command-only=${labels.commandOnlyScripts.length}/${labels.scriptCount}${labels.commandOnlyScripts.length ? ` (${labels.commandOnlyScripts.join(", ")})` : ""}`);
  }
  if (report.xseVm.xseEntryCaller?.available) {
    const callers = report.xseVm.xseEntryCaller;
    lines.push(`- Entry caller probe: ${callers.status}; calls=${callers.callCount}, dispatch=${callers.dispatchingCallCount}, select-only=${callers.selectOnlyCallCount}, labels=${callers.semanticLabels.join(", ") || "none"}`);
  }
  if (report.xseVm.xseEntryCompare?.available) {
    const compare = report.xseVm.xseEntryCompare;
    lines.push(`- Entry compare probe: ${compare.status}; requested=${compare.requestedLabels.join(", ") || "none"}, safe=${compare.safeLabelScripts.length}/${compare.scriptCount}, unsafe=${compare.unsafeLabelScripts.length}/${compare.scriptCount}, pointer-delta=${compare.callerPointerNonZeroDeltaCount}`);
  }
  if (report.xseVm.xseLabelPointer?.available) {
    const labels = report.xseVm.xseLabelPointer;
    lines.push(`- Label pointer probe: ${labels.status}; exact-full=${labels.exactFullLabelCount}/${labels.profileCount}, suffix=${labels.suffixPointerCount}, pretarget=${labels.pretargetMismatchCount}, pc+2-full=${labels.pcPlus2FullLabelCount}, exactADR=${labels.exactAdrSelectedCount}`);
  }
  if (report.xseVm.xseRefEncoding?.available) {
    const refs = report.xseVm.xseRefEncoding;
    lines.push(`- Ref encoding probe: ${refs.status}; safe-label=${refs.safeLabelScripts.length}/${refs.scriptCount}, risky-label=${refs.riskyLabelScripts.length}/${refs.scriptCount}, top-ref64=${refs.topRef64Modes.join(", ") || "none"}`);
  }
  if (report.xseVm.xseCompareNormalization?.available) {
    const norm = report.xseVm.xseCompareNormalization;
    lines.push(`- Compare normalization probe: ${norm.status}; exact=${norm.exactRequestedCoverage}/${norm.profileCount}, pc+2=${norm.pcPlus2RequestedCoverage}/${norm.profileCount}, target+/-2=${norm.targetPlusMinus2RequestedCoverage}/${norm.profileCount}, primary-safe=${norm.primarySafeScripts.length}, primary-risk=${norm.primaryRiskScripts.length}`);
  }
  if (report.xseVm.xseTailBoundary?.available) {
    const tail = report.xseVm.xseTailBoundary;
    lines.push(`- Tail boundary probe: ${tail.status}; clean-text=${tail.cleanTextPayloadScripts.length}/${tail.scriptCount}, clean-safe=${tail.cleanTextPayloadSafeScripts.length}/${tail.scriptCount}, crossing-only=${tail.crossingOnlyTextPayloadScripts.length}/${tail.scriptCount}`);
  }
  if (report.xseVm.xseCompareService?.available) {
    const service = report.xseVm.xseCompareService;
    lines.push(`- Compare service probe: ${service.status}; +0x50 roles=${service.plus50RoleCount}, return0Match=${service.compareReturnsZeroOnMatch ? "yes" : "no"}`);
  }
  if (report.xseVm.xseCompareShim?.available) {
    const shim = report.xseVm.xseCompareShim;
    lines.push(`- Compare shim probe: ${shim.status}; primary=${shim.primaryModel}, safe=${shim.selectedSafeScripts.length}/${shim.scriptCount}, writeback-risk=${shim.selectedWritebackRiskScripts.length}/${shim.scriptCount}, all-strong-implausible=${shim.allStrongImplausibleScripts.length}/${shim.scriptCount}, exactADR=${shim.exactAdrSelectedCount}/${shim.scriptCount}`);
  }
  if (report.xseVm.xseActivation?.available) {
    const activation = report.xseVm.xseActivation;
    lines.push(`- Activation probe: ${activation.status}; selected=${activation.primarySelectedScripts.length}/${activation.scriptCount}, safe=${activation.primarySafeScripts.length}/${activation.scriptCount}, risk=${activation.primaryRiskScripts.length}/${activation.scriptCount}, broad-invalid=${activation.broadInvalidScripts.length}/${activation.scriptCount}`);
  }
  if (report.xseVm.xseActivatedDispatch?.available) {
    const activated = report.xseVm.xseActivatedDispatch;
    lines.push(`- Activated dispatch probe: ${activated.status}; selected=${activated.primarySelectedCount}/${activated.scriptCount}, steps=${activated.primaryActivatedStepCount}/${activated.primarySelectedCount}, writeback-blocked=${activated.primaryWritebackBlockedCount}/${activated.primarySelectedCount}, stack-seed=${activated.primaryStackSeedRelevantCount}/${activated.primarySelectedCount}`);
  }
  if (report.xseVm.xseActivatedOperand?.available) {
    const operand = report.xseVm.xseActivatedOperand;
    lines.push(`- Activated operand probe: ${operand.status}; stable=${operand.stableBoundaryCount}/${operand.blockedPrimaryCount}`);
  }
  if (report.xseVm.xseHighOpcode?.available) {
    const high = report.xseVm.xseHighOpcode;
    lines.push(`- High opcode probe: ${high.status}; high-writeback=${high.highOpcodeWritebackRiskCount}/${high.writebackRiskCount}, numeric-default=${high.numericDefaultHighOperandCount}/${high.highOperandUseCount}, activated-blocked=${high.activatedHighOpcodeBlockedCount}/${high.activatedHighOpcodeCount}`);
  }
  if (report.xseVm.xseEntrySafety?.available) {
    const safety = report.xseVm.xseEntrySafety;
    lines.push(`- Entry safety probe: ${safety.status}; selected=${safety.primarySelectedCount}/${safety.scriptCount}, promotable=${safety.promotablePrimaryCount}/${safety.scriptCount}, high-op-demoted=${safety.demotedHighOpcodeWritebackCount}, unmatched=${safety.unmatchedPrimaryCount}/${safety.scriptCount}`);
  }
  if (report.xseVm.xseRefWidthSafety?.available) {
    const refWidth = report.xseVm.xseRefWidthSafety;
    lines.push(`- Ref width safety probe: ${refWidth.status}; scans=${refWidth.totalCandidateScans}, first-safe=${refWidth.firstSafeMatchCount}, safe-total=${refWidth.safeMatchCount}, unsafe=${refWidth.unsafeMatchCount}`);
  }
  if (report.xseVm.xseCompareAbi?.available) {
    const compareAbi = report.xseVm.xseCompareAbi;
    lines.push(`- Compare ABI probe: ${compareAbi.status}; stream-read=${compareAbi.streamCursorReadCount}, label-ref-compare=${compareAbi.labelRefCompareCount}, shim-branch-missing=${compareAbi.compareBranchMissingFromShim ? "yes" : "no"}`);
  }
  if (report.xseVm.xseRefNamespace?.available) {
    const refs = report.xseVm.xseRefNamespace;
    lines.push(`- Ref namespace probe: ${refs.status}; scalar-safe=${refs.scalarSafeMatchCount}, unsafe-scalar=${refs.unsafeScalarCollisionCount}, resolver=${refs.resolverBound ? "bound" : "unbound"}, effects=${refs.visibleEffectsEnabled ? "enabled" : "disabled"}`);
  }
  if (report.xseVm.xseRef64Loader?.available) {
    const refs = report.xseVm.xseRef64Loader;
    lines.push(`- Ref64 loader probe: ${refs.status}; selected-inline-text=${refs.selectedInlineTextCount}/${refs.selectedEntryCount}, rangeRefStore=${refs.rangeRefCallSite || "-"}, finalRefRead=${refs.finalRefCallSite || "-"}`);
  }
  if (report.xseVm.providerRefContext?.available) {
    const refs = report.xseVm.providerRefContext;
    lines.push(`- Provider ref context probe: ${refs.status}; contexts=${refs.contextCount}, text-safe=${refs.textSafeContextCount}, opaque=${refs.opaqueContextCount}, effects=${refs.visibleEffectsEnabled ? "enabled" : "disabled"}`);
  }
  if (report.xseVm.xseCompareResolver?.available) {
    const resolver = report.xseVm.xseCompareResolver;
    lines.push(`- Compare resolver boundary probe: ${resolver.status}; reader=${resolver.providerReaderGlobal || "-"}${resolver.compareSlot || ""}, shimSamples=${resolver.shimCompareSampleCount}, unbound=${resolver.shimUnboundSampleCount}, ledgerRefs=${resolver.ledgerRefCount}, ledgerCompares=${resolver.ledgerCompareCount}, hook=${resolver.resolverHookBound ? "bound" : (resolver.resolverHookMode || "unbound")}`);
  }
  if (report.xseVm.providerResolverHook?.available) {
    const hook = report.xseVm.providerResolverHook;
    lines.push(`- Provider resolver hook probe: ${hook.status}; checks=${hook.checkCount}, failures=${hook.failureCount}, exactPair=${hook.exactObservedPairMatches ? "match" : "no"}, sameLabelWrongRef=${hook.sameLabelWrongRefMatches ? "match" : "no"}, wrongLabelSameRef=${hook.wrongLabelSameRefMatches ? "match" : "no"}`);
  }
  if (report.xseVm.provider35c4Tape?.available) {
    const tape = report.xseVm.provider35c4Tape;
    lines.push(`- Provider 0x35C4 tape probe: ${tape.status}; events=${tape.providerEventCount}, producers=${tape.producerEventCount}, cursorReads=${tape.cursorReadEventCount}, labelCompares=${tape.labelCompareEventCount}, observedHookFeed=${tape.hookFeedObservedMatchCount}, failures=${tape.failureCount}`);
  }
  if (report.xseVm.provider35c4Feed?.available) {
    const feed = report.xseVm.provider35c4Feed;
    lines.push(`- Provider 0x35C4 feed probe: ${feed.status}; observed=${feed.observedMatchCount}, replay=${feed.resolverReplayCount}, matched=${feed.resolverMatchedCount}, promotionEligible=${feed.promotionEligibleCount}, entrySafetyPromotable=${feed.entrySafetyPromotableCount}, failures=${feed.failureCount}`);
  }
  if (report.xseVm.provider35c4Capture?.available) {
    const capture = report.xseVm.provider35c4Capture;
    lines.push(`- Provider 0x35C4 capture plan probe: ${capture.status}; points=${capture.readyCapturePointCount}/${capture.capturePointCount}, feedEligible=${capture.feedEligibleCapturePointCount}, observed=${capture.observedMatchCount}, promotionEligible=${capture.promotionEligibleCount}, failures=${capture.failureCount}`);
  }
  if (report.xseVm.provider35c4Source?.available) {
    const source = report.xseVm.provider35c4Source;
    lines.push(`- Provider 0x35C4 capture source probe: ${source.status}; events=${source.captureEventCount}, linked=${source.linkedCompareCount}/${source.labelCompareEventCount}, observedFeed=${source.observedFeedEventCount}, points=${source.observedCapturePointCount}/${source.planCapturePointCount}, failures=${source.failureCount}`);
  }
  if (report.xseVm.provider35c4Emu?.available) {
    const emu = report.xseVm.provider35c4Emu;
    lines.push(`- Provider 0x35C4 emulated source probe: ${emu.status}; events=${emu.captureEventCount}, adapterProvider=${emu.adapterProviderOwnedEventCount}/${emu.adapterEventCount}, handoffs=${emu.adapterConversionHandoffCount}, linked=${emu.linkedCompareCount}/${emu.labelCompareEventCount}, observedFeed=${emu.observedFeedEventCount}, failures=${emu.failureCount}`);
  }
  if (report.xseVm.provider35c4SvcObj?.available) {
    const svc = report.xseVm.provider35c4SvcObj;
    lines.push(`- Provider 0x35C4 service object probe: ${svc.status}; replay=${svc.replayRowCount}, producers=${svc.producerOperationCount}, cursorReads=${svc.cursorReadOperationCount}, compares=${svc.compareOperationCount}, refs=${svc.knownRefCount}, observedFeed=${svc.observedFeedCount}, failures=${svc.failureCount}`);
  }
  if (report.xseVm.provider35c4SvcResolver?.available) {
    const resolver = report.xseVm.provider35c4SvcResolver;
    lines.push(`- Provider 0x35C4 service resolver probe: ${resolver.status}; checks=${resolver.passedCheckCount}/${resolver.checkCount}, exact=${resolver.exactObservedPairMatches ? "yes" : "no"}, sameLabelWrongRef=${resolver.sameLabelWrongRefMatches ? "match" : "reject"}, wrongLabelSameRef=${resolver.wrongLabelSameRefMatches ? "match" : "reject"}, productionFeed=${resolver.productionObservedFeedCount}, failures=${resolver.failureCount}`);
  }
  if (report.xseVm.provider35c4LiveCall?.available) {
    const live = report.xseVm.provider35c4LiveCall;
    lines.push(`- Provider 0x35C4 live call probe: ${live.status}; calls=${live.callRequestCount}, producers=${live.producerOperationCount}, cursorReads=${live.cursorReadOperationCount}, compares=${live.compareOperationCount}, refs=${live.knownRefCount}, parity=${live.serviceObjectParity ? "yes" : "no"}, failures=${live.failureCount}`);
  }
  if (report.xseVm.provider35c4StreamExec?.available) {
    const stream = report.xseVm.provider35c4StreamExec;
    lines.push(`- Provider 0x35C4 stream executor probe: ${stream.status}; calls=${stream.parsedCallCount}, producers=${stream.producerOperationCount}, cursorReads=${stream.cursorReadOperationCount}, compares=${stream.compareOperationCount}, refs=${stream.knownRefCount}, rowParity=${stream.rowParity ? "yes" : "no"}, opParity=${stream.operationParity ? "yes" : "no"}, failures=${stream.failureCount}`);
  }
  if (report.xseVm.provider35c4TableWalk?.available) {
    const table = report.xseVm.provider35c4TableWalk;
    lines.push(`- Provider 0x35C4 table walk probe: ${table.status}; lanes=${table.expandedLaneCount}/${table.laneCount} expanded, guarded=${table.guardedLaneCount}, refs=${table.tableEntryRefCount}, cursorReads=${table.cursorReadOperationCount}, compares=${table.compareOperationCount}, ret0=${table.return0CompareCount}, failures=${table.failureCount}`);
  }
  if (report.xseVm.provider35c4CountMode?.available) {
    const count = report.xseVm.provider35c4CountMode;
    lines.push(`- Provider 0x35C4 count mode probe: ${count.status}; selected=${count.selectedScriptCount}, changed=${count.changedSelectionCount}, unresolved=${count.unresolvedScriptCount}, topGuarded=${count.topGuardedCandidateCount}, failures=${count.failureCount}`);
  }
  if (report.xseVm.provider35c4S02Source?.available) {
    const s02 = report.xseVm.provider35c4S02Source;
    lines.push(`- Provider 0x35C4 s_02 source-mode probe: ${s02.status}; tailEndCandidates=${s02.tailEndCandidateCount}, lanes=${s02.laneCount}, guarded=${s02.guardedLaneCount}, refs=${s02.producerOperationCount}, cursorReads=${s02.cursorReadOperationCount}, compares=${s02.compareOperationCount}, ret0=${s02.return0CompareCount}, failures=${s02.failureCount}`);
  }
  if (report.xseVm.provider35c4SelectedTable?.available) {
    const selected = report.xseVm.provider35c4SelectedTable;
    lines.push(`- Provider 0x35C4 selected table probe: ${selected.status}; lanes=${selected.expandedLaneCount}/${selected.laneCount} expanded, guarded=${selected.guardedLaneCount}, blocked=${selected.blockedScriptCount}, refs=${selected.producerOperationCount}, cursorReads=${selected.cursorReadOperationCount}, compares=${selected.compareOperationCount}, ret0=${selected.return0CompareCount}, failures=${selected.failureCount}`);
  }
  if (report.xseVm.provider35c4SelectedFeed?.available) {
    const feed = report.xseVm.provider35c4SelectedFeed;
    lines.push(`- Provider 0x35C4 selected feed probe: ${feed.status}; selectedCompares=${feed.selectedCompareCount}, observed=${feed.observedMatchCount}, resolverMatches=${feed.resolverMatchedCount}, promotionEligible=${feed.promotionEligibleCount}, failures=${feed.failureCount}`);
  }
  if (report.xseVm.provider35c4PromotionFrontier?.available) {
    const frontier = report.xseVm.provider35c4PromotionFrontier;
    lines.push(`- Provider 0x35C4 promotion frontier probe: ${frontier.status}; selectedCompares=${frontier.selectedCompareCount}, validCursor=${frontier.validCursorCompareCount}, schedulerIfObserved=${frontier.schedulerCandidateIfObservedCount}, directIfObserved=${frontier.promotionEligibleIfObservedCount}, return0=${frontier.sourceReturn0CompareCount}, failures=${frontier.failureCount}`);
  }
  if (report.xseVm.provider35c4FrontierModeScan?.available) {
    const scan = report.xseVm.provider35c4FrontierModeScan;
    lines.push(`- Provider 0x35C4 frontier mode scan probe: ${scan.status}; scanned=${scan.scannedCandidateCount}, poolClean=${scan.poolCleanCandidateCount}, schedulerModes=${scan.schedulerCandidateModeCount}, directModes=${scan.directPromotionCandidateModeCount}, failures=${scan.failureCount}`);
  }
  if (report.xseVm.provider35c4Return0Priority?.available) {
    const priority = report.xseVm.provider35c4Return0Priority;
    lines.push(`- Provider 0x35C4 return-0 priority probe: ${priority.status}; selectedRows=${priority.selectedPriorityRowCount}, modeRows=${priority.modePriorityRowCount}, knownRefs=${priority.knownProviderRefRowCount}, directRows=${priority.directCasePriorityRowCount}, failures=${priority.failureCount}`);
  }
  if (report.xseVm.provider35c4Return0Injection?.available) {
    const inject = report.xseVm.provider35c4Return0Injection;
    lines.push(`- Provider 0x35C4 return-0 injection probe: ${inject.status}; synthetic=${inject.syntheticObservedMatchCount}, matched=${inject.resolverMatchedCount}, directRows=${inject.directCaseRowCount}, executable=${inject.executableRowCount}, failures=${inject.failureCount}`);
  }
  if (report.xseVm.provider35c4Return0Capture?.available) {
    const capture = report.xseVm.provider35c4Return0Capture;
    lines.push(`- Provider 0x35C4 return-0 capture adapter probe: ${capture.status}; imported=${capture.importedObservationCount}, feed=${capture.observedFeedRowCount}, p1=${capture.p1MatchedCount}/${capture.p1PriorityRowCount}, direct=${capture.directCaseObservedCount}, executable=${capture.executableObservedCount}, failures=${capture.failureCount}`);
  }
  if (report.xseVm.provider35c4CapturedFeed?.available) {
    const feed = report.xseVm.provider35c4CapturedFeed;
    lines.push(`- Provider 0x35C4 captured selected feed probe: ${feed.status}; selected=${feed.selectedCompareCount}/${feed.expectedCompareCount}, feed=${feed.observedFeedRowCount}, matched=${feed.resolverMatchedCount}, frontier=${feed.frontierJoinedCount}, direct=${feed.directMatchedCount}, executable=${feed.executableMatchedCount}, failures=${feed.failureCount}`);
  }
  if (report.xseVm.provider35c4ObservationRecorder?.available) {
    const recorder = report.xseVm.provider35c4ObservationRecorder;
    lines.push(`- Provider 0x35C4 observation recorder probe: ${recorder.status}; selected=${recorder.selectedObservationCount}/${recorder.selectedExpectedCompareCount}, stream=${recorder.streamObservationCount}/${recorder.streamExpectedCompareCount}, events=${recorder.totalObservationCount}, feed=${recorder.observedFeedRowCount}, nonmatch=${recorder.nonMatchObservationCount}, failures=${recorder.failureCount}`);
  }
  if (report.xseVm.provider35c4RuntimeSink?.available) {
    const sink = report.xseVm.provider35c4RuntimeSink;
    lines.push(`- Provider 0x35C4 runtime sink probe: ${sink.status}; selected=${sink.selectedObservationCount}/${sink.selectedExpectedCompareCount}, stream=${sink.streamObservationCount}/${sink.streamExpectedCompareCount}, events=${sink.totalObservationCount}, feed=${sink.observedFeedRowCount}, nonmatch=${sink.nonMatchObservationCount}, failures=${sink.failureCount}`);
  }
  if (report.xseVm.cbeRuntimeCore?.available) {
    const core = report.xseVm.cbeRuntimeCore;
    lines.push(`- CBE runtime core probe: ${core.status}; corpus=${core.corpusReadyCount}/${core.corpusFileCount}, resources=${core.resourceCount}, providerEvents=${core.totalObservationCount}, feed=${core.observedFeedRowCount}, nonmatch=${core.nonMatchObservationCount}, failures=${core.failureCount}`);
  }
  if (report.xseVm.cbeRuntimeCoreScene?.available) {
    const sceneCore = report.xseVm.cbeRuntimeCoreScene;
    lines.push(`- CBE runtime core scene probe: ${sceneCore.status}; sceneGames=${sceneCore.readySceneGameCount}/${sceneCore.sceneGameCount}, scenes=${sceneCore.readySceneResourceCount}/${sceneCore.sceneResourceCount}, canvases=${sceneCore.canvasReadyCount}, sceneFrames=${sceneCore.finalSceneFrameCount}, inputFrames=${sceneCore.inputSceneFrameCount}, maps=${sceneCore.mapLinkedSceneCount} (table=${sceneCore.mapTableSceneCount}, ref=${sceneCore.lengthPrefixedMapSceneCount}, trace=${sceneCore.mapTraceSceneCount}, atlas=${sceneCore.mapAtlasSizedSceneCount}, draw=${sceneCore.mapDrawCandidateSceneCount}, tileGrid=${sceneCore.mapTileGridCandidateSceneCount}), entityScenes=${sceneCore.entitySceneCount}, scriptScenes=${sceneCore.scriptLinkedSceneCount}, failures=${sceneCore.failureCount}`);
  }
  if (report.xseVm.copyHelper?.available) {
    const helper = report.xseVm.copyHelper;
    lines.push(`- Copy helper probe: ${helper.status}; calls=${helper.copyCallCount}, writebackGuard=${helper.writebackLocalNullGuard ? "yes" : "no"}, helperNullSafe=${helper.helperNullSafeProven ? "yes" : "no"}`);
  }
  lines.push(`- Execution status: ${report.xseVm.executionStatus}`);
  if (report.xseVm.wire?.scripts?.length) {
    const exactAtoms = report.xseVm.wire.scripts.reduce((sum, script) => sum + (script.exactHandlerAtoms?.length || 0), 0);
    const fragmentAtoms = report.xseVm.wire.scripts.reduce((sum, script) => sum + (script.fragmentHandlerAtoms?.length || 0), 0);
    lines.push(`- Wire probe: ${report.xseVm.wire.scripts.length} scripts, ${exactAtoms} exact handler atoms, ${fragmentAtoms} fragment aliases; legacy strict-record candidates are now superseded by switch replay`);
  }
  if (report.xseVm.readerService?.available) {
    const reader = report.xseVm.readerService;
    const confirmedCalls = reader.xseCallSites.filter((site) => site.global35C4).length;
    lines.push(`- Reader service trace: ${confirmedCalls}/${reader.xseCallSites.length} focused calls use sb+0x35C4; unresolved slot ${reader.blockingSlot}`);
  }
  if (report.xseVm.vmGate?.available) {
    const gate = report.xseVm.vmGate;
    lines.push(`- VM gate probe: legacy strict-gate ${gate.alignedCount}/${gate.scriptCount} layout-aligned paths; ${gate.shallowCount} shallow/non-aligned paths after widening only +0x4C`);
    lines.push(`- VM gate next target: ${gate.nextTarget}`);
  }
  if (report.xseVm.streamPrep?.available) {
    const prep = report.xseVm.streamPrep;
    lines.push(`- Stream prep trace: ${prep.currentBlocker}`);
    lines.push(`- Stream prep next target: ${prep.nextTarget}`);
  }
  if (report.xseVm.streamService?.available) {
    const service = report.xseVm.streamService;
    const chains = service.chains
      .map((chain) => `${chain.name}: ${chain.open} -> ${chain.convert}`)
      .join("; ");
    lines.push(`- Stream service trace: ${service.currentFinding}`);
    lines.push(`- Shared open/convert chains: ${chains}`);
    lines.push(`- Stream service next target: ${service.nextTarget}`);
  }
  if (report.xseVm.providerService?.available) {
    const provider = report.xseVm.providerService;
    const assignmentText = provider.assignments
      .filter((item) => ["0x35C0", "0x35C4", "0x35E0"].includes(item.global))
      .map((item) => `${item.global}@${item.store} <= ${item.source}`)
      .join("; ");
    lines.push(`- Provider service trace: ${provider.currentFinding}`);
    lines.push(`- Provider assignments: ${assignmentText}`);
    lines.push(`- Provider service next target: ${provider.nextTarget}`);
  }
  if (report.xseVm.providerReplay?.available) {
    const replay = report.xseVm.providerReplay;
    const sceFields = replay.sce.fields || {};
    const mapNames = (replay.sce.maps || []).map((item) => item.name).join(", ");
    lines.push(`- Provider replay: ${replay.currentFinding}`);
    lines.push(`- SCE replay result: ${replay.sce.status}, ${sceFields.width || "?"}x${sceFields.height || "?"}, maps=${sceFields.mapCount ?? "?"}${mapNames ? ` (${mapNames})` : ""}`);
    lines.push(`- XSE replay guardrail: ${replay.xse.status}; ${replay.xseBlocker}`);
  }
  if (report.xseVm.cursor50Variants?.available) {
    const variants = report.xseVm.cursor50Variants;
    const actor = variants.topActor;
    const xse = variants.topXse;
    lines.push(`- Cursor +0x50 variants: ${variants.currentFinding}`);
    if (actor && xse) {
      lines.push(`- Cursor +0x50 summary: actorBest=${variants.actorBest}${variants.actorBestTies?.length ? ` ties=${variants.actorBestTies.join(",")}` : ""}; XSE best=${variants.xseBest}, aligned=${xse.alignedCount}/${xse.scriptCount}, strict=${xse.strictCount}/${xse.scriptCount}`);
    }
    lines.push(`- Cursor +0x50 next target: ${variants.nextTarget}`);
  }
  if (report.xseVm.providerAbi?.available) {
    const abi = report.xseVm.providerAbi;
    const critical = abi.criticalReturns
      .map((item) => `${item.method}->${item.target}`)
      .join("; ");
    lines.push(`- Provider ABI: ${abi.currentFinding}`);
    lines.push(`- Provider ABI critical returns: ${critical}`);
    lines.push(`- Provider ABI next target: ${abi.nextTarget}`);
  }
  if (report.xseVm.providerAbiShim?.available) {
    const shim = report.xseVm.providerAbiShim;
    const sceFields = shim.sce.fields || {};
    const xse = shim.xse || {};
    lines.push(`- Provider ABI shim: ${shim.currentFinding}`);
    lines.push(`- ABI shim replay: SCE ${shim.sce.status} ${sceFields.width || "?"}x${sceFields.height || "?"}; XSE ${xse.status}, aligned=${xse.alignedCandidateCount || 0}, strict=${xse.strictCandidateCount || 0}`);
    lines.push(`- ABI shim next target: ${shim.nextTarget}`);
  }
  if (report.xseVm.xseSwitchReplay?.available) {
    const replay = report.xseVm.xseSwitchReplay;
    lines.push(`- XSE switch replay: ${replay.currentFinding}`);
    lines.push(`- XSE switch correction: ${replay.correction.meaning || ""}`);
    lines.push(`- XSE switch tails: close=${replay.closeTailScripts}/${replay.scriptCount}; ${replay.scripts.map((script) => `${script.name}:${script.tailEnd || "?"}/${script.layoutEnd || "?"} delta=${script.layoutDelta ?? "?"}`).join(", ")}`);
    lines.push(`- XSE switch next target: ${replay.nextTarget}`);
  }
  if (report.xseVm.xseRuntimeDispatch?.available) {
    const dispatch = report.xseVm.xseRuntimeDispatch;
    const rows = dispatch.scripts.map((script) => {
      const tail = script.tailBest || {};
      const run = script.dispatchBest || {};
      const exec = script.executionBest || {};
      const tailText = `${tail.mode || "?"} ${tail.directGroups ?? "?"}/${tail.defaultGroups ?? "?"} delta=${tail.layoutDelta ?? "?"}`;
      const dispatchText = `${run.mode || "?"} ${run.directGroups ?? "?"}/${run.defaultGroups ?? "?"}`;
      const execText = `${exec.mode || "?"} ${exec.directGroups ?? "?"}/${exec.defaultGroups ?? "?"}`;
      return `${script.name}:${tailText}->${dispatchText}->exec ${execText}${script.executionCorrection ? " corrected" : ""}${script.tension ? " tension" : ""}`;
    }).join("; ");
    lines.push(`- XSE dispatch validation: ${dispatch.currentFinding}`);
    lines.push(`- XSE dispatch rows: ${rows}`);
    lines.push(`- XSE dispatch next target: ${dispatch.nextTarget}`);
  }
  if (report.xseVm.xseDispatchCases?.available) {
    const cases = report.xseVm.xseDispatchCases;
    const focused = cases.targetSummaries
      .filter((item) => item.groupIds.some((id) => cases.focusedDirect.includes(id)))
      .map((item) => `${item.target}[${item.groupIds.filter((id) => cases.focusedDirect.includes(id)).join(",")}]:${item.helpers.join("/") || "-"}`)
      .join("; ");
    lines.push(`- XSE dispatch cases: ${cases.currentFinding}`);
    lines.push(`- XSE focused case targets: ${focused}`);
    lines.push(`- XSE dispatch case next target: ${cases.nextTarget}`);
  }
  if (report.xseVm.xseTraceVm?.available) {
    const vm = report.xseVm.xseTraceVm;
    const rows = vm.scripts.map((script) => `${script.name}:${script.steps} steps direct=${script.directSteps}/${script.defaultSteps} defaulted=${script.highOpcodeOperandDefaultSteps} writeback=${script.writebackTargetBlockedSteps} shape=${script.registerShapeSuspectSteps} cursor=${script.finalCursor} active=${script.active}`).join("; ");
    lines.push(`- XSE trace VM: ${vm.currentFinding}`);
    lines.push(`- XSE trace VM rows: ${rows}`);
    lines.push(`- XSE trace VM next target: ${vm.nextTarget}`);
  }
  if (report.xseVm.xseWriteback?.available) {
    const writeback = report.xseVm.xseWriteback;
    const rows = writeback.scripts.map((script) => `${script.name}:${script.executionMode} risk=${script.executionRiskCount} lowRisk=${script.lowRiskModes.join("/") || "-"}`).join("; ");
    lines.push(`- XSE writeback: ${writeback.currentFinding}`);
    lines.push(`- XSE writeback contract: site=${writeback.writebackSite || "?"}, localNullGuard=${writeback.nullGuardedWritebackSite ? "yes" : "no"}, requiredOperand0Types=${(writeback.requiredPointerTypes || []).join("/") || "?"}, directLowRisk=${writeback.directLowRiskScripts.join(",") || "none"}`);
    lines.push(`- XSE writeback rows: ${rows}`);
    lines.push(`- XSE writeback next target: ${writeback.nextTarget}`);
  }
  if (report.xseVm.xseCursorInit?.available) {
    const cursorInit = report.xseVm.xseCursorInit;
    const rows = cursorInit.scripts.map((script) => `${script.name}:${script.executionMode} field08=${script.field08Byte} seed=${script.cursorSeedStatus} init=${script.inferredInitialCursor ?? "?"}`).join("; ");
    lines.push(`- XSE cursor init: ${cursorInit.currentFinding}`);
    lines.push(`- XSE cursor init rows: ${rows}`);
    lines.push(`- XSE cursor init next target: ${cursorInit.nextTarget}`);
  }
  if (report.xseVm.xseSlotLifecycle?.available) {
    const lifecycle = report.xseVm.xseSlotLifecycle;
    const rows = lifecycle.writebackBlockers.map((row) => `${row.name}:${row.mode} blockers=${row.writebackBlockers} first=${row.firstWritebackCursor ?? "-"} group=${row.firstGroupId ?? "-"} op0=${row.firstOperand0Type ?? "-"} ${row.firstBeforeAnyPriorStep ? "pre-mutation" : "after-prior"}`).join("; ");
    const seeds = lifecycle.scripts.map((script) => `${script.name}:${script.executionMode} +50=${script.resetGroupCursorSeed} +5C=${script.resetOpcodeCursorSeed}`).join("; ");
    lines.push(`- XSE slot lifecycle: ${lifecycle.currentFinding}`);
    lines.push(`- XSE slot lifecycle seeds: ${seeds}`);
    lines.push(`- XSE slot lifecycle blockers: ${rows}`);
    lines.push(`- XSE slot lifecycle next target: ${lifecycle.nextTarget}`);
  }
  if (report.xseVm.xseOperandBinding?.available) {
    const operand = report.xseVm.xseOperandBinding;
    const rows = operand.blockers.map((row) => `${row.script}:${row.mode} cursor=${row.cursor} group=${row.groupId} op0=${row.operand0Type ?? "-"} ${row.operand0PointerKind || "-"} stack=${row.stackSeedRelevant ? "yes" : "no"}`).join("; ");
    lines.push(`- XSE operand binding: ${operand.currentFinding}`);
    lines.push(`- XSE operand binding rows: ${rows}`);
    lines.push(`- XSE operand binding next target: ${operand.nextTarget}`);
  }
  if (report.xseVm.xseEntrypoint?.available) {
    const entrypoint = report.xseVm.xseEntrypoint;
    const rows = entrypoint.scripts.map((script) => {
      const best = script.bestEntry || {};
      const modes = best.modes ? `74=${best.modes.ref74Mode || "-"} 64=${best.modes.ref64Mode || "-"}` : "74=- 64=-";
      return `${script.name}:${script.status || "-"} mode=${script.executionMode || "-"} ${modes} end=${best.end || "-"} delta=${best.layoutDelta ?? "-"} entries=${best.plausibleEntryCount || 0}/${best.entryCount ?? "-"} safe=${best.safeEntryCount || 0}`;
    }).join("; ");
    const contract = entrypoint.entryHelperContract ? `${entrypoint.entryHelperContract.entry || "0x12364"} ${entrypoint.entryHelperContract.role || "entry helper"}` : "entry helper unavailable";
    lines.push(`- XSE entrypoint: ${entrypoint.currentFinding}`);
    lines.push(`- XSE entrypoint contract: ${contract}`);
    lines.push(`- XSE entrypoint rows: ${rows}`);
    lines.push(`- XSE entrypoint next target: ${entrypoint.nextTarget}`);
  }
  if (report.xseVm.xseEntryLabel?.available) {
    const labels = report.xseVm.xseEntryLabel;
    const rows = labels.scripts.map((script) => `${script.name}:${script.status} safeLabel=${script.safeLabelCandidateCount} safeCommand=${script.safeCommandCandidateCount}`).join("; ");
    lines.push(`- XSE entry labels: ${labels.currentFinding}`);
    lines.push(`- XSE entry label rows: ${rows}`);
    lines.push(`- XSE entry label next target: ${labels.nextTarget}`);
  }
  if (report.xseVm.xseEntryCaller?.available) {
    const callers = report.xseVm.xseEntryCaller;
    const rows = callers.calls.map((call) => `${call.call}->${call.target} ${call.semanticLabel || "-"} ${call.targetRole}`).join("; ");
    lines.push(`- XSE entry callers: ${callers.currentFinding}`);
    lines.push(`- XSE entry caller rows: ${rows}`);
    lines.push(`- XSE entry caller next target: ${callers.nextTarget}`);
  }
  if (report.xseVm.xseEntryCompare?.available) {
    const compare = report.xseVm.xseEntryCompare;
    const callerRows = compare.callerLabelProfiles.map((profile) => `${profile.call}:${profile.requestedLabel} exact=${profile.exactTextAtTarget || "-"} delta=${profile.pointerDeltaToBestLabel ?? "-"}`).join("; ");
    const scriptRows = compare.scripts.map((script) => `${script.name}:${script.status} safe=${script.safeLabelCandidateCount} unsafe=${script.unsafeLabelCandidateCount}`).join("; ");
    lines.push(`- XSE entry compare: ${compare.currentFinding}`);
    lines.push(`- XSE entry compare callers: ${callerRows}`);
    lines.push(`- XSE entry compare rows: ${scriptRows}`);
    lines.push(`- XSE entry compare next target: ${compare.nextTarget}`);
  }
  if (report.xseVm.xseLabelPointer?.available) {
    const labels = report.xseVm.xseLabelPointer;
    const rows = labels.pointerProfiles.map((profile) => `${profile.call}:${profile.requestedLabel} exact=${profile.exactTextAtTarget || "-"} full=${profile.nearestFullLabel || "-"} delta=${profile.pointerDeltaToFullLabel ?? "-"} pc+2=${profile.adr?.pcPlus2DiagnosticText || "-"} ${profile.classification}`).join("; ");
    lines.push(`- XSE label pointer: ${labels.currentFinding}`);
    lines.push(`- XSE label pointer rows: ${rows}`);
    lines.push(`- XSE label pointer next target: ${labels.nextTarget}`);
  }
  if (report.xseVm.xseRefEncoding?.available) {
    const refs = report.xseVm.xseRefEncoding;
    const rows = refs.scripts.map((script) => `${script.name}:${script.status} top=${script.topMode || "-"} layout=${script.layoutClosestMode || "-"} label=${script.safeRequestedCandidateCount}/${script.requestedCandidateCount}`).join("; ");
    lines.push(`- XSE ref encoding: ${refs.currentFinding}`);
    lines.push(`- XSE ref encoding rows: ${rows}`);
    lines.push(`- XSE ref encoding next target: ${refs.nextTarget}`);
  }
  if (report.xseVm.xseCompareNormalization?.available) {
    const norm = report.xseVm.xseCompareNormalization;
    const rows = norm.normalizers.map((normalizer) => `${normalizer.id}:${normalizer.requestedCoverageCount}/${norm.profileCount} labels=${normalizer.labels.join("/") || "-"}`).join("; ");
    lines.push(`- XSE compare normalization: ${norm.currentFinding}`);
    lines.push(`- XSE compare normalization rows: ${rows}`);
    lines.push(`- XSE compare normalization next target: ${norm.nextTarget}`);
  }
  if (report.xseVm.xseTailBoundary?.available) {
    const tail = report.xseVm.xseTailBoundary;
    const rows = tail.scripts.map((script) => {
      const text = script.models.find((model) => model.id === "text-payload") || {};
      return `${script.name}:${script.status} text=${text.boundaryCleanMatchedCount || 0}/${text.boundaryCleanSafeCount || 0}/${text.crossingMatchedCount || 0}`;
    }).join("; ");
    lines.push(`- XSE tail boundary: ${tail.currentFinding}`);
    lines.push(`- XSE tail boundary rows: ${rows}`);
    lines.push(`- XSE tail boundary next target: ${tail.nextTarget}`);
  }
  if (report.xseVm.xseCompareService?.available) {
    const service = report.xseVm.xseCompareService;
    const rows = service.windows.map((window) => `${window.name}:${window.slot} ${window.role}`).join("; ");
    lines.push(`- XSE compare service: ${service.currentFinding}`);
    lines.push(`- XSE compare service rows: ${rows}`);
    lines.push(`- XSE compare service next target: ${service.nextTarget}`);
  }
  if (report.xseVm.xseCompareShim?.available) {
    const shim = report.xseVm.xseCompareShim;
    const rows = shim.scripts.map((script) => {
      const selected = script.primarySelection?.selected;
      const entry = selected ? ` entry${selected.index} cursor=${selected.groupCursor} risk=${selected.riskKind || "unknown"}` : "";
      return `${script.name}:${script.primaryStatus}${entry}`;
    }).join("; ");
    lines.push(`- XSE compare shim: ${shim.currentFinding}`);
    lines.push(`- XSE compare shim rows: ${rows}`);
    lines.push(`- XSE compare shim next target: ${shim.nextTarget}`);
  }
  if (report.xseVm.xseActivation?.available) {
    const activation = report.xseVm.xseActivation;
    const rows = activation.scripts.map((script) => {
      const effect = script.primaryEffect;
      return effect ? `${script.name}:entry${effect.selectedIndex} cursor=${effect.recordFields?.field00GroupCursor} delta=${effect.activationWrites?.script5cDelta} risk=${effect.riskKind}` : `${script.name}:unmatched`;
    }).join("; ");
    lines.push(`- XSE activation: ${activation.currentFinding}`);
    lines.push(`- XSE activation rows: ${rows}`);
    lines.push(`- XSE activation next target: ${activation.nextTarget}`);
  }
  if (report.xseVm.xseActivatedDispatch?.available) {
    const activated = report.xseVm.xseActivatedDispatch;
    const rows = activated.scripts.map((script) => {
      const row = script.primaryDispatch;
      return row ? `${script.name}:entry${row.selectedIndex} cursor=${row.activatedCursor} group=${row.groupId ?? "-"} op0=${row.operand0?.typeHex || "-"} result=${row.result}` : `${script.name}:unmatched`;
    }).join("; ");
    lines.push(`- XSE activated dispatch: ${activated.currentFinding}`);
    lines.push(`- XSE activated dispatch rows: ${rows}`);
    lines.push(`- XSE activated dispatch next target: ${activated.nextTarget}`);
  }
  if (report.xseVm.xseActivatedOperand?.available) {
    const operand = report.xseVm.xseActivatedOperand;
    const rows = operand.rows.map((row) => `${row.script}:cursor=${row.group?.cursor ?? "-"} first=${row.group?.firstRecordStart || "-"} op0=${row.dispatch?.operand0?.typeHex || "-"} ${row.status}`).join("; ");
    lines.push(`- XSE activated operand: ${operand.currentFinding}`);
    lines.push(`- XSE activated operand rows: ${rows}`);
    lines.push(`- XSE activated operand next target: ${operand.nextTarget}`);
  }
  if (report.xseVm.xseHighOpcode?.available) {
    const high = report.xseVm.xseHighOpcode;
    const rows = high.highOperandRows.map((row) => `${row.script}:cursor=${row.cursor} group=${row.groupId} use=${row.useKind} blocked=${row.writebackBlocked ? "yes" : "no"}`).join("; ");
    const activatedRows = high.activatedRows.map((row) => `${row.script}:cursor=${row.cursor} group=${row.groupId} op0=${row.operand0?.typeHex || "-"} use=${row.highOpcodeUse?.kind || "-"}`).join("; ");
    lines.push(`- XSE high opcode: ${high.currentFinding}`);
    lines.push(`- XSE high opcode rows: ${rows}`);
    lines.push(`- XSE high opcode activated rows: ${activatedRows || "none"}`);
    lines.push(`- XSE high opcode next target: ${high.nextTarget}`);
  }
  if (report.xseVm.xseEntrySafety?.available) {
    const safety = report.xseVm.xseEntrySafety;
    const rows = safety.primaryRows.map((row) => {
      const selected = row.selected ? `entry${row.selected.index} cursor=${row.selected.groupCursor}` : "unmatched";
      const dispatch = row.dispatch ? ` group=${row.dispatch.groupId ?? "-"} op0=${row.dispatch.operand0?.typeHex || "-"}` : "";
      const high = row.highOpcode ? ` high=${row.highOpcode.useKind}` : "";
      return `${row.script}:${selected}${dispatch}${high} ${row.status}`;
    }).join("; ");
    const broadRows = safety.broadRows.filter((row) => row.status !== "entry-unmatched").map((row) => `${row.script}:entry${row.selected?.index ?? "-"} cursor=${row.selected?.groupCursor ?? "-"} ${row.status}`).join("; ");
    lines.push(`- XSE entry safety: ${safety.currentFinding}`);
    lines.push(`- XSE entry safety rows: ${rows}`);
    lines.push(`- XSE entry safety broad diagnostics: ${broadRows || "none"}`);
    lines.push(`- XSE entry safety next target: ${safety.nextTarget}`);
  }
  if (report.xseVm.xseRefWidthSafety?.available) {
    const refWidth = report.xseVm.xseRefWidthSafety;
    const rows = refWidth.scripts.map((script) => {
      const modelRows = script.models
        .filter((model) => model.matchCount > 0)
        .map((model) => `${model.id}:${model.matchCount}/safe${model.safeMatchCount}/first${model.firstMatchSafeCount} modes=${model.ref64ModesWithMatches.join("/") || "-"}`)
        .join(",");
      return `${script.name}:${modelRows || "unmatched"}`;
    }).join("; ");
    lines.push(`- XSE ref width safety: ${refWidth.currentFinding}`);
    lines.push(`- XSE ref width safety rows: ${rows}`);
    lines.push(`- XSE ref width safety next target: ${refWidth.nextTarget}`);
  }
  if (report.xseVm.xseCompareAbi?.available) {
    const compareAbi = report.xseVm.xseCompareAbi;
    const branch = compareAbi.branchContract || {};
    lines.push(`- XSE compare ABI: ${compareAbi.currentFinding}`);
    lines.push(`- XSE compare ABI contract: ${branch.slot || "[35C4]+0x50"} stream=${compareAbi.streamCursorReadCount}, compare=${compareAbi.labelRefCompareCount}, return0Match=${compareAbi.compareReturnsZeroOnMatch ? "yes" : "no"}`);
    lines.push(`- XSE compare ABI next target: ${compareAbi.nextTarget}`);
  }
  if (report.xseVm.xseRefNamespace?.available) {
    const refs = report.xseVm.xseRefNamespace;
    const rows = refs.primarySelections.map((row) => {
      const selected = row.selected ? `entry${row.entry} cursor=${row.cursor} ref=${row.ref}${row.refRaw ? ` raw=${row.refRaw}` : ""}` : "unmatched";
      return `${row.script}:${selected} ${row.safetyStatus || "-"}`;
    }).join("; ");
    lines.push(`- XSE ref namespace: ${refs.currentFinding}`);
    lines.push(`- XSE ref namespace primary rows: ${rows}`);
    lines.push(`- XSE ref namespace oracle: compare=${refs.labelRefCompareCount}, scalarSafe=${refs.scalarSafeMatchCount}, unsafeScalar=${refs.unsafeScalarCollisionCount}, resolver=${refs.resolverBound ? "bound" : "unbound"}`);
    lines.push(`- XSE ref namespace next target: ${refs.nextTarget}`);
  }
  if (report.xseVm.xseRef64Loader?.available) {
    const refs = report.xseVm.xseRef64Loader;
    const rows = refs.scripts.map((script) => {
      const top = script.topCandidate;
      const selected = top?.selectedEntry ? ` selected=entry${top.selectedEntry.index} raw=${top.selectedEntry.refRaw} len=${top.selectedEntry.lengthTextStatus}` : "";
      return `${script.name}:${script.status} ${top?.modeKey || "-"} textLike=${top?.entryRefTextLikeCount || 0}/${top?.finalRefTextLikeCount || 0}${selected}`;
    }).join("; ");
    lines.push(`- XSE +0x64 loader: ${refs.currentFinding}`);
    lines.push(`- XSE +0x64 loader rows: ${rows}`);
    lines.push(`- XSE +0x64 loader next target: ${refs.nextTarget}`);
  }
  if (report.xseVm.providerRefContext?.available) {
    const refs = report.xseVm.providerRefContext;
    const rows = refs.contexts.map((context) => `${context.id}:${context.returnClass}${context.safeToParseAsText ? "/text" : "/opaque"} sites=${context.callSites.join(",") || "-"}`).join("; ");
    lines.push(`- Provider ref context: ${refs.currentFinding}`);
    lines.push(`- Provider ref context rows: ${rows}`);
    lines.push(`- Provider ref context next target: ${refs.nextTarget}`);
  }
  if (report.xseVm.xseCompareResolver?.available) {
    const resolver = report.xseVm.xseCompareResolver;
    const rows = resolver.compareSamples.slice(0, 6).map((sample) => `${sample.script}:${sample.refContext}@${sample.refOffset} ${sample.label}->${sample.returnValue} ${sample.resolverStatus}`).join("; ");
    lines.push(`- XSE compare resolver boundary: ${resolver.currentFinding}`);
    lines.push(`- XSE compare resolver samples: ${rows || "none"}`);
    lines.push(`- XSE compare resolver next target: ${resolver.nextTarget}`);
  }
  if (report.xseVm.providerResolverHook?.available) {
    const hook = report.xseVm.providerResolverHook;
    const rows = hook.checks.map((check) => `${check.id}:${check.label}/${check.refId} matched=${check.matched ? "yes" : "no"} expected=${check.expectedMatched ? "yes" : "no"}`).join("; ");
    lines.push(`- Provider resolver hook: ${hook.currentFinding}`);
    lines.push(`- Provider resolver hook rows: ${rows}`);
    lines.push(`- Provider resolver hook next target: ${hook.nextTarget}`);
  }
  if (report.xseVm.provider35c4Tape?.available) {
    const tape = report.xseVm.provider35c4Tape;
    const invariantRows = tape.invariants.map((invariant) => `${invariant.id}:${invariant.passed ? "pass" : "fail"}`).join("; ");
    const eventRows = tape.tape.slice(0, 8).map((event) => `${event.seq}:${event.kind}${event.refId ? `/${event.refId}` : ""}${event.label ? ` ${event.label}->${event.returnValue}` : ""}`).join("; ");
    lines.push(`- Provider 0x35C4 tape: ${tape.currentFinding}`);
    lines.push(`- Provider 0x35C4 tape invariants: ${invariantRows}`);
    lines.push(`- Provider 0x35C4 tape head: ${eventRows || "none"}`);
    lines.push(`- Provider 0x35C4 tape next target: ${tape.nextTarget}`);
  }
  if (report.xseVm.provider35c4Feed?.available) {
    const feed = report.xseVm.provider35c4Feed;
    const invariantRows = feed.invariants.map((invariant) => `${invariant.id}:${invariant.passed ? "pass" : "fail"}`).join("; ");
    const replayRows = feed.replayedCompares.slice(0, 8).map((row) => `${row.seq}:${row.label}/${row.refId} src=${row.sourceReturnValue}->res=${row.resolverReturnValue}`).join("; ");
    lines.push(`- Provider 0x35C4 feed: ${feed.currentFinding}`);
    lines.push(`- Provider 0x35C4 feed invariants: ${invariantRows}`);
    lines.push(`- Provider 0x35C4 feed replay: ${replayRows || "none"}`);
    lines.push(`- Provider 0x35C4 feed next target: ${feed.nextTarget}`);
  }
  if (report.xseVm.provider35c4Capture?.available) {
    const capture = report.xseVm.provider35c4Capture;
    const pointRows = capture.capturePoints.map((point) => `${point.id}:${point.eventKind}@${point.site || point.slot} ${point.ready ? "ready" : "missing"}${point.feedEligible ? "/feed" : ""}`).join("; ");
    const invariantRows = capture.invariants.map((invariant) => `${invariant.id}:${invariant.passed ? "pass" : "fail"}`).join("; ");
    lines.push(`- Provider 0x35C4 capture plan: ${capture.currentFinding}`);
    lines.push(`- Provider 0x35C4 capture points: ${pointRows}`);
    lines.push(`- Provider 0x35C4 capture invariants: ${invariantRows}`);
    lines.push(`- Provider 0x35C4 capture next target: ${capture.nextTarget}`);
  }
  if (report.xseVm.provider35c4Source?.available) {
    const source = report.xseVm.provider35c4Source;
    const pointRows = source.pointCoverage.map((point) => `${point.id}:${point.observedEventCount}`).join("; ");
    const invariantRows = source.invariants.map((invariant) => `${invariant.id}:${invariant.passed ? "pass" : "fail"}`).join("; ");
    const linkRows = source.compareLinks.slice(0, 8).map((row) => `${row.sourceSeq}:${row.callerLabel}/${row.providerRefId}->p${row.producerSeq ?? "-"} ret=${row.returnValue}`).join("; ");
    lines.push(`- Provider 0x35C4 capture source: ${source.currentFinding}`);
    lines.push(`- Provider 0x35C4 source coverage: ${pointRows}`);
    lines.push(`- Provider 0x35C4 source compare links: ${linkRows || "none"}`);
    lines.push(`- Provider 0x35C4 source invariants: ${invariantRows}`);
    lines.push(`- Provider 0x35C4 source next target: ${source.nextTarget}`);
  }
  if (report.xseVm.provider35c4Emu?.available) {
    const emu = report.xseVm.provider35c4Emu;
    const pointRows = emu.pointCoverage.map((point) => `${point.id}:${point.observedEventCount}`).join("; ");
    const invariantRows = emu.invariants.map((invariant) => `${invariant.id}:${invariant.passed ? "pass" : "fail"}`).join("; ");
    const linkRows = emu.compareLinks.slice(0, 8).map((row) => `${row.sourceSeq}:${row.callerLabel}/${row.providerRefId}->p${row.producerSeq ?? "-"} ret=${row.returnValue}`).join("; ");
    lines.push(`- Provider 0x35C4 emulated source: ${emu.currentFinding}`);
    lines.push(`- Provider 0x35C4 emulated source coverage: ${pointRows}`);
    lines.push(`- Provider 0x35C4 emulated source compare links: ${linkRows || "none"}`);
    lines.push(`- Provider 0x35C4 emulated source invariants: ${invariantRows}`);
    lines.push(`- Provider 0x35C4 emulated source next target: ${emu.nextTarget}`);
  }
  if (report.xseVm.provider35c4SvcObj?.available) {
    const svc = report.xseVm.provider35c4SvcObj;
    const invariantRows = svc.invariants.map((invariant) => `${invariant.id}:${invariant.passed ? "pass" : "fail"}`).join("; ");
    const replayRows = svc.replayRows.slice(0, 8).map((row) => `${row.sourceSeq}:${row.dispatchShape}${row.providerRefId ? `/${row.providerRefId}` : ""}${row.callerLabel ? ` ${row.callerLabel}->${row.serviceReturnValue}` : ""}`).join("; ");
    const shapes = (svc.serviceObject?.methodShapes || []).join(", ");
    lines.push(`- Provider 0x35C4 service object: ${svc.currentFinding}`);
    lines.push(`- Provider 0x35C4 service object shapes: ${shapes || "none"}`);
    lines.push(`- Provider 0x35C4 service object replay: ${replayRows || "none"}`);
    lines.push(`- Provider 0x35C4 service object invariants: ${invariantRows}`);
    lines.push(`- Provider 0x35C4 service object next target: ${svc.nextTarget}`);
  }
  if (report.xseVm.provider35c4SvcResolver?.available) {
    const resolver = report.xseVm.provider35c4SvcResolver;
    const invariantRows = resolver.invariants.map((invariant) => `${invariant.id}:${invariant.passed ? "pass" : "fail"}`).join("; ");
    const checkRows = resolver.checks.map((check) => `${check.id}:${check.label}/${check.providerRefId}->${check.returnValue}${check.passed ? "" : "/fail"}`).join("; ");
    lines.push(`- Provider 0x35C4 service resolver: ${resolver.currentFinding}`);
    lines.push(`- Provider 0x35C4 service resolver checks: ${checkRows}`);
    lines.push(`- Provider 0x35C4 service resolver invariants: ${invariantRows}`);
    lines.push(`- Provider 0x35C4 service resolver next target: ${resolver.nextTarget}`);
  }
  if (report.xseVm.provider35c4LiveCall?.available) {
    const live = report.xseVm.provider35c4LiveCall;
    const invariantRows = live.invariants.map((invariant) => `${invariant.id}:${invariant.passed ? "pass" : "fail"}`).join("; ");
    const replayRows = live.replayRows.slice(0, 8).map((row) => `${row.sourceSeq}:${row.method}/${row.dispatchShape}${row.providerRefId ? `/${row.providerRefId}` : ""}${row.callerLabel ? ` ${row.callerLabel}->${row.serviceReturnValue}` : ""}`).join("; ");
    lines.push(`- Provider 0x35C4 live call feeder: ${live.currentFinding}`);
    lines.push(`- Provider 0x35C4 live call replay: ${replayRows || "none"}`);
    lines.push(`- Provider 0x35C4 live call invariants: ${invariantRows}`);
    lines.push(`- Provider 0x35C4 live call next target: ${live.nextTarget}`);
  }
  if (report.xseVm.provider35c4StreamExec?.available) {
    const stream = report.xseVm.provider35c4StreamExec;
    const invariantRows = stream.invariants.map((invariant) => `${invariant.id}:${invariant.passed ? "pass" : "fail"}`).join("; ");
    const replayRows = stream.streamRows.slice(0, 8).map((row) => `${row.callSeq}:${row.method}/${row.dispatchShape}${row.providerRefId ? `/${row.providerRefId}` : ""}${row.callerLabel ? ` ${row.callerLabel}->${row.serviceReturnValue}` : ""}`).join("; ");
    lines.push(`- Provider 0x35C4 stream executor: ${stream.currentFinding}`);
    lines.push(`- Provider 0x35C4 stream executor replay: ${replayRows || "none"}`);
    lines.push(`- Provider 0x35C4 stream executor invariants: ${invariantRows}`);
    lines.push(`- Provider 0x35C4 stream executor next target: ${stream.nextTarget}`);
  }
  if (report.xseVm.provider35c4TableWalk?.available) {
    const table = report.xseVm.provider35c4TableWalk;
    const invariantRows = table.invariants.map((invariant) => `${invariant.id}:${invariant.passed ? "pass" : "fail"}`).join("; ");
    const laneRows = table.lanes.map((lane) => `${lane.laneIndex}:${lane.script}/${lane.policy} entries=${lane.rangeEntriesWalked} refs=${lane.rangeRefsProduced} guards=${lane.guardReasons.join("+") || "none"}`).join("; ");
    lines.push(`- Provider 0x35C4 table walk: ${table.currentFinding}`);
    lines.push(`- Provider 0x35C4 table walk lanes: ${laneRows || "none"}`);
    lines.push(`- Provider 0x35C4 table walk invariants: ${invariantRows}`);
    lines.push(`- Provider 0x35C4 table walk next target: ${table.nextTarget}`);
  }
  if (report.xseVm.provider35c4CountMode?.available) {
    const count = report.xseVm.provider35c4CountMode;
    const invariantRows = count.invariants.map((invariant) => `${invariant.id}:${invariant.passed ? "pass" : "fail"}`).join("; ");
    const scriptRows = count.scripts.map((script) => `${script.name}:${script.status} top=${script.currentTopMode || "-"} selected=${script.selectedMode || "-"} blockers=${script.blockers.join("+") || "none"}`).join("; ");
    lines.push(`- Provider 0x35C4 count mode: ${count.currentFinding}`);
    lines.push(`- Provider 0x35C4 count mode scripts: ${scriptRows || "none"}`);
    lines.push(`- Provider 0x35C4 count mode invariants: ${invariantRows}`);
    lines.push(`- Provider 0x35C4 count mode next target: ${count.nextTarget}`);
  }
  if (report.xseVm.provider35c4SelectedTable?.available) {
    const selected = report.xseVm.provider35c4SelectedTable;
    const invariantRows = selected.invariants.map((invariant) => `${invariant.id}:${invariant.passed ? "pass" : "fail"}`).join("; ");
    const laneRows = selected.lanes.map((lane) => `${lane.laneIndex}:${lane.script}/${lane.policy} ${lane.modeKey} entries=${lane.rangeEntriesWalked} refs=${lane.rangeRefsProduced} guards=${lane.guardReasons.join("+") || "none"}`).join("; ");
    const blockedRows = selected.blocked.map((row) => `${row.script}:${row.blockers.join("+")}`).join("; ");
    lines.push(`- Provider 0x35C4 selected table: ${selected.currentFinding}`);
    lines.push(`- Provider 0x35C4 selected table lanes: ${laneRows || "none"}`);
    lines.push(`- Provider 0x35C4 selected table blocked: ${blockedRows || "none"}`);
    lines.push(`- Provider 0x35C4 selected table invariants: ${invariantRows}`);
    lines.push(`- Provider 0x35C4 selected table next target: ${selected.nextTarget}`);
  }
  if (report.xseVm.provider35c4S02Source?.available) {
    const s02 = report.xseVm.provider35c4S02Source;
    const invariantRows = s02.invariants.map((invariant) => `${invariant.id}:${invariant.passed ? "pass" : "fail"}`).join("; ");
    const attemptRows = s02.attempts.map((attempt) => `${attempt.mode}:groupEnd=${attempt.groupEnd} tailEnd=${attempt.tailEnd} text=${attempt.groupEndStartsInTextPool ? "yes" : "no"}`).join("; ");
    const laneRows = s02.lanes.map((lane) => `${lane.laneIndex}:${lane.policy} ${s02.selected?.modeKey || lane.modeKey} entries=${lane.rangeEntriesWalked} refs=${lane.rangeRefsProduced} guards=${lane.guardReasons.join("+") || "none"}`).join("; ");
    lines.push(`- Provider 0x35C4 s_02 source mode: ${s02.currentFinding}`);
    lines.push(`- Provider 0x35C4 s_02 selected: ${s02.selected ? `${s02.selected.start} ${s02.selected.modeKey} entries=${s02.selected.entryCount} final=${s02.selected.finalRefCount} end=${s02.selected.end} textGap=${s02.selected.textStartDelta}` : "none"}`);
    lines.push(`- Provider 0x35C4 s_02 attempts: ${attemptRows || "none"}`);
    lines.push(`- Provider 0x35C4 s_02 lanes: ${laneRows || "none"}`);
    lines.push(`- Provider 0x35C4 s_02 invariants: ${invariantRows}`);
    lines.push(`- Provider 0x35C4 s_02 next target: ${s02.nextTarget}`);
  }
  if (report.xseVm.provider35c4SelectedFeed?.available) {
    const feed = report.xseVm.provider35c4SelectedFeed;
    const invariantRows = feed.invariants.map((invariant) => `${invariant.id}:${invariant.passed ? "pass" : "fail"}`).join("; ");
    const replayRows = feed.replayedCompares.map((row) => `${row.seq}:${row.script}/${row.policy} ${row.label}->${row.refId} src=${row.returnValue} res=${row.resolverReturnValue}`).join("; ");
    lines.push(`- Provider 0x35C4 selected feed: ${feed.currentFinding}`);
    lines.push(`- Provider 0x35C4 selected feed counts: compares=${feed.selectedCompareCount}, observed=${feed.observedMatchCount}, resolverMatches=${feed.resolverMatchedCount}, promotionEligible=${feed.promotionEligibleCount}, entryPromotable=${feed.entrySafetyPromotableCount}`);
    lines.push(`- Provider 0x35C4 selected feed replay head: ${replayRows || "none"}`);
    lines.push(`- Provider 0x35C4 selected feed invariants: ${invariantRows}`);
    lines.push(`- Provider 0x35C4 selected feed next target: ${feed.nextTarget}`);
  }
  if (report.xseVm.provider35c4PromotionFrontier?.available) {
    const frontier = report.xseVm.provider35c4PromotionFrontier;
    const invariantRows = frontier.invariants.map((invariant) => `${invariant.id}:${invariant.passed ? "pass" : "fail"}`).join("; ");
    const candidateRows = frontier.schedulerCandidates.map((row) => `${row.seq}:${row.script}/${row.policy} entry=${row.entryIndex} ${row.label}->${row.providerRefId} cursor=${row.field00} gid=${row.groupId} target=${row.target} status=${row.status}`).join("; ");
    lines.push(`- Provider 0x35C4 promotion frontier: ${frontier.currentFinding}`);
    lines.push(`- Provider 0x35C4 promotion frontier counts: compares=${frontier.selectedCompareCount}, validCursor=${frontier.validCursorCompareCount}, defaultOnly=${frontier.defaultOnlyCompareCount}, directCase=${frontier.directCaseCompareCount}, schedulerIfObserved=${frontier.schedulerCandidateIfObservedCount}, directIfObserved=${frontier.promotionEligibleIfObservedCount}`);
    lines.push(`- Provider 0x35C4 promotion frontier candidates: ${candidateRows || "none"}`);
    lines.push(`- Provider 0x35C4 promotion frontier invariants: ${invariantRows}`);
    lines.push(`- Provider 0x35C4 promotion frontier next target: ${frontier.nextTarget}`);
  }
  if (report.xseVm.provider35c4FrontierModeScan?.available) {
    const scan = report.xseVm.provider35c4FrontierModeScan;
    const invariantRows = scan.invariants.map((invariant) => `${invariant.id}:${invariant.passed ? "pass" : "fail"}`).join("; ");
    const scriptRows = scan.scripts.map((script) => {
      const source = script.sourceMode?.source && script.sourceMode?.mode ? `${script.sourceMode.source}:${script.sourceMode.mode}` : "-";
      const top = script.topCandidates[0]
        ? `${script.topCandidates[0].source} ${script.topCandidates[0].start} ${script.topCandidates[0].modeKey} sched=${script.topCandidates[0].schedulerCandidateIfObservedCount} direct=${script.topCandidates[0].promotionEligibleIfObservedCount}`
        : "none";
      return `${script.name} ${source} scan=${script.scannedCandidateCount} pool=${script.poolCleanCandidateCount} sched=${script.schedulerCandidateModeCount} direct=${script.directPromotionCandidateModeCount} top=${top}`;
    }).join("; ");
    const modeRows = scan.schedulerCandidateModes.map((mode) => {
      const first = mode.firstSchedulerRow ? `${mode.firstSchedulerRow.label || "?"}@entry${mode.firstSchedulerRow.entryIndex} cursor=${mode.firstSchedulerRow.cursor ?? mode.firstSchedulerRow.field00} target=${mode.firstSchedulerRow.target || ""}` : "none";
      return `${mode.script} ${mode.source} ${mode.start} ${mode.modeKey} entries=${mode.entryCount} sched=${mode.schedulerCandidateIfObservedCount} direct=${mode.promotionEligibleIfObservedCount} first=${first}`;
    }).join("; ");
    lines.push(`- Provider 0x35C4 frontier mode scan: ${scan.currentFinding}`);
    lines.push(`- Provider 0x35C4 frontier mode scan counts: scanned=${scan.scannedCandidateCount}, poolClean=${scan.poolCleanCandidateCount}, schedulerModes=${scan.schedulerCandidateModeCount}, directModes=${scan.directPromotionCandidateModeCount}, schedulerScripts=${scan.schedulerCandidateScriptCount}, directScripts=${scan.directPromotionCandidateScriptCount}`);
    lines.push(`- Provider 0x35C4 frontier mode scan scripts: ${scriptRows || "none"}`);
    lines.push(`- Provider 0x35C4 frontier mode scan scheduler modes: ${modeRows || "none"}`);
    lines.push(`- Provider 0x35C4 frontier mode scan invariants: ${invariantRows}`);
    lines.push(`- Provider 0x35C4 frontier mode scan next target: ${scan.nextTarget}`);
  }
  if (report.xseVm.provider35c4Return0Priority?.available) {
    const priority = report.xseVm.provider35c4Return0Priority;
    const invariantRows = priority.invariants.map((invariant) => `${invariant.id}:${invariant.passed ? "pass" : "fail"}`).join("; ");
    const scriptRows = priority.summaryByScript.map((row) => `${row.script}:selected=${row.selectedRows} mode=${row.modeRows} modes=${row.uniqueModeKeyCount} direct=${row.directRows}`).join("; ");
    const selectedRows = priority.selectedPriorities.map((row) => `${row.priority}:${row.script}/${row.policy} entry=${row.entryIndex} ${row.label}->${row.providerRefId} cursor=${row.cursor} gid=${row.groupId} target=${row.target}`).join("; ");
    const modeRows = priority.modeScanPriorities.map((row) => `${row.priority}:${row.tier} ${row.script} ${row.start} ${row.modeKey} entry=${row.entryIndex} ${row.label} raw=${row.refRaw} cursor=${row.cursor} gid=${row.groupId}`).join("; ");
    lines.push(`- Provider 0x35C4 return-0 priority: ${priority.currentFinding}`);
    lines.push(`- Provider 0x35C4 return-0 priority counts: selectedRows=${priority.selectedPriorityRowCount}, modeRows=${priority.modePriorityRowCount}, modes=${priority.modePriorityModeCount}, knownRefs=${priority.knownProviderRefRowCount}, unknownRefs=${priority.unknownProviderRefRowCount}, directRows=${priority.directCasePriorityRowCount}, executable=${priority.executablePriorityRowCount}`);
    lines.push(`- Provider 0x35C4 return-0 priority scripts: ${scriptRows || "none"}`);
    lines.push(`- Provider 0x35C4 return-0 priority selected head: ${selectedRows || "none"}`);
    lines.push(`- Provider 0x35C4 return-0 priority mode head: ${modeRows || "none"}`);
    lines.push(`- Provider 0x35C4 return-0 priority invariants: ${invariantRows}`);
    lines.push(`- Provider 0x35C4 return-0 priority next target: ${priority.nextTarget}`);
  }
  if (report.xseVm.provider35c4Return0Injection?.available) {
    const inject = report.xseVm.provider35c4Return0Injection;
    const invariantRows = inject.invariants.map((invariant) => `${invariant.id}:${invariant.passed ? "pass" : "fail"}`).join("; ");
    const replayRows = inject.replayRows.map((row) => `${row.priority}:${row.script}/${row.policy} entry=${row.entryIndex} ${row.label}->${row.providerRefId} res=${row.resolverReturnValue} frontier=${row.frontierStatus} direct=${row.directCaseIfObserved ? "yes" : "no"}`).join("; ");
    lines.push(`- Provider 0x35C4 return-0 injection: ${inject.currentFinding}`);
    lines.push(`- Provider 0x35C4 return-0 injection counts: p1=${inject.p1PriorityRowCount}, synthetic=${inject.syntheticObservedMatchCount}, matched=${inject.resolverMatchedCount}, frontier=${inject.joinedFrontierRowCount}, scheduler=${inject.schedulerOnlyRowCount}, direct=${inject.directCaseRowCount}, executable=${inject.executableRowCount}`);
    lines.push(`- Provider 0x35C4 return-0 injection replay: ${replayRows || "none"}`);
    lines.push(`- Provider 0x35C4 return-0 injection invariants: ${invariantRows}`);
    lines.push(`- Provider 0x35C4 return-0 injection next target: ${inject.nextTarget}`);
  }
  if (report.xseVm.provider35c4Return0Capture?.available) {
    const capture = report.xseVm.provider35c4Return0Capture;
    const invariantRows = capture.invariants.map((invariant) => `${invariant.id}:${invariant.passed ? "pass" : "fail"}`).join("; ");
    const replayRows = capture.p1Replays.map((row) => `${row.priority}:${row.script}/${row.policy} entry=${row.entryIndex} ${row.label}->${row.providerRefId} res=${row.resolverReturnValue} frontier=${row.frontierStatus} direct=${row.directCaseIfObserved ? "yes" : "no"}`).join("; ");
    const observedRows = capture.observedMatches.map((row) => `${row.importSeq}:${row.script}/${row.policy} ${row.label}->${row.providerRefId} ret=${row.returnValue}`).join("; ");
    lines.push(`- Provider 0x35C4 return-0 capture adapter: ${capture.currentFinding}`);
    lines.push(`- Provider 0x35C4 return-0 capture source: ${capture.captureSource?.exists ? "present" : "missing"} ${capture.captureSource?.path || ""}`);
    lines.push(`- Provider 0x35C4 return-0 capture counts: imported=${capture.importedObservationCount}, invalid=${capture.invalidObservationCount}, ret0=${capture.return0ObservationCount}, feed=${capture.observedFeedRowCount}, p1=${capture.p1MatchedCount}/${capture.p1PriorityRowCount}, mode=${capture.modeScanMatchedCount}, direct=${capture.directCaseObservedCount}, executable=${capture.executableObservedCount}`);
    lines.push(`- Provider 0x35C4 return-0 capture replay: ${replayRows || "none"}`);
    lines.push(`- Provider 0x35C4 return-0 capture observed: ${observedRows || "none"}`);
    lines.push(`- Provider 0x35C4 return-0 capture invariants: ${invariantRows}`);
    lines.push(`- Provider 0x35C4 return-0 capture next target: ${capture.nextTarget}`);
  }
  if (report.xseVm.provider35c4CapturedFeed?.available) {
    const feed = report.xseVm.provider35c4CapturedFeed;
    const invariantRows = feed.invariants.map((invariant) => `${invariant.id}:${invariant.passed ? "pass" : "fail"}`).join("; ");
    const matchedRows = feed.matchedRows.map((row) => `${row.seq}:${row.script}/${row.policy} entry=${row.entryIndex} ${row.label}->${row.refId} frontier=${row.frontierStatus} direct=${row.directCaseIfObserved ? "yes" : "no"}`).join("; ");
    lines.push(`- Provider 0x35C4 captured selected feed: ${feed.currentFinding}`);
    lines.push(`- Provider 0x35C4 captured selected feed adapter: ${feed.captureAdapter?.status || ""} ${feed.captureAdapter?.captureFileExists ? "present" : "missing"} ${feed.captureAdapter?.captureFile || ""}`);
    lines.push(`- Provider 0x35C4 captured selected feed counts: selected=${feed.selectedCompareCount}/${feed.expectedCompareCount}, feed=${feed.observedFeedRowCount}, matched=${feed.resolverMatchedCount}, frontier=${feed.frontierJoinedCount}, scheduler=${feed.schedulerMatchedCount}, direct=${feed.directMatchedCount}, executable=${feed.executableMatchedCount}`);
    lines.push(`- Provider 0x35C4 captured selected feed matched: ${matchedRows || "none"}`);
    lines.push(`- Provider 0x35C4 captured selected feed invariants: ${invariantRows}`);
    lines.push(`- Provider 0x35C4 captured selected feed next target: ${feed.nextTarget}`);
  }
  if (report.xseVm.provider35c4ObservationRecorder?.available) {
    const recorder = report.xseVm.provider35c4ObservationRecorder;
    const invariantRows = recorder.invariants.map((invariant) => `${invariant.id}:${invariant.passed ? "pass" : "fail"}`).join("; ");
    lines.push(`- Provider 0x35C4 observation recorder: ${recorder.currentFinding}`);
    lines.push(`- Provider 0x35C4 observation recorder output: ${recorder.output?.observationEventFile || ""}; defaultCapture=${recorder.output?.writesDefaultNativeCaptureFile ? "writes" : "not-written"}`);
    lines.push(`- Provider 0x35C4 observation recorder counts: selected=${recorder.selectedObservationCount}/${recorder.selectedExpectedCompareCount}, stream=${recorder.streamObservationCount}/${recorder.streamExpectedCompareCount}, selectedOps=${recorder.selectedOperationCompareCount}, total=${recorder.totalObservationCount}, adapterValid=${recorder.adapterCompatibleObservationCount}, invalid=${recorder.invalidObservationCount}, feed=${recorder.observedFeedRowCount}, nonmatch=${recorder.nonMatchObservationCount}`);
    lines.push(`- Provider 0x35C4 observation recorder adapter check: ${recorder.adapterCheck?.status || ""}; imported=${recorder.adapterCheck?.importedObservationCount || 0}, feed=${recorder.adapterCheck?.observedFeedRowCount || 0}, executable=${recorder.adapterCheck?.executableObservedCount || 0}`);
    lines.push(`- Provider 0x35C4 observation recorder invariants: ${invariantRows}`);
    lines.push(`- Provider 0x35C4 observation recorder next target: ${recorder.nextTarget}`);
  }
  if (report.xseVm.provider35c4RuntimeSink?.available) {
    const sink = report.xseVm.provider35c4RuntimeSink;
    const invariantRows = sink.invariants.map((invariant) => `${invariant.id}:${invariant.passed ? "pass" : "fail"}`).join("; ");
    lines.push(`- Provider 0x35C4 runtime sink: ${sink.currentFinding}`);
    lines.push(`- Provider 0x35C4 runtime sink output: ${sink.output?.observationEventFile || ""}; defaultCapture=${sink.output?.writesDefaultNativeCaptureFile ? "writes" : "not-written"}`);
    lines.push(`- Provider 0x35C4 runtime sink counts: selected=${sink.selectedObservationCount}/${sink.selectedExpectedCompareCount}, stream=${sink.streamObservationCount}/${sink.streamExpectedCompareCount}, total=${sink.totalObservationCount}, adapterValid=${sink.adapterCompatibleObservationCount}, invalid=${sink.invalidObservationCount}, feed=${sink.observedFeedRowCount}, nonmatch=${sink.nonMatchObservationCount}, missingEntryMeta=${sink.selectedMissingEntryMetadataCount}`);
    lines.push(`- Provider 0x35C4 runtime sink adapter check: ${sink.adapterCheck?.status || ""}; imported=${sink.adapterCheck?.importedObservationCount || 0}, feed=${sink.adapterCheck?.observedFeedRowCount || 0}, executable=${sink.adapterCheck?.executableObservedCount || 0}`);
    lines.push(`- Provider 0x35C4 runtime sink selected-feed check: ${sink.selectedFeedCheck?.status || ""}; selected=${sink.selectedFeedCheck?.selectedCompareCount || 0}/${sink.selectedFeedCheck?.expectedCompareCount || 0}, feed=${sink.selectedFeedCheck?.observedFeedRowCount || 0}, matched=${sink.selectedFeedCheck?.resolverMatchedCount || 0}, executable=${sink.selectedFeedCheck?.executableMatchedCount || 0}`);
    lines.push(`- Provider 0x35C4 runtime sink invariants: ${invariantRows}`);
    lines.push(`- Provider 0x35C4 runtime sink next target: ${sink.nextTarget}`);
  }
  if (report.xseVm.cbeRuntimeCore?.available) {
    const core = report.xseVm.cbeRuntimeCore;
    const invariantRows = core.invariants.map((invariant) => `${invariant.id}:${invariant.passed ? "pass" : "fail"}`).join("; ");
    const surfaceRows = Object.entries(core.surfaces || {}).map(([surface, count]) => `${surface}:${count}`).join(", ");
    lines.push(`- CBE runtime core: ${core.currentFinding}`);
    lines.push(`- CBE runtime core output: ${core.output?.providerObservationFile || ""}; defaultCapture=${core.output?.writesDefaultNativeCaptureFile ? "writes" : "not-written"}`);
    lines.push(`- CBE runtime core counts: corpus=${core.corpusReadyCount}/${core.corpusFileCount}, resources=${core.resourceCount}, selected=${core.selectedObservationCount}/${core.selectedExpectedCompareCount}, stream=${core.streamObservationCount}/${core.streamExpectedCompareCount}, total=${core.totalObservationCount}, feed=${core.observedFeedRowCount}, nonmatch=${core.nonMatchObservationCount}, invalid=${core.invalidObservationCount}`);
    lines.push(`- CBE runtime core surfaces: ${surfaceRows || "none"}`);
    lines.push(`- CBE runtime core adapter check: ${core.adapterCheck?.status || ""}; imported=${core.adapterCheck?.importedObservationCount || 0}, feed=${core.adapterCheck?.observedFeedRowCount || 0}, executable=${core.adapterCheck?.executableObservedCount || 0}`);
    lines.push(`- CBE runtime core selected-feed check: ${core.selectedFeedCheck?.status || ""}; selected=${core.selectedFeedCheck?.selectedCompareCount || 0}/${core.selectedFeedCheck?.expectedCompareCount || 0}, feed=${core.selectedFeedCheck?.observedFeedRowCount || 0}, matched=${core.selectedFeedCheck?.resolverMatchedCount || 0}, executable=${core.selectedFeedCheck?.executableMatchedCount || 0}`);
    lines.push(`- CBE runtime core invariants: ${invariantRows}`);
    lines.push(`- CBE runtime core next target: ${core.nextTarget}`);
  }
  if (report.xseVm.cbeRuntimeCoreScene?.available) {
    const sceneCore = report.xseVm.cbeRuntimeCoreScene;
    const invariantRows = sceneCore.invariants.map((invariant) => `${invariant.id}:${invariant.passed ? "pass" : "fail"}`).join("; ");
    const sceneRows = sceneCore.sceneGames.map((game) => `${game.game}:${game.readySceneCount}/${game.sceneCount} anchor=${game.firstScene} ${game.canvas ? `${game.canvas.width}x${game.canvas.height}` : "?"} entities=${game.entityCount} scripts=${game.scriptCount}`).join("; ");
    lines.push(`- CBE runtime core scene corpus: ${sceneCore.currentFinding}`);
    lines.push(`- CBE runtime core scene counts: files=${sceneCore.coreReadyCount}/${sceneCore.fileCount}, sceneGames=${sceneCore.readySceneGameCount}/${sceneCore.sceneGameCount}, scenes=${sceneCore.readySceneResourceCount}/${sceneCore.sceneResourceCount}, canvases=${sceneCore.canvasReadyCount}, sceneFrames=${sceneCore.finalSceneFrameCount}, inputFrames=${sceneCore.inputSceneFrameCount}, maps=${sceneCore.mapLinkedSceneCount} (table=${sceneCore.mapTableSceneCount}, ref=${sceneCore.lengthPrefixedMapSceneCount}, trace=${sceneCore.mapTraceSceneCount}, atlas=${sceneCore.mapAtlasSizedSceneCount}, draw=${sceneCore.mapDrawCandidateSceneCount}, rle=${sceneCore.mapRleCandidateSceneCount}, tileGrid=${sceneCore.mapTileGridCandidateSceneCount}), tilesets=${sceneCore.tilesetLinkedSceneCount}, entityScenes=${sceneCore.entitySceneCount}, scriptScenes=${sceneCore.scriptLinkedSceneCount}, bootFlow=${sceneCore.bootFlowSceneCount}, errors=${sceneCore.sceneResourceErrorCount}`);
    lines.push(`- CBE runtime core scene rows: ${sceneRows}`);
    lines.push(`- CBE runtime core scene invariants: ${invariantRows}`);
    lines.push(`- CBE runtime core scene next target: ${sceneCore.nextTarget}`);
  }
  if (report.xseVm.copyHelper?.available) {
    const helper = report.xseVm.copyHelper;
    const rows = helper.helpers.map((item) => `${item.target}:${item.copyLike ? "copy-like" : "unknown"} nullSafe=${item.nullSafeProven ? "yes" : "no"}${item.firstStoreThroughR0 ? ` firstStore=${item.firstStoreThroughR0}` : ""}`).join("; ");
    lines.push(`- Copy helper: ${helper.currentFinding}`);
    lines.push(`- Copy helper rows: ${rows}`);
    lines.push(`- Copy helper next target: ${helper.nextTarget}`);
  }
  if (report.xseVm.slotAudit?.available) {
    const audit = report.xseVm.slotAudit;
    lines.push(`- Slot audit: ${audit.newFalsification}`);
    lines.push(`- Slot audit next target: ${audit.nextTarget}`);
  }
  if (report.xseVm.serviceLifecycle?.available) {
    const lifecycle = report.xseVm.serviceLifecycle;
    const serviceText = lifecycle.services
      .map((service) => `${service.target} hits=${service.hitCount}`)
      .join(", ");
    lines.push(`- Service lifecycle: ${lifecycle.currentFinding}`);
    lines.push(`- Service globals: ${serviceText}`);
    lines.push(`- Service lifecycle next target: ${lifecycle.nextTarget}`);
  }
  if (report.xseVm.loaderCallers?.available) {
    const callers = report.xseVm.loaderCallers;
    const wrapperText = callers.wrapperRefs
      .map((ref) => `${ref.target}=${ref.count}`)
      .join(", ");
    lines.push(`- Loader callers: ${callers.finding}`);
    lines.push(`- 0x112C4 direct sites: ${callers.x112c4CallSites.join(", ") || "none"}; wrappers ${wrapperText}`);
    lines.push(`- Loader callers next target: ${callers.nextTarget}`);
  }
  if (report.xseVm.wrapperFacade?.available) {
    const facade = report.xseVm.wrapperFacade;
    const wrapperText = facade.focusWrappers
      .map((wrapper) => `${wrapper.start}: ${wrapper.path} refs=${wrapper.directBranchCount}`)
      .join("; ");
    lines.push(`- Wrapper facade: ${facade.facadeMap}`);
    lines.push(`- Wrapper manager root: ${facade.manager.global}${facade.manager.rootSlot} -> ${facade.manager.rootGlobal}; ${wrapperText}`);
    lines.push(`- Wrapper facade next target: ${facade.nextTarget}`);
  }
  if (report.xseVm.facadeSlots?.available) {
    const slots = report.xseVm.facadeSlots;
    const slotText = slots.facadeResolutions
      .map((item) => `${item.wrapper}@${item.offset}:${item.status}${item.bestTarget ? `->${item.bestTarget}` : ""}`)
      .join("; ");
    lines.push(`- Facade slots: ${slots.finding}`);
    lines.push(`- Facade slot resolutions: ${slotText}`);
    lines.push(`- Facade slots next target: ${slots.nextTarget}`);
  }
  if (report.xseVm.managerRoot?.available) {
    const root = report.xseVm.managerRoot;
    const rootAssign = root.assignments.find((item) => item.targetGlobal === "0x35E0");
    lines.push(`- Manager root: ${root.finding}`);
    if (rootAssign) lines.push(`- 0x35E0 assignment: ${rootAssign.site} <= ${rootAssign.source}`);
    lines.push(`- Manager root next target: ${root.nextTarget}`);
  }
  if (report.xseVm.facadeEquivalence?.available) {
    const equiv = report.xseVm.facadeEquivalence;
    const equivText = equiv.equivalences
      .slice(0, 2)
      .map((item) => `${item.wrapper}=>${item.directService}`)
      .join("; ");
    lines.push(`- Facade equivalence: ${equiv.finding}`);
    lines.push(`- Reader normalization: ${equivText}`);
    lines.push(`- Facade equivalence next target: ${equiv.nextTarget}`);
  }
  if (report.xseVm.facadeNormalized?.available) {
    const norm = report.xseVm.facadeNormalized;
    lines.push(`- Facade-normalized probe: ${norm.finding}`);
    lines.push(`- Facade-normalized next target: ${norm.nextTarget}`);
  }
  for (const script of scripts) {
    const best = script.objectProbe?.best;
    const opcodes = best?.opcodeHistogram?.map((item) => `${item.key}:${item.count}`).join(" ") || "-";
    lines.push(`- ${script.name}: ${script.strictStatus}; ${script.strictReason}`);
    if (best) lines.push(`  - reader=${best.reader} groups=${best.groupCount} records=${best.totalRecords} knownOpcode=${best.knownOpcodePercent}% opcodes=${opcodes}`);
  }
  lines.push("");
  lines.push("## Next Emulator Work");
  lines.push("- Keep raw `.CBE` archive access as the runtime source of truth.");
  lines.push("- Reconstruct the shared stream service now proven across XSE, SCE, and sibling table parsers: `[sb+0x35C4]+0x40` open followed by `[sb+0x35C0]+0x50` conversion.");
  lines.push("- Materialize the provider-returned service objects from `0x354`: `0x35C0 <= [[sb+0x3584]+0x04+0x5C]()` and `0x35C4 <= [[sb+0x3584]+0x04+0x64]()`.");
  lines.push("- Implement a provider ABI shim for `providerApi+0x5C -> 0x35C0`, `providerApi+0x64 -> 0x35C4`, and `providerApi+0x80+0x04 -> 0x35E0`; these live services are host-provider returns, not static CBE method tables.");
  lines.push("- Dispatch `[sb+0x35C4]+0x64` by call context: SCE resource-name reads can use length-prefixed text, while XSE range/final refs and child-script handles stay provider-opaque until their consumers are bound.");
  lines.push("- Treat the `0x12326` compare resolver as a provider-service boundary: `[35C4]+0x50` consumes caller labels and opaque refs, and scalar/string guesses remain diagnostics until that service namespace is observed.");
  lines.push("- Keep a provider `0x35C4` instrumentation tape shape between the shim and VM: `+0x64` producers and `+0x50` label/ref consumers can feed the observed-match-only resolver hook when real return-0 rows are captured.");
  lines.push("- Feed the resolver hook only from provider tape return-0 observations; an empty observed feed must replay all label/ref compares as non-matches and leave entry promotion at zero.");
  lines.push("- Replace the provider `0x35C4` shim-tape capture source with live/emulated calls at `0x1173C` range-ref `+0x64` and `0x1233C` label/ref `+0x50` return value first.");
  lines.push("- Keep `[sb+0x35C0]+0x50` stream conversion outside the provider `0x35C4` source; the ABI-shim emulated source now matches the provider-owned adapter subset after excluding conversion handoffs.");
  lines.push("- Route future runtime reads through the `0x35C4` service object boundary: `+0x64` produces provider refs, while `+0x50` dispatches by argument shape into cursor reads or label/ref compares.");
  lines.push("- Feed service-object resolver matches only from exact observed `label + providerRefId` pairs; same-label/wrong-ref and wrong-label/same-ref checks must keep returning non-match.");
  lines.push("- Replace prebuilt provider source events with live call requests into the `0x35C4` service object; the ABI-shim call feeder now proves parity against source replay.");
  lines.push("- Drive the `0x35C4` service object from parsed raw CBE SCE/XSE streams; the stream executor now matches the ABI live-call feeder without using traceEvents as input.");
  lines.push("- Expand the parsed feeder into a guarded full `0x112C4/0x11672` range-table walk; negative count/final-ref lanes are blockers, not promotion candidates.");
  lines.push("- Select pool-clean table lanes before promotion: `s_01/s_03/s_04` use count/ref alternatives, while `s_02` now uses the tail-aligned `u16le` handoff at `0x02A1`; all lanes still require real provider return-0 observations.");
  lines.push("- Replay selected table provider refs through an observed-return0 feed gate: 268 selected compares currently produce 0 resolver matches and 0 promotion-eligible rows with an empty feed.");
  lines.push("- Classify observed-return0 candidates through activation/dispatch/writeback gates before execution: current selected lanes have 4 scheduler-only default-dispatch rows and 0 direct-case promotion frontier rows.");
  lines.push("- Use the broader frontier mode scan as a capture priority list, not an execution license: 425 source/mode candidates produce 28 scheduler-only modes and 0 direct-case promotion modes.");
  lines.push("- Capture provider return-0 values in priority order: P1 has 4 selected rows with known providerRefIds, while P2/P3 has 56 mode-scan rows that still need live +0x64 providerRefIds.");
  lines.push("- Treat synthetic P1 return-0 injection as a plumbing check only: 4/4 resolver matches still produce 0 direct-case and 0 executable rows.");
  lines.push("- Replace synthetic feed through the real return-0 capture adapter: the current observation file is missing, so imported feed rows remain 0 and effects stay disabled.");
  lines.push("- Replay the real capture adapter through the selected feed surface: 268 selected compares join the frontier, but 0 captured feed rows currently produce 0 matches and 0 executable rows.");
  lines.push("- Keep the provider ABI shim as the runtime service boundary: SCE now replays through the shim, and XSE object/table replay now uses the real high-opcode skip path instead of the old strict gate.");
  lines.push("- Use the provider replay as the first runnable service-chain slice: SCE can now be parsed through the provider/open/convert/read path; XSE remains blocked at exact `[sb+0x35C4]+0x50` cursor semantics.");
  lines.push("- Use the cursor +0x50 variant probe as a guardrail: actor 0x0F222 remains plausible under the current compact family, while endian/signedness variants still do not produce a layout-aligned XSE opcode path.");
  lines.push("- Bind the high-opcode records from the corrected `0x112C4` switch replay to the later symbol/handler tables, then resolve the remaining `+0x74/+0x64` tail refs.");
  lines.push("- Trace the runtime object copy/overwrite that resolves the final `sb+0x35C0` and `sb+0x35C4` service instances; static table candidates now include several call-shape rejects.");
  lines.push("- Continue from the `0x3008` service lifecycle chain: identify the allocation/registration point for the live `0x35C4` reader service instead of treating the `0x1122C` reset table as a global write.");
  lines.push("- Model `0x112C4` through its two verified caller facades: direct `[sb+0x35C4]` service reads at `0x10B04`, and wrapper reads through `0x934/0x958` at `0x16482`.");
  lines.push("- Resolve the `0x3584 -> +0x5C -> 0x35E0` manager-root object used by wrapper reader facades, especially method groups `+0x140` and `+0x180`.");
  lines.push("- Keep the static `0x934` facade candidate `0x1125E` rejected by call shape, and trace the runtime method-slot overwrite that populates `0x35E0+0x1C8/+0x1E0`.");
  lines.push("- Emulate the host-provider call `[[sb+0x35F8]+0x08+0x84]()` that writes the live `0x35E0` manager root at `0x004F4`.");
  lines.push("- Normalize wrapper reader calls first: `0x934` behaves like `[0x35C4]+0x4C`, and `0x958` behaves like `[0x35C4]+0x64` at the verified `0x112C4` caller sites.");
  lines.push("- Use the facade-normalized probe result as a guardrail: shallow loose-width opcode paths are not accepted until the real `0x11300..0x1130E` stream conversion and `[sb+0x35C4]+0x50` cursor method are reproduced.");
  lines.push("- Replace symbolic XSE flow guesses with an executable 0x112C4 object/table decoder that preserves high-opcode records and feeds the real script handler dispatch.");
  lines.push("- Bind validated script records to the real handler table service slots (`0x08` number, `0x10` ref/string, `0x38` advance, `0x3C` branch/result).");
  return `${lines.join("\n")}\n`;
}

function main() {
  const args = process.argv.slice(2);
  const input = args[0] ? path.resolve(args[0]) : DEFAULT_INPUT;
  const scene = args[1] || DEFAULT_SCENE;
  const outDir = args[2] ? path.resolve(args[2]) : DEFAULT_OUT;
  fs.mkdirSync(outDir, { recursive: true });
  const report = buildTrueRuntime({ input, scene });
  writeJson(path.join(outDir, "true_runtime_probe.json"), report);
  fs.writeFileSync(path.join(outDir, "true_runtime_probe.md"), renderMarkdown(report), "utf8");
  console.log(`Input: ${report.source.input}`);
  console.log(`Resources: ${report.source.resourceCount} from ${report.source.sectionCount} raw CBE sections`);
  console.log(`Scene: ${report.scene.name} ${report.scene.summary.specific?.sce?.canvas?.width || "?"}x${report.scene.summary.specific?.sce?.canvas?.height || "?"}`);
  console.log(`XSE: ${report.xseVm.executionStatus}`);
  if (report.xseVm.provider35c4LiveCall?.available) {
    const live = report.xseVm.provider35c4LiveCall;
    console.log(`Provider Calls: ${live.status}; calls=${live.callRequestCount}, producers=${live.producerOperationCount}, cursorReads=${live.cursorReadOperationCount}, compares=${live.compareOperationCount}, parity=${live.serviceObjectParity ? "yes" : "no"}, failures=${live.failureCount}`);
  }
  if (report.xseVm.provider35c4StreamExec?.available) {
    const stream = report.xseVm.provider35c4StreamExec;
    console.log(`Provider Stream: ${stream.status}; calls=${stream.parsedCallCount}, producers=${stream.producerOperationCount}, cursorReads=${stream.cursorReadOperationCount}, compares=${stream.compareOperationCount}, rowParity=${stream.rowParity ? "yes" : "no"}, opParity=${stream.operationParity ? "yes" : "no"}, failures=${stream.failureCount}`);
  }
  if (report.xseVm.provider35c4TableWalk?.available) {
    const table = report.xseVm.provider35c4TableWalk;
    console.log(`Provider Table: ${table.status}; lanes=${table.expandedLaneCount}/${table.laneCount}, guarded=${table.guardedLaneCount}, refs=${table.tableEntryRefCount}, cursorReads=${table.cursorReadOperationCount}, compares=${table.compareOperationCount}, ret0=${table.return0CompareCount}, failures=${table.failureCount}`);
  }
  if (report.xseVm.provider35c4SelectedTable?.available) {
    const selected = report.xseVm.provider35c4SelectedTable;
    console.log(`Provider Selected Table: ${selected.status}; lanes=${selected.expandedLaneCount}/${selected.laneCount}, guarded=${selected.guardedLaneCount}, blocked=${selected.blockedScriptCount}, refs=${selected.producerOperationCount}, cursorReads=${selected.cursorReadOperationCount}, compares=${selected.compareOperationCount}, ret0=${selected.return0CompareCount}, failures=${selected.failureCount}`);
  }
  if (report.xseVm.provider35c4S02Source?.available) {
    const s02 = report.xseVm.provider35c4S02Source;
    console.log(`Provider s_02 Source: ${s02.status}; selected=${s02.selected ? `${s02.selected.start}/${s02.selected.modeKey}` : "none"}, lanes=${s02.laneCount}, guarded=${s02.guardedLaneCount}, refs=${s02.producerOperationCount}, compares=${s02.compareOperationCount}, ret0=${s02.return0CompareCount}, failures=${s02.failureCount}`);
  }
  if (report.xseVm.provider35c4SelectedFeed?.available) {
    const feed = report.xseVm.provider35c4SelectedFeed;
    console.log(`Provider Selected Feed: ${feed.status}; compares=${feed.selectedCompareCount}, observed=${feed.observedMatchCount}, resolverMatches=${feed.resolverMatchedCount}, promotionEligible=${feed.promotionEligibleCount}, failures=${feed.failureCount}`);
  }
  if (report.xseVm.provider35c4PromotionFrontier?.available) {
    const frontier = report.xseVm.provider35c4PromotionFrontier;
    console.log(`Provider Promotion Frontier: ${frontier.status}; compares=${frontier.selectedCompareCount}, validCursor=${frontier.validCursorCompareCount}, schedulerIfObserved=${frontier.schedulerCandidateIfObservedCount}, directIfObserved=${frontier.promotionEligibleIfObservedCount}, return0=${frontier.sourceReturn0CompareCount}, failures=${frontier.failureCount}`);
  }
  if (report.xseVm.provider35c4FrontierModeScan?.available) {
    const scan = report.xseVm.provider35c4FrontierModeScan;
    console.log(`Provider Frontier Mode Scan: ${scan.status}; scanned=${scan.scannedCandidateCount}, poolClean=${scan.poolCleanCandidateCount}, schedulerModes=${scan.schedulerCandidateModeCount}, directModes=${scan.directPromotionCandidateModeCount}, failures=${scan.failureCount}`);
  }
  if (report.xseVm.provider35c4Return0Priority?.available) {
    const priority = report.xseVm.provider35c4Return0Priority;
    console.log(`Provider Return0 Priority: ${priority.status}; selectedRows=${priority.selectedPriorityRowCount}, modeRows=${priority.modePriorityRowCount}, knownRefs=${priority.knownProviderRefRowCount}, directRows=${priority.directCasePriorityRowCount}, failures=${priority.failureCount}`);
  }
  if (report.xseVm.provider35c4Return0Injection?.available) {
    const inject = report.xseVm.provider35c4Return0Injection;
    console.log(`Provider Return0 Injection: ${inject.status}; synthetic=${inject.syntheticObservedMatchCount}, matched=${inject.resolverMatchedCount}, direct=${inject.directCaseRowCount}, executable=${inject.executableRowCount}, failures=${inject.failureCount}`);
  }
  if (report.xseVm.provider35c4Return0Capture?.available) {
    const capture = report.xseVm.provider35c4Return0Capture;
    console.log(`Provider Return0 Capture: ${capture.status}; imported=${capture.importedObservationCount}, feed=${capture.observedFeedRowCount}, p1=${capture.p1MatchedCount}/${capture.p1PriorityRowCount}, direct=${capture.directCaseObservedCount}, executable=${capture.executableObservedCount}, failures=${capture.failureCount}`);
  }
  if (report.xseVm.provider35c4CapturedFeed?.available) {
    const feed = report.xseVm.provider35c4CapturedFeed;
    console.log(`Provider Captured Feed: ${feed.status}; selected=${feed.selectedCompareCount}/${feed.expectedCompareCount}, feed=${feed.observedFeedRowCount}, matched=${feed.resolverMatchedCount}, direct=${feed.directMatchedCount}, executable=${feed.executableMatchedCount}, failures=${feed.failureCount}`);
  }
  if (report.xseVm.provider35c4ObservationRecorder?.available) {
    const recorder = report.xseVm.provider35c4ObservationRecorder;
    console.log(`Provider Observation Recorder: ${recorder.status}; selected=${recorder.selectedObservationCount}/${recorder.selectedExpectedCompareCount}, stream=${recorder.streamObservationCount}/${recorder.streamExpectedCompareCount}, events=${recorder.totalObservationCount}, feed=${recorder.observedFeedRowCount}, nonmatch=${recorder.nonMatchObservationCount}, failures=${recorder.failureCount}`);
  }
  if (report.xseVm.provider35c4RuntimeSink?.available) {
    const sink = report.xseVm.provider35c4RuntimeSink;
    console.log(`Provider Runtime Sink: ${sink.status}; selected=${sink.selectedObservationCount}/${sink.selectedExpectedCompareCount}, stream=${sink.streamObservationCount}/${sink.streamExpectedCompareCount}, events=${sink.totalObservationCount}, feed=${sink.observedFeedRowCount}, nonmatch=${sink.nonMatchObservationCount}, failures=${sink.failureCount}`);
  }
  if (report.xseVm.cbeRuntimeCore?.available) {
    const core = report.xseVm.cbeRuntimeCore;
    console.log(`Runtime Core: ${core.status}; corpus=${core.corpusReadyCount}/${core.corpusFileCount}, resources=${core.resourceCount}, events=${core.totalObservationCount}, feed=${core.observedFeedRowCount}, nonmatch=${core.nonMatchObservationCount}, failures=${core.failureCount}`);
  }
  if (report.xseVm.cbeRuntimeCoreScene?.available) {
    const sceneCore = report.xseVm.cbeRuntimeCoreScene;
    console.log(`Runtime Core Scene Corpus: ${sceneCore.status}; sceneGames=${sceneCore.readySceneGameCount}/${sceneCore.sceneGameCount}, scenes=${sceneCore.readySceneResourceCount}/${sceneCore.sceneResourceCount}, canvases=${sceneCore.canvasReadyCount}, sceneFrames=${sceneCore.finalSceneFrameCount}, inputFrames=${sceneCore.inputSceneFrameCount}, maps=${sceneCore.mapLinkedSceneCount} (table=${sceneCore.mapTableSceneCount}, ref=${sceneCore.lengthPrefixedMapSceneCount}, trace=${sceneCore.mapTraceSceneCount}, atlas=${sceneCore.mapAtlasSizedSceneCount}, draw=${sceneCore.mapDrawCandidateSceneCount}, rle=${sceneCore.mapRleCandidateSceneCount}, tileGrid=${sceneCore.mapTileGridCandidateSceneCount}), entityScenes=${sceneCore.entitySceneCount}, scriptScenes=${sceneCore.scriptLinkedSceneCount}, failures=${sceneCore.failureCount}`);
  }
  console.log(`Output: ${outDir}`);
}

if (require.main === module) {
  main();
}

module.exports = {
  DEFAULT_OUT,
  DEFAULT_SCENE,
  buildCatalog,
  buildTrueRuntime,
  findEntry,
  renderMarkdown,
  strictXseProbe,
};
