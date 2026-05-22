#!/usr/bin/env python3
import argparse
import datetime as _dt
import json
import pathlib
import sys

BASE_DIR = pathlib.Path(__file__).resolve().parent
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

from cbe_xse_reader_service_trace import disasm_window, hx, ins_text  # noqa: E402


DEFAULT_INPUT = pathlib.Path(__file__).resolve().parents[1] / "cbe file" / "众神之战.CBE"
DEFAULT_OUT = BASE_DIR / "out_godwar_providerabi"
GLOBAL_BLOCK = 0x3584

PROVIDER_SOURCE = {
    "hostProviderGlobal": 0x35F8,
    "hostProviderStore": 0x34AAA,
    "providerRootLoad": 0x0035A,
    "apiObjectStore": 0x0037E,
    "apiObjectGlobal": 0x3588,
    "meaning": (
        "0x34AAA stores the incoming host/provider pointer at sb+0x35F8. "
        "0x354 loads that pointer from sb+0x3584+0x74, stores provider[0x0C] at 0x3584, "
        "and stores provider[0x08] at 0x3588. The later provider calls are through this provider[0x08] API object."
    ),
}

PROVIDER_METHOD_RETURNS = [
    (0x00380, 0x98, 0x35D8, "extended provider method", "providerApi+0x80+0x18"),
    (0x00388, 0x04, 0x358C, "early service object", "providerApi+0x04"),
    (0x003BA, 0x4C, 0x3598, "service object used by helper init", "providerApi+0x4C"),
    (0x003F6, 0x14, 0x359C, "provider-returned service", "providerApi+0x14"),
    (0x003FE, 0x1C, 0x35A0, "provider-returned service", "providerApi+0x1C"),
    (0x00406, 0x24, 0x35A4, "provider-returned service", "providerApi+0x24"),
    (0x0040E, 0x3C, 0x35B0, "provider-returned service", "providerApi+0x3C"),
    (0x00416, 0x44, 0x35B4, "provider-returned service", "providerApi+0x44"),
    (0x0041E, 0x34, 0x35B8, "provider-returned service", "providerApi+0x34"),
    (0x00426, 0x54, 0x35BC, "provider-returned service", "providerApi+0x54"),
    (0x0042E, 0x5C, 0x35C0, "stream conversion service", "providerApi+0x5C"),
    (0x00436, 0x64, 0x35C4, "reader/open/cursor service", "providerApi+0x64"),
    (0x0043E, 0x6C, 0x35C8, "sibling service", "providerApi+0x6C"),
    (0x0044A, 0x74, 0x35CC, "provider-returned service", "providerApi+0x74"),
    (0x00452, 0x7C, 0x35D0, "provider-returned service", "providerApi+0x7C"),
    (0x0045A, 0x90, 0x35D4, "extended provider method", "providerApi+0x80+0x10"),
    (0x00464, 0xB8, 0x35DC, "extended provider method", "providerApi+0x80+0x38"),
    (0x0046E, 0x2C, 0x35AC, "provider-returned service after local init", "providerApi+0x2C"),
    (0x004EC, 0x84, 0x35E0, "manager root for wrapper facades", "providerApi+0x80+0x04"),
    (0x004F6, 0xA0, 0x35E4, "extended provider method", "providerApi+0x80+0x20"),
    (0x00500, 0xC8, 0x35E8, "extended provider method", "providerApi+0xC0+0x08"),
    (0x0050A, 0xCC, 0x35EC, "extended provider method", "providerApi+0xC0+0x0C"),
]

HELPER_ONLY_CALLS = [
    {
        "site": 0x003A0,
        "methodOffset": 0x0C,
        "expression": "providerApi+0x0C",
        "meaning": "return is fed to 0x3453C with local object sb+...+0x78, not stored directly in the flat 0x3584 block",
    },
    {
        "site": 0x003DE,
        "methodOffset": 0x48,
        "expression": "providerApi+0x48",
        "meaning": "conditional helper path used when providerApi+0x4C reports 0x2A",
    },
]

WINDOWS = [
    {
        "name": "host provider entry",
        "start": 0x34AAA,
        "size": 0x20,
        "note": "Stores incoming host/provider pointer at sb+0x35F8, then calls 0x354.",
    },
    {
        "name": "provider source and API-object setup",
        "start": 0x00354,
        "size": 0x34,
        "note": "Loads sb+0x35F8, copies provider[0x0C] to 0x3584 and provider[0x08] to 0x3588.",
    },
    {
        "name": "provider API return block A",
        "start": 0x0041E,
        "size": 0x4E,
        "note": "Includes providerApi+0x54/+0x5C/+0x64/+0x6C/+0x74/+0x7C/+0x90/+0xB8 returns.",
    },
    {
        "name": "provider API return block B",
        "start": 0x004EC,
        "size": 0x2A,
        "note": "Includes providerApi+0x84/+0xA0/+0xC8/+0xCC returns before 0x2910 and 0x3008.",
    },
]


def md_row(values):
    return "| " + " | ".join(str(value if value is not None else "").replace("|", "\\|") for value in values) + " |"


def build_report(input_file):
    data = pathlib.Path(input_file).read_bytes()
    provider_returns = []
    for site, method_offset, target_global, role, expression in PROVIDER_METHOD_RETURNS:
        provider_returns.append({
            "site": site,
            "siteHex": hx(site),
            "methodOffset": method_offset,
            "methodOffsetHex": f"+0x{method_offset:X}",
            "targetGlobal": target_global,
            "targetGlobalHex": hx(target_global, 4),
            "targetBlockOffset": target_global - GLOBAL_BLOCK,
            "targetBlockOffsetHex": f"+0x{target_global - GLOBAL_BLOCK:X}",
            "role": role,
            "expression": expression,
            "isXseCritical": target_global in {0x35C0, 0x35C4, 0x35E0},
        })
    return {
        "schema": "nicai.cbe.providerAbiTrace.v1",
        "input": str(pathlib.Path(input_file)),
        "generatedAt": _dt.datetime.now(_dt.UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "globalBlock": GLOBAL_BLOCK,
        "globalBlockHex": hx(GLOBAL_BLOCK, 4),
        "providerSource": {
            **PROVIDER_SOURCE,
            "hostProviderGlobalHex": hx(PROVIDER_SOURCE["hostProviderGlobal"], 4),
            "hostProviderStoreHex": hx(PROVIDER_SOURCE["hostProviderStore"]),
            "providerRootLoadHex": hx(PROVIDER_SOURCE["providerRootLoad"]),
            "apiObjectStoreHex": hx(PROVIDER_SOURCE["apiObjectStore"]),
            "apiObjectGlobalHex": hx(PROVIDER_SOURCE["apiObjectGlobal"], 4),
        },
        "providerReturns": provider_returns,
        "helperOnlyCalls": [
            {
                **item,
                "siteHex": hx(item["site"]),
                "methodOffsetHex": f"+0x{item['methodOffset']:X}",
            }
            for item in HELPER_ONLY_CALLS
        ],
        "windows": [
            {
                **window,
                "startHex": hx(window["start"]),
                "instructions": [ins_text(ins) for ins in disasm_window(data, window["start"], window["size"])],
            }
            for window in WINDOWS
        ],
        "conclusion": {
            "currentFinding": (
                "The services at 0x35C0, 0x35C4, and 0x35E0 are not statically built CBE method tables. "
                "They are return values from the host provider API object stored at sb+0x3588."
            ),
            "emulatorImpact": (
                "Static method-table scans can still find local objects, but the live XSE reader service must be modeled as a host-provider "
                "return: providerApi+0x5C -> 0x35C0 conversion service and providerApi+0x64 -> 0x35C4 reader/open/cursor service."
            ),
            "nextTarget": (
                "Implement a host-provider ABI shim that returns service objects for 0x35C0/0x35C4/0x35E0, then bind the observed SCE/XSE reader slots "
                "+0x40/+0x4C/+0x50/+0x64 to that shim instead of selecting static table candidates."
            ),
        },
    }


def render_markdown(report):
    lines = [
        "# Provider ABI Trace",
        "",
        f"- Input CBE: `{report['input']}`",
        f"- Generated: {report['generatedAt']}",
        "",
        "## Current Conclusion",
        "",
        f"- {report['conclusion']['currentFinding']}",
        f"- {report['conclusion']['emulatorImpact']}",
        f"- Next: {report['conclusion']['nextTarget']}",
        "",
        "## Provider Source",
        "",
        f"- Host provider stored at `{report['providerSource']['hostProviderGlobalHex']}` from `{report['providerSource']['hostProviderStoreHex']}`.",
        f"- API object stored at `{report['providerSource']['apiObjectGlobalHex']}` from provider field `[host+0x08]`.",
        f"- {report['providerSource']['meaning']}",
        "",
        "## Provider API Returns",
        "",
        md_row(["Site", "Provider method", "Stored global", "Role", "Critical"]),
        md_row(["---", "---", "---", "---", "---"]),
    ]
    for item in report["providerReturns"]:
        lines.append(md_row([
            item["siteHex"],
            item["expression"],
            f"{item['targetGlobalHex']} ({item['targetBlockOffsetHex']})",
            item["role"],
            "yes" if item["isXseCritical"] else "",
        ]))
    lines.extend(["", "## Helper-Only Provider Calls", ""])
    for item in report["helperOnlyCalls"]:
        lines.append(f"- `{item['siteHex']}` `{item['expression']}`: {item['meaning']}")
    lines.extend(["", "## Disassembly Windows", ""])
    for window in report["windows"]:
        lines.append(f"### {window['name']} `{window['startHex']}`")
        lines.append("")
        lines.append(f"- {window['note']}")
        lines.append("")
        lines.append("```text")
        lines.extend(window["instructions"])
        lines.append("```")
        lines.append("")
    return "\n".join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Trace the host-provider ABI methods that populate the flat sb+0x3584 service block.")
    parser.add_argument("input", nargs="?", default=DEFAULT_INPUT)
    parser.add_argument("out", nargs="?", default=str(DEFAULT_OUT))
    args = parser.parse_args(argv)

    report = build_report(args.input)
    out_dir = pathlib.Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    json_path = out_dir / "provider_abi_trace.json"
    md_path = out_dir / "provider_abi_trace.md"
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    md_path.write_text(render_markdown(report), encoding="utf-8")
    print(f"wrote {json_path}")
    print(f"wrote {md_path}")


if __name__ == "__main__":
    main()
