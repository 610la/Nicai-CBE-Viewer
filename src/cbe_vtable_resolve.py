#!/usr/bin/env python3
import argparse
import pathlib
import struct
import sys

local_deps = pathlib.Path(__file__).resolve().parent / ".python_deps"
if local_deps.exists():
    sys.path.insert(0, str(local_deps))

from capstone import Cs, CS_ARCH_ARM, CS_MODE_THUMB
from capstone.arm_const import ARM_OP_MEM, ARM_OP_REG, ARM_REG_PC


def parse_int(text):
    return int(str(text), 0)


def hx(value, width=8):
    return f"0x{value & 0xFFFFFFFF:0{width}X}"


def reg_name(ins, reg_id):
    try:
        return ins.reg_name(reg_id)
    except Exception:
        return str(reg_id)


def read_u32(data, offset, endian):
    if offset < 0 or offset + 4 > len(data):
        return None
    fmt = "<i" if endian == "le" else ">i"
    return struct.unpack_from(fmt, data, offset)[0]


def read_u16(data, offset, endian="le"):
    if offset < 0 or offset + 2 > len(data):
        return None
    fmt = "<H" if endian == "le" else ">H"
    return struct.unpack_from(fmt, data, offset)[0]


def thumb_literal_aligned(address):
    return (address + 4) & ~3


def literal_pools(ins):
    if ins.mnemonic != "ldr" or len(ins.operands) < 2:
        return None
    mem = ins.operands[1]
    if mem.type != ARM_OP_MEM or mem.mem.base != ARM_REG_PC:
        return None
    disp = mem.mem.disp
    return {
        "raw": ins.address + 4 + disp,
        "aligned": thumb_literal_aligned(ins.address) + disp,
    }


def parse_store(ins):
    if not ins.mnemonic.startswith("str") or len(ins.operands) < 2:
        return None
    src = ins.operands[0]
    dst = ins.operands[1]
    if src.type != ARM_OP_REG or dst.type != ARM_OP_MEM:
        return None
    return {
        "src": reg_name(ins, src.reg),
        "base": reg_name(ins, dst.mem.base),
        "offset": dst.mem.disp,
    }


def disasm_one(md, data, offset):
    if offset < 0 or offset >= len(data):
        return None
    for ins in md.disasm(data[offset:offset + 8], offset, count=1):
        if ins.address == offset:
            return ins
    return None


def head(data, target):
    target &= ~1
    md = Cs(CS_ARCH_ARM, CS_MODE_THUMB)
    ins = disasm_one(md, data, target)
    if not ins:
        return "-", 0
    text = f"{ins.mnemonic} {ins.op_str}".strip()
    score = 0
    if ins.mnemonic == "push":
        score = 3
    elif ins.mnemonic in {"movs", "ldr", "adds", "cmp", "sub", "b", "bl"}:
        score = 1
    return text, score


def find_add_pc(insns, start_index, reg):
    for j in range(start_index + 1, min(len(insns), start_index + 6)):
        ins = insns[j]
        if ins.mnemonic != "add" or len(ins.operands) < 2:
            continue
        if ins.operands[0].type != ARM_OP_REG or ins.operands[1].type != ARM_OP_REG:
            continue
        if reg_name(ins, ins.operands[0].reg) == reg and ins.operands[1].reg == ARM_REG_PC:
            return j
    return None


def find_store(insns, start_index, reg):
    for j in range(start_index + 1, min(len(insns), start_index + 6)):
        store = parse_store(insns[j])
        if store and store["src"] == reg:
            return j, store
    return None, None


def candidates_for(data, add_ins, pools):
    out = []
    cbe_base = add_ins.address + 4
    add_pc_base = thumb_literal_aligned(add_ins.address)
    for label, pool in (
        ("halfLE(raw)", pools["raw"]),
        ("halfLE(raw+2)", pools["raw"] + 2),
        ("halfLE(aligned)", pools["aligned"]),
        ("halfLE(aligned+2)", pools["aligned"] + 2),
    ):
        value = read_u16(data, pool, "le")
        if value is None:
            continue
        for base_label, base in (("cbe+4", cbe_base), ("thumb-pc", add_pc_base)):
            target = (base + value) & 0xFFFFFFFF
            text, score = head(data, target)
            out.append({
                "kind": f"{label}/{base_label}",
                "pool": pool,
                "value": value,
                "target": target,
                "thumb": target & ~1,
                "head": text,
                "score": score + (1 if score else 0),
            })
    for label, pool, endian, base in (
        ("rawLE", pools["raw"], "le", cbe_base),
        ("rawBE", pools["raw"], "be", cbe_base),
        ("alignedLE", pools["aligned"], "le", add_pc_base),
        ("alignedBE", pools["aligned"], "be", add_pc_base),
    ):
        value = read_u32(data, pool, endian)
        if value is None:
            continue
        target = (base + value) & 0xFFFFFFFF
        text, score = head(data, target)
        out.append({
            "kind": label,
            "pool": pool,
            "value": value,
            "target": target,
            "thumb": target & ~1,
            "head": text,
            "score": score,
        })
    out.sort(key=lambda item: (-item["score"], item["thumb"]))
    return out


def resolve(data, offset, size, wanted_offsets=None):
    md = Cs(CS_ARCH_ARM, CS_MODE_THUMB)
    md.detail = True
    insns = list(md.disasm(data[offset:offset + size], offset))
    rows = []
    for i, ins in enumerate(insns):
        pools = literal_pools(ins)
        if not pools or not ins.operands or ins.operands[0].type != ARM_OP_REG:
            continue
        reg = reg_name(ins, ins.operands[0].reg)
        add_index = find_add_pc(insns, i, reg)
        if add_index is None:
            continue
        store_index, store = find_store(insns, add_index, reg)
        if not store:
            continue
        if wanted_offsets is not None and store["offset"] not in wanted_offsets:
            continue
        rows.append({
            "ldr": ins,
            "add": insns[add_index],
            "store": insns[store_index],
            "store_info": store,
            "candidates": candidates_for(data, insns[add_index], pools),
        })
    return rows


def format_offset(value):
    if value < 0:
        return f"-0x{abs(value):X}"
    return f"+0x{value:X}"


def main():
    parser = argparse.ArgumentParser(description="Compact resolver for CBE ldr/add-pc/str method tables.")
    parser.add_argument("input")
    parser.add_argument("--offset", "-o", action="append", required=True)
    parser.add_argument("--size", "-s", default="0x180")
    parser.add_argument("--only", default="", help="Comma-separated store offsets, e.g. 0x40,0x50,0x64")
    parser.add_argument("--all-candidates", action="store_true")
    args = parser.parse_args()

    data = pathlib.Path(args.input).read_bytes()
    wanted = None
    if args.only.strip():
        wanted = {parse_int(part.strip()) for part in args.only.split(",") if part.strip()}

    for offset_text in args.offset:
        offset = parse_int(offset_text)
        rows = resolve(data, offset, parse_int(args.size), wanted)
        print(f"\n## table window {hx(offset)} rows={len(rows)}")
        for row in rows:
            store = row["store_info"]
            store_addr = row["store"].address
            where = f"[{store['base']}{format_offset(store['offset'])}]"
            print(f"{hx(store_addr)} {where}")
            shown = row["candidates"] if args.all_candidates else row["candidates"][:2]
            for cand in shown:
                print(
                    f"  {cand['kind']:<9} pool={hx(cand['pool'])} "
                    f"value={cand['value']:+d} target={hx(cand['target'])} "
                    f"thumb={hx(cand['thumb'])} score={cand['score']} head={cand['head']}"
                )


if __name__ == "__main__":
    main()
