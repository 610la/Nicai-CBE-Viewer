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
DEFAULT_OUT = pathlib.Path(__file__).resolve().parent / "out_godwar_xsemanagerroot"

KEY_WINDOWS = [
    {
        "name": "host bridge into 0x354 setup",
        "start": 0x34AAA,
        "size": 0x20,
        "note": "External/host-facing bridge stores an incoming pointer and calls the 0x354 global service setup.",
    },
    {
        "name": "0x3584 global service setup",
        "start": 0x0354,
        "size": 0xF0,
        "note": "Builds the flat global service block rooted at sb+0x3584 from the parent object at [sb+0x3584]+0x74.",
    },
    {
        "name": "0x35E0 manager-root assignment",
        "start": 0x04E4,
        "size": 0x38,
        "note": "Calls a parent-provider method at [[sb+0x3584]+4 + 0x84] and stores the return value in [sb+0x35E0].",
    },
]

ROOT_ASSIGNMENTS = [
    {
        "site": 0x34AB0,
        "targetGlobal": 0x35F8,
        "source": "incoming host/provider r0",
        "meaning": "parent provider pointer consumed by 0x354 at [sb+0x3584]+0x74",
    },
    {
        "site": 0x037E,
        "targetGlobal": 0x3588,
        "source": "[[sb+0x35F8]+0x08]",
        "meaning": "parent service object used as the provider for manager roots",
    },
    {
        "site": 0x04F4,
        "targetGlobal": 0x35E0,
        "source": "[[sb+0x35F8]+0x08 + 0x84]()",
        "meaning": "manager-root pointer used by 0x934/0x958 wrapper facades",
    },
    {
        "site": 0x04FE,
        "targetGlobal": 0x35E4,
        "source": "[[sb+0x35F8]+0x08 + 0xA0]()",
        "meaning": "sibling root/provider pointer used by later wrappers",
    },
    {
        "site": 0x0508,
        "targetGlobal": 0x35E8,
        "source": "[[sb+0x35F8]+0x08 + 0xC8]()",
        "meaning": "sibling root/provider pointer",
    },
    {
        "site": 0x0512,
        "targetGlobal": 0x35EC,
        "source": "[[sb+0x35F8]+0x08 + 0xCC]()",
        "meaning": "sibling root/provider pointer used just before 0x2910/0x3008 boot calls",
    },
]


def build_report(input_path):
    data = pathlib.Path(input_path).read_bytes()
    refs = direct_bl_refs(data, [0x0354, 0x2910, 0x3008])
    return {
        "schema": "nicai.cbe.xseManagerRootTrace.v1",
        "input": str(pathlib.Path(input_path)),
        "generated": _dt.datetime.now(_dt.UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "assignments": [
            {
                **item,
                "siteHex": hx(item["site"]),
                "targetGlobalHex": hx(item["targetGlobal"], 4),
            }
            for item in ROOT_ASSIGNMENTS
        ],
        "directBranchRefs": [
            {
                "target": item["target"],
                "targetHex": hx(item["target"]),
                "count": item["count"],
                "sites": [hx(ref["site"]) for ref in item["refs"]],
                "truncated": item["truncated"],
            }
            for item in refs
        ],
        "keyWindows": [
            {
                **window,
                "startHex": hx(window["start"]),
                "instructions": [ins_text(row) for row in disasm_window(data, window["start"], window["size"])],
            }
            for window in KEY_WINDOWS
        ],
        "conclusion": {
            "finding": "The live 0x35E0 manager root is not a simple static method-table initializer. It is assigned at 0x004F4 from the host/parent provider stored at 0x35F8.",
            "bootBridge": "The 0x34AAA host bridge stores incoming r0 at 0x35F8 and calls 0x354 once; 0x354 copies [0x35F8+0x08] into 0x3588, fills the 0x3584 flat service block, and only afterward calls 0x2910 and 0x3008.",
            "facadeImpact": "0x934/0x958 wrapper facades therefore depend on the object returned by [[sb+0x35F8]+0x08+0x84](), not on the rejected static 0x2B2C candidate.",
            "nextTarget": "Emulate or trace the host provider at 0x35F8, especially [[0x35F8]+0x08+0x84](), to materialize the true 0x35E0 object, then read its +0x1C8/+0x1E0 facade slots.",
        },
    }


def md_row(values):
    return "| " + " | ".join(str(value).replace("|", "\\|") for value in values) + " |"


def render_markdown(report):
    lines = [
        "# XSE Manager Root Trace",
        "",
        f"- Input CBE: `{report['input']}`",
        f"- Generated: {report['generated']}",
        "",
        "## Current Conclusion",
        "",
        f"- {report['conclusion']['finding']}",
        f"- {report['conclusion']['bootBridge']}",
        f"- {report['conclusion']['facadeImpact']}",
        f"- {report['conclusion']['nextTarget']}",
        "",
        "## Root Assignments",
        "",
        md_row(["Site", "Target global", "Source", "Meaning"]),
        md_row(["---", "---", "---", "---"]),
    ]
    for item in report["assignments"]:
        lines.append(md_row([item["siteHex"], item["targetGlobalHex"], item["source"], item["meaning"]]))

    lines.extend(["", "## Direct Branch References", ""])
    for ref in report["directBranchRefs"]:
        lines.append(f"- `{ref['targetHex']}`: {ref['count']} refs ({', '.join(ref['sites'])})")

    lines.extend(["", "## Key Windows", ""])
    for window in report["keyWindows"]:
        lines.append(f"### {window['name']}")
        lines.append("")
        lines.append(f"- Start: `{window['startHex']}`")
        lines.append(f"- Note: {window['note']}")
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
    json_path = out_dir / "xse_manager_root_trace.json"
    md_path = out_dir / "xse_manager_root_trace.md"
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    md_path.write_text(render_markdown(report), encoding="utf-8")
    print(f"wrote {json_path}")
    print(f"wrote {md_path}")


if __name__ == "__main__":
    main()
