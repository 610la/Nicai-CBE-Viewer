#!/usr/bin/env python3
import json
import pathlib
import sys
from datetime import UTC, datetime

local_deps = pathlib.Path(__file__).resolve().parent / ".python_deps"
if local_deps.exists():
    sys.path.insert(0, str(local_deps))

from capstone import Cs, CS_ARCH_ARM, CS_MODE_THUMB


DEFAULT_INPUT = pathlib.Path(__file__).resolve().parents[1] / "cbe file" / "众神之战.CBE"
DEFAULT_OUT = pathlib.Path(__file__).resolve().parent / "out_godwar_xsecomparesvc"

WINDOWS = [
    {
        "name": "0x112C4 compact/header reader",
        "start": 0x11316,
        "end": 0x1131E,
        "slot": "+0x50",
        "role": "stream,cursor numeric reader",
        "shape": "r0=converted stream; r1=&cursor; r2=[sb+0x35C4]+0x50; blx r2",
    },
    {
        "name": "0x112C4 group-id reader",
        "start": 0x11426,
        "end": 0x11432,
        "slot": "+0x4C",
        "role": "stream,cursor group-id reader",
        "shape": "r0=converted stream; r1=&cursor; r2=[sb+0x35C4]+0x4C; blx r2",
    },
    {
        "name": "0x11672 +0x64 entry-count reader",
        "start": 0x11672,
        "end": 0x1167E,
        "slot": "+0x50",
        "role": "stream,cursor count reader",
        "shape": "r0=converted stream; r1=&cursor; r2=[sb+0x35C4]+0x50; blx r2",
    },
    {
        "name": "0x11752 final-ref count reader",
        "start": 0x11752,
        "end": 0x1175E,
        "slot": "+0x50",
        "role": "stream,cursor count reader",
        "shape": "r0=converted stream; r1=&cursor; r2=[sb+0x35C4]+0x50; blx r2",
    },
    {
        "name": "0x12326 label/ref compare",
        "start": 0x1233C,
        "end": 0x12350,
        "slot": "+0x50",
        "role": "caller-label versus script+0x64 record+0x10 compare",
        "shape": "r0=caller label pointer; r1=selected +0x64 record+0x10; r2=[sb+0x35C4]+0x50; blx r2; cmp r0,#0 means match",
    },
]

HELPERS = [
    {
        "name": "0x12326 label scan",
        "start": 0x12326,
        "end": 0x12364,
        "role": "scan script+0x64 records and return the first index whose compare call returns 0",
    },
    {
        "name": "0x12364 dispatching entry helper",
        "start": 0x12364,
        "end": 0x123E2,
        "role": "select entry, activate +0x64 record through 0x11A4A, synthesize a type-9 record, then dispatch 0x11C3C",
    },
    {
        "name": "0x123E4 select-only entry helper",
        "start": 0x123E4,
        "end": 0x1240C,
        "role": "select entry and activate +0x64 record; caller dispatches separately",
    },
]


def hx(value, width=8):
    return f"0x{value & ((1 << (width * 4)) - 1):0{width}X}"


def md_thumb():
    md = Cs(CS_ARCH_ARM, CS_MODE_THUMB)
    md.detail = False
    return md


def disasm_window(data, start, end):
    md = md_thumb()
    size = end - start + 2
    return list(md.disasm(data[start:start + size], start))


def ins_text(ins):
    return f"{hx(ins.address)}: {ins.bytes.hex(' ').upper():<14} {ins.mnemonic:<7} {ins.op_str}"


def build_report(input_path=DEFAULT_INPUT):
    data = pathlib.Path(input_path).read_bytes()
    windows = []
    for window in WINDOWS:
        insns = disasm_window(data, window["start"], window["end"])
        windows.append({
            **window,
            "startHex": hx(window["start"]),
            "endHex": hx(window["end"]),
            "instructions": [ins_text(ins) for ins in insns],
            "hasBlx": any(ins.mnemonic == "blx" for ins in insns),
            "hasReturnZeroMatch": window["start"] == 0x1233C and any(ins.mnemonic == "cmp" and "#0" in ins.op_str for ins in insns),
        })
    helpers = []
    for helper in HELPERS:
        insns = disasm_window(data, helper["start"], helper["end"])
        helpers.append({
            **helper,
            "startHex": hx(helper["start"]),
            "endHex": hx(helper["end"]),
            "instructions": [ins_text(ins) for ins in insns],
        })
    plus50_roles = sorted({window["role"] for window in windows if window["slot"] == "+0x50"})
    compare_window = next((window for window in windows if window["start"] == 0x1233C), None)
    polymorphic = len(plus50_roles) > 1
    return {
        "schema": "nicai.cbe.xseCompareServiceProbe.v1",
        "generatedAt": datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "input": str(input_path),
        "summary": {
            "status": "compare-service-polymorphic" if polymorphic else "compare-service-single-shape",
            "plus50RoleCount": len(plus50_roles),
            "plus50Roles": plus50_roles,
            "compareReturnsZeroOnMatch": bool(compare_window and compare_window["hasReturnZeroMatch"]),
            "currentFinding": (
                "[sb+0x35C4]+0x50 is used both as the stream/cursor numeric reader and as the 0x12326 caller-label versus +0x64 record+0x10 compare service; "
                "the compare loop treats return 0 as a match."
            ),
            "emulatorImpact": "A generic emulator cannot model service slot +0x50 as only a primitive compact reader; the host/service ABI needs a compare/ref mode for label entry selection.",
            "nextTarget": "Resolve the concrete provider-returned 0x35C4 service object or emulate +0x50 by argument shape: stream,cursor reads versus label,ref compares.",
        },
        "windows": windows,
        "helpers": helpers,
    }


def md_row(cells):
    return "| " + " | ".join(str(cell if cell is not None else "").replace("|", "\\|") for cell in cells) + " |"


def render_markdown(report):
    lines = [
        "# XSE Compare Service Probe",
        "",
        f"- Generated: {report['generatedAt']}",
        f"- Status: {report['summary']['status']}",
        f"- Finding: {report['summary']['currentFinding']}",
        f"- Emulator impact: {report['summary']['emulatorImpact']}",
        f"- Next target: {report['summary']['nextTarget']}",
        "",
        "## Slot +0x50 Call Shapes",
        "",
        md_row(["Window", "Slot", "Role", "Shape"]),
        md_row(["---", "---", "---", "---"]),
    ]
    for window in report["windows"]:
        lines.append(md_row([window["name"], window["slot"], window["role"], window["shape"]]))
    for window in report["windows"]:
        lines.extend(["", f"### {window['name']}", "", f"- Window: `{window['startHex']}`-`{window['endHex']}`", f"- Shape: {window['shape']}"])
        for ins in window["instructions"]:
            lines.append(f"  - `{ins}`")
    lines.extend(["", "## Helper Windows"])
    for helper in report["helpers"]:
        lines.extend(["", f"### {helper['name']}", "", f"- Role: {helper['role']}"])
        for ins in helper["instructions"][:28]:
            lines.append(f"  - `{ins}`")
    lines.append("")
    return "\n".join(lines) + "\n"


def main(argv=None):
    argv = argv or sys.argv[1:]
    input_path = pathlib.Path(argv[0]) if argv else DEFAULT_INPUT
    out_dir = pathlib.Path(argv[1]) if len(argv) > 1 else DEFAULT_OUT
    out_dir.mkdir(parents=True, exist_ok=True)
    report = build_report(input_path)
    json_file = out_dir / "xse_compare_service_probe.json"
    md_file = out_dir / "xse_compare_service_probe.md"
    json_file.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    md_file.write_text(render_markdown(report), encoding="utf-8")
    print(f"wrote {json_file}")
    print(f"wrote {md_file}")
    print(f"{report['summary']['status']}: {report['summary']['currentFinding']}")


if __name__ == "__main__":
    main()
