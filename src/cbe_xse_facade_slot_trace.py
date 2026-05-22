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
from capstone.arm_const import ARM_OP_IMM, ARM_OP_MEM, ARM_OP_REG, ARM_REG_PC, ARM_REG_R2

from cbe_xse_reader_service_trace import disasm_window, hx, ins_text


DEFAULT_INPUT = pathlib.Path(__file__).resolve().parents[1] / "cbe file" / "众神之战.CBE"
DEFAULT_OUT = pathlib.Path(__file__).resolve().parent / "out_godwar_xsefacadeslots"

FACADES = [
    {
        "wrapper": 0x0934,
        "path": "*([sb+0x3584]+0x5C)+0x140 slot +0x2C",
        "relativeOffset": 0x01C8,
    },
    {
        "wrapper": 0x0958,
        "path": "*([sb+0x3584]+0x5C)+0x180 slot +0x04",
        "relativeOffset": 0x01E0,
    },
]

NEARBY_OFFSETS = [0x01BC, 0x01C8, 0x01CC, 0x01E0, 0x01F4, 0x01F8, 0x01FC, 0x0200, 0x0204, 0x0214]

INITIALIZER_WINDOWS = [
    {"name": "0x28F6 base initializer", "start": 0x28F6, "size": 0x180},
    {"name": "0x292E table initializer", "start": 0x292E, "size": 0x180},
    {"name": "0x29B4 table initializer", "start": 0x29B4, "size": 0x180},
    {"name": "0x2A1E table initializer", "start": 0x2A1E, "size": 0x180},
    {"name": "0x2A4A table initializer", "start": 0x2A4A, "size": 0x2E0},
    {"name": "0x2B2C table initializer", "start": 0x2B2C, "size": 0x300},
    {"name": "0x0BD6 manager-ish constructor", "start": 0x0BD6, "size": 0x66},
    {"name": "0x3B74 global setup caller", "start": 0x3B74, "size": 0x90},
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


def target_candidates(data, ldr_ins, add_ins):
    pools = literal_pools(ldr_ins)
    if not pools:
        return []
    out = []
    for pool_name, pool in pools.items():
        for delta in (-2, 0, 2):
            offset = pool + delta
            value = read_u16(data, offset)
            if value is None:
                continue
            base = thumb_pc(add_ins.address)
            target = (base + value) & 0xFFFFFFFF
            thumb = target & ~1
            rows = disasm_window(data, thumb, 0x16)
            head = ins_text(rows[0]) if rows else ""
            score = 0
            if rows:
                if rows[0].mnemonic == "push":
                    score += 4
                if rows[0].mnemonic in {"ldr", "movs", "adds", "cmp"}:
                    score += 1
                if rows[0].mnemonic in {"pop", "bx"}:
                    score -= 2
            out.append({
                "kind": f"{pool_name}{delta:+d}" if delta else pool_name,
                "pool": hx(offset),
                "value": hx(value, 4),
                "target": hx(target),
                "thumb": hx(thumb),
                "score": score,
                "head": head,
            })
    out.sort(key=lambda item: (-item["score"], item["thumb"]))
    return out[:4]


def wrapper_call_shape_verdict(data, target_hex):
    if not target_hex:
        return {
            "status": "unresolved",
            "reason": "no candidate target",
            "instructions": [],
        }
    target = int(target_hex, 16) & ~1
    rows = disasm_window(data, target, 0x24)
    r2_defined = False
    for row in rows[:8]:
        try:
            reads, writes = row.regs_access()
        except Exception:
            reads, writes = [], []
        if ARM_REG_R2 in reads and not r2_defined:
            return {
                "status": "call-shape-rejected",
                "reason": "the candidate consumes r2 before defining it, but the wrapper has just used r2 as the BLX function-pointer register",
                "instructions": [ins_text(item) for item in rows[:8]],
            }
        if ARM_REG_R2 in writes:
            r2_defined = True
        if row.mnemonic.startswith("b") and row.mnemonic not in {"bne", "beq", "bgt", "blt", "bge", "ble"}:
            break
    return {
        "status": "call-shape-compatible",
        "reason": "the candidate does not consume wrapper-clobbered r2 before defining it",
        "instructions": [ins_text(item) for item in rows[:8]],
    }


def is_reg(op, name):
    return op.type == ARM_OP_REG and name == reg_name(op._insn, op.reg)


def scan_initializer(data, window):
    md = Cs(CS_ARCH_ARM, CS_MODE_THUMB)
    md.detail = True
    rows = list(md.disasm(data[window["start"]:window["start"] + window["size"]], window["start"]))
    aliases = {"r0": 0}
    pending_literal = {}
    stores = []

    def set_alias(reg, value):
        if value is None:
            aliases.pop(reg, None)
        else:
            aliases[reg] = value

    for ins in rows:
        text = ins_text(ins)
        if ins.mnemonic == "ldr" and len(ins.operands) >= 2:
            dst, src = ins.operands[0], ins.operands[1]
            if dst.type == ARM_OP_REG and src.type == ARM_OP_MEM:
                dst_name = reg_name(ins, dst.reg)
                if src.mem.base == ARM_REG_PC:
                    pending_literal[dst_name] = ins
                    set_alias(dst_name, None)
                else:
                    set_alias(dst_name, None)
            continue

        if ins.mnemonic in {"add", "adds"} and len(ins.operands) >= 2 and ins.operands[0].type == ARM_OP_REG:
            dst = reg_name(ins, ins.operands[0].reg)
            ops = ins.operands
            if len(ops) >= 3 and ops[1].type == ARM_OP_REG and ops[2].type == ARM_OP_IMM:
                src = reg_name(ins, ops[1].reg)
                if src in aliases:
                    set_alias(dst, aliases[src] + ops[2].imm)
                else:
                    set_alias(dst, None)
                continue
            if len(ops) >= 2 and ops[1].type == ARM_OP_IMM:
                if dst in aliases:
                    aliases[dst] += ops[1].imm
                continue
            if len(ops) >= 2 and ops[1].type == ARM_OP_REG and ops[1].reg == ARM_REG_PC:
                # This is the second half of an LDR literal / ADD PC pair.
                # Keep alias removed; the register now holds a method/code pointer.
                set_alias(dst, None)
                continue

        if ins.mnemonic == "mov" and len(ins.operands) >= 2 and ins.operands[0].type == ARM_OP_REG and ins.operands[1].type == ARM_OP_REG:
            dst = reg_name(ins, ins.operands[0].reg)
            src = reg_name(ins, ins.operands[1].reg)
            set_alias(dst, aliases.get(src))
            continue

        if ins.mnemonic.startswith("str") and len(ins.operands) >= 2:
            src, dst = ins.operands[0], ins.operands[1]
            if src.type != ARM_OP_REG or dst.type != ARM_OP_MEM:
                continue
            src_name = reg_name(ins, src.reg)
            base_name = reg_name(ins, dst.mem.base)
            if base_name not in aliases:
                continue
            absolute = aliases[base_name] + dst.mem.disp
            source_ldr = pending_literal.get(src_name)
            candidates = []
            if source_ldr:
                # Find the ADD PC immediately before the store when present.
                add_ins = None
                for back in reversed(rows[:rows.index(ins)]):
                    if back.address < source_ldr.address:
                        break
                    if back.mnemonic in {"add", "adds"} and back.operands and back.operands[0].type == ARM_OP_REG and reg_name(back, back.operands[0].reg) == src_name:
                        add_ins = back
                        break
                if add_ins:
                    candidates = target_candidates(data, source_ldr, add_ins)
            stores.append({
                "store": ins.address,
                "storeHex": hx(ins.address),
                "slot": absolute,
                "slotHex": hx(absolute, 4),
                "sourceReg": src_name,
                "baseReg": base_name,
                "baseAlias": hx(aliases[base_name], 4),
                "memDisp": hx(dst.mem.disp, 4),
                "text": text,
                "candidates": candidates,
            })

    focus = [row for row in stores if row["slot"] in {item["relativeOffset"] for item in FACADES}]
    nearby = [row for row in stores if row["slot"] in set(NEARBY_OFFSETS)]
    return {
        **window,
        "startHex": hx(window["start"]),
        "storeCount": len(stores),
        "focusStores": focus,
        "nearbyStores": nearby,
        "maxSlotHex": hx(max((row["slot"] for row in stores), default=0), 4),
        "instructions": [ins_text(row) for row in rows[:80]],
    }


def build_report(input_path):
    data = pathlib.Path(input_path).read_bytes()
    windows = [scan_initializer(data, window) for window in INITIALIZER_WINDOWS]
    focus_hits = []
    nearby_hits = []
    for window in windows:
        for row in window["focusStores"]:
            focus_hits.append({"window": window["name"], **row})
        for row in window["nearbyStores"]:
            nearby_hits.append({"window": window["name"], **row})

    facade_resolutions = []
    for facade in FACADES:
        hits = [hit for hit in focus_hits if hit["slot"] == facade["relativeOffset"]]
        best = hits[0]["candidates"][0] if hits and hits[0]["candidates"] else None
        verdict = wrapper_call_shape_verdict(data, best["thumb"] if best else "")
        status = "unresolved-in-static-initializers"
        if hits:
            status = "static-candidate" if verdict["status"] == "call-shape-compatible" else "static-candidate-callshape-rejected"
        facade_resolutions.append({
            **facade,
            "wrapperHex": hx(facade["wrapper"]),
            "relativeOffsetHex": hx(facade["relativeOffset"], 4),
            "hitCount": len(hits),
            "status": status,
            "bestCandidate": best,
            "callShape": verdict,
            "hits": hits[:4],
        })

    return {
        "schema": "nicai.cbe.xseFacadeSlotTrace.v1",
        "input": str(pathlib.Path(input_path)),
        "generated": _dt.datetime.now(_dt.UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "facades": [
            {
                **item,
                "wrapperHex": hx(item["wrapper"]),
                "relativeOffsetHex": hx(item["relativeOffset"], 4),
            }
            for item in FACADES
        ],
        "facadeResolutions": facade_resolutions,
        "focusHitCount": len(focus_hits),
        "nearbyHitCount": len(nearby_hits),
        "focusHits": focus_hits,
        "nearbyHits": nearby_hits[:40],
        "windows": windows,
        "conclusion": {
            "finding": "The 0x934 facade slot has one static initializer candidate at 0x2B2C+0x18C, but that candidate is call-shape rejected; the 0x958 facade slot is still unresolved in the scanned static table initializers.",
            "guardrail": "The rejected 0x934 candidate lands at 0x1125E and consumes r2 immediately, while the wrapper uses r2 as the BLX function-pointer register. The live facade table is therefore likely overwritten or populated by a later runtime copy/registration path.",
            "nextTarget": "Trace the 0x3B74 setup chain and the [sb+0x35E0] pointer source, then replay enough of its object-copy path to populate facade method slots.",
        },
    }


def md_row(values):
    return "| " + " | ".join(str(value).replace("|", "\\|") for value in values) + " |"


def render_markdown(report):
    lines = [
        "# XSE Facade Slot Trace",
        "",
        f"- Input CBE: `{report['input']}`",
        f"- Generated: {report['generated']}",
        "",
        "## Current Conclusion",
        "",
        f"- Focus hits for wrapper method offsets: {report['focusHitCount']}",
        f"- Nearby hits for wrapper-family offsets: {report['nearbyHitCount']}",
        f"- {report['conclusion']['finding']}",
        f"- {report['conclusion']['guardrail']}",
        f"- {report['conclusion']['nextTarget']}",
        "",
        "## Facade Offsets",
        "",
        md_row(["Wrapper", "Path", "Relative offset"]),
        md_row(["---", "---", "---"]),
    ]
    for item in report["facades"]:
        lines.append(md_row([item["wrapperHex"], item["path"], item["relativeOffsetHex"]]))

    lines.extend(["", "## Facade Resolutions", ""])
    lines.append(md_row(["Wrapper", "Offset", "Status", "Best target", "Call shape", "Store"]))
    lines.append(md_row(["---", "---", "---", "---", "---", "---"]))
    for item in report["facadeResolutions"]:
        best = item["bestCandidate"]
        first_hit = item["hits"][0] if item["hits"] else None
        lines.append(md_row([
            item["wrapperHex"],
            item["relativeOffsetHex"],
            item["status"],
            best["thumb"] if best else "-",
            item["callShape"]["status"],
            f"{first_hit['window']} {first_hit['storeHex']}" if first_hit else "-",
        ]))

    lines.extend(["", "## Focus Stores", ""])
    if not report["focusHits"]:
        lines.append("- none")
    for hit in report["focusHits"]:
        best = hit["candidates"][0] if hit["candidates"] else None
        lines.append(f"- {hit['window']} `{hit['storeHex']}` -> `{hit['slotHex']}` {best['thumb'] if best else 'no target candidate'}")

    lines.extend(["", "## Nearby Stores", ""])
    if not report["nearbyHits"]:
        lines.append("- none")
    for hit in report["nearbyHits"][:20]:
        best = hit["candidates"][0] if hit["candidates"] else None
        lines.append(f"- {hit['window']} `{hit['storeHex']}` -> `{hit['slotHex']}` {best['thumb'] if best else 'no target candidate'}")

    lines.extend(["", "## Initializer Windows", ""])
    for window in report["windows"]:
        lines.append(f"### {window['name']}")
        lines.append("")
        lines.append(f"- Start: `{window['startHex']}`")
        lines.append(f"- Stores seen: {window['storeCount']}; max slot `{window['maxSlotHex']}`; focus stores {len(window['focusStores'])}; nearby stores {len(window['nearbyStores'])}")
        lines.append("")
        for text in window["instructions"][:30]:
            lines.append(f"- `{text}`")
        if len(window["instructions"]) > 30:
            lines.append("- ...")
        lines.append("")
    return "\n".join(lines)


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    input_path = pathlib.Path(argv[0] if argv else DEFAULT_INPUT)
    out_dir = pathlib.Path(argv[1] if len(argv) > 1 else DEFAULT_OUT)
    out_dir.mkdir(parents=True, exist_ok=True)
    report = build_report(input_path)
    json_path = out_dir / "xse_facade_slot_trace.json"
    md_path = out_dir / "xse_facade_slot_trace.md"
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    md_path.write_text(render_markdown(report), encoding="utf-8")
    print(f"wrote {json_path}")
    print(f"wrote {md_path}")


if __name__ == "__main__":
    main()
