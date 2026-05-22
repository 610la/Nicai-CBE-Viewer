# CBE Disassembly Notes

These notes pin the current reverse-engineering evidence to raw offsets in
`./cbe file/众神之战.CBE`.

Use:

```powershell
python .\src\cbe_thumbdump.py "./cbe file/众神之战.CBE" 0x107F6 320
```

## Key Ranges

### `0x107F6` - `CodeGame\DF_Record.c`, scene/SCE parser

Evidence:

- Function prologue at `0x107F6`.
- At `0x10824` through `0x1083A`, the code compares the first four bytes of the stream to `SCE2`:
  - `0x53`, `0x43`, `0x45`, `0x32`.
- If the magic matches, it sets a local flag and advances the stream cursor by 4 bytes.
- It then reads three little-endian 16-bit fields through the same helper:
  - stored at `scene + 0x04`
  - stored at `scene + 0x06`
  - stored at `scene + 0x0A`
- In extracted `.sce` files these match `width`, `height`, and `map_count`.
- For `0312_guangmingshendian.sce`:
  - `width = 480`
  - `height = 528`
  - `map_count = 1`
  - map record: `guangmingshendian.map`, fields `0,0,1,1`
- The parser allocates `map_count * 8` bytes for the map table, and later allocates `map_count * 0x84` bytes for scene/map-related records.
- Around `0x108CA`, this parser calls `0x0F616`, tying scene records to actor/template initialization.

### `0x0F616` - actor/template initializer

Evidence:

- Function prologue at `0x0F616`.
- Stores several function pointers into the actor/template object:
  - `object + 0x70`
  - `object + 0x74`
  - `object + 0x78`
  - `object + 0x7C`
  - `object + 0x80`
- Calls `0x1291E`, then clears halfwords at `object + 0x20` and `object + 0x22`.
- Calls `0x0F222` at `0x0F666`.
- This makes `0x0F222` the next important parser for actor stream grammar.

### `0x0F222` - actor stream parser

Evidence:

- Function prologue at `0x0F222`.
- Reads a leading count and allocates `count * 2` bytes, then fills that table in a loop.
- Reads multiple 16-bit fields into the actor/template object:
  - `object + 0x00`
  - `object + 0x04`
  - `object + 0x08`
  - `object + 0x0C`
- Uses those fields to compute larger array sizes through a multiply helper at `0x345F4`.
- Allocates nested arrays and fills them with stream values in loops.
- This aligns with the extracted actor files:
  - the referenced GIF is a complete sprite/sheet image
  - the trailing actor stream is metadata/animation/template data
  - it is not a uniform tile-cut instruction stream

### sb-relative stream services, global slots `0x35C4` and `0x35C0`

Evidence:

- `cbe_global_lifecycle.py -t 0x35C0` finds repeated `ldr/add sb/ldr` call sites around the same parser functions.
- `cbe_service_layer_trace.py` now anchors the startup initializer order:
  - `0x301A`: global `0x35C0` -> `0x2B2C`
  - `0x3024`: global `0x35C0` -> `0x2A4A`
  - `0x302E`: global `0x35C8` -> `0x2A1E`
  - `0x3038`: global `0x35C8` -> `0x29B4`
- Therefore `0x2B2C` and `0x2A4A` are the relevant chained initializers for `0x35C0`; `0x2A1E` and `0x29B4` belong to the neighboring `0x35C8` service and should not be merged into this reader vtable.
- Because `0x2A4A` runs after `0x2B2C`, slot values from `0x2B2C` can be overwritten. Where the two passes disagree, the later `0x2A4A` candidates are the better starting point for tracing XSE parser callbacks.
- The current shared parser pattern uses two services, not one:
  - `[sb+0x35C4]+0x40` opens/wraps the resource stream
  - `[sb+0x35C0]+0x50` converts the opened stream into the pointer/object later consumed by cursor reads
  - `[sb+0x35C4]+0x50`, `+0x4C`, `+0x64`, and `+0x38` perform typed cursor/reference/close operations on that converted stream
- `cbe_xse_stream_service_trace.py` verifies this exact open/convert pair in four parser paths:
  - XSE object loader `0x112C4`: `0x11304` `[0x35C4]+0x40`, `0x1130E` `[0x35C0]+0x50`, then `0x1131E` `[0x35C4]+0x50`
  - actor/resource parser `0x0F222`: `0x0F230` `[0x35C4]+0x40`, `0x0F23A` `[0x35C0]+0x50`, then `[0x35C4]` cursor methods
  - nested-table parser `0x1607C`: `0x1608E` `[0x35C4]+0x40`, `0x16098` `[0x35C0]+0x50`, then `[0x35C4]+0x50/+0x38`
  - scene/SCE parser `0x107F6`: `0x10816` `[0x35C4]+0x40`, `0x10820` `[0x35C0]+0x50`, then the explicit `SCE2` check and `[0x35C4]+0x4C` field reads
- `cbe_xse_provider_service_trace.py` resolves where these live globals come from. The `0x354` provider setup uses `sb+0x3584` as a flat global service block:
  - `0x00434`: `0x35C0 = 0x3584+0x3C <= [[sb+0x3584]+0x04+0x5C]()`
  - `0x0043C`: `0x35C4 = 0x3584+0x40 <= [[sb+0x3584]+0x04+0x64]()`
  - `0x00448`: `0x35C8 = 0x3584+0x44 <= [[sb+0x3584]+0x04+0x6C]()`
  - `0x004F4`: `0x35E0 = 0x3584+0x5C <= [[sb+0x3584]+0x04+0x84]()`
- This means `0x35C4` is not just a nearby state/table slot for this work. It is a provider-returned live reader/open/cursor service used by XSE and SCE paths, while `0x35C0` supplies the shared conversion service. `0x3008` runs later constructor/table passes over the already-returned `0x35C0` and sibling `0x35C8`; it is not the source of `0x35C4`. The remaining emulator blocker is materializing the provider method returns for `+0x5C/+0x64` and inspecting the live method tables they return.
- `cbe_provider_service_replay.js` is now the first runnable service-chain slice. It uses the provider assignments to replay `guangmingshendian.sce` through `[0x35C4]+0x40`, `[0x35C0]+0x50`, and `[0x35C4]+0x4C/+0x64`, recovering `480x528`, `map_count=1`, `guangmingshendian.map`, and map fields `0,0,1,1`. XSE remains blocked because exact `[0x35C4]+0x50` cursor semantics are still unresolved.
- `cbe_cursor50_variant_probe.js` compares `[0x35C4]+0x50` endian/signedness variants against actor `0x0F222` and XSE `0x112C4`. Current result: the current compact-token family remains tied for the strongest actor oracle, but no tested variant creates a layout-aligned XSE opcode path. This makes a simple primitive-token endian flip unlikely; the next target is the live `+0x50` method body/object state and the converted-stream base/cursor contract.
- `cbe_provider_abi_trace.py` resolves why static `+0x50` method-table scans keep failing. `0x35C0`, `0x35C4`, and `0x35E0` are return values from the host-provider API object at `0x3588`: `providerApi+0x5C -> 0x35C0`, `providerApi+0x64 -> 0x35C4`, and `providerApi+0x80+0x04 -> 0x35E0`. The emulator should model these provider-returned services with an ABI shim, not pick static CBE table candidates as final live methods.
- `cbe_provider_abi_shim_probe.js` turns that ABI into a runnable boundary. It boots provider-returned `0x35C0/0x35C4/0x35E0` service objects and replays `guangmingshendian.sce` through those services, recovering `480x528` and `guangmingshendian.map`. Its older XSE strict-gate result is now superseded by the corrected switch replay below; keep the shim as the runtime service boundary, not as proof that opcode `0x0A` is fatal.
- `cbe_xse_switch_replay_probe.js` corrects the key `0x112C4` control-flow read. At `0x1148E`, `cmp opcode,#9; bhs 0x1150E` skips the `0..8` operand switch and continues the record loop; it is not a failure gate. With that correction, focused XSE object/opcode tables replay in 4/4 scripts. Tail alignment is close for 3/4 (`s_03` exact, `s_04` -1, `s_01` +10), while `s_02` remains the narrow `+0x74/+0x64` tail-reader blocker. The emulator target is now high-opcode record binding to symbol/handler tables, not rejecting high opcodes.
- `cbe_xse_runtime_dispatch_probe.js` connects that corrected loader replay to the interpreter at `0x11C3C`. The group dispatcher checks ids at `0x11CF8`: ids `0..0x20` jump through the table at `0x11D0C`, while everything else goes to default `0x11FE0`. Tail-best and dispatch-best `+0x4C` modes now disagree in `s_02.xse` and `s_04.xse`; `u16le` is tail-close but sends all groups to default, while `compact` lands three groups on direct cases. The emulator must choose reader semantics from runtime behavior, then resolve `+0x74/+0x64` tail refs, rather than treating object-boundary alignment as final proof.
- `cbe_xse_dispatch_case_probe.py` maps the first interpreter implementation surface. Under the execution-best selector, focused opening scripts directly exercise group ids `2,5,6,9,30,31`, so the first trace-only VM can start with targets `0x11D4C`, `0x11ED4`, `0x12222`, and `0x1223E` plus default handling. The apparent compact-mode id `32` target `0x15F08` is a register-shape suspect: the jump-table halfword overlaps real code and lands in an inner table-lookup label that expects `r4` as an object pointer, not as the dispatcher group id. The case map confirms the script-record state layout used at runtime: `+0x48` group table, `+0x50` group/cursor, `+0x54` opcode records, `+0x5C` opcode cursor, `+0x60` negative-index base, `+0x64` tail records, `+0x68` tail count, and `+0x6C` final refs. This turns the next work from format probing into a trace-only interpreter pass.
- `cbe_xse_trace_vm_probe.js` performs that first trace-only interpreter pass. It walks 22 group steps across `s_01.xse`..`s_04.xse` using execution-best modes and the real case map; `s_03.xse` stops at group `31` because the case clears the active flag. This proves the simulator can now advance real VM group state, while keeping visible effects disabled. The high-opcode operands in this pass are not fatal or uniformly numeric: 3 high-opcode numeric operand uses default through `0x118FA/0x118D2`, while the other high-opcode reads are record copies through `0x11862`. The trace avoids one `s_04` compact group32/register-shape path. The next blocker is writeback semantics: 6 direct writeback steps still need `operand0` to resolve through `0x11AE6` as a valid type 3/4/8 target, alongside the remaining compact/tail ambiguity.
- `cbe_xse_writeback_probe.js` compares that writeback blocker across every candidate reader mode. The execution-best modes still have 6 unresolved writeback targets, while the low-risk alternatives are mostly default-only modes. The writeback site at `0x11FD2` calls `0x11AE6(operand0)` and then the shared `0x34540` copy helper without a local null guard, so the next choice is not simply "pick u16le everywhere"; we need to bind the live `+0x50` reader/cursor state and the script `+0x54/+0x60` record stack, or prove that the copy helper tolerates null destinations, before visible script effects can be honest.
- The writeback target helpers are now anchored. `0x117D8` copies one 0x28-byte record from the script `+0x54` table into a destination buffer; when the requested index is negative, it first adds the script `+0x60` negative-index base. `0x1180A` uses the current group record table at `+0x48/+0x50` and copies operand `r0`: type `3` returns operand field `+0x14`; type `4` copies `+0x54[field+0x04]` and returns copied field `+0x08` plus operand field `+0x14`; type `8` resolves through `0x11AE6` to the script inline record at `+0x20`. Non-reference operand0 values therefore explain the 6 writeback blockers without inventing gameplay effects.
- `cbe_xse_cursor_init_probe.js` anchors the reset/start helper at `0x11266`. It seeds script `+0x50` from tail64 only if script/header field `+0x08` is nonzero; it clears `+0x5C/+0x60`, initializes `+0x54` stack records with type `-1`, then calls `0x11252` to seed the opcode-stack cursor/negative-index base from `field+0x04` and tail64 record state. All 4 execution-best focused scripts currently have field `+0x08=0`, so the writeback blocker is not explained by a nonzero reset group cursor.
- `cbe_xse_slot_lifecycle_probe.py` maps the runtime script-slot writes around `0x11252`, `0x11266`, `0x11A4A`, `0x11C3C`, and the activation helpers `0x12286/0x122B0`. It confirms `0x11266` does not seed `+0x50` for 4/4 execution-best focused scripts, and the first unresolved writeback in `s_01.xse`, `s_02.xse`, and `s_03.xse` occurs at cursor 0 before any in-trace VM case can mutate `+0x50`. Slot lifecycle still belongs in the generic emulator state machine, but the current opening blocker points back to operand/reference binding and `+0x5C/+0x60` tail stack state rather than hidden branch-state cursor reuse.
- `cbe_xse_operand_binding_probe.js` checks whether the current writeback blockers can be solved by the `+0x5C/+0x60` stack-address layer. All 6 unresolved writebacks have `operand0` outside the pointer-producing type set `3/4/8` (`1`, `100`, `129`, `249`), so stack seed binding alone cannot make `0x11AE6(operand0)` return a destination. This pushes the next emulator step toward operand record boundaries and `+0x4C/+0x50` reader binding around direct value-op groups.
- `cbe_xse_entrypoint_probe.js` shifts the entry question from a forced cursor-0 scheduler hypothesis to the real label/tail helper at `0x12364`. `0x12326` scans `script+0x64` records by requested label/ref, `0x11A4A` copies the selected record, adjusts `+0x5C/+0x60` via `0x11252`, writes selected `record+0x00` into `script+0x50`, then dispatches through `0x11C3C`. Under the current tail scan, `s_01.xse`, `s_03.xse`, and `s_04.xse` have plausible and writeback-safe entry candidates, while `s_02.xse` remains tail-binding unresolved. The next check is to match candidate refs against the tail symbol pool and caller-provided strings before replacing the cursor-0 trace with label-entry execution.
- `cbe_xse_entry_label_probe.js` performs that guardrail check. It finds no safe focused candidate whose `+0x64` ref strongly maps to `INIT` or `_MAIN`; only `s_01.xse` maps safe candidates to command-symbol slots such as `LOADHERERSKILL` and `CLOSESCRIPT`. That means the entry helper and symbol-pool-like refs are real, but the emulator still needs the caller-provided label/ref binding and exact `+0x64` width before using those candidates as executable entrypoints.
- `cbe_xse_entry_caller_probe.py` anchors the caller side of that binding. Direct calls to dispatching `0x12364` appear at `0x10B7A` and `0x164DA`; select-only `0x123E4` is called at `0x08F1A`, `0x10CA6`, and `0x10D78`. The nearby ADR label constants recover as `Init` and `_main`, although the computed ADR target can land a couple bytes into or before the ASCII storage. The remaining binding problem is therefore the `0x12326` compare service (`[sb+0x35C4]+0x50`) and the `+0x64 record+0x10` string/ref representation, not whether the engine really uses named entry labels.
- `cbe_xse_entry_compare_probe.js` joins those caller labels with the current `+0x64` parses. The exact ADR targets read as `it`, `ain`, or empty rather than full `Init/_main`, so the compare method is not a plain C-string equality on the raw ADR target. Under the current tail modes, only `s_01.xse` has an `INIT`-shaped match (`textRelPayload=253`), and that match enters a writeback-risk group. There are still 0 safe caller-label matches, making `[sb+0x35C4]+0x50` compare normalization the next concrete target.
- `cbe_xse_label_pointer_probe.js` separates literal caller pointers from inferred full labels. All 5 direct label-entry caller pointers are offset from the recovered full label start: 4 point two bytes inside `Init/_main` (`it` or `ain` at the exact target), and 1 points two bytes before `_main`. A diagnostic `address+2+imm` calculation reaches the full label for 4/5 calls, which explains the repeated two-byte skew, but exact ADR-target text still selects 0/4 focused scripts and the current inferred full-label shim remains unsafe. `nearby-full-label` must stay a diagnostic model until the concrete compare provider or argument-shape normalization is recovered.
- `cbe_xse_ref_encoding_probe.js` separates the `+0x64 record+0x10` width/base question from label-pointer normalization. Across focused scripts, no top candidate has a safe requested-label ref match. The lone requested-label collision is `s_01.xse` `INIT:textRelPayload=253`, but that selected entry dispatches into the writeback-risk group. Top `ref64` modes also split across `compact`, `raw1`, `raw2le`, and `raw3le`, so the emulator cannot promote one universal tail-ref width yet.
- `cbe_xse_compare_normalization_probe.js` tests caller-label normalization directly against the unresolved ref models. Exact ADR text covers 0/5 caller labels, `pc+2` covers 4/5, and `target+/-2` covers 5/5, but even the full-coverage `target+/-2/text-payload` model has 0 safe focused selections and 1 writeback-risk selection. That means the emulator can model the caller-pointer skew as evidence, but it still cannot enter scripts until the `+0x64 record+0x10` ref representation is recovered.
- `cbe_xse_tail_boundary_probe.js` adds a parser-boundary guard to those label/ref collisions. `s_01.xse` has one boundary-clean `textRelPayload` requested-label match, but it is still writeback-risk; `s_04.xse` only gets a text-payload collision from a `+0x64` table parse that crosses into the text pool. There are still 0/4 boundary-clean safe requested-label selections, so visible entry execution remains blocked.
- `cbe_xse_compare_service_probe.py` nails down that `+0x50` is polymorphic at the ABI level. In `0x112C4` it is called as `r0=stream, r1=&cursor` for numeric/count reads, but in `0x12326` it is called as `r0=caller label pointer, r1=+0x64 record+0x10`; the loop treats return `0` as a successful label match. The emulator should either recover the concrete provider-returned `0x35C4` service method or provide an argument-shape shim for `stream,cursor` versus `label,ref`.
- `cbe_xse_compare_shim_probe.js` is that first selection-only shim. It keeps `+0x50` as `stream,cursor` for loader reads and as `label,ref` for `0x12326`, then scans full candidate `+0x64` tables without enabling effects. Exact ADR-target text selects 0/4 focused scripts. The primary `nearby-full-label/text-payload` model selects only `s_01.xse`, and that selected `INIT:textRelPayload=253` record enters a writeback-risk group. The broader all-strong model first-matches implausible records in `s_01.xse` and `s_04.xse`, proving those symbol/length-offset collisions are not safe entry bindings. This means the current `+0x64 record+0x10` model is not yet a real entry binding; the next target is concrete ref encoding and `0x11A4A` activation state, not rendering script effects.
- `cbe_xse_activation_probe.js` binds the `0x11A4A` side effects as a state transition. `0x11954` copies `script+0x64[selectedIndex]`, `0x11A0E` pushes a transformed runtime record into `+0x54[+0x5C]`, `0x11252` adds selected `record+0x08+1` into `+0x5C` and mirrors it to `+0x60`, and `0x11AA8` stores selected `record+0x00` into `+0x50`. For the primary `s_01.xse` selection this would set `+0x50=2` and stack delta `8`, but the activated dispatch is still writeback-risk. The all-strong diagnostic selections would restore invalid cursors (`-37` and `98`), so they remain rejected.
- `cbe_xse_activated_dispatch_probe.js` connects that activation state to the trace-only VM. The primary `s_01.xse` entry `26` selection reaches cursor `2`, dispatches group `6` at `0x011ED4`, and immediately hits the same writeback blocker with operand0 `0x64/high-opcode-no-target`. Because operand0 is not a type `3/4/8` destination, the activation stack delta cannot make `0x11AE6(operand0)` return a valid target. This makes the next target narrower: operand record boundaries and `+0x4C/+0x50` reader binding at activated value-op groups, before applying the generic `+0x54/+0x60` address layer.
- `cbe_xse_activated_operand_probe.js` narrows that further. For `s_01.xse`, the activated group header at `0x00D8` and the nearby one-byte compact-id view both leave the first record at `0x00DB` with opcode `0x64`. Disassembly of `0x11ED4` shows `movs r1,#0; bl 0x11862`, and the writeback site uses `movs r0,#0; bl 0x11AE6`, so this case really reads and writes operand index `0`. Later type `8` records in the group are not the destination. The next target is concrete label/ref selection or high-opcode record semantics, not a simple operand-index swap.
- `cbe_xse_high_opcode_probe.js` separates high-opcode record reads from numeric value defaults and writeback destinations. The loader-valid `opcode>=9` records are not corrupt: `0x11862` copies non-reference records, while `0x118D2` returns numeric `0` only after a case actually enters the numeric helper path. The activated `s_01.xse` path does not do that; group `6` at `0x11ED4` is an identity writeback that falls through to `0x11FD2`, and `0x11AE6` still returns null for operand0 `0x64`. So the current label-entry candidate must be demoted rather than rescued by high-opcode value semantics.
- `cbe_xse_entry_safety_probe.js` turns that demotion into the generic scheduler gate. A label/ref compare selection is only promotable after the `0x11A4A` activation cursor, the `0x11C3C` dispatch step, and the `0x11AE6/0x11FD2` destination contract all pass. Current result: `s_01.xse` entry `26` is automatically demoted as `entry-demoted-high-opcode-writeback`; `s_02.xse`, `s_03.xse`, and `s_04.xse` remain unmatched under the active model, and the broad all-strong matches in `s_01.xse`/`s_04.xse` restore invalid cursors. Visible script effects therefore stay disabled by rule, not by an ad hoc exception.
- `cbe_xse_ref_width_exhaustive_probe.js` rules out a width-only rescue. It runs the entrypoint parser with `candidateLimit=100`, covering every supported `+0x74/+0x64` mode pair for each focused script. Current result: 0 first requested-label matches are safe for scheduling, 0 requested-label matches are safe at all, and 114 requested-label collisions are unsafe or implausible. The next target is no longer "try a different guessed ref64 width"; it is the provider-backed `+0x50` compare/reader ABI and the true `+0x64` range-table count/ref encoding.
- `cbe_xse_compare_abi_probe.js` formalizes the provider-reader ambiguity. `[sb+0x35C4]+0x50` is not just a compact-token reader: the same method slot has 3 stream/cursor read windows and 1 label/ref compare window. At `0x1233C`, `r0` is the caller label pointer, `r1` is `script+0x64 record+0x10`, and return `0` selects the entry. The provider ABI shim now documents a shape-polymorphic `+0x50` branch; the remaining compare blocker is the `script+0x64 record+0x10` ref namespace.
- `cbe_xse_ref_namespace_probe.js` makes that blocker an explicit emulator gate. Direct C-string compare is rejected (`exact ADR` selects 0/4 focused scripts), scalar symbol offsets are rejected for scheduling (0 first-safe and 0 safe requested-label matches, 114 unsafe/implausible collisions), and the only valid runtime shape left is provider-opaque `record+0x10` refs compared by `[sb+0x35C4]+0x50`. Until a resolver maps provider `+0x64` refs to normalized `Init/_main` labels, the shim should return non-match and visible XSE effects remain disabled.
- `cbe_xse_ref64_loader_probe.js` pins the write sites behind that opaque value. The range loader at `0x11672` stores `[sb+0x35C4]+0x64` return values into 0x14-byte records at `+0x10`, while `+0x0C` is computed as `field+0x04 + field+0x08 + 1`. The final-ref table at `0x11752` also reads refs through `+0x64`. Under the current selected compare candidate, `s_01.xse` entry `26` has `ref@0x02A0 raw=0xFD`, which is not SCE-style inline length-prefixed text. This strengthens the call-context ABI split: SCE `+0x64` can produce resource-name text, but XSE range/final refs remain provider-opaque until the compare namespace is recovered.
- `cbe_provider_ref_context_probe.js` promotes that split into a generic loader rule. `[sb+0x35C4]+0x64` now has four documented contexts: `sce-resource-name` is the only text-safe one, `xse-range-entry-ref` feeds `record+0x10` and the `0x12326` compare, `xse-final-ref` fills the `script+0x6C` table, and `xse-child-resource-handle` is passed as `r0` into `0x112C4`. The ABI shim exposes `readProviderRef(..., { context })`, routes range refs into `compareLabelRef(label, ref)` with an unbound resolver, and keeps the legacy `readRef()` as an SCE-only compatibility wrapper.
- `cbe_xse_compare_resolver_boundary_probe.js` marks the next boundary. The compare loop at `0x12326` loads `[35C4]+0x50` from the provider-returned reader service whose origin is provider API `+0x64`; no static CBE resolver target is currently known. Shim samples now prove the dataflow `readProviderRef(xse-range-entry-ref) -> compareLabelRef(label, ref)` and store it in a provider namespace ledger (`19` refs, `18` opaque refs, `36` compares), but all return non-match while the provider namespace is unbound. The shim now includes an observed-match-only resolver hook, so entry promotion can later depend on real provider observations rather than scalar/string ref guesses.
- `cbe_provider_resolver_hook_probe.js` checks that hook contract without promoting execution. A synthetic observed `label + providerRefId` pair returns the `0x12326` return-0 shape, but same-label/wrong-ref, wrong-label/same-ref, and unknown-ref checks all reject. This proves the insertion point is guarded: future instrumentation can feed real provider observations, while label or raw-ref coincidences alone still cannot enable visible effects.
- `cbe_provider35c4_tape_probe.js` turns the shim trace into the provider-service event shape the emulator should eventually receive from real instrumentation. It separates `[35C4]+0x64` ref producers, `[35C4]+0x50` stream/cursor reads, and `[35C4]+0x50` label/ref compare consumers, then checks that compares consume known `providerRefId` values and that no return-0 hook-feed rows exist yet. Current result: `provider35c4-instrumentation-tape-ready`, with visible effects still disabled until real provider observations feed the hook.
- `cbe_provider35c4_feed_probe.js` wires that tape shape into the resolver hook without inventing observations. It builds the feed only from provider compare rows where `[35C4]+0x50` returned `0`, then replays all current label/ref compares through `createObservedProviderRefResolver`. Current result: `provider35c4-feed-guarded-empty`; there are 0 observed feed rows, 36 replayed compares, 0 resolver matches, and 0 promotion-eligible rows.
- `cbe_provider35c4_capture_plan_probe.js` turns the feed rule into an implementation checklist. The current capture points are SCE `+0x64` resource-name producer, XSE `0x1173C` range-ref `+0x64` producer, XSE `0x11792` final-ref `+0x64` producer, three stream/cursor `+0x50` read sites, and the `0x1233C` label/ref `+0x50` compare site. Current result: `provider35c4-capture-plan-ready`; all capture points are evidence-backed, and only the `0x1233C` return-0 compare point is feed-eligible.
- `cbe_provider35c4_capture_source_probe.js` makes the capture plan executable as a source adapter. It converts the current shim tape into canonical `provider-ref-produced`, `provider-cursor-read`, and `provider-label-ref-compared` events, then verifies that every label/ref compare links to an earlier `+0x64` producer. Current result: `provider35c4-capture-source-shim-adapter-ready`; 104 events are emitted, 36/36 compares link to prior producers, and 0 observed feed rows keep visible effects disabled.
- `cbe_provider35c4_emulated_source_probe.js` rebuilds the source from raw CBE through the ABI shim instead of reading the tape. Current result: `provider35c4-emulated-source-parity-ready`; it emits 95 provider-owned `0x35C4` events and matches the previous adapter after excluding 9 `[sb+0x35C0]+0x50` conversion handoffs. This sharpens the service split: stream conversion belongs to `0x35C0`, while `0x35C4` owns ref production, cursor reads, and label/ref comparison.
- `cbe_provider35c4_service_object_probe.js` turns that source into a service object contract. Current result: `provider35c4-service-object-ready`; it replays 95 provider-owned events with 19 `+0x64` ref producers, 40 `+0x50` cursor reads, and 36 `+0x50` label/ref compares. The accepted method shapes are `+0x64:provider-ref-producer`, `+0x50:stream-cursor-read`, and `+0x50:label-ref-compare`; all 36 compares consume known prior refs, and an empty observed feed returns no matches.
- `cbe_provider35c4_service_resolver_probe.js` checks the service-object resolver guard. Current result: `provider35c4-service-resolver-guarded`; the empty production feed keeps the target pair non-match, a synthetic exact observed `label + providerRefId` returns 0, and same-label/wrong-ref plus wrong-label/same-ref variants reject. This preserves the rule that future return-0 rows must be exact provider observations.
- `cbe_provider35c4_live_call_probe.js` feeds the provider service object through ABI shim call requests rather than prebuilt source events. Current result: `provider35c4-live-call-feeder-ready`; 95 direct service calls replay with parity against the source-object path, split into 19 `+0x64` producers, 40 `+0x50` cursor reads, and 36 `+0x50` label/ref compares. All compares consume known prior refs, 0 return-0 rows are observed, and the next boundary is parsed live stream execution invoking `0x35C4` methods at the real SCE/XSE call sites.
- `cbe_provider35c4_stream_executor_probe.js` makes that boundary executable from parsed raw streams. Current result: `provider35c4-parsed-stream-feeder-ready`; the stream executor does not read ABI `traceEvents` as its call source, parses SCE/XSE resources directly, and matches the ABI live-call feeder with 95 calls, 19 producers, 40 cursor reads, 36 label/ref compares, row parity, and operation parity. It still keeps 0 return-0 compares and disables visible effects until real provider observations are available.
- `cbe_provider35c4_table_walk_probe.js` expands the parsed feeder into a guarded full `0x112C4/0x11672` range-table walk. Current result: `provider35c4-full-table-walk-guarded`; 8 candidate lanes emit 306 table range refs, 626 cursor reads, and 612 label/ref compares, but all lanes remain non-promoting because negative or suspicious count/final-ref values are still present. This is progress toward the real loader loop without turning table guesses into gameplay.
- `cbe_provider35c4_count_mode_probe.js` resolves part of that ambiguity without pretending the whole table is known. Current result: `provider35c4-count-mode-guarded`; unsigned compact reads do not rescue the top lanes because several cross into text/pool bytes. Pool-clean alternatives are selected for `s_01.xse`, `s_03.xse`, and `s_04.xse`, while `s_02.xse` stays blocked because its current table start is already inside text/resource bytes.
- `cbe_provider35c4_s02_source_mode_probe.js` resolves the `s_02.xse` text-pool blocker as a source-mode handoff, not a count reinterpretation. Current result: `provider35c4-s02-source-mode-tailend-candidate-ready`; compact dispatch scoring points to `0x03D0` inside text/resource bytes, while the tail-aligned `u16le` handoff at `0x02A1` has a unique pool-clean `74=fixed5,64=raw1` table candidate ending at `0x031B`.
- `cbe_provider35c4_selected_table_walk_probe.js` reruns the provider service-object walk on the count-mode lanes plus the `s_02` tailEnd lane. Current result: `provider35c4-selected-table-walk-ready`; 8/8 selected lanes expand with 0 count guards, producing 238 refs, 284 cursor reads, and 268 label/ref compares. There are still 0 return-0 compare observations, so this advances the generic loader model across all focused scripts but does not enable visible script effects or entry promotion.
- `cbe_provider35c4_selected_feed_probe.js` applies the observed-match resolver rule to the expanded selected table, not just the older sampled tape. Current result: `provider35c4-selected-feed-guarded-empty`; 268/268 selected compares replay through the feed gate, 0 return-0 rows produce 0 observed feed rows, 0 resolver matches, and 0 promotion-eligible rows.
- `cbe_provider35c4_promotion_frontier_probe.js` adds the final pre-execution guard for hypothetical selected return-0 rows. Current result: `provider35c4-promotion-frontier-guarded`; 268 selected compares are classified, 4 have valid cursor plus coherent stack delta, but all 4 are `s_04.xse` default-dispatch-only rows and 0 reach a direct-case promotion frontier.
- `cbe_provider35c4_frontier_mode_scan_probe.js` broadens the frontier check across source/mode candidates without enabling effects. Current result: `provider35c4-frontier-mode-scan-guarded`; 425 candidates are scanned, 107 are pool-clean, 28 are scheduler-only modes, and 0 reach a direct-case promotion frontier. These modes are capture priorities, not emulator execution entries.
- `cbe_provider35c4_return0_priority_probe.js` turns those scheduler-only rows into an ordered provider observation queue. Current result: `provider35c4-return0-priority-ready`; P1 has 4 selected rows with known providerRefIds, P2/P3 has 56 mode-scan compare rows that still need live `+0x64` providerRefIds, and 0 rows are direct-case/executable.
- `cbe_provider35c4_return0_injection_probe.js` validates that the observed-match plumbing works without opening execution. Current result: `provider35c4-return0-injection-guarded`; synthetic P1 observations make 4/4 resolver rows return 0, but all four remain `frontier-default-dispatch-only`, with 0 direct-case and 0 executable rows.
- `cbe_provider35c4_return0_capture_adapter_probe.js` replaces synthetic P1 rows with a real observation import boundary. Current result: `provider35c4-return0-capture-adapter-empty`; the expected capture file is missing, so imported observations, observed feed rows, P1 matches, direct-case rows, and executable rows all remain 0. The generated template documents the required `provider35c4-label-ref-compare-1` / `0x0001233C` rows.
- `cbe_provider35c4_captured_selected_feed_probe.js` wires the real capture adapter into the full selected-table feed. Current result: `provider35c4-captured-selected-feed-empty`; 268/268 selected compares replay, 268/268 join the promotion frontier, and the empty capture feed produces 0 resolver matches, 0 direct matches, and 0 executable rows.
- `cbe_provider35c4_observation_recorder_probe.js` adds the common recorder/export boundary for provider compare observations. Current result: `provider35c4-observation-recorder-nonfeed-ready`; it exports 268 selected-table compare events plus 36 parsed-stream compare events in the capture-adapter schema, writes only `provider35c4_observation_events.json` as a non-authoritative fixture, and confirms the adapter imports all 304 rows as non-match evidence with 0 feed rows and 0 executable rows.
- `cbe_provider35c4_runtime_sink_probe.js` moves that boundary into the service-object runtime path using `cbe_provider_observation_channel.js`. Current result: `provider35c4-runtime-sink-nonfeed-ready`; `Provider35C4ServiceObject` emits 268 selected-table compare observations and 36 parsed-stream compare observations during execution, selected rows retain entry metadata, and the adapter plus selected-feed/frontier checks import all 304 runtime rows as non-match evidence with 0 feed rows, 0 resolver matches, and 0 executable rows.
- `cbe_runtime_core.js` and `cbe_runtime_core_probe.js` start the generic emulator shell instead of another single-game path. Current result: `cbe-runtime-core-ready`; the core loads 19/24 corpus CBE files, exposes archive catalog/resource APIs, owns the provider observation channel, and routes 268 selected-table plus 36 parsed-stream provider observations through the same adapter/feed gates with 0 feed rows and 0 executable rows.
- `buildRuntimeSceneFromCore()` in `cbe_runtime.js` now builds an SCE runtime snapshot directly from `CbeRuntimeCore` buffers. The viewer exposes this through `/api/cbe-runtime` and shows a `Core Runtime` comparison row; for `guangmingshendian.sce` it recovers the 480 x 528 scene, `guangmingshendian.map`, `zhongliqu_1.gif`, 3 entities, and 1 linked script without reading the extracted `out_batch` scene file. `/api/cbe-emulator` then runs that core-native runtime through the emulator frame/state machine, reaching a scene frame after four confirm actions with tick 4 and 3 entities.
- `cbe_runtime_core_scene_probe.js` turns that into a corpus invariant for the generic web emulator: current result `cbe-runtime-core-scene-ready`; 148/148 scene resources across 6/6 scene-bearing CBE files build through `CbeRuntimeCore -> buildRuntimeSceneFromCore -> emulator state/frame`, all 148 expose canvas dimensions, all 148 end on a scene frame after four confirm actions, all 148 baseline input smoke runs stay on scene frames, and the compatibility matrix currently has 8 map-linked scenes (3 from SCE map tables and 5 from direct length-prefixed `.map` refs), 8 tileset-linked scenes, 107 scenes with entities, 3 script-linked scenes, and 35 boot-flow-linked scenes. `cbe_maptrace.js` now has a buffer-native `analyzeMapBuffer()` path, so all 8/8 linked maps are analyzed directly from raw CBE resources with atlas sizes, draw-record candidates, and RLE candidates; 6/8 currently produce full-grid diagnostic tile candidates. Those tile candidates are hidden by default in the viewer and require `mapCandidate=1`, because the visible result is still known to disagree with captured gameplay. The renderer is still gated because these are bytecode hints, not proven terrain execution. The generic viewer no longer treats `guangmingshendian.sce` as the default Godwar entry, though it remains the richest anchor for parity checks.
- `cbe_ui_asset_probe.js` records the new device-reference correction and scans screenshot-grounded visual candidates from raw CBE. Current result `cbe-ui-asset-probe-ready`; `众神之战.CBE` has 283 GIF resources and 115 actor resources, with all GIF graphic-control delays equal to `0cs`, so resource GIF metadata does not prove the reported 15fps. The real `光明神殿` screenshots show a texture-composited HUD/softbar over an ice/water temple scene, not the old RLE tile-grid candidate. The strongest HUD/softbar evidence is `touxiang*`, `honggang.gif`, `hongzi.gif`, `jibieziti*.gif`, `jinbi*.gif`, `caidan*`, `renwu*`, `jineng*`, and `guangminshenlan_jineng*.gif`; light-temple candidates include `zhongliqu_1.gif`, `shuitai.gif`, `shidui.gif`, `shijiezhishu.gif`, `diaoxiang.gif`, `heermode.gif`, `nanna.gif`, `fali.gif`, and `lang.gif`. The grid/shutter loading footage stays classified as a compositor/transition effect, not terrain decoding.
- `cbe_guangming_role_probe.js` locks the exact `guangming.gif` question to code evidence. Current result `cbe-guangming-role-probe-ready`; `0068_guangming.gif` is `171x182`, one GIF descriptor, `0cs`, and sheet-like, but it has `0` direct `.actor` references in the current parser. The original `LOADLIGHTGOD` block at `0x0000698A` resolves resource strings through Thumb literal loads to `guangmingshen_jineng.actor` at `0x000049F6` and `guangmingshen.actor` at `0x00004A12`; the latter actor points to `dao_guangmin.gif`, not to `guangming.gif`. The raw `guangming.gif` string hits are currently catalog/resource-name evidence or substrings of `jineng_guangming.gif`, so an engine-faithful composite from `guangming.gif` still needs a hidden resource-index/record path before promotion.
- `cbe_copy_helper_probe.py` checks the shared copy helpers at `0x34540/0x3453C`. The writeback call site at `0x11FD2` has no local guard between `0x11AE6` and `blx 0x34540`. The helper island still needs a fuller decode, but diagnostic ARM decoding shows copy-like `r0` destination / `r1` source access (`stmhs r0!, ...`) and does not prove a destination-null guard. That removes the easy "null writes are safe" escape hatch for now; unresolved writebacks remain effect-blocking.

## Actor Stream Evidence

`cbe_actordump.js` currently reports:

- `115` actor files
- `115` actor streams with an FF-heavy token/sentinel candidate
- `0` without that candidate

The dominant candidate shape is a high-byte control pair followed by `FF FF FF`.
Examples:

- `0401_heermode.actor`: `85 DB FF FF FF` at stream offset `0x0062`
- `0423_nanna.actor`: `85 F5 FF FF FF` at stream offset `0x0039`
- `0392_fali.actor`: `85 F5 FF FF FF` at stream offset `0x003F`
- `0442_tianbing.actor`: `85 F5 FF FF FF` at stream offset `0x01AF`

Current interpretation:

- the FF-heavy pattern is stable and useful for alignment
- it may be a token/sentinel inside the compact integer stream rather than a hard section boundary
- surrounding data is likely action/frame/template metadata
- compact numeric probing now sign-extends `0x82` and `0x83` values:
  - `0x82` is treated as signed 16-bit big-endian
  - `0x83` is treated as signed 24-bit big-endian
  - `0x84`/`0x85` remain signed 32-bit little-endian candidates because actor markers such as `85 DB FF FF FF` decode cleanly to `-37`
- `cbe_streamtrace.js` now reports the scored `0x0F222` actor layout instead of only the older raw8 wording. For `0401_heermode.actor`, the best current parse is:
  - `+0x50` count `8` at file offset `0x001B`
  - `+0x64` best candidate table `fixed8`, records at `0x001C..0x005B`
  - fields at file offset `0x005C`: `cellW=60`, `cellH=8`, `extentW=119`, `extentH=8`
  - matrix `2/2` at `0x0060..0x0061`
  - FF-heavy token candidate still later at `0x007D`, so it remains a marker candidate, not a hard divider

This is a stable structural clue, not yet a complete grammar.

## Map/SCE Evidence

`0312_guangmingshendian.sce`:

- `SCE2` at `0x000A`
- canvas `480x528`
- map table starts immediately after the magic and canvas fields
- map record `guangmingshendian.map`, fields `0,0,1,1`
- scene stream starts at `0x0032`
- decoded placements:
  - `heermode.actor @ 53,232`
  - `nanna.actor @ 178,113`
  - `fali.actor @ 313,119`
- `cbe_streamtrace.js` now ties these placements directly to raw scene bytes:
  - `0x0129..0x012E` = `type=15`, `x=53`, `y=232`, followed by `heermod` at `0x012F`, resolved to `heermode.actor`
  - `0x0140..0x0145` = `type=15`, `x=178`, `y=113`, followed by `nanna` at `0x0146`, resolved to `nanna.actor`
  - `0x0150..0x0155` = `type=15`, `x=313`, `y=119`, followed by `fali` at `0x0156`, resolved to `fali.actor`

`0347_guangmingshendian.map`:

- tileset `zhongliqu_1.gif`
- sibling `.sce` canvas `480x528`
- lead header at `0x001E`: `E0 06 15 82 10 02`
- decoded as:
  - stored width `1760`
  - width bias `0x500`, giving `480`
  - flags `0x8215`
  - height `528`
- draw stream starts at `0x0024`
- the first draw stream wide token `83 FF FF 00` now decodes as `-256`, not `16776960`
- current maptrace reports expose raw buffer draw/RLE candidates as evidence only; the map stream should still be treated as bytecode until the renderer is proven

The map stream still needs a true bytecode/record interpreter. Grid-stitch output remains diagnostic only and should not be treated as reconstruction.

Video transition evidence supplied on 2026-05-22 shows a black screen with a bright rectangular grid / shutter-like reveal during scene switching or loading. Treat this as a screen-transition/compositor effect, not map terrain evidence. It may be useful later when modeling scene changes, because it could correspond to an engine-level wipe between `CLOSESCRIPT`/`LOAD*`/scene-load paths, but it should not be used to justify the current map tile-grid candidate.

## Stream Trace Baseline

`cbe_streamtrace.js` is the current baseline for the next reverse-engineering pass.

It emits:

- exact file offsets
- raw bytes consumed by each read
- reader guess (`u16le`, `+0x64 ref`, `+0x50 compact`, anchored ref scan)
- decoded value/text
- target object field
- known disassembly anchor

Default command:

```powershell
node .\src\cbe_streamtrace.js
```

Current default output:

- `out_godwar_streamtrace\stream_trace.txt`
- `out_godwar_streamtrace\stream_trace.json`

The trace proves the map is larger than the WQVGA screen (`480x528`) and that actor/NPC references point to complete actor resources and complete GIF sheets. The startup image confirms the phone-facing screen for this title is `240x400`. It deliberately does not render the map or split GIFs into visual tiles. The remaining hard problem is resolving the exact `+0x4C/+0x50/+0x64` reader semantics for the map draw bytecode and actor/template records.

## Emulator Runtime Baseline

`cbe_runtime.js` is the first explicit simulator-facing artifact. It starts from a `.sce` resource and emits `runtime_scene.json` with:

- WQVGA screen size inferred from the startup image, currently `240x400`, and full scene canvas
- startup/title screen candidate, currently resolved from filename hints such as `fengmian.gif`
- linked map resource, tileset, lead header, and draw-stream offset
- decoded scene actor placements with actor resource, primary GIF, GIF dimensions, and current `0x0F222` template evidence
- linked `.xse` script resources
- runtime status flags that keep terrain rendering, actor animation playback, and XSE VM execution marked as pending rather than guessed

For `0312_guangmingshendian.sce`, the runtime graph currently links the initial `fengmian.gif` title image, `guangmingshendian.map`, `zhongliqu_1.gif`, `s_02.xse`, and the three scene actors `heermode`, `nanna`, and `fali`. The viewer now keeps `.sce` preview focused on this runtime graph; detailed terrain stream diagnostics remain on the linked `.map` resource.

Interactive emulator work is paused. The earlier `heermod -> heermode.actor` player-control inference was too aggressive because user memory and script evidence indicate a dual-protagonist structure: one light side and one dark side. `heermode`, `heer`, `guangmingshen`, and `heianshen` should be treated as role candidates or actor/resource names, not as proven playable mappings.

`cbe_storytrace.js` is now the active analysis path before more simulation work. It emits `out_godwar_storytrace\story_trace.md/json` and groups:

- light-side text/resources such as `光明`, `巴尔德`, `guangmingshen`, `tx_guangmin`, and `jineng_guangming`
- dark-side text/resources such as `黑暗`, `霍德尔`, `heianshen`, `tx_heian`, and `jineng_heian`
- story names such as `奥丁`, `洛基`, `赫尔`, `南娜`, `孪生`, and scene/temple references

Current evidence from the text dump strongly ties `巴尔德` to `光明神` and `霍德尔` to `黑暗神`, but does not yet prove which actor resources are player-controlled at each point. The next analysis target is reconstructing script transitions among `guangmingshendian.sce`, `heianshendian.sce`, and `zhongli.sce`.

## Raw Boot Data Evidence

`cbe_bootdata_trace.js` scans the raw CBE bytes before the first unpacked resource section, `0x000000..0x0393F6`. This matters because several boot/title/manual strings are not stored in extracted `.xse` resources.

Confirmed raw offsets:

- `0x0359CE`: `可通过连续点击攻击按键产生连击的动作，连续伤害到敌人可累计连击次数`
- `0x022CAA`: `重新开始游戏会删除存档，是否开始？`
- `0x022D0E`: `没有游戏存档，请选择新的游戏！`
- `0x037F2D`: a dark-route ending/teaser paragraph ending with `请关注黑暗神剧情篇章。`
- `0x037FC2`: opening narration beginning `光明神巴尔德和黑暗神霍德尔是诸神之王奥丁与芙莉嘉所生的一对孪生子...`
- `0x03833A` and `0x0387FB`: full keypad/touch operation help text. Both versions explicitly say `游戏中分为光明神和黑暗神两个主角，剧情各不相同，任务承前启后。`

This directly supports the user's correction: there are two protagonists/routes, so actor-control and route assumptions must remain paused until the route scripts and branch state are decoded.

## XSE Opening Route Evidence

`cbe_xseflow.js` now emits `out_godwar_xseflow\xse_flow_trace.md/json`. It is a focused trace, not a full VM decompiler.

Current concrete route edges:

- `guangmingshendian.sce -> s_02.xse`
- `s_02.xse -> zhongli.sce`
- `zhongli.sce -> s_03.xse`
- `heianshendian.sce -> s_01.xse`

Important script evidence:

- `s_02.xse` contains `LOADLIGHTGOD`, `SETROLEPOS`, a `zhongli.sce` reference, and dialogue where 南娜 talks to 巴尔德.
- `s_03.xse` contains `LOADDARKGOD`, `OPENCR`, and dialogue about the brothers deciding who goes to the human village: `你们兄弟俩谁去人界的圣灵村看看...` followed by `让我去吧！`
- `s_01.xse` contains `LOADHERERSKILL` and dark-temple/冥王 evidence.
- `s_04.xse` contains `LOADLIGHTGOD` and a 洛基 line claiming to act under 黑暗神霍德尔.

The next decoder target is the XSE command/argument grammar around `GETGAMESTATE`, `LOADLIGHTGOD`, `LOADDARKGOD`, `SETROLEPOS`, `CANSAY`, and `OPENCR`.

`cbe_xsecmd_probe.js` now emits `out_godwar_xsecmd\xse_command_probe.md/json` for that target. Current command-window observations:

- `LOADLIGHTGOD`, `LOADDARKGOD`, `GETGAMESTATE`, `SETROLEPOS`, `CANSAY`, and `CLOSESCRIPT` often appear as full ASCII atoms with immediate length bytes.
- Other command-like pieces are interleaved with bytecode/control bytes, for example `SCREENSIZE`, `RAMODE`, `RTDIALOG`, `SHOW`, `ROLEPOS`, `SKILL`, and `ISF`.
- `OPENCR` in `s_03.xse` is especially important because it is not an immediate length-prefixed atom in the same simple way as `CANSAY`; that likely marks either an argument/control prefix pattern or a different command emission form.
- 2026-05-21 correction: `cbe_xsecmd_probe.js` and `cbe_xse_skeleton.js` now import object-boundary summaries from `out_godwar_xseobject`. The visible command atoms in the focused scripts are all marked as `symbol-pool`, so `SETROLEPOS` candidates such as `[6, 37, 139]` in `s_02.xse` remain pool-adjacent hypotheses, not decoded VM calls.
- The reports now also repeat the `sb+0x86DC` script-record layout and the opcode switch field map near `0x11492`, so command-string scans stay tied to the actual 0x112C4 parser structure.

## XSE Route and Task Evidence

`cbe_route_trace.js` now emits `out_godwar_routes\route_trace.md/json` from the recovered `.xse` text dump. This is a story/task reconstruction aid, not a VM decompiler.

Route buckets are currently supported by these file families:

- common opening/setup: `s_01.xse`, `s_02.xse`, `s_03.xse`, `s_04.xse`
- light route: `gm_dialog.xse`, `gm_maintask.xse`, `gm_taskpro.xse`, `gm_monster.xse`
- dark route: `ha_dialog.xse`, `ha_maintask.xse`, `ha_taskpro.xse`, `ha_monster.xse`

Current light-route evidence:

- `gm_dialog.xse` names 巴尔德, 南娜, 奥丁, 霍德尔, 赫尔, 洛基, 冥界, 死亡之国, and the prophecy that 巴尔德 will be killed by his twin brother 黑暗神霍德尔.
- `gm_maintask.xse` recovered main task titles: `杀死狼群`, `噩梦惊魂`, `心灵神药`, `万物灵符`, `寻找普拉神咒`, `伐拉的预言`, `抢夺器具`, `救治南娜`, `真假灵符1`, `火神传说`, `寻找机关`, `破解魔咒`, `终极命运`.
- `gm_taskpro.xse` recovered related/progress tokens: `杀死狼群`, `心灵神药`, `万物灵符`, `普拉神咒`, `玲珑之火`, `八角银器`, `开启魔法机关`, `九转龙潭剂`.

Current dark-route evidence:

- `ha_dialog.xse` opens with 赫尔 addressing 黑暗神霍德尔 and includes 霍德尔 saying he wants to kill 光明神, plus later conflict around 巴尔德, 洛基, 赫尔莫德, and revenge.
- `ha_maintask.xse` recovered main task titles: `杀死狼群`, `勾结冥王`, `将计就计`, `天魔神符`, `离间洛基`, `找到死亡灵符`, `光明神之死`, `控制冥界`, `背叛奥丁`, `封印瓦宫`, `威胁`.
- `ha_taskpro.xse` recovered related/progress tokens: `杀死狼群`, `天魔神符`, `死亡灵`, `破解魔法机关`, `普拉神咒`.

This strengthens the two-protagonist correction: the game has distinct light/dark plot and task tracks. It still does not prove the exact branch predicate, save-state flags, or actor-control mapping. Those remain blocked on XSE object/table reference decoding.

## Script Command Handler Evidence

`cbe_script_handler_trace.py` now emits `out_godwar_scripthandlers\script_handler_trace.md/json`.

The important correction is that the earlier `cbe_symbols.js` `handlerOffset` field was only a simple string-table-relative diagnostic. The real command handler address is resolved in the registration code:

- `ldr r2, [pc, #...]` reads the signed relative word stored immediately before the command name.
- `add r2, pc` applies that relative word using the registration-site PC base.
- `adr r1, #...` points to the command name; in this binary the command-name PC base lines up as instruction address `+2`.

With that model, all 32 command registrations resolve and 25 land on direct Thumb prologues. Current high-value targets:

- `SHOWDIALOG -> 0x00006C08`: reads `number[1]`, `ref/string[0]`, then advances 2 script arguments.
- `SETROLEPOS -> 0x000068A2`: reads `number[2]`, `number[1]`, `number[0]`, writes actor position fields, then advances 3 script arguments.
- `SETCAMERAMODE -> 0x000067CE`: reads four numeric arguments and advances 4.
- `CHANGESCENE -> 0x000063B4`: reads one string/reference argument and advances.
- `LOADLIGHTGOD -> 0x0000698A` and `LOADDARKGOD -> 0x00006904`: distinct setup blocks. Keep the exact actor-control assignment paused until these blocks are correlated with actor/resource loads.
- `GETGAMESTATE -> 0x0000646A`: an inner state-check label that returns a VM branch/result without obvious normal argument reads on the target path.
- `OPENCR -> 0x0000611E`: a direct prologue block with calls through VM/service slot `+0x20`; exact gameplay meaning is still unresolved.

This handler map is the current bridge between XSE byte windows and decompiler output. The next useful step is to teach the XSE pass to consume this command arity/type table, then re-run it on `s_02.xse`, `s_03.xse`, and the protagonist-selection path.

`cbe_xse_skeleton.js` is the first cautious pass that does that. It emits `out_godwar_xseskel\xse_skeleton.md/json` and intentionally labels the output as a skeleton, not a finished VM decompiler.

Current useful skeleton findings:

- Exact full command rows resolve through the handler map, for example `LOADLIGHTGOD`, `LOADDARKGOD`, `SETROLEPOS`, `CANSAY`, `CLOSESCRIPT`, and `OPENCR`.
- The stream also contains command fragments such as `SCREENSIZE`, `RAMODE`, `ROLEPOS`, `SHOW`, `RTDIALOG`, `DARK`, `LIGHT`, and `SWORD`; these are kept as context atoms rather than forced into final calls.
- In `s_02.xse`, the full `SETROLEPOS` atom at `0x042F` has gap bytes `0D 06 25 8B`. Dropping the next visible length byte gave candidate numeric values `[6, 37, 139]`, but this is now downgraded to a pool-adjacent candidate because the later layout pass shows the tail bytes are symbol slots, not proven execution bytes.
- In `s_04.xse`, the same downgrade applies to the earlier `[8, 24, 132]` candidate after the `SETROLEPOS` atom at `0x0496`.
- In `s_03.xse`, the role-position evidence currently appears as the fragment `ROLEPOS` rather than a full `SETROLEPOS` atom, so it remains a context clue rather than a decoded call.

`cbe_xse_layout_trace.js` now emits `out_godwar_xselayout\xse_layout_trace.md/json` and is the current guardrail for XSE decompilation.

The focused opening scripts show a stable file shape:

- resource envelope, then `XSE0` at `0x000A`
- a `0x112C4`-style object/table probe region beginning at `0x000F`
- a post-probe binary span
- a text/resource pool containing dialogue and refs such as `tianbing.actor` and `zhongli.sce`
- a tail label/symbol pool beginning at `INIT`, followed by `_MAIN` and script symbol slots

Important concrete examples:

- `s_02.xse`: object/table probe `0x000F..0x02BD`, text/resource pool `0x031F..0x0403`, label/symbol pool `0x0403..0x04AB`; refs include `tianbing.actor` and `zhongli.sce`, and dialogue places 南娜 with 巴尔德 before the `zhongli.sce` transition.
- `s_03.xse`: object/table probe `0x000F..0x02C9`, text/resource pool `0x05D8..0x0726`, label/symbol pool `0x0726..0x080C`; dialogue contains 奥丁 asking which brother should go to 圣灵村 and the response `让我去吧！`.
- Mixed symbol slots such as `0x0439 len=13 visible=.%.SCREENSIZE` and `0x0447 len=13 visible=...C.3.RAMODE` explain why simple ASCII scans observe command fragments. These fragments are evidence for the script symbol vocabulary, not a decompiled linear command stream.

This means the next hard target is not more ASCII scanning; it is correlating the `0x112C4` object/table references with offsets into the text/resource/symbol pools so the actual XSE VM order can be recovered.

`cbe_xse_object_trace.js` is the focused follow-up for that target. It emits `out_godwar_xseobject\xse_object_trace.md/json` and replays the parser shape observed around raw CBE `0x112C4`:

- object header starts at stream-relative `+6`
- slot capacity reads as `8` in `s_01.xse` through `s_04.xse`
- group count reads as `6` in all four focused opening scripts
- group/opcode records are parsed before the text/resource pool, confirming that tail command-name hits are not a linear executable script

Current object-trace alignment:

- `s_01.xse`: best diagnostic group end `0x021D`, best tail boundary `0x0286`, first text at `0x0366`
- `s_02.xse`: best diagnostic group end `0x0272`, best boundary hypothesis `0x02A1`, first text/ref at `0x031F`; this stays before `tianbing.actor`, but the next range-count read is still invalid
- `s_03.xse`: best diagnostic group end `0x0299`, best tail boundary `0x02C9`, first text at `0x05D8`
- `s_04.xse`: best diagnostic group end `0x0280`, best tail boundary `0x02ED`, first text at `0x0377`

The parser order is now anchored in the CBE code:

- `0x115B8`: reads the first post-group count through service slot `+0x50`, allocates a temporary `count * 4` array, loops through the reader/service `+0x74` callback, then uses that temporary array to backfill opcode `2` records
- `0x11672`: reads the range count through `+0x50`, allocates `count * 0x14`, then each range reads `+0x50`, a raw byte, another `+0x50`, and a `+0x64` reference
- `0x11752`: reads the final reference count through `+0x50`, stores the count at script-record `+0x70`, allocates the `count * 4` final-ref array at `+0x6C`, and loops through `+0x64`

This means the remaining blocker is not command-string scanning. It is resolving the real reader semantics for service slots `+0x64` and especially `+0x74`. The service-layer report adds an important correction: `0x2B2C` is only the first initializer pass for `0x35C0`; `0x2A4A` runs after it and overwrites several focused slots. `cbe_vtable_resolve.py` now exposes both old `address+4` and Thumb-aligned ADD-PC halfword candidates. For `+0x74`, the focused candidates are now explicit: halfword ADD-PC lands around `0xDCC8/0xDCCA`, while a big-endian word diagnostic points at dispatcher-like `0x11094` that loads another object's `+0x74` before `blx`. So this is a callback-layer tracing problem, not a solved stream-reader width.

`cbe_reader_callback_trace.py` now emits `out_godwar_reader_callbacks\reader_callback_trace.md/json` to keep this callback ambiguity separate from the XSE object parser:

- XSE post-group parser sites still resolve through `sb+0x35C4`, with halfword-sensitive literal pools also carrying `0x86DC`.
- The halfword `+0x74` candidate at `0xDCC8` is inside the `0xDCA8` wrapper; it calls `[sb+0x3590][0]` first, then calls `0xDC4C`, which prepares a temporary buffer and dispatches through `[sb+0x2444][+0x28]`.
- Direct caller scans put `0xDCA8`, `0xDC4C`, and `0xD5EA` in draw/coordinate-style wrapper paths. `0x11094` has no direct caller because it is a mid-function child-slot load, not an entry point.
- The `0x11094` candidate is an object-list dispatcher over `0x84`-byte child records, calling child slot `+0x74`; sibling code dispatches `+0x78`.
- Therefore `+0x64/+0x74` must remain symbolic in emulator scaffolding until object/ref arrays can be matched to concrete pool indices.

`cbe_xse_ref_correlation.js` now emits `out_godwar_xseref\xse_ref_correlation.md/json` as a direct sanity check against overfitting object fields to pool offsets:

- Direct `value` / `base+value` matches to visible text/resource/symbol-pool offsets are currently zero in `s_01.xse` through `s_04.xse`.
- Weak matches from transforms such as `textStart+value` are dominated by tiny field values (`1`, `8`, `10`, etc.) landing near the first text run, so they are not decoded references.
- This supports keeping the post-group arrays symbolic until the actual `+0x64/+0x74` callback semantics are recovered.

`cbe_runtime.js` now threads that caution into the emulator scaffold. Linked scene scripts include symbolic XSE evidence:

- object summary (`groupEnd`, `tailEnd`, tail mode, warnings)
- full command atoms from `xse_skeleton`, explicitly marked as `symbol-pool`
- ref-correlation counts showing direct matches are currently zero
- route/story bucket snippets from `route_trace`

The runtime scene still keeps actor control disabled. For `guangmingshendian.sce`, `s_02.xse` is linked as common-opening evidence with `LOADLIGHTGOD`/`SETROLEPOS` visible only as symbol-pool atoms and `object+68` tail warning still unresolved.

`cbe_script_record_trace.py` now emits `out_godwar_scriptrecord\script_record_trace.md/json` for the `sb+0x86DC` per-script table. The current field map is:

- `sb+0x86DC`: 5 script records, stride `0x74`
- script record `+0x48/+0x4C`: group table pointer/count, with 0x0C-byte group entries
- script record `+0x54/+0x58`: flat 0x28-byte opcode record table pointer/capacity
- script record `+0x64/+0x68`: 0x14-byte range table pointer/count
- script record `+0x6C/+0x70`: final reference array pointer/count
- first post-group `+0x74` refs: temporary opcode-2 backfill array, not the persistent `+0x70` final-ref field

## Observed Boot Flow

User-observed real-device/video flow is now treated as the boot sequence ground truth:

1. Cold start shows a gameplay tip plus a progress bar. One observed tip is: `可通过连续点击攻击按键产生连击的动作，连续伤害到敌人可累计连击次数`.
2. A skippable pre-title animation plays before the cover. It includes dark-side sword/skill imagery, light-side sword/skill imagery, and caption cards such as `在此天地交接之处，无尽遥远的彼方`, `战争不断的持续，这属于神之间的战斗`, and `即将开始`.
3. The cover/title screen uses `fengmian.gif`, with snow-like particles and image-rendered menu buttons such as new game/load progress.
4. Starting/loading enters another tip/progress screen.
5. Opening narration introduces `光明神巴尔德` and `黑暗神霍德尔`, then shows intro visuals using `zhongliqu_2.gif` followed by `zhongliqu_1.gif`.
6. The flow later reaches light/dark protagonist selection.

`cbe_bootflow_trace.js` emits `out_godwar_bootflow\boot_flow_trace.md/json` for this sequence. Direct resource anchors currently include:

- `LOADING.gif` (`70x62`)
- `fengmian.gif` (`240x400`)
- `zhucaidan1.gif`
- `kaichang.sce` (`240x320`, no map table; strong pre-title/opening scene container candidate)
- `zhongliqu_2.gif` (`144x112`)
- `zhongliqu_1.gif` (`128x224`)
- `xuanzetouxiang.gif`
- `tx_guangmin.gif`
- `tx_heian.gif`
- `jineng_guangming.gif`
- `jineng_heian.gif`
- `guangmingshen.actor`
- `heianshen.actor`

The exact combo-tip sentence is now confirmed by `cbe_bootdata_trace.js` at raw CBE offset `0x0359CE`; it was simply outside the extracted `.xse` resources. The specific pre-title caption strings and `读取进度` still do not appear in the current raw/extracted text scans, so treat those as unresolved: likely image-rendered, compressed, or encoded in a path the current scanner misses. The next decompile target is the XSE command grammar for the opening route through `s_02.xse`, `zhongli.sce`, `s_03.xse`, and the light/dark selection resources.
