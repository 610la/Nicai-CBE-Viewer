# CBE Web Emulator Research Toolkit

This repository is a reverse-engineering workspace for old Nicai/MStar-style
`.CBE` games. The long-term goal is a generic browser runtime/emulator that can
load standard CBE containers, not a one-off remake of a single game.

`众神之战` is the main research anchor because it contains `.sce`, `.map`,
`.actor`, `.xse`, image, audio, save, and script evidence. The code should still
be treated as generic CBE tooling wherever possible.

## Repository Status

This is research code, not a finished emulator. Current support includes:

- scanning and unpacking standard CBE resource sections
- listing and classifying resources by extension/profile
- structural probes for `.sce`, `.map`, `.actor`, and `.xse`
- a local browser viewer for catalog, bytes, structure, scene, and runtime probes
- early scene graph construction from CBE resources
- trace-only VM/provider experiments for XSE execution
- focused GodWar save-record parsing for `GodWarGameRecord`

The repository may include public sample files: CBE files belong in
`cbe file/`, and Nicai phone system/save files belong in
`nicai system files/`. Tool-generated `out_*` extraction folders, logs, and
debug screenshots are not uploaded to GitHub; they can be regenerated locally
when needed.

## Quick Start

Requirements:

- Node.js 18 or newer
- Python 3 for the Thumb disassembly helpers
- Python `capstone` only for scripts that disassemble ARM/Thumb code

Run the local viewer:

```bash
npm run viewer
```

Then open:

```text
http://127.0.0.1:4173
```

The current web UI reads its game list from local
`out_batch/batch_manifest.json`. Even if public sample CBE files are committed
in this repository, unpack them into `out_batch` before first using the viewer:

```bash
node src/cbe_unpack.js "./cbe file" out_batch
npm run viewer
```

Public sample CBE files can live in `cbe file/`; phone system/save files can
live in `nicai system files/`. If you only have one CBE file, put it in
`cbe file/` and run the directory command above. That creates the
`batch_manifest.json` expected by the viewer.

Some lower-level APIs can read a CBE file directly without unpacking first, but
the current web UI still uses `out_batch` as the resource-list entry point.

Most probes also accept explicit paths, for example:

```bash
node src/cbe_unpack.js "./cbe file/game.CBE" out_game
node src/cbe_runtime_core_probe.js "./cbe file/game.CBE"
node src/cbe_godwar_record_probe.js "./nicai system files/.system/MB_MSTAR_WQVGA" "./cbe file/众神之战.CBE"
```

## Important Files

- [docs/README_CBE.md](docs/README_CBE.md): detailed tool inventory and research notes
- [docs/CBE_EMULATOR_ROADMAP.md](docs/CBE_EMULATOR_ROADMAP.md): generic emulator roadmap
- [src/cbe_unpack.js](src/cbe_unpack.js): CBE resource-section loader/unpacker
- [src/cbe_runtime_core.js](src/cbe_runtime_core.js): generic raw-CBE runtime shell
- [src/cbe_runtime.js](src/cbe_runtime.js): first-pass scene graph/runtime builder
- [src/cbe_struct.js](src/cbe_struct.js): shared structural analyzer
- [src/cbe_godwar_record_probe.js](src/cbe_godwar_record_probe.js): GodWar phone save parser
- [src/viewer_server.js](src/viewer_server.js) and [viewer/](viewer/): local browser UI
- [docs/PROJECT_STRUCTURE.md](docs/PROJECT_STRUCTURE.md): repository layout guide
