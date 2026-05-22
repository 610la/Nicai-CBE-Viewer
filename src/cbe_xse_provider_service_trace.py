#!/usr/bin/env python3
import argparse
import datetime as _dt
import json
import pathlib
import sys

BASE_DIR = pathlib.Path(__file__).resolve().parent
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

from cbe_xse_reader_service_trace import disasm_window, hx, ins_text  # noqa: E402


DEFAULT_INPUT = pathlib.Path(__file__).resolve().parents[1] / "cbe file" / "众神之战.CBE"
DEFAULT_OUT = BASE_DIR / "out_godwar_xseprovidersvc"

GLOBAL_BLOCK_BASE = 0x3584

PROVIDER_ASSIGNMENTS = [
    {
        "global": 0x35C0,
        "name": "stream conversion service",
        "store": 0x00434,
        "globalBlockOffset": 0x3C,
        "providerMethod": "+0x5C",
        "expression": "[[sb+0x3584]+0x04 + 0x5C]()",
        "emulatorRole": "conversion method host used by 0x1130E after [35C4]+40 opens a resource",
    },
    {
        "global": 0x35C4,
        "name": "reader/open/cursor service",
        "store": 0x0043C,
        "globalBlockOffset": 0x40,
        "providerMethod": "+0x64",
        "expression": "[[sb+0x3584]+0x04 + 0x64]()",
        "emulatorRole": "open/read/reference/close service used by XSE, SCE, and sibling resource parsers",
    },
    {
        "global": 0x35C8,
        "name": "sibling service",
        "store": 0x00448,
        "globalBlockOffset": 0x44,
        "providerMethod": "+0x6C",
        "expression": "[[sb+0x3584]+0x04 + 0x6C]()",
        "emulatorRole": "sibling service initialized before the 0x3008 pass",
    },
    {
        "global": 0x35E0,
        "name": "manager root for wrapper facades",
        "store": 0x004F4,
        "globalBlockOffset": 0x5C,
        "providerMethod": "+0x84",
        "expression": "[[sb+0x3584]+0x04 + 0x84]()",
        "emulatorRole": "manager root used by 0x934/0x958 wrapper reader facades",
    },
]

BOOT_CALLS = [
    {
        "site": 0x34AAA,
        "target": 0x00354,
        "meaning": "host/provider entry stores the incoming provider at 0x35F8, then calls the 0x354 global-service setup",
    },
    {
        "site": 0x00514,
        "target": 0x02910,
        "meaning": "after provider-service globals are populated, boot enters the first service bootstrap call",
    },
    {
        "site": 0x00518,
        "target": 0x03008,
        "meaning": "boot then runs layered table/constructor passes over the provider-returned service objects",
    },
    {
        "site": 0x0301A,
        "target": 0x02B2C,
        "meaning": "constructor pass A runs on the already-returned 0x35C0 object",
    },
    {
        "site": 0x03024,
        "target": 0x02A4A,
        "meaning": "constructor pass B runs on the same 0x35C0 object and can overwrite pass-A slots",
    },
    {
        "site": 0x0302E,
        "target": 0x02A1E,
        "meaning": "constructor pass A for sibling 0x35C8, not for 0x35C4",
    },
    {
        "site": 0x03038,
        "target": 0x029B4,
        "meaning": "constructor pass B for sibling 0x35C8, not for 0x35C4",
    },
]

WINDOWS = [
    {
        "name": "host/provider entry",
        "start": 0x34AAA,
        "size": 0x24,
        "note": "Stores incoming provider at 0x35F8 and calls 0x354.",
    },
    {
        "name": "0x354 provider-service setup",
        "start": 0x00354,
        "size": 0x130,
        "note": "Populates the flat sb+0x3584 global service block, including 0x35C0 and 0x35C4.",
    },
    {
        "name": "post-provider boot",
        "start": 0x004E0,
        "size": 0x60,
        "note": "After provider assignments, boot calls 0x2910 and 0x3008.",
    },
    {
        "name": "0x3008 constructor passes",
        "start": 0x03008,
        "size": 0x58,
        "note": "Runs table/constructor passes on 0x35C0 and 0x35C8; it does not create 0x35C4.",
    },
]


def md_row(values):
    return "| " + " | ".join(str(value if value is not None else "").replace("|", "\\|") for value in values) + " |"


def build_report(input_file):
    data = pathlib.Path(input_file).read_bytes()
    assignments = []
    for item in PROVIDER_ASSIGNMENTS:
        assignments.append({
            **item,
            "globalHex": hx(item["global"], 4),
            "storeHex": hx(item["store"]),
            "globalBlockBase": hx(GLOBAL_BLOCK_BASE, 4),
            "globalBlockOffsetHex": f"+0x{item['globalBlockOffset']:X}",
        })
    return {
        "schema": "nicai.cbe.xseProviderServiceTrace.v1",
        "input": str(pathlib.Path(input_file)),
        "generatedAt": _dt.datetime.now(_dt.UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "globalBlockBase": GLOBAL_BLOCK_BASE,
        "globalBlockBaseHex": hx(GLOBAL_BLOCK_BASE, 4),
        "providerAssignments": assignments,
        "bootCalls": [
            {
                **call,
                "siteHex": hx(call["site"]),
                "targetHex": hx(call["target"]),
            }
            for call in BOOT_CALLS
        ],
        "windows": [
            {
                **window,
                "startHex": hx(window["start"]),
                "instructions": [ins_text(ins) for ins in disasm_window(data, window["start"], window["size"])],
            }
            for window in WINDOWS
        ],
        "conclusion": {
            "currentFinding": "0x35C0 and 0x35C4 are provider-returned service objects populated in 0x354 before the 0x3008 constructor/table passes run.",
            "serviceSplit": "0x35C0 is stored at 0x3584+0x3C from provider method +0x5C; 0x35C4 is stored at 0x3584+0x40 from provider method +0x64.",
            "bootImpact": "0x3008 mutates/initializes the already-returned 0x35C0 object and sibling 0x35C8; it does not explain the source of 0x35C4.",
            "emulatorImpact": "A real emulator must materialize provider method returns for +0x5C and +0x64 before replaying [35C4]+40, [35C0]+50, and [35C4]+50.",
            "nextTarget": "Resolve or emulate the host/provider object behind [sb+0x3584]+0x04, especially methods +0x5C and +0x64, then inspect the returned live method tables.",
        },
    }


def render_markdown(report):
    lines = [
        "# XSE Provider Service Trace",
        "",
        f"- Input CBE: `{report['input']}`",
        f"- Generated: {report['generatedAt']}",
        "",
        "## Current Conclusion",
        "",
        f"- {report['conclusion']['currentFinding']}",
        f"- {report['conclusion']['serviceSplit']}",
        f"- {report['conclusion']['bootImpact']}",
        f"- {report['conclusion']['emulatorImpact']}",
        f"- Next: {report['conclusion']['nextTarget']}",
        "",
        "## Provider Assignments",
        "",
        md_row(["Global", "Store", "Source", "Role"]),
        md_row(["---", "---", "---", "---"]),
    ]
    for item in report["providerAssignments"]:
        lines.append(md_row([
            f"{item['globalHex']} {item['name']}",
            item["storeHex"],
            item["expression"],
            item["emulatorRole"],
        ]))
    lines.extend(["", "## Boot Calls", ""])
    for call in report["bootCalls"]:
        lines.append(f"- `{call['siteHex']}` -> `{call['targetHex']}`: {call['meaning']}")
    lines.extend(["", "## Disassembly Windows", ""])
    for window in report["windows"]:
        lines.append(f"### {window['name']} `{window['startHex']}`")
        lines.append("")
        lines.append(f"- {window['note']}")
        lines.append("")
        lines.append("```text")
        lines.extend(window["instructions"])
        lines.append("```")
        lines.append("")
    return "\n".join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Trace host/provider service assignments for 0x35C0/0x35C4 and related XSE runtime globals.")
    parser.add_argument("input", nargs="?", default=DEFAULT_INPUT)
    parser.add_argument("out", nargs="?", default=str(DEFAULT_OUT))
    args = parser.parse_args(argv)

    report = build_report(args.input)
    out_dir = pathlib.Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    json_path = out_dir / "xse_provider_service_trace.json"
    md_path = out_dir / "xse_provider_service_trace.md"
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    md_path.write_text(render_markdown(report), encoding="utf-8")
    print(f"wrote {json_path}")
    print(f"wrote {md_path}")


if __name__ == "__main__":
    main()
