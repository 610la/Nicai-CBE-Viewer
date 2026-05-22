import argparse
import sys
from pathlib import Path

local_deps = Path(__file__).resolve().parent / ".python_deps"
if local_deps.exists():
    sys.path.insert(0, str(local_deps))

from capstone import Cs, CS_ARCH_ARM, CS_MODE_ARM, CS_MODE_THUMB


DEFAULT_INPUT = Path(__file__).resolve().parents[1] / "cbe file" / "众神之战.CBE"


def parse_int(text: str) -> int:
    text = str(text).strip()
    return int(text, 16) if text.lower().startswith("0x") else int(text, 10)


def hx(value: int, width: int = 0) -> str:
    return f"0x{value:0{width}X}"


def dump(file: Path, start: int, length: int, mode_name: str = "thumb") -> str:
    data = file.read_bytes()
    start = max(0, min(len(data), start))
    end = max(start, min(len(data), start + length))
    code = data[start:end]
    mode = CS_MODE_ARM if mode_name == "arm" else CS_MODE_THUMB
    md = Cs(CS_ARCH_ARM, mode)
    lines = [f"# {file.name} {mode_name.upper()} @ {hx(start, 8)} len={len(code)}"]
    for ins in md.disasm(code, start):
        raw = " ".join(f"{byte:02x}" for byte in ins.bytes)
        lines.append(f"{hx(ins.address, 8)}  {raw:<10}  {ins.mnemonic} {ins.op_str}".rstrip())
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description="Disassemble a CBE byte range as ARM Thumb or ARM.")
    parser.add_argument("file", nargs="?", default=DEFAULT_INPUT)
    parser.add_argument("start", nargs="?", default="0x107F6")
    parser.add_argument("length", nargs="?", default="256")
    parser.add_argument("--mode", choices=["thumb", "arm"], default="thumb")
    args = parser.parse_args()
    print(dump(Path(args.file), parse_int(args.start), parse_int(args.length), args.mode))


if __name__ == "__main__":
    main()
