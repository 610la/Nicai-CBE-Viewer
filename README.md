# CBE 网页模拟器研究工具集

[English README](README_EN.md)

这是一个用于研究尼采/MStar 时代 `.CBE` 游戏格式的逆向工程工作区。长期目标是做一个能够加载标准 CBE 容器的通用网页运行时/模拟器，而不是把某一个游戏单独重做或移植。

`众神之战` 是当前主要研究样本，因为它同时包含 `.sce`、`.map`、`.actor`、`.xse`、图片、音频、存档和脚本证据。但项目里的代码和结论都应尽量保持通用 CBE 工具链方向。

## 当前状态

这不是一个完成品模拟器，而是一套研究工具。目前已经具备：

- 扫描和解包标准 CBE 资源段
- 按扩展名/资源类型列出和分类资源
- 对 `.sce`、`.map`、`.actor`、`.xse` 做结构化探测
- 本地网页查看器，用于浏览资源表、字节、结构、场景和运行时探测结果
- 从 CBE 资源构建早期 scene graph
- XSE VM/provider 的 trace-only 实验
- 针对 `GodWarGameRecord` 的手机侧存档解析

仓库可以包含公开样本文件：CBE 文件统一放在 `cbe file/`，尼采手机系统/存档文件统一放在 `nicai system files/`。工具运行后生成的 `out_*` 解包目录、日志和调试截图不会上传到 GitHub，需要时可以在本地重新生成。

## 快速开始

需要：

- Node.js 18 或更新版本
- Python 3，用于 Thumb 反汇编辅助脚本
- Python `capstone`，只在运行 ARM/Thumb 反汇编脚本时需要

启动本地查看器：

```bash
npm run viewer
```

然后打开：

```text
http://127.0.0.1:4173
```

当前网页查看器的游戏列表来自本地 `out_batch/batch_manifest.json`。即使仓库里已经放了公开样本 CBE 文件，第一次运行查看器前仍需要先解包到 `out_batch`：

```bash
node src/cbe_unpack.js "./cbe file" out_batch
npm run viewer
```

公开样本 CBE 文件可以放在 `cbe file/`；手机系统/存档文件可以放在 `nicai system files/`。如果只有一个 CBE 文件，也建议先放进 `cbe file/` 再运行上面的命令。这样会生成查看器需要的 `batch_manifest.json`。

部分底层 API 可以直接读取 CBE 文件，不一定依赖解包目录；但当前网页 UI 的资源列表仍以 `out_batch` 为入口。

大多数 probe 支持显式传入路径，例如：

```bash
node src/cbe_unpack.js "./cbe file/game.CBE" out_game
node src/cbe_runtime_core_probe.js "./cbe file/game.CBE"
node src/cbe_godwar_record_probe.js "./nicai system files/.system/MB_MSTAR_WQVGA" "./cbe file/众神之战.CBE"
```

## 重要文件

- [docs/README_CBE.md](docs/README_CBE.md)：详细工具清单和研究记录
- [docs/CBE_EMULATOR_ROADMAP.md](docs/CBE_EMULATOR_ROADMAP.md)：通用模拟器路线图
- [src/cbe_unpack.js](src/cbe_unpack.js)：CBE 资源段加载/解包器
- [src/cbe_runtime_core.js](src/cbe_runtime_core.js)：通用 raw-CBE runtime shell
- [src/cbe_runtime.js](src/cbe_runtime.js)：第一阶段 scene graph/runtime 构建器
- [src/cbe_struct.js](src/cbe_struct.js)：共享结构分析器
- [src/cbe_godwar_record_probe.js](src/cbe_godwar_record_probe.js)：`众神之战` 手机存档解析器
- [src/viewer_server.js](src/viewer_server.js) 和 [viewer/](viewer/)：本地网页 UI
- [docs/PROJECT_STRUCTURE.md](docs/PROJECT_STRUCTURE.md)：仓库结构说明
