const fs = require("fs");
const path = require("path");
const { DEFAULT_INPUT } = require("./cbe_unpack");
const { createObservedProviderRefResolver } = require("./cbe_provider_abi_shim_probe");

const DEFAULT_OUT = path.resolve(__dirname, "out_godwar_provider35c4feed");
const PROVIDER35C4_TAPE_JSON = path.resolve(__dirname, "out_godwar_provider35c4tape", "provider35c4_tape_probe.json");
const ENTRY_SAFETY_JSON = path.resolve(__dirname, "out_godwar_xseentrysafety", "xse_entry_safety_probe.json");

function readJson(file, fallback = null) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function mdRow(values) {
  return `| ${values.map((value) => String(value ?? "").replace(/\|/g, "\\|")).join(" | ")} |`;
}

function normalizeLabel(label) {
  return String(label || "").trim().toLowerCase();
}

function buildObservedMatches(tape) {
  const rows = (tape?.observedMatches || []).filter((match) => match.providerRefId && (match.label || match.normalizedLabel));
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const label = row.label || row.normalizedLabel || "";
    const normalizedLabel = row.normalizedLabel || normalizeLabel(label);
    const key = `${normalizedLabel}|${row.providerRefId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      label,
      normalizedLabel,
      providerRefId: row.providerRefId,
      source: row.source || "provider35c4-tape-return0",
      compareStatus: row.compareStatus || "",
      returnValue: row.returnValue,
    });
  }
  return out;
}

function replayCompareEvents(tape, observedMatches) {
  const resolver = createObservedProviderRefResolver(observedMatches);
  return (tape?.tape || [])
    .filter((event) => event.kind === "label-ref-consumer")
    .map((event) => {
      const result = resolver({
        callerLabel: event.label,
        normalizedLabel: event.normalizedLabel || normalizeLabel(event.label),
        entryRef: {
          kind: "provider-opaque-ref",
          context: event.context || "",
          providerRefId: event.refId || "",
          resource: event.resource || "",
          policy: event.policy || "",
          offset: event.offset || "",
          rawSample: event.rawSample || "",
        },
      });
      const matched = Boolean(result?.matched);
      return {
        seq: event.seq,
        label: event.label || "",
        normalizedLabel: event.normalizedLabel || normalizeLabel(event.label),
        refId: event.refId || "",
        resource: event.resource || "",
        context: event.context || "",
        sourceReturnValue: event.returnValue,
        sourceMatched: Boolean(event.returnValue === 0 || event.matched),
        sourceStatus: event.compareStatus || "",
        resolverStatus: result?.status || "",
        resolverReturnValue: matched ? 0 : 1,
        resolverMatched: matched,
        promotionEligible: matched && event.refId && (event.label || event.normalizedLabel),
      };
    });
}

function buildInvariant(id, passed, details, impact = "") {
  return { id, passed: Boolean(passed), details, impact };
}

function buildReport(options = {}) {
  const input = path.resolve(options.input || DEFAULT_INPUT);
  const tape = readJson(PROVIDER35C4_TAPE_JSON, {});
  const entrySafety = readJson(ENTRY_SAFETY_JSON, {});
  const observedMatches = buildObservedMatches(tape);
  const replays = replayCompareEvents(tape, observedMatches);
  const resolverMatches = replays.filter((row) => row.resolverMatched);
  const sourceMatches = replays.filter((row) => row.sourceMatched);
  const nonObservedResolverMatches = replays.filter((row) => row.resolverMatched && !row.sourceMatched);
  const missedSourceMatches = replays.filter((row) => row.sourceMatched && !row.resolverMatched);
  const promotionEligibleRows = replays.filter((row) => row.promotionEligible);
  const entryPromotableCount = entrySafety?.summary?.promotablePrimaryCount ?? (entrySafety?.primaryRows || []).filter((row) => row.status === "entry-promotable").length;
  const invariants = [
    buildInvariant(
      "feed-derived-only-from-return0",
      observedMatches.length === sourceMatches.length,
      `${observedMatches.length} observed feed row(s), ${sourceMatches.length} source return-0 compare row(s)`,
      "The hook feed must be a projection of real provider compare results."
    ),
    buildInvariant(
      "resolver-does-not-invent-matches",
      nonObservedResolverMatches.length === 0,
      `${nonObservedResolverMatches.length} resolver match(es) without source return-0`,
      "ProviderRefId/label coincidences alone cannot promote entries."
    ),
    buildInvariant(
      "resolver-covers-observed-matches",
      missedSourceMatches.length === 0,
      `${missedSourceMatches.length} source return-0 row(s) missed by the observed-match resolver`,
      "When real provider return-0 rows appear, the feed path should make them selectable."
    ),
    buildInvariant(
      "empty-feed-keeps-promotions-disabled",
      observedMatches.length > 0 || promotionEligibleRows.length === 0,
      `${promotionEligibleRows.length} promotion-eligible replay row(s) with ${observedMatches.length} feed row(s)`,
      "A zero-observation tape must leave XSE label-entry promotion disabled."
    ),
    buildInvariant(
      "entry-safety-still-demotes",
      entryPromotableCount === 0,
      `${entryPromotableCount} currently promotable primary entry selection(s) in entry-safety output`,
      "The compare feed does not override the existing activation/writeback safety gate."
    ),
  ];
  const failures = invariants.filter((item) => !item.passed);
  return {
    schema: "nicai.cbe.provider35c4ObservedFeedProbe.v1",
    generatedAt: new Date().toISOString(),
    input,
    inputs: {
      provider35c4Tape: PROVIDER35C4_TAPE_JSON,
      entrySafety: ENTRY_SAFETY_JSON,
    },
    feed: {
      observedMatchCount: observedMatches.length,
      sourceReturn0CompareCount: sourceMatches.length,
      resolverReplayCount: replays.length,
      resolverMatchedCount: resolverMatches.length,
      nonObservedResolverMatchCount: nonObservedResolverMatches.length,
      missedSourceMatchCount: missedSourceMatches.length,
      promotionEligibleCount: promotionEligibleRows.length,
      entrySafetyPromotableCount: entryPromotableCount,
    },
    observedMatches,
    replayedCompares: replays.slice(0, 80),
    invariants,
    summary: {
      status: failures.length ? "provider35c4-feed-risk" : "provider35c4-feed-guarded-empty",
      currentFinding: "The provider 0x35C4 resolver feed is now wired from tape return-0 observations only. The current tape has no observed return-0 rows, so replaying label/ref compares through the hook produces no matches.",
      emulatorImpact: "This gives the generic emulator a real feed contract without promoting guessed refs. A future live provider tape can add observed matches, but entry promotion still has to pass activation and writeback safety.",
      nextTarget: "Capture or emulate real provider 0x35C4 +0x50 return-0 compare rows, then re-run this feed probe to verify observed providerRefId/label matches before enabling any XSE entry promotion.",
      visibleEffectsEnabled: false,
      failureCount: failures.length,
      observedMatchCount: observedMatches.length,
      resolverReplayCount: replays.length,
      resolverMatchedCount: resolverMatches.length,
      promotionEligibleCount: promotionEligibleRows.length,
      entrySafetyPromotableCount: entryPromotableCount,
    },
  };
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# Provider 0x35C4 Observed Feed Probe");
  lines.push("");
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Input CBE: \`${report.input}\``);
  lines.push(`- Status: ${report.summary.status}`);
  lines.push(`- Finding: ${report.summary.currentFinding}`);
  lines.push(`- Emulator impact: ${report.summary.emulatorImpact}`);
  lines.push(`- Next target: ${report.summary.nextTarget}`);
  lines.push("");
  lines.push("## Feed Counts");
  lines.push("");
  lines.push(mdRow(["Field", "Value"]));
  lines.push(mdRow(["---", "---:"]));
  for (const [key, value] of Object.entries(report.feed)) {
    lines.push(mdRow([key, value]));
  }
  lines.push("");
  lines.push("## Invariants");
  lines.push("");
  lines.push(mdRow(["Invariant", "Pass", "Details", "Impact"]));
  lines.push(mdRow(["---", "---", "---", "---"]));
  for (const invariant of report.invariants) {
    lines.push(mdRow([
      invariant.id,
      invariant.passed ? "yes" : "no",
      invariant.details,
      invariant.impact,
    ]));
  }
  lines.push("");
  lines.push("## Observed Feed Rows");
  lines.push("");
  if (report.observedMatches.length) {
    lines.push(mdRow(["Label", "Normalized", "Provider Ref", "Source", "Return"]));
    lines.push(mdRow(["---", "---", "---", "---", "---:"]));
    for (const row of report.observedMatches) {
      lines.push(mdRow([row.label, row.normalizedLabel, row.providerRefId, row.source, row.returnValue]));
    }
  } else {
    lines.push("- No observed return-0 providerRefId/label rows are available yet.");
  }
  lines.push("");
  lines.push("## Compare Replay Head");
  lines.push("");
  lines.push(mdRow(["Seq", "Resource", "Label", "Ref", "Source Return", "Resolver Return", "Resolver Status"]));
  lines.push(mdRow(["---:", "---", "---", "---", "---:", "---:", "---"]));
  for (const row of report.replayedCompares.slice(0, 48)) {
    lines.push(mdRow([
      row.seq,
      row.resource,
      row.label,
      row.refId,
      row.sourceReturnValue,
      row.resolverReturnValue,
      row.resolverStatus,
    ]));
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
  const jsonFile = path.join(outDir, "provider35c4_feed_probe.json");
  const mdFile = path.join(outDir, "provider35c4_feed_probe.md");
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
  buildObservedMatches,
  buildReport,
  renderMarkdown,
  replayCompareEvents,
};
