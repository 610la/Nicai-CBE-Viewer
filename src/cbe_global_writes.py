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


def read_u16(data, offset):
    if offset < 0 or offset + 2 > len(data):
        return None
    return struct.unpack_from("<H", data, offset)[0]


def read_u32(data, offset):
    if offset < 0 or offset + 4 > len(data):
        return None
    return struct.unpack_from("<I", data, offset)[0]


def reg_name(ins, reg_id):
    try:
        return ins.reg_name(reg_id)
    except Exception:
        return str(reg_id)


def literal_pools(ins):
    if ins.mnemonic != "ldr" or len(ins.operands) < 2:
        return None
    mem = ins.operands[1]
    if mem.type != ARM_OP_MEM or "[pc" not in ins.op_str:
        return None
    disp = mem.mem.disp
    return {
        "raw": ins.address + 4 + disp,
        "raw2": ins.address + 6 + disp,
        "aligned": ((ins.address + 4) & ~3) + disp,
    }


def literal_contains(data, ins, target):
    pools = literal_pools(ins)
    if not pools:
        return []
    out = []
    for label, offset in (
        ("u16 raw", pools["raw"]),
        ("u16 raw+2", pools["raw"] + 2),
        ("u16 raw2", pools["raw2"]),
        ("u16 aligned", pools["aligned"]),
        ("u16 aligned+2", pools["aligned"] + 2),
    ):
        value = read_u16(data, offset)
        if value == target:
            out.append((label, offset, value))
    for label, offset in (
        ("u32 raw", pools["raw"]),
        ("u32 raw2", pools["raw2"]),
        ("u32 aligned", pools["aligned"]),
    ):
        value = read_u32(data, offset)
        if value == target:
            out.append((label, offset, value))
    return out


def is_add_sb(ins, reg):
    if ins.mnemonic != "add" or len(ins.operands) < 2:
        return False
    return (
        ins.operands[0].type == ARM_OP_REG
        and ins.operands[1].type == ARM_OP_REG
        and reg_name(ins, ins.operands[0].reg) == reg
        and ins.operands[1].reg == ARM_REG_SB
    )


def mem_base_name(ins):
    if len(ins.operands) < 2:
        return None
    mem = ins.operands[1]
    if mem.type != ARM_OP_MEM:
        return None
    return reg_name(ins, mem.mem.base), mem.mem.disp


def classify_use(ins, base_reg):
    if len(ins.operands) < 2:
        return None
    op0 = ins.operands[0]
    op1 = ins.operands[1]
    if op1.type == ARM_OP_MEM and reg_name(ins, op1.mem.base) == base_reg:
        if ins.mnemonic.startswith("str"):
            src = reg_name(ins, op0.reg) if op0.type == ARM_OP_REG else "?"
            return f"WRITE {ins.mnemonic} {src} -> [{base_reg}{fmt_disp(op1.mem.disp)}]"
        if ins.mnemonic.startswith("ldr"):
            dst = reg_name(ins, op0.reg) if op0.type == ARM_OP_REG else "?"
            return f"READ {ins.mnemonic} {dst} <- [{base_reg}{fmt_disp(op1.mem.disp)}]"
    return None


def fmt_disp(value):
    if value == 0:
        return ""
    if value > 0:
        return f"+0x{value:X}"
    return f"-0x{abs(value):X}"


def ins_text(ins):
    return f"{ins.address:08X}: {ins.bytes.hex(' ').upper():<14} {ins.mnemonic:<8} {ins.op_str}"


def scan(data, targets, window=48):
    md = Cs(CS_ARCH_ARM, CS_MODE_THUMB)
    md.detail = True
    rows = []
    for off in range(0, len(data) - 8, 2):
        insns = list(md.disasm(data[off:off + window], off))
        if not insns or insns[0].address != off:
            continue
        ins = insns[0]
        if not ins.operands or ins.operands[0].type != ARM_OP_REG:
            continue
        reg = reg_name(ins, ins.operands[0].reg)
        for target in targets:
            matches = literal_contains(data, ins, target)
            if not matches:
                continue
            add_idx = None
            for idx, future in enumerate(insns[1:8], 1):
                if is_add_sb(future, reg):
                    add_idx = idx
                    break
            if add_idx is None:
                continue
            uses = []
            for future in insns[add_idx + 1:add_idx + 14]:
                item = classify_use(future, reg)
                if item:
                    uses.append((future.address, item, ins_text(future)))
                elif future.mnemonic.startswith("bl"):
                    uses.append((future.address, "CALL", ins_text(future)))
                if len(uses) >= 8:
                    break
            rows.append({
                "target": target,
                "offset": off,
                "reg": reg,
                "matches": matches,
                "context": [ins_text(row) for row in insns[:min(len(insns), add_idx + 14)]],
                "uses": uses,
            })
    return rows


def main():
    parser = argparse.ArgumentParser(description="Classify reads/writes of sb-relative CBE global slots.")
    parser.add_argument("input", nargs="?", default=DEFAULT_INPUT)
    parser.add_argument("-t", "--target", action="append", required=True)
    parser.add_argument("--limit", default="200")
    parser.add_argument("--writes-only", action="store_true")
    args = parser.parse_args()

    data = pathlib.Path(args.input).read_bytes()
    targets = [parse_int(item) for item in args.target]
    rows = scan(data, targets)
    limit = parse_int(args.limit)

    for target in targets:
        print(f"\n## global base {hx(target, 4)}")
        shown = 0
        for row in [item for item in rows if item["target"] == target]:
            if args.writes_only and not any(use[1].startswith("WRITE") for use in row["uses"]):
                continue
            shown += 1
            if shown > limit:
                break
            labels = ", ".join(f"{label}@{hx(offset)}" for label, offset, _ in row["matches"])
            print(f"\n@{hx(row['offset'])} reg={row['reg']} {labels}")
            for _, kind, text in row["uses"]:
                print(f"  {kind:<28} {text}")
            print("  context:")
            for text in row["context"]:
                print(f"    {text}")


if __name__ == "__main__":
    main()
