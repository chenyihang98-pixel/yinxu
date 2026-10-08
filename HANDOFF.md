# 音序 Muse：制作过程、功能与仓库交接反馈

快照日期：2026-10-08（Asia/Tokyo）。适用版本：`muse-bgm@0.2.0`。工作目录：`D:\makeBGM`。
本文件是接手智能体的主交接文件；事实由当前源码、已完成测试和本次开发记录整理。不是聊天逐字稿，也不是对未来版本的保证。

## S00｜快速接手：先只读这一节

- **用户目标**：简单输入“青春欢快”等场景，生成 BGM，能试听和各种微调，最后交付简洁的 Windows App。用户选择“本地作曲 + 可配置 AI 音乐服务”两种方式都要；最新计划是自己填国内 API 凭据后再测评。
- **已经交付**：可运行 Windows x64 便携 EXE；中文 React 工作台；离线四分轨作曲；腾讯云 TokenHub、火山引擎 AI 音乐、阿里云 Fun-Music、ElevenLabs 四个云端选项。
- **最新文件**：[Muse-BGM-0.2.0-Windows.exe](release/Muse-BGM-0.2.0-Windows.exe)，90,001,478 字节。根目录 [启动音序.cmd](启动音序.cmd) 指向它。旧 0.1.0 仍保留。
- **本地引擎的真实能力**：关键词解析 + 音乐规则 + 确定性随机合成，完全离线，不需要 GPU、模型权重或 API。不是本地音乐大模型，也没有通用 LLM Agent/工具规划框架。
- **云端的真实能力**：提交文字与音乐方向，接收混合音频；没有分轨分离、局部音符编辑或上传音频续写。云端改风格通常要重新生成；本地四分轨可即时混音。
- **最重要的验证边界**：66 项单元/协议测试、27 项扩展工作流、7 组基础 UI、8 组国内云端模拟流程、7 组发行版检查已通过。真实付费 API、账号权限、音质和扣费尚未实测。不要把 mock 通过写成真实账号联调通过。
- **结构**：`src/` 是浏览器渲染层；`electron/` 是桌面主进程与服务适配；`window.museDesktop` 是唯一桌面桥接。没有独立 HTTP 后端、数据库服务器、Python 常驻服务或云部署。
- **状态**：`App.tsx` 的 `config/prompt` 是草稿，`project.config` 才是当前已生成音频的配方。每次重新生成新作品，旧版本保留；即时调轨音量原地更新当前作品。
- **数据**：IndexedDB `muse-bgm` / `projects` 保存作品。默认桌面数据在 `%APPDATA%\Muse BGM`；服务凭据通过 Windows `safeStorage` 加密写入 `music-credentials.json`。不要为了解仓库读取用户真实凭据或清空作品库。
- **服务凭据**：腾讯用 TokenHub Key；火山用 AK/SK 和已开通的计费方式；阿里用北京地域 Key + Workspace ID 且需邀测；普通聊天/TTS Key 不等于音乐服务权限。
- **最低开发动作**：已有依赖时 `npm run build`、`npm test`。完整源码桌面启动 `npm run desktop`；发行包 `npm run dist`。UI 脚本读取已有 `dist`，改前端后先 build。
- **仓库状态**：快照时没有 `.git`，没有可供追溯的提交、分支或 PR。已存在 `.gitignore` 与锁文件；不要假定能用 git diff/回滚恢复用户改动。
- **本次文档任务**：仅补充交接文档和发现入口，不修改应用逻辑，不重新打包 EXE。

## S01｜节省 token 的阅读与改动导航

无需一开始读完整文档或整个 `App.tsx`。先读 S00，再按任务选择一行。使用函数名搜索，比固定行号更耐版本变化。

| 接手任务 | 本文需要读 | 最少源码/证据 |
| --- | --- | --- |
| 向用户介绍或直接运行 | S03、S10 | `README.md`、`package.json` |
| 配置/排查国内 API | S07、S08、S11 | `docs/API配置指南.md` → 对应 `electron/providers/*.cjs` |
| 改界面或生成流程 | S04、S05 | `src/App.tsx` 对应函数、`src/styles.css`、`src/components.tsx` |
| 改音乐规则/合成音色 | S06、S09 | `src/composer.ts`、`src/audio/engine.ts`、`tests/engine.test.ts` |
| 修播放/混音/导出 | S05、S06 | `src/usePlayer.ts`、App 的 `changeMix/exportAudio` |
| 修保存/导入/作品恢复 | S05、S11 | `src/storage.ts`、App 的 `persist/openProject`、`tests/storage.test.ts` |
| 加服务或改鉴权 | S07、S08 | `src/types.ts`、`src/providers.ts`、`ProviderSettings.tsx`、`credentials.cjs`、服务适配器及测试 |
| 验证用户反馈 | S09、S11 | 最新结果 JSON + 相关测试脚本；只重跑受影响范围 |
| 打包发布 | S10 | `package.json`、`启动音序.cmd`、`scripts/packaged-smoke.cjs` |

PowerShell 定向读取示例：

```powershell
Get-Content .\HANDOFF.md -TotalCount 58
rg -n '^## S' HANDOFF.md
rg -n 'const generate|const openProject|const exportAudio' src/App.tsx
rg -n 'createMusicService|generate|cancel' electron/music-service.cjs
rg --files src electron tests scripts docs
```

不要把 `node_modules/`、`dist/`、`release/`、锁文件全文、音频/图片二进制、所有截图一次性塞进上下文。需要依赖版本时用 S10 或只查锁文件相应条目。旧失败截图不是当前失败结论；判断当前状态看 S09 的结果 JSON。

内容目录：S02 制作过程；S03 功能；S04 架构/文件地图；S05 数据和状态；S06 本地音乐；S07 云端协议；S08 桌面安全/凭据；S09 测试；S10 运行/发布；S11 限制/下一步；S12 维护方式。

## S02｜完整制作过程与关键决策

以下按可核实的开发阶段整理；本目录没有 Git 历史，不虚构每次提交或精确耗时。

| 阶段 | 做了什么 | 选择理由与留下的成果 |
| --- | --- | --- |
| 1. 需求与参考 | 用户要求在当前目录制作简洁 BGM Agent，参考 [Modelwright](https://github.com/chenyihang98-pixel/Modelwright) 的应用设计；确认同时支持本地与 API | 参考应用组织和交互思路，围绕“描述→生成→试听→微调→导出”；没有把参考仓库作为运行依赖、代码分支或音乐引擎 |
| 2. 界面与桌面骨架 | React + TypeScript + Vite；Electron 窗口、隔离 preload、原生导出；中文工作台、作品库、灵感库、设置/帮助 | Windows 可直接用；浏览器开发版仍能离线作曲。深色背景、淡紫强调、左侧导航和清晰参数区域；没有引入复杂路由/状态管理框架 |
| 3. 本地作曲 | 实现六种情绪、规则解析、种子、和声/旋律/贝斯/鼓组、四种主奏合成音色、混响和循环、PCM/WAV | 首次打开无需账号、GPU 或下载模型即可试听。可控、可重建，接受其音色和文本理解有限的边界 |
| 4. 完整创作闭环 | 试听、跳转、文字/参数微调、即时分轨混音、保存版本、搜索收藏删除、工程 JSON、WAV/分轨导出 | 区分“编辑草稿”和“已经生成的声音”，避免导出内容与界面参数不一致；本地配方与云端音频分别持久化 |
| 5. 首个云端和 v0.1.0 | 接入 ElevenLabs；加入系统加密密钥、请求取消/超时、固定官方端点、错误脱敏；构建便携 EXE | v0.1.0 的 29 项单元、7 组 UI、6 组发行检查通过；示例音乐、图标和截图生成。此时也没有真实付费 API 调用 |
| 6. 用户要求完整自测及三家国内服务 | 查阅官方音乐 API，选腾讯 TokenHub、火山 AI 音乐、阿里 Fun-Music；新增三适配器与独立配置表单 | 腾讯直连路径选 TokenHub，未把 MiniMax 直连作为新用户默认入口；火山使用新 v5.0 文档；阿里明确邀测和北京地域限制。调研依据保存在 `docs/` |
| 7. 工作流缺陷修复 | 扩展实际 Electron 回归、模拟云端音频与故障注入，修复播放/删除竞态、微调语义、保存状态、时长与格式 | 见下方修复表；云端保存实际时长，按真实文件格式导出，凭据状态表述为“已保存”而非“已联通” |
| 8. v0.2.0 交付 | 更新类型/存储/多服务密钥兼容；重新构建 EXE，实测解包程序与自解压入口、完整进程重启；更新 README/QA/API 指南 | 当前 0.2.0 是下一轮用户 API 实测基线；旧 0.1.0 留存；校验和见 S10 |
| 9. 本次交接 | 对当前源码、协议、数据和测试重新只读核对；创建本文及智能体入口 | 把上下文变成仓库内可按节读取的资料；不依赖接手者拥有原聊天记录 |

已修复且接手时应保留的行为：

| 曾经的问题/风险 | 当前处理 | 主要位置 |
| --- | --- | --- |
| 手动调整被预设覆盖、微调意外换种子 | 生成从当前 config 出发；adjust/refine 保留种子，明确换旋律指令除外 | App `generate`、`refineFromPrompt` |
| 英文 `unmute` 被识别成 `mute`；能量已很低却“更柔和”后升高 | 修正指令匹配与边界行为，加入回归 | `composer.ts`、`invariants.test.ts` |
| 不支持的本地微调仍保存一份一样的作品 | 参数没有变化时提示可用指令，不创建重复作品 | App `generate` |
| `AudioContext.resume()` 晚到导致新建/暂停后又播放 | 用播放请求序号、buffer/context 检查丢弃过期请求 | `usePlayer.ts` |
| 旧节点 onended 污染新状态、关循环时进度跳到末尾 | 绑定当前 source，切换循环时重设时间基准 | `usePlayer.ts` |
| 删除旧作品完成后清空刚打开的另一首 | 异步删除完成时重新检查 `projectRef.current.id` | App `remove` |
| 保存失败却显示完成、旧作品时长补写失败留下旧音频 | 保存失败单独提示，保留可导出结果；先载入正确声音再补写元数据 | App `persist/generate/openProject` |
| 未应用草稿影响导出 | 配方/分轨/淡出读取 `project.config`，完整音频读取已生成 buffer | App `exportAudio` |
| 云端都被当作 MP3、目标时长冒充实际长度 | 识别文件头与 MIME，保存 `audioDuration`，原格式逐字节导出 | `providers/shared.cjs`、`src/providers.ts`、App |
| 取消/超时后迟到成功仍生效、重复点击多次提交 | 前后端任务锁与取消检查，提交不自动重试 | App、`music-service.cjs`、共享适配器 |
| 空标题留在输入框而作品仍是旧名 | 恢复原名称并提示 | App 作品名称输入框 |

## S03｜当前功能清单与产品边界

| 区域 | 已实现 | 约束 |
| --- | --- | --- |
| 创作工作台 | 中文描述、六个情绪按钮、预设灵感、生成进度、取消、重新变奏 | 主描述 UI 上限 1500 字符；本地为规则识别，不理解所有自由语言 |
| 参数 | BPM 60–160、五种调性、四种主奏、能量/丰富度/混响、循环编排、目标时长 | 默认 30 秒；选项 15/30/60/120；本地可识别范围内其他秒数并显示自定义选项；火山至少 30 秒 |
| 播放 | 波形、播放暂停、跳转、回到开头、循环试听、主音量 | 试听循环与创作配方 loop 分开；主音量不会改变导出文件 |
| 本地微调 | 自然语言指令、保留种子改参数、换旋律；旋律/和声/贝斯/鼓组音量、静音、独奏 | 声音由程序合成，没有 MIDI 钢琴卷帘、音符拖拽、外部采样库或 VST |
| 云端微调 | 音乐方向与当前参数写入提示词后重新生成 | 返回混合音轨；四分轨控件禁用；无法保证 BPM、调性、音色、循环、时长逐项精确遵循 |
| 我的作品 | 自动保存、重命名、收藏、搜索、删除、打开、版本编号 | 全部在本机；无登录、云同步、多人协作、撤销栈或真正版本树 |
| 导出/导入 | WAV、单独本地音轨、云端原始音频、可编辑本地 JSON | JSON 不含音频；不能用它恢复云端成品；未实现任意音频文件导入/编辑；原格式导出不是转码 |
| 服务设置 | 四家服务独立配置/删除、官方链接、非秘密配置回显、系统加密 | 保存不发计费请求，不等于鉴权已通过；修改配置需重新填凭据 |
| 桌面 | Windows x64 便携包、原生保存框、用户目录持久化 | 无安装向导、自动更新或代码签名；未交付 macOS/Linux 包 |

UI 采用 CSS 渐变、原生绘制的封面/波形与 Lucide 图标；主要样式集中在 `styles.css`，没有 Tailwind、远程字体或外部图片服务依赖。默认窗口 1440×940，最小 1060×720；新设置面板在小窗口内滚动。

## S04｜架构与完整文件地图

```text
index.html → src/main.tsx → App.tsx（React.StrictMode）
  ├─ 本地：composer → audio/engine → AudioBuffer + 四条 stems
  ├─ 云端：window.museDesktop → preload → main IPC → music-service
  │                                         ├─ ElevenLabs 内置分支
  │                                         └─ providers/{tencent,volcengine,aliyun}
  │                                              → shared 下载/文件头校验
  │         ← ArrayBuffer + MIME ← 主进程      → renderer 解码为 AudioBuffer
  ├─ usePlayer：Web Audio 试听；components/styles：界面
  ├─ storage：IndexedDB（本地配方 / 云端 Blob）
  └─ 导出：encodeWav 或原始 Blob → saveAudio IPC → 原生对话框 → 文件
       浏览器版无 museDesktop，只走本地作曲和浏览器下载
```

| 文件/目录 | 职责与定位 |
| --- | --- |
| `src/App.tsx` | 主界面与业务编排（约 1800 行）。`generate/openProject/persist`、`changeMix/toggleSolo`、`exportAudio/saveFile`、`favorite/remove/importFile/rename/newProject` 是定位点 |
| `src/ProviderSettings.tsx` | 按服务切换表单、保存/移除凭据；不会将已保存秘密读回输入框 |
| `src/providers.ts` | 四服务名称、模型选项、开通提示、官方链接、`originalFormat` MIME→扩展名 |
| `src/types.ts` | 跨前端的类型契约：MusicConfig、Project、RenderResult、Provider、DesktopAPI |
| `src/composer.ts` | `MOODS/INSTRUMENTS/DEFAULT_CONFIG`、`planFromPrompt/refineFromPrompt/promptSeed` |
| `src/audio/engine.ts` | `renderMusic/mixStems/computePeaks/encodeWav/seededRandom`，实际 PCM 合成 |
| `src/usePlayer.ts` | AudioContext 生命周期、一次性 source、播放/暂停/跳转/循环/音量和竞态防护 |
| `src/storage.ts` | 配方/Project 归一化，IndexedDB 事务，JSON 导入导出和中文错误 |
| `src/components.tsx` | IconButton、Slider、Modal、Cover、timeLabel；Modal 包含焦点/键盘处理 |
| `src/styles.css` | 全局与各页面/响应式样式；服务表单样式也在此，无 CSS 模块系统 |
| `src/main.tsx`、`index.html` | React 启动与中文 HTML 容器 |
| `electron/main.cjs` | Electron 启动、窗口、安全设置、可信 IPC、导出对话框、生命周期 |
| `electron/preload.cjs` | 冻结的九个桌面方法；不暴露通用 IPC/fs/Node |
| `electron/music-service.cjs` | 统一生成锁/超时/取消、ElevenLabs 分支、适配器路由、安全文件名、外链白名单 |
| `electron/credentials.cjs` | 服务枚举与各服务凭据/模型归一化；秘密字符与长度验证 |
| `electron/key-store.cjs` | Windows 加密凭据、V1→V2 兼容、串行写入和单服务删除 |
| `electron/providers/shared.cjs` | MusicError、受限 JSON/音频读取、格式检测、HTTPS 下载和逐跳域名校验 |
| `electron/providers/tencent.cjs` | TokenHub 请求、服务状态码、hex 校验/解码 |
| `electron/providers/volcengine.cjs` | V4 签名、GenBGM/GenBGMForTime、QuerySong 轮询、官方 CDN |
| `electron/providers/aliyun.cjs` | 北京业务空间域名、Fun-Music 请求、结果 URL 下载 |
| `electron/assets/muse.svg/.png/.ico` | 自制应用图标；构建直接使用已有 PNG/ICO，无需 Python |
| `tests/*.test.ts`、`tests/*.test.cjs` | 单元与协议测试；逐文件覆盖见 S09 |
| `tests/fixtures/music-3s.{mp3,m4a,wav}` | 真实可解码的 3 秒本地音频，用于模拟 API 输出，不是云端生成结果 |
| `scripts/*smoke.cjs`、`workflow-regression.cjs`、`cloud-workflow.cjs` | 实际 Electron 与发行程序验证；见 S09 |
| `scripts/create-demo.cjs` | 经 Electron 界面生成示例 WAV/工程/工作台截图 |
| `scripts/generate-icons.py` | 用 Python/Pillow 重新生成 SVG、PNG、ICO；非运行依赖 |
| `examples/夏日小事.wav/.muse.json` | 30 秒本地示例、可导入配方；示例 WAV 为 3,840,044 字节 |
| `docs/API配置指南.md` | 面向用户的开通、填写、试用提示词与排错步骤 |
| `docs/QA.md` | 当前验证结论、范围与发行哈希 |
| `docs/research-minimax.md`、`research-volcengine.md` | 官方协议核验依据、选型理由与文档差异，按需读 |
| `test-results/` | JSON 结果、截图、导出样例；混有调试期失败截图，不能仅凭名字推断未修复 |
| `package.json`、`package-lock.json` | 依赖/命令/Electron 构建配置、精确锁定版本 |
| `vite.config.ts`、`tsconfig.json` | 相对 base、开发端口、生产 CSP、严格 TS；TS 检查 include 为 src，CJS 依靠测试 |
| `README.md`、`LICENSE`、`.gitignore` | 用户入口、当前项目 MIT 文本、依赖/构建/日志/环境文件忽略规则 |
| `HANDOFF.md`、`AGENTS.md`、`CLAUDE.md` | 本交接文件和简短智能体发现入口；入口不自动导入全文 |
| `启动音序.cmd` | 从源目录定位当前发行 EXE；发布新版时需同步文件名 |
| `dist/`、`release/`、`node_modules/`、`tsconfig.tsbuildinfo` | 构建产物、发行物、安装依赖、TS 增量缓存；不是需要逐个理解/手改的业务源码 |

## S05｜数据契约、状态流与不能破坏的不变量

### MusicConfig 与 Project

| 字段 | 取值与含义 |
| --- | --- |
| `prompt` | UI 最长 1500 字符；存储最多 2000，可为空，但生成入口拒绝空描述 |
| `mood` | bright 青春欢快 / chill 慵懒松弛 / cinematic 电影叙事 / dreamy 梦幻空灵 / focus 安静专注 / retro 复古电子 |
| `bpm`、`duration` | 存储 BPM 60–160 整数；目标 duration 15–120 秒。各云端接口还有限制，见 S07 |
| `key`、`instrument` | C major、D major、G major、A minor、D minor；piano、guitar、synth、bell |
| `energy/complexity/reverb` | 0–1；分别影响能量、音符/和声丰富度、空间效果 |
| `seed`、`loop` | uint32 种子；是否按循环片段编排/处理尾音；不是播放器循环开关 |
| `volumes` | `{melody,chords,bass,drums}`，每项 0–1 |
| Project 元数据 | id（新建/导入使用 UUID；存储接受最长 120 字符的非空字符串）、title、createdAt/updatedAt(ISO)、config、provider、favorite、revision、tags |
| `audioBlob?` | 本地通常不保存；云端必须是非空 Blob。已生成云端作品重新打开只解码，不重新调用服务 |
| `audioDuration?` | 解码/合成后的实际秒数，存储接受 0.01–3600；和目标 config.duration 分开，老记录可打开时补齐 |

名称 UI 限 64 字符、存储限 80；最多 12 个去重标签，每个 32 字符。归一化会拒绝非有限数字/非法枚举/错误类型，将合法数字夹取到范围，并去掉未知字段。默认配方：bright、112 BPM、30 秒、C major、piano、能量 0.62、丰富度 0.5、混响 0.25、seed=42017、loop=true、音量 0.8/0.64/0.68/0.56。

### 用户操作到状态变化

1. 启动：`listProjects()` 读库；桌面 `getSettings()` 读配置状态。当前页为 studio；不会自动重新生成已保存云端音乐。
2. 编辑：`prompt/config/provider` 是草稿。`dirty` 是参数编辑事件设置的待应用标志，不是完整差异比较；同值编辑也可能置位，切换 provider 本身不置位。文字改变可重新解析预设；手动参数必须在真正生成时保留。
3. 生成：`generate(new|variation|adjust|refine)` 从当前参数构造计划；new/variation 取新随机种子，adjust/refine 保留种子，明确换旋律指令除外。
4. 本地调用 renderMusic；云端将当前参数、纯音乐要求、轨道突出程度和本次微调文字组成中文 prompt，经桌面桥接取音频并解码。
5. 成功后创建新 UUID，new 的 revision=1，其他为当前 revision+1；旧作品不覆盖。没有 parentId、分支关系或版本树。成功生成但保存失败时，仍保留声音并提示先导出。
6. `changeMix` 立即重混音并原地写回当前作品的音量；不会创建新版本。独奏只影响当前试听 buffer，不写入配方。打开作品时，本地重建 stems，云端恢复 Blob。
7. 导出 JSON/分轨增益/淡入淡出依据 `project.config`，完整 WAV 依据当前 `audioBuffer`；独奏状态下完整 WAV 也只有独奏内容，UI 会提示。主试听音量不影响文件。非循环作品可添加最多约 1 秒淡入淡出；原始云端导出不改变字节。

### 存储/工程格式

- IndexedDB：数据库 `muse-bgm`，版本 `1`，store=`projects`，keyPath=`id`。保存必须等事务 `oncomplete`，不能只等单次 request 成功。列表按 updatedAt 降序；当前生成/混音会更新时间，改名/收藏不会，修改“最近作品”排序前需注意这一点。
- JSON：`{schemaVersion:1, ...Project元数据}`，去掉 audioBlob；上限 1 MiB，检查 UTF-8 实际字节数。`importProject` 创建新 ID/时间，保留配方和版本等字段，避免覆盖已有作品。
- 云端 JSON 不含 Blob，不能单独导入恢复：ElevenLabs 有专用提示，国内服务经通用 Blob 检查拒绝。App 的工程备份入口用于本地配方。
- 本地配方重建依赖当前引擎；schemaVersion 不是引擎音色版本，修改合成算法可能改变旧工程声音。
- 默认用户数据和浏览器开发 origin 的数据相互独立；将 EXE 移到别处不等于迁移作品；清除应用数据会丢作品。

### 并发与播放器约束

- `busyLock` 是同步生成/打开锁，`busy` 负责 UI。`token` 是任务代次；取消后旧结果不得写入当前作品。本地通过进度回调抛 AbortError；云端同时调用主进程取消。
- `projectRef` 防止异步删除误清空后来打开的作品。`openProject` 先更新音频与 UI，再尝试补写时长元数据。
- `usePlayer` 使用 AudioContext、GainNode 和一次性 AudioBufferSourceNode；`playRequest` 在暂停/换 buffer/卸载时失效，resume 后再检查；旧 source 的 onended 不得结束新 source。
- 关闭试听循环前重设 offset/start，避免取到多次循环后的累计时间。`load(buffer,true)` 用于即时混音，尽量保留播放位置/状态；内部播放错误走 onError。
- 保存失败和生成失败是不同状态；不能仅凭声音可听就显示“已保存”。草稿、试听独奏/主音量/循环不自动持久化。

## S06｜本地作曲实现与扩展入口

`composer.ts` 的 `planFromPrompt` 根据关键词选择情绪/音色和显式参数，`refineFromPrompt` 在已有配方上改动。支持中英文部分关键词，以及“慢一点/快一点”“换成吉他”“不要鼓点/恢复鼓点”“减少混响”“新旋律”等规则；`applyInstructions` 是查看实际支持范围的位置。`reasoning` 是面向用户的参数解释，不是 LLM 推理结果。

`engine.ts` 在 renderer 内异步分块合成，没有 Web Worker/AudioWorklet。输出 32 kHz 双声道，四个 Float32 stems 加一个混音 buffer；按小节组织和弦进行、重复动机与变奏、贝斯和程序鼓。旋律与打击乐随机流分开，调音量不应改变音符。不同情绪使用不同和声/密度；piano/guitar/synth/bell 都是合成音色，内部还有铺底等声部。

| 入口 | 输入→输出 / 关键行为 |
| --- | --- |
| `seededRandom(seed)` | 可复现伪随机函数；不要将 Math.random 混入可重建音符序列 |
| `renderMusic(config,onProgress?)` | Promise<{buffer,stems,peaks}>；进度 0–1；通过让出浏览器执行权响应 UI/取消 |
| `addNote/addDrum/addSpace` | 音色包络/振荡、打击乐、空间效果；改音色优先定位这些内部函数 |
| `mixStems(stems,volumes)` | 建新双声道 buffer，按 0–1 增益混合，峰值超过 0.96 时整体缩放；不修改原始 stems |
| `computePeaks(buffer,count=140)` | 抽样归一化波形显示，不能用它替代响度/音质测量 |
| `encodeWav(buffer)` | 44 字节 RIFF/WAVE 头 + 交错 little-endian 16-bit PCM；使用实际 buffer 声道数/采样率 |

循环片段处理跨边界音符/效果，非循环片段有自然包络收尾；任意指定秒数不保证落在完整乐句边界。120 秒多声道 Float32 音频会占用明显内存；未来要提升长音频能力应考虑线程和内存预算，而不是直接去掉时长限制。示例和测试可证明采样有效/确定性，不能替代人工音乐性评价。

## S07｜四个音乐 API 的现有适配协议

协议快照核验日期为 2026-10-08，后续接入失败时应按官方最新文档复核。用户开通步骤和测试提示词直接读 [API 配置指南](docs/API配置指南.md)，此处只保留维护代码需要的契约。没有通用“OpenAI 兼容音乐 Base URL”配置，不能填写任意第三方中转地址。

| provider / 模型 | 凭据与端点 | 返回/时长 |
| --- | --- | --- |
| `tencent`：`minimax-music-v3.0` 默认、`minimax-music-v2.6` | TokenHub Bearer Key；POST `https://tokenhub.tencentmaas.com/v1/wand/minimax-music/generation` | 同步 JSON 内 hex MP3；目标时长只写入 prompt |
| `volcengine`：`v5.0` | AK/SK；POST `https://open.volcengineapi.com/`，query API Version=`2024-08-12` | 提交 TaskID→查询→CDN 音频；整数 30–120 秒 |
| `aliyun`：`fun-music-preview` 默认、`fun-music-v1` | 北京地域 Bearer Key + Workspace ID；POST `https://{workspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/music/generation` | 同步 JSON 内 audio.url，再下载；目标时长只写入 prompt；需邀测 |
| `elevenlabs`：`music_v1` 默认、`music_v2`、`music_v2_5` | `xi-api-key`；POST `https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128` | 直接 MP3；`music_length_ms` 传目标时长 |

**腾讯**：`is_instrumental:true`、`lyrics_optimizer:false`、`output_format:'hex'`、不传歌词；`audio_setting:{sample_rate:44100,bitrate:256000,format:'mp3'}`。加上时长说明后的 prompt ≤2000 字符。检查 `base_resp.status_code===0`、`data.status===2`，验证 hex 字符/长度后解码。模型名、地址和 Key 均不是 MiniMax 官网直连的那一套。采用 TokenHub 的理由及 MiniMax 新用户限制见 [调研记录](docs/research-minimax.md)，不要照旧免费模型示例改回直连。[官方协议](https://cloud.tencent.cn/document/product/1823/135323)

**火山**：预付费 Action=`GenBGM`，默认按量后付费=`GenBGMForTime`，查询=`QuerySong`。`signRequest` 对实际 UTF-8 JSON 做 V4 HMAC-SHA256；region=`cn-beijing`、service=`imagination`、UTC `X-Date`，签名头含 content-type、host、x-content-sha256、x-date。正文 `Text` 中文、`Duration`、`Version:'v5.0'`、`EnableInputRewrite:false`、`Segments:[{Name:'inst',Duration}]`；Segments 保证结构时长优先。查询 Status 0/1 等待、2 成功、3 失败，间隔 2 秒、最多 150 次。读取 `SongDetail.AudioUrl`；初始地址严格限定 HTTPS 的 v1–v50-default.douyinvod.com。当前文档的 v5 30–120 秒优先于旧资料 60 秒上限；开通资格以账号控制台为准。[协议与差异记录](docs/research-volcengine.md)

**阿里**：`{model,input:{prompt,is_instrumental:true,format:'mp3'}}`；添加目标时长文字后 ≤2000 字符。成功需 `output.finish_reason==='stop'` 和 `output.audio.url`；下载后以实际内容识别格式，即使请求 MP3 也不硬编码导出扩展名。官方示例的 HTTP OSS URL 会升级 HTTPS，并保留查询参数；链接临时有效，App 下载成 Blob 后离线保存。Workspace ID 只接受可作为主机标签的标识，不能填空间名称或整条 URL。[官方协议](https://help.aliyun.com/zh/model-studio/fun-music-api)

**ElevenLabs**：旧实现保留在 music-service，不在独立 adapter 文件；发 `prompt/music_length_ms/force_instrumental:true/model_id`，只接受 MP3。IPC 缺省 provider 仍为 ElevenLabs，以兼容旧版；前端默认选择本地。

三家新服务统一适配器签名为 `generate({input,credentials,signal,fetchImpl,maxBytes})`，返回 `{audio:ArrayBuffer,mimeType}`；火山可能附额外时长信息，但 UI 使用解码后的真实 duration。`fetchImpl` 可注入用于 mock。共享音频上限 80 MiB，JSON 默认 2 MiB，腾讯 hex 响应单独放宽。文件头检测支持 MP3、WAV、FLAC、MP4/M4A；文件头通过不代表完整音频有效，renderer 还需解码。

## S08｜桌面边界、IPC、凭据和任务生命周期

### DesktopAPI（通道均带 `muse:` 前缀）

| 前端方法 | IPC 通道 | 关键入参/返回 |
| --- | --- | --- |
| `getSettings` | `get-settings` | `{hasApiKey,providers,dataPath}`；hasApiKey 仅指 ElevenLabs |
| `saveApiKey/deleteApiKey` | `save-api-key/delete-api-key` | 旧 ElevenLabs 兼容方法，勿误用为多服务配置 |
| `saveProviderCredentials` | `save-provider` | provider、凭据对象；保存成功返回 void |
| `deleteProviderCredentials` | `delete-provider` | 只删除一个 provider |
| `generateMusic` | `generate-music` | `{provider?,prompt,duration,model?}` → `{audio:ArrayBuffer,mimeType}` |
| `cancelGeneration` | `cancel-generation` | 终止客户端等待，不保证撤销远端任务/费用 |
| `saveAudio` | `save-audio` | `{name,data:ArrayBuffer,format}` → `{saved,path?}`；format=wav/mp3/m4a/flac/json |
| `openExternal` | `open-external` | 只能打开精确白名单内官方 URL |

主进程验证调用窗口、主 frame 与受信 URL；sandbox/contextIsolation 开启，nodeIntegration 关闭，拒绝新窗口/webview/非应用导航/权限请求。生产 CSP 同时在 Vite meta 和主进程响应头设置，renderer `connect-src 'none'`。所有云端请求走主进程，密钥不会进入 renderer 持久化数据。用户新填的凭据短暂经过表单/IPC，保存后清空秘密输入；已存秘密不回显。

`createMusicService` 对所有云服务共用一把锁，5 分钟总超时；取消后原请求收尾前仍保持锁，并丢弃迟到成功。不自动重发付费生成、不自动切换收费方式。轮询不是重新提交生成。API 请求禁重定向；CDN 下载不附鉴权，逐跳重新验证域名，最多 5 次请求；阿里限制 aliyuncs.com 域下，火山初始下载还有限定 CDN 名单。

对外只传 MusicError 的安全文案，隐藏原始错误响应、认证头、带签名 URL 和系统网络异常。当前没有持久化完整服务 request ID/TaskID 的诊断日志，排查真实调用要结合平台控制台。

导出入参须为非空 ArrayBuffer，最大 256 MiB；原生保存框决定磁盘路径，renderer 不能指定绝对输出路径。`safeFilename` 处理非法字符、Windows 设备名和扩展名，但不转换音频编码。

### 凭据文件与迁移

```text
userData/music-credentials.json
V2: {version:2, providers:{providerId:{encryptedCredentials:"<base64密文>"}}}
密文内部是 normalizeCredentials 后的 JSON（含 Key/AK/SK 及模型等配置）。
V1: {version:1, encryptedApiKey:"<base64密文>"}   // 仅 ElevenLabs
```

`safeStorage` 使用当前系统账户保护；加密不可用时拒绝保存。读 V1 兼容，首次保存配置时转 V2 并保留旧 ElevenLabs；迁移时旧密钥解密失败会拒绝写入，保留原文件。V2 保存不先解密旧条目，只替换所选服务，因此可重新保存来修复该服务无法解密的旧凭据；文件结构校验失败则仍会拒绝读写。写入通过串行队列、临时文件和 rename；单独删除不影响其他服务。`getStatuses` 只回传 configured、model、workspaceId、billingMode；configured 表示“已保存”，不代表真实鉴权成功。一个损坏的凭据条目可能令整体状态读取失败，见 S11。

| 环境变量 | 行为 |
| --- | --- |
| `MUSE_DEV_URL` | 只在未打包时允许 localhost/127.0.0.1/[::1] 的 HTTP 开发页；发行版忽略 |
| `MUSE_PORTABLE_DATA=1` + `PORTABLE_EXECUTABLE_DIR` | 同时具备时，将数据改到指定目录下 Muse-Data；正常便携启动默认仍使用 Windows 用户目录 |
| `ELECTRON_RUN_AS_NODE` | 外部环境若遗留会影响 Electron 启动；测试脚本会删除，不是产品功能开关 |
| `MUSE_REGRESSION_FILTER` | 只作用于扩展回归脚本，正则筛选检查；定向报告与全量报告分开 |

测试脚本为自己创建临时 profile；不要改成正式用户数据目录。切换 portable 数据路径不会迁移旧库，加密文件也不能假定跨机可解密。

## S09｜测试现状、证据与最小验证策略

本节记录的是此前已完成的 v0.2.0 验证；本次文档任务不重新运行应用测试，不声称新增验证。当前没有已确认未修复的阻塞流程故障；S11 的限制依然存在。

| 单元文件 | 数量 | 主要覆盖 |
| --- | ---: | --- |
| `tests/engine.test.ts` | 8 | 解析、保留参数、边界、种子、PCM/WAV、四轨、时长/确定性、取消/循环/变奏 |
| `tests/invariants.test.ts` | 4 | 指令和数值边界回归（含 unmute、柔和调整） |
| `tests/storage.test.ts` | 11 | JSON 往返、校验/大小/枚举、未知字段、云端缺 Blob、存储环境错误 |
| `tests/desktop.test.cjs` | 10 | ElevenLabs 契约、密钥、重试/锁/取消/超时、文件/外链校验 |
| `tests/provider-tencent.test.cjs` | 9 | TokenHub 参数/模型、业务状态、hex、大小、音频格式、取消/错误 |
| `tests/provider-volcengine.test.cjs` | 10 | V4 固定签名、v5 参数/时长、计费 Action、轮询、CDN、失败/取消 |
| `tests/shared-providers.test.cjs` | 14 | 阿里契约、共享下载、认证隔离、路由/锁、密钥多服务隔离与 V1 迁移 |
| **合计** | **66** | `npm test`：23 TS + 43 CJS，全部通过 |

| 集成脚本 | 最近结果与证据 | 覆盖/运行前置 |
| --- | --- | --- |
| `scripts/desktop-smoke.cjs` | 通过；结果主要在标准输出 | 实际 Electron、9 个桥接方法、隔离、四服务状态、真实 Windows 加密保存删除；先 build |
| `scripts/ui-smoke.cjs` | [7 组通过](test-results/ui-smoke-results.json) | 15 秒音乐、播放/微调、静音独奏、WAV/JSON、库/收藏/reload；先 build |
| `scripts/workflow-regression.cjs` | [27/27](test-results/workflow-regression-results.json)，0 renderer 错误 | 六 mood、各时长、取消/双击、无效导入、配额故障、草稿导出、删除/播放竞态、4 服务配置；先 build |
| 同脚本定向运行 | [1/1](test-results/workflow-regression-focused-results.json) | 旧作品补写 duration 遇配额错误，仍正确打开并能播放；不是额外完整跑过 27 次的证明 |
| `scripts/cloud-workflow.cjs` | [8 组通过](test-results/cloud-workflow-results.json)，真实请求 0 | UI→preload→IPC→实际适配器→真实音频解码→保存→播放→原格式导出；先 build |
| `scripts/packaged-smoke.cjs` | [7 组通过](test-results/packaged-smoke-results.json)，version=0.2.0 | 实际 win-unpacked EXE、便携自解压包、三国内选项/四状态、生成/导出、完整进程重启、Blob 恢复；先 dist |

云端脚本在载入真实 main 前替换所有 fetch；未知请求立即失败，另阻断 Chromium HTTP/HTTPS。腾讯模拟 hex MP3；火山模拟签名提交+两次查询+M4A CDN；阿里模拟 URL+WAV。三份实际 3 秒音频与请求 15/30/15 秒不同，断言保存/显示实际 3 秒、导出字节完全相同。还检查 401 不重试、双击一次提交、删除一个 Key 不影响其他、CDN 无认证、云端作品离线重开。素材来自本地示例，通过已有 FFmpeg 转换；不是商业模型成品。

导出测试替换原生保存框返回路径，随后实际 IPC 写盘/读回；没有人工点击保存框的验收。单元 PCM 使用轻量 AudioBuffer 实现；集成测试使用 Chromium 真正解码与 Web Audio。无 renderer 错误、有效采样和播放时间推进不等于人工听感合格。

已查看工作台 1440/1060 宽度和三家设置 1060 窗口截图。主截图见 `test-results/ui-generated-1440.png`、`ui-generated-1060.png`、`cloud-workflow.png`、`portable-launched.png`。`ui-smoke-failure.png`、`workflow-failure-*.png` 是历史调试遗留；不要当成当前失败。旧隔离临时目录有过清理受环境策略阻止并保留的记录，不属于发行依赖，无需为运行 App 删除它们。

最小验证选择：

- 只改文档：核对链接/路径/事实即可，不必重新合成和打包。
- 改前端/数据/规则：build + 相关单元；涉及用户流程再跑对应 UI/扩展脚本。
- 改 API/密钥：相关 CJS + desktop smoke；改契约/解码时再跑 cloud-workflow。
- 改发版配置或最终交付：dist 后跑 packaged-smoke，重算 SHA；源码测试不能替代已打包程序检查。
- 保守地顺序运行桌面脚本；应用存在单实例锁。脚本虽用隔离 profile，也不要让自己添加的测试误连真实服务。

## S10｜环境、命令、发行物与资源重建

快照机器：Windows / PowerShell，Node `24.18.0`、npm `11.16.0`。README 建议 Node 22.12+；不必为了复现强行升级现有可用环境。`npm ci` 按锁文件安装，`npm install` 可能更新解析版本。

锁定版本（来自 package-lock，和 package.json 的范围不是一回事）：React/react-dom 19.3.0、TypeScript 5.9.3、Vite 7.3.7、Electron 41.10.7、electron-builder 26.15.3、Playwright 1.64.0、Lucide 0.577.0、tsx 4.23.15；global-agent override=4.1.3。前端是 ESM/TS，Electron 和测试脚本后缀 .cjs 使用 CommonJS。

```powershell
Set-Location D:\makeBGM
# 依赖不存在/需要按锁恢复时才执行 npm ci
npm run build                  # tsc -b + vite build
npm test                       # TS 测试，再 CJS 测试
npm run desktop                # 会重新 build，然后打开 Electron
# 下列为按需测试，不要求每次文档/样式更改全跑
npm run desktop:smoke
npm run test:ui
node scripts/workflow-regression.cjs
node scripts/cloud-workflow.cjs
```

浏览器开发：`npm run dev`，127.0.0.1:5173，严格端口，浏览器没有桌面 API。Electron 热更新可另开 PowerShell，设置 `$env:MUSE_DEV_URL='http://127.0.0.1:5173'` 后 `npx electron .`；该变量只用于当前进程环境，结束后移除以免混淆生产界面。`npm run desktop` 本身不是双进程热更新脚本。

发行：`npm run dist` = build + electron-builder `--win portable --x64`。包内包含 dist、electron、package.json 及所需运行依赖；asar=true，npmRebuild=false，appId=`studio.muse.bgm`，productName=`Muse BGM`，以普通用户运行。`signExecutable:false` 表示不签名但仍需编辑图标/元数据；不要误改为跳过资源编辑的配置。图标取 `electron/assets/muse.ico`。

| 产物 | 用途 |
| --- | --- |
| `release/Muse-BGM-0.2.0-Windows.exe` | 当前正式交付，便携自解压，无需安装 Node；90,001,478 字节（约 85.83 MiB） |
| `release/win-unpacked/Muse BGM.exe` | 打包展开后的程序，开发检查用；需要同目录运行依赖，不能只拷贝此 EXE |
| `release/Muse-BGM-0.2.0-Windows.exe.sha256` | SHA-256：`84fc1d947cadc35e2841f3a4def4b05b59af740535bbb1e4009db0f59ddbf21f` |
| `release/Muse-BGM-0.1.0-Windows.exe` | 历史版本留存，非当前测试基线 |
| `release/builder-debug.yml`、临时 7z | 构建过程记录/中间物；压缩时临时文件短暂为 0 字节不必然表示挂住，应看进程/日志 |

下一版更新 package.json 和锁文件版本、`启动音序.cmd`、UI 版本文案、README/QA/本文快照；构建后运行 `node scripts/packaged-smoke.cjs`，脚本从 package.json 取版本。用 `Get-FileHash -Algorithm SHA256` 对**新 EXE**计算校验和，不沿用此处旧值。正常运行便携 EXE 仍读 Windows 用户数据，不自动获得“所有数据跟着 EXE 走”的行为。

资源重建：`node scripts/create-demo.cjs` 需要已有 dist/Electron，会覆盖示例与展示截图；`python scripts/generate-icons.py` 需要 Pillow，会重写三个图标文件。运行 App、常规 npm build/dist 都不依赖 Python/FFmpeg。三份云端音频测试素材已存在，无需每次重转码。

## S11｜已知限制、维护风险与下一步优先级

### 已确认的产品/实现限制（不等于测试发现了新阻塞故障）

| 范围 | 当前限制/影响 |
| --- | --- |
| 真正云端联调 | 没有用户真实凭据；权限/账户地域/邀测/余额、真实音质、响应时长和账单待确认 |
| 云端可控性 | 参数大多是提示词，腾讯/阿里无硬时长字段；无音轨分离、局部重绘、旋律 seed 复现保证；更改方向通常整首重新生成 |
| 自由微调留存 | 未识别成结构参数的云端追加文字仅参与本次请求；没有单独保存最终云端 prompt、所用模型快照、request ID/TaskID；之后重生成不保证保留此前自由描述 |
| 草稿/版本 | 草稿不自动保存，切换作品会丢弃；revision 只是数字，没有 parentId/历史树或撤销栈 |
| 本地重建 | JSON 没有引擎版本，改算法后旧工程重建不保证逐样本一致；重要音乐应导出 WAV 备份 |
| 库损坏 | `listProjects` 中一条坏记录会使整个库读取失败；没有单条隔离/修复 UI，应保留原数据再诊断 |
| 凭据损坏 | `getStatuses` 解密所有已配置服务，一条坏密文可能使设置加载失败；不要为“修好”盲目删除整份文件 |
| 并发元数据编辑 | 保存状态是全局布尔，UI 元数据更新是整 Project 快照，没有统一编辑队列；快速交错改名/收藏/混音等复杂组合仍应针对性验证 |
| 网络恢复 | 不持久化远端任务、不支持崩溃后继续轮询；取消只是停止等待；用户重试前应核对平台调用记录 |
| 性能 | renderer 合成多条长音频，尚未引入 Worker、磁盘流式导出或缓存限额；未在低配设备做系统性能测试 |
| 导出与覆盖 | 原始音频导出保持格式，不任意转 MP3；原生对话框人工交互、不同声卡/辅助功能全路径、真实磁盘写满未完整验收 |
| 发行/工程维护 | 无代码签名/自动更新/CI，当前未初始化 Git；App.tsx 较大，可按业务边界逐步拆分，避免在 API 实测前大规模重构 |

### 下一步与用户已表达的计划

优先支持用户真实 API 实测，不要擅自购买套餐、索取聊天中的明文密钥或替其发起未约定的付费批量生成。

1. 用户在 App 设置中配置一个已开通服务，建议先 Tencent TokenHub；火山首次选 30 秒，阿里先确认邀测和北京地域。
2. 先测试一首：提交→完成→真实听感/无人声→实际时长→保存→导出→关闭重开；用户在控制台核对调用与费用。
3. 出错时收集服务名、模型、时间、App 安全文案和平台请求编号；不收集完整 Key、认证头或带签名音频 URL。先分清鉴权、权限/计费、参数、网络、音频下载/解码问题。
4. 只有出现证据再修改对应适配器或提示词策略；用 sanitized fixture 增加回归，不把整仓库重写作为默认修复方式。
5. 后续可选改进：完整云端创作上下文/诊断编号留存、任务恢复、项目备份包、坏记录隔离、引擎版本、Worker、版本谱系、代码拆分。它们尚未实现，也不是用户已批准的新增开发清单。

### 快速排错定位

| 现象 | 先检查 |
| --- | --- |
| EXE 启动失败 | 运行的是便携完整包还是孤立 win-unpacked EXE；用户目录权限；遗留 ELECTRON_RUN_AS_NODE；已有实例 |
| 改代码界面没变 | 是否先 build；打开的是旧 EXE、旧 dist 还是 MUSE_DEV_URL 页面 |
| 浏览器没有云端入口能力 | 正常：无 preload；应使用桌面版，不能放松生产 CSP 来绕过 |
| 保存凭据成功但生成失败 | 保存只做本地格式/加密；查凭据类型、模型开通、地域/Workspace、余额；不是“连接测试已通过” |
| 火山 15 秒被拒绝 | 当前 v5 最少 30 秒；别套旧版时长文档 |
| 腾讯/阿里成品比目标长 | 提示词时长不精确；看 audioDuration 和实际账单；App 当前不自动裁切 |
| 音乐生成了却不在库 | 看 saveFailed/配额；先导出当前声音；不要声称自动保存成功 |
| 云端工程 JSON 无法导入 | JSON 没有 Blob；应备份音频，或回原作品库打开 |
| 完整 WAV 只有一种乐器 | 检查是否开启独奏；导出使用当前试听混音，而主音量不会影响导出 |
| 回归突然大量超时 | 先看隔离 profile、单实例冲突、dist 是否最新、真实 renderer 错误；不要先扩大超时掩盖失败 |

## S12｜如何持续维护这份交接文件

事实优先级：用户最新目标与要求 → 当前源码/配置 → 本轮实际测试证据 → 本文快照/旧聊天结论。本文不是比用户要求更高优先级的约束。若发现不同，定向核实并更新对应章节，不必重新扫描全部依赖。

每轮有效变更后只更新受影响的功能/契约/限制/测试/版本，写清“通过什么、未验证什么”。新 API 协议变更在 docs 调研文件记录官方依据和日期；不要把服务商可变的资格、价格或模型能力写成永久事实。只修改文档时无需变更应用版本和 EXE 哈希。

接手时不需要重新阅读原聊天。需要更具体的用户操作读 [README](README.md) / [API 指南](docs/API配置指南.md)；需要验证细节读 [QA](docs/QA.md) 和对应 JSON；需要改实现按 S01 找符号。没有必要把本文件全部复制进下一次回复或新任务提示。
