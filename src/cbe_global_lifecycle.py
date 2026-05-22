#!/usr/bin/env python3
import argparse
import pathlib
import struct
import sys

local_deps = pathlib.Path(__file__).resolve().parent / ".python_deps"
if local_deps.exists():
    sys.path.insert(0, str(local_deps))

from capstone import Cs, CS_ARCH_ARM, CS_MODE_THUMB
from capstone.arm_const import ARM_OP_MEM, ARM_OP_REG, ARM_REG_SB


DEFAULT_INPUT = pathlib.Path(__file__).resolve().parents[1] / "cbe file" / "众神之战.CBE"


def parse_int(text):
    return int(str(text), 0)


def hx(value, width=8):
    return f"0x{value & 0xFFFFFFFF:0{width}X}"


def reg_name(ins, reg_id):
    try:
        return ins.reg_name(reg_id)
    except Exception:
        return str(reg_id)


def read_u16(data, offset):
    if offset < 0 or offset + 2 > len(data):
        return None
    return struct.unpack_from("<H", data, offset)[0]


def read_u32(data, offset, signed=False):
    if offset < 0 or offset + 4 > len(data):
        return None
    return struct.unpack_from("<i" if signed else "<I", data, offset)[0]


def thumb_literal_pools(ins):
    if ins.mnemonic != "ldr" or len(ins.operands) < 2:
        return None
    mem = ins.operands[1]
    if mem.type != ARM_OP_MEM:
        return None
    if "[pc" not in ins.op_str:
        return None
    disp = mem.mem.disp
    return {
        "raw": ins.address + 4 + disp,
        "raw2": ins.address + 6 + disp,
        "aligned": ((ins.address + 4) & ~3) + disp,
    }


def literal_matches(data, ins, target):
    pools = thumb_literal_pools(ins)
    if not pools:
        return []
    matches = []
    for label, pool in (
        ("halfLE(raw)", pools["raw"]),
        ("halfLE(raw+2)", pools["raw"] + 2),
        ("halfLE(raw2)", pools["raw2"]),
        ("halfLE(aligned)", pools["aligned"]),
        ("halfLE(aligned+2)", pools["aligned"] + 2),
    ):
        value = read_u16(data, pool)
        if value == target:
            matches.append((label, pool, value))
    for label, pool in (
        ("u32LE(raw)", pools["raw"]),
        ("u32LE(raw2)", pools["raw2"]),
        ("u32LE(aligned)", pools["aligned"]),
    ):
        value = read_u32(data, pool)
        if value == target:
            matches.append((label, pool, value))
    return matches


def is_add_sb(ins, reg):
    if ins.mnemonic != "add" or len(ins.operands) < 2:
        return False
    left, right = ins.operands[0], ins.operands[1]
    return (
        left.type == ARM_OP_REG
        and right.type == ARM_OP_REG
        and reg_name(ins, left.reg) == reg
        and right.reg == ARM_REG_SB
    )


def is_mem_with_base(ins, reg):
    for op in ins.operands:
        if op.type == ARM_OP_MEM and reg_name(ins, op.mem.base) == reg:
            return True
    return False


def ins_text(ins):
    return f"{ins.address:08X}: {ins.bytes.hex(' ').upper():<14} {ins.mnemonic:<8} {ins.op_str}"


def scan(data, targets):
    md = Cs(CS_ARCH_ARM, CS_MODE_THUMB)
    md.detail = True
    hits = []

    # Disassemble in broad overlapping windows. CBE mixes code and data; we keep
    # this as a candidate scanner and later classify by nearby add-sb/use shape.
    for off in range(0, len(data) - 8, 2):
        insns = list(md.disasm(data[off:off + 40], off))
        if not insns or insns[0].address != off:
            continue
        ins = insns[0]
        if not ins.operands or ins.operands[0].type != ARM_OP_REG:
            continue
        reg = reg_name(ins, ins.operands[0].reg)
        for target in targets:
            matches = literal_matches(data, ins, target)
            if not matches:
                continue
            add_idx = None
            for idx, future in enumerate(insns[1:8], 1):
                if is_add_sb(future, reg):
                    add_idx = idx
                    break
            if add_idx is None:
                continue
            use = []
            for future in insns[add_idx + 1:add_idx + 8]:
                if is_mem_with_base(future, reg) or future.mnemonic.startswith("bl"):
                    use.append(ins_text(future))
                    if len(use) >= 4:
                        break
            hits.append({
                "target": target,
                "offset": off,
                "reg": reg,
                "matches": matches,
                "context": [ins_text(row) for row in insns[:min(len(insns), add_idx + 8)]],
                "use": use,
            })
    return hits


def main():
    parser = argparse.ArgumentParser(description="Scan CBE Thumb code for literal/add-sb global-slot lifecycles.")
    parser.add_argument("input", nargs="?", default=DEFAULT_INPUT)
    parser.add_argument("--target", "-t", action="append", required=True, help="Global slot offset, e.g. 0x35c4")
    parser.add_argument("--limit", default="200")
    args = parser.parse_args()

    data = pathlib.Path(args.input).read_bytes()
    targets = [parse_int(text) for text in args.target]
    hits = scan(data, targets)
    limit = parse_int(args.limit)

    for target in targets:
        subset = [hit for hit in hits if hit["target"] == target]
        print(f"\n## global {hx(target, 4)} hits={len(subset)}")
        for hit in subset[:limit]:
            labels = ", ".join(f"{label}@{hx(pool)}" for label, pool, _ in hit["matches"])
            print(f"\n@{hx(hit['offset'])} reg={hit['reg']} {labels}")
            for row in hit["context"]:
                print(f"  {row}")


if __name__ == "__main__":
    main()
