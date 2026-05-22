#!/usr/bin/env python3
import json
import pathlib
import sys
from datetime import UTC, datetime

local_deps = pathlib.Path(__file__).resolve().parent / ".python_deps"
if local_deps.exists():
    sys.path.insert(0, str(local_deps))

from capstone import Cs, CS_ARCH_ARM, CS_MODE_THUMB


DEFAULT_INPUT = pathlib.Path(__file__).resolve().parents[1] / "cbe file" / "众神之战.CBE"
DEFAULT_OUT = pathlib.Path(__file__).resolve().parent / "out_godwar_xseentrycallers"
TARGETS = {
    0x12364: {
        "name": "dispatching label-entry helper",
        "effect": "select +0x64 entry, activate it, then dispatch 0x11C3C",
    },
    0x123E4: {
        "name": "select-only label-entry helper",
        "effect": "select +0x64 entry and activate it; caller dispatches separately",
    },
}


def hx(value, width=8):
    return f"0x{value & ((1 << (width * 4)) - 1):0{width}X}"


def md_thumb():
    md = Cs(CS_ARCH_ARM, CS_MODE_THUMB)
    md.detail = False
    return md


def disasm_one_at(md, data, offset):
    for ins in md.disasm(data[offset:offset + 8], offset, count=1):
        if ins.address == offset:
            return ins
    return None


def sparse_disasm(data, start=0, end=None):
    if end is None:
        end = len(data)
    md = md_thumb()
    for offset in range(start & ~1, min(end, len(data) - 1), 2):
        ins = disasm_one_at(md, data, offset)
        if ins:
            yield ins


def branch_target(ins):
    if ins.mnemonic not in {"bl", "blx", "b"}:
        return None
    text = ins.op_str.strip()
    if not text.startswith("#"):
        return None
    try:
        return int(text[1:], 0) & ~1
    except ValueError:
        return None


def adr_target(ins):
    if ins.mnemonic != "adr" or "," not in ins.op_str:
        return None
    left, right = [part.strip() for part in ins.op_str.split(",", 1)]
    if left != "r1" or not right.startswith("#"):
        return None
    try:
        imm = int(right[1:], 0)
    except ValueError:
        return None
    base = (ins.address + 4) & ~3
    return base + imm


def ins_text(ins):
    return f"{hx(ins.address)}: {ins.bytes.hex(' ').upper():<14} {ins.mnemonic:<7} {ins.op_str}"


def context_window(data, address, before=10, after=8):
    start = max(0, address - before * 4)
    end = min(len(data), address + after * 4 + 8)
    rows = []
    for ins in sparse_disasm(data, start, end):
        if abs(ins.address - address) > max(before, after) * 4 + 6:
            continue
        rows.append({
            "address": ins.address,
            "addressHex": hx(ins.address),
            "mnemonic": ins.mnemonic,
            "opStr": ins.op_str,
            "text": ins_text(ins),
            "mark": ins.address == address,
        })
    return rows


def read_ascii(data, start, limit=40):
    if start < 0 or start >= len(data):
        return ""
    out = []
    pos = start
    while pos < len(data) and len(out) < limit:
        value = data[pos]
        if value == 0:
            break
        if value < 0x20 or value > 0x7E:
            break
        out.append(chr(value))
        pos += 1
    return "".join(out)


def nearby_ascii_candidates(data, target):
    out = []
    for start in range(target - 6, target + 7):
        text = read_ascii(data, start)
        if len(text) < 2:
            continue
        lower = text.lower()
        if not any(key in lower for key in ("init", "_main", "main", "label")):
            continue
        end = start + len(text)
        out.append({
            "start": start,
            "startHex": hx(start),
            "targetDelta": target - start,
            "text": text,
            "containsTarget": start <= target < end,
            "distance": 0 if start <= target < end else min(abs(target - start), abs(target - end)),
        })
    out.sort(key=lambda item: (
        0 if item["text"].lower() in {"init", "_main"} else 1,
        item["distance"],
        abs(item["targetDelta"]),
        item["start"],
    ))
    return out[:8]


def classify_label(candidates):
    for item in candidates:
        lower = item["text"].lower()
        if lower == "init":
            return "Init"
        if lower == "_main":
            return "_main"
    for item in candidates:
        lower = item["text"].lower()
        if "init" in lower:
            return "Init"
        if "main" in lower:
            return "_main"
    return ""


def analyze_call(data, ins, context):
    prior = [row for row in context if row["address"] < ins.address]
    adr_rows = []
    md = md_thumb()
    for row in prior[-10:]:
        decoded = disasm_one_at(md, data, row["address"])
        target = adr_target(decoded) if decoded else None
        if target is None:
            continue
        candidates = nearby_ascii_candidates(data, target)
        adr_rows.append({
            "address": row["addressHex"],
            "instruction": row["text"],
            "target": target,
            "targetHex": hx(target),
            "nearbyAscii": candidates,
            "semanticLabel": classify_label(candidates),
        })
    selected = adr_rows[-1] if adr_rows else None
    return {
        "call": ins.address,
        "callHex": hx(ins.address),
        "target": branch_target(ins),
        "targetHex": hx(branch_target(ins)),
        "targetRole": TARGETS.get(branch_target(ins), {}).get("name", ""),
        "targetEffect": TARGETS.get(branch_target(ins), {}).get("effect", ""),
        "labelArg": selected,
        "allRecentAdrR1": adr_rows,
        "context": [row["text"] for row in context],
    }


def build_report(input_path=DEFAULT_INPUT):
    data = pathlib.Path(input_path).read_bytes()
    calls = []
    for ins in sparse_disasm(data):
        target = branch_target(ins)
        if target not in TARGETS:
            continue
        context = context_window(data, ins.address)
        calls.append(analyze_call(data, ins, context))
    labels = sorted({call["labelArg"]["semanticLabel"] for call in calls if call.get("labelArg") and call["labelArg"].get("semanticLabel")})
    dispatching = [call for call in calls if call["target"] == 0x12364]
    select_only = [call for call in calls if call["target"] == 0x123E4]
    return {
        "schema": "nicai.cbe.xseEntryCallerProbe.v1",
        "generatedAt": datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "input": str(input_path),
        "targets": {hx(k): v for k, v in TARGETS.items()},
        "summary": {
            "status": "entry-callers-anchored" if calls else "entry-callers-missing",
            "callCount": len(calls),
            "dispatchingCallCount": len(dispatching),
            "selectOnlyCallCount": len(select_only),
            "semanticLabels": labels,
            "currentFinding": (
                f"{len(calls)} direct label-entry helper call(s) were found: "
                f"{len(dispatching)} dispatch through 0x12364 and {len(select_only)} use select-only 0x123E4. "
                f"Recovered nearby label constants: {', '.join(labels) or 'none'}."
            ),
            "emulatorImpact": "The generic emulator should treat Init/_main as real caller-provided entry labels, not as guessed cursor positions.",
            "nextTarget": "Reconcile the ADR label pointers with the +0x64 string/ref compare service at 0x12326, then bind tail records whose record+0x10 compares equal to Init or _main.",
        },
        "calls": calls,
    }


def md_row(cells):
    return "| " + " | ".join(str(cell if cell is not None else "").replace("|", "\\|") for cell in cells) + " |"


def render_markdown(report):
    lines = [
        "# XSE Entry Caller Probe",
        "",
        f"- Generated: {report['generatedAt']}",
        f"- Status: {report['summary']['status']}",
        f"- Finding: {report['summary']['currentFinding']}",
        f"- Emulator impact: {report['summary']['emulatorImpact']}",
        f"- Next target: {report['summary']['nextTarget']}",
        "",
        md_row(["Call", "Target", "Role", "Label arg target", "Semantic label", "Nearby ASCII"]),
        md_row(["---", "---", "---", "---", "---", "---"]),
    ]
    for call in report["calls"]:
        label_arg = call.get("labelArg") or {}
        nearby = "; ".join(
            f"{item['startHex']}:{item['text']} delta={item['targetDelta']}"
            for item in (label_arg.get("nearbyAscii") or [])[:3]
        )
        lines.append(md_row([
            call["callHex"],
            call["targetHex"],
            call["targetRole"],
            label_arg.get("targetHex", "-"),
            label_arg.get("semanticLabel", "-"),
            nearby or "-",
        ]))
    for call in report["calls"]:
        lines.extend(["", f"## {call['callHex']} -> {call['targetHex']}"])
        label_arg = call.get("labelArg") or {}
        if label_arg:
            lines.append(f"- Label ADR: {label_arg['instruction']} -> {label_arg['targetHex']} semantic={label_arg.get('semanticLabel') or '-'}")
            for item in label_arg.get("nearbyAscii") or []:
                lines.append(f"  - {item['startHex']}: `{item['text']}` targetDelta={item['targetDelta']} containsTarget={item['containsTarget']}")
        lines.append("- Context:")
        for row in call["context"]:
            prefix = "  - "
            lines.append(prefix + ("`" + row + "`"))
    lines.append("")
    return "\n".join(lines) + "\n"


def main(argv=None):
    argv = argv or sys.argv[1:]
    input_path = pathlib.Path(argv[0]) if argv else DEFAULT_INPUT
    out_dir = pathlib.Path(argv[1]) if len(argv) > 1 else DEFAULT_OUT
    out_dir.mkdir(parents=True, exist_ok=True)
    report = build_report(input_path)
    json_file = out_dir / "xse_entry_caller_probe.json"
    md_file = out_dir / "xse_entry_caller_probe.md"
    json_file.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    md_file.write_text(render_markdown(report), encoding="utf-8")
    print(f"wrote {json_file}")
    print(f"wrote {md_file}")
    print(f"{report['summary']['status']}: {report['summary']['currentFinding']}")


if __name__ == "__main__":
    main()
