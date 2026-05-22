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
from capstone.arm_const import ARM_OP_MEM, ARM_OP_REG, ARM_REG_PC, ARM_REG_SB


DEFAULT_INPUT = pathlib.Path(__file__).resolve().parents[1] / "cbe file" / "众神之战.CBE"
DEFAULT_OUT = "out_godwar_xsereader"

FOCUS_GLOBAL = 0x35C4
FOCUS_SLOTS = [0x40, 0x48, 0x4C, 0x50, 0x5C, 0x64, 0x74, 0x78]
XSE_CALLS = [0x112C6, 0x11362, 0x1138A, 0x113AA, 0x113EA, 0x11426, 0x115B8, 0x11614, 0x11672, 0x116B6, 0x1171E, 0x11752, 0x11792]


def parse_int(text):
    return int(str(text), 0)


def hx(value, width=8):
    return f"0x{value & 0xFFFFFFFF:0{width}X}"


def read_u16(data, offset, endian="le"):
    if offset < 0 or offset + 2 > len(data):
        return None
    return struct.unpack_from("<H" if endian == "le" else ">H", data, offset)[0]


def read_i32(data, offset, endian="le"):
    if offset < 0 or offset + 4 > len(data):
        return None
    return struct.unpack_from("<i" if endian == "le" else ">i", data, offset)[0]


def reg_name(ins, reg_id):
    try:
        return ins.reg_name(reg_id)
    except Exception:
        return str(reg_id)


def thumb_pc(address):
    return (address + 4) & ~3


def ins_text(ins):
    return f"{hx(ins.address)}: {ins.bytes.hex(' ').upper():<14} {ins.mnemonic:<8} {ins.op_str}".rstrip()


def literal_pools(ins):
    if ins.mnemonic != "ldr" or len(ins.operands) < 2:
        return None
    mem = ins.operands[1]
    if mem.type != ARM_OP_MEM or mem.mem.base != ARM_REG_PC:
        return None
    disp = mem.mem.disp
    return {
        "raw": ins.address + 4 + disp,
        "aligned": thumb_pc(ins.address) + disp,
    }


def parse_store(ins):
    if not ins.mnemonic.startswith("str") or len(ins.operands) < 2:
        return None
    src, dst = ins.operands[0], ins.operands[1]
    if src.type != ARM_OP_REG or dst.type != ARM_OP_MEM:
        return None
    return {
        "src": reg_name(ins, src.reg),
        "base": reg_name(ins, dst.mem.base),
        "offset": dst.mem.disp,
        "text": ins_text(ins),
    }


def is_add_pc(ins, reg):
    if ins.mnemonic != "add" or len(ins.operands) < 2:
        return False
    left, right = ins.operands[0], ins.operands[1]
    return (
        left.type == ARM_OP_REG
        and right.type == ARM_OP_REG
        and reg_name(ins, left.reg) == reg
        and right.reg == ARM_REG_PC
    )


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


def disasm_one(md, data, offset):
    if offset < 0 or offset >= len(data):
        return None
    for ins in md.disasm(data[offset:offset + 8], offset, count=1):
        if ins.address == offset:
            return ins
    return None


def disasm_window(data, offset, size=0x40):
    md = Cs(CS_ARCH_ARM, CS_MODE_THUMB)
    md.detail = True
    return list(md.disasm(data[offset:offset + size], offset))


def classify_target(data, target):
    thumb = target & ~1
    rows = disasm_window(data, thumb, 0x34)
    text = [ins_text(row) for row in rows[:10]]
    if not rows:
        return {"kind": "invalid", "head": "-", "instructions": []}

    joined = "\n".join(text)
    first = rows[0]
    if "0x3590" in joined or "0x2444" in joined or "[r0, #0x14]" in joined or "[r0, #0x18]" in joined:
        kind = "callback/graphics-looking"
    elif "ldrb" in joined and ("[r0" in joined or "[r3" in joined) and ("[r1]" in joined or "[r1," in joined):
        kind = "stream-reader-looking"
    elif first.mnemonic == "push":
        kind = "function-prologue"
    elif first.mnemonic in {"ldr", "adds", "movs", "cmp", "bl", "blx"}:
        kind = "code-looking"
    elif first.mnemonic in {"pop", "bx"}:
        kind = "epilogue/mid-function"
    else:
        kind = "unclear"

    return {
        "kind": kind,
        "head": f"{first.mnemonic} {first.op_str}".strip(),
        "instructions": text,
    }


def target_candidates(data, add_ins, pools):
    out = []
    cbe_base = add_ins.address + 4
    thumb_base = thumb_pc(add_ins.address)
    for label, pool in (
        ("halfLE(raw)", pools["raw"]),
        ("halfLE(raw+2)", pools["raw"] + 2),
        ("halfLE(aligned)", pools["aligned"]),
        ("halfLE(aligned+2)", pools["aligned"] + 2),
    ):
        value = read_u16(data, pool)
        if value is None:
            continue
        for base_label, base in (("cbe+4", cbe_base), ("thumb-pc", thumb_base)):
            target = (base + value) & 0xFFFFFFFF
            cls = classify_target(data, target)
            score = 0
            if cls["kind"] == "stream-reader-looking":
                score += 5
            if cls["kind"] == "function-prologue":
                score += 4
            if cls["kind"] == "code-looking":
                score += 2
            if cls["kind"] == "callback/graphics-looking":
                score -= 2
            if cls["kind"] in {"invalid", "epilogue/mid-function"}:
                score -= 3
            out.append({
                "candidateKind": f"{label}/{base_label}",
                "pool": pool,
                "value": value,
                "target": target,
                "thumb": target & ~1,
                "score": score,
                "targetKind": cls["kind"],
                "head": cls["head"],
                "instructions": cls["instructions"],
            })
    for label, pool, endian, base in (
        ("rawLE", pools["raw"], "le", cbe_base),
        ("rawBE", pools["raw"], "be", cbe_base),
        ("alignedLE", pools["aligned"], "le", thumb_base),
        ("alignedBE", pools["aligned"], "be", thumb_base),
    ):
        value = read_i32(data, pool, endian)
        if value is None:
            continue
        target = (base + value) & 0xFFFFFFFF
        cls = classify_target(data, target)
        score = 0
        if cls["kind"] == "stream-reader-looking":
            score += 4
        if cls["kind"] == "function-prologue":
            score += 3
        if cls["kind"] == "code-looking":
            score += 1
        if cls["kind"] in {"invalid", "epilogue/mid-function"}:
            score -= 3
        out.append({
            "candidateKind": label,
            "pool": pool,
            "value": value,
            "target": target,
            "thumb": target & ~1,
            "score": score,
            "targetKind": cls["kind"],
            "head": cls["head"],
            "instructions": cls["instructions"],
        })
    out.sort(key=lambda item: (-item["score"], item["thumb"]))
    return out


def scan_method_writes(data, wanted_slots):
    md = Cs(CS_ARCH_ARM, CS_MODE_THUMB)
    md.detail = True
    rows = []
    wanted = set(wanted_slots)
    for off in range(0, len(data) - 16, 2):
        insns = list(md.disasm(data[off:off + 0x28], off))
        if not insns or insns[0].address != off:
            continue
        ins = insns[0]
        pools = literal_pools(ins)
        if not pools or not ins.operands or ins.operands[0].type != ARM_OP_REG:
            continue
        reg = reg_name(ins, ins.operands[0].reg)
        add_idx = None
        for idx, future in enumerate(insns[1:7], 1):
            if is_add_pc(future, reg):
                add_idx = idx
                break
        if add_idx is None:
            continue
        store_idx = None
        store = None
        for idx in range(add_idx + 1, min(len(insns), add_idx + 7)):
            candidate = parse_store(insns[idx])
            if candidate and candidate["src"] == reg and candidate["offset"] in wanted:
                store_idx = idx
                store = candidate
                break
        if store_idx is None:
            continue
        rows.append({
            "ldr": ins.address,
            "add": insns[add_idx].address,
            "store": insns[store_idx].address,
            "slot": store["offset"],
            "base": store["base"],
            "src": store["src"],
            "context": [ins_text(row) for row in insns[:min(len(insns), store_idx + 3)]],
            "candidates": target_candidates(data, insns[add_idx], pools)[:8],
        })
    deduped = {}
    for row in rows:
        key = (row["store"], row["slot"])
        best_score = row["candidates"][0]["score"] if row["candidates"] else -999
        old = deduped.get(key)
        old_score = old["candidates"][0]["score"] if old and old["candidates"] else -999
        if old is None or best_score > old_score:
            deduped[key] = row
    return sorted(deduped.values(), key=lambda row: row["store"])


def cluster_writes(rows):
    rows = sorted(rows, key=lambda row: row["store"])
    clusters = []
    current = None
    for row in rows:
        if current is None or row["store"] - current["lastStore"] > 0x30:
            if current:
                clusters.append(current)
            current = {"start": row["ldr"], "end": row["store"], "lastStore": row["store"], "rows": []}
        current["rows"].append(row)
        current["end"] = max(current["end"], row["store"])
        current["lastStore"] = row["store"]
    if current:
        clusters.append(current)

    out = []
    for cluster in clusters:
        slots = sorted({row["slot"] for row in cluster["rows"]})
        slot_rows = {}
        for row in cluster["rows"]:
            slot_rows.setdefault(row["slot"], row)
        score = len(slots) * 4
        if 0x4C in slots and 0x50 in slots:
            score += 8
        if 0x64 in slots:
            score += 3
        if 0x74 in slots:
            score += 2
        if 0x78 in slots:
            score += 2
        best_kinds = []
        for row in cluster["rows"]:
            if row["candidates"]:
                best_kinds.append(row["candidates"][0]["candidateKind"] + ":" + row["candidates"][0]["targetKind"])
                score += row["candidates"][0]["score"]
        out.append({
            "start": cluster["start"],
            "end": cluster["end"],
            "slots": slots,
            "score": score,
            "slotRows": slot_rows,
            "rows": cluster["rows"],
        })
    out.sort(key=lambda item: (-item["score"], item["start"]))
    return out


def global_call_sites(data, target_global):
    md = Cs(CS_ARCH_ARM, CS_MODE_THUMB)
    md.detail = True
    out = []
    for site in XSE_CALLS:
        rows = disasm_window(data, site, 0x20)
        if not rows:
            continue
        first = rows[0]
        pools = literal_pools(first)
        global_hit = False
        pool_hits = []
        if pools and first.operands and first.operands[0].type == ARM_OP_REG:
            reg = reg_name(first, first.operands[0].reg)
            for label, pool in (
                ("halfLE(raw-2)", pools["raw"] - 2),
                ("halfLE(raw)", pools["raw"]),
                ("halfLE(raw+2)", pools["raw"] + 2),
                ("halfLE(aligned-2)", pools["aligned"] - 2),
                ("halfLE(aligned)", pools["aligned"]),
                ("halfLE(aligned+2)", pools["aligned"] + 2),
            ):
                value = read_u16(data, pool)
                if value == target_global:
                    pool_hits.append({"kind": label, "pool": pool, "value": value})
            global_hit = bool(pool_hits) and any(is_add_sb(row, reg) for row in rows[1:6])
        slot = None
        for row in rows[:8]:
            if row.mnemonic == "ldr" and len(row.operands) >= 2 and row.operands[1].type == ARM_OP_MEM:
                disp = row.operands[1].mem.disp
                if disp in FOCUS_SLOTS:
                    slot = disp
                    break
        out.append({
            "site": site,
            "globalHit": global_hit,
            "poolHits": pool_hits,
            "slot": slot,
            "instructions": [ins_text(row) for row in rows[:10]],
        })
    return out


def render_markdown(report):
    lines = [
        "# God War XSE Reader Service Trace",
        "",
        f"Generated: {report['generated']}",
        "",
        "## Current Conclusions",
        "",
        "- The focused XSE parser call sites load the reader/service object through `sb+0x35C4`, not the earlier `0x35C0` startup-service trace.",
        "- In-code method-table scans find several table-like initializers, but the focused `0x35C4` object is still not tied to a single constructor in the CBE image.",
        "- `+0x50` remains the proven compact-number reader shape for the 0x112C4 header, but `out_godwar_xsevmgate` shows that widening only `+0x4C` is not enough to recover a layout-aligned opcode stream.",
        "- The emulator should keep XSE execution behind the strict opcode gate until the exact stream-preparation chain (`+0x40` open plus the base-pointer conversion before `+0x50`) is reconstructed from constructor evidence.",
        "",
        "## XSE Call Sites",
        "",
    ]
    for site in report["xseCallSites"]:
        slot = f"+0x{site['slot']:X}" if site["slot"] is not None else "unknown"
        hit = "yes" if site["globalHit"] else "no"
        lines.append(f"- `{hx(site['site'])}` global35C4={hit} slot={slot}")
    lines.extend(["", "## Top Method-Table Clusters", ""])
    for cluster in report["topClusters"]:
        slot_text = ", ".join(f"+0x{slot:X}" for slot in cluster["slots"])
        lines.append(f"### `{hx(cluster['start'])}`-`{hx(cluster['end'])}` score={cluster['score']}")
        lines.append("")
        lines.append(f"- Slots: {slot_text}")
        for row in cluster["rows"][:10]:
            best = row["candidates"][0] if row["candidates"] else None
            if best:
                lines.append(
                    f"- store `{hx(row['store'])}` -> `+0x{row['slot']:X}` best `{hx(best['thumb'])}` "
                    f"{best['candidateKind']} target={best['targetKind']} head=`{best['head']}`"
                )
            else:
                lines.append(f"- store `{hx(row['store'])}` -> `+0x{row['slot']:X}` no candidate")
        lines.append("")
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Trace reader-service slots used by the 0x112C4 XSE parser.")
    parser.add_argument("input", nargs="?", default=DEFAULT_INPUT)
    parser.add_argument("out", nargs="?", default=DEFAULT_OUT)
    parser.add_argument("--clusters", default="12")
    args = parser.parse_args()

    data = pathlib.Path(args.input).read_bytes()
    rows = scan_method_writes(data, FOCUS_SLOTS)
    clusters = cluster_writes(rows)
    limit = parse_int(args.clusters)
    report = {
        "schema": "nicai.cbe.xseReaderServiceTrace.v1",
        "input": str(pathlib.Path(args.input)),
        "generated": _dt.datetime.now(_dt.UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "focusGlobal": FOCUS_GLOBAL,
        "focusSlots": FOCUS_SLOTS,
        "methodWriteCount": len(rows),
        "clusterCount": len(clusters),
        "xseCallSites": global_call_sites(data, FOCUS_GLOBAL),
        "topClusters": [
            {
                "start": item["start"],
                "end": item["end"],
                "slots": item["slots"],
                "score": item["score"],
                "rows": item["rows"],
            }
            for item in clusters[:limit]
        ],
    }

    out_dir = pathlib.Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    json_path = out_dir / "xse_reader_service_trace.json"
    md_path = out_dir / "xse_reader_service_trace.md"
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    md_path.write_text(render_markdown(report), encoding="utf-8")
    print(f"wrote {json_path}")
    print(f"wrote {md_path}")


if __name__ == "__main__":
    main()
