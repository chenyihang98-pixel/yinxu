# MiniMax / 腾讯云 TokenHub 音乐接口核验

核验日期：2026-10-08。仅查阅官方文档；未使用真实密钥，也未调用计费接口。

## 采用腾讯云 TokenHub

[腾讯云官方音乐生成文档](https://cloud.tencent.cn/document/product/1823/135323)（页面更新时间：2026-09-24）确认这是音乐生成接口，支持无人声模式。接入要求是腾讯云账号、已开通 TokenHub、该平台 API Key，以及在「在线推理 → 语音模型」开通所选音乐模型的后付费；不能用腾讯云 SecretId/SecretKey 或 MiniMax 官方 Key 替代。

- 地址：`POST https://tokenhub.tencentmaas.com/v1/wand/minimax-music/generation`。
- 鉴权：`Authorization: Bearer <TokenHub API Key>`；JSON 请求体。
- 模型：`minimax-music-v3.0`（默认）、`minimax-music-v2.6`。
- 请求：`prompt` 为 1–2000 字符，`is_instrumental:true`，`lyrics_optimizer:false`，不传歌词，`output_format:"hex"`，`audio_setting:{sample_rate:44100,bitrate:256000,format:"mp3"}`。
- 同步返回，无任务创建或轮询。成功需 HTTP 200、`base_resp.status_code===0`、`data.status===2`；`data.audio` 是 hex 音频。必须先验证长度与字符再解码，并验证音频格式。`extra_info.music_duration` 单位为毫秒。
- 文档没有 `duration`、`seed`、`bpm` 或 `key` 数值控制字段；这些只能放进描述，不能承诺精准时长或旋律种子复现。App 保留完整服务端音频并使用实际音频时长。
- 文档也支持 URL 输出，链接有效期为 12 小时；本适配器选 hex，避免额外下载和链接失效。取消只终止客户端等待，不能保证已提交任务不计费。不自动重试生成请求。

价格与可用额度以腾讯云账号所选模型的后付费页面为准；上述接口文档未给出可据以报价的固定单价。模型开通、余额、地区和账号权限最终需用户自己的 TokenHub Key 实测。

## 不采用 MiniMax 直连作为新用户默认入口

[MiniMax 音乐 API 官方文档](https://platform.minimax.cn/docs/api-reference/music-generation)以及[官方使用指南](https://platform.minimax.cn/docs/guides/music-generation)均声明：2026-08-20 起，直连付费音乐 API 不再接纳新用户，历史付费账号可继续使用；免费音乐模型已经停用。模型枚举中仍残留 free/M Plan 旧说明，应以页面顶部的服务调整通知为准。

当前直连接口地址是 `https://api.minimax.cn/v1/music_generation`，模型名为 `music-3.0` / `music-2.6`，与腾讯云的地址、密钥及模型 ID 均不同。旧 `platform.minimaxi.com` 文档会跳转到 `platform.minimax.cn`。本轮不交付第四个直连入口，也不引导用户为不可用的新账号音乐 API 购买旧套餐。

核验补充：网页读取器未能获取腾讯云正文时，使用普通 HTTPS GET 获取同一官方页面 HTML；MiniMax 的 `.md` 页面包含完整 OpenAPI schema，未发现可直接控制时长或 seed 的请求参数。
