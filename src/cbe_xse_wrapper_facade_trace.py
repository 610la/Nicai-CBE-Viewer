#!/usr/bin/env python3
import datetime as _dt
import json
import pathlib
import struct
import sys

local_deps = pathlib.Path(__file__).resolve().parent / ".python_deps"
if local_deps.exists():
    sys.path.insert(0, str(local_deps))

from capstone import Cs, CS_ARCH_ARM, CS_MODE_THUMB
from capstone.arm_const import ARM_OP_IMM, ARM_OP_MEM, ARM_OP_REG, ARM_REG_PC, ARM_REG_SB

from cbe_xse_slot_audit import direct_bl_refs
from cbe_xse_reader_service_trace import disasm_window, hx, ins_text


DEFAULT_INPUT = pathlib.Path(__file__).resolve().parents[1] / "cbe file" / "众神之战.CBE"
DEFAULT_OUT = pathlib.Path(__file__).resolve().parent / "out_godwar_xsewrapperfacade"

MANAGER_GLOBAL = 0x3584
MANAGER_ROOT_SLOT = 0x5C
MANAGER_ROOT_GLOBAL = MANAGER_GLOBAL + MANAGER_ROOT_SLOT

READER_WRAPPER_STARTS = [
    0x0922,
    0x0934,
    0x0946,
    0x0958,
    0x096A,
    0x097C,
    0x098E,
    0x09A0,
    0x09B2,
    0x09C4,
]

FOCUS_WRAPPERS = {0x0934, 0x0958}

KEY_WINDOWS = [
    {
        "name": "reader wrapper facade family",
        "start": 0x0922,
        "size": 0xB4,
        "note": "Small wrappers dispatch through [sb+0x3584]+0x5C, then into method groups such as +0x140 and +0x180.",
    },
    {
        "name": "manager-root getter and constructors",
        "start": 0x0B14,
        "size": 0xC0,
        "note": "The 0x3584 object exposes fields such as +0x04 and +0x5C; 0x0B4E returns the same +0x5C root used by reader wrappers.",
    },
    {
        "name": "manager object constructor",
        "start": 0x0BD6,
        "size": 0x66,
        "note": "Constructor-like code copies an object and installs methods around +0x18/+0x1C/+0x50..+0x6C.",
    },
    {
        "name": "direct 0x35E0 runtime use",
        "start": 0x10D16,
        "size": 0x24,
        "note": "Later scene/object code directly loads [sb+0x35E0] and calls +0x2C, confirming 0x35E0 is a live manager-root pointer.",
    },
]


def read_u16(data, offset):
    if offset < 0 or offset + 2 > len(data):
        return None
    return struct.unpack_from("<H", data, offset)[0]


def reg_name(ins, reg_id):
    try:
        return ins.reg_name(reg_id)
    except Exception:
        return str(reg_id)


def thumb_pc(address):
    return (address + 4) & ~3


def literal_pools(ins):
    if ins.mnemonic != "ldr" or len(ins.operands) < 2:
        return None
    src = ins.operands[1]
    if src.type != ARM_OP_MEM or src.mem.base != ARM_REG_PC:
        return None
    disp = src.mem.disp
    return {
        "raw": ins.address + 4 + disp,
        "aligned": thumb_pc(ins.address) + disp,
    }


def literal_half_candidates(data, ins):
    pools = literal_pools(ins)
    if not pools:
        return []
    out = []
    for base_label, pool in pools.items():
        for delta in (-2, 0, 2):
            offset = pool + delta
            value = read_u16(data, offset)
            if value is None:
                continue
            label = f"{base_label}{delta:+d}" if delta else base_label
            out.append({
                "label": label,
                "offset": offset,
                "offsetHex": hx(offset),
                "value": value,
                "valueHex": hx(value, 4),
                "matchesManager": value == MANAGER_GLOBAL,
            })
    return out


def is_add_sb(ins, reg):
    if ins.mnemonic != "add" or len(ins.operands) < 2:
        return False
    return (
        ins.operands[0].type == ARM_OP_REG
        and reg_name(ins, ins.operands[0].reg) == reg
        and ins.operands[1].type == ARM_OP_REG
        and ins.operands[1].reg == ARM_REG_SB
    )


def is_mem_load_from(ins, reg):
    if ins.mnemonic != "ldr" or len(ins.operands) < 2:
        return None
    dst, src = ins.operands[0], ins.operands[1]
    if dst.type != ARM_OP_REG or src.type != ARM_OP_MEM:
        return None
    if reg_name(ins, src.mem.base) != reg:
        return None
    return {
        "address": ins.address,
        "addressHex": hx(ins.address),
        "dst": reg_name(ins, dst.reg),
        "base": reg,
        "slot": src.mem.disp,
        "slotHex": f"+0x{src.mem.disp:X}" if src.mem.disp else "+0x0",
        "text": ins_text(ins),
    }


def self_add_imm(ins, reg):
    if ins.mnemonic not in {"add", "adds"} or len(ins.operands) < 2:
        return None
    dst = ins.operands[0]
    if dst.type != ARM_OP_REG or reg_name(ins, dst.reg) != reg:
        return None
    for op in ins.operands[1:]:
        if op.type == ARM_OP_IMM:
            return op.imm
    return None


def decode_function(data, start, max_size=0x36):
    rows = disasm_window(data, start, max_size)
    out = []
    for row in rows:
        out.append(row)
        if row.mnemonic in {"pop", "bx"} and ("pc" in row.op_str or "lr" in row.op_str):
            break
    return out


def decode_wrapper(data, start):
    rows = decode_function(data, start)
    pc_ldr = None
    for row in rows[:4]:
        if literal_pools(row) and row.operands[0].type == ARM_OP_REG:
            pc_ldr = row
            break
    if pc_ldr is None:
        return {
            "start": start,
            "startHex": hx(start),
            "decoded": False,
            "reason": "No leading PC-relative LDR found",
            "instructions": [ins_text(row) for row in rows],
        }

    reg = reg_name(pc_ldr, pc_ldr.operands[0].reg)
    literals = literal_half_candidates(data, pc_ldr)
    chosen = next((item for item in literals if item["matchesManager"]), None)

    add_sb_idx = None
    for idx, row in enumerate(rows):
        if is_add_sb(row, reg):
            add_sb_idx = idx
            break

    base_load = None
    group_adds = []
    method_load = None
    if add_sb_idx is not None:
        for row in rows[add_sb_idx + 1:]:
            load = is_mem_load_from(row, reg)
            if load:
                if base_load is None:
                    base_load = load
                    continue
                method_load = load
                break
            imm = self_add_imm(row, reg)
            if imm is not None:
                group_adds.append({
                    "address": row.address,
                    "addressHex": hx(row.address),
                    "imm": imm,
                    "immHex": hx(imm, 2),
                    "text": ins_text(row),
                })

    group_offset = sum(item["imm"] for item in group_adds)
    manager_root = chosen["value"] + base_load["slot"] if chosen and base_load else None
    method_group = manager_root + group_offset if manager_root is not None else None

    return {
        "start": start,
        "startHex": hx(start),
        "decoded": True,
        "reg": reg,
        "literalCandidates": literals,
        "chosenGlobal": chosen["valueHex"] if chosen else "",
        "literalAlignment": chosen["label"] if chosen else "",
        "baseLoad": base_load,
        "managerRootGlobal": hx(manager_root, 4) if manager_root is not None else "",
        "groupAdds": group_adds,
        "groupOffset": hx(group_offset, 4),
        "methodGroupBase": hx(method_group, 4) if method_group is not None else "",
        "methodLoad": method_load,
        "dispatchPath": (
            f"*([sb+{hx(chosen['value'], 4)}]{base_load['slotHex']})+{hx(group_offset, 4)} -> {method_load['slotHex']}"
            if chosen and base_load and method_load else ""
        ),
        "absoluteMethodOffset": hx((base_load["slot"] + group_offset + method_load["slot"]) if base_load and method_load else 0, 4)
        if base_load and method_load else "",
        "instructions": [ins_text(row) for row in rows],
    }


def build_report(input_path):
    data = pathlib.Path(input_path).read_bytes()
    wrappers = [decode_wrapper(data, start) for start in READER_WRAPPER_STARTS]
    refs = {
        item["target"]: item
        for item in direct_bl_refs(data, READER_WRAPPER_STARTS)
    }
    for wrapper in wrappers:
        ref = refs.get(wrapper["start"])
        wrapper["directBranchCount"] = ref["count"] if ref else 0
        wrapper["directBranchSites"] = [hx(item["site"]) for item in ref["refs"]] if ref else []
        wrapper["directBranchTruncated"] = bool(ref["truncated"]) if ref else False

    focus = [wrapper for wrapper in wrappers if wrapper["start"] in FOCUS_WRAPPERS]
    return {
        "schema": "nicai.cbe.xseWrapperFacade.v1",
        "input": str(pathlib.Path(input_path)),
        "generated": _dt.datetime.now(_dt.UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "manager": {
            "global": hx(MANAGER_GLOBAL, 4),
            "rootSlot": f"+0x{MANAGER_ROOT_SLOT:X}",
            "rootGlobal": hx(MANAGER_ROOT_GLOBAL, 4),
            "meaning": "[sb+0x3584]+0x5C is the manager-root pointer used by the 0x934/0x958 reader facades.",
        },
        "wrappers": wrappers,
        "focusWrappers": focus,
        "keyWindows": [
            {
                **window,
                "startHex": hx(window["start"]),
                "instructions": [ins_text(row) for row in disasm_window(data, window["start"], window["size"])],
            }
            for window in KEY_WINDOWS
        ],
        "conclusion": {
            "finding": "0x934 and 0x958 do not read the direct 0x35C4 service. They are wrapper-reader facades through the 0x3584 manager object and its +0x5C root pointer.",
            "literalAlignment": "For these wrappers, the useful literal is the halfword at pool-2/aligned+2, not the visually tempting word at the PC-aligned pool.",
            "facadeMap": "0x934 dispatches through *([sb+0x3584]+0x5C)+0x140 slot +0x2C; 0x958 dispatches through the same root +0x180 slot +0x04.",
            "runtimeBridge": "A later direct use at 0x10D16 loads [sb+0x35E0] and calls +0x2C, supporting 0x35E0 as the live manager-root global.",
            "nextTarget": "Resolve which constructor writes [sb+0x3584]+0x5C/[sb+0x35E0], then map +0x140/+0x180 method slots to concrete stream-reader routines.",
        },
    }


def md_row(values):
    return "| " + " | ".join(str(value).replace("|", "\\|") for value in values) + " |"


def render_markdown(report):
    lines = [
        "# XSE Wrapper Facade Trace",
        "",
        f"- Input CBE: `{report['input']}`",
        f"- Generated: {report['generated']}",
        "",
        "## Current Conclusion",
        "",
        f"- {report['conclusion']['finding']}",
        f"- {report['conclusion']['literalAlignment']}",
        f"- {report['conclusion']['facadeMap']}",
        f"- {report['conclusion']['runtimeBridge']}",
        f"- {report['conclusion']['nextTarget']}",
        "",
        "## Manager Root",
        "",
        md_row(["Global", "Root slot", "Root global", "Meaning"]),
        md_row(["---", "---", "---", "---"]),
        md_row([
            report["manager"]["global"],
            report["manager"]["rootSlot"],
            report["manager"]["rootGlobal"],
            report["manager"]["meaning"],
        ]),
        "",
        "## Focus Wrappers",
        "",
        md_row(["Wrapper", "Direct refs", "Literal", "Root", "Group", "Method slot", "Path"]),
        md_row(["---", "---", "---", "---", "---", "---", "---"]),
    ]
    for wrapper in report["focusWrappers"]:
        lines.append(md_row([
            wrapper["startHex"],
            wrapper["directBranchCount"],
            f"{wrapper['chosenGlobal']} via {wrapper['literalAlignment']}",
            wrapper["managerRootGlobal"],
            wrapper["groupOffset"],
            wrapper["methodLoad"]["slotHex"] if wrapper.get("methodLoad") else "",
            wrapper["dispatchPath"],
        ]))

    lines.extend(["", "## Reader Wrapper Family", ""])
    lines.append(md_row(["Start", "Refs", "Root", "Group", "Method slot", "Absolute method offset"]))
    lines.append(md_row(["---", "---", "---", "---", "---", "---"]))
    for wrapper in report["wrappers"]:
        lines.append(md_row([
            wrapper["startHex"],
            wrapper["directBranchCount"],
            wrapper.get("managerRootGlobal", ""),
            wrapper.get("groupOffset", ""),
            wrapper.get("methodLoad", {}).get("slotHex", ""),
            wrapper.get("absoluteMethodOffset", ""),
        ]))

    lines.extend(["", "## Key Windows", ""])
    for window in report["keyWindows"]:
        lines.append(f"### {window['name']}")
        lines.append("")
        lines.append(f"- Start: `{window['startHex']}`")
        lines.append(f"- Note: {window['note']}")
        lines.append("")
        for text in window["instructions"][:38]:
            lines.append(f"- `{text}`")
        if len(window["instructions"]) > 38:
            lines.append("- ...")
        lines.append("")
    return "\n".join(lines)


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    input_path = pathlib.Path(argv[0] if argv else DEFAULT_INPUT)
    out_dir = pathlib.Path(argv[1] if len(argv) > 1 else DEFAULT_OUT)
    out_dir.mkdir(parents=True, exist_ok=True)
    report = build_report(input_path)
    json_path = out_dir / "xse_wrapper_facade_trace.json"
    md_path = out_dir / "xse_wrapper_facade_trace.md"
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    md_path.write_text(render_markdown(report), encoding="utf-8")
    print(f"wrote {json_path}")
    print(f"wrote {md_path}")


if __name__ == "__main__":
    main()
