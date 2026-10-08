# 国内音乐 API 配置与首次实测

核验日期：2026-10-08。App 已按官方协议适配；模拟接口测试不代表你的账号已开通，也不代表真实模型效果已经验证。下一步是在 App 内保存自己的凭证，完成一次小规模生成。

从官方配置步骤看，建议先试 **腾讯云 TokenHub**：只需一项 API Key，并有明确的纯音乐调用说明。已有火山 AI 音乐权限时也可直接用火山；阿里云 Fun-Music 需先通过邀测申请。

| 服务 | 在 App 中填写 | 首次生成时长 | 开通要求 |
| --- | --- | --- | --- |
| 腾讯云 TokenHub | TokenHub API Key、音乐模型 | 可先选 15 或 30 秒作为目标；实际可能更长 | 开通 TokenHub 及所选音乐模型后付费 |
| 火山引擎 AI 音乐 | Access Key ID、Secret Access Key、计费方式 | 先选 30 秒 | 开通「生成纯音乐」，计费方式与控制台一致 |
| 阿里云百炼 Fun-Music | 北京地域 API Key、Workspace ID、音乐模型 | 可先选 15 或 30 秒作为目标；实际可能更长 | 北京地域、模型邀测通过、空间与 Key 对应 |

凭证只填写在桌面 App 的「设置与生成服务」中，无需设置终端环境变量，也不要把完整密钥发进聊天或截图。

## 1. 腾讯云 TokenHub：建议先测试

1. 登录腾讯云并开通 TokenHub，在 [TokenHub 密钥管理](https://console.cloud.tencent.com/tokenhub/apikey)创建 API Key。
2. 打开[在线推理 → 语音模型](https://console.cloud.tencent.com/tokenhub/inference?serviceType=SPEECH)，为 MiniMax Music v3.0 或 v2.6 开通后付费，并确认账户可用额度。
3. 在 App 设置中选择腾讯云 TokenHub，填入该平台 API Key，选择已开通的模型并保存。首次建议选择 v3.0；只有 v2.6 权限时选 v2.6。
4. 回到创作工作台，把「生成引擎」切换到腾讯云，选一段下方提示词，点击生成。

这里需要的是 **TokenHub API Key**，不能填写腾讯云普通 SecretId/SecretKey，也不能填写 MiniMax 官网的 Key。官方支持的模型 ID 是 `minimax-music-v3.0` 和 `minimax-music-v2.6`，App 请求无人声模式。[腾讯云官方音乐生成文档](https://cloud.tencent.cn/document/product/1823/135323)

腾讯接口没有独立的精确时长参数，15/30 秒会作为描述要求发送。请以生成后播放器显示的实际时长为准；选择短目标不等于服务端一定按短片段生成或计费。

## 2. 火山引擎 AI 音乐

1. 登录[AI 音乐控制台](https://console.volcengine.com/ai-music/product)，查看当前账号能否开通「生成纯音乐」。按页面提示完成认证、权限和计费配置。
2. 在[访问密钥管理](https://console.volcengine.com/iam/keymanage/)创建或取得有该服务权限的 AK/SK。可使用已授权的子账号；这里不用方舟聊天模型 API Key。[官方快速接入指南](https://docs.volcengine.com/docs/Audiovideounderstandingandprocessing/APIQuickAccessGuide?lang=zh)
3. 在 App 的火山引擎设置中填写 Access Key ID 和 Secret Access Key，并选择与控制台相同的计费方式：购买套餐对应预付费；开通按量计费对应后付费。App 不会自动替你切换收费方式。[官方计费说明](https://docs.volcengine.com/docs/Audiovideounderstandingandprocessing/Productbilling?lang=zh)
4. 选择火山引擎生成，首次设为 **30 秒**，使用中文音乐描述。

当前专门的纯音乐 API 文档使用 v5.0，支持 **30–120 秒**；不要照旧资料测试 15 秒。较早接入指南提到企业认证，当前计费资料又有个人账号说明，因此是否可开通以你的控制台为准，不承诺所有账号均可直接使用。[当前纯音乐 API](https://docs.volcengine.com/docs/Audiovideounderstandingandprocessing/Generatepuremusic?lang=zh)

## 3. 阿里云百炼 Fun-Music

1. 进入百炼控制台，切换到 **华北2（北京）**，在模型广场申请 Fun-Music 邀测。先确认所选模型已经获批，再测试 App；普通百炼聊天模型能用，不代表音乐模型已授权。[Fun-Music 官方使用指南](https://help.aliyun.com/zh/model-studio/fun-music)
2. 在该地域创建 API Key，并取得对应业务空间的 Workspace ID。Key、空间和地域必须匹配。[获取 API Key](https://help.aliyun.com/zh/model-studio/get-api-key)、[业务空间与接入域名说明](https://help.aliyun.com/zh/model-studio/regions)
3. 在 App 的阿里云设置中填入 API Key 与 Workspace ID。Workspace ID 填空间标识本身，不要填整个网址或空间显示名称。选择已获批的 `fun-music-preview` 或 `fun-music-v1`，保存设置。
4. 在工作台选择阿里云，先提交一段简短描述。两个模型均支持纯音乐；当前接口没有精确时长控制字段，App 通过描述表达目标时长，并保留实际返回的音频。[Fun-Music API 参数](https://help.aliyun.com/zh/model-studio/fun-music-api)

## 三段可直接测试的描述

**青春日常**：阳光下的校园午后，青春欢快，轻盈钢琴、温暖贝斯和柔和鼓点，约 112 BPM，适合日常 Vlog，纯音乐，无人声，不要突然变得很响。

**午后专注**：安静的咖啡馆，温暖木吉他与稀疏钢琴，约 82 BPM，轻柔鼓点，旋律克制，适合阅读，纯音乐，无人声。

**温柔叙事**：夜晚城市里的温柔电影配乐，钢琴主旋律、缓慢铺开的合成器和低音，约 88 BPM，略带忧郁但有希望，纯音乐，无人声，结尾自然收束。

这些是音乐方向，不是模型必须精确遵守的数值约束。先测试一段，确认连通和效果，再提交另外两段。

## 首次实测顺序

1. 先选本地引擎生成 15 秒，确认扬声器、播放暂停和 WAV 导出正常。
2. 在设置中保存一个服务的凭证。**保存成功只代表已保存配置**，第一次生成才会验证该账号的真实访问权限。
3. 腾讯或阿里先设 15/30 秒目标；火山设 30 秒。只点击一次生成，等待完成。
4. 成功后确认：听得到声音、没有意外人声、实际时长可见、作品出现在「我的作品」、导出的音频能重新播放。再到服务商控制台核对一次调用与用量。
5. 若要反馈问题，记录服务名称、模型、发生时间、App 错误文字及服务商请求编号；不要附完整密钥。鉴权错误优先查凭证类型，权限错误优先查模型开通、地域与计费状态。

三家云端输出都是已经混合好的音乐，App 不会把它们伪装成可独立调整的四条乐器轨道。主音量和播放操作用于本地试听；更改音色、风格、速度等后点击重新生成，会发起新的计费请求。循环、BPM、调性和音色描述均需听实际结果判断，不能保证每次严格一致。

取消会停止 App 等待，但已提交的云端任务仍可能完成并计费。遇到超时或服务端错误，先检查服务商调用记录再手动重试；App 不自动重发生成请求。具体费用与使用额度以各平台当前控制台为准。
