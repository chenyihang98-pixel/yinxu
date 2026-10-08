import { useCallback, useEffect, useRef, useState } from "react";
import {
  AudioLines,
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Cloud,
  Disc3,
  FolderOpen,
  Heart,
  Headphones,
  LayoutGrid,
  Library,
  ListMusic,
  LoaderCircle,
  Mic2,
  MoreHorizontal,
  Music2,
  Pause,
  Piano,
  Play,
  Plus,
  RefreshCw,
  Repeat2,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Shuffle,
  SkipBack,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Upload,
  Volume2,
  Waves,
  X,
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type {
  MusicConfig,
  Project,
  RenderResult,
  TrackName,
  Mood, Provider, ProviderStatuses, AudioFormat,
} from "./types";
import {
  DEFAULT_CONFIG,
  MOODS,
  INSTRUMENTS,
  planFromPrompt,
  refineFromPrompt,
} from "./composer";
import { renderMusic, mixStems, encodeWav, computePeaks } from "./audio/engine";
import {
  listProjects,
  saveProject,
  deleteProject,
  exportProject,
  importProject,
} from "./storage";
import { Cover, IconButton, Modal, Slider, timeLabel } from "./components";
import { usePlayer } from "./usePlayer";
import ProviderSettings from "./ProviderSettings";
import {CLOUD_PROVIDERS, EMPTY_PROVIDER_STATUSES, providerName, originalFormat} from "./providers";

type Page = "studio" | "library" | "inspiration";
const initialPrompt =
  "阳光下的校园午后，青春、欢快，带一点轻盈的钢琴，适合日常 Vlog。";
const inspirations: {
  title: string;
  subtitle: string;
  prompt: string;
  mood: Mood;
  label: string;
}[] = [
  {
    title: "把夏天，按下播放",
    subtitle: "青春 · 轻快 · 日常 Vlog",
    prompt: initialPrompt,
    mood: "bright",
    label: "SUMMER DIARY",
  },
  {
    title: "一杯咖啡的时间",
    subtitle: "Lo-fi · 慵懒 · 咖啡馆",
    prompt: "慵懒的 Lo-fi 爵士，温暖的电钢琴与柔和鼓点，适合咖啡馆和雨天放松。",
    mood: "chill",
    label: "SLOW AFTERNOON",
  },
  {
    title: "故事，即将展开",
    subtitle: "电影感 · 宏大 · 叙事",
    prompt:
      "富有电影感的史诗背景音乐，低沉的铺底，逐渐变得有力量，适合游戏探索。",
    mood: "cinematic",
    label: "BEYOND THE FRAME",
  },
  {
    title: "掉进一场好梦",
    subtitle: "空灵 · 梦幻 · 冥想",
    prompt: "梦幻空灵的氛围音乐，稀疏的钟琴和绵长的混响，像漂浮在星空中。",
    mood: "dreamy",
    label: "SOFT ORBIT",
  },
  {
    title: "只剩下心流",
    subtitle: "专注 · 极简 · 工作",
    prompt:
      "平静的极简背景音乐，柔和钢琴，不要鼓点，不要抢耳的旋律，适合阅读和专注。",
    mood: "focus",
    label: "IN THE FLOW",
  },
  {
    title: "午夜的像素城市",
    subtitle: "复古 · 合成器 · 游戏",
    prompt:
      "复古的电子合成器音乐，像素游戏里的霓虹城市，律动清晰，适合循环播放。",
    mood: "retro",
    label: "AFTER HOURS",
  },
];
const tracks: {
  id: TrackName;
  label: string;
  english: string;
  icon: LucideIcon;
  color: string;
}[] = [
  {
    id: "melody",
    label: "旋律",
    english: "MELODY",
    icon: Piano,
    color: "#b4a1fa",
  },
  {
    id: "chords",
    label: "和声",
    english: "HARMONY",
    icon: Waves,
    color: "#7bafa5",
  },
  {
    id: "bass",
    label: "贝斯",
    english: "BASS",
    icon: AudioLines,
    color: "#d3ac76",
  },
  {
    id: "drums",
    label: "鼓组",
    english: "DRUMS",
    icon: Disc3,
    color: "#c18aab",
  },
];
const defaultPeaks = Array.from(
  { length: 128 },
  (_, i) => 0.12 + Math.abs(Math.sin(i * 1.7) * Math.sin(i * 0.11)) * 0.75,
);

export default function App() {
  const [page, setPage] = useState<Page>("studio");
  const [prompt, setPrompt] = useState(initialPrompt);
  const [config, setConfig] = useState<MusicConfig>({
    ...DEFAULT_CONFIG,
    prompt: initialPrompt,
  });
  const [provider, setProvider] = useState<Provider>("local");
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [rendered, setRendered] = useState<RenderResult | null>(null);
  const [audioBuffer, setAudioBuffer] = useState<AudioBuffer | null>(null);
  const [peaks, setPeaks] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [phase, setPhase] = useState("");
  const [reasoning, setReasoning] = useState<string[]>([]);
  const [refine, setRefine] = useState("");
  const [dirty, setDirty] = useState(false);
  const [toast, setToast] = useState("");
  const [error, setError] = useState("");
  const [modal, setModal] = useState<"settings" | "export" | "help" | null>(
    null,
  );
  const [providerStatuses,setProviderStatuses]=useState<ProviderStatuses>(EMPTY_PROVIDER_STATUSES);
  const [search, setSearch] = useState("");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [solo, setSolo] = useState<TrackName | null>(null);
  const [fade, setFade] = useState(true);
  const [exportBusy, setExportBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const token = useRef(0);
  const busyLock = useRef(false);
  const projectRef = useRef<Project | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const promptInput = useRef<HTMLTextAreaElement>(null);
  const notify = useCallback((message: string) => setToast(message), []);
  const fail = useCallback(
    (e: unknown) =>
      setError(e instanceof Error ? e.message : "操作失败，请重试。"),
    [],
  );
  const player = usePlayer(fail);
  const closeModal = useCallback(() => setModal(null), []);
  useEffect(() => {
    void listProjects().then(setProjects).catch(fail);
    if (window.museDesktop)
      void window.museDesktop
        .getSettings()
        .then((s) => setProviderStatuses(s.providers ?? {...EMPTY_PROVIDER_STATUSES,elevenlabs:{configured:s.hasApiKey}}))
        .catch(fail);
  }, [fail]);
  useEffect(() => {
    projectRef.current = project;
  }, [project]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 3800);
    return () => clearTimeout(timer);
  }, [toast]);
  const persist = async (next: Project) => {
    setSaving(true);
    try {
      await saveProject(next);
      setSaveFailed(false);
      setProjects((prev) =>
        [next, ...prev.filter((p) => p.id !== next.id)].sort((a, b) =>
          b.updatedAt.localeCompare(a.updatedAt),
        ),
      );
    } catch (e) {
      setSaveFailed(true);
      throw e;
    } finally {
      setSaving(false);
    }
  };
  const decode = async (blob: Blob) => {
    const context = new AudioContext();
    try {
      return await context.decodeAudioData(await blob.arrayBuffer());
    } finally {
      void context.close();
    }
  };
  const updateConfig = <K extends keyof MusicConfig>(
    key: K,
    value: MusicConfig[K],
  ) => {
    setConfig((c) => ({ ...c, [key]: value }));
    setDirty(!!project);
  };
  const chooseInspiration = (item: (typeof inspirations)[number]) => {
    setPrompt(item.prompt);
    const plan = planFromPrompt(item.prompt);
    setConfig(plan.config);
    setReasoning(plan.reasoning);
    setDirty(!!project);
    setPage("studio");
    promptInput.current?.focus();
  };
  const cancel = async () => {
    token.current++;
    try {
      if (provider !== "local")
        await window.museDesktop?.cancelGeneration();
      notify(
        provider !== "local"
          ? "已取消等待。已提交的云端生成可能仍会计费。"
          : "已取消本地生成",
      );
    } catch (e) {
      fail(e);
    }
  };
  const generate = async (
    mode: "new" | "variation" | "adjust" | "refine" = "new",
  ) => {
    if (busyLock.current) return;
    if (!prompt.trim()) {
      setError("先描述一下你想要的背景音乐吧。");
      promptInput.current?.focus();
      return;
    }
    if (provider !== "local" && !window.museDesktop) {
      setModal("settings");
      setError("请在 Windows 桌面版中配置并使用 AI 音乐服务。");
      return;
    }
    if (provider !== "local" && !providerStatuses[provider].configured) {
      setModal("settings");
      setError(`请先保存${providerName(provider)}的服务凭据。`);
      return;
    }
    if(provider === "volcengine" && (config.duration < 30 || config.duration > 120)){setError("火山引擎纯音乐 v5.0 支持 30–120 秒，请先调整生成时长。");return;}
    if (mode === "refine" && !refine.trim()) return;
    busyLock.current = true;
    setBusy(true);
    setProgress(0);
    setError("");
    player.pause();
    setSolo(null);
    const job = ++token.current;
    try {
      const seed =
        mode === "adjust" || mode === "refine"
          ? config.seed
          : Math.floor(Math.random() * 2147483647);
      const plan = refineFromPrompt(
        { ...config, prompt, seed },
        mode === "refine" ? refine : "",
      );
      const nextConfig = plan.config;
      if (
        mode === "refine" &&
        provider === "local" &&
        JSON.stringify(nextConfig) ===
          JSON.stringify({ ...config, prompt, seed })
      )
        throw new Error(
          "这条描述没有改变当前参数。可以试试“慢一点”“换成吉他”“减少混响”“不要鼓点”，或直接调整右侧滑杆。",
        );
      setReasoning(
        mode === "refine"
          ? plan.reasoning
          : [
              `采用「${MOODS.find((m) => m.id === nextConfig.mood)?.label}」风格`,
              `${nextConfig.bpm} BPM · ${nextConfig.key}`,
              `主奏使用${INSTRUMENTS.find((i) => i.id === nextConfig.instrument)?.label}`,
              nextConfig.loop ? "循环片段，适合连续播放" : "自然收尾",
            ],
      );
      setPhase(
        provider === "local"
          ? "正在编排旋律与和声"
          : `正在向${providerName(provider)}提交创作`,
      );
      let nextBuffer: AudioBuffer;
      let nextRender: RenderResult | null = null;
      let audioBlob: Blob | undefined;
      if (provider === "local") {
        nextRender = await renderMusic(nextConfig, (p) => {
          if (job !== token.current)
            throw new DOMException("已取消", "AbortError");
          setProgress(p > 1 ? p : p * 100);
          setPhase("正在合成旋律、和声、贝斯与鼓组");
        });
        nextBuffer = nextRender.buffer;
      } else {
        const cloudPrompt = [
          nextConfig.prompt,
          `请生成无歌词、无人声的纯音乐背景配乐。氛围：${MOODS.find(m=>m.id===nextConfig.mood)?.label}。当前编曲参数优先：${nextConfig.bpm} BPM，${nextConfig.key}，主奏${INSTRUMENTS.find(i=>i.id===nextConfig.instrument)?.label}。能量${Math.round(nextConfig.energy*100)}%，丰富度${Math.round(nextConfig.complexity*100)}%，混响${Math.round(nextConfig.reverb*100)}%。`,
          ...tracks.map(t=>nextConfig.volumes[t.id]===0?`不要${t.label}。`:`${t.label}相对突出程度${Math.round(nextConfig.volumes[t.id]*100)}%。`),
          nextConfig.loop?'适合循环使用，头尾自然衔接。':'自然收尾。',
          mode==='refine'?`本次追加调整：${refine}`:'',
        ].filter(Boolean).join('\n');
        setPhase("AI 正在创作，通常需要数十秒至数分钟");
        const result = await window.museDesktop!.generateMusic({
          provider,
          prompt: cloudPrompt,
          duration: nextConfig.duration,
        });
        audioBlob = new Blob([result.audio], { type: result.mimeType });
        nextBuffer = await decode(audioBlob);
      }
      if (job !== token.current) return;
      const now = new Date().toISOString();
      const next: Project = {
        id: crypto.randomUUID(),
        title: mode === "new" || !project ? plan.title : project.title,
        createdAt: now,
        updatedAt: now,
        config: nextConfig,
        provider,
        favorite: false,
        revision: mode === "new" ? 1 : (project?.revision ?? 0) + 1,
        tags: plan.tags,
        audioBlob,
        audioDuration:nextBuffer.duration,
      };
      setProject(next);
      setConfig(nextConfig);
      setPrompt(nextConfig.prompt);
      setRendered(nextRender);
      setAudioBuffer(nextBuffer);
      setPeaks(nextRender?.peaks ?? computePeaks(nextBuffer));
      player.load(nextBuffer);
      setDirty(false);
      setRefine("");
      setPhase("已完成");
      setProgress(100);
      try {
        await persist(next);
        notify("创作完成，已保存到「我的作品」");
      } catch (e) {
        fail(
          new Error(
            `音乐已生成，但保存失败：${e instanceof Error ? e.message : "存储空间不可用"}。请先导出音乐。`,
          ),
        );
      }
    } catch (e) {
      if (
        job === token.current &&
        !(e instanceof DOMException && e.name === "AbortError")
      )
        fail(e);
    } finally {
      busyLock.current = false;
      setBusy(false);
    }
  };
  const openProject = async (item: Project) => {
    if (busyLock.current) return;
    busyLock.current = true;
    setBusy(true);
    setError("");
    setProgress(0);
    setPage("studio");
    player.pause();
    const job = ++token.current;
    try {
      setPhase("正在打开作品");
      let result: RenderResult | null = null;
      let buffer: AudioBuffer;
      if (item.provider === "local") {
        result = await renderMusic(item.config, (p) => {
          if (job !== token.current)
            throw new DOMException("已取消", "AbortError");
          setProgress(p > 1 ? p : p * 100);
        });
        buffer = result.buffer;
      } else {
        if (!item.audioBlob) throw new Error("这首作品的音频文件不可用。");
        buffer = await decode(item.audioBlob);
      }
      if (job !== token.current) return;
      const opened={...item,audioDuration:buffer.duration};
      setProject(opened);
      projectRef.current=opened;
      setSaveFailed(false);
      setPrompt(item.config.prompt);
      setConfig(item.config);
      setProvider(item.provider);
      setRendered(result);
      setAudioBuffer(buffer);
      setPeaks(result?.peaks ?? computePeaks(buffer));
      player.load(buffer);
      setDirty(false);
      setSolo(null);
      setReasoning([]);
      // A metadata write failure must not leave the previous audio loaded.
      if(item.audioDuration!==buffer.duration)await persist(opened);
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) fail(e);
    } finally {
      busyLock.current = false;
      setBusy(false);
    }
  };
  const changeMix = async (name: TrackName, value: number) => {
    if (!rendered || !project) return;
    const volumes = { ...config.volumes, [name]: value };
    const nextConfig = { ...config, volumes };
    setConfig(nextConfig);
    setSolo(null);
    const mixed = mixStems(rendered.stems, volumes);
    setAudioBuffer(mixed);
    setPeaks(computePeaks(mixed));
    player.load(mixed, true);
    const next = {
      ...project,
      config: { ...project.config, volumes },
      updatedAt: new Date().toISOString(),
    };
    setProject(next);
    try {
      await persist(next);
    } catch (e) {
      fail(e);
    }
  };
  const toggleSolo = (name: TrackName) => {
    if (!rendered) return;
    const next = solo === name ? null : name;
    setSolo(next);
    const volumes = { ...config.volumes };
    if (next)
      tracks.forEach((t) => {
        if (t.id !== next) volumes[t.id] = 0;
      });
    const mixed = mixStems(rendered.stems, volumes);
    setAudioBuffer(mixed);
    setPeaks(computePeaks(mixed));
    player.load(mixed, true);
  };
  const favorite = async (item: Project) => {
    const current =
      projectRef.current?.id === item.id ? projectRef.current : item;
    const next = { ...current, favorite: !current.favorite };
    setProject((p) =>
      p?.id === item.id ? { ...p, favorite: next.favorite } : p,
    );
    try {
      await persist(next);
    } catch (e) {
      fail(e);
    }
  };
  const remove = async (item: Project) => {
    try {
      await deleteProject(item.id);
      setProjects((p) => p.filter((i) => i.id !== item.id));
      notify("作品已删除");
      if (projectRef.current?.id === item.id) {
        setProject(null);
        setAudioBuffer(null);
        setRendered(null);
        setPeaks([]);
        player.pause();
      }
    } catch (e) {
      fail(e);
    }
  };
  const saveFile = async (
    name: string,
    data: ArrayBuffer,
    format: AudioFormat | "json",
  ) => {
    if (window.museDesktop) {
      const result = await window.museDesktop.saveAudio({ name, data, format });
      if (result.saved) notify("已导出到选定位置");
      return result.saved;
    }
    const url = URL.createObjectURL(
      new Blob([data], {
        type:
          format === "wav"
            ? "audio/wav"
            : format === "mp3"
              ? "audio/mpeg"
              : format === "m4a" ? "audio/mp4" : format === "flac" ? "audio/flac" : "application/json",
      }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name}.${format}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notify("已开始下载");
    return true;
  };
  const exportAudio = async (
    format: "wav" | "original" | "json",
    stem?: TrackName,
  ) => {
    if (!project || !audioBuffer) return;
    setExportBusy(true);
    setError("");
    try {
      if (format === "json") {
        await saveFile(
          project.title,
          new TextEncoder().encode(exportProject(project)).buffer,
          "json",
        );
      } else if (format === "original") {
        if (project.audioBlob)
          await saveFile(
            project.title,
            await project.audioBlob.arrayBuffer(),
            originalFormat(project.audioBlob.type),
          );
      } else {
        let buffer =
          stem && rendered
            ? mixStems(
                rendered.stems,
                Object.fromEntries(
                  tracks.map((t) => [
                    t.id,
                    t.id === stem ? project.config.volumes[t.id] : 0,
                  ]),
                ) as Record<TrackName, number>,
              )
            : audioBuffer;
        if (fade && !project.config.loop) {
          const copy = new AudioBuffer({
            length: buffer.length,
            numberOfChannels: buffer.numberOfChannels,
            sampleRate: buffer.sampleRate,
          });
          for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
            const src = buffer.getChannelData(ch),
              dest = copy.getChannelData(ch);
            const n = Math.min(buffer.sampleRate, buffer.length / 3);
            for (let i = 0; i < src.length; i++)
              dest[i] = src[i] * Math.min(1, i / n, (src.length - 1 - i) / n);
          }
          buffer = copy;
        }
        await saveFile(
          `${project.title}${stem ? `-${tracks.find((t) => t.id === stem)?.label}` : ""}`,
          encodeWav(buffer),
          "wav",
        );
      }
    } catch (e) {
      fail(e);
    } finally {
      setExportBusy(false);
    }
  };
  const importFile = async (file?: File) => {
    if (!file) return;
    try {
      if (file.size > 1024 * 1024) throw new Error("工程文件不能超过 1 MB。");
      const item = importProject(await file.text());
      await persist(item);
      await openProject(item);
      notify("工程已导入");
    } catch (e) {
      fail(e);
    } finally {
      if (fileInput.current) fileInput.current.value = "";
    }
  };
  const rename = async (title: string) => {
    if (!project || !title.trim()) return;
    const next = { ...project, title: title.trim().slice(0, 64) };
    setProject(next);
    setSaving(true);
    try {
      await persist(next);
    } catch (e) {
      fail(e);
    } finally {
      setSaving(false);
    }
  };
  const newProject = () => {
    if (busy) return;
    setProject(null);
    projectRef.current=null;
    setSaveFailed(false);
    setRendered(null);
    setAudioBuffer(null);
    setPeaks([]);
    setPrompt("");
    setConfig({ ...DEFAULT_CONFIG, prompt: "" });
    setReasoning([]);
    setDirty(false);
    setPage("studio");
    player.pause();
    setTimeout(() => promptInput.current?.focus(), 0);
  };
  const filtered = projects.filter(
    (p) =>
      (!favoritesOnly || p.favorite) &&
      `${p.title} ${p.config.prompt} ${p.tags.join(" ")}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const moodName = MOODS.find((m) => m.id === config.mood)?.label ?? "青春欢快";

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button
          className="brand"
          onClick={() => setPage("studio")}
          aria-label="音序 Muse 首页"
        >
          <div className="brand-icon">
            <AudioLines size={23} />
          </div>
          <span>
            音序 <b>Muse</b>
            <small>MAKE YOUR MOMENT SOUND.</small>
          </span>
        </button>
        <button className="new-button" onClick={newProject} disabled={busy}>
          <Plus size={17} /> 新建创作 <kbd>＋</kbd>
        </button>
        <div className="nav-caption">工作空间</div>
        <nav>
          {(
            [
              { id: "studio", label: "创作工作台", icon: LayoutGrid },
              { id: "library", label: "我的作品", icon: Library },
              { id: "inspiration", label: "灵感库", icon: Sparkles },
            ] as const
          ).map((n) => (
            <button
              key={n.id}
              className={`nav-item ${page === n.id ? "selected" : ""}`}
              onClick={() => setPage(n.id)}
            >
              <n.icon size={18} />
              {n.label}
              {n.id === "library" && projects.length > 0 ? (
                <span className="nav-count">{projects.length}</span>
              ) : null}
              {page === n.id && <i />}
            </button>
          ))}
        </nav>
        <div className="sidebar-divider" />
        <div className="nav-caption">
          最近创作{" "}
          <span>
            {projects.length ? `${Math.min(projects.length, 4)} 首` : ""}
          </span>
        </div>
        <div className="recent-list">
          {projects.slice(0, 4).map((p) => (
            <button
              key={p.id}
              disabled={busy}
              onClick={() => void openProject(p)}
              className={p.id === project?.id ? "current" : ""}
            >
              <Music2 size={15} />
              <span>{p.title}</span>
              <small>v{p.revision}</small>
            </button>
          ))}
          {!projects.length && (
            <p>
              下一段好音乐，
              <br />
              从你的第一句灵感开始。
            </p>
          )}
        </div>
        <div className="sidebar-bottom">
          <div className="local-note">
            <span className="status-dot" />
            <div>
              灵感随时，创作随地<small>本地作曲无需联网</small>
            </div>
            <Waves size={19} />
          </div>
          <button className="nav-item" onClick={() => setModal("settings")}>
            <Settings2 size={18} />
            设置与生成服务
          </button>
          <button className="nav-item" onClick={() => setModal("help")}>
            <CircleHelp size={18} />
            使用指南 <span className="version">v0.2</span>
          </button>
          <div className="sidebar-footer">
            MADE FOR YOUR CREATIVE FLOW <span>↗</span>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div>
            <span className="breadcrumb">工作空间</span>
            <ChevronRight size={13} />
            <span>
              {page === "studio"
                ? "创作工作台"
                : page === "library"
                  ? "我的作品"
                  : "灵感库"}
            </span>
          </div>
          <div className="topbar-right">
            <span className="engine-status">
              <span className="status-dot" />
              {provider === "local" ? "本地引擎已就绪" : `${providerName(provider)} · ${providerStatuses[provider].configured?"已配置":"待配置"}`}
            </span>
            <div className="topbar-separator" />
            <button
              className="avatar"
              onClick={() => setModal("settings")}
              aria-label="打开设置"
            >
              M
            </button>
          </div>
        </header>
        <main>
          {page === "studio" && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">YOUR IDEAS. YOUR SOUND.</div>
                  <h1>
                    让灵感，自带 <em>BGM。</em>
                  </h1>
                  <p>描述脑海中的画面，把情绪写成音乐。</p>
                </div>
                <div className="heading-decoration">
                  <AudioLines />
                  <span>
                    LESS FRICTION.
                    <br />
                    MORE CREATION.
                  </span>
                </div>
              </div>
              <div className="creation-grid">
                <section className="prompt-card panel">
                  <div className="section-title">
                    <div>
                      <span className="number-label">01</span>
                      <h2>你想听见什么？</h2>
                    </div>
                    <span className="subtle-tag">
                      <Mic2 size={12} /> 纯音乐 · 无人声
                    </span>
                  </div>
                  <div className="prompt-input-wrap">
                    <textarea
                      ref={promptInput}
                      maxLength={1500}
                      value={prompt}
                      onChange={(e) => {
                        const value = e.target.value;
                        setPrompt(value);
                        const plan = planFromPrompt(value, {
                          duration: config.duration,
                          loop: config.loop,
                        });
                        setConfig({ ...plan.config, prompt: value });
                        setDirty(!!project);
                      }}
                      placeholder="比如：青春、欢快，像夏天骑车经过海边。想要轻盈的钢琴和一点鼓点……"
                      aria-label="音乐描述"
                      disabled={busy}
                    />
                    <div className="prompt-input-footer">
                      <span>
                        <Sparkles size={12} /> 场景、情绪、乐器，都可以告诉我
                      </span>
                      <span>{prompt.length} / 1500</span>
                    </div>
                  </div>
                  <div className="mood-picker">
                    <span className="field-caption">氛围</span>
                    {MOODS.map((m) => (
                      <button
                        key={m.id}
                        disabled={busy}
                        onClick={() => {
                          const next = planFromPrompt(m.label, {
                            duration: config.duration,
                            loop: config.loop,
                          });
                          setConfig({
                            ...next.config,
                            prompt,
                            seed: config.seed,
                          });
                          setDirty(!!project);
                        }}
                        className={`mood-chip ${config.mood === m.id ? "selected" : ""}`}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                  <div className="generation-options">
                    <label>
                      {provider==="tencent"||provider==="aliyun"?"目标时长":"时长"}
                      <select
                        aria-label="生成时长"
                        value={config.duration}
                        disabled={busy}
                        onChange={(e) =>
                          updateConfig("duration", Number(e.target.value))
                        }
                      >
                        {Array.from(new Set([15, 30, 60, 120, config.duration]))
                          .filter(d=>provider!=="volcengine"||d>=30)
                          .sort((a, b) => a - b)
                          .map((d) => (
                            <option key={d} value={d}>
                              {d % 60 === 0 ? `${d / 60} 分钟` : `${d} 秒`}
                            </option>
                          ))}
                      </select>
                    </label>
                    <div className="option-divider" />
                    <label>
                      生成引擎
                      <select
                        aria-label="生成引擎"
                        value={provider}
                        disabled={busy}
                        onChange={(e) =>
                          {const next=e.target.value as Provider;setProvider(next);if(next==="volcengine"&&config.duration<30){updateConfig("duration",30);notify("火山引擎支持30–120秒，目标时长已设为30秒。");}}
                        }
                      >
                        <option value="local">本地作曲 · 免费</option>
                        {CLOUD_PROVIDERS.map(p=><option key={p.id} value={p.id}>{p.shortName}</option>)}
                      </select>
                    </label>
                    <button
                      className={`loop-option ${config.loop ? "selected" : ""}`}
                      disabled={busy}
                      onClick={() => updateConfig("loop", !config.loop)}
                      aria-pressed={config.loop}
                    >
                      <Repeat2 size={15} />
                      循环片段
                    </button>
                  </div>
                  {provider!=="local"&&<p className="engine-capability-note">{CLOUD_PROVIDERS.find(p=>p.id===provider)?.durationNote}</p>}
                  <div className="generate-row">
                    <span className="generation-footnote">
                      {provider === "local" ? (
                        <>
                          <ShieldCheck size={13} /> 离线算法作曲 · 无需密钥
                        </>
                      ) : (
                        <>
                          <Cloud size={13} /> 使用你的 API 额度，按服务商计费
                        </>
                      )}
                    </span>
                    <button
                      className="primary-button"
                      onClick={() => void generate()}
                      disabled={busy}
                    >
                      {busy ? (
                        <LoaderCircle className="spin" size={17} />
                      ) : (
                        <Sparkles size={17} />
                      )}{" "}
                      {busy ? "正在创作…" : "生成我的 BGM"}{" "}
                      {!busy && <ArrowRight size={16} />}
                    </button>
                  </div>
                </section>
                <section className="inspiration-feature">
                  <Cover mood="bright" />
                  <div className="feature-top">
                    <span>一点灵感</span>
                    <span>
                      VOL. 01 <ArrowRight size={13} />
                    </span>
                  </div>
                  <div className="feature-center">
                    <div className="feature-wordmark">
                      summer
                      <br />
                      <i>in stereo.</i>
                    </div>
                    <span className="art-caption">
                      让每个平凡瞬间，都有自己的配乐。
                    </span>
                  </div>
                  <div className="feature-bottom">
                    <div>
                      <strong>青春的第一个和弦</strong>
                      <small>轻盈钢琴 / 阳光感 / 日常 Vlog</small>
                    </div>
                    <button
                      aria-label="使用青春灵感"
                      onClick={() => chooseInspiration(inspirations[0])}
                      disabled={busy}
                    >
                      <ArrowUpRightIcon />
                    </button>
                  </div>
                </section>
              </div>
              {busy && (
                <div className="generation-progress" role="status">
                  <LoaderCircle className="spin" size={17} />
                  <span>{phase}</span>
                  {provider === "local" && (
                    <>
                      <div>
                        <i style={{ width: `${Math.min(100, progress)}%` }} />
                      </div>
                      <b>{Math.round(progress)}%</b>
                    </>
                  )}
                  <button onClick={() => void cancel()}>取消</button>
                </div>
              )}
              <div className="workbench-heading">
                <div>
                  <span className="number-label">02</span>
                  <h2>雕琢你的声音</h2>
                  <span className="heading-hint">好音乐，差一点你的偏爱。</span>
                </div>
                {project && (
                  <span className="autosave">
                    <Check size={13} />
                    {saving
                      ? "保存中"
                      : saveFailed
                        ? "保存失败，请先导出"
                        : "已保存本机"}
                  </span>
                )}
              </div>
              <div
                className={`workbench panel ${!audioBuffer ? "empty-workbench" : ""}`}
              >
                <div className="audio-editor">
                  <div className="track-heading">
                    <div className="track-art">
                      <Cover mood={config.mood} small />
                      <Music2 size={23} />
                    </div>
                    <div className="track-meta">
                      {project ? (
                        <input
                          aria-label="作品名称"
                          key={project.id}
                          defaultValue={project.title}
                          maxLength={64}
                          onBlur={(e) => {if(!e.target.value.trim()){e.target.value=project.title;setError("作品名称不能为空，已保留原名称。");return;}void rename(e.target.value);}}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") e.currentTarget.blur();
                          }}
                        />
                      ) : (
                        <h3>你的下一首好作品</h3>
                      )}
                      <p>
                        {project ? (
                          <>
                            <span className="tiny-dot" />
                            {project.provider === "local"
                              ? "本地作曲"
                              : providerName(project.provider)}
                            <span>·</span>
                            {project.config.bpm} BPM<span>·</span>
                            {project.config.key}
                            <span className="revision">
                              V{project.revision}
                            </span>
                          </>
                        ) : (
                          "从上方开始，或挑选一个灵感预设"
                        )}
                      </p>
                    </div>
                    {project && (
                      <IconButton
                        icon={Heart}
                        label={project.favorite ? "取消收藏" : "收藏作品"}
                        active={project.favorite}
                        onClick={() => void favorite(project)}
                      />
                    )}
                    <button
                      className="secondary-button export-top"
                      disabled={!audioBuffer || busy}
                      onClick={() => setModal("export")}
                    >
                      <ArrowDownToLine size={15} />
                      导出
                    </button>
                  </div>
                  <div className={`waveform ${audioBuffer ? "ready" : ""}`}>
                    <div className="waveform-bars" aria-hidden="true">
                      {(peaks.length
                        ? Array.from(
                            { length: 128 },
                            (_, i) =>
                              peaks[
                                Math.min(
                                  peaks.length - 1,
                                  Math.floor((i * peaks.length) / 128),
                                )
                              ],
                          )
                        : defaultPeaks
                      ).map((p, i) => (
                        <i
                          key={i}
                          style={{
                            height: `${Math.max(3, Math.min(100, p * 95))}%`,
                          }}
                          className={
                            audioBuffer &&
                            i / 128 <= player.position / player.duration
                              ? "played"
                              : ""
                          }
                        />
                      ))}
                    </div>
                    {audioBuffer ? (
                      <input
                        type="range"
                        min={0}
                        max={player.duration || 1}
                        step={0.01}
                        value={player.position}
                        onChange={(e) => player.seek(Number(e.target.value))}
                        aria-label="播放进度"
                      />
                    ) : (
                      <div className="waveform-empty">
                        <Headphones size={17} />
                        <span>生成后，在这里听见你的灵感</span>
                      </div>
                    )}
                    <div className="waveform-times">
                      <span>00:00</span>
                      <span>
                        {audioBuffer ? timeLabel(player.duration / 2) : "— : —"}
                      </span>
                      <span>
                        {audioBuffer
                          ? timeLabel(player.duration)
                          : timeLabel(config.duration)}
                      </span>
                    </div>
                  </div>
                  <div className="transport">
                    <div className="transport-time">
                      <strong>
                        {audioBuffer ? timeLabel(player.position) : "00:00"}
                      </strong>
                      <span>
                        /{" "}
                        {audioBuffer
                          ? timeLabel(player.duration)
                          : timeLabel(config.duration)}
                      </span>
                    </div>
                    <div className="transport-controls">
                      <IconButton
                        icon={SkipBack}
                        label="回到开头"
                        disabled={!audioBuffer || busy}
                        onClick={() => player.seek(0)}
                      />
                      <button
                        className="play-button"
                        disabled={!audioBuffer || busy}
                        onClick={() =>
                          player.playing
                            ? player.pause()
                            : void player.play().catch(fail)
                        }
                        aria-label={player.playing ? "暂停" : "播放"}
                      >
                        {player.playing ? (
                          <Pause size={19} fill="currentColor" />
                        ) : (
                          <Play size={19} fill="currentColor" />
                        )}
                      </button>
                      <IconButton
                        icon={Repeat2}
                        label="循环试听"
                        disabled={!audioBuffer}
                        active={player.loop}
                        onClick={() => player.setLoop(!player.loop)}
                      />
                    </div>
                    <div className="volume-control">
                      <Volume2 size={16} />
                      <input
                        type="range"
                        aria-label="主音量"
                        min={0}
                        max={1}
                        step={0.01}
                        value={player.volume}
                        onChange={(e) =>
                          player.setVolume(Number(e.target.value))
                        }
                      />
                    </div>
                  </div>
                  <div className="mixer-heading">
                    <span>轨道混音</span>
                    <small>
                      {project && project.provider !== "local"
                        ? "AI 成品为混合音轨，可调整主音量与导出淡入淡出"
                        : "拖动滑杆，即时调整每一层声音"}
                    </small>
                  </div>
                  <div className="mixer">
                    {tracks.map((t) => (
                      <div
                        className={`mixer-row ${config.volumes[t.id] === 0 ? "muted" : ""}`}
                        key={t.id}
                        style={
                          { "--track-color": t.color } as React.CSSProperties
                        }
                      >
                        <span className="track-icon">
                          <t.icon size={15} />
                        </span>
                        <span className="track-label">
                          {t.label}
                          <small>{t.english}</small>
                        </span>
                        <div className="mini-wave" aria-hidden="true">
                          {Array.from({ length: 26 }, (_, i) => (
                            <i
                              key={i}
                              style={{
                                height: `${18 + Math.abs(Math.sin(i * 1.8 + t.id.length)) * 65}%`,
                              }}
                            />
                          ))}
                        </div>
                        <input
                          type="range"
                          aria-label={`${t.label}音量`}
                          min={0}
                          max={1}
                          step={0.01}
                          value={config.volumes[t.id]}
                          disabled={!rendered || busy}
                          onChange={(e) =>
                            void changeMix(t.id, Number(e.target.value))
                          }
                        />
                        <span className="mix-value">
                          {Math.round(config.volumes[t.id] * 100)}
                          <small>%</small>
                        </span>
                        <button
                          className={config.volumes[t.id] === 0 ? "active" : ""}
                          title={`${t.label}静音`}
                          aria-label={`${t.label}静音`}
                          disabled={!rendered || busy}
                          onClick={() =>
                            void changeMix(
                              t.id,
                              config.volumes[t.id] === 0 ? 0.7 : 0,
                            )
                          }
                        >
                          M
                        </button>
                        <button
                          className={solo === t.id ? "active" : ""}
                          title={`${t.label}独奏`}
                          aria-label={`${t.label}独奏`}
                          disabled={!rendered || busy}
                          onClick={() => toggleSolo(t.id)}
                        >
                          S
                        </button>
                      </div>
                    ))}
                  </div>
                  <div className="refine-bar">
                    <Sparkles size={16} />
                    <input
                      aria-label="微调描述"
                      placeholder="试着说：慢一点，钢琴再温柔一些…"
                      value={refine}
                      onChange={(e) => setRefine(e.target.value)}
                      disabled={!project || busy}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void generate("refine");
                      }}
                      maxLength={400}
                    />
                    <button
                      disabled={!project || !refine.trim() || busy}
                      onClick={() => void generate("refine")}
                      aria-label="应用描述微调"
                    >
                      <ArrowRight size={17} />
                    </button>
                  </div>
                </div>
                <aside className="sound-controls">
                  <div className="controls-title">
                    <span>
                      <SlidersHorizontal size={15} /> 声音微调
                    </span>
                    <button
                      disabled={busy}
                      onClick={() => {
                        setConfig({
                          ...DEFAULT_CONFIG,
                          prompt,
                          duration: config.duration,
                          seed: config.seed,
                        });
                        setDirty(!!project);
                      }}
                      title="重置微调"
                    >
                      重置
                    </button>
                  </div>
                  <Slider
                    label="节奏速度"
                    value={config.bpm}
                    min={60}
                    max={160}
                    step={1}
                    display={`${config.bpm} BPM`}
                    onChange={(v) => updateConfig("bpm", v)}
                    disabled={busy}
                  />
                  <div className="slider-extremes">
                    <span>舒缓</span>
                    <span>轻快</span>
                  </div>
                  <div className="control-select">
                    <label htmlFor="instrument">主奏乐器</label>
                    <select
                      id="instrument"
                      value={config.instrument}
                      disabled={busy}
                      onChange={(e) =>
                        updateConfig(
                          "instrument",
                          e.target.value as MusicConfig["instrument"],
                        )
                      }
                    >
                      {INSTRUMENTS.map((i) => (
                        <option key={i.id} value={i.id}>
                          {i.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="control-select">
                    <label htmlFor="music-key">调性</label>
                    <select
                      id="music-key"
                      value={config.key}
                      disabled={busy}
                      onChange={(e) => updateConfig("key", e.target.value)}
                    >
                      {[
                        "C major",
                        "D major",
                        "G major",
                        "A minor",
                        "D minor",
                      ].map((k) => (
                        <option key={k}>{k}</option>
                      ))}
                    </select>
                  </div>
                  <div className="control-line" />
                  <Slider
                    label="情绪能量"
                    value={config.energy}
                    onChange={(v) => updateConfig("energy", v)}
                    disabled={busy}
                  />
                  <Slider
                    label="旋律丰富度"
                    value={config.complexity}
                    onChange={(v) => updateConfig("complexity", v)}
                    disabled={busy}
                  />
                  <Slider
                    label="空间混响"
                    value={config.reverb}
                    onChange={(v) => updateConfig("reverb", v)}
                    disabled={busy}
                  />
                  <button
                    className="variation-button"
                    disabled={!project || busy}
                    onClick={() => void generate("variation")}
                  >
                    <Shuffle size={13} /> 同样风格，再来一版
                  </button>
                  <button
                    className={`apply-button ${dirty ? "has-changes" : ""}`}
                    disabled={!project || busy || !dirty}
                    onClick={() => void generate("adjust")}
                  >
                    <RefreshCw size={14} />
                    {provider !== "local"
                      ? "按调整重新生成 AI 音乐"
                      : "应用调整"}
                  </button>
                  <span className="controls-hint">
                    {provider === "local"
                      ? "保留旋律种子，生成一个新版本"
                      : dirty
                        ? "重新生成将使用 API 额度"
                        : "每次调整后生成独立的新版本"}
                  </span>
                </aside>
              </div>
              {reasoning.length > 0 && (
                <div className="agent-note">
                  <Sparkles size={14} />
                  <span>
                    <strong>编曲思路</strong>
                    {reasoning.join(" · ")}
                  </span>
                </div>
              )}
              <div className="bottom-section-heading">
                <div>
                  <h2>还没有灵感？从这里开始</h2>
                  <span>为不同的画面，找到合适的声音。</span>
                </div>
                <button onClick={() => setPage("inspiration")}>
                  探索全部 <ArrowRight size={14} />
                </button>
              </div>
              <div className="preset-strip">
                {inspirations.slice(1, 5).map((item, i) => (
                  <button
                    className="mini-preset"
                    disabled={busy}
                    onClick={() => chooseInspiration(item)}
                    key={item.mood}
                  >
                    <div className="mini-cover">
                      <Cover mood={item.mood} small />
                      {i === 0 ? (
                        <Disc3 size={20} />
                      ) : i === 1 ? (
                        <Waves size={20} />
                      ) : i === 2 ? (
                        <Sparkles size={20} />
                      ) : (
                        <Headphones size={20} />
                      )}
                    </div>
                    <span>
                      <strong>{item.title}</strong>
                      <small>{item.subtitle}</small>
                    </span>
                    <ChevronRight size={15} />
                  </button>
                ))}
              </div>
            </>
          )}

          {page === "library" && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">YOUR PERSONAL SOUND LIBRARY</div>
                  <h1>
                    每一段灵感，<em>都有回响。</em>
                  </h1>
                  <p>{projects.length} 首作品，保存在这台电脑上。</p>
                </div>
                <button
                  className="secondary-button"
                  onClick={() => fileInput.current?.click()}
                >
                  <Upload size={16} />
                  导入工程
                </button>
              </div>
              <div className="library-toolbar">
                <div className="segmented">
                  <button
                    className={!favoritesOnly ? "selected" : ""}
                    onClick={() => setFavoritesOnly(false)}
                  >
                    全部作品 <span>{projects.length}</span>
                  </button>
                  <button
                    className={favoritesOnly ? "selected" : ""}
                    onClick={() => setFavoritesOnly(true)}
                  >
                    <Heart size={14} />
                    我的收藏
                  </button>
                </div>
                <div className="search-field">
                  <Search size={16} />
                  <input
                    aria-label="搜索作品"
                    placeholder="搜索名称、情绪或描述"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
              </div>
              {filtered.length ? (
                <div className="project-grid">
                  {filtered.map((p) => (
                    <article className="project-card" key={p.id}>
                      <button
                        className="project-cover"
                        disabled={busy}
                        onClick={() => void openProject(p)}
                        aria-label={`打开 ${p.title}`}
                      >
                        <Cover mood={p.config.mood} />
                        <span className="cover-label">
                          {p.provider === "local"
                            ? "LOCAL COMPOSITION"
                            : "AI GENERATED"}
                        </span>
                        <span className="cover-play">
                          <Play size={21} />
                        </span>
                        <span className="cover-duration">
                          {timeLabel(p.audioDuration??p.config.duration)}
                        </span>
                      </button>
                      <div className="project-card-body">
                        <div>
                          <h3>{p.title}</h3>
                          <IconButton
                            icon={Heart}
                            label={`收藏 ${p.title}`}
                            active={p.favorite}
                            onClick={() => void favorite(p)}
                          />
                        </div>
                        <p>
                          {p.config.bpm} BPM <span>·</span> {p.config.key}{" "}
                          <span>·</span> V{p.revision}
                        </p>
                        <div className="project-card-footer">
                          <span>
                            {new Date(p.createdAt).toLocaleDateString("zh-CN")}
                          </span>
                          <button
                            disabled={busy}
                            onClick={() => void remove(p)}
                            title="删除作品"
                            aria-label={`删除 ${p.title}`}
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="empty-library">
                  <Library size={38} />
                  <h2>
                    {search || favoritesOnly
                      ? "还没有找到作品"
                      : "你的声音收藏夹，等你填满"}
                  </h2>
                  <p>
                    {search
                      ? "换一个词试试。"
                      : "每次生成都会自动保存，随时回来继续创作。"}
                  </p>
                  <button
                    className="primary-button"
                    onClick={() => setPage("studio")}
                  >
                    <Plus size={16} />
                    开始创作
                  </button>
                </div>
              )}
            </>
          )}
          {page === "inspiration" && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">A LITTLE SPARK GOES A LONG WAY</div>
                  <h1>
                    下一段声音，<em>从这里遇见。</em>
                  </h1>
                  <p>挑一个心动的场景，再加入你自己的想象。</p>
                </div>
                <span className="subtle-tag">
                  <Sparkles size={13} />6 种灵感场景
                </span>
              </div>
              <div className="inspiration-grid">
                {inspirations.map((item, i) => (
                  <button
                    key={item.mood}
                    className="inspiration-card"
                    onClick={() => chooseInspiration(item)}
                    disabled={busy}
                  >
                    <div className="inspiration-art">
                      <Cover mood={item.mood} />
                      <span className="inspiration-number">0{i + 1}</span>
                      <span className="inspiration-label">
                        {item.label.replace(" ", "\n")}
                      </span>
                      <div className="inspiration-arrow">
                        <ArrowRight size={21} />
                      </div>
                    </div>
                    <div className="inspiration-card-text">
                      <h3>{item.title}</h3>
                      <p>{item.subtitle}</p>
                      <span>
                        以此开始创作 <ArrowRight size={14} />
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            </>
          )}
          <footer className="page-footer">
            <span>
              <AudioLines size={13} /> 音序 MUSE
            </span>
            <span>让每一个画面，都有恰到好处的声音。</span>
            <span>DESIGNED FOR CREATORS</span>
          </footer>
        </main>
      </div>
      <input
        ref={fileInput}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={(e) => void importFile(e.target.files?.[0])}
      />
      {error && (
        <div className="error-toast" role="alert">
          <span>{error}</span>
          <IconButton
            icon={X}
            label="关闭错误提示"
            onClick={() => setError("")}
          />
        </div>
      )}
      {toast && (
        <div className="toast" role="status">
          <Check size={16} />
          {toast}
        </div>
      )}
      {modal === "settings" && (
        <Modal title="设置与生成服务" onClose={closeModal}>
          <div className="settings-intro">
            <div className="settings-symbol">
              <AudioLines size={26} />
            </div>
            <div>
              <strong>给灵感，更多可能。</strong>
              <p>本地随时创作，也可以连接 AI 音乐服务。</p>
            </div>
          </div>
          <div className="service-card">
            <div className="service-heading">
              <span>
                <Zap size={19} />
                本地作曲引擎
              </span>
              <span className="service-ready">
                <span className="status-dot" />
                已就绪
              </span>
            </div>
            <p>
              根据情绪与参数自动编排四条音轨。完全离线、免费使用，适合轻量
              BGM、游戏循环和灵感草稿。采用算法合成，音色与理解能力有别于云端
              AI。
            </p>
          </div>
          <ProviderSettings initialProvider={provider==='local'?'tencent':provider} statuses={providerStatuses} onChanged={setProviderStatuses} onError={fail} onNotice={notify} disabled={busy}/>
          <div className="settings-bottom">
            <p>
              本地作品自动保存到应用作品库。建议导出工程备份；云端作品请导出音频。
            </p>
            <button
              className="secondary-button"
              onClick={() => {
                setModal(null);
                fileInput.current?.click();
              }}
            >
              <Upload size={15} />
              导入本地工程
            </button>
          </div>
        </Modal>
      )}
      {modal === "export" && project && (
        <Modal title="把好声音，带到你的作品里" onClose={closeModal}>
          <div className="export-summary">
            <div className="export-cover">
              <Cover mood={config.mood} small />
            </div>
            <div>
              <h3>{project.title}</h3>
              <p>
                {timeLabel(audioBuffer?.duration ?? 0)} ·{" "}
                {audioBuffer?.sampleRate} Hz · 立体声
              </p>
            </div>
          </div>
          {solo && (
            <p className="export-warning">
              正在独奏「{tracks.find((t) => t.id === solo)?.label}」，当前 WAV
              将只包含试听中的轨道。关闭独奏后可导出完整混音。
            </p>
          )}
          <button
            className="export-option"
            disabled={exportBusy}
            onClick={() => void exportAudio("wav")}
          >
            <span className="format-icon">WAV</span>
            <span>
              <strong>导出无损音频</strong>
              <small>16-bit PCM · 当前混音 · 可直接用于视频与游戏</small>
            </span>
            <ArrowDownToLine size={19} />
          </button>
          {project.audioBlob && (
            <button
              className="export-option"
              disabled={exportBusy}
              onClick={() => void exportAudio("original")}
            >
              <span className="format-icon">{originalFormat(project.audioBlob.type).toUpperCase()}</span>
              <span>
                <strong>导出 AI 原始音频</strong>
                <small>保持服务商原始文件，不应用淡入淡出</small>
              </span>
              <ArrowDownToLine size={19} />
            </button>
          )}
          {project.provider === "local" && (
            <>
              <button
                className="export-option"
                disabled={exportBusy}
                onClick={() => void exportAudio("json")}
              >
                <span className="format-icon">MUSE</span>
                <span>
                  <strong>保存可编辑工程</strong>
                  <small>保存编曲参数与种子，可重新导入继续微调</small>
                </span>
                <ArrowDownToLine size={19} />
              </button>
              <div className="stem-export">
                <span>单独导出音轨</span>
                <div>
                  {tracks.map((t) => (
                    <button
                      disabled={exportBusy}
                      key={t.id}
                      onClick={() => void exportAudio("wav", t.id)}
                    >
                      <t.icon size={14} />
                      {t.label}
                      <ArrowDownToLine size={12} />
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={fade}
              disabled={project.config.loop}
              onChange={(e) => setFade(e.target.checked)}
            />
            <span>
              WAV 头尾各 1 秒柔和淡入淡出
              {project.config.loop ? "（循环片段已禁用）" : ""}
            </span>
          </label>
          <p className="export-note">
            WAV 导出保留轨道混音，不受试听主音量影响。
            {project.provider !== "local"
              ? "云端生成作品的使用权以服务商条款为准。"
              : ""}
          </p>
        </Modal>
      )}
      {modal === "help" && (
        <Modal title="三步，把想法变成背景音乐" onClose={closeModal}>
          <div className="help-steps">
            {[
              {
                title: "描述一个画面",
                text: "告诉音序你想表达的情绪、应用场景和喜欢的乐器。也可以从灵感库挑一个起点。",
              },
              {
                title: "生成，再慢慢雕琢",
                text: "本地引擎立即可用；AI 模式先在设置中配置腾讯云、火山引擎、阿里云或 ElevenLabs。调整速度、音色、能量后点「应用调整」。本地轨道音量可即时试听；每次重新生成都会保存一个新版本。",
              },
              {
                title: "导出，配上你的画面",
                text: "导出立体声 WAV，或分别导出本地作品的旋律、和声、贝斯与鼓组。本地工程 JSON 可以备份和重新导入。",
              },
            ].map((s, i) => (
              <div key={s.title}>
                <span>0{i + 1}</span>
                <section>
                  <h3>{s.title}</h3>
                  <p>{s.text}</p>
                </section>
              </div>
            ))}
          </div>
          <div className="help-note">
            <ShieldCheck size={20} />
            <p>
              本地作曲是基于关键词与音乐规则的合成引擎。AI
              生成使用云端服务，修改乐器或风格会发起一次新的生成，不支持直接拆分
              AI 成品的乐器轨道。
            </p>
          </div>
          <button className="primary-button full-width" onClick={closeModal}>
            开始我的创作 <ArrowRight size={16} />
          </button>
        </Modal>
      )}
    </div>
  );
}
function ArrowUpRightIcon() {
  return <ArrowRight size={20} style={{ transform: "rotate(-40deg)" }} />;
}
