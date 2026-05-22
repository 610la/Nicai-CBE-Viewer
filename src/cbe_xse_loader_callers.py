#!/usr/bin/env python3
import datetime as _dt
import json
import pathlib
import sys

local_deps = pathlib.Path(__file__).resolve().parent / ".python_deps"
if local_deps.exists():
    sys.path.insert(0, str(local_deps))

from cbe_xse_slot_audit import direct_bl_refs
from cbe_xse_reader_service_trace import disasm_window, hx, ins_text


DEFAULT_INPUT = pathlib.Path(__file__).resolve().parents[1] / "cbe file" / "众神之战.CBE"
DEFAULT_OUT = pathlib.Path(__file__).resolve().parent / "out_godwar_xseloadercallers"

WINDOWS = [
    {
        "name": "0x10B04 service-reader caller",
        "start": 0x10AB6,
        "size": 0x84,
        "call": 0x10B04,
        "shape": "reads a per-child script handle through [sb+0x35C4]+0x64, then calls 0x112C4 with r0=handle, r1=record+0x0C, r2=0",
    },
    {
        "name": "0x16482 wrapper-reader caller",
        "start": 0x1643E,
        "size": 0xA4,
        "call": 0x16482,
        "shape": "uses wrapper reads 0x934/0x958, then calls 0x112C4 with r0=wrapper-returned handle, r1=record+0x0C, r2=0",
    },
    {
        "name": "reader wrapper family",
        "start": 0x090A,
        "size": 0x96,
        "call": None,
        "shape": "0x934/0x958 are compact wrapper dispatchers through the boot/global service manager rather than direct 0x35C4 literal loads",
    },
]

TARGETS = [0x934, 0x958, 0x112C4]


def build_report(input_path):
    data = pathlib.Path(input_path).read_bytes()
    direct_refs = direct_bl_refs(data, TARGETS)
    return {
        "schema": "nicai.cbe.xseLoaderCallers.v1",
        "input": str(pathlib.Path(input_path)),
        "generated": _dt.datetime.now(_dt.UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "windows": [
            {
                **window,
                "startHex": hx(window["start"]),
                "callHex": hx(window["call"]) if window["call"] is not None else "",
                "instructions": [ins_text(row) for row in disasm_window(data, window["start"], window["size"])],
            }
            for window in WINDOWS
        ],
        "directBranchRefs": [
            {
                "target": item["target"],
                "targetHex": hx(item["target"]),
                "count": item["count"],
                "sites": [hx(ref["site"]) for ref in item["refs"]],
                "truncated": item["truncated"],
            }
            for item in direct_refs
        ],
        "conclusion": {
            "finding": "There are exactly two direct 0x112C4 callers. Both prepare a child-script record slot at +0x0C and pass r2=0, so 0x112C4 is the shared sub-script/object loader.",
            "serviceCaller": "The 0x10B04 caller uses [sb+0x35C4]+0x4C/+0x64 directly before invoking 0x112C4.",
            "wrapperCaller": "The 0x16482 caller uses wrapper functions 0x934 and 0x958. 0x934 has 24 direct callers and 0x958 has 21, so this is a real alternate reader facade, not a one-off artifact.",
            "nextTarget": "Map wrapper 0x934/0x958 back to their runtime service objects, then implement 0x112C4 with two verified caller facades instead of a single guessed compact-reader width.",
        },
    }


def md_row(values):
    return "| " + " | ".join(str(value).replace("|", "\\|") for value in values) + " |"


def render_markdown(report):
    lines = [
        "# XSE Loader Callers Trace",
        "",
        f"- Input CBE: `{report['input']}`",
        f"- Generated: {report['generated']}",
        "",
        "## Current Conclusion",
        "",
        f"- {report['conclusion']['finding']}",
        f"- {report['conclusion']['serviceCaller']}",
        f"- {report['conclusion']['wrapperCaller']}",
        f"- {report['conclusion']['nextTarget']}",
        "",
        "## Direct Branch References",
        "",
        md_row(["Target", "Count", "Sites"]),
        md_row(["---", "---", "---"]),
    ]
    for ref in report["directBranchRefs"]:
        lines.append(md_row([
            ref["targetHex"],
            ref["count"],
            ", ".join(ref["sites"][:16]) + (" ..." if ref["truncated"] else ""),
        ]))

    lines.extend(["", "## Caller Windows", ""])
    for window in report["windows"]:
        lines.append(f"### {window['name']}")
        lines.append("")
        lines.append(f"- Start: `{window['startHex']}`")
        if window["callHex"]:
            lines.append(f"- Focus call: `{window['callHex']}`")
        lines.append(f"- Shape: {window['shape']}")
        lines.append("")
        for text in window["instructions"][:42]:
            lines.append(f"- `{text}`")
        if len(window["instructions"]) > 42:
            lines.append("- ...")
        lines.append("")
    return "\n".join(lines)


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    input_path = pathlib.Path(argv[0] if argv else DEFAULT_INPUT)
    out_dir = pathlib.Path(argv[1] if len(argv) > 1 else DEFAULT_OUT)
    out_dir.mkdir(parents=True, exist_ok=True)
    report = build_report(input_path)
    json_path = out_dir / "xse_loader_callers.json"
    md_path = out_dir / "xse_loader_callers.md"
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    md_path.write_text(render_markdown(report), encoding="utf-8")
    print(f"wrote {json_path}")
    print(f"wrote {md_path}")


if __name__ == "__main__":
    main()
