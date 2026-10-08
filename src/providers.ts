import type { AudioFormat, CloudProvider, Provider, ProviderStatuses } from './types';
export const EMPTY_PROVIDER_STATUSES: ProviderStatuses = {tencent:{configured:false},volcengine:{configured:false},aliyun:{configured:false},elevenlabs:{configured:false}};
export const CLOUD_PROVIDERS: {id:CloudProvider;name:string;shortName:string;description:string;requirement:string;durationNote:string;models:{id:string;name:string}[];docs:string;console:string}[] = [
  {id:'tencent',name:'腾讯云 TokenHub',shortName:'腾讯云 · MiniMax 音乐',description:'MiniMax Music v3.0 / v2.6 · 纯音乐生成',requirement:'开通 TokenHub，并在语音模型中开启所选音乐模型的后付费。使用 TokenHub API Key。',durationNote:'时长是提示词目标，实际长度由模型决定；按服务商整段输出计费。',models:[{id:'minimax-music-v3.0',name:'MiniMax Music v3.0'},{id:'minimax-music-v2.6',name:'MiniMax Music v2.6'}],docs:'https://cloud.tencent.cn/document/product/1823/135323',console:'https://console.cloud.tencent.com/tokenhub'},
  {id:'volcengine',name:'火山引擎 AI 音乐',shortName:'火山引擎 · 豆包音乐',description:'纯音乐 v5.0 · 30–120 秒',requirement:'开通「AI 音乐生成」服务及对应计费方式，配置有音乐权限的 Access Key ID / Secret Access Key。',durationNote:'支持 30–120 秒；请选择与你控制台开通项目一致的计费方式。',models:[],docs:'https://docs.volcengine.com/docs/Audiovideounderstandingandprocessing/Generatepuremusic?lang=zh',console:'https://console.volcengine.com/ai-music/product'},
  {id:'aliyun',name:'阿里云百炼 Fun-Music',shortName:'阿里云 · Fun-Music',description:'Fun-Music · 需申请邀测',requirement:'先获批 Fun-Music 邀测权限，再准备北京地域百炼 API Key 和该业务空间的 Workspace ID。',durationNote:'时长是提示词目标，模型返回长度可能不同；以实际输出计费。',models:[{id:'fun-music-preview',name:'Fun-Music Preview'},{id:'fun-music-v1',name:'Fun-Music v1'}],docs:'https://help.aliyun.com/zh/model-studio/fun-music',console:'https://bailian.console.aliyun.com/'},
  {id:'elevenlabs',name:'ElevenLabs Music',shortName:'ElevenLabs · AI',description:'海外服务 · 纯音乐生成',requirement:'使用 ElevenLabs API Key，并确认账户拥有 Music API 权限和可用额度。',durationNote:'通过接口传入目标时长；音频播放与作品库显示实际时长。',models:[{id:'music_v1',name:'Music v1'},{id:'music_v2',name:'Music v2'},{id:'music_v2_5',name:'Music v2.5'}],docs:'https://elevenlabs.io/docs/api-reference/music/compose',console:'https://elevenlabs.io/app/settings/api-keys'},
];
export function providerName(provider:Provider){return provider==='local'?'本地作曲':CLOUD_PROVIDERS.find(p=>p.id===provider)?.name??'AI 音乐';}
export function originalFormat(mimeType:string):AudioFormat {
  if(['audio/wav','audio/x-wav','audio/wave'].includes(mimeType))return 'wav';
  if(['audio/mp4','video/mp4','audio/x-m4a'].includes(mimeType))return 'm4a';
  if(['audio/flac','audio/x-flac'].includes(mimeType))return 'flac';
  if(['audio/mpeg','audio/mp3'].includes(mimeType))return 'mp3';
  throw new Error('此音频原始格式不支持直接导出，请选择导出 WAV。');
}
