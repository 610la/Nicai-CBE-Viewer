#!/usr/bin/env python3
import json
import pathlib
import re
import sys
from datetime import datetime

local_deps = pathlib.Path(__file__).resolve().parent / ".python_deps"
if local_deps.exists():
    sys.path.insert(0, str(local_deps))

from capstone import Cs, CS_ARCH_ARM, CS_MODE_ARM, CS_MODE_THUMB  # noqa: E402


ROOT = pathlib.Path(__file__).resolve().parent
DEFAULT_INPUTS = [
    pathlib.Path(__file__).resolve().parents[1] / "cbe file" / "众神之战.CBE",
    pathlib.Path(__file__).resolve().parents[1] / "cbe file" / "众神之战.CBE",
]
DEFAULT_OUT = ROOT / "out_godwar_copyhelper"

HELPERS = {
    0x34540: "copy-helper-a",
    0x3453C: "copy-helper-b",
}

WRITEBACK_SITE = {
    "address": 0x11FD2,
    "resolverCall": 0x11FD4,
    "copyCall": 0x11FDC,
    "resolver": 0x11AE6,
    "copyHelper": 0x34540,
}


def pick_input(arg=None):
    if arg:
        return pathlib.Path(arg)
    for item in DEFAULT_INPUTS:
        if item.exists():
            return item
    return DEFAULT_INPUTS[0]


def hx(value, width=6):
    return f"0x{value:0{width}X}"


def md_thumb():
    return Cs(CS_ARCH_ARM, CS_MODE_THUMB)


def md_arm():
    return Cs(CS_ARCH_ARM, CS_MODE_ARM)


def ins_text(ins):
    return f"{hx(ins.address, 8)}  {ins.mnemonic:<7} {ins.op_str}".rstrip()


def parse_target(ins):
    if ins.mnemonic not in {"bl", "blx"}:
        return None
    text = ins.op_str.strip()
    if not text.startswith("#"):
        return None
    try:
        return int(text[1:], 0)
    except ValueError:
        return None


def disasm_thumb_window(data, start, size):
    return list(md_thumb().disasm(data[start:start + size], start))


def disasm_one_thumb(data, offset):
    items = list(md_thumb().disasm(data[offset:offset + 4], offset, count=1))
    return items[0] if items else None


def find_copy_calls(data):
    hits = []
    limit = min(len(data) - 4, 0x38000)
    for offset in range(0, limit, 2):
        ins = disasm_one_thumb(data, offset)
        if not ins:
            continue
        target = parse_target(ins)
        if target not in HELPERS:
            continue
        window_start = max(0, offset - 0x28)
        context = [
            item for item in disasm_thumb_window(data, window_start, 0x34)
            if offset - 0x20 <= item.address <= offset + 4
        ]
        length_hint = None
        for prev in reversed([item for item in context if item.address < offset]):
            if re.match(r"r2,\s*#0x[0-9a-f]+$", prev.op_str, re.I) and prev.mnemonic in {"movs", "mov"}:
                length_hint = prev.op_str.split("#", 1)[1]
                break
            if re.match(r"r2,\s*#\d+$", prev.op_str, re.I) and prev.mnemonic in {"movs", "mov"}:
                length_hint = prev.op_str.split("#", 1)[1]
                break
        hits.append({
            "address": hx(offset, 8),
            "target": hx(target, 6),
            "helper": HELPERS[target],
            "instruction": ins_text(ins),
            "lengthHint": length_hint,
            "context": [ins_text(item) for item in context],
        })
    return hits


def swap16_words(blob):
    out = bytearray()
    for index in range(0, len(blob), 4):
        word = blob[index:index + 4]
        if len(word) < 4:
            break
        out.extend(word[2:4] + word[0:2])
    return bytes(out)


def helper_decode(data, target):
    raw = data[target:target + 0x90]
    swapped = swap16_words(raw)
    arm_items = list(md_arm().disasm(swapped, target))[:32]
    thumb_items = list(md_thumb().disasm(data[target:target + 0x90], target))[:32]
    first_store = None
    first_null_check = None
    for ins in arm_items:
        op = ins.op_str.replace(" ", "").lower()
        if first_null_check is None and ins.mnemonic in {"cmp", "cbz", "cbnz", "tst"} and ("r0,#0" in op or op.startswith("r0,")):
            first_null_check = ins
        if first_store is None and (
            (ins.mnemonic.startswith("stm") and op.startswith("r0")) or
            (ins.mnemonic.startswith("str") and "[r0" in op)
        ):
            first_store = ins
            break
    return {
        "target": hx(target, 6),
        "helper": HELPERS[target],
        "rawFirstBytes": " ".join(f"{byte:02X}" for byte in raw[:32]),
        "diagnosticDecode": "arm-swap16-le",
        "decodeCaveat": "The helper island is not clean Thumb and raw ARM decoding is noisy; the halfword-swapped ARM view is a diagnostic used to classify copy-like memory access, not a finished decompilation.",
        "sampleArmSwap16": [ins_text(item) for item in arm_items],
        "sampleThumbRaw": [ins_text(item) for item in thumb_items[:12]],
        "firstStoreThroughR0": ins_text(first_store) if first_store else "",
        "firstNullCheckBeforeStore": ins_text(first_null_check) if first_null_check and first_store and first_null_check.address < first_store.address else "",
        "copyLike": bool(first_store),
        "nullSafeProven": bool(first_null_check and first_store and first_null_check.address < first_store.address),
    }


def writeback_context(data):
    insns = disasm_thumb_window(data, WRITEBACK_SITE["address"], 0x18)
    between = [
        ins for ins in insns
        if WRITEBACK_SITE["resolverCall"] < ins.address < WRITEBACK_SITE["copyCall"]
    ]
    guards = [
        ins for ins in between
        if ins.mnemonic in {"cmp", "cbz", "cbnz", "tst"} and "r0" in ins.op_str.replace(" ", "").lower()
    ]
    return {
        "site": hx(WRITEBACK_SITE["address"], 6),
        "resolver": hx(WRITEBACK_SITE["resolver"], 6),
        "copyHelper": hx(WRITEBACK_SITE["copyHelper"], 6),
        "instructions": [ins_text(item) for item in insns],
        "guardsBetweenResolverAndCopy": [ins_text(item) for item in guards],
        "localNullGuard": bool(guards),
    }


def build_report(input_path):
    data = input_path.read_bytes()
    calls = find_copy_calls(data)
    helper_reports = [helper_decode(data, target) for target in sorted(HELPERS)]
    writeback = writeback_context(data)
    calls_by_target = {}
    for call in calls:
        calls_by_target.setdefault(call["target"], 0)
        calls_by_target[call["target"]] += 1
    writeback_call = next((call for call in calls if call["address"] == hx(WRITEBACK_SITE["copyCall"], 8)), None)
    copy_like = any(item["copyLike"] for item in helper_reports if item["target"] == hx(WRITEBACK_SITE["copyHelper"], 6))
    helper_null_safe = any(item["nullSafeProven"] for item in helper_reports if item["target"] == hx(WRITEBACK_SITE["copyHelper"], 6))
    status = "copy-helper-null-safe-proven" if writeback["localNullGuard"] or helper_null_safe else "copy-helper-null-safe-unproven"
    return {
        "schema": "nicai.cbe.copyHelperProbe.v1",
        "input": str(input_path),
        "generatedAt": datetime.now().isoformat(timespec="seconds"),
        "summary": {
            "status": status,
            "copyCallCount": len(calls),
            "callsByTarget": calls_by_target,
            "writebackCopyCall": hx(WRITEBACK_SITE["copyCall"], 8),
            "writebackLocalNullGuard": writeback["localNullGuard"],
            "copyLikeHelperEvidence": copy_like,
            "helperNullSafeProven": helper_null_safe,
            "currentFinding": (
                "The 0x11FD2 writeback path calls 0x11AE6 and then 0x34540 without a local null guard; "
                "the helper island has copy-like r0-destination/r1-source evidence, but no proven destination-null guard. "
                "Unresolved writebacks must therefore remain effect-blocking."
            ),
            "emulatorImpact": (
                "The web emulator should treat null writeback targets as unsafe until the helper island is fully decoded or the live reader/cursor path is corrected."
            ),
            "nextTarget": (
                "Prioritize live reader/cursor binding and script-slot reuse; helper null-safety is not currently proven enough to enable visible XSE side effects."
            ),
        },
        "writebackSite": writeback,
        "helpers": helper_reports,
        "calls": calls,
        "writebackCall": writeback_call,
    }


def md_row(cells):
    return "| " + " | ".join(str(cell).replace("|", "\\|") for cell in cells) + " |"


def render_markdown(report):
    lines = [
        "# Copy Helper Probe",
        "",
        f"- Input CBE: `{report['input']}`",
        f"- Generated: {report['generatedAt']}",
        "",
        "## Summary",
        "",
        f"- Status: {report['summary']['status']}",
        f"- Finding: {report['summary']['currentFinding']}",
        f"- Emulator impact: {report['summary']['emulatorImpact']}",
        f"- Next target: {report['summary']['nextTarget']}",
        "",
        "## Writeback Site",
        "",
        f"- Site: {report['writebackSite']['site']}",
        f"- Resolver: {report['writebackSite']['resolver']}",
        f"- Copy helper: {report['writebackSite']['copyHelper']}",
        f"- Local null guard before copy: {'yes' if report['writebackSite']['localNullGuard'] else 'no'}",
        "",
    ]
    for item in report["writebackSite"]["instructions"]:
        lines.append(f"- `{item}`")
    lines.extend(["", "## Helpers", ""])
    for helper in report["helpers"]:
        lines.append(f"### {helper['target']} {helper['helper']}")
        lines.append(f"- Diagnostic decode: {helper['diagnosticDecode']}")
        lines.append(f"- Caveat: {helper['decodeCaveat']}")
        lines.append(f"- Copy-like memory access: {'yes' if helper['copyLike'] else 'no'}")
        lines.append(f"- Null-safe proven: {'yes' if helper['nullSafeProven'] else 'no'}")
        if helper["firstStoreThroughR0"]:
            lines.append(f"- First diagnostic store through r0: `{helper['firstStoreThroughR0']}`")
        lines.append("- Sample:")
        for ins in helper["sampleArmSwap16"][:12]:
            lines.append(f"  - `{ins}`")
        lines.append("")
    lines.extend(["## Call Sites", ""])
    lines.append(md_row(["Target", "Count"]))
    lines.append(md_row(["---", "---:"]))
    for target, count in sorted(report["summary"]["callsByTarget"].items()):
        lines.append(md_row([target, count]))
    lines.append("")
    lines.append(md_row(["Address", "Target", "Length hint", "Instruction"]))
    lines.append(md_row(["---", "---", "---", "---"]))
    for call in report["calls"]:
        lines.append(md_row([call["address"], call["target"], call["lengthHint"] or "-", f"`{call['instruction']}`"]))
    lines.append("")
    return "\n".join(lines) + "\n"


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    input_path = pick_input(argv[0] if argv else None)
    out_dir = pathlib.Path(argv[1]) if len(argv) > 1 else DEFAULT_OUT
    out_dir.mkdir(parents=True, exist_ok=True)
    report = build_report(input_path)
    json_file = out_dir / "copy_helper_probe.json"
    md_file = out_dir / "copy_helper_probe.md"
    json_file.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    md_file.write_text(render_markdown(report), encoding="utf-8")
    print(f"wrote {json_file}")
    print(f"wrote {md_file}")
    print(f"{report['summary']['status']}: {report['summary']['currentFinding']}")


if __name__ == "__main__":
    main()
