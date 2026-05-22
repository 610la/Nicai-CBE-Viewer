#!/usr/bin/env python3
import argparse
import json
import pathlib
import re
import sys

local_deps = pathlib.Path(__file__).resolve().parent / ".python_deps"
if local_deps.exists():
    sys.path.insert(0, str(local_deps))

from capstone import Cs, CS_ARCH_ARM, CS_MODE_THUMB


DEFAULT_INPUT = pathlib.Path(__file__).resolve().parents[1] / "cbe file" / "众神之战.CBE"
DEFAULT_SYMBOLS = pathlib.Path(__file__).resolve().parent / "out_godwar_symbols_current" / "cbe_symbols.json"
DEFAULT_OUT = pathlib.Path(__file__).resolve().parent / "out_godwar_scripthandlers"

FOCUS_COMMANDS = {
    "SHOWDIALOG",
    "LOADLIGHTGOD",
    "LOADDARKGOD",
    "SETROLEPOS",
    "GETGAMESTATE",
    "CANSAY",
    "OPENCR",
    "LOADCR",
    "CHANGESCENE",
    "CLOSESCRIPT",
}


def parse_int(text):
    return int(str(text), 0)


def hx(value, width=8):
    return f"0x{value & 0xFFFFFFFF:0{width}X}"


def load_json(path):
    return json.loads(pathlib.Path(path).read_text(encoding="utf8"))


def clean_target(text):
    return parse_int(text) & ~1


def command_offset(command):
    return parse_int(command["offset"])


def parse_imm_from_op(op_str):
    match = re.search(r"#(0x[0-9a-fA-F]+|\d+)", op_str)
    if not match:
        return None
    return parse_int(match.group(1))


def read_c_string(data, offset, limit=48):
    if offset < 0 or offset >= len(data):
        return ""
    end = offset
    while end < len(data) and end - offset < limit and 0x20 <= data[end] <= 0x7E:
        end += 1
    return data[offset:end].decode("ascii", errors="replace")


def md_thumb(detail=False):
    md = Cs(CS_ARCH_ARM, CS_MODE_THUMB)
    md.detail = detail
    return md


def disasm_one(md, data, offset):
    if offset < 0 or offset >= len(data):
        return None
    for ins in md.disasm(data[offset:offset + 8], offset, count=1):
        if ins.address == offset:
            return ins
    return None


def disasm_linear(data, start, size, detail=False):
    md = md_thumb(detail)
    return list(md.disasm(data[start:start + size], start))


def is_push_lr(ins):
    return ins is not None and ins.mnemonic == "push" and "lr" in ins.op_str


def is_return(ins):
    if ins is None:
        return False
    return (ins.mnemonic == "pop" and "pc" in ins.op_str) or (
        ins.mnemonic == "bx" and ins.op_str.strip() == "lr"
    )


def ins_text(ins):
    if not ins:
        return "-"
    raw = ins.bytes.hex(" ").upper()
    text = f"{ins.mnemonic} {ins.op_str}".strip()
    return f"{hx(ins.address)}: {raw:<13} {text}"


def find_registration_sites(data, commands):
    by_offset = {command_offset(command): command for command in commands}
    min_off = max(0, min(command_offset(command) for command in commands) - 0x900)
    max_off = min(len(data), max(command_offset(command) for command in commands) + 0x280)
    md = md_thumb()
    sites = {}

    def prev_matching(address, predicate, limit=0x30):
        start = max(0, address - limit)
        for off in range(address - 2, start - 1, -2):
            prev = disasm_one(md, data, off)
            if prev and predicate(prev):
                return prev
        return None

    for off in range(min_off & ~1, max_off, 2):
        ins = disasm_one(md, data, off)
        if not ins:
            continue
        if ins.mnemonic != "adr" or not ins.op_str.startswith("r1,"):
            continue
        imm = parse_imm_from_op(ins.op_str)
        if imm is None:
            continue

        # The command registration code in this binary lines up command names
        # with a compact PC base of instruction_address + 2.
        candidates = {
            "pc+2": ins.address + 2 + imm,
            "pc+4": ins.address + 4 + imm,
            "thumb-aligned": ((ins.address + 4) & ~3) + imm,
        }
        name_kind = None
        command = None
        for kind, address in candidates.items():
            if address in by_offset:
                name_kind = kind
                command = by_offset[address]
                break
        if not command:
            continue

        add_ins = prev_matching(
            ins.address,
            lambda item: item.mnemonic == "add" and item.op_str.replace(" ", "") == "r2,pc",
        )
        ldr_ins = None
        if add_ins:
            ldr_ins = prev_matching(
                add_ins.address,
                lambda item: item.mnemonic == "ldr" and item.op_str.startswith("r2, [pc"),
            )

        pool_kind = None
        pool_candidates = {}
        if ldr_ins:
            disp = parse_imm_from_op(ldr_ins.op_str) or 0
            pool_candidates = {
                "pc+2": ldr_ins.address + 2 + disp,
                "pc+4": ldr_ins.address + 4 + disp,
                "thumb-aligned": ((ldr_ins.address + 4) & ~3) + disp,
            }
            pointer = parse_int(command["pointerOffset"])
            for kind, address in pool_candidates.items():
                if address == pointer:
                    pool_kind = kind
                    break

        relative = int(command["relative"])
        registered_raw = None
        registered_kind = None
        if add_ins:
            base_candidates = {
                "add-pc+2": add_ins.address + 2,
                "add-pc+4": add_ins.address + 4,
                "add-thumb-aligned": ((add_ins.address + 4) & ~3),
            }
            # The observed direct prologue hits use add instruction address + 4.
            registered_kind = "add-pc+4"
            registered_raw = base_candidates[registered_kind] + relative
        sites[command["name"]] = {
            "registerAt": hx(ins.address),
            "namePcKind": name_kind,
            "addAt": None if not add_ins else hx(add_ins.address),
            "ldrAt": None if not ldr_ins else hx(ldr_ins.address),
            "poolKind": pool_kind,
            "poolCandidates": {key: hx(value) for key, value in pool_candidates.items()},
            "registeredTargetKind": registered_kind,
            "registeredTargetRaw": None if registered_raw is None else hx(registered_raw),
            "registeredTarget": None if registered_raw is None else hx(registered_raw & ~1),
        }
    return sites


def short_head(data, offset):
    ins = disasm_one(md_thumb(), data, offset)
    if not ins:
        return "-"
    return f"{ins.mnemonic} {ins.op_str}".strip()


def find_block_start(data, target, lookback=0x180):
    md = md_thumb()
    start = max(0, (target - lookback) & ~1)
    best = None
    for off in range(start, target + 2, 2):
        ins = disasm_one(md, data, off)
        if is_push_lr(ins):
            best = off
    return best if best is not None else target


def find_block_end(data, block_start, target, max_size=0x360):
    insns = disasm_linear(data, block_start, min(max_size, len(data) - block_start))
    saw_target = False
    for ins in insns:
        if ins.address >= target:
            saw_target = True
        if saw_target and is_return(ins):
            return ins.address + len(ins.bytes)
    return min(len(data), block_start + max_size)


def previous_window(insns, index, count=10):
    return insns[max(0, index - count):index]


def last_mov_r1_imm(insns, index):
    for prev in reversed(previous_window(insns, index, 8)):
        m = re.fullmatch(r"r1,#(.+)", prev.op_str.replace(" ", ""))
        if prev.mnemonic in {"movs", "mov"} and m:
            try:
                return parse_int(m.group(1))
            except ValueError:
                return None
    return None


def last_loader_for_blx(insns, index, reg):
    # Finds a nearby "ldr reg, [rX, #offset]" used just before "blx reg".
    pattern = re.compile(rf"^{re.escape(reg)}, \[r[0-9]+(?:, #(0x[0-9a-fA-F]+|\d+))?\]$")
    for prev in reversed(previous_window(insns, index, 8)):
        if prev.mnemonic != "ldr":
            continue
        match = pattern.match(prev.op_str)
        if not match:
            continue
        disp = match.group(1)
        return 0 if disp is None else parse_int(disp)
    return None


def extract_vm_calls(insns):
    calls = []
    for i, ins in enumerate(insns):
        if ins.mnemonic != "blx":
            continue
        reg = ins.op_str.strip()
        if not re.fullmatch(r"r\d+", reg):
            continue
        slot = last_loader_for_blx(insns, i, reg)
        arg_index = last_mov_r1_imm(insns, i)
        if slot is None and arg_index is None:
            continue
        if slot == 0x08:
            kind = "read-number"
        elif slot == 0x10:
            kind = "read-ref/string"
        elif slot == 0x38:
            kind = "vm-advance"
        elif slot == 0x3C:
            kind = "vm-branch/result"
        else:
            kind = f"vm-slot-{hx(slot, 2)}" if slot is not None else "vm-call"
        calls.append({
            "address": hx(ins.address),
            "kind": kind,
            "slot": None if slot is None else hx(slot, 2),
            "argIndex": arg_index,
            "text": f"{ins.mnemonic} {ins.op_str}",
        })
    return calls


def compact_calls(calls):
    parts = []
    for call in calls:
        if call["argIndex"] is None:
            parts.append(f"{call['kind']}@{call['address']}")
        else:
            parts.append(f"{call['kind']}[{call['argIndex']}]@{call['address']}")
    return ", ".join(parts) if parts else "-"


def format_window(data, start, end, marks):
    insns = disasm_linear(data, start, max(0, end - start))
    lines = []
    for ins in insns:
        prefix = marks.get(ins.address, " ")
        lines.append(f"{prefix} {ins_text(ins)}")
    return lines


def analyze_command(data, command, registration):
    symbol_target_raw = parse_int(command["handlerOffset"])
    target_raw = parse_int(registration["registeredTargetRaw"]) if registration and registration.get("registeredTargetRaw") else symbol_target_raw
    target = target_raw & ~1
    block_start = find_block_start(data, target)
    block_end = find_block_end(data, block_start, target)
    detail_start = max(0, min(block_start, target) - 0x10)
    detail_end = min(len(data), block_end + 0x10)
    insns_from_target = disasm_linear(data, target, max(0, block_end - target), detail=False)
    insns_from_block = disasm_linear(data, block_start, max(0, block_end - block_start), detail=False)
    target_head = short_head(data, target)
    block_head = short_head(data, block_start)
    entry_kind = "direct-prologue" if block_start == target and is_push_lr(disasm_one(md_thumb(), data, target)) else (
        "inside-block" if block_start != target else "direct-label"
    )
    return {
        "name": command["name"],
        "stringOffset": command["offset"],
        "pointerOffset": command["pointerOffset"],
        "relative": command["relative"],
        "symbolTargetRaw": hx(symbol_target_raw),
        "symbolTarget": hx(symbol_target_raw & ~1),
        "registration": registration,
        "targetRaw": hx(target_raw),
        "target": hx(target),
        "targetHead": target_head,
        "blockStart": hx(block_start),
        "blockHead": block_head,
        "blockEnd": hx(block_end),
        "distanceFromBlock": target - block_start,
        "entryKind": entry_kind,
        "callsFromTarget": extract_vm_calls(insns_from_target),
        "callsFromBlock": extract_vm_calls(insns_from_block),
        "windowStart": hx(detail_start),
        "windowEnd": hx(detail_end),
        "window": format_window(
            data,
            detail_start,
            detail_end,
            {
                block_start: "*",
                target: ">",
            },
        ),
    }


def report_markdown(input_path, symbols_path, analyses):
    lines = []
    lines.append("# CBE Script Handler Trace")
    lines.append("")
    lines.append(f"Input: `{input_path}`")
    lines.append(f"Symbols: `{symbols_path}`")
    lines.append("")
    lines.append("## Reading Notes")
    lines.append("- `target` is resolved from the command registration sequence when possible: `ldr r2` loads the relative word before the command name, then `add r2, pc` produces the handler target.")
    lines.append("- `symbolTarget` is the older simple back-reference value from `cbe_symbols.js`; keep it as a diagnostic, not as the primary handler address.")
    lines.append("- `blockStart` is the nearest preceding `push {..., lr}`. A command may still intentionally target an inner label inside a shared block.")
    lines.append("- `read-number[n]` and `read-ref/string[n]` are inferred VM argument reads through service slots `+0x08` and `+0x10`; this is a working hypothesis.")
    lines.append("- `vm-advance` and `vm-branch/result` are inferred dispatcher continuation calls through service slots `+0x38` and `+0x3C`.")
    lines.append("")
    lines.append("## Command Overview")
    lines.append("| Command | Target | Symbol target | Block | Kind | Head | VM calls from target |")
    lines.append("|---|---:|---:|---:|---|---|---|")
    for item in analyses:
        calls = compact_calls(item["callsFromTarget"])
        lines.append(
            f"| `{item['name']}` | `{item['target']}` | `{item['symbolTarget']}` | `{item['blockStart']}+0x{item['distanceFromBlock']:X}` | "
            f"{item['entryKind']} | `{item['targetHead']}` | {calls} |"
        )
    lines.append("")
    lines.append("## Focus Windows")
    for item in analyses:
        if item["name"] not in FOCUS_COMMANDS:
            continue
        lines.append(f"### {item['name']}")
        reg = item.get("registration") or {}
        lines.append(
            f"- string={item['stringOffset']} pointer={item['pointerOffset']} rel={item['relative']} "
            f"target={item['targetRaw']} aligned={item['target']} symbolTarget={item['symbolTargetRaw']}"
        )
        if reg:
            lines.append(
                f"- registerAt={reg.get('registerAt')} namePc={reg.get('namePcKind')} "
                f"ldr={reg.get('ldrAt')} pool={reg.get('poolKind')} add={reg.get('addAt')} "
                f"targetRule={reg.get('registeredTargetKind')}"
            )
        else:
            lines.append("- registerAt unresolved; using symbolTarget fallback")
        lines.append(
            f"- blockStart={item['blockStart']} blockEnd={item['blockEnd']} "
            f"kind={item['entryKind']} distance=0x{item['distanceFromBlock']:X}"
        )
        lines.append(f"- callsFromTarget: {compact_calls(item['callsFromTarget'])}")
        lines.append(f"- callsFromBlock: {compact_calls(item['callsFromBlock'])}")
        lines.append("")
        lines.append("```text")
        lines.extend(item["window"])
        lines.append("```")
        lines.append("")
    lines.append("## Current Inferences")
    lines.append("- The earlier `cbe_symbols.js` handler offsets were partly misleading because they added the relative word to the command-table location. This report now prefers the registration-site `add r2, pc` base.")
    lines.append("- `SETROLEPOS` now resolves to `0x000068A2`, a self-contained block that reads three numeric arguments through indices 2, 1, and 0 before writing actor position fields.")
    lines.append("- `GETGAMESTATE` now resolves to `0x0000646A`, an inner label in a small state-check block that returns a VM branch/result. The target path does not show normal argument reads, so it likely checks existing global game state.")
    lines.append("- `LOADLIGHTGOD` and `LOADDARKGOD` resolve to two different setup blocks (`0x00006904` and `0x0000698A`), but the light/dark assignment still needs validation against actor resource loads before we name them permanently.")
    lines.append("- `OPENCR` resolves to `0x0000611E`, a direct prologue block with service-slot calls at `+0x20`; its exact combat/choice meaning is still unresolved.")
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Trace CBE DF_Script command targets back to nearby Thumb blocks.")
    parser.add_argument("input", nargs="?", default=DEFAULT_INPUT)
    parser.add_argument("--symbols", default=str(DEFAULT_SYMBOLS))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    args = parser.parse_args()

    input_path = pathlib.Path(args.input)
    symbols_path = pathlib.Path(args.symbols)
    out_dir = pathlib.Path(args.out)
    data = input_path.read_bytes()
    symbols = load_json(symbols_path)
    commands = sorted(symbols["commands"], key=command_offset)
    registrations = find_registration_sites(data, commands)
    analyses = [analyze_command(data, command, registrations.get(command["name"])) for command in commands]

    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "script_handler_trace.json").write_text(json.dumps({
        "input": str(input_path),
        "symbols": str(symbols_path),
        "registrationsResolved": len(registrations),
        "commands": analyses,
    }, ensure_ascii=False, indent=2), encoding="utf8")
    (out_dir / "script_handler_trace.md").write_text(
        report_markdown(input_path, symbols_path, analyses),
        encoding="utf8",
    )

    print(f"Input: {input_path}")
    print(f"Output: {out_dir}")
    print(f"Commands: {len(analyses)}")
    print(f"Registrations resolved: {len(registrations)}")
    direct = sum(1 for item in analyses if item["entryKind"] == "direct-prologue")
    inside = sum(1 for item in analyses if item["entryKind"] == "inside-block")
    print(f"Direct prologue targets: {direct}")
    print(f"Inside-block targets: {inside}")


if __name__ == "__main__":
    main()
