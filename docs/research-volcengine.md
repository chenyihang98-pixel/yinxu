# 火山引擎纯音乐适配依据

核对日期：2026-10-08。只使用官方文档与官方 SDK；未使用付费密钥或发送音乐生成请求。

## 当前 API（不要沿用旧版 60 秒限制）

[生成纯音乐](https://docs.volcengine.com/docs/Audiovideounderstandingandprocessing/Generatepuremusic?lang=zh)（页面更新 2026-07-24）确认：服务已全面升级为 v5.0；纯音乐时长为 30–120 秒。提交为 `POST https://open.volcengineapi.com/`，query 包含 `Version=2024-08-12`，`Action=GenBGM` 使用预付费套餐，`Action=GenBGMForTime` 使用按量后付费。正文使用中文 `Text`、整数 `Duration`、`Version:"v5.0"`、`EnableInputRewrite:false`。本适配器额外设置 `Segments:[{Name:"inst",Duration:秒数}]`，使 UI 时长优先于描述中的时长。成功由 `Code:0`、`Result.TaskID` 表示。不会自动重试提交，也不会自动切换收费方式。

## 查询与下载

[查询任务](https://docs.volcengine.com/docs/Audiovideounderstandingandprocessing/Querytask-1?lang=zh)确认：同一主机下 `Action=QuerySong`、相同 API 版本和 POST 方法；正文仅 `TaskID`。`Result.Status` 为 0 等待、1 处理、2 完成、3 失败。完成时读取 `Result.SongDetail.AudioUrl` 与 `Duration`。文档给出的 CDN 范围为 `v1-default.douyinvod.com` 至 `v50-default.douyinvod.com`。默认 WAV，视频云链路也可能转码为 MP4，必须检测实际内容，不能伪装 MP3。地址用于下载转存，不作为作品永久远程依赖。适配器每 2 秒查询、最多 150 次，支持取消；HTTPS 下载不携带 AK/SK 或 API 签名。

## 签名

[公共字段](https://docs.volcengine.com/docs/Audiovideounderstandingandprocessing/Publicfields?lang=zh)指定 service=`imagination`、region=`cn-beijing`、Host=`open.volcengineapi.com`、Content-Type=`application/json`、UTC `X-Date` 格式 `YYYYMMDDTHHMMSSZ`，使用 HMAC-SHA256 鉴权。对实际发送的 UTF-8 JSON 计算 SHA256；签名头按字典序为 `content-type;host;x-content-sha256;x-date`。凭证范围为 `日期/地域/服务/request`。

算法核对：[官方 Python SignerV4](https://github.com/volcengine/volc-sdk-python/blob/master/volcengine/auth/SignerV4.py)，以及[官方签名方法](https://docs.volcengine.com/docs/APISignatureCallGuide/Signaturemethod-9?lang=zh)。HMAC 派生依次使用 SK、日期、region、service、`request`；不增加 AWS4 前缀。测试使用虚构凭证和固定 UTC 时间，并以独立 Python 算法生成固定期望签名。

## 开通与已知文档差异

用户需在[AI 音乐控制台](https://console.volcengine.com/ai-music/product)开通“生成纯音乐”，并选择与应用相同的套餐/按量模式；[计费说明](https://docs.volcengine.com/docs/Audiovideounderstandingandprocessing/Productbilling?lang=zh)明确两种方式独立。AK/SK 来自[访问密钥管理](https://console.volcengine.com/iam/keymanage/)；[快速接入指南](https://docs.volcengine.com/docs/Audiovideounderstandingandprocessing/APIQuickAccessGuide?lang=zh)推荐有授权的子账号密钥。

较早接入指南写企业认证购买，计费页出现个人付费说明；以账户控制台当前可开通资格为准。计费页仍写旧版纯音乐 60 秒，专门的生成 API 页明确 v5.0 为 30–120 秒，代码遵循后者。API 页的示例响应 Action 有复制残留，因此代码以接口信息及 curl 中的 `GenBGM`/`GenBGMForTime` 为准。

当前验证边界：完成签名与请求/轮询/下载的模拟契约测试，不声称已通过真实服务账单或模型效果测试。
