#!/usr/bin/env python3
import argparse
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

from cbe_vtable_resolve import resolve as resolve_vtable_rows


DEFAULT_INPUT = pathlib.Path(__file__).resolve().parents[1] / "cbe file" / "众神之战.CBE"
DEFAULT_OUT = "out_godwar_servicelayer"

INIT_WINDOW_OFFSET = 0x3008
INIT_WINDOW_SIZE = 0x60

TABLE_WINDOWS = [
    {"name": "reader/base pass A", "offset": 0x2B2C, "size": 0xD0, "global": 0x35C0},
    {"name": "reader/base pass B", "offset": 0x2A4A, "size": 0xB8, "global": 0x35C0},
    {"name": "secondary service A", "offset": 0x2A1E, "size": 0x2C, "global": 0x35C8},
    {"name": "secondary service B", "offset": 0x29B4, "size": 0x6A, "global": 0x35C8},
]

FOCUS_OFFSETS = [0x40, 0x4C, 0x50, 0x64, 0x70, 0x74, 0x78]

TARGETS_OF_INTEREST = [
    0xD2D4,
    0xD450,
    0xDBD6,
    0xDBE6,
    0xDC1C,
    0xDC36,
    0xD5EA,
    0xDCC8,
    0xDCCA,
    0xDCD0,
    0x11094,
    0x115B8,
    0x11614,
    0x11672,
    0x11752,
]


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


def ldr_literal_pools(ins):
    if ins.mnemonic != "ldr" or len(ins.operands) < 2:
        return None
    mem = ins.operands[1]
    if mem.type != ARM_OP_MEM or mem.mem.base != ARM_REG_PC:
        return None
    disp = mem.mem.disp
    return {
        "raw": ins.address + 4 + disp,
        "aligned": ((ins.address + 4) & ~3) + disp,
    }


def ins_text(ins):
    return f"{hx(ins.address)}: {ins.bytes.hex(' ').upper():<14} {ins.mnemonic:<8} {ins.op_str}".rstrip()


def disasm(data, offset, size):
    md = Cs(CS_ARCH_ARM, CS_MODE_THUMB)
    md.detail = True
    return list(md.disasm(data[offset:offset + size], offset))


def likely_global_slots(data, ins):
    pools = ldr_literal_pools(ins)
    if not pools:
        return []
    slots = []
    for label, pool in (
        ("raw", pools["raw"]),
        ("raw+2", pools["raw"] + 2),
        ("aligned", pools["aligned"]),
        ("aligned+2", pools["aligned"] + 2),
    ):
        value = read_u16(data, pool)
        if value and 0x2000 <= value <= 0x7000:
            confidence = "high" if 0x3500 <= value <= 0x36FF else "low"
            slots.append({"kind": label, "pool": pool, "slot": value, "confidence": confidence})
    seen = set()
    out = []
    for item in slots:
        key = (item["kind"], item["slot"])
        if key in seen:
            continue
        seen.add(key)
        out.append(item)
    return out


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


def is_load_deref(ins, reg):
    if ins.mnemonic != "ldr" or len(ins.operands) < 2:
        return False
    dst, src = ins.operands[0], ins.operands[1]
    return (
        dst.type == ARM_OP_REG
        and src.type == ARM_OP_MEM
        and reg_name(ins, dst.reg) == reg
        and reg_name(ins, src.mem.base) == reg
        and src.mem.disp == 0
    )


def bl_target(ins):
    if ins.mnemonic not in {"bl", "blx"} or not ins.operands:
        return None
    op = ins.operands[0]
    if op.type == ARM_OP_IMM:
        return op.imm
    return None


def init_calls(data):
    insns = disasm(data, INIT_WINDOW_OFFSET, INIT_WINDOW_SIZE)
    calls = []
    for i, ins in enumerate(insns):
        target = bl_target(ins)
        if target is None:
            continue
        slot_info = None
        context_start = max(0, i - 5)
        for j in range(i - 1, context_start - 1, -1):
            maybe_ldr = insns[j]
            if maybe_ldr.mnemonic != "ldr" or not maybe_ldr.operands:
                continue
            dst = maybe_ldr.operands[0]
            if dst.type != ARM_OP_REG:
                continue
            reg = reg_name(maybe_ldr, dst.reg)
            if not any(is_add_sb(row, reg) for row in insns[j + 1:i]):
                continue
            if not any(is_load_deref(row, reg) for row in insns[j + 1:i]):
                continue
            slots = likely_global_slots(data, maybe_ldr)
            if slots:
                high = [item for item in slots if item["confidence"] == "high"]
                chosen = (high or slots)[0]
                slot_info = {
                    "load": maybe_ldr.address,
                    "register": reg,
                    "candidates": slots,
                    "chosen": chosen["slot"],
                    "chosenKind": chosen["kind"],
                    "confidence": chosen["confidence"],
                }
                break
        calls.append({
            "call": ins.address,
            "target": target,
            "global": slot_info,
            "context": [ins_text(row) for row in insns[max(0, i - 4):i + 1]],
        })
    return calls


def classify_head(data, target, window_starts):
    thumb = target & ~1
    rows = disasm(data, thumb, 0x20)
    text = [ins_text(row) for row in rows[:8]]
    if not rows:
        return {"kind": "invalid", "head": "-", "instructions": []}

    first = rows[0]
    local = None
    for item in window_starts:
        if item["offset"] <= thumb < item["offset"] + item["size"]:
            local = item
            break
    if local:
        kind = f"inside {local['name']} initializer"
    elif first.mnemonic in {"pop", "bx"} or first.mnemonic.startswith("add") and "sp" in first.op_str:
        kind = "epilogue/mid-function looking"
    elif any("0x3590" in row for row in text):
        kind = "wrapper using global 0x3590"
    elif any("blx" in row and "[r0, #0x74]" in " ".join(text[:3]) for row in text):
        kind = "dispatcher through object +0x74"
    elif first.mnemonic == "push":
        kind = "function prologue"
    elif first.mnemonic in {"ldr", "movs", "adds", "cmp", "bl"}:
        kind = "code-looking"
    else:
        kind = "unclear"

    joined = "\n".join(text)
    if "0x3590" in joined or "[r0, #0x14]" in joined or "[r0, #0x18]" in joined:
        if "wrapper" not in kind and "dispatcher" not in kind:
            kind += "; wrapper/callback clue"

    return {
        "kind": kind,
        "head": f"{first.mnemonic} {first.op_str}".strip(),
        "instructions": text,
    }


def row_to_dict(data, row):
    store = row["store_info"]
    candidates = []
    for cand in row["candidates"]:
        item = {
            "kind": cand["kind"],
            "pool": cand["pool"],
            "value": cand["value"],
            "target": cand["target"],
            "thumb": cand["thumb"],
            "score": cand["score"],
            "head": cand["head"],
        }
        item["class"] = classify_head(data, cand["thumb"], TABLE_WINDOWS)["kind"]
        candidates.append(item)
    return {
        "store": row["store"].address,
        "offset": store["offset"],
        "base": store["base"],
        "source": store["src"],
        "candidates": candidates,
    }


def table_reports(data):
    out = []
    wanted = set(FOCUS_OFFSETS)
    for window in TABLE_WINDOWS:
        rows = resolve_vtable_rows(data, window["offset"], window["size"], wanted)
        out.append({
            **window,
            "rows": [row_to_dict(data, row) for row in rows],
        })
    return out


def target_reports(data):
    reports = []
    for target in TARGETS_OF_INTEREST:
        reports.append({
            "target": target,
            **classify_head(data, target, TABLE_WINDOWS),
        })
    return reports


def write_report(report, out_dir):
    out_dir.mkdir(parents=True, exist_ok=True)
    json_path = out_dir / "service_layer_trace.json"
    md_path = out_dir / "service_layer_trace.md"
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    lines = [
        "# God War Service Layer Trace",
        "",
        f"Generated: {report['generated']}",
        "",
        "## Current Conclusions",
        "",
        "- The startup window initializes global `0x35C0` twice: first through `0x2B2C`, then through `0x2A4A`.",
        "- The later calls to `0x2A1E` and `0x29B4` target global `0x35C8`, so they should not be merged into the `0x35C0` reader-service vtable.",
        "- Because `0x2A4A` runs after `0x2B2C`, slot values seen in `0x2B2C` are not necessarily the final reader callbacks used by XSE parsing.",
        "- Reader/base pass B slot `+0x74` remains unresolved: the halfword-style ADD-PC candidate lands around `0xDCC8/0xDCCA`, while a big-endian word diagnostic points at dispatcher-like code around `0x11094`. Treat both as callback-layer clues, not primitive stream-reader widths.",
        "- The XSE post-group `+0x74` call seen at `0x11614` sits in a literal-pool region that also references `0x35C4` and `0x86DC`; logically it behaves like a reader/service callback, while `0x86DC` is the 0x74-byte per-script record table receiving the parsed arrays.",
        "",
        "## Init Calls",
        "",
    ]

    for call in report["initCalls"]:
        global_info = call["global"]
        if global_info:
            prefix = "global" if global_info["confidence"] == "high" else "low-confidence global-like"
            slot = f"{prefix} {hx(global_info['chosen'], 4)} via {global_info['chosenKind']}"
        else:
            slot = "no sb-global candidate"
        lines.append(f"- `{hx(call['call'])}` -> `{hx(call['target'])}` ({slot})")

    lines.extend(["", "## Focused Table Writes", ""])
    for table in report["tables"]:
        lines.append(f"### `{table['name']}` at `{hx(table['offset'])}` for global `{hx(table['global'], 4)}`")
        lines.append("")
        if not table["rows"]:
            lines.append("- no focused slot writes found")
            lines.append("")
            continue
        for row in table["rows"]:
            lines.append(f"- store `{hx(row['store'])}` -> `+0x{row['offset']:X}`")
            for cand in row["candidates"][:4]:
                lines.append(
                    f"  - `{cand['kind']}` target `{hx(cand['thumb'])}` score={cand['score']} "
                    f"class={cand['class']} head=`{cand['head']}`"
                )
        lines.append("")

    lines.extend(["## Target Heads", ""])
    for target in report["targets"]:
        lines.append(f"### `{hx(target['target'])}` {target['kind']}")
        lines.append("")
        for text in target["instructions"][:6]:
            lines.append(f"- `{text}`")
        lines.append("")

    md_path.write_text("\n".join(lines), encoding="utf-8")
    return json_path, md_path


def main():
    parser = argparse.ArgumentParser(description="Trace layered service/vtable initialization around CBE globals 0x35C0 and 0x35C8.")
    parser.add_argument("input", nargs="?", default=DEFAULT_INPUT)
    parser.add_argument("out", nargs="?", default=DEFAULT_OUT)
    args = parser.parse_args()

    data = pathlib.Path(args.input).read_bytes()
    report = {
        "schema": "nicai.cbe.serviceLayerTrace.v1",
        "input": str(pathlib.Path(args.input)),
        "generated": _dt.datetime.now(_dt.UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "initWindow": {"offset": INIT_WINDOW_OFFSET, "size": INIT_WINDOW_SIZE},
        "focusOffsets": FOCUS_OFFSETS,
        "initCalls": init_calls(data),
        "tables": table_reports(data),
        "targets": target_reports(data),
    }
    _, md_path = write_report(report, pathlib.Path(args.out))

    for call in report["initCalls"]:
        global_info = call["global"]
        slot = hx(global_info["chosen"], 4) if global_info else "?"
        conf = global_info["confidence"] if global_info else "none"
        print(f"{hx(call['call'])}: global {slot} ({conf}) -> {hx(call['target'])}")
    print(f"wrote {md_path}")


if __name__ == "__main__":
    main()
