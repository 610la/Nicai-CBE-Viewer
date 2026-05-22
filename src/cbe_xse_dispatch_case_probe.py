#!/usr/bin/env python3
import json
import pathlib
import re
import struct
import sys

local_deps = pathlib.Path(__file__).resolve().parent / ".python_deps"
if local_deps.exists():
    sys.path.insert(0, str(local_deps))

from capstone import Cs, CS_ARCH_ARM, CS_MODE_THUMB  # noqa: E402


ROOT = pathlib.Path(__file__).resolve().parent
DEFAULT_INPUTS = [
    pathlib.Path(__file__).resolve().parents[1] / "cbe file" / "众神之战.CBE",
    pathlib.Path(__file__).resolve().parents[1] / "cbe file" / "众神之战.CBE",
]
DISPATCH_JSON = ROOT / "out_godwar_xsedispatch" / "xse_runtime_dispatch_probe.json"
DEFAULT_OUT = ROOT / "out_godwar_xsedispatchcases"

PRIMARY_TABLE_OFFSET = 0x11D0C
PRIMARY_TABLE_COUNT = 0x21
PRIMARY_ADD_PC_BASE = 0x11D08
PRIMARY_DEFAULT_TARGET = 0x11FE0
MAIN_CASE_END = 0x12256
GRID_CASE_END = 0x15F6E
ARITH_TABLE_OFFSET = 0x11D6E
ARITH_TABLE_COUNT = 0x10
ARITH_ADD_PC_BASE = 0x11D6C

HELPERS = {
    0x117D8: ("copy-record-by-index", "copy 0x28-byte opcode record by script/index"),
    0x11862: ("resolve-record", "copy current operand record and resolve type 3/4/8 references"),
    0x118FA: ("typed-value", "return primitive value from resolved record"),
    0x11920: ("final-ref", "read current script +0x6C final-ref array"),
    0x1193A: ("rewind-cursor", "subtract from current script +0x5C opcode cursor"),
    0x11954: ("copy-tail64-record", "copy a +0x64 tail record into an opcode record"),
    0x11984: ("previous-record", "decrement +0x5C and copy previous opcode record"),
    0x119D2: ("copy-explicit-record", "copy record by explicit script/index and transform fields"),
    0x11A0E: ("write-current-record", "write transformed record at current +0x5C cursor"),
    0x11A4A: ("tail64-select", "select/restore a +0x64 tail record"),
    0x11AAE: ("resolved-field-1c", "return resolved record field +0x1C"),
    0x11AC0: ("raw-opcode-type", "return current record raw opcode/type"),
    0x11AE6: ("resolved-record-pointer", "return referenced/target opcode record pointer"),
    0x11B34: ("resolved-field-18", "return resolved record field +0x18"),
    0x11BB6: ("boxed-value", "return boxed/string-like value from resolved record"),
    0x11BDC: ("resolved-type", "return resolved record type"),
    0x11C16: ("resolved-box", "return object/string-like payload from resolved record"),
}

SCRIPT_FIELDS = {
    0x10: "active/blocked flag",
    0x14: "delay flag",
    0x18: "delay deadline",
    0x1C: "time/entry field",
    0x20: "type-8 inline record",
    0x48: "group table pointer",
    0x50: "current group index/cursor",
    0x54: "opcode record table pointer",
    0x5C: "opcode cursor",
    0x60: "negative-index base",
    0x64: "tail record table",
    0x68: "tail record count",
    0x6C: "final-ref table",
}

TARGET_NOTES = {
    0x11D4C: "binary/value operator family; resolves two operand records and then uses a nested group-id switch",
    0x11ED4: "unary/value operator family; handles groups 6, 7, 8, 9, 13 in this shared block",
    0x11F40: "string/box append-like operation; allocates/grows object through r5 service slot +0x0C",
    0x11F82: "single-byte/string extraction-like operation",
    0x11FE2: "write byte from one resolved record into another record payload",
    0x1200A: "branch/control helper via resolved-field-18",
    0x12012: "comparison/conditional branch family for groups 19..24",
    0x1212E: "copy current resolved record into current script cursor",
    0x1214C: "decrement cursor and restore previous record",
    0x1215A: "tail +0x64 selection and cursor advance",
    0x1217A: "branch/jump-state setup; writes +0x50/+0x60 and rewinds +0x5C",
    0x121C8: "final-ref table dispatch through script +0x6C",
    0x12222: "delay/timer setup; writes script +0x14/+0x18",
    0x1223E: "clear active flag at script +0x10",
    0x15F08: "register-shape suspect: overlapping id-32 entry jumps into a shared table-lookup inner label that expects r4 as an object pointer",
    PRIMARY_DEFAULT_TARGET: "default/no-op path for out-of-range group ids",
}


def hx(value, width=6):
    return f"0x{value:0{width}X}"


def pick_input(arg):
    if arg:
        return pathlib.Path(arg)
    for item in DEFAULT_INPUTS:
        if item.exists():
            return item
    return DEFAULT_INPUTS[0]


def md_thumb():
    return Cs(CS_ARCH_ARM, CS_MODE_THUMB)


def ins_text(ins):
    return f"{hx(ins.address, 8)}  {ins.mnemonic:<7} {ins.op_str}".rstrip()


def read_thumb_table(data, offset, count, add_pc_base):
    rows = []
    for index in range(count):
        table_offset = offset + (index * 2)
        halfword = struct.unpack_from("<H", data, table_offset)[0]
        rows.append({
            "id": index,
            "tableOffset": hx(table_offset, 6),
            "halfword": hx(halfword, 4),
            "target": hx(add_pc_base + (halfword * 2), 6),
            "targetInt": add_pc_base + (halfword * 2),
        })
    return rows


def parse_call_target(ins):
    if ins.mnemonic not in {"bl", "blx"}:
        return None
    text = ins.op_str.strip()
    if not text.startswith("#"):
        return None
    try:
        return int(text[1:], 0)
    except ValueError:
        return None


def collect_field_hits(ins):
    hits = []
    for field, meaning in SCRIPT_FIELDS.items():
        if re.search(rf"#0x{field:X}\b", ins.op_str, re.IGNORECASE) or re.search(rf"#\s*{field}\b", ins.op_str):
            hits.append({
                "address": hx(ins.address, 8),
                "field": hx(field, 2),
                "meaning": meaning,
                "instruction": ins_text(ins),
            })
    return hits


def collect_window(data, start, end):
    insns = list(md_thumb().disasm(data[start:end], start))
    helper_calls = []
    external_calls = []
    field_hits = []
    relevant = []
    for ins in insns:
        target = parse_call_target(ins)
        if target in HELPERS:
            name, role = HELPERS[target]
            item = {
                "address": hx(ins.address, 8),
                "target": hx(target, 6),
                "helper": name,
                "role": role,
                "instruction": ins_text(ins),
            }
            helper_calls.append(item)
            relevant.append(ins_text(ins))
        elif target is not None:
            external_calls.append({
                "address": hx(ins.address, 8),
                "target": hx(target, 6),
                "instruction": ins_text(ins),
            })
        for hit in collect_field_hits(ins):
            field_hits.append(hit)
            relevant.append(hit["instruction"])
    seen_helpers = []
    for item in helper_calls:
        if item["helper"] not in seen_helpers:
            seen_helpers.append(item["helper"])
    seen_fields = []
    for item in field_hits:
        if item["field"] not in seen_fields:
            seen_fields.append(item["field"])
    return {
        "start": hx(start, 6),
        "end": hx(end, 6),
        "instructionCount": len(insns),
        "note": TARGET_NOTES.get(start, ""),
        "helperCalls": helper_calls,
        "helperSummary": seen_helpers,
        "externalCalls": external_calls,
        "scriptFieldHits": field_hits,
        "scriptFieldSummary": seen_fields,
        "relevantInstructions": relevant[:80],
    }


def target_end(target, sorted_targets):
    if target == 0x15F08:
        return GRID_CASE_END
    later = [item for item in sorted_targets if target < item < MAIN_CASE_END]
    if later:
        return later[0]
    if target < MAIN_CASE_END:
        return MAIN_CASE_END
    return min(target + 0x80, GRID_CASE_END)


def load_dispatch_context():
    if not DISPATCH_JSON.exists():
        return None
    return json.loads(DISPATCH_JSON.read_text(encoding="utf-8"))


def build_focused_scripts(dispatch):
    if not dispatch:
        return []
    out = []
    for script in dispatch.get("scripts", []):
        best = script.get("executionBest") or script.get("dispatchBest") or {}
        groups = best.get("groupIds") or []
        direct = [item for item in groups if isinstance(item, int) and 0 <= item < PRIMARY_TABLE_COUNT]
        defaulted = [item for item in groups if not (isinstance(item, int) and 0 <= item < PRIMARY_TABLE_COUNT)]
        out.append({
            "name": script.get("name"),
            "mode": best.get("mode"),
            "groups": groups,
            "directGroups": direct,
            "defaultGroups": defaulted,
            "targetCounts": best.get("targetCounts") or [],
            "tension": bool(script.get("tension")),
        })
    return out


def build_report(input_path):
    data = input_path.read_bytes()
    primary = read_thumb_table(data, PRIMARY_TABLE_OFFSET, PRIMARY_TABLE_COUNT, PRIMARY_ADD_PC_BASE)
    arith = read_thumb_table(data, ARITH_TABLE_OFFSET, ARITH_TABLE_COUNT, ARITH_ADD_PC_BASE)
    target_to_ids = {}
    for row in primary:
        target_to_ids.setdefault(row["targetInt"], []).append(row["id"])
    sorted_targets = sorted(target_to_ids)
    case_windows = []
    for target in sorted_targets:
        case_windows.append({
            "target": hx(target, 6),
            "groupIds": target_to_ids[target],
            **collect_window(data, target, target_end(target, sorted_targets)),
        })
    dispatch = load_dispatch_context()
    focused_scripts = build_focused_scripts(dispatch)
    focused_direct = sorted({group for script in focused_scripts for group in script["directGroups"]})
    focused_default = sorted({group for script in focused_scripts for group in script["defaultGroups"]})
    focused_targets = sorted({
        primary[group]["target"] for group in focused_direct
        if isinstance(group, int) and 0 <= group < len(primary)
    })
    executable_targets = [target for target in focused_targets if target != hx(0x15F08, 6)]
    return {
        "schema": "nicai.cbe.xseDispatchCaseProbe.v1",
        "input": str(input_path),
        "generatedAt": __import__("datetime").datetime.now().isoformat(timespec="seconds"),
        "dispatcher": {
            "entry": hx(0x11C3C, 6),
            "primarySite": "0x11CF8..0x11D06",
            "primaryTable": hx(PRIMARY_TABLE_OFFSET, 6),
            "primaryAddPcBase": hx(PRIMARY_ADD_PC_BASE, 6),
            "primaryDefaultTarget": hx(PRIMARY_DEFAULT_TARGET, 6),
            "primary": [{k: v for k, v in row.items() if k != "targetInt"} for row in primary],
            "arithmeticSubtable": {
                "site": "0x11D5C..0x11D6A",
                "table": hx(ARITH_TABLE_OFFSET, 6),
                "addPcBase": hx(ARITH_ADD_PC_BASE, 6),
                "rows": [{k: v for k, v in row.items() if k != "targetInt"} for row in arith],
            },
        },
        "summary": {
            "status": "dispatch-cases-mapped",
            "currentFinding": (
                "Focused opening scripts exercise direct group ids "
                f"{', '.join(str(item) for item in focused_direct) or 'none'}; "
                f"default-only ids remain {', '.join(str(item) for item in focused_default) or 'none'}."
            ),
            "emulatorImpact": (
                "The first executable VM milestone can focus on case targets "
                f"{', '.join(executable_targets) or 'none'} plus default handling; "
                "the apparent group 32 / 0x015F08 path is tracked as a register-shape suspect instead of an executable helper."
            ),
            "nextTarget": (
                "Implement a trace-only interpreter for 0x11C3C using +0x48/+0x50/+0x54/+0x5C cursor fields, "
                "then bind group 2/5/6/9/30/31 while resolving the group32/register-shape ambiguity before expanding the full case table."
            ),
        },
        "focusedScripts": focused_scripts,
        "caseWindows": case_windows,
        "helpers": {hx(k, 6): {"name": v[0], "role": v[1]} for k, v in HELPERS.items()},
        "scriptFields": {hx(k, 2): v for k, v in SCRIPT_FIELDS.items()},
    }


def md_row(cells):
    return "| " + " | ".join(str(cell).replace("|", "\\|") for cell in cells) + " |"


def render_markdown(report):
    lines = [
        "# XSE Dispatch Case Probe",
        "",
        f"- Input CBE: `{report['input']}`",
        f"- Generated: {report['generatedAt']}",
        "",
        "## Summary",
        "",
        f"- Status: {report['summary']['status']}",
        f"- Finding: {report['summary']['currentFinding']}",
        f"- Emulator impact: {report['summary']['emulatorImpact']}",
        f"- Next target: {report['summary']['nextTarget']}",
        "",
        "## Focused Opening Scripts",
        "",
        md_row(["Script", "Dispatch mode", "Direct groups", "Default groups", "Tension"]),
        md_row(["---", "---", "---", "---", "---"]),
    ]
    for script in report["focusedScripts"]:
        lines.append(md_row([
            script["name"],
            script["mode"],
            ",".join(str(item) for item in script["directGroups"]),
            ",".join(str(item) for item in script["defaultGroups"]),
            "yes" if script["tension"] else "no",
        ]))
    lines.extend([
        "",
        "## Primary Group Cases",
        "",
        md_row(["Group ids", "Target", "Role", "Helpers", "Script fields"]),
        md_row(["---", "---", "---", "---", "---"]),
    ])
    for case in report["caseWindows"]:
        lines.append(md_row([
            ",".join(str(item) for item in case["groupIds"]),
            case["target"],
            case["note"],
            ", ".join(case["helperSummary"]) or "-",
            ", ".join(case["scriptFieldSummary"]) or "-",
        ]))
    lines.extend([
        "",
        "## Arithmetic Subtable",
        "",
        md_row(["Group id", "Target"]),
        md_row(["---:", "---"]),
    ])
    for row in report["dispatcher"]["arithmeticSubtable"]["rows"]:
        lines.append(md_row([row["id"], row["target"]]))
    lines.extend([
        "",
        "## Helper Roles",
        "",
    ])
    for addr, item in report["helpers"].items():
        lines.append(f"- `{addr}` {item['name']}: {item['role']}")
    lines.extend([
        "",
        "## Script Record Fields",
        "",
    ])
    for field, meaning in report["scriptFields"].items():
        lines.append(f"- `{field}`: {meaning}")
    lines.append("")
    return "\n".join(lines)


def main(argv):
    input_path = pick_input(argv[0] if argv else None)
    out_dir = pathlib.Path(argv[1]) if len(argv) > 1 else DEFAULT_OUT
    out_dir.mkdir(parents=True, exist_ok=True)
    report = build_report(input_path)
    json_file = out_dir / "xse_dispatch_case_probe.json"
    md_file = out_dir / "xse_dispatch_case_probe.md"
    json_file.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    md_file.write_text(render_markdown(report), encoding="utf-8")
    print(f"wrote {json_file}")
    print(f"wrote {md_file}")
    print(f"{report['summary']['status']}: {report['summary']['currentFinding']}")


if __name__ == "__main__":
    main(sys.argv[1:])
