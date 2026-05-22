#!/usr/bin/env python3
import argparse
import datetime as _dt
import json
import pathlib
import struct
import sys
from collections import Counter

BASE_DIR = pathlib.Path(__file__).resolve().parent
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

from cbe_xse_reader_service_trace import (  # noqa: E402
    cluster_writes,
    disasm_window,
    hx,
    ins_text,
    scan_method_writes,
)


DEFAULT_INPUT = pathlib.Path(__file__).resolve().parents[1] / "cbe file" / "众神之战.CBE"
DEFAULT_OUT = BASE_DIR / "out_godwar_xsestreamsvc"
FOCUS_SLOTS = [0x38, 0x40, 0x50, 0x64]

CHAIN_DEFS = [
    {
        "id": "xse_112c4",
        "name": "XSE object loader 0x112C4",
        "kind": "xse",
        "window": (0x112FE, 0x1132A),
        "literalPools": [
            {"offset": 0x115F2, "role": "reader/open service", "expectedGlobal": 0x35C4},
            {"offset": 0x1160E, "role": "stream conversion service", "expectedGlobal": 0x35C0},
        ],
        "steps": [
            {"site": 0x11304, "role": "open resource stream", "globalSlot": 0x35C4, "methodSlot": 0x40},
            {"site": 0x1130E, "role": "convert opened stream", "globalSlot": 0x35C0, "methodSlot": 0x50},
            {"site": 0x1131E, "role": "read first object/table count", "globalSlot": 0x35C4, "methodSlot": 0x50},
        ],
        "meaning": "No XSE0 magic check appears here. The converted stream is placed in r4, cursor state starts at sp+4 = 6, then [35C4]+50 reads from the converted stream.",
    },
    {
        "id": "resource_eedc",
        "name": "0xEEDC resource table parser",
        "kind": "sibling-resource-parser",
        "window": (0xEEF0, 0xEFAE),
        "literalPools": [
            {"offset": 0xF5DA, "role": "reader/open service", "expectedGlobal": 0x35C4},
            {"offset": 0xF5DE, "role": "stream conversion service", "expectedGlobal": 0x35C0},
        ],
        "steps": [
            {"site": 0xEEF4, "role": "open resource stream", "globalSlot": 0x35C4, "methodSlot": 0x40},
            {"site": 0xEEFE, "role": "convert opened stream", "globalSlot": 0x35C0, "methodSlot": 0x50},
            {"site": 0xEF14, "role": "read entry count", "globalSlot": 0x35C4, "methodSlot": 0x50},
            {"site": 0xEF3A, "role": "read resource reference", "globalSlot": 0x35C4, "methodSlot": 0x64},
            {"site": 0xEF62, "role": "read secondary count", "globalSlot": 0x35C4, "methodSlot": 0x50},
            {"site": 0xEF8E, "role": "read table field", "globalSlot": 0x35C4, "methodSlot": 0x50},
            {"site": 0xEFA6, "role": "read table field", "globalSlot": 0x35C4, "methodSlot": 0x50},
        ],
        "meaning": "This sibling parser uses the same open/convert pair as XSE, then consumes counts and references through [35C4]+50/+64.",
    },
    {
        "id": "nested_1607c",
        "name": "0x1607C nested-table parser",
        "kind": "sibling-resource-parser",
        "window": (0x16088, 0x16156),
        "literalPools": [
            {"offset": 0x16172, "role": "reader/open service", "expectedGlobal": 0x35C4},
            {"offset": 0x16176, "role": "stream conversion service", "expectedGlobal": 0x35C0},
        ],
        "steps": [
            {"site": 0x1608E, "role": "open resource stream", "globalSlot": 0x35C4, "methodSlot": 0x40},
            {"site": 0x16098, "role": "convert opened stream", "globalSlot": 0x35C0, "methodSlot": 0x50},
            {"site": 0x160A4, "role": "read dimension/count", "globalSlot": 0x35C4, "methodSlot": 0x50},
            {"site": 0x160B0, "role": "read dimension/count", "globalSlot": 0x35C4, "methodSlot": 0x50},
            {"site": 0x160BC, "role": "read dimension/count", "globalSlot": 0x35C4, "methodSlot": 0x50},
            {"site": 0x16118, "role": "read nested-row count", "globalSlot": 0x35C4, "methodSlot": 0x50},
            {"site": 0x16152, "role": "close converted stream", "globalSlot": 0x35C4, "methodSlot": 0x38},
        ],
        "meaning": "This parser opens and converts exactly like XSE, reads a nested matrix through [35C4]+50, and closes the converted stream through [35C4]+38.",
    },
    {
        "id": "sce_107f6",
        "name": "SCE parser 0x107F6 contrast",
        "kind": "sce-parser-contrast",
        "window": (0x107F6, 0x10860),
        "literalPools": [
            {"offset": 0x10BAA, "role": "reader/open service", "expectedGlobal": 0x35C4},
            {"offset": 0x10BAE, "role": "stream conversion service", "expectedGlobal": 0x35C0},
        ],
        "steps": [
            {"site": 0x1080C, "role": "setup before open", "globalSlot": 0x35C4, "methodSlot": 0x78},
            {"site": 0x10816, "role": "open resource stream", "globalSlot": 0x35C4, "methodSlot": 0x40},
            {"site": 0x10820, "role": "convert opened stream", "globalSlot": 0x35C0, "methodSlot": 0x50},
            {"site": 0x10852, "role": "read SCE halfword field", "globalSlot": 0x35C4, "methodSlot": 0x4C},
        ],
        "meaning": "The SCE path uses the same [35C4]+40 then [35C0]+50 shape before it explicitly checks SCE2 at 0x10824..0x1083A.",
    },
]


def parse_int(text):
    return int(str(text), 0)


def read_u32le(data, offset):
    if offset < 0 or offset + 4 > len(data):
        return None
    return struct.unpack_from("<I", data, offset)[0]


def md_row(values):
    return "| " + " | ".join(str(value if value is not None else "").replace("|", "\\|") for value in values) + " |"


def slot_text(slot):
    return f"+0x{slot:X}"


def literal_pool_rows(data, literals):
    out = []
    for item in literals:
        actual = read_u32le(data, item["offset"])
        out.append({
            "offset": item["offset"],
            "offsetHex": hx(item["offset"]),
            "role": item["role"],
            "expectedGlobal": item["expectedGlobal"],
            "expectedGlobalHex": hx(item["expectedGlobal"], 4),
            "actual": actual,
            "actualHex": hx(actual, 4) if actual is not None else "",
            "matches": actual == item["expectedGlobal"],
        })
    return out


def chain_summary(data, chain):
    start, end = chain["window"]
    return {
        "id": chain["id"],
        "name": chain["name"],
        "kind": chain["kind"],
        "windowStart": start,
        "windowEnd": end,
        "window": f"{hx(start)}-{hx(end)}",
        "literalPools": literal_pool_rows(data, chain["literalPools"]),
        "steps": [
            {
                **step,
                "siteHex": hx(step["site"]),
                "globalSlotHex": hx(step["globalSlot"], 4),
                "methodSlotHex": slot_text(step["methodSlot"]),
                "serviceShape": f"[sb+{hx(step['globalSlot'], 4)}]{slot_text(step['methodSlot'])}",
            }
            for step in chain["steps"]
        ],
        "meaning": chain["meaning"],
        "disassembly": [ins_text(ins) for ins in disasm_window(data, start, end - start)],
    }


def summarize_cluster(cluster):
    rows = []
    for row in cluster["rows"]:
        best = row["candidates"][0] if row["candidates"] else None
        rows.append({
            "store": row["store"],
            "storeHex": hx(row["store"]),
            "slot": row["slot"],
            "slotHex": slot_text(row["slot"]),
            "base": row["base"],
            "bestTarget": best["thumb"] if best else None,
            "bestTargetHex": hx(best["thumb"]) if best else "",
            "bestKind": best["targetKind"] if best else "",
            "bestHead": best["head"] if best else "",
            "candidateKind": best["candidateKind"] if best else "",
        })
    return {
        "start": cluster["start"],
        "startHex": hx(cluster["start"]),
        "end": cluster["end"],
        "endHex": hx(cluster["end"]),
        "slots": cluster["slots"],
        "slotHexes": [slot_text(slot) for slot in cluster["slots"]],
        "score": cluster["score"],
        "rows": rows,
    }


def build_report(input_file, cluster_limit=12):
    path = pathlib.Path(input_file)
    data = path.read_bytes()
    method_rows = scan_method_writes(data, FOCUS_SLOTS)
    clusters = cluster_writes(method_rows)
    chains = [chain_summary(data, chain) for chain in CHAIN_DEFS]
    slot_counts = Counter(row["slot"] for row in method_rows)
    shared_chain_ids = [
        chain["id"]
        for chain in chains
        if any(step["globalSlot"] == 0x35C4 and step["methodSlot"] == 0x40 for step in chain["steps"])
        and any(step["globalSlot"] == 0x35C0 and step["methodSlot"] == 0x50 for step in chain["steps"])
    ]

    return {
        "schema": "nicai.cbe.xseStreamServiceTrace.v1",
        "input": str(path),
        "generatedAt": _dt.datetime.now(_dt.UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "focusSlots": FOCUS_SLOTS,
        "chains": chains,
        "methodWriteCount": len(method_rows),
        "methodWriteSlotCounts": {slot_text(slot): slot_counts[slot] for slot in sorted(slot_counts)},
        "topMethodTableClusters": [summarize_cluster(cluster) for cluster in clusters[:cluster_limit]],
        "conclusion": {
            "currentFinding": (
                "XSE 0x112C4, 0xEEDC, 0x1607C, and the SCE parser all share "
                "[sb+0x35C4]+0x40 open followed by [sb+0x35C0]+0x50 conversion."
            ),
            "emulatorImpact": (
                "The emulator cannot execute XSE by reading resource bytes directly; it must model the converted stream "
                "object/pointer plus the [sb+0x35C4]+0x50 cursor reader."
            ),
            "methodTableStatus": (
                "Static method-table scans find plausible +0x38/+0x40/+0x50/+0x64 initializer clusters, "
                "but these are not yet proven to be the live runtime objects stored in globals 0x35C4 and 0x35C0 after constructor copies/overwrites."
            ),
            "sharedOpenConvertChains": shared_chain_ids,
            "nextTarget": (
                "Use the provider-service assignment at 0x354 to materialize globals 0x35C0/0x35C4, resolve the live "
                "+0x40/+0x50 methods returned by provider methods +0x5C/+0x64, then replay 0x112C4 through those exact services."
            ),
        },
    }


def render_markdown(report):
    lines = [
        "# XSE Stream Service Trace",
        "",
        f"- Input CBE: `{report['input']}`",
        f"- Generated: {report['generatedAt']}",
        "",
        "## Current Conclusion",
        "",
        f"- {report['conclusion']['currentFinding']}",
        f"- {report['conclusion']['emulatorImpact']}",
        f"- {report['conclusion']['methodTableStatus']}",
        f"- Next: {report['conclusion']['nextTarget']}",
        "",
        "## Shared Open/Convert Chains",
        "",
    ]
    lines.append(md_row(["Chain", "Open", "Convert", "Reader/Cursor", "Evidence"]))
    lines.append(md_row(["---", "---", "---", "---", "---"]))
    for chain in report["chains"]:
        open_step = next((step for step in chain["steps"] if step["globalSlot"] == 0x35C4 and step["methodSlot"] == 0x40), None)
        convert_step = next((step for step in chain["steps"] if step["globalSlot"] == 0x35C0 and step["methodSlot"] == 0x50), None)
        readers = [
            f"{step['siteHex']} {step['serviceShape']} {step['role']}"
            for step in chain["steps"]
            if step is not open_step and step is not convert_step
        ]
        lines.append(md_row([
            chain["name"],
            f"{open_step['siteHex']} {open_step['serviceShape']}" if open_step else "",
            f"{convert_step['siteHex']} {convert_step['serviceShape']}" if convert_step else "",
            "; ".join(readers),
            chain["meaning"],
        ]))
    lines.extend(["", "## Literal Pools", ""])
    for chain in report["chains"]:
        lines.append(f"### {chain['name']}")
        lines.append("")
        for pool in chain["literalPools"]:
            verdict = "ok" if pool["matches"] else "mismatch"
            lines.append(
                f"- `{pool['offsetHex']}` {pool['role']}: expected `{pool['expectedGlobalHex']}`, "
                f"actual `{pool['actualHex']}` ({verdict})"
            )
        lines.append("")
    lines.extend(["## Top Method-Table Clusters", ""])
    lines.append(f"- Method writes in focus slots: {report['methodWriteCount']} ({report['methodWriteSlotCounts']})")
    lines.append("")
    for cluster in report["topMethodTableClusters"]:
        lines.append(f"### `{cluster['startHex']}`-`{cluster['endHex']}` score={cluster['score']}")
        lines.append("")
        lines.append(f"- Slots: {', '.join(cluster['slotHexes'])}")
        for row in cluster["rows"][:10]:
            target = f"`{row['bestTargetHex']}` {row['bestKind']} head=`{row['bestHead']}`" if row["bestTargetHex"] else "no candidate"
            lines.append(f"- store `{row['storeHex']}` -> `{row['slotHex']}` {target}")
        lines.append("")
    lines.extend(["## Disassembly Excerpts", ""])
    for chain in report["chains"]:
        lines.append(f"### {chain['name']} `{chain['window']}`")
        lines.append("")
        lines.append("```text")
        lines.extend(chain["disassembly"])
        lines.append("```")
        lines.append("")
    return "\n".join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Trace shared CBE stream open/convert service chains used by XSE and sibling parsers.")
    parser.add_argument("input", nargs="?", default=DEFAULT_INPUT)
    parser.add_argument("out", nargs="?", default=str(DEFAULT_OUT))
    parser.add_argument("--clusters", default="12")
    args = parser.parse_args(argv)

    report = build_report(args.input, parse_int(args.clusters))
    out_dir = pathlib.Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    json_path = out_dir / "xse_stream_service_trace.json"
    md_path = out_dir / "xse_stream_service_trace.md"
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    md_path.write_text(render_markdown(report), encoding="utf-8")
    print(f"wrote {json_path}")
    print(f"wrote {md_path}")


if __name__ == "__main__":
    main()
