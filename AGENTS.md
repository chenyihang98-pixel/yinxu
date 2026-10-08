# 智能体接手入口

本仓库是音序 Muse BGM 桌面 App。主交接文件为 [HANDOFF.md](HANDOFF.md)。

- 初次接手先只读 HANDOFF.md 的 S00、S01：`Get-Content .\HANDOFF.md -TotalCount 58`。
- 按 S01 的任务表再读对应章节/函数；无需加载交接全文、App.tsx 全文或全目录。
- 默认排除 node_modules、dist、release、音频/图片二进制和锁文件全文；需要时定向查看。
- 当前快照 v0.2.0；云端完成的是协议与模拟全流程验证，真实付费账号仍待用户接入。后续结果以当前源码和新测试为准。
- 用户作品和加密凭据位于应用用户目录，正常代码任务无需读取/清空它们。离线测试使用脚本自建的隔离 profile。
- 变更后更新 HANDOFF.md 相关小节及必要的 QA 记录；文档-only 改动无需重新打包。

运行、验证、API、制作过程、已知限制和所有文件职责均在 HANDOFF.md 按 S00–S12 索引。用户最新要求优先于本交接快照。
