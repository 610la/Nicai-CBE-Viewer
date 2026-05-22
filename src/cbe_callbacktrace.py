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


DEFAULT_INPUT = pathlib.Path(__file__).resolve().parents[1] / "cbe file" / "众神之战.CBE"


def parse_int(text):
    return int(str(text), 0)


def hex32(value):
    return f"0x{value & 0xFFFFFFFF:08X}"


def reg_name(ins, reg_id):
    try:
        return ins.reg_name(reg_id)
    except Exception:
        return str(reg_id)


def read_u32_variants(data, offset):
    if offset < 0 or offset + 4 > len(data):
        return None
    return {
        "offset": offset,
        "bytes": data[offset:offset + 4],
        "le_u": struct.unpack_from("<I", data, offset)[0],
        "be_u": struct.unpack_from(">I", data, offset)[0],
        "le_s": struct.unpack_from("<i", data, offset)[0],
        "be_s": struct.unpack_from(">i", data, offset)[0],
    }


def read_u16_value(data, offset):
    if offset < 0 or offset + 2 > len(data):
        return None
    return struct.unpack_from("<H", data, offset)[0]


def thumb_pc_base(address):
    return (address + 4) & ~3


def literal_targets(ins):
    if len(ins.operands) < 2:
        return None
    if ins.operands[1].type != ARM_OP_MEM:
        return None
    mem = ins.operands[1].mem
    if mem.base != ARM_REG_PC:
        return None
    return {
        "aligned": thumb_pc_base(ins.address) + mem.disp,
        "raw": ins.address + 4 + mem.disp,
    }


def is_reg_operand(op):
    return op.type == ARM_OP_REG


def pc_add_target(add_ins, loaded_value):
    # Thumb literal sequences in this binary commonly use:
    #   ldr rN, [pc, #imm]
    #   add rN, pc
    # The add sees PC as current_address + 4, aligned to word boundary.
    return thumb_pc_base(add_ins.address) + loaded_value


def cbe_pc_add_target(add_ins, loaded_value):
    # The CBE literal pools observed around 0x1031E are packed on halfword
    # boundaries. Using address+4, without Thumb word alignment, maps those
    # entries to nearby real routines such as 0x101E6. Keep the aligned ARM
    # form as an alternate because normal Thumb code still appears elsewhere.
    return add_ins.address + 4 + loaded_value


def cbe_half_targets(data, add_ins, pools):
    targets = []
    for label, pool in (
        ("rawHalf", pools["raw"]),
        ("rawHalf+2", pools["raw"] + 2),
        ("alignedHalf", pools["aligned"]),
        ("alignedHalf+2", pools["aligned"] + 2),
    ):
        value = read_u16_value(data, pool)
        if value is None:
            continue
        target = cbe_pc_add_target(add_ins, value)
        targets.append((label, pool, value, target, target & ~1))
    return targets




def disasm_one_at(md, data, offset):
    for ins in md.disasm(data[offset:offset + 8], offset, count=1):
        if ins.address == offset:
            return ins
    return None


def context_window(data, address, before=3, after=3):
    md = Cs(CS_ARCH_ARM, CS_MODE_THUMB)
    md.detail = False
    start = max(0, address - before * 4)
    end = min(len(data), address + after * 4 + 8)
    rows = []
    for off in range(start & ~1, end, 2):
        ins = disasm_one_at(md, data, off)
        if not ins:
            continue
        mark = ">" if ins.address == address else " "
        rows.append(f"{mark} {ins.address:08X}: {ins.bytes.hex(' ').upper():<14} {ins.mnemonic:<7} {ins.op_str}")
    return rows


def prologue_hint(data, target):
    target &= ~1
    if target < 0 or target >= len(data):
        return None
    md = Cs(CS_ARCH_ARM, CS_MODE_THUMB)
    md.detail = True
    ins = disasm_one_at(md, data, target)
    if not ins:
        return {"head": None, "looks_like_code": False, "reason": "no instruction"}
    head = f"{ins.mnemonic} {ins.op_str}".strip()
    looks_like_code = ins.mnemonic in {"push", "movs", "sub", "stmdb", "ldr", "add"}
    return {
        "head": head,
        "looks_like_code": looks_like_code,
        "reason": "prologue-like" if ins.mnemonic == "push" else "code-like" if looks_like_code else "unclear",
    }


def parse_store(ins):
    if ins.mnemonic not in {"str", "strh", "strb", "str.w", "strh.w", "strb.w"}:
        return None
    if len(ins.operands) < 2:
        return None
    if not is_reg_operand(ins.operands[0]) or ins.operands[1].type != ARM_OP_MEM:
        return None
    mem = ins.operands[1].mem
    base = reg_name(ins, mem.base)
    return {
        "reg": reg_name(ins, ins.operands[0].reg),
        "base": base,
        "offset": mem.disp,
    }


def find_callback_store(insns, start_index):
    ldr = insns[start_index]
    if len(ldr.operands) < 1 or not is_reg_operand(ldr.operands[0]):
        return None
    reg = reg_name(ldr, ldr.operands[0].reg)
    add_index = None
    for j in range(start_index + 1, min(len(insns), start_index + 6)):
        add_ins = insns[j]
        if (
            add_ins.mnemonic == "add"
            and len(add_ins.operands) >= 2
            and is_reg_operand(add_ins.operands[0])
            and add_ins.operands[1].type == ARM_OP_REG
            and add_ins.operands[1].reg == ARM_REG_PC
            and reg_name(add_ins, add_ins.operands[0].reg) == reg
        ):
            add_index = j
            break
    if add_index is None:
        return None

    for j in range(add_index + 1, min(len(insns), add_index + 5)):
        store = parse_store(insns[j])
        if store and store["reg"] == reg:
            return insns[add_index], insns[j], store
    return None


def analyze_window(data, offset, size):
    md = Cs(CS_ARCH_ARM, CS_MODE_THUMB)
    md.detail = True
    insns = list(md.disasm(data[offset:offset + size], offset))
    lines = []
    candidates = []
    i = 0
    while i < len(insns):
        ins = insns[i]
        raw = ins.bytes.hex(" ").upper()
        note = ""
        lit = literal_targets(ins)
        if lit is not None:
            aligned_variants = read_u32_variants(data, lit["aligned"])
            raw_variants = read_u32_variants(data, lit["raw"])
            if aligned_variants or raw_variants:
                future = find_callback_store(insns, i)
                add_for_target = future[0] if future else ins
                note_parts = []
                if raw_variants:
                    cbe_target = cbe_pc_add_target(add_for_target, raw_variants["le_s"])
                    cbe_thumb = cbe_target & ~1
                    note_parts.append(
                        f"rawPool={hex32(lit['raw'])} le={hex32(raw_variants['le_u'])} "
                        f"cbeLE+pc={hex32(cbe_target)} cbeThumb={hex32(cbe_thumb)}"
                    )
                    if 0 <= cbe_thumb < len(data):
                        hint = prologue_hint(data, cbe_thumb)
                        if hint:
                            note_parts.append(f"cbeHead={hint['head'] or '-'}")
                for label, pool, value, target, thumb in cbe_half_targets(data, add_for_target, lit):
                    note_parts.append(f"{label}@{hex32(pool)}={value:#06x}->{hex32(thumb)}")
                if aligned_variants:
                    be_target = pc_add_target(add_for_target, aligned_variants["be_s"])
                    be_thumb = be_target & ~1
                    note_parts.append(
                        f"alignedPool={hex32(lit['aligned'])} be={hex32(aligned_variants['be_u'])} "
                        f"alignedBE+pc={hex32(be_target)} alignedBEThumb={hex32(be_thumb)}"
                    )
                note = " ; " + " ".join(note_parts)

                # Detect the common ldr/add pc/str callback-store pattern.
                if future:
                    add_ins, store_ins, store = future
                    candidates.append({
                        "ldr": ins,
                        "add": add_ins,
                        "store": store_ins,
                        "aligned_pool": lit["aligned"],
                        "raw_pool": lit["raw"],
                        "aligned_variants": aligned_variants,
                        "raw_variants": raw_variants,
                        "aligned_be_target": pc_add_target(add_ins, aligned_variants["be_s"]) if aligned_variants else None,
                        "aligned_le_target": pc_add_target(add_ins, aligned_variants["le_s"]) if aligned_variants else None,
                        "cbe_le_target": cbe_pc_add_target(add_ins, raw_variants["le_s"]) if raw_variants else None,
                        "cbe_be_target": cbe_pc_add_target(add_ins, raw_variants["be_s"]) if raw_variants else None,
                        "half_targets": cbe_half_targets(data, add_ins, lit),
                        "store_offset": store["offset"],
                        "store_base": store["base"],
                    })
        lines.append(f"{ins.address:08X}: {raw:<14} {ins.mnemonic:<8} {ins.op_str}{note}")
        i += 1

    return lines, candidates


def summarize_candidates(data, candidates):
    lines = []
    for idx, cand in enumerate(candidates, 1):
        store_off = cand["store_offset"]
        store_off_text = f"+0x{store_off:X}" if store_off >= 0 else f"-0x{abs(store_off):X}"
        cbe_target = cand["cbe_le_target"]
        cbe_thumb = cbe_target & ~1 if cbe_target is not None else None
        aligned_be_target = cand["aligned_be_target"]
        aligned_be_thumb = aligned_be_target & ~1 if aligned_be_target is not None else None
        hint = prologue_hint(data, cbe_thumb) if cbe_thumb is not None else None
        lines.append(f"#{idx} store@{hex32(cand['store'].address)} [{cand['store_base']}{store_off_text}]")
        if cand["raw_variants"]:
            variants = cand["raw_variants"]
            lines.append(
                f"  rawPool={hex32(cand['raw_pool'])} "
                f"le={hex32(variants['le_u'])}/{variants['le_s']} "
                f"cbeLE+pc={hex32(cbe_target)} cbeThumb={hex32(cbe_thumb)}"
            )
        if cand["aligned_variants"]:
            variants = cand["aligned_variants"]
            lines.append(
                f"  alignedPool={hex32(cand['aligned_pool'])} "
                f"be={hex32(variants['be_u'])}/{variants['be_s']} "
                f"alignedBE+pc={hex32(aligned_be_target)} alignedBEThumb={hex32(aligned_be_thumb)}"
            )
        for label, pool, value, target, thumb in cand.get("half_targets", []):
            lines.append(f"  {label}@{hex32(pool)}={value:#06x} cbeHalf+pc={hex32(target)} cbeHalfThumb={hex32(thumb)}")
        if hint:
            lines.append(f"  cbeHead={hint['head'] or '-'} ({hint['reason']})")
        lines.extend(f"  {row}" for row in context_window(data, cand["store"].address, 2, 2))
    return lines


def main():
    parser = argparse.ArgumentParser(description="Resolve Thumb callback tables inside a narrow Nicai CBE window.")
    parser.add_argument("input", nargs="?", default=DEFAULT_INPUT)
    parser.add_argument("--offset", "-o", action="append", default=[], help="Thumb code window offset, e.g. 0x1031e")
    parser.add_argument("--size", "-s", default="0x180", help="Bytes per window")
    args = parser.parse_args()

    data = pathlib.Path(args.input).read_bytes()
    for offset_text in args.offset:
        offset = parse_int(offset_text)
        print(f"\n## window {hex32(offset)}")
        lines, candidates = analyze_window(data, offset, parse_int(args.size))
        print("\n".join(lines))
        if candidates:
            print("\n## callback candidates")
            print("\n".join(summarize_candidates(data, candidates)))
        else:
            print("\n## callback candidates")
            print("-")


if __name__ == "__main__":
    main()
