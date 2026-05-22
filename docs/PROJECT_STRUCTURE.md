# Project Structure

This project is intentionally kept as a research workspace. Source probes now
live under `src/`, while public sample data and local generated output stay in
separate top-level folders.

## Top-Level Layout

- `src/`
  - source code and reverse-engineering probes
- `viewer/`
  - browser UI files
- `docs/`
  - project notes, roadmap, and publishing/maintenance notes
- `tools/`
  - repository helper scripts
- `scripts/`
  - local maintenance and GitHub publishing scripts
- `cbe file/`
  - optional published CBE sample files
- `nicai system files/`
  - optional published Nicai phone/system/save files

## Source Groups

- `src/cbe_unpack.js`, `src/cbe_profile.js`, `src/cbe_scan.js`, `src/cbe_textdump.js`
  - archive loading, resource table parsing, text scanning, and basic profiling
- `src/cbe_struct.js`, `src/cbe_structdump.js`
  - shared structural summaries for `.sce`, `.map`, `.actor`, and `.xse`
- `src/cbe_runtime_core.js`, `src/cbe_runtime.js`, `src/cbe_emulator.js`
  - generic runtime shell, scene graph builder, and early emulator state/frame logic
- `src/cbe_*probe.js`, `src/cbe_*trace.js`, `src/cbe_*trace.py`
  - focused reverse-engineering probes; most produce `out_*` reports
- `src/cbe_disasm.py`, `src/cbe_thumbdump.py`, `src/cbe_global_*.py`, `src/cbe_vtable_resolve.py`
  - binary and Thumb-code analysis helpers
- `src/viewer_server.js`, `viewer/`
  - local web UI for resource browsing and runtime experiments

## Documentation

- `README.md`
  - GitHub-facing entry point
- `docs/README_CBE.md`
  - detailed inventory of tools and discoveries
- `docs/CBE_EMULATOR_ROADMAP.md`
  - project direction and known blockers
- `docs/cbe_disasm_notes.md`
  - reverse-engineering notes tied to raw offsets
- `docs/GITHUB_PUBLISH_CHECKLIST.md`
  - steps to check before pushing to GitHub

## Generated Artifacts

Generated files are intentionally ignored:

- `out*/`, `out_*/`
- `palette_tests/`
- `*.log`, `*.err.log`
- root-level diagnostic PNGs such as `debug_*.png`, `viewer_*preview*.png`,
  `actor_draw_candidate_*.png`, and `map_candidate*.png`
- local dependency/cache folders such as `.python_deps/`, `__pycache__/`,
  and `node_modules/`

If a generated report is important for a future article or release, copy the
smallest useful excerpt into documentation instead of committing the whole output
directory.

## Published/Local Assets

The project can use CBE files and Nicai phone/system files from these folders:

- `cbe file/`
- `nicai system files/`

Generated outputs still belong in ignored `out_*` folders.
