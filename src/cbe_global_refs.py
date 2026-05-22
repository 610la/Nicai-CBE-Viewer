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


def parse_int(text):
    return int(str(text), 0)


def hx(value, width=8):
    return f"0x{value & 0xFFFFFFFF:0{width}X}"


def reg_name(ins, reg_id):
    try:
        return ins.reg_name(reg_id)
    except Exception:
        return str(reg_id)


def read_word(data, offset, endian):
    if offset < 0 or offset + 4 > len(data):
        return None
    fmt = "<I" if endian == "le" else ">I"
    return struct.unpack_from(fmt, data, offset)[0]


def read_u16(data, offset, endian="le"):
    if offset < 0 or offset + 2 > len(data):
        return None
    fmt = "<H" if endian == "le" else ">H"
    return struct.unpack_from(fmt, data, offset)[0]


def pool_addresses(ins):
    if ins.mnemonic != "ldr" or len(ins.operands) < 2:
        return None
    mem = ins.operands[1]
    if mem.type != ARM_OP_MEM:
        return None
    text = ins.op_str
    if "[pc" not in text:
        return None
    disp = mem.mem.disp
    return {
        "raw": ins.address + 4 + disp,
        "raw2": ins.address + 6 + disp,
        "aligned": ((ins.address + 4) & ~3) + disp,
    }


def find_add_sb(insns, start_index, reg):
    for j in range(start_index + 1, min(len(insns), start_index + 8)):
        ins = insns[j]
        if ins.mnemonic != "add" or len(ins.operands) < 2:
            continue
        if ins.operands[0].type != ARM_OP_REG or ins.operands[1].type != ARM_OP_REG:
            continue
        if reg_name(ins, ins.operands[0].reg) == reg and ins.operands[1].reg == ARM_REG_SB:
            return ins
    return None


def plausible_global(value):
    return value < 0x20000


def main():
    parser = argparse.ArgumentParser(description="Trace CBE ldr/add-sb global table references.")
    parser.add_argument("input")
    parser.add_argument("--offset", "-o", action="append", required=True)
    parser.add_argument("--size", "-s", default="0x180")
    args = parser.parse_args()

    data = pathlib.Path(args.input).read_bytes()
    md = Cs(CS_ARCH_ARM, CS_MODE_THUMB)
    md.detail = True

    for offset_text in args.offset:
        offset = parse_int(offset_text)
        size = parse_int(args.size)
        insns = list(md.disasm(data[offset:offset + size], offset))
        print(f"\n## global refs {hx(offset)}")
        for i, ins in enumerate(insns):
            pools = pool_addresses(ins)
            if not pools or not ins.operands or ins.operands[0].type != ARM_OP_REG:
                continue
            reg = reg_name(ins, ins.operands[0].reg)
            add = find_add_sb(insns, i, reg)
            if not add:
                continue
            candidates = []
            for label, pool in (
                ("halfLE(raw-2)", pools["raw"] - 2),
                ("halfLE(raw)", pools["raw"]),
                ("halfLE(raw+2)", pools["raw"] + 2),
                ("halfLE(raw2-2)", pools["raw2"] - 2),
                ("halfLE(raw2)", pools["raw2"]),
                ("halfLE(aligned-2)", pools["aligned"] - 2),
                ("halfLE(aligned)", pools["aligned"]),
                ("halfLE(aligned+2)", pools["aligned"] + 2),
            ):
                value = read_u16(data, pool, "le")
                if value is None:
                    continue
                candidates.append((label, pool, value, plausible_global(value)))
            for label, pool, endian in (
                ("rawLE", pools["raw"], "le"),
                ("rawBE", pools["raw"], "be"),
                ("raw2LE", pools["raw2"], "le"),
                ("raw2BE", pools["raw2"], "be"),
                ("alignedLE", pools["aligned"], "le"),
                ("alignedBE", pools["aligned"], "be"),
            ):
                value = read_word(data, pool, endian)
                if value is None:
                    continue
                candidates.append((label, pool, value, plausible_global(value)))
            candidates.sort(key=lambda item: (not item[3], item[2]))
            best = " ".join(
                f"{label}={hx(value, 4)}@{hx(pool)}{'*' if ok else ''}"
                for label, pool, value, ok in candidates[:6]
            )
            print(f"{hx(ins.address)} -> add@{hx(add.address)} {reg}+sb {best}")


if __name__ == "__main__":
    main()
