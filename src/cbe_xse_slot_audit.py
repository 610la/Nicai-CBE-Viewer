#!/usr/bin/env python3
import datetime as _dt
import json
import pathlib
import struct
import sys

local_deps = pathlib.Path(__file__).resolve().parent / ".python_deps"
if local_deps.exists():
    sys.path.insert(0, str(local_deps))

from cbe_xse_reader_service_trace import (
    FOCUS_SLOTS,
    disasm_window,
    hx,
    ins_text,
    scan_method_writes,
)


DEFAULT_INPUT = pathlib.Path(__file__).resolve().parents[1] / "cbe file" / "众神之战.CBE"
DEFAULT_OUT = pathlib.Path(__file__).resolve().parent / "out_godwar_xseslotaudit"

FOCUS_TARGETS = {
    0x00000B56: "startup wrapper that chains a global +0x50 call into 0x292E",
    0x0000D2D4: "multi-argument graphics/service wrapper previously selected for 0x35C0+0x50",
    0x0000D44E: "mid wrapper candidate for 0x35C0+0x4C",
    0x0000D450: "mid wrapper candidate for 0x35C0+0x4C",
    0x0000D5EA: "function prologue used by a later service slot",
    0x0000DBE6: "function prologue used by 0x35C0 pass A +0x64",
    0x0000DCC8: "mid wrapper candidate for 0x35C0+0x74",
    0x0000DCD0: "function-like wrapper near 0x35C0+0x74",
    0x0000FC48: "mid-function UI/geometry code selected by a 0x10398 diagnostic",
    0x00011094: "object child dispatcher through +0x74",
    0x00020392: "mid-function UI/geometry code selected by a 0x10398 diagnostic",
    0x0002C132: "buffer object method dispatcher",
    0x0002C182: "buffer object reset/free routine",
    0x0002C234: "buffer object byte write routine",
    0x0002C26E: "buffer object byte read routine",
    0x0002C48C: "buffer object constructor",
}

CALLSITE_WINDOWS = [
    {
        "name": "XSE stream conversion",
        "start": 0x112FE,
        "end": 0x11310,
        "shape": "r0=open([sb+0x35C4]+0x40); r1=[sb+0x35C0]+0x50 function pointer; blx r1; r0 result becomes script stream r4",
        "constraint": "The concrete 0x35C0+0x50 target must be callable with only the opened resource handle in r0. r1 is the function pointer itself at call time.",
    },
    {
        "name": "XSE compact reader",
        "start": 0x11316,
        "end": 0x1131E,
        "shape": "r0=converted stream r4; r1=&cursor; r2=[sb+0x35C4]+0x50; blx r2",
        "constraint": "The concrete 0x35C4+0x50 target must update/use the cursor pointer in r1.",
    },
    {
        "name": "XSE group id reader",
        "start": 0x11426,
        "end": 0x11432,
        "shape": "r0=converted stream r4; r1=&cursor; r2=[sb+0x35C4]+0x4C; blx r2",
        "constraint": "The concrete 0x35C4+0x4C target has the same stream/cursor call shape as +0x50 but a different value grammar.",
    },
]


def parse_int(text):
    return int(str(text), 0)


def read_u16(data, offset):
    if offset < 0 or offset + 2 > len(data):
        return None
    return struct.unpack_from("<H", data, offset)[0]


def sign_extend(value, bits):
    sign = 1 << (bits - 1)
    return (value ^ sign) - sign


def thumb_bl_target(data, offset):
    if offset < 0 or offset + 4 > len(data):
        return None
    h1 = read_u16(data, offset)
    h2 = read_u16(data, offset + 2)
    if h1 is None or h2 is None:
        return None
    if (h1 & 0xF800) != 0xF000:
        return None
    if (h2 & 0xD000) != 0xD000:
        return None
    s = (h1 >> 10) & 1
    imm10 = h1 & 0x03FF
    j1 = (h2 >> 13) & 1
    j2 = (h2 >> 11) & 1
    i1 = 1 - (j1 ^ s)
    i2 = 1 - (j2 ^ s)
    imm = (s << 24) | (i1 << 23) | (i2 << 22) | (imm10 << 12) | ((h2 & 0x07FF) << 1)
    target = (offset + 4 + sign_extend(imm, 25)) & 0xFFFFFFFF
    return target & ~1


def direct_bl_refs(data, targets):
    wanted = {target & ~1 for target in targets}
    refs = {target: [] for target in sorted(wanted)}
    for off in range(0, len(data) - 4, 2):
        target = thumb_bl_target(data, off)
        if target in wanted:
            refs[target].append(off)
    return [
        {
            "target": target,
            "description": FOCUS_TARGETS.get(target, ""),
            "refs": [
                {
                    "site": site,
                    "context": [ins_text(ins) for ins in disasm_window(data, max(0, site - 6), 0x18)],
                }
                for site in sites[:16]
            ],
            "truncated": len(sites) > 16,
            "count": len(sites),
        }
        for target, sites in refs.items()
        if sites
    ]


def target_head(data, target, size=0x44):
    rows = disasm_window(data, target & ~1, size)
    return {
        "target": target & ~1,
        "description": FOCUS_TARGETS.get(target & ~1, ""),
        "instructions": [ins_text(row) for row in rows[:14]],
    }


def has_prefix(rows, expected):
    if len(rows) < len(expected):
        return False
    for row, (mnemonic, op) in zip(rows, expected):
        if row.mnemonic != mnemonic or row.op_str.replace(" ", "") != op.replace(" ", ""):
            return False
    return True


def candidate_verdict(data, target, slot):
    target &= ~1
    rows = disasm_window(data, target, 0x44)
    if not rows:
        return {
            "status": "reject",
            "reason": "target does not disassemble as Thumb code in the CBE image",
        }

    if 0x2900 <= target <= 0x2C20:
        return {
            "status": "reject",
            "reason": "target lands inside a method-table initializer, not at the final callable method",
        }

    if has_prefix(rows, [("adds", "r0, r1, #0"), ("adds", "r1, r2, #0"), ("push", "{r3, r4, r5, lr}")]):
        return {
            "status": "reject",
            "reason": "entry immediately consumes r1/r2/r3/stack args; at the XSE conversion call r1 is the function pointer, so this cannot be the one-arg stream conversion target",
        }

    if target == 0x0002C234:
        return {
            "status": "reject",
            "reason": "this byte-stream method writes r2 into an internal buffer selected by r1; it matches a buffer-object slot, not the XSE conversion slot or cursor reader",
        }

    if target == 0x0002C26E:
        return {
            "status": "clue",
            "reason": "this is a byte-stream read primitive, but no current constructor evidence links it to 0x35C0/0x35C4 in the XSE path",
        }

    if target == 0x00000B56:
        return {
            "status": "clue",
            "reason": "call-shape is one-arg compatible, but it chains through global 0x3584 and then 0x292E; this looks like startup/table setup, not a primitive stream converter",
        }

    if target in {0x0000FC48, 0x0000FC4A, 0x00020392, 0x00020394}:
        return {
            "status": "reject",
            "reason": "target is inside an already-running UI/geometry function, not a callable method entry for the XSE service",
        }

    if rows[0].mnemonic == "push":
        return {
            "status": "clue",
            "reason": "real function prologue, but slot ownership and argument semantics still need a caller-chain proof",
        }

    if rows[0].mnemonic in {"pop", "bx"} or target in {0x0000DCC8, 0x00011094}:
        return {
            "status": "reject",
            "reason": "target is a mid-function dispatch point, not a safe function entry for the XSE reader/conversion call",
        }

    return {
        "status": "unknown",
        "reason": f"code-looking target for slot +0x{slot:X}, but not yet tied to the runtime object used by 0x112C4",
    }


def focused_slot_writes(data):
    rows = scan_method_writes(data, FOCUS_SLOTS)
    focused = []
    for row in rows:
        if row["slot"] not in {0x40, 0x4C, 0x50, 0x64, 0x74}:
            continue
        candidates = []
        for cand in row["candidates"]:
            verdict = candidate_verdict(data, cand["thumb"], row["slot"])
            candidates.append({
                "candidateKind": cand["candidateKind"],
                "target": cand["target"],
                "thumb": cand["thumb"],
                "score": cand["score"],
                "targetKind": cand["targetKind"],
                "head": cand["head"],
                "verdict": verdict,
            })
        focused.append({
            "store": row["store"],
            "slot": row["slot"],
            "base": row["base"],
            "src": row["src"],
            "context": row["context"],
            "candidates": candidates,
        })
    return focused


def callsite_evidence(data):
    out = []
    for site in CALLSITE_WINDOWS:
        size = site["end"] - site["start"] + 2
        out.append({
            **site,
            "instructions": [ins_text(row) for row in disasm_window(data, site["start"], size)],
        })
    return out


def build_report(input_path):
    data = pathlib.Path(input_path).read_bytes()
    slot_writes = focused_slot_writes(data)
    plus_50 = [row for row in slot_writes if row["slot"] == 0x50]
    report = {
        "schema": "nicai.cbe.xseSlotAudit.v1",
        "input": str(pathlib.Path(input_path)),
        "generated": _dt.datetime.now(_dt.UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "callsites": callsite_evidence(data),
        "slotWriteCount": len(slot_writes),
        "plus50WriteCount": len(plus_50),
        "slotWrites": slot_writes,
        "targetHeads": [target_head(data, target) for target in FOCUS_TARGETS],
        "directBranchRefs": direct_bl_refs(data, FOCUS_TARGETS),
        "conclusion": {
            "currentBlocker": "The real XSE parser is still blocked at the service-slot boundary: 0x112C4 calls [sb+0x35C0]+0x50 as a one-argument stream conversion, then calls [sb+0x35C4]+0x50/+0x4C as stream,cursor readers.",
            "newFalsification": "The prominent 0x35C0+0x50 candidate 0xD2D4 is call-shape incompatible with the 0x1130E conversion call. The 0x2C234 byte-stream slot is a real buffer object method, but it is also incompatible with that conversion call and is not linked to 0x35C0/0x35C4 by current constructor evidence.",
            "nextTarget": "Trace the runtime object copy/overwrite that makes sb+0x35C0 and sb+0x35C4 point at their final service instances, then re-run the VM gate with the exact conversion and reader methods instead of width guesses.",
        },
    }
    return report


def md_row(values):
    return "| " + " | ".join(str(value).replace("|", "\\|") for value in values) + " |"


def render_markdown(report):
    lines = [
        "# XSE Service Slot Audit",
        "",
        f"- Input CBE: `{report['input']}`",
        f"- Generated: {report['generated']}",
        "",
        "## Current Conclusion",
        "",
        f"- {report['conclusion']['currentBlocker']}",
        f"- {report['conclusion']['newFalsification']}",
        f"- {report['conclusion']['nextTarget']}",
        "",
        "## XSE Call Shapes",
        "",
    ]
    for site in report["callsites"]:
        lines.append(f"### {site['name']}")
        lines.append("")
        lines.append(f"- Window: `{hx(site['start'])}`-`{hx(site['end'])}`")
        lines.append(f"- Shape: {site['shape']}")
        lines.append(f"- Constraint: {site['constraint']}")
        lines.append("")
        for text in site["instructions"]:
            lines.append(f"  - `{text}`")
        lines.append("")

    lines.extend([
        "## Focused +0x50 Writes",
        "",
        md_row(["Store", "Base", "Best target", "Verdict", "Reason"]),
        md_row(["---", "---", "---", "---", "---"]),
    ])
    for row in [item for item in report["slotWrites"] if item["slot"] == 0x50]:
        best = row["candidates"][0] if row["candidates"] else None
        if best:
            lines.append(md_row([
                hx(row["store"]),
                row["base"],
                hx(best["thumb"]),
                best["verdict"]["status"],
                best["verdict"]["reason"],
            ]))
        else:
            lines.append(md_row([hx(row["store"]), row["base"], "", "", "no candidates"]))

    lines.extend(["", "## Notable +0x50 Candidates", ""])
    for row in [item for item in report["slotWrites"] if item["slot"] == 0x50]:
        lines.append(f"### store `{hx(row['store'])}`")
        lines.append("")
        lines.append(md_row(["Target", "Kind", "Verdict", "Reason"]))
        lines.append(md_row(["---", "---", "---", "---"]))
        seen = set()
        for cand in row["candidates"]:
            key = cand["thumb"]
            if key in seen:
                continue
            seen.add(key)
            if len(seen) > 4:
                break
            lines.append(md_row([
                hx(cand["thumb"]),
                cand["candidateKind"],
                cand["verdict"]["status"],
                cand["verdict"]["reason"],
            ]))
        lines.append("")

    lines.extend(["", "## Selected Candidate Details", ""])
    selected = {
        0x00000B56,
        0x0000D2D4,
        0x0000FC48,
        0x00020392,
        0x0002C234,
        0x0002C26E,
        0x0002C48C,
        0x00011094,
    }
    for head in report["targetHeads"]:
        if head["target"] not in selected:
            continue
        lines.append(f"### `{hx(head['target'])}` {head['description']}")
        lines.append("")
        for text in head["instructions"][:10]:
            lines.append(f"- `{text}`")
        lines.append("")

    lines.extend(["## Direct Branch References", ""])
    for item in report["directBranchRefs"]:
        lines.append(f"- `{hx(item['target'])}` {item['description']}: {item['count']} direct BL refs")
        for ref in item["refs"][:4]:
            lines.append(f"  - site `{hx(ref['site'])}`")
        if item["truncated"]:
            lines.append("  - refs truncated in JSON")
    lines.append("")
    return "\n".join(lines)


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    input_path = pathlib.Path(argv[0] if argv else DEFAULT_INPUT)
    out_dir = pathlib.Path(argv[1] if len(argv) > 1 else DEFAULT_OUT)
    out_dir.mkdir(parents=True, exist_ok=True)
    report = build_report(input_path)
    json_path = out_dir / "xse_slot_audit.json"
    md_path = out_dir / "xse_slot_audit.md"
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    md_path.write_text(render_markdown(report), encoding="utf-8")
    print(f"wrote {json_path}")
    print(f"wrote {md_path}")


if __name__ == "__main__":
    main()
