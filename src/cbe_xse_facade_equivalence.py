#!/usr/bin/env python3
import datetime as _dt
import json
import pathlib
import sys

local_deps = pathlib.Path(__file__).resolve().parent / ".python_deps"
if local_deps.exists():
    sys.path.insert(0, str(local_deps))

from cbe_xse_reader_service_trace import disasm_window, hx, ins_text


DEFAULT_INPUT = pathlib.Path(__file__).resolve().parents[1] / "cbe file" / "众神之战.CBE"
DEFAULT_OUT = pathlib.Path(__file__).resolve().parent / "out_godwar_xsefacadeequiv"

EQUIVALENCES = [
    {
        "role": "child-record count",
        "directSite": 0x10ABE,
        "directService": "[sb+0x35C4]+0x4C",
        "wrapperSite": 0x16442,
        "wrapper": "0x934",
        "semantic": "scalar/field reader used for counts and small record fields",
    },
    {
        "role": "child script/resource handle",
        "directSite": 0x10AE2,
        "directService": "[sb+0x35C4]+0x64",
        "wrapperSite": 0x16470,
        "wrapper": "0x958",
        "semantic": "child-resource handle reader used as r0 for 0x112C4",
    },
    {
        "role": "post-child record field +8",
        "directSite": 0x10B10,
        "directService": "[sb+0x35C4]+0x4C",
        "wrapperSite": 0x1648A,
        "wrapper": "0x934",
        "semantic": "scalar/field reader after nested 0x112C4 returns",
    },
    {
        "role": "post-child record field +4",
        "directSite": 0x10B24,
        "directService": "[sb+0x35C4]+0x4C",
        "wrapperSite": 0x16498,
        "wrapper": "0x934",
        "semantic": "scalar/field reader after nested 0x112C4 returns",
    },
]

KEY_WINDOWS = [
    {
        "name": "direct 0x35C4 facade into 0x112C4",
        "start": 0x10AB6,
        "size": 0x86,
        "note": "Uses [sb+0x35C4]+0x4C for count/fields and +0x64 for child handle before 0x112C4.",
    },
    {
        "name": "wrapper 0x934/0x958 facade into 0x112C4",
        "start": 0x1643E,
        "size": 0x90,
        "note": "The same logical flow uses 0x934 for scalar fields and 0x958 for the child handle.",
    },
]


def build_report(input_path):
    data = pathlib.Path(input_path).read_bytes()
    return {
        "schema": "nicai.cbe.xseFacadeEquivalence.v1",
        "input": str(pathlib.Path(input_path)),
        "generated": _dt.datetime.now(_dt.UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "equivalences": [
            {
                **item,
                "directSiteHex": hx(item["directSite"]),
                "wrapperSiteHex": hx(item["wrapperSite"]),
            }
            for item in EQUIVALENCES
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
            "finding": "The two verified 0x112C4 caller facades give a semantic bridge: wrapper 0x934 aligns with the direct [sb+0x35C4]+0x4C scalar reader, while wrapper 0x958 aligns with [sb+0x35C4]+0x64 child-resource handle creation.",
            "emulatorImpact": "A practical emulator can model wrapper calls by delegating 0x934 to the same scalar-reader semantics as +0x4C and 0x958 to the same child-handle semantics as +0x64, while the exact 0x35E0 host-provider object is still being reconstructed.",
            "nextTarget": "Implement 0x112C4 around this facade-normalized reader interface, then validate record layout against the strict opcode gate.",
        },
    }


def md_row(values):
    return "| " + " | ".join(str(value).replace("|", "\\|") for value in values) + " |"


def render_markdown(report):
    lines = [
        "# XSE Facade Equivalence Trace",
        "",
        f"- Input CBE: `{report['input']}`",
        f"- Generated: {report['generated']}",
        "",
        "## Current Conclusion",
        "",
        f"- {report['conclusion']['finding']}",
        f"- {report['conclusion']['emulatorImpact']}",
        f"- {report['conclusion']['nextTarget']}",
        "",
        "## Equivalence Map",
        "",
        md_row(["Role", "Direct site", "Direct service", "Wrapper site", "Wrapper", "Semantic"]),
        md_row(["---", "---", "---", "---", "---", "---"]),
    ]
    for item in report["equivalences"]:
        lines.append(md_row([
            item["role"],
            item["directSiteHex"],
            item["directService"],
            item["wrapperSiteHex"],
            item["wrapper"],
            item["semantic"],
        ]))

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
    json_path = out_dir / "xse_facade_equivalence.json"
    md_path = out_dir / "xse_facade_equivalence.md"
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    md_path.write_text(render_markdown(report), encoding="utf-8")
    print(f"wrote {json_path}")
    print(f"wrote {md_path}")


if __name__ == "__main__":
    main()
