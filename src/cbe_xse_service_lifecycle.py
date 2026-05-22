#!/usr/bin/env python3
import datetime as _dt
import json
import pathlib
import re
import sys

local_deps = pathlib.Path(__file__).resolve().parent / ".python_deps"
if local_deps.exists():
    sys.path.insert(0, str(local_deps))

from cbe_global_writes import scan as scan_global_uses
from cbe_xse_slot_audit import direct_bl_refs
from cbe_xse_reader_service_trace import disasm_window, hx, ins_text


DEFAULT_INPUT = pathlib.Path(__file__).resolve().parents[1] / "cbe file" / "众神之战.CBE"
DEFAULT_OUT = pathlib.Path(__file__).resolve().parent / "out_godwar_xseservicelife"

SERVICE_GLOBALS = {
    0x35C0: "stream/open/conversion service used by XSE and SCE paths",
    0x35C4: "resource reader service used by 0x112C4 for open/read/allocate",
    0x35C8: "sibling service initialized beside 0x35C0 during boot",
}

KEY_WINDOWS = [
    {
        "name": "boot service bootstrap",
        "start": 0x04E0,
        "size": 0x60,
        "note": "Boot calls 0x2910 and then 0x3008 after creating several service objects.",
    },
    {
        "name": "0x3584 wrapper family",
        "start": 0x0B14,
        "size": 0xBC,
        "note": "Wrappers route through [sb+0x3584] and then direct-call table initializers such as 0x292E.",
    },
    {
        "name": "multi-service initializer",
        "start": 0x3008,
        "size": 0x58,
        "note": "Initializes service objects behind 0x35C0, 0x35C8 and a later pointer before entering setup at 0xD230.",
    },
    {
        "name": "XSE record reset and loader",
        "start": 0x11206,
        "size": 0x260,
        "note": "Resets script-record tables, opens/converts the stream, then reads records through 0x35C4 method slots.",
    },
]

DIRECT_REF_TARGETS = [
    0x28F6,
    0x2910,
    0x292E,
    0x29B4,
    0x2A1E,
    0x2A4A,
    0x2B2C,
    0x3008,
    0x112C4,
]

SLOT_RE = re.compile(r"\[r\d+\+0x([0-9A-Fa-f]+)\]")


def parse_int(text):
    return int(str(text), 0)


def serialise_use(use):
    address, kind, text = use
    return {
        "address": address,
        "addressHex": hx(address),
        "kind": kind,
        "text": text,
    }


def slot_from_kind(kind):
    match = SLOT_RE.search(kind)
    if not match:
        return None
    return int(match.group(1), 16)


def classify_hit(row):
    use_kinds = [use[1] for use in row["uses"]]
    slots = sorted({slot_from_kind(kind) for kind in use_kinds if slot_from_kind(kind) is not None})
    has_write = any(kind.startswith("WRITE") for kind in use_kinds)
    has_call = any(kind == "CALL" for kind in use_kinds)
    raw_match_labels = [label for label, _, _ in row["matches"]]

    if row["target"] == 0x35C4 and row["offset"] == 0x1122C:
        return {
            "class": "table-reset-overlap",
            "confidence": "high",
            "reason": "The 0x1122C site uses an overlapping literal-pool halfword and zeroes a 64-entry stride-0x10 table; it is not an assignment of the 0x35C4 reader-service pointer.",
            "slots": slots,
            "rawMatchLabels": raw_match_labels,
        }

    if has_write and not slots:
        return {
            "class": "possible-global-write",
            "confidence": "medium",
            "reason": "A write through the sb-relative base appears before a method-slot load; needs manual validation against literal alignment.",
            "slots": slots,
            "rawMatchLabels": raw_match_labels,
        }

    if slots:
        return {
            "class": "service-method-use",
            "confidence": "high",
            "reason": "The global slot is dereferenced, then a method pointer is loaded from the service object.",
            "slots": slots,
            "rawMatchLabels": raw_match_labels,
        }

    if has_call:
        return {
            "class": "service-object-use",
            "confidence": "medium",
            "reason": "The global slot is dereferenced and passed into a direct call or branch target without an immediately decoded method-slot load.",
            "slots": slots,
            "rawMatchLabels": raw_match_labels,
        }

    return {
        "class": "other-reference",
        "confidence": "low",
        "reason": "The literal/add-sb shape references the slot, but this short window does not classify it as a method use or write.",
        "slots": slots,
        "rawMatchLabels": raw_match_labels,
    }


def compact_hit(row):
    verdict = classify_hit(row)
    return {
        "offset": row["offset"],
        "offsetHex": hx(row["offset"]),
        "reg": row["reg"],
        "matches": [
            {
                "label": label,
                "offset": offset,
                "offsetHex": hx(offset),
                "value": value,
                "valueHex": hx(value, 4),
            }
            for label, offset, value in row["matches"]
        ],
        "classification": verdict,
        "uses": [serialise_use(use) for use in row["uses"]],
        "context": row["context"][:16],
    }


def service_summaries(rows):
    out = []
    for target, description in SERVICE_GLOBALS.items():
        hits = [row for row in rows if row["target"] == target]
        compact = [compact_hit(row) for row in hits]
        slot_counts = {}
        class_counts = {}
        direct_write_like = []
        for hit in compact:
            cls = hit["classification"]["class"]
            class_counts[cls] = class_counts.get(cls, 0) + 1
            for slot in hit["classification"]["slots"]:
                slot_counts[f"+0x{slot:X}"] = slot_counts.get(f"+0x{slot:X}", 0) + 1
            if cls == "possible-global-write":
                direct_write_like.append(hit)
        representatives = []
        seen_classes = set()
        for hit in compact:
            cls = hit["classification"]["class"]
            if cls not in seen_classes:
                representatives.append(hit)
                seen_classes.add(cls)
            if len(representatives) >= 8:
                break
        # Keep a few XSE-adjacent method uses even when class representatives
        # have already consumed the same class.
        for hit in compact:
            if hit["offset"] in {0x112C6, 0x11362, 0x1138A, 0x113AA, 0x113EA, 0x11426}:
                if all(item["offset"] != hit["offset"] for item in representatives):
                    representatives.append(hit)
        out.append({
            "target": target,
            "targetHex": hx(target, 4),
            "description": description,
            "hitCount": len(hits),
            "classCounts": dict(sorted(class_counts.items())),
            "slotCounts": dict(sorted(slot_counts.items())),
            "directWriteLikeCount": len(direct_write_like),
            "directWriteLike": direct_write_like[:8],
            "representatives": representatives[:14],
        })
    return out


def window_report(data):
    return [
        {
            **window,
            "startHex": hx(window["start"]),
            "instructions": [ins_text(row) for row in disasm_window(data, window["start"], window["size"])],
        }
        for window in KEY_WINDOWS
    ]


def direct_refs(data):
    return [
        {
            "target": item["target"],
            "targetHex": hx(item["target"]),
            "count": item["count"],
            "sites": [hx(ref["site"]) for ref in item["refs"]],
            "truncated": item["truncated"],
        }
        for item in direct_bl_refs(data, DIRECT_REF_TARGETS)
    ]


def build_report(input_path):
    data = pathlib.Path(input_path).read_bytes()
    rows = scan_global_uses(data, SERVICE_GLOBALS.keys())
    summaries = service_summaries(rows)
    return {
        "schema": "nicai.cbe.xseServiceLifecycle.v1",
        "input": str(pathlib.Path(input_path)),
        "generated": _dt.datetime.now(_dt.UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "services": summaries,
        "keyWindows": window_report(data),
        "directBranchRefs": direct_refs(data),
        "conclusion": {
            "currentFinding": "0x35C0/0x35C4 are already live service-object pointers when the XSE loader runs; the current scans find method use, not a simple direct assignment in the XSE window.",
            "bootChain": "Boot reaches 0x3008, which initializes service objects behind 0x35C0 and 0x35C8, while the 0x3584 wrapper family can route into 0x292E. This explains why static slot-write candidates around 0x292E are constructor/table code rather than final XSE methods.",
            "falsePositive": "The apparent 0x35C4 write at 0x1122C is a table reset produced by overlapping literal-pool interpretation; the valid XSE reader-service uses at 0x112C6/0x11362/0x11426 load 0x35C4 as a pointer and then call +0x78/+0x50/+0x4C.",
            "nextTarget": "Trace allocation/registration before or inside 0x3008 and identify the concrete method table behind the runtime 0x35C0 and 0x35C4 service instances.",
        },
    }


def md_row(values):
    return "| " + " | ".join(str(value).replace("|", "\\|") for value in values) + " |"


def render_markdown(report):
    lines = [
        "# XSE Service Lifecycle Trace",
        "",
        f"- Input CBE: `{report['input']}`",
        f"- Generated: {report['generated']}",
        "",
        "## Current Conclusion",
        "",
        f"- {report['conclusion']['currentFinding']}",
        f"- {report['conclusion']['bootChain']}",
        f"- {report['conclusion']['falsePositive']}",
        f"- {report['conclusion']['nextTarget']}",
        "",
        "## Service Globals",
        "",
        md_row(["Global", "Meaning", "Hits", "Classes", "Method slots"]),
        md_row(["---", "---", "---", "---", "---"]),
    ]
    for service in report["services"]:
        classes = ", ".join(f"{key}:{value}" for key, value in service["classCounts"].items())
        slots = ", ".join(f"{key}:{value}" for key, value in service["slotCounts"].items())
        lines.append(md_row([
            service["targetHex"],
            service["description"],
            service["hitCount"],
            classes,
            slots,
        ]))

    lines.extend(["", "## Representative Uses", ""])
    for service in report["services"]:
        lines.append(f"### `{service['targetHex']}`")
        lines.append("")
        for hit in service["representatives"][:8]:
            cls = hit["classification"]["class"]
            reason = hit["classification"]["reason"]
            uses = "; ".join(use["kind"] for use in hit["uses"][:4])
            lines.append(f"- `{hit['offsetHex']}` {cls}: {uses}")
            lines.append(f"  - {reason}")
        lines.append("")

    lines.extend(["## Direct Branch Chain", ""])
    for ref in report["directBranchRefs"]:
        sites = ", ".join(f"`{site}`" for site in ref["sites"][:10])
        lines.append(f"- `{ref['targetHex']}`: {ref['count']} direct BL refs ({sites})")

    lines.extend(["", "## Key Windows", ""])
    for window in report["keyWindows"]:
        lines.append(f"### {window['name']}")
        lines.append("")
        lines.append(f"- Start: `{window['startHex']}`")
        lines.append(f"- Note: {window['note']}")
        lines.append("")
        for text in window["instructions"][:34]:
            lines.append(f"- `{text}`")
        if len(window["instructions"]) > 34:
            lines.append("- ...")
        lines.append("")
    return "\n".join(lines)


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    input_path = pathlib.Path(argv[0] if argv else DEFAULT_INPUT)
    out_dir = pathlib.Path(argv[1] if len(argv) > 1 else DEFAULT_OUT)
    out_dir.mkdir(parents=True, exist_ok=True)
    report = build_report(input_path)
    json_path = out_dir / "xse_service_lifecycle.json"
    md_path = out_dir / "xse_service_lifecycle.md"
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    md_path.write_text(render_markdown(report), encoding="utf-8")
    print(f"wrote {json_path}")
    print(f"wrote {md_path}")


if __name__ == "__main__":
    main()
