# 音序 Muse · BGM 创作工作台

输入「青春欢快、轻盈钢琴、适合日常 Vlog」，生成背景音乐，再试听、微调和导出。v0.2.0 提供离线本地作曲，以及腾讯云、火山引擎、阿里云三家国内音乐服务；保留 ElevenLabs 选项。

**智能体接手**：先读 [制作过程与仓库交接反馈](HANDOFF.md) 的 S00、S01，再按任务定位章节。Claude Code / Codex 的简短入口分别为 `CLAUDE.md` / `AGENTS.md`。

## 打开与运行

已生成并验证 [v0.2.0 Windows x64 便携版](release/Muse-BGM-0.2.0-Windows.exe)，大小 90,001,478 字节（约 85.83 MiB）。双击 EXE，或双击源文件夹中的 `启动音序.cmd`。便携版无需安装 Node.js；没有 API 凭证也能使用完整本地作曲功能。[SHA-256 校验文件](release/Muse-BGM-0.2.0-Windows.exe.sha256)

源码位于 `D:\makeBGM`。使用 Node.js 22.12 或更新版本：

```powershell
Set-Location D:\makeBGM
npm ci
npm run desktop
```

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 启动浏览器开发版，本地作曲可用 |
| `npm run build` | TypeScript 检查与生产构建 |
| `npm run desktop` | 构建并打开桌面 App |
| `npm test` | 音频、解析、存储、服务协议及凭证测试 |
| `npm run desktop:smoke` | 检查真实 Electron、IPC 和系统加密 |
| `npm run test:ui` | 本地创作、播放、微调和导出流程 |
| `node scripts/workflow-regression.cjs` | 六种情绪、各时长、取消、导入、存储和播放竞态回归 |
| `node scripts/cloud-workflow.cjs` | 三家云端完整流程，使用模拟响应，零真实 API 调用 |
| `npm run dist` | 构建 Windows x64 便携版 |
| `node scripts/packaged-smoke.cjs` | 检查发行程序启动、导出和完整进程重启 |

桌面/UI 脚本读取已有 `dist`，先运行 `npm run build`。首次安装和打包需要下载依赖。测试使用隔离目录；浏览器与桌面作品库相互独立，可通过工程 JSON 迁移本地作品。

## 先试本地作曲

1. 写下情绪、场景和乐器，或选一个灵感预设；选择 15、30、60 或 120 秒。
2. 点击生成，在波形中播放、暂停、定位和循环试听。
3. 调整节奏、调性、主奏乐器、能量、丰富度和混响，点击「应用调整」创建新版本；也可输入「慢一点」「换成吉他」「不要鼓点」。
4. 即时调整旋律、和声、贝斯、鼓组的音量，静音或独奏。作品自动保存，可改名、收藏、搜索和删除。
5. 导出完整 WAV、单独音轨，或可重新导入的工程 JSON。

[试听 30 秒「夏日小事」](examples/夏日小事.wav) · [可编辑工程](examples/夏日小事.muse.json) · [工作台截图](test-results/muse-workbench.png)

本地引擎使用关键词、音乐规则和随机种子编曲，并用程序合成音色。它适合轻量 BGM、循环片段和草稿，不是运行在本机的生成式音乐大模型；文本理解和音色范围有限。

## 配置国内 AI 音乐服务

在桌面版「设置与生成服务」中保存所选平台凭证，再到工作台切换生成引擎。无需设置终端环境变量。建议先试腾讯云；已经开通其他服务时，可直接使用对应入口。

| 服务 | 所需配置 | 当前限制 |
| --- | --- | --- |
| 腾讯云 TokenHub | TokenHub API Key；MiniMax Music v3.0/v2.6 | 需开通所选音乐模型后付费；时长是描述目标 |
| 火山引擎 AI 音乐 | Access Key ID、Secret Access Key、预付费/后付费方式 | 需开通生成纯音乐；v5.0 支持 30–120 秒；不要填方舟聊天 Key |
| 阿里云百炼 Fun-Music | 北京地域 API Key、Workspace ID、已授权模型 | 目前需邀测批准；时长是描述目标 |

完整开通步骤、官方链接和首次测试提示词见 [API 配置指南](docs/API配置指南.md)。腾讯使用专属 TokenHub Key，不是腾讯云 SecretId/SecretKey 或 MiniMax 官网 Key。阿里云需要模型、地域和业务空间权限匹配；火山资格与计费开通情况以账号控制台为准。

每家凭证独立保存和删除，界面只返回配置状态。保存成功不代表平台鉴权已通过。所有云端输出都是混合音频，支持主音量、播放、WAV 和原始音频导出，不能直接拆成四条乐器轨道。原始导出按实际格式使用 MP3、WAV、M4A 或 FLAC。

云端重新生成会提交新的请求并可能计费；速度、音色、循环等意图通过描述传给模型，不能保证逐项精确遵循。腾讯和阿里的目标时长可能与结果不同，作品库和播放器显示实际音频时长。程序不自动重试生成；取消只停止等待，远端任务仍可能完成和计费。音乐使用权及费用以服务商条款为准。

## 保存与备份

- 每个版本保存到本机 IndexedDB；本地作品存参数与种子，重新打开时重建声音；云端作品保存实际音频 Blob 和时长。
- 工程 JSON 不包含密钥或音频，只用于本地作品备份；上限 1 MB，导入建立新作品。云端作品请导出音频备份。
- WAV 为立体声 16-bit PCM。本地采样率 32 kHz，云端 WAV 使用解码后的采样率。导出不受试听主音量影响；独奏状态会有导出提示。
- 参数尚未应用时，导出仍对应当前已生成的声音。保存失败会保留可试听结果并提示先导出，不会冒充已保存。
- 默认桌面数据目录为 `%APPDATA%\Muse BGM`。服务凭证在 `music-credentials.json` 中通过 Windows 系统保护加密保存；系统加密不可用时拒绝保存。
- 便携版默认也用 Windows 用户目录。可选 `MUSE_PORTABLE_DATA=1` 使用 EXE 旁 `Muse-Data`，但不会迁移旧作品；系统加密凭证不适合跨电脑共享。

## 验证状态

当前代码通过生产构建、66 项单元/协议测试、7 组基础 UI、27 项扩展回归，以及 8 组三家云端模拟流程检查。真实 Electron、IPC、Windows 加密、音频解码和文件写盘都参与测试；云端返回值使用本地音频素材模拟，**未使用用户真实密钥，未验证付费服务的账号权限、效果或账单**。

v0.2.0 实际发行程序和便携自解压包另通过 7 组检查，包含版本与三家国内入口、生成播放、导出及完整进程重启恢复。旧 v0.1.0 安装包保留供参考；日常使用请打开 v0.2.0。范围与报告见 [QA 记录](docs/QA.md)。

## 代码位置

| 位置 | 职责 |
| --- | --- |
| `src/App.tsx`、`src/ProviderSettings.tsx` | 工作台、作品库、云端配置、导出 |
| `src/composer.ts`、`src/audio/engine.ts` | 描述解析、确定性作曲、四分轨、WAV |
| `src/usePlayer.ts`、`src/storage.ts` | 播放控制、作品库与工程校验 |
| `electron/main.cjs`、`electron/preload.cjs` | 隔离的桌面 IPC 与文件保存 |
| `electron/providers/` | 国内服务协议、签名、轮询和音频下载 |
| `electron/music-service.cjs`、`electron/key-store.cjs` | 生成生命周期、取消、加密凭证 |
| `tests/`、`scripts/`、`test-results/` | 测试、工作流脚本与验证产物 |

设计参考：[Modelwright](https://github.com/chenyihang98-pixel/Modelwright)。
