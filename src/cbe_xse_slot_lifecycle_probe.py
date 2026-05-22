#!/usr/bin/env python3
import datetime as _dt
import json
import pathlib
import sys

local_deps = pathlib.Path(__file__).resolve().parent / ".python_deps"
if local_deps.exists():
    sys.path.insert(0, str(local_deps))

from cbe_xse_reader_service_trace import disasm_window, ins_text  # noqa: E402


ROOT = pathlib.Path(__file__).resolve().parent
DEFAULT_INPUTS = [
    pathlib.Path(__file__).resolve().parents[1] / "cbe file" / "众神之战.CBE",
    pathlib.Path(__file__).resolve().parents[1] / "cbe file" / "众神之战.CBE",
]
SWITCH_REPLAY_JSON = ROOT / "out_godwar_xseswitchreplay" / "xse_switch_replay_probe.json"
RUNTIME_DISPATCH_JSON = ROOT / "out_godwar_xsedispatch" / "xse_runtime_dispatch_probe.json"
TRACE_VM_JSON = ROOT / "out_godwar_xsetracevm" / "xse_trace_vm_probe.json"
CURSOR_INIT_JSON = ROOT / "out_godwar_xsecursorinit" / "xse_cursor_init_probe.json"
DEFAULT_OUT = ROOT / "out_godwar_xseslotlifecycle"


SCRIPT_SLOT_SIZE = 0x74
SCRIPT_FIELDS = {
    0x00: "loaded/resource-present pointer",
    0x04: "initial opcode-stack cursor seed",
    0x08: "tail64 group-cursor seed enable",
    0x0C: "tail64 seed index",
    0x10: "active flag",
    0x14: "delay flag",
    0x18: "delay deadline",
    0x1C: "time/entry field",
    0x20: "type-8 inline record",
    0x48: "group table pointer",
    0x50: "current group index/cursor",
    0x54: "opcode record table pointer",
    0x58: "opcode record capacity",
    0x5C: "opcode stack cursor",
    0x60: "negative-index base",
    0x64: "tail64/range table",
    0x68: "tail64/range count",
    0x6C: "final-ref table",
}

SCHEDULER_FIELDS = {
    0x00: "global scheduler/run flag",
    0x04: "current script slot",
    0x08: "last scheduler timestamp",
    0x0C: "registered callback count",
    0x10: "single-step/nested-exec guard",
}

FUNCTIONS = [
    {
        "entry": 0x11240,
        "end": 0x11252,
        "name": "scheduler reset helper",
        "phase": "scheduler-reset",
        "role": "clears global scheduler fields, not per-script +0x50 state",
        "events": [
            (0x11246, "scheduler+0x00", "write caller value", "clear global scheduler/run flag"),
            (0x11248, "scheduler+0x04", "write caller value", "clear current script slot"),
            (0x1124A, "scheduler+0x0C", "write caller value", "clear registered callback count"),
        ],
    },
    {
        "entry": 0x11252,
        "end": 0x11266,
        "name": "opcode cursor adjust helper",
        "phase": "opcode-stack-seed/rewind",
        "role": "adds a delta to script +0x5C and mirrors it to +0x60",
        "events": [
            (0x11260, "script+0x5C", "old + delta", "updates opcode stack cursor"),
            (0x11262, "script+0x60", "old + delta", "updates negative-index base"),
        ],
    },
    {
        "entry": 0x11266,
        "end": 0x112C4,
        "name": "script reset/start helper",
        "phase": "script-reset",
        "role": "initializes a script slot before VM dispatch",
        "events": [
            (0x11288, "script+0x50", "tail64[field+0x0C].field+0x00 if script+0x08 != 0", "conditional group-cursor seed"),
            (0x1128C, "script+0x5C", "0", "reset opcode stack cursor before seed deltas"),
            (0x11292, "script+0x60", "0", "reset negative-index base before seed deltas"),
            (0x1129E, "script+0x54[*].type", "-1", "mark runtime record-stack slots empty"),
            (0x112A6, "script+0x14", "0", "clear delay flag"),
            (0x112AC, "call 0x11252", "script+0x04", "seed +0x5C/+0x60 from header field +0x04"),
            (0x112BE, "call 0x11252", "tail64[field+0x0C].field+0x08 + 1", "add tail64 opcode-stack seed when tail64 is live"),
        ],
    },
    {
        "entry": 0x1193A,
        "end": 0x11954,
        "name": "rewind opcode cursor helper",
        "phase": "record-stack-runtime",
        "role": "subtracts from current script +0x5C",
        "events": [
            (0x11950, "script+0x5C", "old - delta", "rewind opcode stack cursor"),
        ],
    },
    {
        "entry": 0x11984,
        "end": 0x119C4,
        "name": "previous-record helper",
        "phase": "record-stack-runtime",
        "role": "decrements +0x5C and copies the previous runtime record",
        "events": [
            (0x1199A, "script+0x5C", "old - 1", "pop one runtime record"),
        ],
    },
    {
        "entry": 0x11A0E,
        "end": 0x11A4A,
        "name": "write-current-record helper",
        "phase": "record-stack-runtime",
        "role": "writes one transformed record to +0x54[+0x5C] and increments +0x5C",
        "events": [
            (0x11A3E, "script+0x5C", "old + 1", "push one runtime record"),
        ],
    },
    {
        "entry": 0x11A4A,
        "end": 0x11AAE,
        "name": "tail64 select helper",
        "phase": "record-stack-runtime",
        "role": "copies a tail64 record into the stack, adjusts +0x5C/+0x60, then restores +0x50",
        "events": [
            (0x11A86, "call 0x11252", "tail64 field + 1", "advance opcode stack/negative base for selected tail record"),
            (0x11AA8, "script+0x50", "saved group cursor", "restore group cursor after tail selection"),
        ],
    },
    {
        "entry": 0x11C3C,
        "end": 0x12286,
        "name": "main group dispatcher",
        "phase": "vm-dispatch",
        "role": "reads +0x50, dispatches the group, and increments +0x50 if the case did not change it",
        "events": [
            (0x11CEC, "script+0x50", "read", "load current group cursor before dispatch"),
            (0x1212A, "script+0x50", "branch target", "comparison group can assign group cursor"),
            (0x12172, "script+0x50", "old + 1", "tail-select group advances cursor before helper call"),
            (0x121C0, "script+0x60", "tail state", "branch/jump setup updates negative-index base"),
            (0x121C4, "script+0x50", "tail state", "branch/jump setup updates group cursor"),
            (0x12236, "script+0x18", "now + delay", "timer case sets deadline"),
            (0x1223A, "script+0x14", "1", "timer case sets delay flag"),
            (0x12254, "script+0x10", "0", "clear-active case stops the script"),
            (0x1226C, "script+0x50", "old + 1", "normal post-case cursor advance"),
        ],
    },
    {
        "entry": 0x12286,
        "end": 0x122B0,
        "name": "script activation helper",
        "phase": "external-activation",
        "role": "marks an existing script slot active and records it as current; does not write +0x50",
        "events": [
            (0x122A4, "script+0x10", "1", "mark script active"),
            (0x122A6, "scheduler+0x04", "slot index", "select current script slot"),
            (0x122AC, "scheduler+0x08", "time", "record activation timestamp"),
        ],
    },
    {
        "entry": 0x122B0,
        "end": 0x122D8,
        "name": "script deactivation/free helper",
        "phase": "external-activation",
        "role": "marks a script inactive and clears its loaded pointer; does not write +0x50",
        "events": [
            (0x122C8, "scheduler+0x04", "slot index", "select current script slot"),
            (0x122CC, "scheduler+0x10", "1", "mark scheduler transition"),
            (0x122D2, "script+0x10", "0", "clear script active flag"),
            (0x122D4, "script+0x00", "0", "clear loaded/resource-present pointer"),
        ],
    },
    {
        "entry": 0x122E6,
        "end": 0x12326,
        "name": "external delay helpers",
        "phase": "external-delay",
        "role": "sets or clears script delay fields without touching +0x50",
        "events": [
            (0x12300, "script+0x14", "1", "set delay flag"),
            (0x12308, "script+0x18", "now + argument", "set delay deadline"),
            (0x12322, "script+0x14", "0", "clear delay flag"),
        ],
    },
]

GROUP_CURSOR_MUTATION_TARGETS = {
    "0x012012": "comparison branch can assign +0x50",
    "0x01215A": "tail64 select increments +0x50 before helper",
    "0x01217A": "branch/jump setup writes +0x50/+0x60",
}


def hx(value, width=8):
    if isinstance(value, str):
        return value
    return f"0x{value:0{width}X}"


def pick_input(arg=None):
    if arg:
        return pathlib.Path(arg)
    for item in DEFAULT_INPUTS:
        if item.exists():
            return item
    return DEFAULT_INPUTS[0]


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def function_context(data, fn):
    rows = disasm_window(data, fn["entry"], fn["end"] - fn["entry"])
    by_address = {ins.address: ins_text(ins) for ins in rows}
    events = []
    for address, field, value, meaning in fn["events"]:
        events.append({
            "address": hx(address),
            "field": field,
            "value": value,
            "meaning": meaning,
            "instruction": by_address.get(address, ""),
        })
    return {
        "entry": hx(fn["entry"]),
        "end": hx(fn["end"]),
        "name": fn["name"],
        "phase": fn["phase"],
        "role": fn["role"],
        "events": events,
        "context": [ins_text(ins) for ins in rows[:80]],
    }


def mode_for_script(dispatch, name, fallback):
    for script in dispatch.get("scripts", []):
        if script.get("name") == name:
            return (
                (script.get("executionBest") or {}).get("mode")
                or (script.get("dispatchBest") or {}).get("mode")
                or fallback
            )
    return fallback


def execution_attempts(switch_replay, dispatch):
    rows = []
    for script in switch_replay.get("scripts", []):
        fallback = ((script.get("best") or {}).get("shortMode")) or ""
        mode = mode_for_script(dispatch, script.get("name"), fallback)
        attempt = None
        for item in script.get("attempts", []):
            if item.get("ok") and item.get("shortMode") == mode:
                attempt = item
                break
        if attempt is None:
            attempt = script.get("best") or {}
        header = attempt.get("header") or {}
        has_tail64 = any(
            "object+68 ranges" in str(step.get("label", ""))
            for step in ((attempt.get("bestTail") or {}).get("steps") or [])
        )
        field04 = header.get("field04")
        field08 = header.get("field08Byte")
        field0c = header.get("field0C")
        group_cursor_seed = "tail64[field+0x0C].field+0x00" if field08 else 0
        opcode_cursor_seed = "field+0x04 + tail64[field+0x0C].field+0x08 + 1" if has_tail64 else "field+0x04 + tail64 seed (tail64 unresolved)"
        rows.append({
            "name": script.get("name"),
            "executionMode": mode,
            "field04": field04,
            "field08Byte": field08,
            "field0C": field0c,
            "hasTail64Evidence": has_tail64,
            "resetGroupCursorSeed": group_cursor_seed,
            "resetGroupCursorSeeded": bool(field08),
            "resetOpcodeCursorSeed": opcode_cursor_seed,
            "note": (
                "field+0x08 is zero, so 0x11266 does not seed +0x50 for this execution-best script"
                if not field08
                else "0x11266 can seed +0x50 through tail64 for this script"
            ),
        })
    return rows


def blocker_rows(trace_vm):
    rows = []
    cursor_zero_first = 0
    for script in trace_vm.get("scripts", []):
        blockers = [
            step for step in script.get("steps", [])
            if "writeback target unresolved" in (step.get("blockers") or [])
        ]
        if not blockers:
            rows.append({
                "name": script.get("name"),
                "mode": script.get("mode"),
                "writebackBlockers": 0,
                "firstWritebackCursor": None,
                "firstBeforeAnyPriorStep": False,
                "priorCursorMutationTargets": [],
                "firstOperand0Type": None,
                "firstOperand0PointerKind": "",
            })
            continue
        first = blockers[0]
        prior = [step for step in script.get("steps", []) if step.get("cursor", 0) < first.get("cursor", 0)]
        prior_mutators = [
            {
                "cursor": step.get("cursor"),
                "groupId": step.get("groupId"),
                "target": step.get("target"),
                "meaning": GROUP_CURSOR_MUTATION_TARGETS.get(step.get("target")),
            }
            for step in prior
            if step.get("target") in GROUP_CURSOR_MUTATION_TARGETS
        ]
        operands = ((first.get("semantics") or {}).get("operands")) or []
        op0 = operands[0] if operands else {}
        pointer = op0.get("pointer") or {}
        before_any = first.get("cursor") == 0 and not prior
        if before_any:
            cursor_zero_first += 1
        rows.append({
            "name": script.get("name"),
            "mode": script.get("mode"),
            "writebackBlockers": len(blockers),
            "firstWritebackCursor": first.get("cursor"),
            "firstGroupId": first.get("groupId"),
            "firstTarget": first.get("target"),
            "firstBeforeAnyPriorStep": before_any,
            "priorCursorMutationTargets": prior_mutators,
            "firstOperand0Type": op0.get("type"),
            "firstOperand0PointerKind": pointer.get("kind", ""),
            "firstOperand0PointerResolves": bool(pointer.get("resolves")),
        })
    return rows, cursor_zero_first


def build_report(input_path):
    data = input_path.read_bytes()
    switch_replay = read_json(SWITCH_REPLAY_JSON)
    dispatch = read_json(RUNTIME_DISPATCH_JSON)
    trace_vm = read_json(TRACE_VM_JSON)
    cursor_init = read_json(CURSOR_INIT_JSON)
    functions = [function_context(data, fn) for fn in FUNCTIONS]
    script_rows = execution_attempts(switch_replay, dispatch)
    blockers, cursor_zero_first = blocker_rows(trace_vm)
    blocker_count = sum(row["writebackBlockers"] for row in blockers)
    all_not_seeded = all(not row["resetGroupCursorSeeded"] for row in script_rows)
    first_blocker_scripts = [
        row["name"] for row in blockers
        if row["writebackBlockers"] and row["firstBeforeAnyPriorStep"]
    ]
    status = "slot-lifecycle-anchors-cursor0" if all_not_seeded and cursor_zero_first else "slot-lifecycle-needs-live-state"
    return {
        "schema": "nicai.cbe.xseSlotLifecycleProbe.v1",
        "input": str(input_path),
        "generatedAt": _dt.datetime.now(_dt.UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "inputs": {
            "switchReplay": str(SWITCH_REPLAY_JSON),
            "runtimeDispatch": str(RUNTIME_DISPATCH_JSON),
            "traceVm": str(TRACE_VM_JSON),
            "cursorInit": str(CURSOR_INIT_JSON),
        },
        "stateContract": {
            "scriptSlotSize": hx(SCRIPT_SLOT_SIZE, 2),
            "scriptFields": {hx(k, 2): v for k, v in SCRIPT_FIELDS.items()},
            "schedulerFields": {hx(k, 2): v for k, v in SCHEDULER_FIELDS.items()},
            "groupCursorField": "script+0x50",
            "opcodeCursorField": "script+0x5C",
            "negativeIndexBaseField": "script+0x60",
        },
        "summary": {
            "status": status,
            "scriptCount": len(script_rows),
            "executionGroupCursorNotSeededCount": sum(1 for row in script_rows if not row["resetGroupCursorSeeded"]),
            "writebackBlockerCount": blocker_count,
            "cursorZeroFirstBlockerCount": cursor_zero_first,
            "firstBlockerScripts": first_blocker_scripts,
            "currentFinding": (
                f"0x11266 does not seed script+0x50 for {sum(1 for row in script_rows if not row['resetGroupCursorSeeded'])}/{len(script_rows)} execution-best focused scripts; "
                f"the first unresolved writeback in {cursor_zero_first} script(s) occurs at cursor 0 before any in-trace VM case can mutate +0x50. "
                "Activation/deactivation helpers toggle active/current-slot fields but do not write +0x50."
            ),
            "emulatorImpact": (
                "The generic web emulator should model script slots as runtime state, but the current opening writeback blocker is not explained by a hidden branch-state cursor mutation. "
                "Visible effects still need operand/reference binding rather than a one-off cursor override."
            ),
            "nextTarget": (
                "Bind the opcode-record stack seed through +0x5C/+0x60 and the tail64/+0x74 reader arrays, then re-evaluate operand0 reference records under the same generic script-slot state machine."
            ),
        },
        "scripts": script_rows,
        "writebackBlockers": blockers,
        "cursorInitSummary": cursor_init.get("summary") or {},
        "functions": functions,
    }


def md_row(cells):
    return "| " + " | ".join(str(cell).replace("|", "\\|") for cell in cells) + " |"


def render_markdown(report):
    lines = [
        "# XSE Slot Lifecycle Probe",
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
        "## Reset-State Rows",
        "",
        md_row(["Script", "Mode", "field+04", "field+08", "field+0C", "+0x50 seed", "+0x5C/+0x60 seed"]),
        md_row(["---", "---", "---:", "---:", "---:", "---", "---"]),
    ]
    for row in report["scripts"]:
        lines.append(md_row([
            row["name"],
            row["executionMode"],
            row["field04"],
            row["field08Byte"],
            row["field0C"],
            row["resetGroupCursorSeed"],
            row["resetOpcodeCursorSeed"],
        ]))
    lines.extend([
        "",
        "## Writeback Blocker Timing",
        "",
        md_row(["Script", "Mode", "Blockers", "First cursor", "First group", "Before prior VM mutation", "Operand0 type", "Pointer"]),
        md_row(["---", "---", "---:", "---:", "---:", "---", "---:", "---"]),
    ])
    for row in report["writebackBlockers"]:
        lines.append(md_row([
            row["name"],
            row["mode"],
            row["writebackBlockers"],
            row["firstWritebackCursor"] if row["firstWritebackCursor"] is not None else "-",
            row.get("firstGroupId", "-"),
            "yes" if row["firstBeforeAnyPriorStep"] else "no",
            row["firstOperand0Type"] if row["firstOperand0Type"] is not None else "-",
            row["firstOperand0PointerKind"] or "-",
        ]))
    lines.extend([
        "",
        "## Anchored Lifecycle Functions",
        "",
    ])
    for fn in report["functions"]:
        lines.append(f"### {fn['entry']} {fn['name']}")
        lines.append(f"- Phase: {fn['phase']}")
        lines.append(f"- Role: {fn['role']}")
        for event in fn["events"]:
            instruction = f" `{event['instruction']}`" if event["instruction"] else ""
            lines.append(f"- {event['address']} {event['field']} <= {event['value']}: {event['meaning']}.{instruction}")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2), encoding="utf-8")


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    input_path = pick_input(argv[0] if argv else None)
    out_dir = pathlib.Path(argv[1]) if len(argv) > 1 else DEFAULT_OUT
    out_dir.mkdir(parents=True, exist_ok=True)
    report = build_report(input_path)
    json_file = out_dir / "xse_slot_lifecycle_probe.json"
    md_file = out_dir / "xse_slot_lifecycle_probe.md"
    write_json(json_file, report)
    md_file.write_text(render_markdown(report), encoding="utf-8")
    print(f"wrote {json_file}")
    print(f"wrote {md_file}")
    print(f"{report['summary']['status']}: {report['summary']['currentFinding']}")


if __name__ == "__main__":
    main()
