# 智能体接手入口

本仓库是音序 Muse：把一句话变成纯器乐背景音乐的 Windows 桌面 App（Electron + React），外加一个只有本地作曲的网页版。主交接文件是 [HANDOFF.md](HANDOFF.md)。

- 初次接手先只读 HANDOFF.md 的 S00、S01：`Get-Content .\HANDOFF.md -TotalCount 51`。
- 按 S01 的任务表再读对应章节和源文件；不需要加载交接全文或整个目录。
- 默认排除 `node_modules`、`dist`、`dist-web`、`release`、`demos`、`test-results`、音频 / 图片二进制和锁文件全文；需要时定向查看。`.scratch/` 是被 Git 忽略的草稿区，不是产品的一部分。
- 当前快照 **v0.3.0**（本地作曲引擎 2、离线规则与大模型两种制作人、四家云端音乐服务、网页版、安装版与便携版）。云端音乐服务和托管的大模型只在本机模拟的服务上验证过，真实付费账号没有测过；安装包没有运行过；没有人听过生成的音频。不要把这些写成已验证。
- `release/` 里的 0.1.0 / 0.2.0 旧程序不要运行（会损坏 0.3 的作品库）。
- Git：本地仓库，没有远端；HEAD 是 `7972e71`，基线 `634c650` 是 v0.2.0。HEAD 之后的修复、整理、打包配置和文档都在工作区里没有提交——不要替用户提交、重置或清理，除非用户要求。
- 用户作品和加密凭据在 `%APPDATA%\Muse BGM`，正常的代码任务不需要读取或清空它们；所有测试和套件都使用自建的临时目录。
- 最低验证：`npm run typecheck`、`npm test`（约 1 分钟；`npm run test:fast` 几秒）。改了界面或主进程：`npm run build`，再跑相应的 Electron 套件；完整回归是 `npm run test:all`（约 3.5 分钟，不含打包）。改了作曲器或合成器：重新生成示例 `npx tsx scripts/render-demos.ts --example`。
- 变更后更新 HANDOFF.md 相关小节和必要的 `docs/QA.md` 记录；文档-only 的改动不需要重新打包。

运行、验证、数据契约、云端协议、制作过程、已知限制和全部文件的职责都在 HANDOFF.md 按 S00–S12 索引。以当前源码和测试为准；用户最新的要求优先于这份快照。
