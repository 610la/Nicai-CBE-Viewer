# CBE Unpacker Notes

This workspace now includes:

- `CBE_EMULATOR_ROADMAP.md`: project direction for a generic browser CBE emulator rather than a single-game port
- `cbe_profile.js`: shared resource-profile/capability classifier for generic CBE tooling
- `cbe_corpus_matrix.js`: scans a directory of `.CBE` files and reports standard-loader compatibility plus resource-profile coverage
- `cbe_unpack.js`: unpack a single `.CBE` file or batch-unpack a whole directory
- `cbe_scan.js`: quick signature/string scanner for format exploration
- `cbe_textdump.js`: extract readable GBK/GB2312 text runs from unpacked `.xse` scripts
- `cbe_struct.js`: shared structural analyzer for script/map/actor resources
- `cbe_structdump.js`: batch structural summary exporter for `.sce`, `.map`, `.actor`, and `.xse`
- `cbe_mapdump.js`: focused `.map` payload/statistics exporter for opcode reverse engineering
- `cbe_actordump.js`: focused `.actor` stream summary exporter for sprite/animation reverse engineering
- `cbe_scenedump.js`: focused `.sce` scene exporter with decoded object placement candidates
- `cbe_streamtrace.js`: code-anchored stream read tracer for `.sce`, `.map`, `.actor`, and `.xse`
- `cbe_runtime.js`: builds a first-pass emulator scene graph from a `.sce` resource
- `cbe_bootflow_trace.js`: records the observed boot/title/opening/protagonist-choice flow and maps each node to resources/scripts
- `cbe_bootdata_trace.js`: scans raw pre-resource CBE boot data for loading tips, title/save strings, opening narration, and manual/story evidence
- `cbe_storytrace.js`: groups light/dark story, actor, scene, portrait, and dialogue evidence before emulator assumptions
- `cbe_route_trace.js`: reconstructs light/dark route evidence and recovered task-title tokens from `.xse` text dumps
- `cbe_xseflow.js`: traces focused opening-route `.sce`/`.xse` links, command-name evidence, resource refs, and dialogue text
- `cbe_xsecmd_probe.js`: dumps command-adjacent XSE byte windows and token gaps for the current script grammar pass
- `cbe_script_handler_trace.py`: resolves script command registration targets in Thumb code and infers first-pass VM argument reads
- `cbe_xse_skeleton.js`: uses the handler map to produce a cautious XSE command/argument skeleton for the focused opening scripts
- `cbe_xse_layout_trace.js`: separates focused `.xse` files into object/table bytes, text/resource pools, and tail label/symbol slots
- `cbe_xse_object_trace.js`: follows the `0x112C4` script-object parser shape and compares object/group-table alignment attempts
- `cbe_xse_vm_gate_probe.js`: tests the real `0x112C4` opcode gate from raw CBE XSE resources and falsifies the `+0x4C`-only fix
- `cbe_xse_stream_prep_trace.js`: compares the XSE open/stream-conversion chain with sibling resource parsers
- `cbe_xse_stream_service_trace.py`: isolates the shared `[sb+0x35C4]+0x40` open and `[sb+0x35C0]+0x50` conversion service chain across XSE, SCE, and sibling parsers
- `cbe_xse_provider_service_trace.py`: traces the host/provider setup that populates live service globals `0x35C0`, `0x35C4`, `0x35C8`, and `0x35E0`
- `cbe_provider_service_replay.js`: replays the first runnable provider/open/convert/read service-chain slice against real SCE bytes while keeping XSE blocked at exact `+0x50` cursor semantics
- `cbe_cursor50_variant_probe.js`: compares `[sb+0x35C4]+0x50` token variants against the actor `0x0F222` sibling parser and XSE `0x112C4` strict gate
- `cbe_provider_abi_trace.py`: maps the host-provider API methods that return live service objects such as `0x35C0`, `0x35C4`, and `0x35E0`
- `cbe_provider_abi_shim_probe.js`: boots a runnable host-provider ABI shim and replays SCE/XSE through returned service objects
- `cbe_provider_observation_channel.js`: reusable provider observation channel for normalizing service-object compare events, validating capture schema, and exporting adapter-compatible payloads
- `cbe_xse_switch_replay_probe.js`: replays the real `0x112C4` group/opcode switch and corrects the old strict-opcode-gate assumption
- `cbe_xse_runtime_dispatch_probe.js`: validates replayed XSE group ids against the real `0x11C3C` runtime dispatcher jump table
- `cbe_xse_dispatch_case_probe.py`: maps the `0x11C3C` dispatcher cases, helper calls, and script-record fields needed for trace-only VM execution
- `cbe_xse_trace_vm_probe.js`: runs a first trace-only VM walk over corrected XSE groups using the real dispatcher/case map
- `cbe_xse_writeback_probe.js`: compares candidate reader modes by whether direct VM cases can write results back through `operand0`
- `cbe_xse_cursor_init_probe.js`: anchors `0x11266` script cursor/reset behavior so VM traces do not invent a nonzero starting group cursor
- `cbe_xse_slot_lifecycle_probe.py`: maps runtime script-slot writes for `+0x50/+0x5C/+0x60` and times writeback blockers against cursor mutations
- `cbe_xse_operand_binding_probe.js`: separates operand0 record-layout blockers from `+0x5C/+0x60` stack-address blockers
- `cbe_xse_entrypoint_probe.js`: probes the real `0x12364/0x11A4A` label-entry path and checks candidate `+0x64` entries before promoting cursor-0 traces
- `cbe_xse_entry_label_probe.js`: cross-checks candidate `+0x64` entry refs against `INIT/_MAIN` and symbol-pool slots before enabling label-entry execution
- `cbe_xse_entry_caller_probe.py`: scans direct callers of `0x12364/0x123E4` and recovers the hard-coded `Init/_main` label arguments
- `cbe_xse_entry_compare_probe.js`: reconciles caller labels with script label slots and current `+0x64 record+0x10` candidates
- `cbe_xse_label_pointer_probe.js`: separates exact ADR label pointers from inferred full labels before promoting `0x12326` compare results
- `cbe_xse_ref_encoding_probe.js`: checks whether candidate `+0x64 record+0x10` widths produce safe requested-label matches across focused scripts
- `cbe_xse_compare_normalization_probe.js`: tests exact, pc+2, and target+/-2 caller-label normalization against current `+0x64` ref models
- `cbe_xse_tail_boundary_probe.js`: rejects requested-label ref collisions that require `+0x64` table parses to consume into text/symbol pools
- `cbe_xse_compare_service_probe.py`: anchors `[sb+0x35C4]+0x50` as both stream/cursor reader and label/ref compare service
- `cbe_xse_compare_shim_probe.js`: tests a selection-only argument-shape shim for the `0x12326` label/ref compare path
- `cbe_xse_activation_probe.js`: binds `0x11A4A` label-entry activation side effects without enabling visible script execution
- `cbe_xse_high_opcode_probe.js`: separates high-opcode record reads, numeric defaults, and `0x11AE6` writeback targets so opcode `>=9` records are preserved without fake effects
- `cbe_xse_entry_safety_probe.js`: combines compare selection, activation, dispatch, and high-opcode/writeback contracts into the generic entry-promotion gate
- `cbe_xse_ref_width_exhaustive_probe.js`: exhaustively scans the supported `+0x74/+0x64` width grid and rejects width-only rescues that still cannot pass the entry safety gate
- `cbe_xse_compare_abi_probe.js`: formalizes `[sb+0x35C4]+0x50` as a shape-polymorphic reader/compare host-service method
- `cbe_xse_ref_namespace_probe.js`: turns the unresolved `script+0x64 record+0x10` namespace into a provider-opaque compare oracle gate
- `cbe_xse_ref64_loader_probe.js`: anchors the `0x11672/0x11752` XSE `+0x64` loader ABI and rejects SCE-style inline text reuse for entry refs
- `cbe_provider_ref_context_probe.js`: splits provider-returned `[35C4]+0x64` by call context so SCE resource strings, XSE refs, and child-script handles are not conflated
- `cbe_xse_compare_resolver_boundary_probe.js`: marks the `0x12326` label/ref resolver as a host-provider service boundary instead of a static scalar/string decoder
- `cbe_provider_resolver_hook_probe.js`: verifies the provider resolver hook only accepts observed `providerRefId + label` matches and rejects label/ref-only coincidences
- `cbe_provider35c4_tape_probe.js`: builds the provider `0x35C4` event tape that separates `+0x64` ref producers, `+0x50` cursor reads, and `+0x50` label/ref compare consumers
- `cbe_provider35c4_feed_probe.js`: feeds the resolver hook only from provider tape return-0 observations and verifies an empty real feed cannot promote entries
- `cbe_provider35c4_capture_plan_probe.js`: turns the provider `0x35C4` tape/feed contract into concrete capture points for real or emulated service instrumentation
- `cbe_provider35c4_capture_source_probe.js`: adapts the current tape into a canonical provider `0x35C4` capture-source event stream and verifies compare-to-producer links
- `cbe_provider35c4_emulated_source_probe.js`: regenerates the provider `0x35C4` source from raw CBE via the ABI shim and separates `0x35C0` conversion handoffs from provider-owned events
- `cbe_provider35c4_service_object_probe.js`: materializes a reusable provider `0x35C4` service object with `+0x64` ref production and shape-polymorphic `+0x50`
- `cbe_provider35c4_service_resolver_probe.js`: verifies the service object resolver only accepts exact observed `label + providerRefId` pairs
- `cbe_provider35c4_live_call_probe.js`: feeds the provider `0x35C4` service object directly from ABI shim service-call requests and verifies parity with source replay
- `cbe_provider35c4_stream_executor_probe.js`: drives the provider `0x35C4` service object from parsed raw CBE SCE/XSE streams and checks parity with the ABI live-call feeder
- `cbe_provider35c4_table_walk_probe.js`: expands the parsed provider `0x35C4` feeder into a guarded full `0x112C4/0x11672` range-table walk
- `cbe_provider35c4_count_mode_probe.js`: diagnoses signed/count and pool-crossing ambiguity for provider table-walk modes
- `cbe_provider35c4_s02_source_mode_probe.js`: resolves the `s_02.xse` text-pool table-start blocker as a tail-aligned source-mode handoff candidate
- `cbe_provider35c4_selected_table_walk_probe.js`: reruns the provider table walk with pool-clean count modes plus the `s_02` source-mode lane
- `cbe_provider35c4_selected_feed_probe.js`: replays all selected table label/ref compares through the observed-return0 feed gate
- `cbe_provider35c4_promotion_frontier_probe.js`: classifies hypothetical selected return-0 rows through activation/dispatch/writeback safety gates
- `cbe_provider35c4_frontier_mode_scan_probe.js`: scans pool-clean source/mode candidates for scheduler-only versus direct-case promotion frontiers
- `cbe_provider35c4_return0_priority_probe.js`: orders selected and mode-scan scheduler rows as provider return-0 capture priorities without enabling execution
- `cbe_provider35c4_return0_injection_probe.js`: injects synthetic P1 return-0 rows as a plumbing check and verifies direct-case execution stays closed
- `cbe_provider35c4_return0_capture_adapter_probe.js`: imports real provider return observations from a JSON boundary and replays them through the guarded feed/frontier checks
- `cbe_provider35c4_captured_selected_feed_probe.js`: replays all selected table compares through the real capture adapter feed and joins matches back to the promotion frontier
- `cbe_provider35c4_observation_recorder_probe.js`: exports selected-table and parsed-stream provider compare events in the capture-adapter schema without writing the default native capture file
- `cbe_provider35c4_runtime_sink_probe.js`: verifies the provider service object emits the same capture-adapter observation events at runtime during selected-table and parsed-stream execution
- `cbe_runtime_core.js` / `cbe_runtime_core_probe.js`: starts the reusable generic CBE runtime shell with archive catalog/resource APIs plus a core-owned provider observation channel
- `cbe_guangming_role_probe.js`: focused evidence pass for `guangming.gif`, `LOADLIGHTGOD`, and the light-side actor resource chain
- `cbe_godwar_record_probe.js`: parses the phone-side `GodWar*Record` save files through the recovered Record serializer and links `GodWarGameRecord` back to raw CBE scene resources
- `cbe_copy_helper_probe.py`: checks the shared `0x34540/0x3453C` copy helpers and the `0x11FD2` writeback call site for null-safety evidence
- `cbe_xse_facade_normalized_probe.js`: replays `0x112C4` through the verified `0x934=>+0x4C` and `0x958=>+0x64` reader normalization, then tests whether loose `+0x50` widths can pass the opcode gate
- `cbe_xse_slot_audit.py`: checks candidate service-slot targets against the real XSE call shapes before accepting them as reader/conversion methods
- `cbe_true_runtime.js`: builds the raw-CBE runtime probe used by the viewer's VM gate panel
- `cbe_symbols.js`: scan a `.CBE` binary for source paths, resource strings, and script command tables
- `cbe_thumbdump.py`: disassemble a raw CBE byte range as ARM Thumb; requires the Python `capstone` package
- `cbe_disasm.py`, `cbe_global_refs.py`, `cbe_global_writes.py`, `cbe_global_lifecycle.py`: focused Thumb/global-reference helpers for anchoring parser behavior to engine code
- `cbe_disasm_notes.md`: current reverse-engineering notes tied to CBE raw offsets
- `viewer_server.js` + `viewer/`: local browser UI for browsing extracted resources

## What I found

- The `.CBE` files in `./cbe file` are not plain archives.
- Each game file contains one or more resource sections marked by `FE FE FE FE FE FE FE FE`.
- A section holds:
  - a small header
  - a count
  - an offset table
  - a length-prefixed name table
  - the packed resource data
- For many `.gif` resources, the payload begins with a custom palette/header block before the actual GIF image blocks.
- The emulator target is generic: `众神之战` is the current richest reverse-engineering anchor, not the final product boundary. See `CBE_EMULATOR_ROADMAP.md`.

## Usage

Build the corpus compatibility matrix:

```powershell
node .\src\cbe_corpus_matrix.js ./cbe file
```

This writes:

- `out_cbe_corpus\cbe_corpus_matrix.md`
- `out_cbe_corpus\cbe_corpus_matrix.json`

Current corpus result: 19/24 files expose standard CBE resource sections, 6 include `.sce` scenes, and only 1 includes `.xse` scripts. This means the web emulator must be feature-profile driven: archive/image/audio browsing is universal for standard CBE, while RPG-style scene/VM execution only applies to games with the `.sce/.map/.actor/.xse` stack.

Single file:

```powershell
node .\src\cbe_unpack.js "./cbe file/众神之战.CBE" .\out_godwar
```

Whole directory:

```powershell
node .\src\cbe_unpack.js "./cbe file" .\out_batch
```

Local resource viewer:

```powershell
node .\viewer_server.js
```

Open:

```text
http://127.0.0.1:4173
```

The viewer loads `out_batch\batch_manifest.json`, defaults to `众神之战`, shows rebuilt GIF thumbnails, and previews binary resources with hex plus readable text snippets.
For `.sce` files it asks `/api/true-runtime` for raw-CBE evidence first. The `Raw CBE VM Gate` panel is the current truth source for emulator work: the strict opcode-gate premise has been superseded by corrected `0x112C4` switch replay, and the trace-only VM now walks the real `0x11C3C` group dispatcher under execution-best modes. The browser still marks the scene as decoder evidence until concrete value/box semantics, high-opcode binding, and the remaining `s_04` compact/tail ambiguity are resolved. It still asks `/api/runtime` for a `Runtime Snapshot` panel with linked map/tileset, actors, and scripts as supporting evidence. Deep map bytecode diagnostics are shown when opening the `.map` resource directly, so scene previews stay responsive.
For `.sce`, `.map`, `.actor`, and `.xse` files it also asks the local server for a structure summary:

- `.sce`: detects `SCE2`, parses the scene canvas, map table, and filtered object placement candidates
- `.map`: extracts the tileset/image hint, scene size, lead header, draw stream offset, draw stream density, and byte histograms
- `.actor`: extracts the primary sprite GIF, verifies GIF dimensions/descriptors, and probes the actor metadata stream for a stable FF-heavy token pattern
- `.xse`: detects embedded engine command names when present, using the command list recovered from `众神之战.CBE`
- all data resources: shows inline resource references, likely matched resources, header words, hex, and readable text snippets
- related resources are shown as clickable cards; clicking a card jumps directly to that resource and updates the URL

Extract readable `.xse` text from `众神之战`:

```powershell
node .\src\cbe_textdump.js .\out_godwar .\out_godwar_text
```

This writes:

- `out_godwar_text\xse_text.txt`
- `out_godwar_text\xse_text.json`

Export structural summaries:

```powershell
node .\src\cbe_structdump.js .\out_godwar .\out_godwar_struct
```

This writes:

- `out_godwar_struct\resource_summary.txt`
- `out_godwar_struct\resource_summary.json`

Export focused map stream statistics:

```powershell
node .\src\cbe_mapdump.js .\out_godwar .\out_godwar_mapdump
```

This writes:

- `out_godwar_mapdump\map_streams.txt`
- `out_godwar_mapdump\map_streams.json`

Export focused actor stream statistics:

```powershell
node .\src\cbe_actordump.js .\out_godwar .\out_godwar_actordump
```

This writes:

- `out_godwar_actordump\actor_streams.txt`
- `out_godwar_actordump\actor_streams.json`

Export code-anchored stream traces for the current God War focus set:

```powershell
node .\src\cbe_streamtrace.js
```

Or trace a single resource:

```powershell
node .\src\cbe_streamtrace.js .\out_godwar\section_1_39BCD\0312_guangmingshendian.sce .\out_godwar_streamtrace_current
```

This writes:

- `out_godwar_streamtrace\stream_trace.txt`
- `out_godwar_streamtrace\stream_trace.json`

The stream trace is the preferred next-step artifact for emulator/decompiler work. It lists exact offsets, raw bytes, reader guesses, decoded values, target object fields, and disassembly anchors. It intentionally does not render maps or split sprites.

Build the current emulator/runtime scene graph:

```powershell
node .\src\cbe_runtime.js .\out_godwar\section_1_39BCD\0312_guangmingshendian.sce .\out_godwar_runtime
```

This writes:

- `out_godwar_runtime\runtime_scene.json`

The runtime graph is the first emulator milestone: it links a scene to its startup/title image candidate, inferred WQVGA screen size, map, tileset, camera, script refs, decoded actor placements, actor resources, primary GIF sheets, and current `0x0F222` template evidence. Linked `.xse` scripts now carry symbolic evidence from the object trace, skeleton trace, route trace, and ref-correlation guardrail. For `众神之战`, the startup candidate is `fengmian.gif`, which confirms a `240x400` phone-facing screen. Terrain bytecode, actor animation playback, and XSE execution are still pending.

Build the current story/role evidence report:

```powershell
node .\src\cbe_storytrace.js
```

This writes:

- `out_godwar_storytrace\story_trace.md`
- `out_godwar_storytrace\story_trace.json`

The story trace is the current priority before more emulator work. It groups light/dark resources, scene names, actor names, portraits, skill panels, and `.xse` dialogue hits. Current evidence strongly ties `巴尔德` to the light side and `霍德尔` to the dark side, but actor-control mapping is intentionally not assigned yet. Prior `heermod -> heermode.actor` control inference is treated as invalid/paused.

Build the recovered route/task evidence report:

```powershell
node .\src\cbe_route_trace.js
```

This writes:

- `out_godwar_routes\route_trace.md`
- `out_godwar_routes\route_trace.json`

This report uses `out_godwar_text\xse_text.txt`, so run `cbe_textdump.js` first if the text dump is missing. It keeps common opening evidence separate from the two route buckets. Current anchors:

- common opening: `s_02.xse`/`s_03.xse` mention 南娜, 巴尔德, 奥丁, the brothers, `zhongli.sce`, and `让我去吧！`
- light route: `gm_dialog.xse`, `gm_maintask.xse`, and `gm_taskpro.xse`, with recovered titles/tokens such as `噩梦惊魂`, `心灵神药`, `伐拉的预言`, `救治南娜`, `终极命运`, `玲珑之火`, and `九转龙潭剂`
- dark route: `ha_dialog.xse`, `ha_maintask.xse`, and `ha_taskpro.xse`, with recovered titles/tokens such as `勾结冥王`, `将计就计`, `天魔神符`, `光明神之死`, `控制冥界`, `背叛奥丁`, `封印瓦宫`, and `普拉神咒`

The report intentionally labels these as route/task evidence, not executable branch logic. The exact protagonist-selection predicate and actor-control mapping still need XSE object/table reference decoding.

Build the observed boot/title/opening flow report:

```powershell
node .\src\cbe_bootflow_trace.js
```

This writes:

- `out_godwar_bootflow\boot_flow_trace.md`
- `out_godwar_bootflow\boot_flow_trace.json`

This report is based on the real device/video flow: cold-start tip plus progress bar, skippable pre-title animation, cover/title screen with snow and image-rendered menu buttons, second loading screen, opening narration, `zhongliqu_2.gif` then `zhongliqu_1.gif`, and later light/dark protagonist choice. Direct anchors include `LOADING.gif`, `fengmian.gif`, `zhucaidan1.gif`, `kaichang.sce`, `xuanzetouxiang.gif`, `tx_guangmin.gif`, and `tx_heian.gif`. `kaichang.sce` is a `240x320` no-map scene and is a strong pre-title/opening container candidate, but its tiny scene stream is not decoded yet. The exact combo-tip sentence is now confirmed in raw pre-resource boot data by `cbe_bootdata_trace.js`; the specific pre-title caption strings and `读取进度` are still unresolved in text scans.

Scan raw pre-resource boot/title/manual text:

```powershell
node .\src\cbe_bootdata_trace.js
```

This writes:

- `out_godwar_bootdata\boot_data_trace.md`
- `out_godwar_bootdata\boot_data_trace.json`

This report explains why the `.xse` text dump missed several boot-flow strings. The raw CBE area before the first resource section contains the observed combo loading tip at `0x0359CE`, title/save strings such as `没有游戏存档，请选择新的游戏！`, the opening narration beginning `光明神巴尔德和黑暗神霍德尔...` at `0x037FC2`, and manual text explicitly saying the game has `光明神和黑暗神两个主角，剧情各不相同，任务承前启后`.

Trace the focused opening-route `.sce`/`.xse` graph:

```powershell
node .\src\cbe_xseflow.js
```

This writes:

- `out_godwar_xseflow\xse_flow_trace.md`
- `out_godwar_xseflow\xse_flow_trace.json`

This is a trace, not a full XSE VM decompiler. It currently proves the concrete resource chain `guangmingshendian.sce -> s_02.xse -> zhongli.sce -> s_03.xse`, with `s_02.xse` containing `LOADLIGHTGOD`/`SETROLEPOS` and `s_03.xse` containing `LOADDARKGOD` plus dialogue about the brothers deciding who goes to the human village.

Probe command-adjacent XSE bytes:

```powershell
node .\src\cbe_xsecmd_probe.js
```

This writes:

- `out_godwar_xsecmd\xse_command_probe.md`
- `out_godwar_xsecmd\xse_command_probe.json`

This diagnostic report keeps byte windows around `GETGAMESTATE`, `LOADLIGHTGOD`, `LOADDARKGOD`, `SETROLEPOS`, `CANSAY`, `CLOSESCRIPT`, and `OPENCR`, plus nearby command fragments such as `SCREENSIZE`, `RAMODE`, `RTDIALOG`, `SHOW`, `ROLEPOS`, and `SKILL`. It is intended to support the next XSE VM grammar pass, not to pretend command arguments are already decoded.

Resolve CBE-side script command handlers:

```powershell
python .\src\cbe_script_handler_trace.py
```

This writes:

- `out_godwar_scripthandlers\script_handler_trace.md`
- `out_godwar_scripthandlers\script_handler_trace.json`

This report supersedes the simple `handlerOffset` interpretation in `cbe_symbols.js`. The command-name table stores relative words that must be resolved from the registration code's `add r2, pc` base, not from the string-table location. With that rule, all 32 command registrations resolve; 25 land on direct prologues. Important current anchors include `SHOWDIALOG -> 0x00006C08`, `SETROLEPOS -> 0x000068A2`, `LOADLIGHTGOD -> 0x0000698A`, `LOADDARKGOD -> 0x00006904`, `CHANGESCENE -> 0x000063B4`, and `OPENCR -> 0x0000611E`. The report also infers VM argument reads such as `SETROLEPOS` using numeric arguments `[2,1,0]` before advancing 3 script arguments.

Build the focused XSE command skeleton:

```powershell
node .\src\cbe_xse_skeleton.js
```

This writes:

- `out_godwar_xseskel\xse_skeleton.md`
- `out_godwar_xseskel\xse_skeleton.json`

This is not a full VM decompiler. It combines exact command-name hits, observed command fragments, and the handler-derived argument metadata. The later XSE layout pass shows that many of these hits are tail symbol-pool entries, so apparent `SETROLEPOS` argument bundles such as `[6,37,139]` in `s_02.xse` and `[8,24,132]` in `s_04.xse` are now treated as pool-adjacent candidates, not proven executed VM operands.

Trace focused XSE file layout:

```powershell
node .\src\cbe_xse_layout_trace.js
```

This writes:

- `out_godwar_xselayout\xse_layout_trace.md`
- `out_godwar_xselayout\xse_layout_trace.json`

This report is the current guardrail for script decompilation. In `s_01.xse` through `s_04.xse` it separates the resource envelope, `XSE0`, a `0x112C4`-style object/table probe region, the embedded dialogue/resource pool, and the tail `INIT`/`_MAIN` label/symbol pool. Mixed length slots such as `.%.SCREENSIZE` and `...C.3.RAMODE` explain why simple ASCII scans see command fragments instead of complete command calls.

Trace the focused XSE object/group parser shape:

```powershell
node .\src\cbe_xse_object_trace.js
```

This writes:

- `out_godwar_xseobject\xse_object_trace.md`
- `out_godwar_xseobject\xse_object_trace.json`

This report follows the raw CBE `0x112C4` parser order more directly: stream-relative `+6` object header, group table, 0x28-byte opcode records, then trailing reference/range arrays. Current stable result across `s_01.xse` through `s_04.xse`: slot capacity reads as `8`, group count reads as `6`, and the group/opcode table ends before the text/resource pool. It now runs a tail-reader matrix for `+0x64` and `+0x74` rather than assuming compact tokens. The useful new alignment clues are: `s_01` best tail near `0x0286`, `s_02` best boundary hypothesis at `0x02A1` but still with an invalid next range-count read, `s_03` cleanly ends at `0x02C9`, and `s_04` lands at `0x02ED`. So `s_02.xse` is the current narrow blocker for decoding the post-group reference arrays.

Probe the strict XSE VM opcode gate from raw CBE:

```powershell
node .\src\cbe_xse_vm_gate_probe.js
```

This writes:

- `out_godwar_xsevmgate\xse_vm_gate_probe.md`
- `out_godwar_xsevmgate\xse_vm_gate_probe.json`

This is the current guardrail for "true simulator" work. It keeps the raw CBE XSE stream, keeps the current `+0x50` compact reader, and widens only unresolved `[sb+0x35C4]+0x4C` reads to 1..6 bytes. Result: `s_01.xse`, `s_02.xse`, and `s_03.xse` still have no strict opcode path; `s_04.xse` has only a shallow false-positive ending at `0x0041`, far before the layout boundary `0x02EE`. Therefore the next target is not another `+0x4C` width guess. The next target is reconstructing the stream object returned by `[sb+0x35C4]+0x40` and `[sb+0x35C0]+0x50`, then re-checking exact `+0x50` semantics against the real VM.

Trace XSE stream preparation:

```powershell
node .\src\cbe_xse_stream_prep_trace.js
```

This writes:

- `out_godwar_xsestreamprep\xse_stream_prep_trace.md`
- `out_godwar_xsestreamprep\xse_stream_prep_trace.json`

This report keeps the next blocker concrete. The XSE `0x112C4` path opens through `[sb+0x35C4]+0x40`, converts through `[sb+0x35C0]+0x50`, stores the result in `r4`, then starts VM reads with cursor `6`. The SCE parser uses the same `[0x35C4]+0x40` open plus `[0x35C0]+0x50` conversion shape before checking `SCE2`, proving this is a general resource-open/converted-pointer service pattern rather than an XSE-only quirk. The updated trace also corrects the `0xF224` comparison path and adds the `0x1607C` nested-table parser: both repeat the same pair before reading through `[0x35C4]+0x50`. The VM gate and facade-normalized reports still find no layout-aligned strict opcode path, so the next target is the shared conversion/cursor method, not more script-string guessing.

Trace the shared stream service chain:

```powershell
python .\src\cbe_xse_stream_service_trace.py
```

This writes:

- `out_godwar_xsestreamsvc\xse_stream_service_trace.md`
- `out_godwar_xsestreamsvc\xse_stream_service_trace.json`

This report narrows the true emulator blocker one level further. It records four matching chains: XSE `0x112C4`, the `0xEEDC` resource-table parser, the `0x1607C` nested-table parser, and the SCE parser all call `[sb+0x35C4]+0x40` to open a resource stream and `[sb+0x35C0]+0x50` to convert it before reading through `[sb+0x35C4]` cursor methods. It also lists static method-table clusters that contain `+0x38/+0x40/+0x50/+0x64`, but does not accept them as live runtime objects until the boot constructor copy/overwrite path into `0x35C4` and `0x35C0` is traced.

Trace the provider source of the live service globals:

```powershell
python .\src\cbe_xse_provider_service_trace.py
```

This writes:

- `out_godwar_xseprovidersvc\xse_provider_service_trace.md`
- `out_godwar_xseprovidersvc\xse_provider_service_trace.json`

This report resolves the next layer of that blocker. The `0x354` setup uses the flat `sb+0x3584` service block: `0x35C0 = 0x3584+0x3C` is assigned from provider method `+0x5C`, `0x35C4 = 0x3584+0x40` is assigned from provider method `+0x64`, `0x35C8` from `+0x6C`, and `0x35E0` from `+0x84`. Therefore `0x3008` only mutates/initializes the already-returned `0x35C0` and sibling `0x35C8` objects; it is not the source of the live `0x35C4` reader service. The next emulator step is to materialize or emulate provider method returns for `+0x5C/+0x64`, then inspect the live method tables behind `[35C0]+50` and `[35C4]+40/+50`.

Replay the first provider-derived service-chain slice:

```powershell
node .\src\cbe_provider_service_replay.js
```

This writes:

- `out_godwar_providerreplay\provider_service_replay_probe.md`
- `out_godwar_providerreplay\provider_service_replay_probe.json`

This is the first runnable slice of the real service model. It uses the provider assignments from `0x354`, opens `guangmingshendian.sce` through `[sb+0x35C4]+0x40`, converts it through `[sb+0x35C0]+0x50`, then reads the SCE fields through `[sb+0x35C4]+0x4C/+0x64`. The replay recovers `480x528`, one map, `guangmingshendian.map`, and fields `0,0,1,1` from raw CBE bytes. It intentionally keeps `s_02.xse` blocked: provider/open/convert provenance is now modeled, but exact `[sb+0x35C4]+0x50` cursor semantics are still required before script execution can be accepted.

Compare `+0x50` cursor-token variants against sibling parser and XSE gates:

```powershell
node .\src\cbe_cursor50_variant_probe.js
```

This writes:

- `out_godwar_cursor50variants\cursor50_variant_probe.md`
- `out_godwar_cursor50variants\cursor50_variant_probe.json`

This report keeps the next XSE step honest. It tests endian/signedness variants of `[sb+0x35C4]+0x50` against two oracles: actor `0x0F222` layout recovery on focused `.actor` resources, and the XSE `0x112C4` strict opcode gate on `s_01.xse` through `s_04.xse`. Current result: the current compact-token family remains tied for the strongest actor oracle, but no tested `+0x50` variant produces a layout-aligned XSE opcode path. That means the blocker is unlikely to be a simple primitive-token endian flip; the emulator now needs the live `[35C4]+50` method body/object state and the converted-stream base/cursor contract.

Trace the host-provider ABI returns behind the live service objects:

```powershell
python .\src\cbe_provider_abi_trace.py
```

This writes:

- `out_godwar_providerabi\provider_abi_trace.md`
- `out_godwar_providerabi\provider_abi_trace.json`

This report explains why static method-table scans keep producing attractive but wrong `+0x50` candidates. `0x34AAA` stores the incoming host/provider pointer at `0x35F8`; `0x354` then copies provider field `[host+0x08]` to `0x3588` and calls methods on that provider API object. The critical live services are provider returns: `providerApi+0x5C -> 0x35C0`, `providerApi+0x64 -> 0x35C4`, and `providerApi+0x80+0x04 -> 0x35E0`. The emulator should therefore implement a provider ABI shim for these returned service objects instead of selecting static CBE table candidates as if they were the final live methods.

Boot and exercise the host-provider ABI shim:

```powershell
node .\src\cbe_provider_abi_shim_probe.js
```

This writes:

- `out_godwar_providerabishim\provider_abi_shim_probe.md`
- `out_godwar_providerabishim\provider_abi_shim_probe.json`

This is the first runtime-shaped provider boot model. It materializes `0x35C0`, `0x35C4`, and `0x35E0` as provider-returned service objects, then replays `guangmingshendian.sce` through `[35C4]+40`, `[35C0]+50`, `[35C4]+4C`, and `[35C4]+64`, recovering `480x528`, one map, and `guangmingshendian.map`. The older XSE strict-gate result from this shim is now treated as a historical guardrail: the disassembly-correct switch replay below shows that opcode `>=9` is a legal high-opcode skip path, not a loader failure. The provider shim remains the runtime boundary while the next target moves to handler/symbol binding and tail refs.

Replay the `0x112C4` group/opcode switch with the real high-opcode path:

```powershell
node .\src\cbe_xse_switch_replay_probe.js
```

This writes:

- `out_godwar_xseswitchreplay\xse_switch_replay_probe.md`
- `out_godwar_xseswitchreplay\xse_switch_replay_probe.json`

This report corrects the previous "strict opcode gate" assumption. At `0x1148E`, the loader executes `cmp opcode,#9; bhs 0x1150E`; that branch skips the `0..8` operand switch and continues the record loop. It is not an error path. With that correction, `s_01.xse` through `s_04.xse` all replay through the `0x112C4` group/opcode table: `s_03` lands exactly at the layout boundary, `s_04` is off by one byte, `s_01` is off by ten bytes, and `s_02` remains the narrow tail-alignment blocker. The emulator should now preserve high-opcode records and bind them to the later symbol/handler tables instead of rejecting them.

Validate the replayed group ids against the runtime dispatcher:

```powershell
node .\src\cbe_xse_runtime_dispatch_probe.js
```

This writes:

- `out_godwar_xsedispatch\xse_runtime_dispatch_probe.md`
- `out_godwar_xsedispatch\xse_runtime_dispatch_probe.json`

This report ties the corrected loader replay to the later interpreter. At `0x11CF8`, `0x11C3C` dispatches group ids `0..0x20` through the jump table at `0x11D0C`; higher or negative ids fall to default `0x11FE0`. The current result still finds reader tension in `s_02.xse` and `s_04.xse`, but it now keeps a separate execution-best score: `s_04`'s compact path is rejected because its id `32` lands on the register-shape-suspect `0x15F08` overlap, while `s_02` remains compact because no equivalent register-shape contradiction has been proven. Therefore object-boundary alignment and direct-case count are both insufficient by themselves; the emulator path must choose `+0x4C` semantics by execution behavior.

Map the dispatcher cases needed by the first trace-only VM:

```powershell
python .\src\cbe_xse_dispatch_case_probe.py
```

This writes:

- `out_godwar_xsedispatchcases\xse_dispatch_case_probe.md`
- `out_godwar_xsedispatchcases\xse_dispatch_case_probe.json`

This report turns the jump table into an implementation checklist. Under the execution-best mode selector, the focused opening scripts exercise direct group ids `2,5,6,9,30,31`; the first executable milestone can therefore focus on targets `0x11D4C`, `0x11ED4`, `0x12222`, and `0x1223E`, with default handling for out-of-range ids. The apparent compact-mode id `32` target `0x15F08` is tracked as a register-shape suspect instead of an executable helper: the table entry overlaps real code and jumps into an inner table-lookup label that expects `r4` to be an object pointer, while the dispatcher path has `r4=groupId`. It also maps the script-record fields used by the interpreter: `+0x48` group table, `+0x50` current group/cursor, `+0x54` opcode record table, `+0x5C` opcode cursor, `+0x60` negative-index base, `+0x64` tail record table, `+0x68` tail count, and `+0x6C` final-ref table. This is the bridge from parser replay toward a real trace-only VM.

Walk the first trace-only VM state:

```powershell
node .\src\cbe_xse_trace_vm_probe.js
```

This writes:

- `out_godwar_xsetracevm\xse_trace_vm_probe.md`
- `out_godwar_xsetracevm\xse_trace_vm_probe.json`

This report is the first VM-shaped execution pass. It does not render gameplay yet, but it advances the real group cursor through the corrected `0x112C4` tables and `0x11C3C` dispatch cases. Current result: 22 group steps across `s_01.xse`..`s_04.xse`, with `s_03.xse` stopping when group `31` clears the active flag. The high-opcode operands seen in this walk are no longer treated as fatal or uniformly numeric: 3 high-opcode numeric operand uses default through `0x118FA/0x118D2`, while other high-opcode reads are record copies through `0x11862`. The execution-best selector now avoids the `s_04` compact group32/register-shape path and uses the tail-aligned candidate instead. The newest semantic blocker is writeback, not dispatch: 6 direct writeback steps still need `operand0` to resolve through `0x11AE6` as a valid type 3/4/8 target before visible script effects can be enabled.

Compare candidate reader modes by writeback feasibility:

```powershell
node .\src\cbe_xse_writeback_probe.js
```

This writes:

- `out_godwar_xsewriteback\xse_writeback_probe.md`
- `out_godwar_xsewriteback\xse_writeback_probe.json`

This report checks the part of the VM that a fake scene preview cannot cover: after `0x11D4C` and `0x11ED4` compute or normalize a record, the result is copied back through `0x11AE6(operand0)`. Current result: execution-best modes contain 6 direct writeback steps whose `operand0` is an immediate or high-opcode record rather than a proven type 3/4/8 target. The writeback site at `0x11FD2` has no local null guard before calling the shared copy helper, while the low-risk alternatives are mostly default-only modes. That means this is not enough to flip modes automatically; the next target is binding the live `+0x50` reader/cursor state and the `+0x54/+0x60` record stack, or proving the shared `0x34540` copy helper ignores null destinations.

Anchor VM cursor reset/start behavior:

```powershell
node .\src\cbe_xse_cursor_init_probe.js
```

This writes:

- `out_godwar_xsecursorinit\xse_cursor_init_probe.md`
- `out_godwar_xsecursorinit\xse_cursor_init_probe.json`

`0x11266` resets `+0x5C` and `+0x60`, initializes the runtime `+0x54` record stack as empty, and only seeds `+0x50` from the tail64 table when header field `+0x08` is nonzero. Current result: all 4 execution-best focused scripts have header field `+0x08=0`, so the current writeback blocker is not explained by a nonzero reset group cursor. The reset helper then calls `0x11252` to seed the opcode stack cursor/negative-index base from `field+0x04` and tail64 record state, so `+0x5C/+0x60` still need a separate binding pass.

Trace runtime script-slot lifecycle and writeback timing:

```powershell
python .\src\cbe_xse_slot_lifecycle_probe.py
```

This writes:

- `out_godwar_xseslotlifecycle\xse_slot_lifecycle_probe.md`
- `out_godwar_xseslotlifecycle\xse_slot_lifecycle_probe.json`

This report separates group cursor state from opcode-stack state. It maps the anchored writes in `0x11252`, `0x11266`, `0x11A4A`, `0x11C3C`, and the activation/deactivation helpers around `0x12286/0x122B0`. Current result: `0x11266` does not seed script `+0x50` for 4/4 execution-best focused scripts, and the first unresolved writeback in `s_01.xse`, `s_02.xse`, and `s_03.xse` happens at cursor 0 before any in-trace VM case can mutate `+0x50`. That keeps slot lifecycle in the generic emulator model, but it points the current blocker back to operand/reference binding and `+0x5C/+0x60` tail stack state rather than a hidden branch-state cursor override.

Separate operand0 binding from stack-address binding:

```powershell
node .\src\cbe_xse_operand_binding_probe.js
```

This writes:

- `out_godwar_xseoperandbinding\xse_operand_binding_probe.md`
- `out_godwar_xseoperandbinding\xse_operand_binding_probe.json`

This report checks whether the 6 unresolved writebacks are actually waiting on the `+0x54/+0x60` stack-address layer. Current result: all 6 have `operand0` outside the pointer-producing type set `3/4/8` (`1`, `100`, `129`, `249`). Some operand1 records are valid references, but the real writeback site calls `0x11AE6(operand0)`. Therefore `+0x5C/+0x60` still belongs in the generic VM, but it cannot by itself repair the current blockers; the next target is operand record boundaries and `+0x4C/+0x50` reader binding around direct value-op groups.

Probe real script label/tail entry selection:

```powershell
node .\src\cbe_xse_entrypoint_probe.js
```

This writes:

- `out_godwar_xseentrypoint\xse_entrypoint_probe.md`
- `out_godwar_xseentrypoint\xse_entrypoint_probe.json`

This report follows the runtime entry helper instead of assuming every script starts at group cursor 0. `0x12364` calls `0x12326` to scan `script+0x64` records by label/ref, then `0x11A4A` copies the selected tail record, adjusts `+0x5C/+0x60` through `0x11252`, restores selected `record+0x00` into `script+0x50`, and finally calls `0x11C3C`. Current result: 3/4 focused scripts have plausible `+0x64` entry candidates, and those same 3 have candidates that avoid the current writeback risks under the trace model. `s_02.xse` remains tail-binding unresolved, and the candidate refs still need cross-checking against script symbol pools and caller strings before visible effects can be enabled.

Cross-check candidate entry refs against label/symbol pools:

```powershell
node .\src\cbe_xse_entry_label_probe.js
```

This writes:

- `out_godwar_xseentrylabels\xse_entry_label_probe.md`
- `out_godwar_xseentrylabels\xse_entry_label_probe.json`

This report keeps the entrypoint probe honest. It compares top `+0x64` entry refs against known `INIT/_MAIN` label slots and nearby command-symbol slots using absolute, symbol-relative, text-relative, group-relative, and low-byte/low-word transforms. Current result: no focused script has a safe candidate whose ref strongly maps to `INIT` or `_MAIN`; only `s_01.xse` has safe candidates that map to command-symbol positions such as `LOADHERERSKILL` and `CLOSESCRIPT`. That proves the refs are symbol-pool-like, but not yet label-bound, so the emulator must still bind the caller-provided label/ref value and `+0x64` ref width before enabling visible script effects.

Anchor caller-provided entry labels:

```powershell
python .\src\cbe_xse_entry_caller_probe.py
```

This writes:

- `out_godwar_xseentrycallers\xse_entry_caller_probe.md`
- `out_godwar_xseentrycallers\xse_entry_caller_probe.json`

This report scans direct helper callers instead of guessing labels from script text. Current result: there are 5 direct label-entry helper calls, 2 through dispatching `0x12364` and 3 through select-only `0x123E4`. The nearby hard-coded label constants recover as `Init` and `_main`. Some ADR targets land a couple bytes into or before the ASCII storage, so the next low-level job is reconciling that pointer convention with the `[sb+0x35C4]+0x50` compare service used by `0x12326`. Emulator-wise, `Init/_main` are now real caller-provided labels; they still need to be bound to `script+0x64 record+0x10`.

Reconcile caller labels with `script+0x64` entry refs:

```powershell
node .\src\cbe_xse_entry_compare_probe.js
```

This writes:

- `out_godwar_xseentrycompare\xse_entry_compare_probe.md`
- `out_godwar_xseentrycompare\xse_entry_compare_probe.json`

This report puts the caller labels, script `INIT/_MAIN` symbol slots, and current `+0x64 record+0x10` parses into one table. Current result: requested labels are `INIT` and `_MAIN`; all 5 caller ADR pointers have nonzero deltas relative to the nearest full ASCII label (`it`, `ain`, or empty at the exact target), which means the compare service normalizes more than a plain C string pointer. Under current `+0x64` modes, only `s_01.xse` has a caller-label-shaped match, and it is unsafe because it enters a writeback-risk group. So the next real emulator step is reversing or emulating `[sb+0x35C4]+0x50` as used by `0x12326`.

Anchor the shared compare/read service shape:

```powershell
python .\src\cbe_xse_compare_service_probe.py
```

This writes:

- `out_godwar_xsecomparesvc\xse_compare_service_probe.md`
- `out_godwar_xsecomparesvc\xse_compare_service_probe.json`

This report explains why the label compare cannot be solved by treating `+0x50` as only the compact-number reader. The same `[sb+0x35C4]+0x50` slot is used by `0x112C4` as `stream,cursor` numeric/count reader, and by `0x12326` as `caller label pointer` versus `script+0x64 record+0x10` compare; the compare loop treats return `0` as a match. A generic emulator therefore needs either the concrete provider-returned `0x35C4` service object or an argument-shape shim that distinguishes `stream,cursor` reads from `label,ref` compares.

Run the first selection-only compare shim:

```powershell
node .\src\cbe_xse_compare_shim_probe.js
```

This writes:

- `out_godwar_xsecompareshim\xse_compare_shim_probe.md`
- `out_godwar_xsecompareshim\xse_compare_shim_probe.json`

This report models `[sb+0x35C4]+0x50` by argument shape without enabling visible script effects, and splits ref transforms so constant length offsets do not masquerade as entry refs. Current result: exact ADR-target text (`it`, `ain`, or empty) selects 0/4 focused scripts. The primary `nearby-full-label/text-payload` model selects only `s_01.xse`, and that selected `INIT:textRelPayload=253` record enters a writeback-risk group. The broader all-strong model first-matches implausible records in `s_01.xse` and `s_04.xse`, proving those symbol/length-offset collisions are not safe entry bindings. The next blocker is now sharper: the emulator needs the concrete `+0x64 record+0x10` ref encoding and `0x11A4A` activation side effects before the label-entry path can replace the cursor-0 trace.

Audit the caller label pointer convention:

```powershell
node .\src\cbe_xse_label_pointer_probe.js
```

This writes:

- `out_godwar_xselabelpointer\xse_label_pointer_probe.md`
- `out_godwar_xselabelpointer\xse_label_pointer_probe.json`

This report separates what the call sites literally pass from the nearby full labels we have been inferring. Current result: 5/5 direct label-entry caller pointers do not land on the recovered full label start; 4 point two bytes inside `Init/_main`, and one points two bytes before `_main`. A diagnostic `address+2+imm` back-computation reaches the full label for 4/5 calls, which explains why the strings sit tantalizingly close to the ADR target, but exact ADR-target text still selects 0/4 focused scripts and the inferred full-label shim remains unsafe. For the generic emulator, `nearby-full-label` is now explicitly a diagnostic model, not a promoted entry rule, until the provider-returned `[sb+0x35C4]+0x50` compare method or its argument-shape behavior is recovered.

Probe the `+0x64 record+0x10` ref encoding candidates:

```powershell
node .\src\cbe_xse_ref_encoding_probe.js
```

This writes:

- `out_godwar_xserefencoding\xse_ref_encoding_probe.md`
- `out_godwar_xserefencoding\xse_ref_encoding_probe.json`

This report keeps the tail-ref question separate from label-pointer normalization. Current result: no focused script has a safe requested-label `+0x64` ref candidate. `s_01.xse` has a risky `INIT:textRelPayload=253` collision under `74=compact,64=raw1`, but it enters the activated writeback blocker; the top `ref64` modes across focused scripts split as `compact`, `raw1`, `raw2le`, and `raw3le`. That rules out the simple "pick raw1 everywhere" path and keeps `+0x64 record+0x10` as unresolved ABI data until provider compare normalization or a stronger ref oracle is recovered.

Test caller label normalization strategies against current ref models:

```powershell
node .\src\cbe_xse_compare_normalization_probe.js
```

This writes:

- `out_godwar_xsecomparenormalization\xse_compare_normalization_probe.md`
- `out_godwar_xsecomparenormalization\xse_compare_normalization_probe.json`

This report shows why pointer normalization is necessary but insufficient. Exact ADR strings explain 0/5 caller labels, `pc+2` explains 4/5, and `target+/-2` explains 5/5. Even the full-coverage `target+/-2/text-payload` model still produces 0 safe focused selections and 1 writeback-risk selection, so the generic emulator cannot promote caller-pointer normalization without solving the `+0x64 record+0x10` ref side.

Guard label/ref matches with tail-boundary checks:

```powershell
node .\src\cbe_xse_tail_boundary_probe.js
```

This writes:

- `out_godwar_xsetailboundary\xse_tail_boundary_probe.md`
- `out_godwar_xsetailboundary\xse_tail_boundary_probe.json`

This report keeps requested-label collisions from being promoted when the candidate `+0x64` table parse runs into the text or symbol pool. Current result: `s_01.xse` has a boundary-clean `textRelPayload` label match, but it is still writeback-risk; `s_04.xse` only gets a text-payload collision from a crossing parse; and 0/4 focused scripts have a boundary-clean safe requested-label `text-payload` selection. The next target is the provider `+0x64` ref reader or the true range-table count/width, not visible script effects.

Bind label-entry activation side effects without running gameplay:

```powershell
node .\src\cbe_xse_activation_probe.js
```

This writes:

- `out_godwar_xseactivation\xse_activation_probe.md`
- `out_godwar_xseactivation\xse_activation_probe.json`

This report turns `0x11A4A` into a generic state-transition contract. `0x11954` copies `script+0x64[selectedIndex]`, `0x11A0E` pushes a transformed runtime record into `+0x54[+0x5C]`, `0x11252` adds selected `record+0x08+1` to `+0x5C/+0x60`, and `0x11AA8` restores selected `record+0x00` into `script+0x50`. Current result: the primary compare-shim selection in `s_01.xse` would set cursor `2` and stack delta `8`, but it still leads to a writeback-risk dispatch. The all-strong diagnostic selections in `s_01.xse` and `s_04.xse` would restore invalid cursors, so they remain rejected.

Join label-entry activation to the trace VM dispatch step:

```powershell
node .\src\cbe_xse_activated_dispatch_probe.js
```

This writes:

- `out_godwar_xseactivateddispatch\xse_activated_dispatch_probe.md`
- `out_godwar_xseactivateddispatch\xse_activated_dispatch_probe.json`

This report checks the activation result against the no-effects interpreter trace. Current result: `activated-dispatch-writeback-blocked`. The only primary selection, `s_01.xse` entry `26`, restores cursor `2`, dispatches group `6` at `0x011ED4`, and immediately lands on an unresolved writeback where operand0 is `0x64/high-opcode-no-target`. Because that operand is not a type `3/4/8` destination, the activation `+0x5C/+0x60` delta cannot repair it. This keeps the generic emulator state transition valid while keeping visible script effects disabled.

Check whether the activated blocker is a simple operand-boundary mistake:

```powershell
node .\src\cbe_xse_activated_operand_probe.js
```

This writes:

- `out_godwar_xseactivatedoperand\xse_activated_operand_probe.md`
- `out_godwar_xseactivatedoperand\xse_activated_operand_probe.json`

This report binds the activated group bytes to the disassembled operand-index contract. Current result: `activated-operand0-boundary-stable`. For `s_01.xse`, group `6` starts at `0x00D8`, its first decoded record is stable at `0x00DB`, and operand0 remains `0x64` even under the nearby one-byte compact-id interpretation. The case code at `0x11EDA..0x11EDE` reads operand index `0`, and the writeback at `0x11FD2..0x11FD4` writes operand index `0`, so later pointer-looking records in the same group are not the destination. The cheap fix is ruled out; next work moves to concrete `+0x64 record+0x10` compare/ref encoding and high-opcode writeback semantics.

Separate high-opcode record semantics from writeback targets:

```powershell
node .\src\cbe_xse_high_opcode_probe.js
```

This writes:

- `out_godwar_xsehighopcode\xse_high_opcode_probe.md`
- `out_godwar_xsehighopcode\xse_high_opcode_probe.json`

This report narrows the current activated blocker. Current result: `high-opcode-writeback-blocked`. The loader-valid `opcode>=9` records are not corrupt data: `0x11862` can copy them as records, and `0x118D2` can turn them into numeric `0` only when a case actually calls the numeric-value helper. But the activated `s_01.xse` path enters group `6`, which is an identity writeback path: it copies operand0 `0x64` as a record and falls through to `0x11FD2`, where `0x11AE6(operand0)` still returns null because only types `3/4/8` produce destinations. This means high-opcode value semantics cannot rescue the current label-entry candidate; the next generic-emulator move is to demote such entry selections and keep binding the true `+0x64` range/ref layout until the selected entry reaches a real destination or a non-writeback case.

Promote only label entries that pass the full runtime safety gate:

```powershell
node .\src\cbe_xse_entry_safety_probe.js
```

This writes:

- `out_godwar_xseentrysafety\xse_entry_safety_probe.md`
- `out_godwar_xseentrysafety\xse_entry_safety_probe.json`

This report turns the manual blocker into a reusable emulator rule. Current result: `entry-safety-no-promotable-selection`. The active `nearby-full-label/text-payload` compare model selects only `s_01.xse` entry `26`, but the activated path restores cursor `2`, dispatches group `6`, and hits operand0 `0x64` on an identity writeback path. That entry is now automatically demoted as `entry-demoted-high-opcode-writeback`; `s_02.xse`, `s_03.xse`, and `s_04.xse` remain unmatched under the active model, while the broad all-strong diagnostics still restore invalid cursors in `s_01.xse` and `s_04.xse`. So the generic simulator must keep label-entry script effects trace-only until the real `+0x64` range/ref layout produces a selection that also passes activation, dispatch, and destination safety.

Exhaust the current guessed ref-width grid before moving deeper:

```powershell
node .\src\cbe_xse_ref_width_exhaustive_probe.js
```

This writes:

- `out_godwar_xserefwidthsafety\xse_ref_width_safety_probe.md`
- `out_godwar_xserefwidthsafety\xse_ref_width_safety_probe.json`

This report prevents a false shortcut. Current result: `ref-width-safety-unsafe-only`. It scans all 100 supported `+0x74/+0x64` mode pairs for each focused script and finds `0` first requested-label matches safe for scheduling, `0` safe requested-label matches total, and `114` requested-label matches that are still unsafe or implausible. So the next step is below the width grid: recover the provider-backed `+0x50` compare/reader ABI and the true `+0x64` range-table count/ref encoding, rather than picking another guessed `ref64` width or a later same-mode collision.

Bind the provider reader method as a reader/compare ABI, not a single primitive:

```powershell
node .\src\cbe_xse_compare_abi_probe.js
```

This writes:

- `out_godwar_xsecompareabi\xse_compare_abi_probe.md`
- `out_godwar_xsecompareabi\xse_compare_abi_probe.json`

This report turns the `+0x50` ambiguity into a host-service contract. Current result: `compare-abi-branch-documented`. The provider-returned `[sb+0x35C4]` reader service uses `+0x50` in three `stream,cursor` read windows and one `caller-label/ref` compare window. The compare call at `0x1233C` passes `r0=caller label pointer`, `r1=script+0x64 record+0x10`, and treats return `0` as a match. The ABI shim now documents `+0x50` as an argument-shape dispatcher, so the remaining blocker is the ref namespace behind `script+0x64 record+0x10`, not the service slot shape.

Gate `record+0x10` behind the provider ref namespace instead of scalar string offsets:

```powershell
node .\src\cbe_xse_ref_namespace_probe.js
```

This writes:

- `out_godwar_xserefnamespace\xse_ref_namespace_probe.md`
- `out_godwar_xserefnamespace\xse_ref_namespace_probe.json`

This report keeps the simulator honest at the exact boundary where fake execution would creep in. Current result: `ref-namespace-provider-opaque-unbound`. Exact ADR-target strings still select `0/4` focused scripts, the exhaustive scalar width grid still has `0` first-safe and `0` safe requested-label matches, and the `114` scalar collisions remain unsafe or implausible. So the generic emulator must treat `script+0x64 record+0x10` as a provider-opaque ref until `[sb+0x35C4]+0x64` refs can be bound to normalized `Init/_main` caller labels through the `[sb+0x35C4]+0x50` compare oracle. While that resolver is unbound, the shim returns non-match and visible XSE effects stay disabled.

Anchor the XSE `+0x64` loader store sites:

```powershell
node .\src\cbe_xse_ref64_loader_probe.js
```

This writes:

- `out_godwar_xseref64loader\xse_ref64_loader_probe.md`
- `out_godwar_xseref64loader\xse_ref64_loader_probe.json`

This report nails down where `record+0x10` comes from. The range table loader at `0x11672` allocates `count * 0x14`, then stores `[sb+0x35C4]+0x64` return values at range-record `+0x10`; `record+0x0C` is derived from `field+0x04 + field+0x08 + 1`, not read from the stream. Current result: `ref64-loader-provider-opaque`. The active selected `s_01.xse` entry `26` has `ref@0x02A0 raw=0xFD`, which is not an inline length-prefixed text ref. So the SCE resource-name flavor of `+0x64` cannot simply be reused for XSE entry refs; the emulator needs a call-context provider model: resource-name refs for SCE, opaque range/final refs for XSE until the compare namespace is bound.

Split provider `[35C4]+0x64` by call context:

```powershell
node .\src\cbe_provider_ref_context_probe.js
```

This writes:

- `out_godwar_providerrefcontext\provider_ref_context_probe.md`
- `out_godwar_providerrefcontext\provider_ref_context_probe.json`

This report turns the loader finding into a generic emulator rule. Current result: `provider-ref-context-split`. There are four current `+0x64` contexts: SCE resource names are text-safe length-prefixed strings; XSE range entries are provider-opaque refs consumed by the `0x12326` label/ref compare; XSE final refs are provider-opaque table entries; and child-script reads return handles passed into `0x112C4`. The provider ABI shim now exposes `readProviderRef(..., { context })`, routes range-entry handles into `compareLabelRef(label, ref)`, and keeps the legacy `readRef()` as an SCE-only compatibility wrapper. Visible XSE effects remain disabled until the provider-side resolver behind `[35C4]+0x50` is recovered.

Anchor the compare resolver boundary:

```powershell
node .\src\cbe_xse_compare_resolver_boundary_probe.js
```

This writes:

- `out_godwar_xsecompareresolver\xse_compare_resolver_boundary_probe.md`
- `out_godwar_xsecompareresolver\xse_compare_resolver_boundary_probe.json`

This report decides where to spend effort next. Current result: `compare-resolver-host-boundary`. The `0x12326` label/ref loop loads `+0x50` from the provider-returned `0x35C4` reader service and treats return `0` as match; the resolver target is not a statically recovered CBE function. The ABI shim now has a provider namespace ledger with `19` refs, `18` opaque refs, and `36` compare consumers, all still unbound, plus an observed-match-only resolver hook. So the next step is feeding that hook with real provider observations from `+0x64` ref creation and `+0x50` compare results, not another scalar ref-width sweep.

Verify that the resolver hook is guarded:

```powershell
node .\src\cbe_provider_resolver_hook_probe.js
```

This writes:

- `out_godwar_providerresolverhook\provider_resolver_hook_probe.md`
- `out_godwar_providerresolverhook\provider_resolver_hook_probe.json`

This probe uses a synthetic observed pair only to test the hook mechanics. Current result: `resolver-hook-guarded`. The hook returns the `0x12326` return-0 shape only for an exact observed `label + providerRefId` pair, while same-label/wrong-ref and wrong-label/same-ref checks return non-match. This gives the emulator a safe future insertion point for real provider observations without enabling visible effects from guessed refs.

Build the provider `0x35C4` instrumentation tape:

```powershell
node .\src\cbe_provider35c4_tape_probe.js
```

This writes:

- `out_godwar_provider35c4tape\provider35c4_tape_probe.md`
- `out_godwar_provider35c4tape\provider35c4_tape_probe.json`

This probe shapes the next runtime bridge. Current result: `provider35c4-instrumentation-tape-ready`. The tape keeps `+0x64` producer events, `+0x50` stream/cursor reads, and `+0x50` label/ref compare consumers distinct while preserving `providerRefId` identity. The current shim tape has no observed return-0 label/ref rows, so the resolver hook feed remains empty and visible effects stay disabled. The next step is replacing the shim-derived tape source with real provider `0x35C4` instrumentation.

Replay the observed provider feed through the resolver hook:

```powershell
node .\src\cbe_provider35c4_feed_probe.js
```

This writes:

- `out_godwar_provider35c4feed\provider35c4_feed_probe.md`
- `out_godwar_provider35c4feed\provider35c4_feed_probe.json`

This probe makes the hook input path concrete. Current result: `provider35c4-feed-guarded-empty`. It derives resolver feed rows only from tape compare events where provider `+0x50` returned `0`, then replays all current label/ref compares through `createObservedProviderRefResolver`. The current tape has `0` observed feed rows, `36` replayed compares, `0` resolver matches, and `0` promotion-eligible rows. Visible XSE effects therefore remain disabled by the feed contract as well as by entry-safety/writeback gates.

Build the provider `0x35C4` capture plan:

```powershell
node .\src\cbe_provider35c4_capture_plan_probe.js
```

This writes:

- `out_godwar_provider35c4capture\provider35c4_capture_plan_probe.md`
- `out_godwar_provider35c4capture\provider35c4_capture_plan_probe.json`

This probe turns the tape/feed contract into implementation points for the generic emulator. Current result: `provider35c4-capture-plan-ready`. It lists the concrete capture points: SCE `+0x64` resource-name producer, XSE `0x1173C` range-ref `+0x64` producer, XSE `0x11792` final-ref `+0x64` producer, three stream/cursor `+0x50` reads, and the `0x1233C` label/ref `+0x50` compare where return `0` may feed the resolver. All capture points are ready under current evidence, but observed matches and promotion candidates remain `0`.

Build the provider `0x35C4` capture source adapter:

```powershell
node .\src\cbe_provider35c4_capture_source_probe.js
```

This writes:

- `out_godwar_provider35c4source\provider35c4_capture_source_probe.md`
- `out_godwar_provider35c4source\provider35c4_capture_source_probe.json`

This probe turns the current shim tape into the replaceable source shape the generic emulator can consume. Current result: `provider35c4-capture-source-shim-adapter-ready`. It emits `104` canonical source events, including `19` ref producers, `49` cursor reads, and `36` label/ref compares. All `36` compares link back to an earlier `+0x64` providerRefId producer, and the observed feed remains `0`, so visible XSE effects remain disabled. The next step is replacing this shim-tape adapter with live or emulated provider calls at `0x1173C` and `0x1233C`.

Regenerate the provider `0x35C4` source from raw CBE through the ABI shim:

```powershell
node .\src\cbe_provider35c4_emulated_source_probe.js
```

This writes:

- `out_godwar_provider35c4emu\provider35c4_emulated_source_probe.md`
- `out_godwar_provider35c4emu\provider35c4_emulated_source_probe.json`

This probe removes one shim-tape dependency. Current result: `provider35c4-emulated-source-parity-ready`. It rebuilds the provider-owned `0x35C4` source directly from the ABI shim run over the raw CBE: `95` source events, `19` `+0x64` producers, `40` `+0x50` cursor reads, and `36` label/ref compares. It matches the provider-owned subset of the previous source adapter, while explicitly excluding `9` `[sb+0x35C0]+0x50` conversion handoffs that should stay in the stream-conversion service. Observed feed remains `0`, so visible effects remain disabled.

Materialize the provider `0x35C4` service object:

```powershell
node .\src\cbe_provider35c4_service_object_probe.js
```

This writes:

- `out_godwar_provider35c4svcobj\provider35c4_service_object_probe.md`
- `out_godwar_provider35c4svcobj\provider35c4_service_object_probe.json`

This probe turns the source contract into a reusable service boundary. Current result: `provider35c4-service-object-ready`. The service object replays `95` provider-owned source events with `19` `+0x64` ref-producer operations, `40` `+0x50` cursor-read operations, and `36` `+0x50` label/ref compare operations. The object owns only `0x35C4` slots, keeps `[sb+0x35C0]+0x50` conversion outside, and makes `+0x50` shape-polymorphism explicit: stream/cursor reads and label/ref compares are separate dispatch forms. The observed feed is still empty, so all label/ref compares return non-match and visible effects remain disabled.

Verify the provider `0x35C4` service resolver guard:

```powershell
node .\src\cbe_provider35c4_service_resolver_probe.js
```

This writes:

- `out_godwar_provider35c4svcresolver\provider35c4_service_resolver_probe.md`
- `out_godwar_provider35c4svcresolver\provider35c4_service_resolver_probe.json`

This probe validates the future insertion point for real return-0 observations. Current result: `provider35c4-service-resolver-guarded`. With the production feed empty, the target pair still returns non-match. When a synthetic observed pair is injected, only that exact `label + providerRefId` returns `0`; same-label/wrong-ref and wrong-label/same-ref checks both return non-match. This keeps visible effects disabled while proving how real provider observations will be admitted later.

Feed the provider `0x35C4` service object from live call requests:

```powershell
node .\src\cbe_provider35c4_live_call_probe.js
```

This writes:

- `out_godwar_provider35c4livecall\provider35c4_live_call_probe.md`
- `out_godwar_provider35c4livecall\provider35c4_live_call_probe.json`

This probe moves the service boundary one step closer to real execution. Current result: `provider35c4-live-call-feeder-ready`. It feeds the provider `0x35C4` service object directly from ABI shim service-call requests instead of prebuilt source events: `95` call requests, `19` `+0x64` producers, `40` `+0x50` cursor reads, `36` `+0x50` label/ref compares, and `19` known refs. The direct call signature matches the prior service-object source replay, all compares consume prior refs, and the observed feed remains empty, so visible effects stay disabled. The next step is replacing the ABI-shim trace call feeder with parsed live stream execution that invokes `0x35C4` methods at the SCE/XSE call sites.

Drive the provider `0x35C4` service object from parsed raw streams:

```powershell
node .\src\cbe_provider35c4_stream_executor_probe.js
```

This writes:

- `out_godwar_provider35c4streamexec\provider35c4_stream_executor_probe.md`
- `out_godwar_provider35c4streamexec\provider35c4_stream_executor_probe.json`

This probe removes the ABI trace event list from the call source. Current result: `provider35c4-parsed-stream-feeder-ready`. It parses raw CBE SCE/XSE resources, calls the provider `0x35C4` service object during stream reads, and uses the ABI live-call report only as a parity oracle. The parsed stream emits `95` calls with `19` `+0x64` producers, `40` `+0x50` cursor reads, `36` `+0x50` label/ref compares, `19` refs, row parity, operation parity, and `0` return-0 compares. The next step is moving from sampled XSE ref offsets into the full `0x112C4` table walk, then admitting only real provider `+0x50` return-0 observations into entry promotion.

Expand the parsed feeder into a guarded `0x112C4/0x11672` table walk:

```powershell
node .\src\cbe_provider35c4_table_walk_probe.js
```

This writes:

- `out_godwar_provider35c4tablewalk\provider35c4_table_walk_probe.md`
- `out_godwar_provider35c4tablewalk\provider35c4_table_walk_probe.json`

This probe moves beyond sampled offsets while still refusing fake execution. Current result: `provider35c4-full-table-walk-guarded`. It walks the current top `+0x74/+0x64` table candidates through the provider `0x35C4` service object, emitting `306` range-entry refs, `626` `+0x50` cursor reads, and `612` `+0x50` label/ref compares across `8` candidate lanes. All compares consume prior refs, `0` return-0 rows are observed, and every lane remains guarded because at least one count/final-ref count is negative or suspicious. The next step is resolving the signed/count and final-ref mode ambiguity before any entry promotion is allowed.

Diagnose provider `0x35C4` count/ref-width mode ambiguity:

```powershell
node .\src\cbe_provider35c4_count_mode_probe.js
```

This writes:

- `out_godwar_provider35c4countmode\provider35c4_count_mode_probe.md`
- `out_godwar_provider35c4countmode\provider35c4_count_mode_probe.json`

This probe keeps the generic table loader from mistaking text/resource bytes for table data. Current result: `provider35c4-count-mode-guarded`. It proves the negative full-table counts are not fixed by blindly treating compact bytes as unsigned: the top lanes for `s_01.xse`, `s_02.xse`, `s_03.xse`, and `s_04.xse` still hit negative final counts or cross into text/pool bytes. Pool-clean alternatives are selected for `s_01.xse` (`74=fixed5,64=compact`), `s_03.xse` (`74=compact,64=compact`), and `s_04.xse` (`74=raw1,64=raw2le`); `s_02.xse` remains blocked because the current group-end/table start lands inside text/resource bytes.

Resolve the `s_02.xse` table-start/source-mode blocker:

```powershell
node .\src\cbe_provider35c4_s02_source_mode_probe.js
```

This writes:

- `out_godwar_provider35c4s02source\provider35c4_s02_source_mode_probe.md`
- `out_godwar_provider35c4s02source\provider35c4_s02_source_mode_probe.json`

This probe separates a dispatch-score false positive from a table-loader handoff. Current result: `provider35c4-s02-source-mode-tailend-candidate-ready`. The compact dispatch-scored mode ends at `0x03D0`, already inside the text/resource pool (`textStart=0x031F`), so it cannot be used as the table start. The tail-aligned `u16le` path has `tailEnd=0x02A1`, and that anchored offset has exactly one pool-clean table parse: `74=fixed5,64=raw1`, `15` range entries, `13` final refs, ending at `0x031B`, four bytes before the text pool. Walking that candidate through the provider service object expands `2/2` lanes with `0` guards, `56` provider refs, `64` cursor reads, and `60` label/ref compares, still with `0` return-0 rows.

Rerun the provider table walk with selected pool-clean modes:

```powershell
node .\src\cbe_provider35c4_selected_table_walk_probe.js
```

This writes:

- `out_godwar_provider35c4selectedtable\provider35c4_selected_table_walk_probe.md`
- `out_godwar_provider35c4selectedtable\provider35c4_selected_table_walk_probe.json`

This is the safer lane selector for the generic CBE loader. Current result: `provider35c4-selected-table-walk-ready`. It expands `8/8` selected lanes with `0` count guards: `s_01/s_03/s_04` use count/ref alternatives, and `s_02` uses the tail-aligned `0x02A1` source-mode handoff. The selected walk now emits `238` provider refs, `284` cursor reads, and `268` label/ref compares, and still observes `0` provider `+0x50` return-0 compare rows. That means table-loader coverage improved across all four focused scripts, but visible XSE effects and entry promotion still require real provider return-0 observations.

Replay selected table compares through the observed-return0 feed gate:

```powershell
node .\src\cbe_provider35c4_selected_feed_probe.js
```

This writes:

- `out_godwar_provider35c4selectedfeed\provider35c4_selected_feed_probe.md`
- `out_godwar_provider35c4selectedfeed\provider35c4_selected_feed_probe.json`

This probe extends the older sampled-feed guard to the full selected table walk. Current result: `provider35c4-selected-feed-guarded-empty`. All `268/268` selected label/ref compares are replayed through `createObservedProviderRefResolver`; because there are still `0` provider return-0 rows, the observed feed has `0` rows, the resolver returns `0` matches, and there are `0` promotion-eligible rows. The selected table can now be walked as loader evidence across all four focused scripts, but real gameplay still requires captured/emulated provider return-0 compare observations plus activation/writeback safety.

Classify selected return-0 candidates through the promotion frontier:

```powershell
node .\src\cbe_provider35c4_promotion_frontier_probe.js
```

This writes:

- `out_godwar_provider35c4frontier\provider35c4_promotion_frontier_probe.md`
- `out_godwar_provider35c4frontier\provider35c4_promotion_frontier_probe.json`

This probe answers the next safety question: if a selected provider compare later returns `0`, would that row actually be safe to activate? Current result: `provider35c4-promotion-frontier-guarded`. It classifies all `268` selected compares through the `0x11A4A` activation shape, the `0x11C3C` dispatcher, and writeback operand rules. Only `4` rows have both a valid record cursor and coherent stack delta, and all four are `s_04.xse` rows that fall through the default dispatcher (`groupId=57608 -> 0x011FE0`) rather than a direct case. Therefore the direct-case promotion frontier is still `0`: even a future return-0 observation must pass this frontier before visible script effects are enabled.

Scan broader source/mode candidates against that same frontier:

```powershell
node .\src\cbe_provider35c4_frontier_mode_scan_probe.js
```

This writes:

- `out_godwar_provider35c4frontiermodes\provider35c4_frontier_mode_scan_probe.md`
- `out_godwar_provider35c4frontiermodes\provider35c4_frontier_mode_scan_probe.json`

This probe keeps table-mode refinement generic instead of tuning only one selected lane. Current result: `provider35c4-frontier-mode-scan-guarded`. It scans `425` source/mode candidates across the four focused XSE scripts, keeps `107` pool-clean candidates, finds `28` scheduler-only modes, and finds `0` direct-case promotion modes. The scheduler-only modes make good live capture priorities, but they still do not justify visible XSE execution because no row has both observed provider return-0 evidence and a direct-case promotion frontier.

Order the provider return-0 capture targets:

```powershell
node .\src\cbe_provider35c4_return0_priority_probe.js
```

This writes:

- `out_godwar_provider35c4return0priority\provider35c4_return0_priority_probe.md`
- `out_godwar_provider35c4return0priority\provider35c4_return0_priority_probe.json`

This probe turns the frontier evidence into a concrete observation queue for the generic emulator. Current result: `provider35c4-return0-priority-ready`. P1 has `4` selected-table rows with known providerRefIds (`ref193/ref217`) at the label/ref compare site, while P2/P3 has `56` mode-scan compare rows across `28` scheduler-only modes that still require live `+0x64` providerRefIds. Direct-case and executable priority rows remain `0`, so this is a capture plan rather than an execution permission.

Replay the P1 feed path with synthetic return-0 rows:

```powershell
node .\src\cbe_provider35c4_return0_injection_probe.js
```

This writes:

- `out_godwar_provider35c4return0inject\provider35c4_return0_injection_probe.md`
- `out_godwar_provider35c4return0inject\provider35c4_return0_injection_probe.json`

This probe is a plumbing check, not a source of truth. Current result: `provider35c4-return0-injection-guarded`. Injecting the four P1 `label + providerRefId` pairs makes the observed-match resolver return `0` for `4/4` rows, proving the feed path can admit exact real observations. All four rows still join the promotion frontier as `frontier-default-dispatch-only`, with `0` direct-case rows and `0` executable rows, so visible XSE effects remain disabled.

Import real provider return observations:

```powershell
node .\src\cbe_provider35c4_return0_capture_adapter_probe.js
```

This writes:

- `out_godwar_provider35c4return0capture\provider35c4_return0_capture_adapter_probe.md`
- `out_godwar_provider35c4return0capture\provider35c4_return0_capture_adapter_probe.json`
- `out_godwar_provider35c4return0capture\provider35c4_return0_observations.template.json`

This probe is the replacement boundary for the synthetic P1 injection. Current result: `provider35c4-return0-capture-adapter-empty` because `provider35c4_return0_observations.json` has not been captured yet. The adapter defines the real observation schema for `provider35c4-label-ref-compare-1` at `0x0001233C`; only rows with `returnValue === 0` and a known `label + providerRefId` enter the observed feed. With the file missing, imported rows, feed rows, P1 matches, direct-case rows, and executable rows all stay `0`.

Replay selected table compares through the real capture feed:

```powershell
node .\src\cbe_provider35c4_captured_selected_feed_probe.js
```

This writes:

- `out_godwar_provider35c4capturedfeed\provider35c4_captured_selected_feed_probe.md`
- `out_godwar_provider35c4capturedfeed\provider35c4_captured_selected_feed_probe.json`

This probe connects the real observation boundary to the full selected-table compare surface. Current result: `provider35c4-captured-selected-feed-empty`. It replays `268/268` selected compares through the capture adapter feed and joins `268/268` rows back to the promotion frontier. Because the capture adapter is still empty, observed feed rows, resolver matches, direct matches, and executable matches all remain `0`.

Export provider compare observations through the shared recorder schema:

```powershell
node .\src\cbe_provider35c4_observation_recorder_probe.js
```

This writes:

- `out_godwar_provider35c4recorder\provider35c4_observation_recorder_probe.md`
- `out_godwar_provider35c4recorder\provider35c4_observation_recorder_probe.json`
- `out_godwar_provider35c4recorder\provider35c4_observation_events.json`

This probe gives the emulator a common event sink for native hooks, JS service replay, and fixtures. Current result: `provider35c4-observation-recorder-nonfeed-ready`. It exports `268` selected-table compare events plus `36` parsed-stream compare events in the same adapter schema, but writes only a non-authoritative fixture instead of the default native capture file. The existing capture adapter imports all `304` rows as non-match evidence with `0` feed rows and `0` executable rows.

Verify the service-object runtime emits provider observations directly:

```powershell
node .\src\cbe_provider35c4_runtime_sink_probe.js
```

This writes:

- `out_godwar_provider35c4runtimesink\provider35c4_runtime_sink_probe.md`
- `out_godwar_provider35c4runtimesink\provider35c4_runtime_sink_probe.json`
- `out_godwar_provider35c4runtimesink\provider35c4_runtime_observation_events.json`

This probe moves the provider observation boundary from offline report extraction into the runtime service path via `cbe_provider_observation_channel.js`. Current result: `provider35c4-runtime-sink-nonfeed-ready`. The `Provider35C4ServiceObject` emits `268` selected-table compare observations and `36` parsed-stream compare observations while executing; selected events preserve entry metadata for later frontier joins. The adapter imports all `304` runtime rows as non-match evidence, and the selected-feed/frontier replay still has `0` feed rows, `0` resolver matches, and `0` executable rows.

Build the reusable generic runtime core:

```powershell
node .\src\cbe_runtime_core_probe.js
```

This writes:

- `out_cbe_runtime_core\cbe_runtime_core_probe.md`
- `out_cbe_runtime_core\cbe_runtime_core_probe.json`
- `out_cbe_runtime_core\runtime_core_provider35c4_observations.json`

This probe moves the work toward a universal CBE web emulator instead of a single-game port. Current result: `cbe-runtime-core-ready`. `CbeRuntimeCore` loads raw CBE archives, exposes a stable resource catalog/API, builds resource-profile capability summaries, constructs provider `0x35C4` service helpers, and owns the provider observation channel. In the current corpus it loads `19/24` CBE files, exposes `489` resources for `众神之战`, and emits the same `304` provider compare observations through the core channel. All `304` rows import as non-match evidence, with `0` feed rows and `0` executable rows, so visible effects remain disabled.

The viewer server now uses this core for raw CBE access: `/api/cbe-core` returns the core catalog/capability summary directly from a `.CBE`, `/cbe-asset` resolves resources through `CbeRuntimeCore.readResource()`, and `/api/cbe-bytes` plus `/api/cbe-struct` expose core-native bytes/structure summaries without relying on the extracted `out_batch` files. `cbe_runtime.js` also exposes `buildRuntimeSceneFromCore()`, and the viewer calls `/api/cbe-runtime` for SCE previews. If no scene is requested the generic path chooses the first `.sce` in the CBE instead of hardcoding a Godwar scene; `guangmingshendian.sce` remains a requested parity anchor where the core-native path recovers `489` resources, a `480 x 528` scene, `guangmingshendian.map`, `zhongliqu_1.gif`, `3` entities, and `1` linked script. `/api/cbe-emulator` runs the same core-native runtime through the emulator state/frame machine; four confirm actions reach a `scene` frame at tick `4` with `3` entities for that anchor.

The corpus scene probe checks that path against every standard scene-bearing CBE instead of only the richest anchor:

```powershell
node .\src\cbe_runtime_core_scene_probe.js
```

This writes:

- `out_cbe_runtime_core_scene\cbe_runtime_core_scene_probe.md`
- `out_cbe_runtime_core_scene\cbe_runtime_core_scene_probe.json`

Current result: `cbe-runtime-core-scene-ready`. The core-native scene/emulator path builds `148/148` scene resources across `6/6` scene-bearing CBE files, exposes canvas dimensions for all 148, produces 148 final `scene` frames after four confirm actions, and keeps 148 baseline directional/center input smoke runs on scene frames. The compatibility matrix currently shows `8` map-linked scenes (`3` from SCE map tables and `5` from direct length-prefixed `.map` refs), `8` tileset-linked scenes, `107` scenes with entities, `3` script-linked scenes, and `35` boot-flow-linked scenes. All `8/8` linked maps now also produce raw-CBE buffer map-trace hints through `analyzeMapBuffer()`: atlas dimensions resolve for all 8, draw-record candidates exist for all 8, RLE candidates exist for all 8, and `6/8` currently produce full-grid diagnostic tile candidates. Those tile candidates are hidden by default in the viewer and only shown with `mapCandidate=1`; they are renderer evidence, not terrain execution. The default Godwar file preference was also removed so the generic viewer no longer treats `guangmingshendian.sce` as a universal entry. The `众神之战` anchor still validates `guangmingshendian.sce` with `480 x 528`, `3` entities, and `1` script while the same path also covers all scenes in `愤怒的小鸟`, `鬼吹灯`, `皇牌空战`, `魔塔`, and `枪之荣誉`.

Probe screenshot-grounded UI/visual asset evidence from raw CBE resources:

```powershell
node .\src\cbe_ui_asset_probe.js
```

This writes:

- `out_cbe_ui_asset\ui_asset_probe.md`
- `out_cbe_ui_asset\ui_asset_probe.json`

Current result: `cbe-ui-asset-probe-ready`. The probe scans `众神之战.CBE` through `CbeRuntimeCore`, cataloging `283` image resources and `115` actor resources. It records the new device-reference observations: the real `光明神殿` view is an ice/water temple scene with a CBE-texture HUD/softbar overlay; the old RLE tile-grid preview is visually wrong and must stay diagnostic-only; the grid/shutter footage is a screen-transition/compositor candidate; and the reported `15fps` remains a timing hypothesis. Resource timing does not prove `15fps`: all `283` GIFs have graphic-control blocks but `0` positive delay values and no multi-frame GIFs. The strongest UI candidates are `touxiang*`, `honggang.gif`, `hongzi.gif`, `jibieziti*.gif`, `jinbi*.gif`, `caidan*`, `renwu*`, `jineng*`, and `guangminshenlan_jineng*.gif`. The strongest light-temple visual candidates include `zhongliqu_1.gif`, `shuitai.gif`, `shidui.gif`, `shijiezhishu.gif`, `diaoxiang.gif`, `heermode.gif`, `nanna.gif`, `fali.gif`, and `lang.gif`.

Probe the exact `guangming.gif` role-resource question without promoting a guessed sprite composition:

```powershell
node .\src\cbe_guangming_role_probe.js
```

This writes:

- `out_cbe_guangming_role\guangming_role_probe.md`
- `out_cbe_guangming_role\guangming_role_probe.json`

Current result: `cbe-guangming-role-probe-ready`. The target image `section_1_39BCD/0068_guangming.gif` is a `171 x 182`, one-frame, `0cs` sheet-like GIF. It has `0` direct `.actor` references in the current raw-CBE actor parser. The original `LOADLIGHTGOD` handler at `0x0000698A` resolves its selected resource strings to `guangmingshen_jineng.actor` and `guangmingshen.actor`; the latter actor uses `dao_guangmin.gif`, not `guangming.gif`. Exact `guangming.gif` string hits in the raw CBE are currently either catalog/resource-name entries or substrings of `jineng_guangming.gif`, so an engine-faithful character composite from `guangming.gif` still requires a hidden resource-index/record reference or another code path before it can be promoted.

Check the shared copy helpers used by writeback and record copies:

```powershell
python .\src\cbe_copy_helper_probe.py
```

This writes:

- `out_godwar_copyhelper\copy_helper_probe.md`
- `out_godwar_copyhelper\copy_helper_probe.json`

This report keeps the null-safety question concrete. The `0x11FD2` writeback path calls `0x11AE6(operand0)` and then `0x34540` with no local null guard. The helper island is not clean Thumb and still needs a fuller decode, but the diagnostic ARM view has copy-like `r0` destination / `r1` source evidence and no proven destination-null guard. Current status is therefore `copy-helper-null-safe-unproven`: unresolved writebacks remain effect-blocking.

Audit XSE service-slot candidates against the true call shapes:

```powershell
python .\src\cbe_xse_slot_audit.py
```

This writes:

- `out_godwar_xseslotaudit\xse_slot_audit.md`
- `out_godwar_xseslotaudit\xse_slot_audit.json`

This report prevents another false "simulator" step. The XSE conversion call at `0x1130E` loads `[sb+0x35C0]+0x50` into `r1` and calls it with only the opened resource handle in `r0`; therefore the target must not need meaningful `r1/r2/r3` arguments. The previously tempting `0xD2D4` candidate immediately consumes `r1/r2/r3` and stack args, so it is call-shape incompatible. The real byte-stream object constructor at `0x2C48C` gives `+0x50 -> 0x2C234`, but that method writes `r2` into an internal buffer selected by `r1`, so it is also not the XSE stream conversion or cursor reader. The next reverse-engineering target is the runtime object copy/overwrite that makes `sb+0x35C0` and `sb+0x35C4` point to their final service instances.

Trace the live XSE service-object lifecycle:

```powershell
python .\src\cbe_xse_service_lifecycle.py
```

This writes:

- `out_godwar_xseservicelife\xse_service_lifecycle.md`
- `out_godwar_xseservicelife\xse_service_lifecycle.json`

This report moves the work from format guessing to runtime service reconstruction. Current result: `0x35C0` has 39 service-object references, `0x35C4` has 66, and `0x35C8` is initialized as a sibling service in the same boot chain. The apparent `0x35C4` write at `0x1122C` is an overlapping literal-pool false positive that zeroes a table, while the real XSE loader uses `0x35C4` as an already-live pointer and calls `+0x78`, `+0x50`, and `+0x4C`. The next target is allocation/registration around the `0x3008` service lifecycle chain, especially the live reader service behind `0x35C4`.

Trace the real callers of the shared XSE/object loader:

```powershell
python .\src\cbe_xse_loader_callers.py
```

This writes:

- `out_godwar_xseloadercallers\xse_loader_callers.md`
- `out_godwar_xseloadercallers\xse_loader_callers.json`

This report pins `0x112C4` as the shared sub-script/object loader instead of another speculative parser entry. There are exactly two direct callers: `0x10B04`, which reads a child script handle through the live `[sb+0x35C4]+0x64` service path, and `0x16482`, which uses wrapper reader facades `0x934` and `0x958` before calling `0x112C4`. Both callers pass `r1=record+0x0C` and `r2=0`, so the emulator should model two verified reader facades feeding one `0x112C4` object/table decoder, not one guessed compact-reader width.

Trace the wrapper-reader facades behind `0x934` and `0x958`:

```powershell
python .\src\cbe_xse_wrapper_facade_trace.py
```

This writes:

- `out_godwar_xsewrapperfacade\xse_wrapper_facade_trace.md`
- `out_godwar_xsewrapperfacade\xse_wrapper_facade_trace.json`

This report resolves the alternate reader facade used by the `0x16482 -> 0x112C4` caller. `0x934` and `0x958` do not load the direct `0x35C4` service. Their useful PC-literal halfword is at `pool-2` / `aligned+2`, which points at the `0x3584` manager object; both wrappers then load `+0x5C`, yielding the live `0x35E0` manager-root pointer. `0x934` dispatches through `*([sb+0x3584]+0x5C)+0x140` slot `+0x2C`, while `0x958` dispatches through the same root plus `+0x180` slot `+0x04`. The next target is the constructor/write path that populates `[sb+0x3584]+0x5C` / `[sb+0x35E0]`, then the concrete method bodies behind those two slots.

Trace the concrete method slots read by the wrapper facades:

```powershell
python .\src\cbe_xse_facade_slot_trace.py
```

This writes:

- `out_godwar_xsefacadeslots\xse_facade_slot_trace.md`
- `out_godwar_xsefacadeslots\xse_facade_slot_trace.json`

This report starts turning the `0x934/0x958` facade map into callable methods. It scans the known table initializers for the actual relative offsets read by the wrappers: `0x934` reads `0x35E0+0x1C8`, and `0x958` reads `0x35E0+0x1E0`. Current result: `0x934` has one static candidate written by the `0x2B2C` initializer at store `0x2CB8`, landing around `0x1125E`, but that candidate is call-shape rejected because it consumes `r2` immediately while the wrapper has just used `r2` as the `blx` function-pointer register. `0x958` is still unresolved in the scanned static initializers. The live facade table is therefore likely overwritten or populated by a later runtime copy/registration path.

Trace the startup assignment of the live `0x35E0` manager root:

```powershell
python .\src\cbe_xse_manager_root_trace.py
```

This writes:

- `out_godwar_xsemanagerroot\xse_manager_root_trace.md`
- `out_godwar_xsemanagerroot\xse_manager_root_trace.json`

This report identifies why the wrapper facade table is not recovered by simple static initializer scans. The host bridge at `0x34AAA` stores the incoming host/provider pointer at `0x35F8` and calls `0x354` once; that setup function copies `[[sb+0x35F8]+0x08]` into `0x3588`, fills the flat `0x3584` global service block, and assigns `0x35E0` at `0x004F4` from the provider call `[[sb+0x35F8]+0x08+0x84]()`. Only after assigning sibling roots at `0x35E4/0x35E8/0x35EC` does startup call `0x2910` and `0x3008`. The emulator now needs a minimal model of this host-provider object so the real `0x35E0+0x1C8/0x1E0` facade slots can be materialized.

Trace the semantic equivalence between the direct and wrapper reader facades:

```powershell
python .\src\cbe_xse_facade_equivalence.py
```

This writes:

- `out_godwar_xsefacadeequiv\xse_facade_equivalence.md`
- `out_godwar_xsefacadeequiv\xse_facade_equivalence.json`

This report gives the first practical execution bridge for `0x112C4`. The direct caller at `0x10B04` uses `[sb+0x35C4]+0x4C` for scalar record fields and `[sb+0x35C4]+0x64` for child-resource handles; the wrapper caller at `0x16482` uses `0x934` and `0x958` in the same logical positions. Therefore the emulator can normalize `0x934` to the `+0x4C` scalar-reader semantics and `0x958` to the `+0x64` child-handle semantics while the exact host-provider object behind `0x35E0` is still being reconstructed.

Replay `0x112C4` through the normalized reader facade:

```powershell
node .\src\cbe_xse_facade_normalized_probe.js
```

This writes:

- `out_godwar_xsefacadenorm\xse_facade_normalized_probe.md`
- `out_godwar_xsefacadenorm\xse_facade_normalized_probe.json`

This report is now a historical guardrail before the corrected switch replay. It keeps `0x934` normalized to direct `+0x4C` scalar reads and `0x958` normalized to direct `+0x64` child/ref reads, then replays the old strict opcode gate twice: once with the existing `+0x50` compact-token model, and once with record-field `+0x50` widths loosened to 1..5 bytes. The old result showed no layout-aligned strict path, but `cbe_xse_switch_replay_probe.js` supersedes the strict-gate premise: opcode `>=9` is a no-extra-field switch path, not rejection.

Check whether parsed XSE numeric fields directly point at text/resource pools:

```powershell
node .\src\cbe_xse_ref_correlation.js
```

This writes:

- `out_godwar_xseref\xse_ref_correlation.md`
- `out_godwar_xseref\xse_ref_correlation.json`

This is a guardrail report. Direct `value` / `base+value` matches are currently zero for the focused opening scripts. Weak `textStart+value` hits are mostly small numbers like `1`, `8`, and `10` landing near the first text run, so they should not be treated as decoded references.

Trace the layered CBE service/vtable initialization:

```powershell
python .\src\cbe_service_layer_trace.py
```

This writes:

- `out_godwar_servicelayer\service_layer_trace.md`
- `out_godwar_servicelayer\service_layer_trace.json`

This report guards the XSE parser work from a wrong vtable assumption. Startup initializes global `0x35C0` twice: `0x2B2C` first, then `0x2A4A`, so the second pass can overwrite reader slots from the first pass. The later `0x2A1E` and `0x29B4` calls target global `0x35C8`, not `0x35C0`. Current unresolved slot: `0x35C0 + 0x74`; halfword ADD-PC candidates now land around `0xDCC8/0xDCCA`, while a word diagnostic points at dispatcher `0x11094`. Both are callback-layer clues, not a concrete stream reader.

Trace the unresolved reader callback candidates:

```powershell
python .\src\cbe_reader_callback_trace.py
```

This writes:

- `out_godwar_reader_callbacks\reader_callback_trace.md`
- `out_godwar_reader_callbacks\reader_callback_trace.json`

This narrows the `+0x74` problem: `0xDCC8` is inside a wrapper beginning at `0xDCA8` that calls into `0xDC4C`, and `0x11094` dispatches to child object slot `+0x74`. The same report now includes a direct-caller scan: `0xDCA8/0xDC4C/0xD5EA` are reached from draw/coordinate-style wrapper paths, while `0x11094` is a mid-function slot load with no direct caller. For emulator work, keep XSE service `+0x64/+0x74` symbolic until object/ref arrays can be matched to text/resource/symbol-pool indices.

Extract CBE-side symbols and script command names:

```powershell
node .\src\cbe_symbols.js "./cbe file/众神之战.CBE" .\out_godwar_symbols
```

This writes:

- `out_godwar_symbols\cbe_symbols.txt`
- `out_godwar_symbols\cbe_symbols.json`

Disassemble a focused Thumb code range:

```powershell
python .\src\cbe_thumbdump.py "./cbe file/众神之战.CBE" 0x107F6 320
```

## Output

- `manifest.json` per unpacked file
- `batch_manifest.json` for directory mode
- extracted resources grouped by section
- optional text reports from `cbe_textdump.js`
- optional structural reports from `cbe_structdump.js`

## Notes

- `CBD` files are not present in this backup.
- In this dump, `CBE` already contains both executable code and embedded resources.
- Some non-resource files in the directory do not match the same section structure, so the batch tool skips them.
- `.xse` is script bytecode with embedded GBK text. The text dumper is intentionally conservative: it extracts readable text runs and keeps byte offsets, but it is not yet a full bytecode decompiler.
- `.sce`, `.map`, and `.actor` also appear to be bytecode-like binary resources with embedded ASCII/GBK references. The structure analyzer extracts reliable hints and cross-resource candidates; it is not yet a complete VM instruction parser.
- For `众神之战`, map canvas sizes are now anchored from same-stem `.sce` files when available. The `.map` payload now looks like compact drawing bytecode rather than a raw tile array. The viewer and `cbe_maptrace.js` intentionally omit the old grid-stitch candidates as reconstruction.
- The old hand-arranged `Game Screen` mockup was removed. The viewer now favors decoded structure: `.sce` previews show parsed scene placement coordinates instead of manually composited sprites.
- Visual previews from older map/grid probes are not reconstruction. The current reliable path is `cbe_streamtrace.js`: first prove the engine's read order and object fields, then use that grammar to build a renderer/emulator.
- The supplied device screenshots are now a guardrail: the real `光明神殿` map is an ice/water temple scene with a texture-composited HUD/softbar, so the old RLE tile-grid candidate is diagnostic-only. The grid/shutter loading footage is tracked as a compositor/transition effect, and the reported `15fps` remains unproven until engine timer or measured-video evidence supports it.
- `.sce`, `.map`, `.actor`, and `.xse` resources share a small 9-byte envelope. Bytes 3-4 are a big-endian body length, usually equal to `file size - 9`.
- The `SCE2` body begins with `u16 width`, `u16 height`, `u16 map_count`, followed by map records. For `0312_guangmingshendian.sce`, this decodes to canvas `480x528`, one map record `guangmingshendian.map`, fields `0,0,1,1`, and the scene stream starts at `0x0032`.
- `cbe_scenedump.js` currently decodes `guangmingshendian.sce` into:
  - canvas `480x528`
  - map `guangmingshendian.map`
  - placements `heermode.actor @ 53,232`, `nanna.actor @ 178,113`, and `fali.actor @ 313,119`
- `cbe_streamtrace.js` confirms those placement records by raw offsets:
  - `heermod` at `0x012F`, with `type=15`, `x=53`, `y=232`, resolved by unique actor prefix to `heermode.actor`
  - `nanna` at `0x0146`, with `type=15`, `x=178`, `y=113`, resolved to `nanna.actor`
  - `fali` at `0x0156`, with `type=15`, `x=313`, `y=119`, resolved to `fali.actor`
- Engine code consistently reaches the parser service through sb-relative global slot `0x35C0`; disassembly windows show calls through offsets `+0x4C`, `+0x50`, and `+0x64`.
  - `+0x4C` is the halfword reader used by the SCE map table and later scene fields
  - `+0x50` is the compact numeric reader used by actor/template fields and script/object probes
  - `+0x64` is the resource/template reference reader used before actor/template initialization
  - startup applies `0x2B2C` and then `0x2A4A` to this same global, so the final slot state should be taken from the later pass where the two disagree
- `0347_guangmingshendian.map` references tileset `zhongliqu_1.gif`. Its lead header at `0x001E` is `E0 06 15 82 10 02`, decoded as biased width `1760 - 0x500 = 480`, flags `0x8215`, height `528`; the draw stream starts at `0x0024`.
- Compact numeric probing now treats `0x82` as signed 16-bit big-endian and `0x83` as signed 24-bit big-endian. This fixes cases such as `83 FF FF 00`, which is diagnostic evidence for `-256` rather than a huge unsigned value.
- `.actor` files reference complete GIF sprite/sheet images, not tiny uniform tiles. Examples:
  - `0401_heermode.actor` -> `heermode.gif`, GIF `110x63`, one image descriptor
  - `0423_nanna.actor` -> `nanna.gif`, GIF `34x30`, one image descriptor
  - `0392_fali.actor` -> `fali.gif`, GIF `46x39`, one image descriptor
- Actor metadata streams have a stable FF-heavy token pattern. Across the current `众神之战` actor set, most streams contain bytes shaped like `85 xx FF FF FF`, but this is now treated as a token/sentinel candidate rather than a proven section divider. For example, `heermode.actor` has such a pattern at stream offset `0x0062`; `nanna.actor` has one at `0x0039`. This remains diagnostic evidence for the actor parser, not yet a full animation/frame grammar.
- `众神之战.CBE` contains useful engine symbol strings, including source file paths such as `CodeGame\DF_Script.c` and script commands such as `SHOWDIALOG`, `CHANGESCENE`, `ROLEATTACK`, and `GETSCREENSIZE`. These are likely the bridge from `.xse` bytecode toward an interpreter.
- Thumb disassembly of `众神之战.CBE` is the current bridge from evidence to a true decoder:
  - around `0x107F6`, `CodeGame\DF_Record.c` checks `SCE2` and reads the scene width/height/count/table
  - around `0x0F222`, the actor parser reads a structured actor/template stream
  - around `0x0F616`, actor template initialization ties into the same resource grammar
- `cbe_streamtrace.js` now reuses the scored `0x0F222` actor/template layout evidence. For `0401_heermode.actor`, it reports a best `fixed8` `+0x64` table with fields at stream-relative `0x0041` and a `2/2` matrix ending at `0x0047`.
- `s_01.xse` through `s_04.xse` directly contain recovered command names such as `GETGAMESTATE`, `LOADLIGHTGOD`, `SETROLEPOS`, `OPENCR`, and `CANSAY`; the viewer now surfaces these under `Script Commands`.
