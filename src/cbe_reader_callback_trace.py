#!/usr/bin/env python3
import argparse
import datetime as _dt
import json
import pathlib
import sys

local_deps = pathlib.Path(__file__).resolve().parent / ".python_deps"
if local_deps.exists():
    sys.path.insert(0, str(local_deps))

from capstone import Cs, CS_ARCH_ARM, CS_MODE_THUMB


DEFAULT_INPUT = pathlib.Path(__file__).resolve().parents[1] / "cbe file" / "众神之战.CBE"
DEFAULT_OUT = "out_godwar_reader_callbacks"

WINDOWS = [
    {
        "name": "xse parser post-group callback sites",
        "offset": 0x115B8,
        "size": 0x210,
        "notes": [
            "`0x115B8`, `0x11672`, `0x116EC`, `0x1171E`, `0x11752` all resolve through `sb+0x35C4` when halfword literal-pool candidates are interpreted with the neighboring-pool correction.",
            "`0x11614` loads service slot `+0x74`; `0x1171E` and final-ref loops load service slot `+0x64`.",
        ],
    },
    {
        "name": "reader/base pass B +0x74 halfword candidate",
        "offset": 0xDCA8,
        "size": 0x70,
        "notes": [
            "`0xDCC8` is inside a wrapper starting at `0xDCA8`, not a clean function entry.",
            "The wrapper first calls the primary callback at `[sb+0x3590][0]`, then calls `0xDC4C`; `0xDC4C` prepares a temporary buffer and dispatches through `[sb+0x2444][+0x28]`.",
            "This shape is callback-layer/graphics-like plumbing and should not be treated as the primitive XSE ref reader until a caller signature proves it.",
        ],
    },
    {
        "name": "reader/base pass B +0x74 word diagnostic",
        "offset": 0x11056,
        "size": 0xC8,
        "notes": [
            "`0x11094` is an object-list dispatcher: it iterates `count` entries of stride `0x84` and calls each child object slot `+0x74`.",
            "The nearby sibling at `0x110B6` does the same family of dispatch for slot `+0x78`.",
            "This is a valid callback clue but not a direct stream-reader width.",
        ],
    },
    {
        "name": "reader/base pass B +0x70 candidate",
        "offset": 0xD5EA,
        "size": 0xB0,
        "notes": [
            "`0xD5EA` is a real function prologue and dispatches through service slot `+0x64` near `0xD68A` after clipping/coordinate-style checks.",
            "This makes `+0x70` a higher-level wrapper around `+0x64`, not a separate proof of XSE reference token width.",
        ],
    },
]


ANCHORS = [
    {"address": 0x11614, "label": "XSE opcode2 backfill calls service +0x74"},
    {"address": 0x1171E, "label": "XSE range ref calls service +0x64"},
    {"address": 0x11752, "label": "XSE final-ref count calls service +0x50"},
    {"address": 0xDCA8, "label": "wrapper entry for halfword +0x74 candidate"},
    {"address": 0xDCC8, "label": "mid-wrapper call into 0xDC4C"},
    {"address": 0x11094, "label": "object child dispatcher through +0x74"},
]


CALLER_TARGETS = [
    {"address": 0xDBE6, "label": "pass A +0x64 prologue candidate"},
    {"address": 0xD5EA, "label": "pass B +0x70 wrapper candidate"},
    {"address": 0xDCA8, "label": "pass B +0x74 wrapper entry"},
    {"address": 0xDC4C, "label": "shared draw/callback helper"},
    {"address": 0x11056, "label": "object-child slot dispatcher wrapper"},
    {"address": 0x11094, "label": "mid-dispatch +0x74 slot load"},
]


def hx(value, width=8):
    return f"0x{value & 0xFFFFFFFF:0{width}X}"


def disasm(data, offset, size):
    md = Cs(CS_ARCH_ARM, CS_MODE_THUMB)
    md.detail = True
    rows = []
    for ins in md.disasm(data[offset:offset + size], offset):
        rows.append({
            "address": ins.address,
            "addressHex": hx(ins.address),
            "bytes": ins.bytes.hex(" ").upper(),
            "mnemonic": ins.mnemonic,
            "opStr": ins.op_str,
            "text": f"{hx(ins.address)}: {ins.bytes.hex(' ').upper():<14} {ins.mnemonic:<8} {ins.op_str}".rstrip(),
        })
    return rows


def disasm_one_at(md, data, offset):
    if offset < 0 or offset >= len(data):
        return None
    for ins in md.disasm(data[offset:offset + 8], offset, count=1):
        if ins.address == offset:
            return ins
    return None


def sparse_disasm(data, start, end):
    md = Cs(CS_ARCH_ARM, CS_MODE_THUMB)
    md.detail = False
    for offset in range(start & ~1, min(end, len(data) - 1), 2):
        ins = disasm_one_at(md, data, offset)
        if ins:
            yield ins


def branch_target(ins):
    if ins.mnemonic not in {"bl", "blx", "b"}:
        return None
    text = ins.op_str.strip()
    if not text.startswith("#"):
        return None
    try:
        return int(text[1:], 0)
    except ValueError:
        return None


def context_window(data, address, before=5, after=5):
    start = max(0, address - before * 4)
    end = min(len(data), address + after * 4 + 8)
    rows = []
    for ins in sparse_disasm(data, start, end):
        mark = ">" if ins.address == address else " "
        rows.append({
            "address": ins.address,
            "addressHex": hx(ins.address),
            "text": f"{mark} {hx(ins.address)}: {ins.bytes.hex(' ').upper():<14} {ins.mnemonic:<8} {ins.op_str}".rstrip(),
        })
    return rows


def find_direct_callers(data, targets):
    target_map = {item["address"]: item for item in targets}
    rows = []
    for ins in sparse_disasm(data, 0, len(data)):
        target = branch_target(ins)
        if target not in target_map:
            continue
        rows.append({
            "target": target,
            "targetHex": hx(target),
            "targetLabel": target_map[target]["label"],
            "caller": ins.address,
            "callerHex": hx(ins.address),
            "context": context_window(data, ins.address, 6, 6),
        })
    rows.sort(key=lambda row: (row["target"], row["caller"]))
    return rows


def add_anchor_flags(rows):
    labels = {item["address"]: item["label"] for item in ANCHORS}
    for row in rows:
        row["anchor"] = labels.get(row["address"], "")
    return rows


def summarize_window(data, item):
    rows = add_anchor_flags(disasm(data, item["offset"], item["size"]))
    calls = [
        {
            "address": row["address"],
            "addressHex": row["addressHex"],
            "opStr": row["opStr"],
            "anchor": row["anchor"],
        }
        for row in rows
        if row["mnemonic"] in {"bl", "blx"} or row["anchor"]
    ]
    slotLoads = [
        {
            "address": row["address"],
            "addressHex": row["addressHex"],
            "text": row["text"],
            "anchor": row["anchor"],
        }
        for row in rows
        if "[r0, #0x64]" in row["opStr"]
        or "[r0, #0x74]" in row["opStr"]
        or "[r0, #0x28]" in row["opStr"]
        or "[r0, #0x7c]" in row["opStr"]
        or "[r0, #0x78]" in row["opStr"]
        or row["anchor"]
    ]
    return {
        **item,
        "offsetHex": hx(item["offset"]),
        "endHex": hx(item["offset"] + item["size"]),
        "rows": rows,
        "calls": calls,
        "slotLoads": slotLoads,
    }


def render_md(report):
    lines = [
        "# God War Reader Callback Trace",
        "",
        f"Generated: {report['generated']}",
        "",
        "## Current Conclusions",
        "",
        "- XSE post-group parsing uses the service object reached through `sb+0x35C4`; nearby literal pools also contain `0x86DC`, the per-script record table, so halfword-sensitive reads must stay explicit.",
        "- The `0x35C0 + 0x74` initializer candidate is not yet a primitive XSE reference reader. The halfword ADD-PC path lands inside the `0xDCA8 -> 0xDC4C` wrapper, while the word diagnostic path lands at `0x11094`, an object-child dispatcher through `+0x74`.",
        "- Direct caller scans place the `0xDCA8/0xDC4C/0xD5EA` candidates in draw/coordinate-style wrapper paths, and `0x11056` in object-child dispatch. This is negative evidence against treating those addresses as raw XSE stream readers.",
        "- For emulator work, keep service `+0x64/+0x74` as symbolic callbacks until object/ref arrays can be matched against actual text/resource/symbol-pool indices.",
        "",
        "## Anchors",
        "",
    ]
    for anchor in report["anchors"]:
        lines.append(f"- `{hx(anchor['address'])}`: {anchor['label']}")

    lines.extend(["", "## Direct Caller Scan", ""])
    grouped = {}
    for row in report["directCallers"]:
        grouped.setdefault(row["target"], []).append(row)
    for target in report["callerTargets"]:
        rows = grouped.get(target["address"], [])
        lines.append(f"- `{hx(target['address'])}` {target['label']}: {len(rows)} direct caller(s)")
        for row in rows[:6]:
            lines.append(f"  - caller `{row['callerHex']}`")
        if len(rows) > 6:
            lines.append(f"  - ... {len(rows) - 6} more")
    lines.extend([
        "",
        "Interpretation:",
        "- `0xDCA8` direct callers sit in byte/coordinate loops and are paired with `0xDBD6/0xDC1C` style wrappers.",
        "- `0xDC4C` is shared by the `0xDCA8` wrapper and later sprite/table-looking loops, so it is a helper below a wrapper, not XSE-specific proof.",
        "- `0xD5EA` has many direct callers in coordinate/object paths; the pass-B `+0x70` store is therefore a wrapper clue around `+0x64`-family behavior.",
        "- `0x11056` has a wrapper caller and internally dispatches object child slots; `0x11094` is mid-function and should not be used as a function entry.",
    ])

    for window in report["windows"]:
        lines.extend(["", f"## {window['name']}", ""])
        lines.append(f"Window: `{window['offsetHex']}..{window['endHex']}`")
        lines.append("")
        lines.append("Notes:")
        for note in window["notes"]:
            lines.append(f"- {note}")
        lines.append("")
        lines.append("Focused calls/slot loads:")
        focused = []
        seen = set()
        for row in window["slotLoads"]:
            key = row["address"]
            seen.add(key)
            focused.append(row)
        for call in window["calls"]:
            if call["address"] not in seen:
                focused.append(call)
        focused.sort(key=lambda item: item["address"])
        if not focused:
            lines.append("- none")
        for item in focused:
            label = f" ({item['anchor']})" if item.get("anchor") else ""
            text = item.get("text") or f"{item['addressHex']}: {item.get('opStr', '')}"
            lines.append(f"- `{text}`{label}")
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Trace unresolved CBE service reader callback candidates.")
    parser.add_argument("input", nargs="?", default=DEFAULT_INPUT)
    parser.add_argument("out", nargs="?", default=DEFAULT_OUT)
    args = parser.parse_args()

    data = pathlib.Path(args.input).read_bytes()
    report = {
        "schema": "nicai.cbe.readerCallbackTrace.v1",
        "input": str(pathlib.Path(args.input)),
        "generated": _dt.datetime.now(_dt.UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "anchors": ANCHORS,
        "callerTargets": CALLER_TARGETS,
        "directCallers": find_direct_callers(data, CALLER_TARGETS),
        "windows": [summarize_window(data, item) for item in WINDOWS],
    }

    out_dir = pathlib.Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    json_path = out_dir / "reader_callback_trace.json"
    md_path = out_dir / "reader_callback_trace.md"
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    md_path.write_text(render_md(report), encoding="utf-8")
    print(f"wrote {md_path}")


if __name__ == "__main__":
    main()
