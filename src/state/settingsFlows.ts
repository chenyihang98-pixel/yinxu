/**
 * Desktop settings: cloud music services and the producer's language model.
 * Every call is safe on the web — nothing is requested and the answer says
 * the feature needs the desktop app. No React.
 */
import { providerName } from "../providers";
import type { CloudProvider, DesktopAPI } from "../types";
import type { Kernel } from "./kernel";
import { errorText, joinText } from "./logic";
import type { ActionResult, AppActions } from "./types";

const ok: ActionResult = { ok: true };

export class SettingsFlows {
  private readonly kernel: Kernel;

  constructor(kernel: Kernel) {
    this.kernel = kernel;
  }

  /* ---------------- settings ---------------- */

  readonly refreshSettings: AppActions["refreshSettings"] = async () => {
    const { desktop } = this.kernel.deps;
    if (!desktop || !this.kernel.deps.platform.isDesktop) return;
    this.kernel.dispatch({ type: "settings/loading" });
    try {
      this.kernel.dispatch({
        type: "settings/loaded",
        settings: await desktop.getSettings(),
      });
    } catch (error) {
      this.kernel.dispatch({
        type: "settings/failed",
        error: errorText(error, "无法读取设置，请重新启动应用后再试。"),
      });
    }
  };

  private async setting(
    run: (desktop: DesktopAPI) => Promise<void>,
    done: string,
    failed: string,
  ): Promise<ActionResult> {
    const { desktop } = this.kernel.deps;
    if (!desktop || !this.kernel.deps.platform.isDesktop)
      return { ok: false, message: "这项设置只在 Windows 桌面版中可用。" };
    try {
      await run(desktop);
    } catch (error) {
      return { ok: false, message: errorText(error, failed) };
    }
    await this.refreshSettings();
    this.kernel.toast(done);
    return ok;
  }

  readonly saveProvider: AppActions["saveProvider"] = (provider, credentials) =>
    this.setting(
      (desktop) => desktop.saveProviderCredentials(provider, credentials),
      "凭据已加密保存；尚未验证服务商账号权限。",
      "凭据没有保存，请检查填写的内容后重试。",
    );

  readonly removeProvider: AppActions["removeProvider"] = async (
    provider: CloudProvider,
  ) => {
    const result = await this.setting(
      (desktop) => desktop.deleteProviderCredentials(provider),
      joinText("已移除", providerName(provider), "的凭据"),
      "凭据没有移除，请重试。",
    );
    if (result.ok && this.kernel.state.studio.provider === provider)
      this.kernel.dispatch({ type: "composer/provider", provider: "local" });
    return result;
  };

  readonly saveLlm: AppActions["saveLlm"] = async (settings) => {
    const result = await this.setting(
      (desktop) => desktop.saveLlmSettings(settings),
      "大模型设置已加密保存，制作人已切换为大模型。",
      "大模型设置没有保存，请检查填写的内容后重试。",
    );
    if (result.ok && this.kernel.state.settings.llm.configured) {
      this.kernel.dispatch({ type: "composer/brain", brain: "llm" });
      this.kernel.writeSession();
    }
    return result;
  };

  readonly removeLlm: AppActions["removeLlm"] = async () => {
    const result = await this.setting(
      (desktop) => desktop.deleteLlmSettings(),
      "已移除大模型设置，制作人改用离线规则。",
      "大模型设置没有移除，请重试。",
    );
    if (result.ok) {
      this.kernel.dispatch({ type: "composer/brain", brain: "rules" });
      this.kernel.writeSession();
    }
    return result;
  };
}
