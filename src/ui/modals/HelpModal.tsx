/** 使用指南: how to describe music, what the producer understands, the two
 *  producers, local vs cloud, shortcuts and privacy. */
import type { ReactNode } from "react";
import {
  BookOpen,
  Bot,
  Cloud,
  Download,
  Headphones,
  Keyboard,
  MessageSquareText,
  MousePointerClick,
  PenLine,
  ShieldCheck,
  Wrench,
} from "lucide-react";
import {
  DESCRIPTION_EXAMPLES,
  PARAMETER_EXAMPLE,
  REFINE_EXAMPLES,
} from "../../state/content";
import { useApp } from "../../state/context";
import { Modal } from "../primitives/Modal";

function Section(props: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="help-section">
      <h3>
        <span className="help-icon" aria-hidden>
          {props.icon}
        </span>
        {props.title}
      </h3>
      {props.children}
    </section>
  );
}

function Key(props: { keys: string[]; children: ReactNode }) {
  return (
    <div className="shortcut">
      <dt>
        {props.keys.map((key, index) => (
          <span key={key}>
            {index > 0 && <span className="shortcut-plus">+</span>}
            <kbd>{key}</kbd>
          </span>
        ))}
      </dt>
      <dd>{props.children}</dd>
    </div>
  );
}

/** 简单模式's guide: three steps with pictures, and what to do when it is not right. */
function SimpleHelp() {
  const { actions, platform, settings, studio } = useApp();
  const cloud =
    platform.isDesktop &&
    Object.values(settings.providers).some((status) => status.configured);
  // the user's own language model reads what they type (scenes and the
  // one-tap buttons never use it)
  const llm = studio.brains.some(
    (option) => option.id === "llm" && option.available,
  );
  const steps = [
    {
      icon: <MousePointerClick size={26} />,
      title: "点一个场景",
      text: "比如「咖啡馆」「旅行风景」。也可以用一句话说说想要什么。",
    },
    {
      icon: <Headphones size={26} />,
      title: "听一听",
      text: "几秒钟就做好，做好会自动播放。",
    },
    {
      icon: <Download size={26} />,
      title: "下载音乐",
      text: platform.isDesktop
        ? "点「下载音乐」，选个地方保存。"
        : "点「下载音乐」，文件会直接下载。",
    },
  ];
  return (
    <Modal
      size="lg"
      title="怎么用"
      icon={<BookOpen size={18} />}
      testId="help-modal"
      onClose={actions.closeModal}
    >
      <div className="help simple-help">
        <ol className="help-steps">
          {steps.map((step, index) => (
            <li key={step.title} className="help-step">
              <span className="help-step-art" aria-hidden>
                {step.icon}
              </span>
              <span className="help-step-number" aria-hidden>
                {index + 1}
              </span>
              <strong>{step.title}</strong>
              <span>{step.text}</span>
            </li>
          ))}
        </ol>
        <Section icon={<Wrench size={16} />} title="不满意怎么办">
          <p>
            点「觉得哪里不对」下面的按钮，比如「快一点」「换个乐器」「去掉鼓」，或者在框里直接说想怎么改。每改一次都会留下上一版，点「撤销」就能回去。整首都不喜欢，就点「换一首」，或者「重新挑」一个场景。
          </p>
        </Section>
        <Section icon={<ShieldCheck size={16} />} title="放心用">
          <p>
            音乐就在
            {platform.isDesktop ? "这台电脑" : "这个浏览器"}
            上做，不收费，做好的都在「我的音乐」里。
            {llm
              ? "场景和按钮不用联网；你自己写的话，会交给你在设置里接入的大模型来理解。"
              : "不用联网。"}
            {cloud
              ? "只有打开「用 AI 服务生成」时，才会按次付费，每次都会先问你。"
              : ""}
            {platform.isWeb ? "清除网站数据会删掉它们，重要的请先下载。" : ""}
          </p>
        </Section>
      </div>
    </Modal>
  );
}

export function HelpModal() {
  const { actions, platform, ui } = useApp();
  if (ui.mode === "simple") return <SimpleHelp />;
  return (
    <Modal
      size="lg"
      title="使用指南"
      icon={<BookOpen size={18} />}
      testId="help-modal"
      onClose={actions.closeModal}
    >
      <div className="help">
        <Section icon={<PenLine size={16} />} title="怎么描述音乐">
          <p>
            写下场景、情绪和想要的乐器就够了，其余交给制作人。也可以直接说参数。
          </p>
          <ul className="help-examples">
            {DESCRIPTION_EXAMPLES.slice(0, 2).map((example) => (
              <li key={example.text}>{example.text}</li>
            ))}
            <li>{PARAMETER_EXAMPLE.text}</li>
          </ul>
        </Section>

        <Section
          icon={<MessageSquareText size={16} />}
          title="制作人听得懂什么"
        >
          <dl className="help-list">
            {REFINE_EXAMPLES.map((group) => (
              <div key={group.topic}>
                <dt>{group.topic}</dt>
                <dd>
                  {group.phrases.join("、")}
                  {group.topic === "旋律" ? "（其余不变）" : ""}
                </dd>
              </div>
            ))}
          </dl>
          <p className="muted">
            每次调整都会生成一个新版本，之前的版本仍在「我的作品」里。混音推子是即时的，不会产生新版本。
          </p>
        </Section>

        <Section icon={<Bot size={16} />} title="两种制作人">
          <dl className="help-list">
            <div>
              <dt>离线规则</dt>
              <dd>内置，随时可用，不联网。听得懂上面这些说法。</dd>
            </div>
            <div>
              <dt>大模型</dt>
              <dd>
                {platform.isDesktop
                  ? "在「设置 → 制作人大模型」接入你自己的模型后，能理解更自由的说法；这时你的描述会发送给所选服务商。模型不可用时会改用离线规则（选了云端生成时会先问你）。"
                  : "桌面版可以接入你自己的大模型来理解更自由的说法；网页版只使用离线规则。"}
              </dd>
            </div>
          </dl>
        </Section>

        <Section icon={<Cloud size={16} />} title="本地作曲与云端生成">
          <dl className="help-list">
            <div>
              <dt>本地作曲</dt>
              <dd>
                免费、离线，在这台设备上作曲与合成。提供旋律、和声、贝斯、鼓组四条分轨，可以即时混音、分轨导出。
              </dd>
            </div>
            <div>
              <dt>云端生成</dt>
              <dd>
                {platform.isDesktop
                  ? "由你配置的 AI 音乐服务生成一条混合音轨，按服务商计费，不能分轨调整。每一次修改（发送、应用调整、重新生成）都是一次新的付费请求，重新生成整首音乐，不保留原旋律；发送前会先询问。取消等待后，已提交的生成仍可能计费。"
                  : "只在桌面版中提供：由 AI 音乐服务生成一条混合音轨，按服务商计费。"}
              </dd>
            </div>
          </dl>
        </Section>

        <Section icon={<Keyboard size={16} />} title="快捷键">
          <dl className="shortcuts">
            <Key keys={["空格"]}>播放 / 暂停</Key>
            <Key keys={["←"]}>后退 5 秒</Key>
            <Key keys={["→"]}>前进 5 秒</Key>
            <Key keys={["L"]}>循环试听</Key>
            <Key keys={["Enter"]}>发送修改</Key>
            <Key keys={["Shift", "Enter"]}>换行</Key>
            <Key keys={["Ctrl", "Enter"]}>生成 / 发送</Key>
            {/* Browsers keep Ctrl+N for themselves: desktop only. */}
            {platform.isDesktop && <Key keys={["Ctrl", "N"]}>新建创作</Key>}
            <Key keys={["Ctrl", "E"]}>导出</Key>
            <Key keys={["Esc"]}>关闭弹窗</Key>
          </dl>
          <p className="muted">
            Enter 和 Shift+Enter
            用在「告诉制作人怎么改」的输入框里；写新作品的描述时 Enter
            是换行，用 Ctrl+Enter 生成。在输入框里打字时，空格、方向键和 L
            不会触发快捷键。
          </p>
        </Section>

        <Section icon={<ShieldCheck size={16} />} title="隐私">
          <p>
            本地作曲不使用网络。描述和作品只保存在
            {platform.isDesktop ? "这台电脑上" : "这个浏览器里"}
            ，不会上传。
            {platform.isDesktop
              ? "只有在你选择云端生成或制作人大模型时，描述文字才会发送给你配置的服务商。"
              : "清除网站数据会删除作品，重要的请先导出。"}
          </p>
        </Section>
      </div>
    </Modal>
  );
}
