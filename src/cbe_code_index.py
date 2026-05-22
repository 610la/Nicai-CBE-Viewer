#!/usr/bin/env python3
import argparse
import pathlib
import re
import sys

local_deps = pathlib.Path(__file__).resolve().parent / ".python_deps"
if local_deps.exists():
    sys.path.insert(0, str(local_deps))

from capstone import Cs, CS_ARCH_ARM, CS_MODE_THUMB


DEFAULT_INPUT = pathlib.Path(__file__).resolve().parents[1] / "cbe file" / "众神之战.CBE"


def parse_int(text):
    return int(str(text), 0)


def hx(value, width=8):
    return f"0x{value:0{width}X}"


def disasm(data, start=0, end=None):
    md = Cs(CS_ARCH_ARM, CS_MODE_THUMB)
    md.detail = False
    if end is None:
        end = len(data)
    return list(md.disasm(data[start:end], start))


def disasm_one_at(md, data, offset):
    # CBE intermixes code, literals, and resource tables. A single linear
    # disassembly can stop in data, so index scans decode each halfword offset
    # independently and accept the first Thumb instruction Capstone recognizes.
    for ins in md.disasm(data[offset:offset + 8], offset, count=1):
        if ins.address == offset:
            return ins
    return None


def sparse_disasm(data, start, end):
    md = Cs(CS_ARCH_ARM, CS_MODE_THUMB)
    md.detail = False
    for offset in range(start & ~1, min(end, len(data) - 1), 2):
        ins = disasm_one_at(md, data, offset)
        if ins:
            yield ins


def context_window(data, address, before=5, after=5):
    start = max(0, address - before * 4)
    end = min(len(data), address + after * 4 + 8)
    rows = []
    for ins in sparse_disasm(data, start, end):
        if abs(ins.address - address) > max(before, after) * 4 + 6:
            continue
        mark = ">" if ins.address == address else " "
        rows.append(f"{mark} {ins.address:08X}: {ins.bytes.hex(' ').upper():<14} {ins.mnemonic:<7} {ins.op_str}")
    return rows


def branch_target(ins):
    if ins.mnemonic not in ("bl", "blx", "b"):
        return None
    text = ins.op_str.strip()
    if not text.startswith("#"):
        return None
    try:
        return int(text[1:], 0)
    except ValueError:
        return None


def find_callers(data, targets, start, end, window):
    target_set = set(targets)
    rows = []
    for ins in sparse_disasm(data, start, end):
        target = branch_target(ins)
        if target not in target_set:
            continue
        context = context_window(data, ins.address, window, window)
        rows.append((target, ins.address, context))
    return rows


def find_vtable_stores(data, start, end):
    rows = []
    literal_re = re.compile(r"\[pc, #0x([0-9a-f]+)\]", re.I)
    offset_re = re.compile(r"\[[^,\]]+, #0x([0-9a-f]+)\]", re.I)
    for ins in sparse_disasm(data, start, end):
        if ins.mnemonic != "str" or "#" not in ins.op_str:
            continue
        offset_match = offset_re.search(ins.op_str)
        if not offset_match:
            continue
        offset = int(offset_match.group(1), 16)
        if offset not in {0x1C, 0x20, 0x3C, 0x40, 0x4C, 0x50, 0x58, 0x64, 0x70, 0x74, 0x78, 0x7C, 0x80}:
            continue
        context = context_window(data, ins.address, 3, 2)
        rows.append((offset, ins.address, context))
    return rows


def main():
    parser = argparse.ArgumentParser(description="Index Thumb callsites and callback stores in a Nicai CBE.")
    parser.add_argument("input", nargs="?", default=DEFAULT_INPUT)
    parser.add_argument("--callers", action="append", default=[], help="Find direct callers of a target, e.g. 0xF222")
    parser.add_argument("--start", default="0x0")
    parser.add_argument("--end", default=None)
    parser.add_argument("--window", default="4")
    parser.add_argument("--vtable-stores", action="store_true")
    args = parser.parse_args()

    data = pathlib.Path(args.input).read_bytes()
    start = parse_int(args.start)
    end = parse_int(args.end) if args.end else len(data)
    window = parse_int(args.window)

    if args.callers:
      targets = [parse_int(item) for item in args.callers]
      rows = find_callers(data, targets, start, end, window)
      print(f"callers count={len(rows)}")
      for target, address, context in rows:
          print(f"\n## caller {hx(address)} -> {hx(target)}")
          print("\n".join(context))

    if args.vtable_stores:
      rows = find_vtable_stores(data, start, end)
      print(f"vtable-like stores count={len(rows)}")
      for offset, address, context in rows:
          print(f"\n## store {hx(address)} offset=+{offset:#04x}")
          print("\n".join(context))


if __name__ == "__main__":
    main()
