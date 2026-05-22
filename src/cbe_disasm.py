#!/usr/bin/env python3
import argparse
import pathlib
import struct
import sys

local_deps = pathlib.Path(__file__).resolve().parent / ".python_deps"
if local_deps.exists():
    sys.path.insert(0, str(local_deps))

from capstone import Cs, CS_ARCH_ARM, CS_MODE_THUMB


DEFAULT_INPUT = pathlib.Path(__file__).resolve().parents[1] / "cbe file" / "众神之战.CBE"


def parse_int(text):
    return int(str(text), 0)


def hex32(value):
    return f"0x{value & 0xFFFFFFFF:08X}"


def hex16(value):
    return f"0x{value & 0xFFFF:04X}"


def ascii_positions(data, needle):
    raw = needle.encode("ascii")
    out = []
    pos = data.find(raw)
    while pos >= 0:
        out.append(pos)
        pos = data.find(raw, pos + 1)
    return out


def read_c_string(data, offset, limit=80):
    if offset < 0 or offset >= len(data):
        return ""
    end = offset
    while end < len(data) and end - offset < limit and 0x20 <= data[end] <= 0x7E:
        end += 1
    return data[offset:end].decode("ascii", errors="ignore")


def ldr_literal_targets(ins):
    if ins.mnemonic != "ldr" or "[pc" not in ins.op_str:
        return None
    # Capstone's compact text is stable enough for this helper. Thumb PC in
    # literal loads is word-aligned address+4.
    pieces = ins.op_str.split("#")
    if len(pieces) < 2:
        imm = 0
    else:
        imm_text = pieces[-1].rstrip("]")
        try:
            imm = int(imm_text, 0)
        except ValueError:
            return None
    return {
        "aligned": ((ins.address + 4) & ~3) + imm,
        "raw": ins.address + 4 + imm,
    }


def find_following_add_pc(insns, index):
    if index >= len(insns):
        return None
    ldr = insns[index]
    pieces = ldr.op_str.split(",")
    if not pieces:
        return None
    reg = pieces[0].strip()
    for next_ins in insns[index + 1:index + 6]:
        if next_ins.mnemonic == "add" and next_ins.op_str.replace(" ", "") == f"{reg},pc":
            return next_ins
    return None


def disasm_window(data, offset, size):
    md = Cs(CS_ARCH_ARM, CS_MODE_THUMB)
    insns = list(md.disasm(data[offset:offset + size], offset))
    for index, ins in enumerate(insns):
        ins_bytes = ins.bytes.hex(" ").upper()
        note = ""
        targets = ldr_literal_targets(ins)
        if targets is not None:
            parts = []
            text = ""
            raw_pool = targets["raw"]
            aligned = targets["aligned"]
            add_ins = find_following_add_pc(insns, index) or ins
            # For the compact CBE literal pools around 0x1031E, the useful
            # interpretation is an unaligned little-endian signed addend read
            # from address+4+imm, then added to the following `add rN, pc`
            # instruction's unaligned PC base.
            if 0 <= raw_pool + 4 <= len(data):
                raw_le_value = struct.unpack_from("<I", data, raw_pool)[0]
                raw_le_signed = struct.unpack_from("<i", data, raw_pool)[0]
                raw_rel = (add_ins.address + 4 + raw_le_signed) & 0xFFFFFFFF
                raw_thumb = raw_rel & ~1
                parts.append(f"rawPool={hex32(raw_pool)} le={hex32(raw_le_value)} cbeLE+pc={hex32(raw_rel)} cbeThumb={hex32(raw_thumb)}")
                text = read_c_string(data, raw_le_value)
            for label, pool in (
                ("rawHalf", raw_pool),
                ("rawHalf+2", raw_pool + 2),
                ("alignedHalf", aligned),
                ("alignedHalf+2", aligned + 2),
            ):
                if 0 <= pool + 2 <= len(data):
                    half = struct.unpack_from("<H", data, pool)[0]
                    half_rel = (add_ins.address + 4 + half) & 0xFFFFFFFF
                    parts.append(f"{label}={hex16(half)} -> {hex32(half_rel & ~1)}")
            # Keep the normal word-aligned big-endian candidate as a secondary
            # diagnostic because some windows still look like aligned tables.
            if 0 <= aligned + 4 <= len(data):
                be_value = struct.unpack_from(">I", data, aligned)[0]
                be_signed = struct.unpack_from(">i", data, aligned)[0]
                aligned_pc = (ins.address + 6) & ~3
                be_rel = (aligned_pc + be_signed) & 0xFFFFFFFF
                be_thumb = be_rel & ~1
                parts.append(f"alignedPool={hex32(aligned)} be={hex32(be_value)} alignedBE+pc={hex32(be_rel)} alignedBEThumb={hex32(be_thumb)}")
                if not text:
                    text = read_c_string(data, be_value)
            values = " ".join(parts)
            if text:
                note = f" ; {values} {text!r}"
            else:
                note = f" ; {values}"
        print(f"{ins.address:08X}: {ins_bytes:<14} {ins.mnemonic:<8} {ins.op_str}{note}")


def find_literal_refs(data, target, span):
    refs = []
    for kind, packed in (("u32-le", struct.pack("<I", target)), ("u32-be", struct.pack(">I", target))):
        pos = data.find(packed)
        while pos >= 0:
            refs.append((kind, pos))
            pos = data.find(packed, pos + 1)

    # Thumb commonly addresses literals through PC-relative loads. This is a
    # rough candidate scan, useful for choosing manual disassembly windows.
    for off in range(0, len(data) - 2, 2):
        op = struct.unpack_from("<H", data, off)[0]
        if (op & 0xF800) != 0x4800:
            continue
        imm8 = op & 0xFF
        literal_addr = ((off + 4) & ~3) + imm8 * 4
        if abs(literal_addr - target) <= span:
            refs.append(("ldr-lit", off))
    return sorted(refs, key=lambda item: item[1])


def main():
    parser = argparse.ArgumentParser(description="Small Thumb disassembly helper for Nicai CBE reverse engineering.")
    parser.add_argument("input", nargs="?", default=DEFAULT_INPUT)
    parser.add_argument("--offset", "-o", action="append", default=[], help="Thumb disassembly window offset, e.g. 0x107f0")
    parser.add_argument("--size", "-s", default="0x180", help="Bytes per disassembly window")
    parser.add_argument("--find", "-f", action="append", default=[], help="ASCII string to locate")
    parser.add_argument("--refs", action="append", default=[], help="Find rough literal refs to an address")
    parser.add_argument("--span", default="0x20", help="Tolerance for rough literal ref scan")
    args = parser.parse_args()

    data = pathlib.Path(args.input).read_bytes()

    for text in args.find:
        hits = ascii_positions(data, text)
        print(f"\n## find {text!r} count={len(hits)}")
        print(" ".join(hex32(hit) for hit in hits[:80]))

    for ref_text in args.refs:
        target = parse_int(ref_text)
        refs = find_literal_refs(data, target, parse_int(args.span))
        print(f"\n## refs near {hex32(target)} count={len(refs)}")
        for kind, off in refs[:80]:
            print(f"{kind:<7} {hex32(off)}")

    for offset_text in args.offset:
        offset = parse_int(offset_text)
        print(f"\n## thumb {hex32(offset)}")
        disasm_window(data, offset, parse_int(args.size))


if __name__ == "__main__":
    main()
