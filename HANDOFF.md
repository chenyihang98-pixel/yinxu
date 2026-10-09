# 音序 Muse：仓库交接

快照日期：2026-10-09（Asia/Tokyo）。适用版本：`muse-bgm@0.3.0`。工作目录：`D:\makeBGM`。
本文件是接手智能体的主入口，由当前源码、`package.json`、最后一轮测试与打包的结果整理而成。代码和测试比本文更新；用户当前的要求优先于本文。先读 S00、S01，再按任务读对应章节。

## S00｜快速接手：先只读这一节

- **产品**：把一句话变成纯器乐背景音乐，可以试听、用对话继续改、调四条分轨、导出。Windows 桌面版（Electron）和只有本地作曲的静态网页版共用一套渲染层代码。
- **做音乐的两种方式**：①**本地作曲（引擎 2）**：符号作曲器 → Score → 纯 TypeScript 合成器；48 kHz、四分轨、−16 LUFS；离线、免费、确定性；22 种风格、14 种主奏乐器、24 个调。②**云端 AI 音乐服务**（仅桌面版，用户自己的密钥）：腾讯云 TokenHub、火山引擎、阿里云百炼 Fun-Music、ElevenLabs；每次一个付费请求，返回一条混合音轨。
- **制作人**（把话变成制作方案）：离线规则（永远可用）和可选的大模型（Claude 官方 SDK、OpenAI 兼容接口、本机 Ollama；只从主进程调用；失败时回退到规则并说明原因）。
- **验证边界（最重要）**：云端音乐服务和托管的大模型只在本机模拟的服务上跑通过，**没有用过任何真实付费账号**；真实的外部调用只有本机 Ollama。安装包**从未运行过**。只在 Chromium / Electron 里测过。**没有人听过生成的音频**——响度、平衡、接缝的结论全是测量值。不要把模拟写成真实联调，不要把测量写成「好听」。
- **结构**：`src/` 渲染层（React 19 + TypeScript + Vite 7）；`electron/` 主进程（CommonJS，Electron 41）；`window.museDesktop` 是唯一的桥（13 个方法，S08）。渲染层 CSP 为 `connect-src 'none'`，外部请求全部从主进程发出。没有后端、自动更新和遥测。
- **状态规则**：`studio.project` 是已生成的作品（标题、封面、混音、导出都读它）；`studio.draft` 只是「声音微调」里没应用的修改；输入框里的字只是字。每次生成都是新作品（新 id、`revision + 1`、`parentId`），旧版本保留。
- **钱和数据的规则**（`src/state/studioFlows.ts` 文件头）：付费请求先确认；从不自动重试生成；云端音频先保存再解码；保存失败的结果留在窗口并提示导出；已生成但没取回的文件用「重新下载」，不再付一次钱。
- **数据**：作品在 IndexedDB `muse-bgm` / `projects`；桌面数据目录 `%APPDATA%\Muse BGM`，凭据在其中的 `music-credentials.json`（Windows safeStorage 加密）。开发时不需要读取或清空它们；测试和套件都用临时目录。
- **不要运行旧程序**：`release/` 里的 0.1.0 / 0.2.0 EXE 与 0.3 共用数据目录和数据库，会把 0.3 的作品改写成旧引擎作品并丢掉对话（S11）。`启动音序.cmd` 只启动与 `package.json` 版本一致的便携版。
- **最低开发动作**：`npm run typecheck`、`npm test`（约 1 分钟；`npm run test:fast` 几秒）。改了界面或主进程：`npm run build` 后跑相应的 Electron 套件；`npm run test:all` 是完整回归（约 3.5 分钟，不含打包）。
- **仓库**：本地 Git，没有远端；四个提交，基线 `634c650`（v0.2.0），HEAD `7972e71`。**HEAD 之后的评审修复、整理、打包配置和全部文档都在工作区里没有提交**（约 220 个路径），提交与否由仓库主人决定。文本固定为 LF，代码用 Prettier。
- **发行物**：`release/` 里有从当前代码打出的 0.3.0 安装版和便携版（文件名与哈希见 S10）。**什么都没有发布**：没有 GitHub 仓库和 release，门户页面没有上线。
- **最该先做的事**（S11 第一组）：仓库主人听一遍 `demos/` 的 22 段示例；用真实账号各做一次最便宜的云端生成和一次托管大模型的规划。

## S01｜阅读与改动导航

| 任务 | 本文 | 最少源码 |
| --- | --- | --- |
| 运行、介绍 | S03、S10 | `README.md`、`package.json` |
| 改界面 | S04、S05 | `src/ui/**`、`src/state/types.ts`（状态契约）、`src/ui/styles/` |
| 改生成 / 保存 / 多标签页流程 | S05 | `src/state/studioFlows.ts`、`libraryFlows.ts`、`kernel.ts`、`tests/app-*.test.ts` |
| 改制作人的理解（离线规则） | S07 | `src/agent/lexicon.ts`、`reading.ts`、`rules.ts`、`tests/agent-rules.test.ts` |
| 改大模型接入 | S07、S08 | `src/agent/brain.ts`、`electron/agent/*.cjs`、`electron/agent-service.cjs` |
| 改音乐（曲式、和声、旋律、节奏、风格） | S06 | `src/music/**`、`tests/music-*.test.ts` |
| 改音色、效果、母带 | S06 | `src/audio/**`、`tests/voices-*`、`fx`、`render`、`audio-quality`、`style-mix-*` |
| 播放器 | S05 | `src/player/usePlayer.ts`、`clock.ts`、`tests/player-*.test.ts` |
| 作品库、导入导出 | S05 | `src/storage.ts`、`src/services/exporter.ts`、`tests/storage*.test.ts` |
| 云端服务、凭据、IPC | S07、S08 | `electron/providers/*.cjs`、`music-service.cjs`、`key-store.cjs`、`main.cjs`、`preload.cjs`、`docs/API配置指南.md` |
| 网页版、门户嵌入 | S10 | `vite.config.ts`、`src/platform.ts`、`scripts/web-smoke.cjs` |
| 打包发布 | S10 | `package.json` 的 `build`、`scripts/packaged-smoke.cjs`、`启动音序.cmd` |
| 判断「测过什么」 | S09、S11 | `docs/QA.md`、`test-results/*.json` |

定向读取示例（PowerShell）：

```powershell
Get-Content .\HANDOFF.md -TotalCount 51      # S00 + S01
rg -n '^## S' HANDOFF.md                     # 章节行号
rg --files src electron tests scripts docs   # 文件清单
```

不要把 `node_modules/`、`dist*/`、`release/`、`demos/`、`test-results/`、锁文件全文和二进制塞进上下文。`.scratch/` 是被 Git 忽略的草稿区（重建期间各轮的报告、评审、探针脚本和测量结果），不是产品的一部分，也可能随时被清掉。

章节：S02 历程与决定 · S03 功能与边界 · S04 架构与文件地图 · S05 数据契约与不变量 · S06 本地引擎 · S07 云端音乐与大模型制作人 · S08 桌面边界 · S09 测试 · S10 环境、命令、打包、发布、网页版 · S11 已知限制与下一步 · S12 维护本文。

## S02｜历程与关键决定

| 阶段 | 做了什么 |
| --- | --- |
| v0.1.0 | React + Electron 骨架、关键词规则 + 简单合成、ElevenLabs、便携 EXE |
| v0.2.0（基线 `634c650`，2026-10-08） | 三家国内云端服务、多凭据加密存储、工作流修复。六种情绪、四种主奏、五个调、32 kHz、单文件界面（`App.tsx` 1842 行） |
| v0.3.0（2026-10-08 晚至 10-09） | 整体重建，见下 |

**推动重建的审计结论**（对 v0.2 的七份只读审计，`.scratch/audit/`）：

- 状态：草稿和已生成的作品共用一个 `config`，造成四处已确认的「界面与声音不一致」（APP-01…04）；没有对话、历史和版本关系。
- 引擎：每个有音高的音色只是 2–4 个静态正弦分音，四种乐器在频谱上几乎一样；24 组预设实测 −19.2 到 −24.4 LUFS、峰值 −7.8 到 −13.4 dBFS、2 kHz 以上的能量只占 0.05–0.40 %；文本理解是对六种情绪的首个正则命中，认不出就落到默认值。
- 存储：一条读不了的记录会让整个作品库显示为空（PS-01）。
- 主进程：小写盘符启动时所有 IPC 被拒（F01）；一条坏凭据让全部服务状态失败（F03）；火山任务一次轮询失败就丢掉已付费的任务（F02）；服务商的错误码被丢弃（F04）；不走系统代理（F05）。
- 网页：`body` 最小宽度 780 px，窄屏没有布局；浏览器里云端入口是死路。
- 门户：旧的产物文件名不被门户的发布同步脚本识别（SITE-01）。

**重建的组织方式**（一段话）：先由负责人写下契约文件（共享清单、`MusicConfig` / `Project` / `DesktopAPI`、Score 中间表示、音色与渲染契约、软削波、制作人契约）以及实现简报和界面规格；第一轮十个并行实现（作曲核心、22 个风格、DSP 基础、键盘与拨弦音色、长音与贝斯音色、鼓、渲染与效果与母带、主进程、制作人、存储与播放器），提交 `1b1186e`；第二轮做引擎集成（Worker、测量工具、质量门槛）、按风格分三组的混音评审、引擎收尾、应用内核、界面、端到端套件和制作人补充，提交 `24e5854`；随后一轮跟进（发行程序冒烟、Worker 导出、本机模型预热、规则措辞），提交 `7972e71`；第三轮是八份互相独立的评审（制作人、应用内核、音频引擎、作曲、遗留与一致性、桌面安全、渲染层数据安全、界面与文案），共 71 条已确认的发现，逐条修复并配回归测试；最后是集成整理、排版、打包和本次文档。修复、整理、打包、文档这几步都没有提交（见 S00）。修复阶段没有留下逐条的书面报告：某一条是否修了，以测试名里的编号为准（`rg -n 'MAIN-0|CORE-0|AGENT-' tests`），没修的列在 S11。

测试名和少量注释里的编号是这些条目的稳定标签：`AGENT-`（制作人）、`MUS-`（作曲）、`ENG-`（音频引擎）、`CORE-` / `RB-`（应用内核与渲染层数据安全）、`UX-`（界面与文案）、`MAIN-`（主进程）、`LEFT-`（遗留项）、`F##` / `APP-##` / `PS-##`（v0.2 审计）、`QA-##`（第二轮端到端缺陷）。

**值得记住的决定**：

- **引擎 1 冻结**：`config.engine === 1` 的作品永远走 `src/audio/engine-v1.ts`（32 kHz），样本与 0.2 一致（有哈希测试）。在它上面做任何修改都会生成一个引擎 2 的新版本，原作品保留。存储里没有 `config.engine` 的记录就是引擎 1。
- **Score 中间表示**：作曲器只决定「什么时候奏什么」（`compose(config) → Score`，纯函数、确定性），合成器只把事件变成声音（`renderScore`）。Score 是纯数据，可以整个发给 Worker。风格是数据（`StyleDef`），引擎里没有按风格 id 分支的代码。
- **48 kHz**：引擎 2 的渲染和导出都是 48 kHz 立体声、16 位 WAV（TPDF 抖动，固定种子，所以导出逐字节可复现）。
- **成品分轨 + 软削波**：四条分轨是成品音频，总线处理和响度增益已经烘焙进去；听到和导出的都是 `softClip(Σ 分轨 × 推子)`，推子永远不触发重新渲染。播放器里的 `WaveShaperNode` 用的是同一条曲线，所听即所导。
- **渲染在 Worker 里**：一个常驻的模块 Worker 完成作曲、合成、母带和 WAV 导出的混音编码；Worker 起不来时退回到调用线程分片执行。同一时间只有一个渲染（音色有模块级状态，不可重入）。
- **两个制作人**：离线规则保证没有网络、没有密钥、网页版里也能用；大模型是可选的增强，只从主进程调用，结果在主进程和渲染层各校验一次，失败就回退到规则并说明原因。
- **主进程的网络栈**：所有主进程请求走 Chromium 网络栈（遵守系统代理），不带 Cookie、不写缓存。**计费请求走专用通道**：Chromium 在复用连接被重置时会自己重发 POST，所以四家服务的计费 POST 使用独立的内存会话，每次请求前关闭所有连接，并全局关闭 QUIC。
- **付费保护**：发送前确认、不自动重试、先保存后解码、保存失败留在窗口并可重试 / 导出、文件没取回时「重新下载」、关闭窗口前询问（S05、S07）。
- **存储保持数据库版本 1**：`muse-bgm` / `projects` 与 0.2 相同，旧作品库原样可读；工程 JSON 的 `schemaVersion` 升到 2。读入时逐条严格校验，读不了的进入「损坏记录」而不是让整个列表失败。代价是旧程序还能写这个库（S11）。
- **网页版**：同一份渲染层代码，`vite build --mode web` 产出相对路径的静态站点，可以放进 iframe；没有云端和大模型（界面上标为「桌面版可用」并给出下载链接）。
- **循环片段按整小节对齐**：速度或时长会被微调，使结尾正好落在小节线上；界面、制作人的回复和标签显示的是对齐后的实际值。
- **旋律连续性由作曲器说了算**：`melodyContinuity(before, after)` 返回 `identical` / `adapted` / `new`，回复里那句「旋律保持不变 / 旋律动机不变，会按新的设置重新演绎 / 这是一段新的旋律」就来自它；云端和旧引擎作品不承诺保留旋律。
- **听不出区别就不算新版本**：会渲染出完全相同音频的请求只回答、不生成。
- **文案统一**：作品库叫「我的作品」；结构叫「循环片段 / 完整结尾」；参数叫「情绪能量 / 旋律丰富度 / 空间混响 / 主奏乐器」；分轨叫「旋律 / 和声 / 贝斯 / 鼓组」；引用一律用「」。

## S03｜功能与产品边界

| 区域 | 已实现 | 边界 |
| --- | --- | --- |
| 创作 | 描述（最多 1500 字）+ 可选的风格（「自动」或 22 种）、时长（15 / 30 / 60 / 90 / 120 秒）、结构（循环片段 / 完整结尾）、生成引擎、制作人；输入框下实时显示离线规则的理解 | 选了大模型时预览注明「发送后由大模型重新理解」 |
| 试听 | 波形、段落带、和弦条；空格播放、← / → 定位 5 秒、`L` 循环试听（循环片段默认开，完整结尾默认关）、`Ctrl+Enter` 发送、`Ctrl+N` 新建、`Ctrl+E` 导出 | 浏览器标签页里拦不住 `Ctrl+N`，帮助里只在桌面版列出 |
| 对话微调 | 自然语言指令；数字按最近的维度词理解（「快 10 bpm」「速度降到 90」「加长 15 秒」「鼓调到 30%」）；听不懂时如实说并给出例子 | 不支持人声、撤销、只改某一段、3/4 拍、模仿具体歌手；会说明 |
| 声音微调 | 风格、速度（50–200 BPM）、调性、主奏乐器、情绪能量、旋律丰富度、空间混响、时长、结构；「应用调整」同一旋律种子生成新版本；「换一版旋律」换种子 | 这两个按钮用离线规则直接出方案，不经过大模型；云端引擎下它们都是新的付费请求 |
| 混音台 | 旋律 / 和声 / 贝斯 / 鼓组推子（即时、自动保存）、静音、独奏 | 独奏只影响试听，不影响导出；云端作品没有分轨 |
| 我的作品 | 改名、收藏、搜索、排序、8 秒可撤销的删除（云端作品要再确认）、导入工程 JSON、损坏记录的原始数据和原始音频导出；同一首曲子的各版本共享一条对话 | 全部在本机；没有账号、同步、协作 |
| 导出 | 混音 WAV（48 kHz / 16 bit；循环片段可重复 ×2 / ×4）、单轨 WAV、工程 JSON；云端作品另有原始音频（MP3 / WAV / M4A / FLAC 原样） | 工程 JSON 不含音频，云端作品不能靠它恢复；云端作品的 WAV 导出是解码后重采样到 48 kHz 的 |
| 设置（桌面） | AI 音乐服务凭据、制作人大模型、关于（版本、数据目录） | 密钥只写不读；保存成功只代表已保存，不代表已连通 |
| 桌面 | Windows x64 安装版（NSIS，当前用户）和便携版；默认窗口 1440×940，最小 1060×720 | 没有自动更新、没有代码签名、没有 macOS / Linux 包 |
| 网页版 | 完整的本地作曲、作品库（浏览器 IndexedDB）、多标签页同步 | 没有云端和大模型；作品只在这个浏览器里 |

本地作曲是「乐理规则 + 确定性随机 + 程序合成」：离线、可控、可重建、不计费。它不是在本机运行的生成式音乐大模型，音色是合成的。

## S04｜架构与文件地图

```text
index.html → src/main.tsx → App.tsx（AppProvider + AppShell，外面是 ErrorBoundary）
  界面 src/ui/**  ──读 useApp()、调 actions──▶  应用内核 src/state/**（不依赖 React）
     ├─ 制作人  src/agent：离线规则；大模型经 desktop.agentPlan → 主进程
     ├─ 本地    src/audio/engine.ts → Worker(worker.ts)：compose(config) → Score → renderScore → 四条分轨
     ├─ 云端    desktop.generateMusic → preload → IPC → music-service → providers/* → ArrayBuffer → 先保存再解码
     ├─ 播放    src/player：4 × 源 → 4 × 推子 → 淡入淡出 → WaveShaper(softClip) → 主音量
     ├─ 存储    src/storage.ts：IndexedDB（本地作品存配方，云端作品存音频 Blob）
     └─ 导出    services/exporter.ts → Worker 混音编码 → desktop.saveAudio（系统保存框）或浏览器下载
主进程 electron/main.cjs：窗口、13 个受信任的 IPC 通道、凭据、网络封装、关闭确认
```

- **两个构建**：`vite build` → `dist/`（Electron 以 `file://` 加载）；`vite build --mode web` → `dist-web/`（`__MUSE_WEB__ = true`）。两者都是相对路径（`base: "./"`），各有一个主包和一个 Worker 包。`src/platform.ts` 是唯一接触 `window.museDesktop` 的模块；网页版即使页面上有个叫 `museDesktop` 的对象也不会用它。
- **CSP**：`electron/csp.cjs` 与 `vite.config.ts` 里是同一个字符串（`tests/csp.test.cjs` 逐字比较）；构建时写进 `<meta>`，这是 `file://` 页面真正生效的那一份。

### 根目录

| 文件 | 职责 |
| --- | --- |
| `package.json`、`package-lock.json` | 版本号（唯一来源）、20 个 npm 脚本、依赖、`build`（electron-builder 配置和打包文件过滤） |
| `vite.config.ts`、`tsconfig.json`、`index.html` | 两个构建目标、CSP `<meta>` 注入、`__APP_VERSION__` / `__MUSE_WEB__`；严格 TS（`verbatimModuleSyntax`），`tsc -b` 只覆盖 `src/` |
| `.gitattributes`、`.gitignore` | 文本 LF、`*.cmd` CRLF、音频与图片二进制；忽略 `node_modules`、`dist*`、`release`、`test-results`、`demos`、`.scratch`、`*.log` |
| `.prettierrc`、`.prettierignore` | Prettier 默认；不排版 Markdown、清单 JSON、`src/agent/lexicon.ts` 和 22 个风格定义文件（手工对齐的表格） |
| `启动音序.cmd` | 启动 `release\Muse-BGM-Portable-<版本>-x64.exe`；没有该版本时启动最新的便携版；都没有时给出说明。`MUSE_LAUNCHER_DRY_RUN=1` 只打印会启动哪个文件 |
| `README.md`、`HANDOFF.md`、`AGENTS.md`、`CLAUDE.md`、`LICENSE`（MIT） | 用户说明、本文、两个智能体入口 |
| `docs/` | `API配置指南.md`（用户配置指南）、`QA.md`（验证记录）、`research-minimax.md`、`research-volcengine.md`（协议核验依据） |
| `examples/` | `晴空漫步.muse.json` + `晴空漫步.wav`（引擎 2 的示例，30 秒，测试核对它与当前引擎一致）、`legacy-v0.2-夏日小事.muse.json`（0.2 工程，测试夹具） |
| `demos/`（被忽略） | `npm run demos` 的输出：22 段示例 WAV 和 `index.md` |
| `release/`、`test-results/`（被忽略） | 发行物（S10）；各套件最近一次的结果 JSON 和截图（里面还混有 0.2 时期的旧截图） |

### `electron/` 主进程（CommonJS）

| 文件 | 职责 |
| --- | --- |
| `main.cjs` | 应用启动、窗口与安全选项、13 个 `muse:*` 通道的注册、保存对话框、单实例锁、`disable-quic`、会话权限一律拒绝 |
| `preload.cjs` | 冻结的 `window.museDesktop`（13 个方法）；去掉 Electron 的 IPC 错误前缀，只留中文消息 |
| `ipc-guard.cjs` | 谁可以调用 IPC：主窗口主框架、页面是应用自己的 `dist/index.html`（按文件路径比较，Windows 下不分大小写）或开发地址；只有 `MusicError` 的消息能过桥 |
| `csp.cjs` | 渲染层的 Content-Security-Policy 字符串 |
| `net-fetch.cjs` | 基于 Electron `net` 的 `fetch`（`createNetFetch`）和计费专用通道（`createBillingFetch`、分区 `muse-billing`） |
| `music-service.cjs` | 云端生成的总入口：任务锁、5 分钟时限、取消、ElevenLabs 分支、适配器路由、`retryLastDownload`、安全文件名、外链白名单 |
| `providers/shared.cjs` | `MusicError`、密钥格式（10–4096 个可打印 ASCII）、有上限的读取、`requestJson`、音频格式识别、带逐跳域名校验和重试的 `downloadAudio` |
| `providers/tencent.cjs`、`volcengine.cjs`、`aliyun.cjs` | 三家国内服务的请求、错误码映射、轮询和下载（S07） |
| `credentials.cjs` | 服务 id、各服务凭据与模型的规范化；大模型设置的规范化（`normalizeLlmSettings`）和 Claude 模型列表 |
| `key-store.cjs` | `music-credentials.json` 的加密读写、逐项状态、V1 → V2、不可读旧密钥的备份 |
| `agent-service.cjs` | 大模型规划的任务锁、90 秒 / 240 秒时限、取消、本机模型预热；只把校验过的方案和模型 id 交回渲染层 |
| `agent/plan-schema.cjs` | 方案的 JSON Schema、系统提示词、`validatePlanInput` / `validatePlan` / `completePlan`、`buildMessages` |
| `agent/anthropic.cjs` | 经官方 SDK 调 Claude（结构化输出），自己控制请求头和目标主机 |
| `agent/openai.cjs` | OpenAI 兼容的 `chat/completions`（含本机 Ollama）、请求形状降级、预热 |
| `agent/base-url.cjs` | 接口地址策略：公网 HTTPS / 本机回环、内网与私有地址拒绝、受限端口、调用前的 DNS 复查 |
| `close-guard.cjs` | 关闭窗口和退出应用前的询问逻辑（云端生成进行中、有未保存的付费成果） |
| `context-menu.cjs` | 最小的右键菜单：文本框里的剪切 / 复制 / 粘贴 / 全选，选中文本上的复制 |
| `shared/music-catalog.json` | 风格、主奏乐器、调、段落类型、鼓和贝斯律动、数值范围的**唯一清单**（主进程和渲染层都读） |
| `assets/muse.svg`、`.png`、`.ico` | 应用图标（`scripts/generate-icons.py` 可重新生成，非运行依赖） |

### `src/` 渲染层

**入口与适配**

| 文件 | 职责 |
| --- | --- |
| `main.tsx`、`App.tsx`、`env.d.ts` | React 启动、根错误边界、空闲时预热 Worker；`AppProvider` + `AppShell`；构建期常量的类型 |
| `types.ts` | 跨层契约：`MusicConfig`、`ArrangementHints`、`Project`、`RenderResult`、`DesktopAPI`、`DesktopSettings` |
| `platform.ts` | 桌面 / 网页适配：`platform`、`desktop`、`saveFile`、`openExternal`、`safeFileName`、`newId`、下载页地址 |
| `providers.ts` | 四家云端服务在界面上的事实（名称、模型、时长范围、官方链接）、MIME → 扩展名 |
| `storage.ts` | 作品库（IndexedDB）与工程 JSON：严格校验、逐条读取、按字段更新、损坏记录、导入导出 |
| `services/generation.ts` | 把设置变成音频：`runLocal`（引擎）、`runCloud`（桥）、`decodeBlob`（48 kHz 解码） |
| `services/exporter.ts` | 导出：混音（可重复）、单轨、原始音频、工程 JSON；永远从已生成的作品出发 |
| `player/usePlayer.ts`、`player/clock.ts` | 不依赖 React 的 `PlayerEngine` 和薄 hook；走带算术（定位、淡入淡出、推子平滑） |

**`src/music/` 作曲器**

| 文件 | 职责 |
| --- | --- |
| `catalog.ts` | 清单 JSON 的类型化视图（`STYLE_IDS` 等字面量由 `tests/catalog.test.ts` 与 JSON 对齐）、`parseKey` |
| `score.ts` | Score 中间表示、`VOICE_IDS`（29 个音色）、`DRUM_KINDS`（23 种）、`DRUM_KITS`（8 套）、`PartMix`、`SAMPLE_RATE` |
| `defaults.ts` | `DEFAULT_CONFIG`、`stylePreset`、`clampConfig`、`cleanArrangement`、`promptSeed`、`ROMAN` |
| `random.ts`、`theory.ts` | 具名分叉的种子随机；音阶、调、罗马数字和弦、声部进行、乐器音域 |
| `form.ts`、`harmony.ts`、`melody.ts`、`rhythm.ts` | 速度与长度的规划和曲式；和声与伴奏声部；主旋律、副旋律、琶音；时间映射、鼓、打击乐、贝斯 |
| `compose.ts` | `compose(config) → Score`、`summarize(score)`、`melodyContinuity(before, after)` |
| `validate.ts` | `scoreProblems(score)`：合成器和界面依赖的全部结构规则 |
| `styles/types.ts`、`styles/index.ts` | `StyleDef` 及其各部分的类型；风格注册表 `STYLE_DEFS: Record<StyleId, StyleDef>` |
| `styles/<id>.ts`（22 个） | `acoustic` `ambient` `battle` `bright` `chill` `chiptune` `cinematic` `corporate` `cute` `dance` `dreamy` `epic` `festive` `focus` `guofeng` `hiphop` `jazz` `retro` `rock` `romantic` `sad` `tension`：每个风格的数据定义 |

**`src/audio/` 合成器**

| 文件 | 职责 |
| --- | --- |
| `engine.ts` | 门面，界面唯一的音频入口：`renderMusic`、`mixStems`、`computePeaks`、`mixdownInWorker`、`prewarm`、`configureEngine`、`engineStatus` |
| `worker.ts` | 渲染任务（作曲 → 合成 → 母带 → 摘要）和承载它的 Web Worker；`attachWorker` |
| `render.ts`、`render-types.ts` | Score → 四条成品立体声分轨；渲染、门面、Worker 之间的契约和 Worker 协议 |
| `master.ts`、`loudness.ts`、`softclip.ts` | 母带总线（鼓总线压缩、低频单声道、倾斜与性格 EQ、粘合压缩、前视限制器、响度增益）；BS.1770-4 响度计；最后一级软削波 |
| `fx.ts`、`fx/{common,chorus,delay,duck,reverb}.ts` | 效果门面；合唱、乒乓延迟、按底鼓闪避、8 线 FDN 混响、循环预热 |
| `drums.ts`、`drums/{core,membrane,snare,cymbal,metal,shaken,chip}.ts` | 鼓合成器入口（23 种 × 8 套）；鼓皮类、军鼓 / 拍手 / 刷子类、镲与锣、金属波表、摇晃类、8-bit 套 |
| `dsp/index.ts` + `math` `osc` `filters` `envelopes` `noise` `rng` `delay` `fm` `modal` `string` `saturate` `fft` `voice` `memory` `extra-keys` `extra-sustained` | DSP 工具箱：振荡器、滤波器、包络、噪声、延迟线、FM、模态合成、Karplus-Strong 弦、饱和、FFT、音色的电平约定、及时释放内存、两个音色组各自的辅助 |
| `voices/types.ts`、`voices/index.ts`、`voices/testing.ts` | 音色契约（一个音色渲染一个音符）；完整音色库 `VOICES`；测量工具（只供测试和草稿脚本） |
| `voices/group-{keys,plucked,sustained,bass}.ts` | 四个音色组的装配和各自的契约参数 |
| `voices/keys/{piano,epiano,mallets,organ}.ts` | 钢琴、电钢琴、钟琴 / 八音盒 / 马林巴 / 颤音琴、风琴 |
| `voices/plucked/{strings,pluck,overdrive}.ts` | 木吉他 / 尼龙吉他 / 古筝 / 拨奏；电子拨弦；失真吉他 |
| `voices/sustained/{strings,pad,airpad,brass,choir,winds,lead,chip}.ts` | 弦乐、暖垫、空气垫、铜管、人声垫、长笛与竹笛、合成器主音、8-bit 方波与脉冲波 |
| `voices/bass/{sub,synth,plucked,chip,b808}.ts` | 低频贝斯、合成贝斯、指弹与低音提琴、三角波贝斯、808 |
| `mixdown.ts`、`wav.ts` | 导出混音（界面线程和 Worker 共用同一套算术）；16 位 WAV 编码 |
| `engine-error.ts` | `EngineError`：`code`、给用户看的中文 `message`、只进控制台的 `detail` |
| `engine-v1.ts` | 冻结的 0.2 合成器和它的取值范围（`LEGACY_MOODS` 等） |

**`src/agent/` 制作人（渲染层一侧）**

| 文件 | 职责 |
| --- | --- |
| `types.ts` | 契约：`AgentRequest`、`AgentPlan`、`AgentTurn`、`RawAgentPlan`、`AgentPlanInput`、`LlmSettingsInput`、`LlmStatus` |
| `lexicon.ts`、`reading.ts`、`rules.ts` | 词典（词 → 风格权重、维度、方向、目标声部）与分词；逐句阅读（否定、程度、抱怨、数字归属）；`planWithRules(request) → AgentPlan` |
| `brain.ts` | `producePlan`：有大模型时先问它，校验并夹回范围（`agentPlanFromRaw`），任何失败都回退到规则并写明 `fallbackReason` |
| `pins.ts` | 用户在界面上固定的风格 / 时长 / 结构，两条路径都强制生效 |
| `cloudPrompt.ts` | 把设置写成给云端音乐模型的中文提示词（`buildCloudPrompt`，最多 1800 字，以「纯音乐，无人声，无歌词」结尾）；`describeChanges` |
| `llm-presets.ts` | 十个大模型预设（Claude、DeepSeek、通义千问、豆包、智谱、Kimi、腾讯混元、OpenAI、本机 Ollama、自定义） |

**`src/state/` 应用内核（不依赖 React）**

| 文件 | 职责 |
| --- | --- |
| `types.ts` | 状态契约：`AppContextValue`、`StudioState` / `StudioView`、`Job`、`Dialog`、`AppActions`、`ExportRequest` |
| `core.ts`、`app.ts`、`ports.ts`、`context.ts` | `AppCore` 把各块接起来并暴露 `actions`；真实依赖的装配；对外部世界的接口（测试传入替身）；唯一的 React context（`useApp()`、`useAppActions()`） |
| `kernel.ts` | store、提示（toast）、询问（dialog）、作品库的唯一写入队列、按字段修改（`patch`）、会话 |
| `studioFlows.ts` | 输入、唯一的运行中任务（生成 / 打开）、云端结果的各种结局、混音保存、导出、`closeRisk()` |
| `libraryFlows.ts`、`settingsFlows.ts` | 列表、改名、收藏、软删除、导入、损坏记录、其他标签页的通知；凭据与大模型设置 |
| `reducer.ts`、`selectors.ts` | 全部渲染层状态和唯一能改它的代码（丢弃过期或已取消任务的结果）；派生视图 |
| `plan.ts` | 从用户动作到方案：`buildAgentRequest`、`planFromDraft`、`planVariation`、让方案说真话的 `withAskedDrums` / `inaudiblePlan` / `honestPlan` / `truthfulTiming`、`suggestionsFor`、`paidNotice` |
| `logic.ts`、`options.ts`、`score.ts`、`works.ts`、`format.ts`、`content.ts` | 纯函数：草稿与差异、文案统一（`houseStyle`）、定时常量；可选的引擎和制作人、任务阶段的文字；不渲染音频就读出作品的实际速度和长度；排序、搜索、版本关系；显示用的小工具；应用自带的文字（灵感卡片、示例） |
| `session.ts`、`sync.ts` | 跨启动记住的少量信息（localStorage `muse-bgm:session`）；标签页之间的通知（BroadcastChannel，退化为 `storage` 事件，键 `muse-bgm:sync`） |
| `shortcuts.ts`、`useStudio.ts`、`useLibrary.ts`、`useSettings.ts`、`usePlanPreview.ts` | 全局快捷键；薄订阅 hook；输入停顿约 300 ms 后的理解预览 |

**`src/ui/` 界面**

| 位置 | 职责 |
| --- | --- |
| `AppShell.tsx`、`ErrorBoundary.tsx` | 导航、当前页面、底栏、弹窗、提示；根错误边界（渲染失败时仍可导出内存里的作品） |
| `shell/` | `ShellNav`（≥1100 px 侧栏，以下为顶栏）、`BottomBar`（任务进度与迷你走带）、`CoreDialog`（付费确认等询问）、`UnsavedBanner`、`Toasts` |
| `studio/` | `StudioPage`、`ComposerHero`（新作品）、`ComposerOptions`、`StyleChips`、`PlayerCard`、`Waveform`、`Transport`、`ProducerThread`（对话）、`Mixer`、`Inspector`（声音微调） |
| `library/LibraryPage.tsx`、`inspiration/InspirationPage.tsx` | 我的作品；灵感（22 个风格卡片和场景提示词） |
| `modals/` | `SettingsModal`（AI 音乐服务 / 制作人大模型 / 关于）、`ExportModal`、`HelpModal` |
| `primitives/` | `Button`、`Controls`（滑块、选择、分段、标签）、`Modal`、`Tooltip`、`Art`（标志、封面、小波形） |
| `hooks/` | 小型 UI hook：`store.ts`、`uiStores.ts`（主走带是否在屏幕上）、`useAutosize.ts`、`useElementWidth.ts`、`useMediaQuery.ts`、`usePlaybackSelector.ts`（按播放头派生值，只在值变化时重渲染）、`useRenderCount.ts`（只在开发构建里计数）、`useStable.ts` |
| `logic/` | 无 DOM 的界面逻辑：`focus.ts`、`instruments.ts`（四个混音组里各有哪些乐器）、`timeline.ts`（段落带、和弦条、波形柱）、`tooltip.ts` |
| `styles/` | `index.css` 依次引入 `tokens` `base` `primitives` `shell` `studio` `library` `inspiration` `modals`；纯 CSS，没有远程字体和图片 |

### `tests/` 与 `scripts/`

| 位置 | 职责 |
| --- | --- |
| `tests/*.test.ts`（34 个）、`tests/*.test.cjs`（20 个） | 单元测试，逐文件见 S09 |
| `tests/helpers/` | `app-fakes.ts`（内核测试的时钟、存储、播放器、引擎、桥替身）、`electron-harness.cjs`（三个 Electron 套件共用的启动与主进程钩子）、`source-shape.cjs`（去掉排版后比较源文件接线）、`spectrum.ts`（DSP 测试的谱线测量） |
| `tests/fixtures/` | `music-3s.{mp3,m4a,wav}`（可解码的 3 秒音频，模拟云端返回）、`engine-worker.node.ts`（在真实线程里跑渲染 Worker）、`literal-aliasing.check.ts`（Node 24.18 的 V8 问题复现） |
| `scripts/web-smoke.cjs`、`desktop-smoke.cjs`、`ui-smoke.cjs`、`cloud-workflow.cjs`、`packaged-smoke.cjs` | 五个端到端套件（S09） |
| `scripts/audio-audit.ts`、`render-demos.ts` | 客观音频测量工具；示例渲染器（S06） |
| `scripts/typecheck.mjs`、`generate-icons.py` | 对 `src/`、`tests/`、`scripts/` 的类型检查；图标生成（需要 Python + Pillow，非运行依赖） |

## S05｜数据契约与不变量

**`MusicConfig`**（`src/types.ts`）：`prompt`、`mood`（风格 id）、`bpm`（50–200）、`duration`（15–120 秒，循环片段可能对齐到整小节）、`key`（24 个之一，如 `"F# minor"`）、`instrument`、`energy` / `complexity` / `reverb`（0–1）、`seed`（32 位无符号）、`loop`、`volumes`（四条分轨 0–1）、`engine`（`1 | 2`）、可选的 `arrangement`（`ArrangementHints`：和弦进行、段落计划、鼓和贝斯律动、摇摆量、附加声部开关、旋律写法；全部经过 `cleanArrangement`）。默认值在 `src/music/defaults.ts`（青春欢快、112 BPM、C 大调、钢琴、30 秒循环；默认推子 0.8 / 0.64 / 0.68 / 0.56）。`clampConfig` 用于制作人的输出（未知枚举退回当前值、数字夹回范围）；存储不用它，存储是严格校验。

**`Project`**：`id, title, createdAt, updatedAt, config, provider('local' | 四家服务), favorite, revision, tags, audioBlob?, audioDuration?, parentId?, chat?, cloud?{prompt, model?}`。本地作品只存配方和对话，打开时重新合成；云端作品存服务商返回的音频本身。

**存储**（`src/storage.ts`）：

- 数据库 `muse-bgm` **版本 1**、对象仓库 `projects`、主键 `id`——与 0.2 完全相同。
- 「schema 2」指工程 JSON：导出写 `schemaVersion: 2`，导入接受 1 和 2；更高的版本提示升级。导入永远生成新 id 和新时间，不覆盖已有作品；文件上限 1 MB；云端作品的 JSON 不能单独导入（没有音频）。
- **引擎缺省**：记录里没有 `config.engine` → 引擎 1，按 0.2 的范围校验（六种情绪、四种主奏、五个调、60–160 BPM）；`engine: 2` 按清单校验。本版本认识但与该引擎不匹配的取值是损坏；本版本不认识的风格 / 乐器 / 调 / 服务 / 引擎号 → 「由更新版本的音序创建，请升级后打开」。连 `provider` 和 `config` 都没有的值 → 「不是音序的工程数据」。
- `listProjects()` 返回 `{ projects, damaged }`：逐条读取，坏记录进入 `damaged`（带原因；`readRawRecord` 导出原始 JSON，`readRawAudio` 导出付费作品的原始音频），不影响其他作品。
- 其他上限：标题 80 字（界面编辑时 64）、标签 12 个 × 32 字、描述 2000 字、对话保留最近 40 轮（每轮 1500 字）。
- 已保存的作品只按字段修改：`updateProject(id, patch)` 在一个事务里读-改-写（`title`、`favorite`、`volumes`、`audioDuration`、`updatedAt`），所以一个标签页不会用旧数据覆盖另一个标签页的改动；已删除的记录不会被写回来。

**状态规则**（`src/state/types.ts`、`reducer.ts`）：

- 已生成 = `studio.project` + `studio.audio`。标题、封面、标签、推子、种子、导出都读 `project.config`。
- 草稿 = `studio.draft`，只有「声音微调」的九个字段（风格、速度、主奏、调、三个滑块、时长、结构），放不下种子、推子和描述，所以改不坏它们。`changedFields` 是算出来的，不是标志位。
- `studio.composerText` 只是文字；打字不会改草稿或作品。`studio.pins` 是新作品输入框里固定的风格 / 时长 / 结构，缺省表示「自动」。
- 推子写进已生成作品的 `volumes`：立即作用于播放，最后一次移动 400 ms 后（或松手时）保存。独奏只是试听状态。
- 版本：每次生成是一个新 `Project`；同一首曲子的版本靠 `parentId` 连成一条线，共享一条对话（最新版本带着整条对话）。

**任务与锁**（`StudioFlows`）：

- `running` 是同步的任务锁，第二个任务被拒绝、不排队；每个任务有 id。任务只能通过 `commit()` 和带任务 id 的 reducer action 改当前作品，被取消的任务两者都无效。
- 一次生成的顺序：输入检查 → 引擎可用性检查 → 当前作品若只存在于窗口里先处理 → 云端引擎先确认付费（可勾选「本次会话不再提示」，按服务记）→ 制作人出方案（大模型失败且引擎付费时停下来问：取消 / 重试大模型 / 用离线规则继续）→ 让方案说真话（`enforcePins`、`withAskedDrums`、`inaudiblePlan`、`honestPlan`、`truthfulTiming`）→ 本地渲染，或云端「请求 → 收到 → 保存 → 解码」→ `commit()` → 保存。
- 任务阶段：`planning`、`asking`、`rendering`、`cloud`、`downloading`、`saving`、`decoding`、`cancelling`。取消：本地是 `AbortSignal`；云端是 `desktop.cancelGeneration()`（只停止等待，服务端可能仍然完成并计费，文案如实说明）；规划是 `desktop.cancelAgent()`。
- 主进程另有两把锁：云端生成一次一个（`music-service.cjs`）、规划一次一个（`agent-service.cjs`），两者互不相干。

**云端结果的几种结局**：正常保存；保存失败 → 留在窗口，横幅「重试保存 / 导出原始音频」，3 秒后自动重试一次，离开前询问；解码失败 → 仍保存，可导出原始文件；取消后才到达 → 仍保存为新作品，不替换当前作品；音乐已生成但文件没取回（主进程消息以「音乐已生成，但下载失败」「已取消下载。」「下载等待超过」开头）→ 常驻提示上的「重新下载」调用 `retryLastDownload`，不提交新请求。以上任何一种存在风险时 `closeRisk()` 非空，渲染层通过 `setUnsavedWork(true)` 告诉主进程，关闭窗口前会询问。

**作品库写入与多标签页**：所有写入走 `Kernel` 的一个队列；标签页之间通过 BroadcastChannel（退化为 `storage` 事件）通知「存了 / 改了 / 真删了」。删除是软删除：8 秒撤销窗口，到期或页面离开时才真正删除。

**会话**（localStorage `muse-bgm:session`）：`lastProjectId, composerText, brain, pendingRemovals[{id, expiresAt}], pendingMixes[{id, volumes, at}]`。后两项是页面关闭时还欠作品库的事（撤销窗口内的删除、没写完的推子位置），下次启动先做完。没应用的草稿不保存。

**播放器**（`src/player/usePlayer.ts`）：

```text
分轨作品：4 × AudioBufferSourceNode → 4 × GainNode（推子）→ 淡入淡出 → WaveShaperNode（引擎 2 的软削波）→ 主音量 → 输出
云端作品：AudioBufferSourceNode → 淡入淡出 → 主音量 → 输出
```

每次开始播放都创建一组独立的「声部」；定位是 10 ms 的交叉淡化，连续拖动合并成一次重启；推子和独奏是 `setTargetAtTime` 平滑（时间常数 15 ms）；从头播放有 2 ms 的起音斜坡（循环片段和云端音频的第一个样本不一定是零）；播放位置是独立的 store，最多每秒 30 次。导出不经过播放器。

## S06｜本地引擎（引擎 2）

**作曲管线**（`compose(config) → Score`，纯函数，耗时是毫秒级的，所以界面可以不渲染音频就读出一首曲子的实际速度、长度和配器）：

```text
clampConfig → 风格 + 调式 → 速度与长度（form.ts: planTiming）→ 曲式 → 和声
  → 主旋律 / 副旋律 / 琶音 / 伴奏 / 铺底 / 贝斯 / 鼓 / 打击乐（都写在拍格上）
  → 一次摇摆 + 人性化 → 秒 → 校验过的 Score
```

- **长度**：循环片段的小节数是 4 的倍数，速度在 ±6 % 内微调使音频正好是所要的长度；调不到时保持速度，长度对齐到偶数小节。所以实际值可能和设置不同——例如默认的嘻哈律动（88 BPM、30 秒循环）实际是 32.7 秒，可爱俏皮的 124 BPM 实际按 128 BPM。完整结尾的曲子严格保持速度和时长，结束在保持的主和弦上并留出自然衰减。
- **和声**：每种调式一个罗马数字进行库，功能替换、转位、副属和弦、借用和弦、挂留属和弦；和声色彩随「旋律丰富度」连续上升；有声部进行求解。
- **旋律**：每个段落家族一个动机，发展成问答乐句并有一个高点；强拍落在和弦音上，之间是级进的经过音。旋律按「种子 + 风格 + 段落类型」只写一次，速度、情绪能量、旋律丰富度只增删音符、移调或换八度。
- **节奏**：16 步的字符串律动、鬼音、过门、段落交界处的镲和冲击，贝斯跟底鼓。
- **两个连续旋钮**：情绪能量改变配器密度、音区、鼓的强度和音色亮度；旋律丰富度改变和声色彩、节奏细分、装饰音和副旋律。
- 只有 4/4 拍。副旋律是导音线加少量应答，不是第二条曲调。

**`StyleDef`**（`src/music/styles/types.ts`）：`id`、`summary`（一句中文）、`harmony`（调式与进行库、色彩、声部配置、循环转回、终止式）、`melody`、可选的 `lead`（按主奏乐器的混音微调）、`comp` / `pad` / `arp` / `counter` / `bass` / `drums` / `perc`、`swing`（0–0.66）与 `swingGrid`、`rubato`、`humanize`、`form`、`mix`（按声部角色）、`space`（混响与延迟）、`master`（`targetLufs`、`ceilingDb`、`character`、`tilt`、可选 `density`）。节奏写成 16 或 32 个字符的步进行：`.` 空、`g` 鬼音、`o` 轻、`x` 正常、`X` 重音、`r` 滚奏（只用于鼓）。22 个风格的 `targetLufs` 都是 −16、`ceilingDb` 都是 −1。

**怎样加一个风格**：

1. `electron/shared/music-catalog.json` 的 `styles` 里加一项（id、中英文名、描述、标签、标题候选、默认速度与范围、调、主奏、三个滑块、封面两色）。
2. `src/music/catalog.ts` 的 `STYLE_IDS` 字面量加上 id（`tests/catalog.test.ts` 保证与 JSON 一致）。
3. 仿照相邻风格写 `src/music/styles/<id>.ts` 并导出 `StyleDef`，在 `styles/index.ts` 的 `STYLE_DEFS` 里注册（`Record<StyleId, StyleDef>` 让编译器逐个检查）。引擎代码不用动。
4. `src/agent/lexicon.ts`：加词条，补 `STYLE_COORDS`、`STYLE_LEADS`（同样是 `Record<StyleId, …>`）。
5. 测试：`tests/music-core.test.ts`（「every definition is well formed」）和质量门槛 `tests/audio-quality.test.ts` 会自动覆盖新 id；在 `tests/music-styles.test.ts` 写它的身份测试，在对应的 `tests/style-mix-*.test.ts` 里钉住它的平衡，在 `tests/agent-rules.test.ts` 里补提示词期望；`tests/plan-schema.test.cjs` 里写死的数量（22 / 14 / 24）要改。
6. `npx tsx scripts/audio-audit.ts --style <id> --both --solo-parts` 看数字，`npm run demos -- --styles <id>` 出一段来听。门户页面上的 22 个风格名是另一份清单（S10）。

加主奏乐器同理：清单 JSON、`INSTRUMENT_IDS`、`VOICE_IDS`（`src/music/score.ts`）、`src/audio/voices/` 里的音色和契约、`theory.ts` 的 `LEAD_TRAITS` / `VOICE_RANGES` / `VOICE_LABELS`、词典。

**音色**（`src/audio/voices/`）：一个 `Voice` 把一个音符渲染进调用方给的立体声缓冲；渲染器负责时间位置、循环回绕、声像、效果和混合。29 个音色：14 个可选主奏（钢琴、电钢琴、木吉他、合成器主音、电子拨弦、钟琴、八音盒、马林巴、颤音琴、长笛、弦乐、古筝、竹笛、8-bit 方波）和 15 个只用于伴奏的（暖垫、空气垫、铜管、人声垫、风琴、尼龙吉他、脉冲波、五种贝斯加 808、弦乐拨奏、失真吉他）。共同的电平约定：A3–A4、力度 0.8 的单音在最响的 400 ms 里读约 −18 dBFS，力度律 `amp ∝ vel^1.5` 并且越响越亮；`assertVoiceContract`（`voices/testing.ts`）对每个音色检查电平、音高、起音、尾音、无爆音、不用 `Math.random`、44.1 kHz 也成立。个别音色有记录在案的偏差（短促的马林巴和拨奏在高音区读得偏低、8-bit 方波没有随力度变亮），都写在各组的 `*_CONTRACT` 里。合成方法：钢琴是加法 / 模态，电钢琴是 FM，钟琴类是模态，吉他 / 古筝 / 拨奏是扩展的 Karplus-Strong，弦乐 / 铜管 / 人声垫 / 暖垫是失谐合奏，木管是加法。

**鼓**（`src/audio/drums.ts` + `drums/`）：23 种 × 8 套（pop、lofi、electro、acoustic、brush、cinematic、chip、soft），全部合成、没有采样。每种每套一个固定增益（按采样率惰性校准），不做逐击归一化。开镲被下一个踩镲截断；底鼓、通鼓、太鼓、低频冲击被同类的下一击截断。`cymbalSwell` 的 `t` 是起点，1.8 秒后到达峰值（作曲器据此提前放置）。

**效果**（`src/audio/fx/`）：声部插入——高低切、驱动（2 倍过采样的削波器，支点在幅度 0.25）、合唱、宽度与声像、按底鼓的闪避曲线；发送——节拍同步的乒乓延迟、8 线 Hadamard FDN 混响（每声道 6 个扩散器、高低频分别设 RT60、调制）。循环模式下每个效果先在循环尾部预热，LFO 与循环同步，所以输出等于无限重复的循环。

**母带**（`src/audio/master.ts`）：鼓分轨先过一个前视峰值压缩器并把损失补回（同样的能量、更低的峰值）；每条分轨做低频（约 120 Hz 以下）单声道化、立体声保护、30 Hz 高通、倾斜 EQ 和性格着色（`clean` / `warm` / `lofi` / `wide` / `punchy` / `bitcrush`）；然后从参考混音求出**一条**增益曲线（2:1 粘合压缩 × 前视限制器 × 静态响度增益）乘到每条分轨上——所以分轨之和仍是母带后的混音，推子保持线性。限制器上限 `LIMITER_CEILING = 0.8`（约 −1.9 dBFS），随 `density` 最多再降 5 dB；软削波在 ±0.7 以内是线性的，输出永远不超过 ±0.881（−1.1 dBFS）。完整结尾的曲子最后 1.2 秒淡出到精确的零；开头不动，除非某条分轨会以台阶开始（那时才淡入 5 ms）。

**响度目标**：参考推子（0.8 / 0.64 / 0.68 / 0.56）下的 `softClip(混音)` 按 BS.1770 积分响度校准到 `master.targetLufs`（−16 LUFS）。只有纯瞬态素材会让母带刻意停在目标之下，最多 0.5 LU（`MAX_SHORTFALL_LU`），并记录在 `MasterDiagnostics.shortfallLu`。

**质量门槛**（`tests/audio-quality.test.ts`：22 种风格 × 循环片段和完整结尾，20 秒，种子 20261，共 44 次渲染，全部必须满足）：

| 项目 | 门槛 | 最后一轮测得（44 次渲染的范围） |
| --- | --- | --- |
| 积分响度 | −16 LUFS ±0.3，且母带没有欠量 | −16.02 到 −16.00 |
| 软削波之前的采样峰值 | ≤ 限制器上限 × 1.02 | −5.9 到 −2.0 dBFS |
| 软削波之后的真峰值（4 倍过采样） | ≤ −1 dBFS；越过削波拐点的样本 ≤ 0.1 % | 通过 |
| 峰值因数 | 9.5–18.5 dB | 11.7–17.1 |
| 频谱斜率（倍频程带，粉噪 = 0） | −5 到 +0.3 dB/倍频程；任一频段不超过 80 % 能量 | −3.92 到 −0.73 |
| 干净 | 没有孤立的样本台阶（爆音）、没有直流 | 通过 |
| 平衡 | 每条在演奏的分轨最响的 400 ms ≥ −40 LUFS；没有分轨盖过混音；旋律在 500 Hz–6 kHz 比和声多 ≥ 0.5 dB（氛围冥想除外），最响时不低于和声 | 通过 |
| 立体声 | 混音相关性 ≥ 0.35；分轨 ≥ 0.10；80 Hz 以下 ≥ 0.95 | 混音 0.585–0.983 |
| 循环接缝 | 回绕处的台阶 ≤ 平常的 1.5 倍、折角 ≤ 2 倍 | 台阶 ≤ 0.39 倍 |
| 完整结尾 | 从零开始；最后 50 ms ≤ −90 dBFS；尾部静音 ≤ 2.6 秒 | 最后 50 ms ≤ −117.8 dBFS |
| 母带动作 | 限制器工作时间 ≤ 22 %、深度 ≤ 6 dB；压缩均值 ≤ 2 dB | 通过 |
| 可复现 | 同一设置第二次渲染，分轨哈希逐位相同 | 通过 |

三个 `tests/style-mix-*.test.ts` 在这道底线之上，按风格组钉住混音评审定下的平衡（谁在上面、低频多少、多亮、多宽、段落对比），窗口约 ±1.5 LU。全部结论都是测量；「听起来对不对」没有人验证过（S11）。

**测量工具**：`npm run audit:audio -- --style <id|all> [--both] [--duration n] [--seed n] [--solo-parts] [--json f] [--wav dir] [--png dir]`（`scripts/audio-audit.ts`）打印响度、峰值、峰值因数、频段、斜率、相关性、分轨电平、接缝和越界项（`flags`），用的就是门槛里的同一批函数；`--png` 输出对数频率声谱图。斜率的单位是倍频程带电平的斜率（粉噪读 0）；FFT 分析仪上的 −4.5 dB/倍频程在这里读 −1.5。

**示例**：`npm run demos`（`scripts/render-demos.ts`）把 22 种风格各渲染一段有结尾的小曲到 `demos/`（默认 40 秒、种子 2026；太慢到不了副歌的风格每次加 5 秒，最多 60 秒），并写 `index.md`（速度、调、配器、编曲思路、响度）。`npx tsx scripts/render-demos.ts --example` 重写 `examples/晴空漫步.*`——**改了作曲器或合成器之后必须重新生成**，否则 `tests/examples.test.ts` 会失败（它把现渲染的结果和入库的 WAV 比到 −40 dB）。

**确定性规则**：影响音乐的代码里不许有 `Math.random()` 和 `Date.now()`；所有随机来自具名分叉（`rng.fork("melody")`），分叉只取决于种子和名字，所以改一个鼓的决定不会洗掉旋律；`config.volumes` 不影响 Score；音色用传入的 `ctx.random`。同一进程内渲染逐位相同（有测试）；不同 JavaScript 引擎之间 `sin` / `exp` / `pow` 可能有末位差异，所以示例文件的比较是 −40 dB 而不是逐位。纯模块（`src/music`、`src/audio` 除 Worker 胶水、`src/agent` 的规则）必须能在 Node 下运行：不碰 DOM、`window`、`AudioBuffer`。

**旋律连续性**：`melodyContinuity(before, after)`——种子、风格或旋律走向变了，或者任一边是引擎 1 → `new`；决定旋律音高和拍位的全部输入（调、主奏、旋律丰富度、循环与小节数、段落、每和弦小节数、和弦进行、音区、活跃度等）都没变 → `identical`；否则 `adapted`。`tests/music-continuity.test.ts` 在 22 种风格和多个种子上把每个答案和实际写出的 Score 对照。已知边界：大调 / 小调互换时保留节奏，音高按另一个调式的和声重写；旋律丰富度大幅变化且牵动主歌和声时，保留的音符比例会明显下降。

**性能与内存**（第二轮的测量，之后引擎还有改动，量级可参考）：120 秒的渲染在 Node 里 0.65–5.6 秒，在 Electron 的 Worker 里常见风格 2.7–5.8 秒，最重的史诗燃向单次测得 8.46 秒；Worker 路径下主线程没有长任务。一次 120 秒的渲染在 Node 里 ArrayBuffer 峰值约 310 MB，四条 120 秒的立体声浮点分轨本身是 184 MB，页面上每个在用的结果另有 184 MB 的 AudioBuffer。失败以 `EngineError` 拒绝；Worker 在约 1 秒内没准备好时先在调用线程渲染，并通过 `onPhase("starting")` 让界面显示「正在启动作曲引擎」。

## S07｜云端音乐服务与制作人大模型

### 云端音乐服务

| 服务 | 适配器 | 凭据 | 请求与结果 |
| --- | --- | --- | --- |
| 腾讯云 TokenHub | `providers/tencent.cjs` | TokenHub API Key（Bearer）、模型 `minimax-music-v3.0`（默认）/ `v2.6` | `POST https://tokenhub.tencentmaas.com/v1/wand/minimax-music/generation`；`is_instrumental: true`、`lyrics_optimizer: false`、`output_format: "hex"`、44.1 kHz / 256 kbps MP3。同步返回十六进制音频（`base_resp.status_code === 0` 且 `data.status === 2`）。描述 1–2000 字，时长作为一句目标写进描述 |
| 火山引擎 AI 音乐 | `providers/volcengine.cjs` | Access Key ID + Secret Access Key、计费方式（`postpaid` 默认 → `GenBGMForTime`；`prepaid` → `GenBGM`） | `POST https://open.volcengineapi.com/?Action=…&Version=2024-08-12`，V4 HMAC-SHA256 签名（region `cn-beijing`、service `imagination`）。正文 `Text`（必须含中文，前面加「背景纯音乐，无人声、无歌词。」）、整数 `Duration` 30–120、`Version: "v5.0"`、`Segments`。提交 → `QuerySong` 每 2 秒轮询、最多 150 次 → 从 `v1…v50-default.douyinvod.com` 下载 |
| 阿里云百炼 Fun-Music | `providers/aliyun.cjs` | 北京地域 API Key（Bearer）+ Workspace ID、模型 `fun-music-preview`（默认）/ `fun-music-v1` | `POST https://<workspaceId>.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/music/generation`；`is_instrumental: true`、`format: "mp3"`；描述连同时长目标 ≤ 2000 字。返回下载地址，只接受 OSS 桶域名（`<bucket>.oss-<region>.aliyuncs.com`，不含内网端点） |
| ElevenLabs Music | `music-service.cjs` 内 | API Key（`xi-api-key`）、模型 `music_v1`（默认）/ `music_v2` / `music_v2_5` | `POST https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128`；`music_length_ms`、`force_instrumental: true`；响应体就是 MP3 |

**从 0.2 起没有变的契约**：只请求纯音乐；端点固定为官方地址；提交不重试、不自动切换计费方式；错误只以主进程自己定义的中文消息（`MusicError`）过桥，上游响应体、请求头、地址和原始网络错误都不转发；下载不带任何凭据，每一跳重定向都重新校验域名；音频格式靠文件头识别（MP3 / WAV / FLAC / MP4），单个文件上限 80 MB；一次生成总时限 5 分钟；`generateMusic` 的 `duration` 接受 3–600 秒，各服务再各自收紧（火山 30–120）。提示词由 `buildCloudPrompt` 从设置生成（或用大模型写的 `cloudPrompt`），永远以「纯音乐，无人声，无歌词」结尾。

**0.3 改了什么**：

- **免费的步骤可以重试，付费的不行**：下载最多 4 次（间隔 1 / 2 / 4 秒；网络错误、408、429、5xx 才重试，每次从原始地址重新开始并重新校验）；火山的状态查询连续失败 5 次才放弃（退避到最多 15 秒）。提交仍然只发一次。
- **消息里带编号**：服务端有任务或请求编号时，超时、取消和下载失败的消息会附上它（火山「任务编号」、阿里「请求编号」、腾讯「追踪编号」），方便到服务控制台查找。只回显形如 id 的值，不回显自由文本。
- **枚举的服务商错误码**：非 2xx 的响应里，已知的错误码映射成固定的中文说明（鉴权、欠费、限流、内容审核、模型权限），未知的退回按状态码的说明。
- **重新下载**：音乐已经在服务端生成、但文件没有取回时（火山、阿里这两家返回下载地址的服务），主进程把「怎样再取一次」留在内存里；`retryLastDownload(provider)` 只收服务 id，地址不出主进程；与生成共用任务锁、取消和时限。下一次生成开始时丢弃，重启后也没有了。腾讯和 ElevenLabs 的音频就在那一次付费请求的响应里，没有可以单独再取的东西。
- **计费请求走不会重发的连接**（S08「网络」）：四家服务的那一个计费 POST 经 `submitFetch`；轮询和下载经普通的 `fetchImpl`。连接在响应头到达前断开时，结果报告为「请求结果未确认，先查看服务控制台记录」。
- **锁在读凭据之前就拿**：读取凭据期间的取消不会丢。
- **阿里云的下载域名收紧**到 OSS 桶域名（依据是文档，不是真实账号，见 S11）。

### 制作人大模型

**链路**：渲染层 `producePlan`（`src/agent/brain.ts`）→ 桥 `agentPlan` → 主进程 `agent-service.cjs`（校验输入、从加密存储读设置、上锁、计时）→ `agent/anthropic.cjs` 或 `agent/openai.cjs` → `validatePlan` → 渲染层 `agentPlanFromRaw` 再校验一次并夹回范围 → `AgentPlan`。只有「发送一句话」这条路径用大模型；「应用调整」和「换一版旋律」直接由规则出方案。

**三种 kind**（`electron/credentials.cjs`）：

| kind | 用途 | 地址 | 密钥 | 模型 |
| --- | --- | --- | --- | --- |
| `anthropic` | Claude，官方 SDK（`@anthropic-ai/sdk` 0.132.1） | 固定 `https://api.anthropic.com` | 必填 | 只接受 `claude-opus-5-5`（默认）、`claude-sonnet-5-5`、`claude-haiku-5-5` |
| `openai` | 任何 OpenAI 兼容的 `chat/completions` | 必须是公网 `https://` 域名；443 或 ≥ 1024 的端口；不能是内网、回环、单主机名 | 必填 | 用户填服务商的模型 id（字母数字和 `._:/-`，最多 128 字符） |
| `ollama` | 本机 Ollama | 只能是 `http://127.0.0.1`、`localhost`（被固定为 127.0.0.1）或 `[::1]`；默认 `http://127.0.0.1:11434/v1` | 没有 | 用户填 `ollama list` 里的名字 |

**预设**（`src/agent/llm-presets.ts`，十个）：`anthropic`；`deepseek`（`https://api.deepseek.com`）、`qwen`（`https://dashscope.aliyuncs.com/compatible-mode/v1`）、`doubao`（`https://ark.cn-beijing.volces.com/api/v3`）、`zhipu`（`https://open.bigmodel.cn/api/paas/v4`）、`moonshot`（`https://api.moonshot.cn/v1`）、`hunyuan`（`https://api.hunyuan.cloud.tencent.com/v1`）、`openai`（`https://api.openai.com/v1`）——以上七个都是 kind `openai`，模型名手填；`ollama`；`custom`。`tests/llm-presets.test.cjs` 保证每个预设都通过主进程的保存校验。这些地址和设置里「获取 API Key」的链接没有对着真实服务逐个验证过。

**发给模型的内容**（`buildMessages`）：固定的系统提示词（约 8600 个字符，由清单生成，说明输出格式、每个字段的含义和规则）；最近最多 12 轮对话（每轮最多 600 字）；最后一条用户消息带着模式（新作品 / 修改）、生成方式、当前设置的 JSON（风格、主奏、调、速度、时长、三个滑块、结构、四个推子；修改时还有当前的编排）和用户的话（最多 1500 字；界面上固定的选项以一行 `【界面选定】…` 附在后面）。**不发送**：任何音频、作品库、音乐服务的凭据、作品标题、之前的描述原文。

**请求形状**：

- Claude：`messages.create`，`max_tokens: 16000`，`output_config: { effort: "medium", format: { type: "json_schema", schema: PLAN_SCHEMA } }`。Opus 和 Sonnet 先走带 `server-side-fallback-2026-07-01` beta 的接口，收到 HTTP 400 时在稳定接口上再问一次（没有该 beta 的组织会对这个头返回 400）；Haiku 直接走稳定接口。SDK `maxRetries: 1`。客户端显式固定了 `baseURL`、`apiKey`、`authToken: null`、`logLevel: "off"`，并在自己的 `fetch` 里重写全部请求头——用户环境里的 `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_CUSTOM_HEADERS` 等都不能改变密钥发往哪里或随它发出什么。`stop_reason` 为 `refusal` 或 `max_tokens` 时给出专门的说明。
- OpenAI 兼容：`POST <baseUrl>/chat/completions`，`max_tokens: 4096`，`response_format: { type: "json_object" }`，`Authorization: Bearer`。HTTP 400 且错误文字里出现我们发过的参数名时把那个参数降级（`json_schema` → `json_object` → 不带；`max_tokens` → `max_completion_tokens`；去掉 `reasoning_effort`），最多 3 次；429 / 5xx 在 1.5 秒后重试一次。调用前解析主机名，任何一个地址是内网或回环就拒绝（解析不了的放行——公司代理后面只有代理能解析）。
- Ollama：同一个端点，但用 `response_format: json_schema`（strict）并加 `reasoning_effort: "none"`——实测 9B 的本机模型开着思考会把额度用完或把 JSON 提前关掉。没有 `Authorization`。
- 读取上限：OpenAI 兼容和 Ollama 的响应体 256 KiB、回答 64 KiB 字符（Claude 的响应体 1 MiB）；`extractPlanObject` 会去掉 `<think>` 块再找 JSON 对象。不够强的模型漏掉的字段由 `completePlan` 从当前设置补齐（从不替它猜枚举）。

**校验**：主进程 `validatePlan` 要求字段齐全、类型正确、枚举来自清单，数字夹进范围，字符串和列表截断，未知字段在每一层都丢弃，和弦进行只留作曲器读得懂的罗马数字。渲染层 `agentPlanFromRaw` 只读自有属性，再过一遍 `clampConfig` / `cleanArrangement`；新作品里只有文字提到的分轨才允许模型动推子；修改时忽略没人提到的小漂移（滑块 < 0.06、速度 < 3 BPM）；放不进时长的段落计划（不在可容纳小节数的 0.6–1.5 倍内）交还给作曲器；模型的回复宣称了设置里看不到的改动时不采用它的话；回复入库前经 `houseStyle` 统一引号和用词。

**时限与回退**：托管服务 90 秒、本机模型 240 秒（从请求开始算；`agent-service.cjs` 的 `HOSTED_TIMEOUT_MS` / `LOCAL_TIMEOUT_MS`）；一次只做一个规划；取消立即返回，迟到的结果丢弃。任何失败（超时、网络、鉴权、拒答、格式不对）都由 `producePlan` 改用离线规则，`fallbackReason` 是一句话加「，已改用离线规则」，显示在对话里。**例外**：生成引擎是付费的云端服务时不会拿规则的方案直接去花钱，而是弹出「大模型没有给出编曲方案」让用户选取消 / 重试大模型 / 用离线规则继续。

**Ollama 备注**：保存本机模型的设置后，主进程在后台发一次只要 1 个 token 的请求（带同样的系统提示词，让 Ollama 把模型载入内存并缓存这段前缀）；真实请求、新的保存、删除设置或退出都会中止它；托管服务从不预热。Ollama 默认 5 分钟后卸载模型，所以隔久了第一条消息仍然会遇到冷启动——240 秒的时限就是为此留的。最后一轮在这台机器上（`qwen3.5:9b-q4_K_M`）冷启动后的第一条消息用了 121.8 秒，修改用了 37.6 秒。提示词较长，Ollama 需要 8k 以上的上下文窗口，而 OpenAI 兼容接口设不了它。9B 模型的音乐判断偏弱（见 S11）。

## S08｜桌面边界：桥、IPC、守卫、CSP、凭据、环境变量

**桥** `window.museDesktop`（`electron/preload.cjs`；与 `src/types.ts` 的 `DesktopAPI`、`main.cjs` 注册的通道三方一致，`tests/preload.test.cjs` 检查）。13 个方法、13 个通道：

| 方法 | 通道 | 说明 |
| --- | --- | --- |
| `getSettings()` | `muse:get-settings` | `{ providers, llm, dataPath, version }`；只有状态，没有密钥。坏的条目按服务标为 `damaged`，不会让整个调用失败 |
| `saveProviderCredentials(provider, credentials)` | `muse:save-provider` | 保存一家音乐服务的凭据（不发任何请求） |
| `deleteProviderCredentials(provider)` | `muse:delete-provider` | 删除一家，不影响其他 |
| `generateMusic({ provider, prompt, duration, model? })` | `muse:generate-music` | 返回 `{ audio: ArrayBuffer, mimeType }`；一次一个；凭据在拿到锁之后才读 |
| `cancelGeneration()` | `muse:cancel-generation` | 停止等待（也用于停止重新下载） |
| `retryLastDownload(provider)` | `muse:retry-download` | 重新取回上一次已生成但没下载下来的结果；不提交、不计费 |
| `setUnsavedWork(boolean)` | `muse:set-unsaved-work` | 渲染层手里有只存在于本次运行的付费成果 → 关闭前询问 |
| `saveAudio({ name, data, format })` | `muse:save-audio` | 系统保存对话框；`format` 为 `wav` / `mp3` / `m4a` / `flac` / `json`；数据上限 256 MB；文件名经过清理 |
| `openExternal(url)` | `muse:open-external` | 只打开 `EXTERNAL_URLS` 白名单里逐字匹配的官方页面 |
| `saveLlmSettings(settings)` | `muse:save-llm` | 保存大模型连接信息（每次保存都要重新填密钥，Ollama 除外）；是本机模型时触发后台预热 |
| `deleteLlmSettings()` | `muse:delete-llm` | 删除并停止预热 |
| `agentPlan(input)` | `muse:agent-plan` | 让大模型出方案；请求里不带地址和密钥，两者都来自加密存储 |
| `cancelAgent()` | `muse:cancel-agent` | 停止规划和预热 |

**守卫**（`ipc-guard.cjs`）：每个处理器都包在 `trustedHandler` 里——发送者必须是主窗口的主框架，页面地址必须是应用自己的 `dist/index.html`（解析成文件路径再比较，Windows 下不分大小写，忽略 hash 和 query）或者开发地址；否则「此页面没有桌面操作权限。」。只有 `MusicError` 的消息原样返回，其余一律变成「操作失败，请重试。」。

**窗口**：`contextIsolation`、`sandbox`、无 Node 集成、`webSecurity`；禁止新窗口和 webview，站外导航被拦；默认会话和计费会话的权限请求一律拒绝；没有应用菜单，右键菜单只在文本框和选中文本上出现，没有刷新和开发者工具入口；单实例。

**CSP**（`electron/csp.cjs`，与 `vite.config.ts` 逐字相同）：

```text
default-src 'self'; script-src 'self'; worker-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'none';
object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'
```

生效的是构建时写进 `index.html` 的 `<meta>`；主进程另外给 `file:///*` 的响应加同一条头（多一层保险，对 `file://` 很可能不起作用）。

**凭据文件** `%APPDATA%\Muse BGM\music-credentials.json`（`key-store.cjs`）：

```jsonc
// V2（当前）
{ "version": 2,
  "providers": { "<tencent|volcengine|aliyun|elevenlabs>": { "encryptedCredentials": "<base64>" } },
  "llm": { "encryptedSettings": "<base64>" } }      // 可选；解密后是 { kind, preset, apiKey, model, baseUrl }
// V1（0.1 / 0.2 的 ElevenLabs 密钥，只读兼容）
{ "version": 1, "encryptedApiKey": "<base64>" }
```

- 每一项用 Windows safeStorage（DPAPI）单独加密；系统加密不可用时拒绝保存。密钥只写不读：`getSettings` 只返回 `configured`、`damaged` 和非秘密的 `model` / `workspaceId` / `billingMode`（大模型：`kind` / `preset` / `model` / `baseUrl`）。
- 读取宽松、写入严格：每一项单独打开，一项坏了不影响其他；本版本不认识的服务 id 和顶层键在每次保存时原样保留。`llm` 放在 `providers` 之外，是因为 0.2 遇到不认识的服务 id 会拒绝整个文件。
- V1 文件在第一次保存时升级。旧密钥解不开（换了 Windows 账户、恢复的配置）时保存照常进行：旧文件先逐字节复制为 `music-credentials.v1-<内容哈希前 12 位>.bak`，新文件里不带那把密钥。复制不成就什么都不写。
- 整个文件读不了（损坏、更高版本）时 `getSettings` 不失败，但保存和删除被拒绝，文件不会被覆盖；没有自动重置。
- 写入是「临时文件 + 改名」，并且串行。密钥的统一格式：10–4096 个不含空格的可打印 ASCII。文件读取上限 1 MiB。

**网络**（`net-fetch.cjs`）：

- `createNetFetch(net)`：主进程的普通请求走 Chromium 网络栈，遵守 Windows 系统代理 / PAC；不带 Cookie、不写缓存；被取消或超限的响应体会真正中止下载；`redirect` 缺省是 `error`，需要跟随重定向的调用方自己逐跳处理。
- `createBillingFetch(getSession)`：只接受 `POST` 且 `redirect: "error"`；每次请求前对专用内存会话（分区 `muse-billing`）`closeAllConnections()`，并等上一个提交放开连接；连接关不掉就什么都不发。`main.cjs` 全局加 `disable-quic`。`scripts/desktop-smoke.cjs` 每次运行都重复这个实验：在计费通道上，被重置或关闭的提交只到达服务一次并报告为未确认；同样的断连在普通通道上到达两次。

**关闭确认**（`close-guard.cjs`）：云端生成进行中（「云端音乐还在生成」：继续等待 / 仍然关闭），或渲染层报告有未保存的付费成果（「有一首付费生成的音乐还没有保存」：返回应用 / 仍然关闭）时，关闭窗口和退出应用都先询问；默认和 Esc 都是留下。页面重新加载时标志清零。

**外链白名单**（`music-service.cjs` 的 `EXTERNAL_URLS`）：四家音乐服务的文档和控制台页面、各大模型预设的密钥页面、Ollama 的下载和模型库页面；逐字匹配。

**环境变量**：

| 变量 | 作用 | 安全性 |
| --- | --- | --- |
| `MUSE_NETWORK=node` | 主进程改用 Node 自带的 `fetch`（普通请求和计费请求都是）。排障用，也是端到端套件替换 `globalThis.fetch` 的接缝 | 打包后的程序同样认它。没有系统代理支持，**也没有计费连接隔离**（S11）；只用于排障和测试 |
| `MUSE_DEV_URL` | 开发时让窗口加载这个地址 | 只在未打包时有效，而且只能是本机的 `http://localhost` / `127.0.0.1` / `[::1]`、不带账号；打包后忽略 |
| `MUSE_PORTABLE_DATA=1` | 便携版把数据放在 EXE 旁边的 `Muse-Data` | 需要同时存在 `PORTABLE_EXECUTABLE_DIR`（便携包装器设置）；默认不启用，数据在 `%APPDATA%\Muse BGM` |
| `MUSE_SMOKE_EXECUTABLE` | `desktop-smoke.cjs` 改测指定的可执行文件（如 `release/win-unpacked/Muse BGM.exe`） | 只影响测试脚本 |
| `MUSE_SCREENSHOT_PATH` | `desktop-smoke.cjs` 把初始界面截图存到这里 | 只影响测试脚本 |
| `MUSE_WEB_DIST`、`MUSE_DESKTOP_DIST` | `web-smoke.cjs` 改测别处的构建 | 只影响测试脚本 |
| `MUSE_LAUNCHER_DRY_RUN=1` | `启动音序.cmd` 只打印会启动哪个文件 | 只影响启动脚本 |

Anthropic 相关的环境变量被有意屏蔽（S07）。

## S09｜测试

**最后一轮的结果**（当前代码，2026-10-09；Windows 11、Node 24.18.0、Electron 41.10.7、20 核）：

| 命令 | 结果 |
| --- | --- |
| `npm run test:all` | 退出码 0，216 秒（构建两次 + 以下前六项） |
| `npm test` | TypeScript 748 / 748，0 跳过，约 53 秒；CommonJS 219 / 219，0 跳过，约 1.4 秒 |
| `npm run test:web` | 27 步通过，72.5 秒 |
| `npm run desktop:smoke` | 通过，约 24 秒 |
| `npm run test:ui`（= `test:desktop`） | 14 步通过，约 17.5 秒 |
| `npm run test:cloud` | 21 步通过，约 32 秒，0 个真实外部请求 |
| `npm run test:packaged`（在 `npm run dist` 之后） | 23 步通过，26.3 秒 |
| `npm run typecheck` | 227 个文件，0 个错误 |
| `npm run format:check` | 全部符合 Prettier |
| `node scripts/cloud-workflow.cjs --ollama` | 25 步通过，192.9 秒（真实的本机 Ollama） |

打包阶段在最后一次修改测试辅助文件之后又单独重跑了 `npm test`、`test:ui`、`test:cloud`、`desktop:smoke`、类型检查和排版检查（都通过），但没有重跑 `test:web`（它不加载那个辅助文件）和整套 `test:all`。详细记录在 `docs/QA.md`；各套件的结果 JSON 在 `test-results/`。

### 单元测试：`tests/*.test.ts`（34 个文件，748 项）

下表的数量是在当前代码上逐个文件单独运行得到的，合计与最后一轮的总数一致。

| 文件 | 项 | 覆盖 |
| --- | --- | --- |
| `agent-rules` | 39 | 离线规则：大表格的新作品与修改提示词、数字与维度的绑定、否定、固定项、听不懂时的回答、14 种乐器的叫法、每张灵感卡片应得的风格、两个性质测试 |
| `agent-brain` | 45 | 大模型方案的校验与夹回、越界和原型污染、回退及其提示语的形状（扫描主进程的全部错误消息）、固定项、推子和小漂移的保护、云端提示词、预设与主进程一致 |
| `app-core` | 42 | 内核端到端（引擎、桥、存储、播放器、时钟全用替身）：任务锁、取消、草稿与作品分离、v0.2 审计 APP-01…20 的回归 |
| `app-safety` | 32 | 计费与数据安全：付费确认、大模型失败后的询问、保存失败后的保留与重试、「重新下载」、关闭风险、多标签页、撤销删除、旋律承诺（CORE、RB、UX-01/03/10、MAIN-02） |
| `app-logic` | 28 | 内核的纯决策：草稿、固定项、方案、对话、版本、可选项、快捷键 |
| `app-reducer` | 19 | reducer：什么可以改什么 |
| `app-services` | 14 | `services/generation.ts` 与 `exporter.ts`（替身引擎、桥、解码器）：导出选项、重复、淡入淡出、格式识别 |
| `ui-logic` | 52 | 界面背后的纯逻辑：文案统一（UX-11）、时间轴与和弦标注、焦点、提示框、建议按钮、应用自带的每条示例都兑现它的承诺 |
| `storage` | 29 | 严格校验、导入导出、引擎缺省、更新版本与非工程数据的说明 |
| `storage-idb` | 17 | 真实的 IndexedDB 语义（fake-indexeddb）：逐条读取、按字段更新、损坏记录、各种失败的中文说明 |
| `platform` | 16 | 桌面 / 网页 / iframe 的识别、文件名清理、保存与外链 |
| `player-clock` | 20 | 播放器的走带算术 |
| `player-engine` | 31 | `PlayerEngine` 对着脚本化的 Web Audio：创建、调度、停止、上报 |
| `catalog` | 2 | 清单 JSON 与 `catalog.ts` 的字面量一致 |
| `music-core` | 33 | 作曲器：每个风格定义格式正确、有效性、确定性、长度规划、和声、旋律统计、编排提示 |
| `music-styles` | 36 | 22 个风格各自的身份（乐器、鼓组、律动、音阶、和声），以及风格 × 主奏 × 曲式的通用有效性 |
| `music-continuity` | 13 | 修改后旋律保留多少；`melodyContinuity()` 的每个答案对照实际的 Score |
| `music-review` | 11 | 作曲评审的回归（MUS-02…11）：贝斯单声部、没有空段落、没有对斜关系、结尾守调式、五声副旋律、rubato、渐强到位、和弦拼写、副属解决、编曲说明如实 |
| `dsp` | 16 | DSP 工具箱：滤波器响应、包络、延迟线、弦、模态、FFT；以及 Node 24.18 的 V8 问题检查 |
| `voices-core` | 15 | 音色库完整、示范音色的契约、测量工具本身 |
| `voices-keys` | 31 | 键盘与拨弦 13 个音色的契约和各自的可测特征 |
| `voices-sustained` | 37 | 长音与贝斯 16 个音色的契约和特征 |
| `drums` | 18 | 23 种 × 8 套：电平、力度律、时长、频谱特征、截断、确定性 |
| `fx` | 21 | 高低切、驱动、合唱、延迟、混响（RT60、单位电平）、闪避、循环预热 |
| `render` | 23 | Score 渲染器、母带、响度计：循环回绕、响度校准、分轨之和、限制器、淡出 |
| `render-memory` | 3 | 一次渲染占用和留下多少内存（ENG-3；独占一个进程） |
| `wav` | 6 | WAV 编码与抖动 |
| `engine` | 18 | 门面：调用线程路径、脚本化的 Worker 失败模式、真实 `worker_threads` 线程上的协议 / 传输 / 中止、引擎 1 与 0.2 的哈希一致 |
| `export-worker` | 6 | Worker 里的导出与调用线程逐字节相同（10 个黄金哈希），以及各种回退 |
| `audio-quality` | 23 | 质量门槛（S06）：22 种风格各一项 + 爆音检测器自检 |
| `style-mix-pop-acoustic` | 9 | 流行 / 原声组八个风格的平衡窗口 |
| `style-mix-groove-electronic` | 12 | 律动 / 电子组八个风格 |
| `style-mix-cinematic-atmos` | 25 | 电影 / 氛围组六个风格 |
| `examples` | 6 | `examples/` 里的文件：0.2 工程仍能作为引擎 1 作品打开；引擎 2 示例正是应用导出的样子，WAV 正是引擎渲染的结果 |

### 单元测试：`tests/*.test.cjs`（20 个文件，219 项，主进程）

| 文件 | 项 | 覆盖 |
| --- | --- | --- |
| `desktop` | 10 | `music-service`：ElevenLabs 的一次请求、参数校验、错误不泄漏、任务锁与取消、超时、非音频与超大响应、导出文件名、外链白名单、基础的密钥存取 |
| `shared-providers` | 14 | 阿里云契约、共享下载与重定向、格式识别、有界读取、取消；四家路由与跨服务的任务锁；凭据默认值、四家加密保存互不影响、V1 迁移 |
| `provider-tencent` | 9 | 腾讯云的请求体、服务码、十六进制校验 |
| `provider-volcengine` | 10 | 火山的请求体、V4 签名（固定时间和虚构凭证的期望值）、轮询、CDN 白名单 |
| `provider-volcengine-retry` | 10 | F02 / F04：容错的轮询、提交后每个失败都带任务编号、错误码与请求编号 |
| `music-robustness` | 8 | F14（先上锁再读凭据）、F04（错误码）、F15（阿里云只从 OSS 桶下载）、大模型密钥页在白名单里 |
| `music-paid-result` | 15 | MAIN-01（计费请求只走 `submitFetch`，轮询和下载从不走）、MAIN-02（下载重试、说明音乐已生成并带编号、可重新下载而不重新提交） |
| `net-fetch` | 18 | 网络封装对着假的 `net`：无 Cookie 无缓存、请求头、重定向模式、中止；计费通道的关闭连接、排队、只收 POST；`main.cjs` 的接线 |
| `key-store` | 14 | F03（逐项隔离）、F07（未知键保留）、大模型设置的加密与隔离、MAIN-06（解不开的 V1 密钥备份后放行）、F16（统一的密钥长度） |
| `ipc-guard` | 6 | F01（按文件路径比较，盘符大小写无关）、开发地址、只有安全的错误过桥 |
| `preload` | 6 | F06（去掉 IPC 错误前缀）；桥、通道、`DesktopAPI` 三方一致 |
| `csp` | 3 | F18：两处 CSP 逐字相同 |
| `close-guard` | 7 | MAIN-05 / RB-03：关闭确认的决策逻辑 |
| `context-menu` | 4 | MAIN-07：右键菜单模板 |
| `base-url` | 8 | 接口地址校验表、私有地址分类、调用前的 DNS 复查、MAIN-08（受限端口） |
| `plan-schema` | 15 | Schema 的形状（与 `RawAgentPlan` 一致）、`validatePlan` / `completePlan` / `validatePlanInput`、罗马数字语法和默认推子与渲染层一致、系统提示词、`buildMessages` |
| `agent-service` | 21 | 规划的锁、取消、迟到结果、90 秒 / 240 秒时限、错误净化、八项预热测试 |
| `agent-anthropic` | 19 | Claude 适配器对着模拟的 `fetch`（真实 SDK 0.132.1）：请求体、请求头屏蔽环境变量、beta 回落、错误映射、拒答与截断 |
| `agent-openai` | 21 | OpenAI 兼容适配器：请求体、Ollama 的形状、参数降级、重试、去掉思考块、有界读取、连不上本机模型时的三种说明、预热请求 |
| `llm-presets` | 1 | 渲染层的预设清单通过主进程的保存校验 |

### 端到端套件：`scripts/`

| 套件 | 驱动什么 | 最近一次结果 | 结果文件 |
| --- | --- | --- | --- |
| `web-smoke.cjs`（`npm run test:web`） | Chromium 里的 `dist-web/`，放在 `/play/yinxu/` 下、嵌在 1000×760 的 iframe 里：创作、播放、键盘、对话修改、声音微调、长渲染不卡界面并可取消、混音、导出、渲染错误的恢复面板、刷新恢复、导入、作品库、删除与撤销、损坏记录、灵感、两个标签页、保存失败的横幅与重试、1366×768 窗口、390×780 触屏；另用替身桥在浏览器里跑桌面渲染层的付费流程。任何控制台错误、CSP 违规或静态文件以外的请求都算失败 | 27 步，72.5 秒 | `test-results/web-smoke.json` |
| `desktop-smoke.cjs`（`npm run desktop:smoke`） | 真实 Electron + 临时数据目录：隔离的 preload、13 个桥方法、设置的形状、中文错误不带前缀、音乐与大模型凭据的真实 safeStorage 增删、经 Chromium 网络栈向本机模拟模型规划、连不上本机模型的三种说明、受限端口、损坏条目互不影响、小写盘符启动；**计费请求不重发的实验**（把 ElevenLabs 和腾讯云的域名映射到本机的替身服务，HTTP/1.1 + TLS 与 HTTP/2，重置与关闭各一次）；右键菜单；三种关闭确认 | 通过，约 24 秒；对打包后的 `Muse BGM.exe` 也通过 | 无（只有终端输出） |
| `ui-smoke.cjs`（`npm run test:ui` / `test:desktop`） | 真实 Electron 的本地全流程：固定风格与时长生成 → 播放与键盘 → 对话修改（同一种子）与「没有变化就不生成」→ 声音微调 → 混音保存、独奏不保存 → 经系统保存路径导出混音 / ×2 / 单轨 / 工程 → 作品库 → `Ctrl+N`、取消 120 秒的渲染 → 删除与撤销、重启恢复 → 音乐服务与大模型设置 → 0.2 工程在旧引擎上打开并升级成引擎 2 的新版本 | 14 步，约 17.5 秒；0 个渲染层错误，0 个外发请求 | `test-results/ui-smoke-results.json` |
| `cloud-workflow.cjs`（`npm run test:cloud`） | 真实的界面、preload、IPC、适配器、解码、存储和导出，只把主进程的网络换成本机模拟（`MUSE_NETWORK=node` + 替换 `globalThis.fetch`）：没有凭据时拒绝；**腾讯 / 火山 / 阿里**三家的凭据保存和各一次完整生成（先保存再解码、显示真实时长、原始文件逐字节不变）；付费确认；HTTP 401；等待中取消；阿里云「已生成但下载一直失败 → 重新下载」；不支持的时长；无法解码的音频；云端作品的修改；Claude（模拟）规划与修改；模型失败回退；规划中取消；OpenAI 兼容接口（模拟 DeepSeek）；模型 + 云端引擎 | 21 步，约 32 秒；未知请求 0、Chromium 外发请求 0 | `test-results/cloud-workflow-results.json` |
| `cloud-workflow.cjs --ollama` / `--ollama-cold` | 上面的 21 步，再加真实的本机 Ollama：经设置表单配置、一次新作品、一次修改、核对只访问了本机。`--ollama-cold` 先让 Ollama 卸载模型 | 25 步，192.9 秒（`qwen3.5:9b-q4_K_M`）；结果只留在 `.scratch/package/` | 可选阶段，不在 `test:all` 里 |
| `packaged-smoke.cjs`（`npm run test:packaged`） | 发行物：先核对 `app.asar`（`dist/`、`electron/`、`package.json` 与工作区一致；依赖里没有多余文件；SDK 的脚本一个不少；`SHA256SUMS.txt` 和发布说明里的校验值就是这两个 EXE 的），再对 `release/win-unpacked/Muse BGM.exe` 和便携版 EXE 各跑 11 步：版本、桥、CSP 生效、Worker 里作曲并播放、对话修改、导出 WAV、真实 safeStorage 存删凭据、包内 Claude SDK 完成一次模拟规划、整个进程重启后作品还在、没有请求离开本机 | 23 步，26.3 秒 | `test-results/packaged-smoke-results.json` |

**什么是模拟的**：

- 四家音乐服务的全部网络往来（固定的 3 秒音频夹具，而请求的是 15 / 30 秒——所以「显示真实时长」是真的被检查了）。
- Claude 和其他托管模型的全部往来（固定的方案夹具；Claude 适配器的单元测试用真实 SDK 加模拟 `fetch`）。
- Electron 套件里的系统保存对话框、关闭确认框、右键菜单和 `shell.openExternal` 被主进程钩子换成记录器。
- 内核测试里的引擎、桥、存储、播放器和时钟；`player-engine` 里的 Web Audio。

**什么是真的**：真实的 Electron 进程和打包后的程序、Windows safeStorage、IndexedDB（套件里是真实浏览器的，单元测试里是 fake-indexeddb）、本地引擎的全部渲染和测量、Worker、计费通道实验里的 TLS / HTTP/2 连接（对本机的替身服务）、可选阶段里的本机 Ollama。

**没有覆盖的**：

- 任何真实付费音乐账号；任何真实的 Anthropic 或其他托管大模型密钥。
- ElevenLabs 没有界面层的端到端生成（只有单元测试和计费通道实验）。
- NSIS 安装包本身（安装、快捷方式、卸载）。
- Chromium 以外的浏览器、真实手机和触屏硬件、屏幕阅读器、输入法组字、强制颜色模式。
- 真实的 Windows 系统代理、Windows 10、macOS / Linux。
- 听感。套件里的「没有爆音」来自增益自动化记录和输出探针，不是耳朵。
- `test:all` 不含 `test:packaged` 和 Ollama 阶段。

**写测试时注意**：

- Electron 套件读 `dist/`（网页套件读 `dist-web/`），先构建。它们使用临时数据目录，并统计、拒绝一切真实外部请求。
- `npm test` 带 `--no-maglev-escape-analysis`：Node 24.18 的 V8 在高负载下会让同一个对象字面量产生的两个对象共用数字字段（`tests/helpers/spectrum.ts` 有说明，`tests/fixtures/literal-aliasing.check.ts` 是复现）。带采样循环的测试辅助函数应当返回数字，而不是新的对象字面量。
- 少数测试检查源文件的接线（哪个通道接哪个处理器）。它们通过 `tests/helpers/source-shape.cjs` 去掉排版再比较，重新排版不会让它们失败，改了代码的意思才会。
- 音频测试较重：`audio-quality`、`music-review`、`style-mix-*`、`engine` 单独运行各要 40–55 秒，并行后整套约 1 分钟。
- 便携版只能靠手工打开的两个调试端口来驱动；`tests/helpers/electron-harness.cjs` 会先等主模块就绪再注入钩子。

## S10｜环境、命令、打包、发布、网页版

**环境**：Windows 11 x64；Node.js 22.12 或更新（Vite 7 和 Electron 41 的要求；实际使用 24.18.0，npm 11.16）。锁定的主要版本：Electron 41.10.7、electron-builder 26.15.3、Vite 7.3.7、TypeScript 5.9.3、React 19.3、tsx 4.23.15、Playwright 1.64、Prettier 3.9.9、`@anthropic-ai/sdk` 0.132.1（唯一的运行时依赖）、fake-indexeddb 6.2.5。`npm ci` 之后即可运行；网页套件需要 Playwright 的 Chromium。

**全部 npm 脚本**：

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | Vite 开发服务器（`127.0.0.1:5173`），浏览器里的本地作曲 |
| `npm run build` | `tsc -b && vite build` → `dist/` |
| `npm run build:web` | `tsc -b && vite build --mode web` → `dist-web/` |
| `npm run preview` | 预览 `dist/` |
| `npm run desktop` | 构建并用 Electron 打开 |
| `npm run typecheck` | `scripts/typecheck.mjs`：`src/`、`tests/`、`scripts/` 的 TypeScript；可带路径只看一部分 |
| `npm run format` / `format:check` | Prettier 写入 / 只检查 |
| `npm test` | 全部单元测试（先 TypeScript，再 CommonJS） |
| `npm run test:fast` | 不合成音频的部分（制作人、内核、清单、平台、播放器、存储、界面逻辑、WAV，加全部主进程测试），几秒 |
| `npm run test:web` | 网页版端到端 |
| `npm run desktop:smoke` | 桌面冒烟 |
| `npm run test:ui`、`npm run test:desktop` | 同一个脚本：界面全流程 |
| `npm run test:cloud` | 云端与大模型流程（模拟网络） |
| `npm run test:all` | `build` + `build:web` + `test` + `test:web` + `desktop:smoke` + `test:desktop` + `test:cloud` |
| `npm run dist` | `npm run build` 后 `electron-builder --win --x64 --publish never` |
| `npm run test:packaged` | 发行物冒烟（要先 `dist`） |
| `npm run audit:audio` | 客观音频测量（S06） |
| `npm run demos` | 渲染 22 段示例到 `demos/` |

**打包**（`package.json` 的 `build`）：`appId` `studio.muse.bgm`，`productName` `Muse BGM`，输出到 `release/`，`asar: true`，两个目标：

- `Muse-BGM-Setup-<版本>-x64.exe`——NSIS，`oneClick`（没有向导页）、只为当前用户、不需要管理员权限、创建桌面快捷方式「音序 Muse」、卸载时保留数据、不生成差分包。
- `Muse-BGM-Portable-<版本>-x64.exe`——单文件，每次启动先自解压到临时目录。
- 两者都没有代码签名，首次运行会有 SmartScreen 提示。

当前的发行物（2026-10-09 09:42 从当前代码打出，`npm run dist` 退出码 0，102 秒）：

| 文件 | 字节 | SHA-256 |
| --- | --- | --- |
| `release/Muse-BGM-Setup-0.3.0-x64.exe` | 81,941,632 | `cdd4d116f19031f26cb9b98546e72bf38d42852294804a73c5dd9c66c22a691b` |
| `release/Muse-BGM-Portable-0.3.0-x64.exe` | 81,776,241 | `6d350c8d52ba79f49f9b12c16b9b1eea52c9666037359cadea723065a6e848f5` |

`release/` 里还有 `win-unpacked/`（318,242,140 字节，安装包装到磁盘上的就是它）、`SHA256SUMS.txt`、`RELEASE-NOTES-0.3.0.md`、`builder-debug.yml`，以及**不要运行、也不要随 0.3.0 上传的** `Muse-BGM-0.1.0-Windows.exe` 和 `Muse-BGM-0.2.0-Windows.exe`（及各自的 `.sha256`）。

**包里有什么**：`build.files` 只收 `dist/`、`electron/`、`package.json` 和生产依赖（Claude SDK 及其依赖），并排除依赖里从不运行的文件——源码映射、TypeScript 源码与声明、README、SDK `src/` 下的 `tsconfig.json` 和 `.keep`。`app.asar` 因此是 4,722,660 字节、1156 个条目（1051 个文件）；不过滤时是 13,320,817 字节、3005 个条目。SDK 的 `.js` / `.mjs` 全部保留；`src/internal/qs/LICENSE.md`（随包分发的 qs 代码的许可证）有意保留。

**重新打包**：

```powershell
npm run test:all        # 可选但建议
npm run dist            # 约 2 分钟
# 两个 EXE 的哈希会变：手工重写 release/SHA256SUMS.txt、release/RELEASE-NOTES-<版本>.md
# 末尾的代码块和它后面的注释、docs/QA.md 与本节的表格
npm run test:packaged   # 校验值没改对会在第一步失败
```

`SHA256SUMS.txt` 每行 `<小写 sha256><两个空格><文件名>`，LF 换行（`sha256sum -c` 可用）。没有脚本生成这些文件。改版本号只改 `package.json`；界面和主进程都从它读取。

**发布到 GitHub（给仓库主人的步骤；目前什么都没有发布）**：

1. 仓库现在只有本地提交、没有远端。先决定工作区里没提交的改动怎么提交，然后在 GitHub 建仓库（门户那边的占位名是 `chenyihang98-pixel/yinxu`，可以改，改了要同步告诉门户的 `content/tools.json`）并推送。`release/`、`demos/`、`.scratch/` 都被忽略，不会进仓库。
2. 打标签并创建**非草稿**的 release，标签等于版本号（`v0.3.0`，门户要求它与网页版的版本一致）。上传三个文件：两个 0.3.0 的 EXE 和 `SHA256SUMS.txt`。文件名必须保持 `Muse-BGM-Setup-0.3.0-x64.exe` / `Muse-BGM-Portable-0.3.0-x64.exe`——门户靠 `setup` / `portable` 识别安装版和便携版。
3. release 的正文用 `release/RELEASE-NOTES-0.3.0.md` 的**全文**，包括末尾 `### SHA-256` 小节的代码块**和它后面那段 HTML 注释**。例如：

   ```powershell
   gh release create v0.3.0 `
     release/Muse-BGM-Setup-0.3.0-x64.exe release/Muse-BGM-Portable-0.3.0-x64.exe release/SHA256SUMS.txt `
     --title "音序 Muse 0.3.0" --notes-file release/RELEASE-NOTES-0.3.0.md
   ```

4. **为什么有那段注释**：门户的 `scripts/sync-releases.mjs` 用一条不分行的正则读正文，「哈希在前、文件名在后」的代码块会被它错配（安装版拿到便携版的哈希，便携版没有哈希）。注释里按「文件名在前、哈希在后」重复了两行，正则才配对正确。这是对着门户仓库的草稿副本验证的，不是线上仓库。更简单的替代：把可见的代码块直接改成「文件名  哈希」并删掉注释，或者把门户的正则改成按行匹配——需要主人决定。改校验值时两处一起改。
5. 发布后按下面「门户」一节同步下载信息。

**网页版**：`npm run build:web` → `dist-web/`（`index.html` + `assets/` 里带内容哈希的一个主包、一个 CSS、一个 Worker 包）。纯静态、相对路径，可以原样部署到任何静态目录；不发任何网络请求（`web-smoke` 的最后一步核对了只请求静态文件）。作品存在浏览器的 IndexedDB 里，与 Windows 版不共享。云端引擎和大模型在界面上显示为「桌面版可用」，链接到 `https://starwright.xyz/tools/yinxu/#download`（`src/platform.ts` 的 `DOWNLOAD_URL`，`target="_top"`）。

**门户嵌入（starwright.xyz；还没有上线）**：

- 目标：工具页 `https://starwright.xyz/tools/yinxu/`，其中的 iframe 加载 `https://starwright.xyz/play/yinxu/`。桌面上框宽最多 1098 px、高 560–860 px，手机上是 390 / 320 px 通栏。界面按 320 px 起不出现横向滚动来设计（≥ 1100 px 是侧栏加双列；以下是顶栏加单列；720 px 以下风格改为一行横向滚动、弹窗变成全屏；520 px 以下导航只剩图标）；第二轮的截图审计覆盖到 320 px，最后一轮的 `web-smoke` 核对的是 390×780 的触屏和 1000×760 的框架。
- 门户是另一个私有仓库（`chenyihang98-pixel/ai-creation-platform`）。它的克隆在 `.scratch/site/ai-creation-platform`，分支 `add-yinxu`，**全部改动都没有提交、暂存或推送**；`.scratch/site-kit/site.patch` 可以在 `4aaa7cd` 上重现这些改动，`.scratch/site-kit/NOTES.md` 是完整的工作笔记（改了哪些文件、做过的决定、剩下的步骤、没验证的事项）。这些都在被忽略的草稿区里，需要的话先另存。
- 剩下的步骤（详见 NOTES §3）：
  1. `npm run build:web`，然后在门户仓库里 `npm run import:yinxu`（把 `dist-web/` 灌进 `public/play/yinxu/`，现在那里是空的——所以页面目前还不能部署）、`npm run build`、`npm run preview`，再跑 `verify-embed.cjs` 和 `verify-behaviour.cjs`。
  2. 截四张 1280×800 的图（封面、创作、我的作品、设置）放进 `.scratch/site-kit/captures/`（这个文件夹还不存在，图也还没有截），`npm run import:assets -- yinxu`。
  3. GitHub release 存在之后，在 `content/tools.json` 的 `yinxu` 项里补上 `github` 和 `releasesUrl`，换掉「Windows 版待发布」的标记，`npm run sync:releases`。
  4. 填 `tests.unit` / `tests.workflow` 等待定的数字，核对页面上引用的按钮文字和「已验证」的每一句（NOTES §3.4）。
- NOTES 是在 0.3 的网页版还不存在时写的：v0.3 的网页版在门户页面的真实框架里还**没有验证过**（`web-smoke` 用的是自己的替身父页面）；门户的发布同步脚本没有对着 GitHub 跑过；Cloudflare Pages 的构建没有跑过。

## S11｜已知限制、风险与下一步

**第一组：只有仓库主人能做的验证（先做）**

1. **听一遍 `demos/`**（22 段，`npm run demos` 可重新生成）。没有任何人听过引擎的输出。各份报告点名要先用耳朵核对的：鼓总线压缩和降低的限制器上限会不会「抽吸」；钢琴的击弦声；变暗后的古筝、竹笛、弦乐；鼓的截断；各声部的饱和量；马林巴、颤音琴、电钢琴做主奏时 1–4 kHz 偏弱（电平对了，但可能显得软）；混响和延迟的回送量（都是没听过就定下的常数）。
2. **一次最便宜的真实云端生成**：建议腾讯云 TokenHub，选最短的时长；看鉴权、音质、实际时长、「我的作品」里的保存和导出，再到服务商控制台核对只有一次调用。四家的鉴权、配额、音质和账单都只在模拟服务上验证过；服务商错误响应的形状来自文档而不是真实账号。
3. **一次真实的托管大模型规划**（Claude 或任一 OpenAI 兼容服务）：结构化输出的 Schema 只在 Ollama 的 `json_schema` 路径上真实跑过；Claude 的 beta 回落、各预设的地址和密钥页链接都没有对着真实服务验证。
4. **运行一次安装包**：安装、快捷方式「音序 Muse」、卸载后数据保留、安装路径都没有测过。

**第二组：与钱和数据有关的风险**

5. **旧程序会损坏 0.3 的作品库**（LEFT-01）：0.2 的 EXE 保存任何东西都会把记录改写成它自己的格式（引擎 1，丢掉编排、版本关系和对话），遇到新风格时它的整个列表打不开。目前只靠文档和启动脚本避免。更彻底的办法是把数据库升到版本 2，让旧程序打不开（要同时改 `tests/storage-idb.test.ts`），并把旧 EXE 移出 `release/`。
6. **`MUSE_NETWORK=node` 下没有计费连接隔离**：Node 的 `fetch` 不走专用会话，也没有在复用连接上验证过它不重发。只用于排障和测试。
7. **「重新下载」只在本次运行内有效**：结果地址只在主进程内存里，下一次云端请求开始或重启后就没有了（关闭前会询问）。它只挂在那条常驻提示上，关掉提示就等于放弃。还有一个界面上到不了的边角：新的云端请求在主进程拿到锁之前被拒绝时，渲染层已经撤回了提示，而主进程其实还留着结果。
8. **阿里云的下载域名规则依据的是文档**：如果 Fun-Music 返回了非 OSS 的地址，付费生成之后下载会被拒绝（消息里带请求编号）。火山 `Text` 的长度上限也没有核实过。
9. **软删除的窗口**：进程在 8 秒撤销窗口内被强杀时，被删的作品可能回来（localStorage 是懒写盘的）。
10. **云端作品的音频和元数据在同一条记录里**（数据库没升版本的代价）：改名、收藏会重写整条记录，包括音频。
11. **凭据文件整个读不了时**没有自动重置：保存和删除都被拒绝，要用户自己处理那个文件。
12. **两个 EXE 都没有签名**；只在一台直连网络的 Windows 11 电脑上测试过，真实的系统代理和 Windows 10 没有验证。

**第三组：产品边界**

13. **本地作曲**：没有人声；只有 4/4；不能只改某一段；副旋律是导音线而不是第二条曲调；循环片段对齐到整小节会移动一些默认值（30 秒的循环实际在 28.6–32.7 秒之间）；rubato 风格（伤感抒情、国风古韵、浪漫温馨）里事件相对和弦条最多偏约 0.1 秒；干的风格的完整结尾末尾有一两秒数字静音。
14. **混音指标没有全部达到评审的目标**：峰值因数整体在 11.7–17.1 dB，舞曲和摇滚没有压到评审想要的 8–11 dB（再压限制器就会明显工作）；个别极端设置（如可爱俏皮 50 BPM 循环）在第二轮测得离目标 0.25 LU。这些都在质量门槛之内。
15. **制作人**：给没有贝斯或和声的编排说加上贝斯或和声，仍然得到「这样改完，听起来会和现在这一版完全一样，所以没有生成新版本。」（只有鼓会真的加）；没有鼓的编排仍然被推荐「加点沙锤」而不是「加上鼓」；光说「降到 90」会反问指的是哪个参数；主进程给大模型的系统提示词里还是弯引号（它的回复入库前会被统一）。
16. **本机小模型**：9B 模型即使方案合法，判断也偏弱——每次都写段落计划且小节数约等于秒数、在新作品里乱动推子、修改时让情绪能量漂移；这些都在渲染层被中和了，结果是它的段落计划几乎从不生效。冷启动要一两分钟，更慢的机器或更大的模型可能超过 240 秒。
17. **云端**：每次都是整首重新生成，没有分轨，不保留旋律；时长和循环只是提示词里的目标（火山除外，它有时长参数）；WAV 导出是解码后重采样的。
18. **性能与内存**：120 秒的重风格在 Electron 里可能超过 8 秒；一次 120 秒的渲染峰值约 300 MB，新旧结果同时存在时更高；每次打开本地作品都要重新渲染（没有分轨缓存）；主包约 933 kB，引擎代码在主包和 Worker 包里各有一份。
19. **界面**：只在 Chromium 里渲染过；没有跑过屏幕阅读器；`field-sizing` 等较新的 CSS 在其他浏览器上会退化；强制颜色和减少动态效果的规则写了但没有在那些设置下渲染过。
20. **没应用的「声音微调」修改不跨重启保存**（当前作品和输入框文字会）；引擎选择器的手动选择也不跨重启。
21. **播放**：从头播放的 2 ms 斜坡是有意保留的；引擎 1 作品的试听没有复现 0.2 在峰值超过 0.96 时的整体缩放，推子推得很高时可能在输出端削波（导出不受影响）。

**第四组：工程杂项**

22. `key-store.cjs` 里的 `saveKey` / `deleteKey` / `getKey` / `hasKey` / `getStatuses` / `getLlmStatus` 现在只有测试在用；`src/audio/fx.ts` 等处还有没人导入的导出类型；`clamp` 等小函数有多份相同的副本。
23. 打包还能再瘦：`json-schema-to-ts`、`@babel/runtime`、`ts-algebra`（437 个文件，约 274 KB，SDK 只为类型用它们）、SDK 的 `.mjs` 那一半（284 个文件，1.2 MB，应用加载的是 CommonJS）和 `bin/` 都随包但从不加载；去掉它们要动声明的依赖，所以没动。
24. 校验值文件、发布说明和文档里的哈希表都是手写的，重新打包后要一起改。
25. 便携版的冒烟依赖两个调试端口和 NSIS 包装器透传命令行开关，也依赖 Electron 默认认 `--inspect` 的 fuse；失败时可能在临时目录留下配置文件夹。
26. `test-results/` 里混有 0.2 时期的截图和结果；系统临时目录里有几个早先留下的 `muse-*` 文件夹。
27. Prettier 不排版词典和风格定义；`npm test` 依赖一个绕开 V8 问题的开关（S09）。
28. 实现简报和界面规格只存在于被忽略的 `.scratch/`（`BRIEF.md`、`UI-SPEC.md`）；它们的要点已经写进本文，原文不保证留存。

## S12｜维护本文

- 行为改变时同时改测试和本文相关小节；`docs/QA.md` 记录最近一次完整回归和打包的结果；用户可见的配置步骤变了就改 `docs/API配置指南.md`。
- S00 必须保持一屏、保持真话：版本、验证边界、仓库和发行物的状态变了先改它。`AGENTS.md` 里 `Get-Content -TotalCount` 的行数要覆盖到 S01 结束。
- 数字只写有出处的：测试数量来自实际运行，哈希来自 `release/` 里的文件，音频指标来自测试输出或测量工具。没测过的事写进 S09「没有覆盖的」和 S11，不要写成已验证。
- 新增风格 / 乐器：按 S06 的步骤，并更新 S03 的数量。
- 新增桥方法：`preload.cjs`、`main.cjs`、`src/types.ts` 三处一起改（`tests/preload.test.cjs` 保证一致），再更新 S08 的表和各 Electron 套件里的方法清单（`BRIDGE_KEYS`）。
- 新增或删除源文件：更新 S04 的文件地图；新增测试文件：更新 S09 的表和数量。
- 界面文案：一个东西一个名字（`tests/ui-logic.test.ts` 的 UX-11 列出了禁用的旧说法），引用用「」。
- 提交前：`npm run format`、`npm run typecheck`、`npm test`；动了界面或主进程再跑 `npm run test:all`；动了作曲器或合成器要重新生成 `examples/`（S06）。文档-only 的改动不需要重新打包。
