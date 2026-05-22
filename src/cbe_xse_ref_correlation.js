const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const DEFAULT_OBJECT_JSON = path.join(process.cwd(), "out_godwar_xseobject", "xse_object_trace.json");
const DEFAULT_OUT = path.join(process.cwd(), "out_godwar_xseref");

function hex(n, width = 4) {
  if (!Number.isFinite(n) || n < 0) return "";
  return `0x${n.toString(16).toUpperCase().padStart(width, "0")}`;
}

function numericFields(script, best) {
  const values = [];
  for (const record of best.recordSamples || []) {
    for (const field of record.fields || []) {
      if (Number.isFinite(field.value) && field.label !== "forced-type") {
        values.push({
          source: `record:${record.startHex}:${field.label}`,
          value: field.value,
          raw: field.raw || "",
        });
      }
    }
  }
  for (const step of best.tail?.steps || []) {
    for (const sample of step.samples || []) {
      if (Number.isFinite(sample.value)) {
        values.push({
          source: `tail:${step.label}:${sample.offset}`,
          value: sample.value,
          raw: sample.raw || "",
        });
      }
      for (const key of ["start", "span", "ref"]) {
        if (Number.isFinite(sample[key])) {
          values.push({
            source: `tail:${step.label}:${sample.offset || sample.index}:${key}`,
            value: sample[key],
            raw: sample.raw || "",
          });
        }
      }
    }
  }
  return values;
}

function poolTargets(script) {
  const targets = [];
  for (const run of script.pools?.firstTextRuns || []) {
    targets.push({ kind: "text", offset: run.offset, label: run.text.replace(/\s+/g, " ").slice(0, 40) });
  }
  for (const ref of script.pools?.refs || []) {
    targets.push({ kind: "resource", offset: ref.offset, label: ref.text });
  }
  if (script.pools?.symbolPoolStart >= 0) targets.push({ kind: "symbolStart", offset: script.pools.symbolPoolStart, label: "INIT/_MAIN pool" });
  if (script.pools?.textPoolStart >= 0) targets.push({ kind: "textStart", offset: script.pools.textPoolStart, label: "text/resource pool" });
  return targets.sort((a, b) => a.offset - b.offset);
}

function nearest(value, targets, transforms) {
  const hits = [];
  for (const transform of transforms) {
    const transformed = transform.apply(value);
    if (!Number.isFinite(transformed)) continue;
    for (const target of targets) {
      const delta = transformed - target.offset;
      const abs = Math.abs(delta);
      if (abs <= 16) {
        hits.push({
          transform: transform.name,
          transformed,
          transformedHex: hex(transformed),
          targetKind: target.kind,
          targetOffset: target.offset,
          targetOffsetHex: hex(target.offset),
          targetLabel: target.label,
          delta,
        });
      }
    }
  }
  return hits.sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta)).slice(0, 5);
}

function analyzeScript(script) {
  const best = script.attempts?.[0] || {};
  const values = numericFields(script, best);
  const targets = poolTargets(script);
  const base = script.envelope?.bodyOffset || 0;
  const textStart = script.pools?.textPoolStart ?? -1;
  const symbolStart = script.pools?.symbolPoolStart ?? -1;
  const transforms = [
    { name: "value", apply: (v) => v },
    { name: "base+value", apply: (v) => base + v },
    { name: "textStart+value", apply: (v) => (textStart >= 0 ? textStart + v : NaN) },
    { name: "symbolStart+value", apply: (v) => (symbolStart >= 0 ? symbolStart + v : NaN) },
    { name: "textStart-value", apply: (v) => (textStart >= 0 ? textStart - v : NaN) },
    { name: "symbolStart-value", apply: (v) => (symbolStart >= 0 ? symbolStart - v : NaN) },
  ];
  const correlations = values.map((item) => ({
    ...item,
    valueHex: hex(item.value),
    hits: nearest(item.value, targets, transforms),
  }));
  const matched = correlations.filter((item) => item.hits.length);
  const directTransforms = new Set(["value", "base+value"]);
  const directMatched = correlations.filter((item) => item.hits.some((hit) => directTransforms.has(hit.transform)));
  const weakMatched = matched.filter((item) => !item.hits.some((hit) => directTransforms.has(hit.transform)));
  const byTransform = new Map();
  for (const item of matched) {
    for (const hit of item.hits) byTransform.set(hit.transform, (byTransform.get(hit.transform) || 0) + 1);
  }
  return {
    name: script.name,
    rel: script.rel,
    bestMode: best.shortMode || "",
    tailMode: best.tail?.modes || null,
    groupEnd: best.absoluteGroupEndHex || "",
    tailEnd: best.absoluteTailEndHex || "",
    textPoolStart: script.pools?.textPoolStartHex || "",
    symbolPoolStart: script.pools?.symbolPoolStartHex || "",
    valueCount: values.length,
    matchedCount: matched.length,
    matchPercent: values.length ? Number(((matched.length / values.length) * 100).toFixed(2)) : 0,
    directMatchedCount: directMatched.length,
    directMatchPercent: values.length ? Number(((directMatched.length / values.length) * 100).toFixed(2)) : 0,
    weakMatchedCount: weakMatched.length,
    weakMatchPercent: values.length ? Number(((weakMatched.length / values.length) * 100).toFixed(2)) : 0,
    byTransform: [...byTransform.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    directMatches: directMatched.slice(0, 18),
    weakMatches: weakMatched.slice(0, 18),
    strongestMatches: matched.slice(0, 18),
    unmatchedSamples: correlations.filter((item) => !item.hits.length).slice(0, 18),
    targets,
  };
}

function renderMd(report) {
  const lines = [
    "# God War XSE Ref Correlation",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## Purpose",
    "",
    "This report tests whether parsed object/tail numeric fields directly correlate with visible text/resource/symbol-pool offsets. It is a sanity check for emulator scaffolding, not a VM decompiler.",
    "",
    "## Current Conclusions",
    "",
    "- No focused opening script shows a strong direct-offset correlation from parsed numeric fields to visible pool offsets.",
    "- Many weak near hits are caused by small values like `1`, `8`, or `10` landing near `textStart` under artificial `textStart+value` transforms. These are not direct reference evidence.",
    "- The current best tail modes in `xse_object_trace` remain boundary/alignment hypotheses. Some sampled values are clearly implausible as pool refs, so service `+0x64/+0x74` must remain symbolic.",
    "- The useful next step is callback semantics, not adding more numeric transforms to force matches.",
  ];
  for (const script of report.scripts) {
    lines.push("", `## ${script.name}`, "");
    lines.push(`Rel: ${script.rel}`);
    lines.push(`Best: mode=${script.bestMode}; tailMode=${script.tailMode ? `74=${script.tailMode.ref74Mode},64=${script.tailMode.ref64Mode}` : ""}; groupEnd=${script.groupEnd}; tailEnd=${script.tailEnd}; text=${script.textPoolStart}; symbol=${script.symbolPoolStart}`);
    lines.push(`Values tested: ${script.valueCount}; direct near-pool matches: ${script.directMatchedCount} (${script.directMatchPercent}%); weak pool-relative matches: ${script.weakMatchedCount} (${script.weakMatchPercent}%)`);
    if (script.byTransform.length) {
      lines.push(`Transforms with near hits: ${script.byTransform.map((item) => `${item.name}=${item.count}`).join(", ")}`);
    } else {
      lines.push("Transforms with near hits: none");
    }
    lines.push("");
    lines.push("Pool targets:");
    for (const target of script.targets.slice(0, 12)) {
      lines.push(`- ${hex(target.offset)} ${target.kind}: ${target.label}`);
    }
    lines.push("");
    lines.push("Direct near matches (`value` or `base+value`):");
    if (!script.directMatches.length) {
      lines.push("- none");
    } else {
      for (const item of script.directMatches.slice(0, 8)) {
        const hit = item.hits.find((candidate) => candidate.transform === "value" || candidate.transform === "base+value");
        lines.push(`- ${item.source} value=${item.value} (${item.valueHex}) via ${hit.transform} -> ${hit.targetKind} ${hit.targetOffsetHex} delta=${hit.delta} ${hit.targetLabel}`);
      }
    }
    lines.push("");
    lines.push("Weak pool-relative near matches:");
    if (!script.weakMatches.length) {
      lines.push("- none");
    } else {
      for (const item of script.weakMatches.slice(0, 8)) {
        const hit = item.hits[0];
        lines.push(`- ${item.source} value=${item.value} (${item.valueHex}) via ${hit.transform} -> ${hit.targetKind} ${hit.targetOffsetHex} delta=${hit.delta} ${hit.targetLabel}`);
      }
    }
    lines.push("");
    lines.push("Unmatched samples:");
    for (const item of script.unmatchedSamples.slice(0, 8)) {
      lines.push(`- ${item.source} value=${item.value} (${item.valueHex}) raw=${item.raw}`);
    }
  }
  return lines.join("\n");
}

async function main() {
  const objectJson = path.resolve(process.argv[2] || DEFAULT_OBJECT_JSON);
  const outDir = path.resolve(process.argv[3] || DEFAULT_OUT);
  const objectReport = JSON.parse(fs.readFileSync(objectJson, "utf8"));
  const report = {
    schema: "nicai.cbe.xseRefCorrelation.v1",
    generatedAt: new Date().toISOString(),
    objectJson,
    scripts: (objectReport.scripts || []).map(analyzeScript),
  };
  fs.mkdirSync(outDir, { recursive: true });
  await fsp.writeFile(path.join(outDir, "xse_ref_correlation.json"), JSON.stringify(report, null, 2), "utf8");
  await fsp.writeFile(path.join(outDir, "xse_ref_correlation.md"), renderMd(report), "utf8");
  console.log(`Output: ${outDir}`);
  for (const script of report.scripts) {
    console.log(`${script.name}: values=${script.valueCount} direct=${script.directMatchedCount} (${script.directMatchPercent}%) weak=${script.weakMatchedCount} (${script.weakMatchPercent}%)`);
  }
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
