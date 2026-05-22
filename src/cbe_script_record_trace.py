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
DEFAULT_OUT = "out_godwar_scriptrecord"

SCRIPT_RECORD_BASE = 0x86DC
SCRIPT_RECORD_SIZE = 0x74
SCRIPT_RECORD_SLOTS = 5
GROUP_RECORD_SIZE = 0x0C
OPCODE_RECORD_SIZE = 0x28
RANGE_RECORD_SIZE = 0x14

ANCHORS = [
    {
        "name": "reset script record slots",
        "offset": 0x11206,
        "size": 0x28,
        "note": "Zeros five 0x74-byte script records and clears key pointer/count fields.",
    },
    {
        "name": "allocate record and group/opcode tables",
        "offset": 0x112C4,
        "size": 0x300,
        "note": "Main XSE parser: chooses a free script slot, reads header fields, allocates opcode and group tables.",
    },
    {
        "name": "post-group arrays",
        "offset": 0x115B8,
        "size": 0x210,
        "note": "Reads opcode2 backfill refs, range records, and final refs after group/opcode parsing.",
    },
    {
        "name": "runtime opcode lookup helpers",
        "offset": 0x117D8,
        "size": 0x180,
        "note": "Copies and resolves 0x28-byte opcode records at runtime.",
    },
    {
        "name": "runtime record cursor helpers",
        "offset": 0x11920,
        "size": 0x90,
        "note": "Reads final ref array at +0x6C and updates opcode cursor at +0x5C.",
    },
    {
        "name": "script activation/deactivation",
        "offset": 0x1228E,
        "size": 0x50,
        "note": "Sets active/current script bookkeeping through the 0x86DC table and nearby current-script state.",
    },
]

SCRIPT_FIELDS = [
    (0x00, "active/loaded flag", "Zeroed by reset; set to 1 at 0x117C6..0x117CC after parse succeeds."),
    (0x04, "header field +04", "Read through service +0x50 at 0x11362 and stored at 0x11378."),
    (0x08, "header raw byte +08", "Raw byte copied from stream at 0x1137A..0x11388."),
    (0x0C, "header field +0C", "Read through service +0x50 at 0x1138A and stored at 0x113A0."),
    (0x10, "runtime status flag", "Zeroed by reset; checked/set by activation helpers around 0x1228E..0x122D4."),
    (0x14, "runtime auxiliary flag", "Zeroed by reset; cleared by helper around 0x12312."),
    (0x1C, "opcode record byte size", "Read from stream or forced by type byte at 0x113BA..0x113E8."),
    (0x48, "group table pointer", "Allocated as groupCount * 0x0C at 0x11402..0x11414."),
    (0x4C, "group count", "Read through service +0x50 at 0x113EA and stored at 0x11400."),
    (0x50, "current group index", "Runtime cursor used to select group record at +0x48 + index * 0x0C."),
    (0x54, "opcode table pointer", "Allocated as slotCapacity * 0x28 at 0x1133A..0x11354."),
    (0x58, "opcode slot capacity", "Initial capacity read at 0x11316..0x11328; zero becomes 0x80."),
    (0x5C, "current opcode index", "Runtime cursor updated by helpers around 0x1193A and used near 0x123A2."),
    (0x60, "relative opcode base", "Runtime helper uses it to resolve negative opcode indices at 0x117EA and 0x119E6."),
    (0x64, "range table pointer", "Allocated as rangeCount * 0x14 at 0x1168E..0x116A0."),
    (0x68, "range count", "Read through service +0x50 at 0x11672 and stored at 0x1168C."),
    (0x6C, "final refs pointer", "Allocated as finalRefCount * 4 at 0x1176C..0x1177C."),
    (0x70, "final refs count", "Read through service +0x50 at 0x11752 and stored at 0x1176A."),
]

GROUP_FIELDS = [
    (0x00, "group id", "Read through service +0x4C at 0x11426 and stored at 0x1144C."),
    (0x04, "opcode count in group", "Raw byte copied from stream at 0x1144E..0x11460."),
    (0x08, "group opcode subtable pointer", "Allocated as count * 0x28 and stored at 0x1159C."),
]

OPCODE_FIELDS = [
    (0x00, "opcode/type", "Raw opcode byte stored at 0x1148C; opcode 2 then forces this field back to 2."),
    (0x04, "aux field", "Written by opcode 4 branch after a second compact read."),
    (0x08, "primary value", "Written by opcode 0 and opcode 2 compact reads."),
    (0x0C, "short/string-like value", "Written by opcode 1 via service +0x4C and transform 0x353A8."),
    (0x10, "opcode2 resolved ref", "Backfilled at 0x11644..0x11656 from the temporary +0x74 ref array."),
    (0x14, "branch/target field", "Written by opcode 3 and first part of opcode 4."),
    (0x18, "opcode 5 field", "Written by opcode 5 compact read."),
    (0x1C, "opcode 6 field", "Written by opcode 6 compact read."),
    (0x20, "opcode 7 field", "Written by opcode 7 compact read."),
    (0x24, "opcode 8 field", "Written by opcode 8 compact read."),
]

RANGE_FIELDS = [
    (0x00, "start", "Compact read through service +0x50 at 0x116B6."),
    (0x04, "kind/raw byte", "Manual raw stream byte at 0x116D8..0x116EA."),
    (0x08, "span", "Compact read through service +0x50 at 0x116EC."),
    (0x0C, "inclusive end", "Computed as kind + span + 1 at 0x11714..0x1171C."),
    (0x10, "range ref", "Read through service +0x64 at 0x1171E."),
]


def hx(value, width=8):
    return f"0x{value & 0xFFFFFFFF:0{width}X}"


def ins_text(ins):
    raw = ins.bytes.hex(" ").upper()
    return f"{hx(ins.address)}  {raw:<14}  {ins.mnemonic} {ins.op_str}".rstrip()


def disasm(data, offset, size):
    md = Cs(CS_ARCH_ARM, CS_MODE_THUMB)
    return [ins_text(ins) for ins in md.disasm(data[offset:offset + size], offset)]


def field_rows(fields):
    return [
        {"offset": offset, "offsetHex": hx(offset, 2), "name": name, "evidence": evidence}
        for offset, name, evidence in fields
    ]


def build_report(input_path):
    data = input_path.read_bytes()
    return {
        "schema": "nicai.cbe.scriptRecordTrace.v1",
        "generated": _dt.datetime.now(_dt.UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "input": str(input_path),
        "scriptRecordBase": SCRIPT_RECORD_BASE,
        "scriptRecordBaseHex": hx(SCRIPT_RECORD_BASE, 4),
        "scriptRecordSize": SCRIPT_RECORD_SIZE,
        "scriptRecordSizeHex": hx(SCRIPT_RECORD_SIZE, 2),
        "scriptRecordSlots": SCRIPT_RECORD_SLOTS,
        "groupRecordSize": GROUP_RECORD_SIZE,
        "opcodeRecordSize": OPCODE_RECORD_SIZE,
        "rangeRecordSize": RANGE_RECORD_SIZE,
        "scriptFields": field_rows(SCRIPT_FIELDS),
        "groupFields": field_rows(GROUP_FIELDS),
        "opcodeFields": field_rows(OPCODE_FIELDS),
        "rangeFields": field_rows(RANGE_FIELDS),
        "anchors": [
            {
                **anchor,
                "offsetHex": hx(anchor["offset"]),
                "instructions": disasm(data, anchor["offset"], anchor["size"])[:80],
            }
            for anchor in ANCHORS
        ],
    }


def render_field_table(fields):
    lines = ["| Offset | Name | Evidence |", "| --- | --- | --- |"]
    for item in fields:
        lines.append(f"| `{item['offsetHex']}` | {item['name']} | {item['evidence']} |")
    return "\n".join(lines)


def render_md(report):
    lines = [
        "# God War Script Record Trace",
        "",
        f"Generated: {report['generated']}",
        "",
        "## Current Conclusions",
        "",
        f"- `sb+{report['scriptRecordBaseHex']}` is a fixed table of {report['scriptRecordSlots']} script records, each `{hx(report['scriptRecordSize'], 2)}` bytes.",
        "- The parsed structure is three nested tables: script record -> 0x0C group records -> 0x28 opcode records.",
        "- The first post-group ref array is a temporary opcode-2 backfill table. The persistent final-ref array is stored at script-record `+0x6C`, with its count at `+0x70`.",
        "- Reader/service callbacks such as `+0x50`, `+0x64`, and `+0x74` decode stream values; they are separate from script-record field offsets.",
        "",
        "## Script Record Fields",
        "",
        render_field_table(report["scriptFields"]),
        "",
        "## Group Record Fields",
        "",
        render_field_table(report["groupFields"]),
        "",
        "## Opcode Record Fields",
        "",
        render_field_table(report["opcodeFields"]),
        "",
        "## Range Record Fields",
        "",
        render_field_table(report["rangeFields"]),
        "",
        "## Disassembly Anchors",
        "",
    ]
    for anchor in report["anchors"]:
        lines.append(f"### `{anchor['offsetHex']}` {anchor['name']}")
        lines.append("")
        lines.append(f"- {anchor['note']}")
        lines.append("")
        for text in anchor["instructions"][:28]:
            lines.append(f"- `{text}`")
        lines.append("")
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Trace the CBE XSE per-script record table.")
    parser.add_argument("input", nargs="?", default=DEFAULT_INPUT)
    parser.add_argument("--out", default=DEFAULT_OUT)
    args = parser.parse_args()

    input_path = pathlib.Path(args.input)
    out_dir = pathlib.Path(args.out)
    report = build_report(input_path)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "script_record_trace.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    (out_dir / "script_record_trace.md").write_text(render_md(report), encoding="utf-8")
    print(f"wrote {out_dir / 'script_record_trace.md'}")


if __name__ == "__main__":
    main()
