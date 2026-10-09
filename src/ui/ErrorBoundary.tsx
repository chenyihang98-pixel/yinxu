/**
 * Root error boundary. When rendering fails the work in memory is still
 * there (the app core lives outside React), so the panel offers to export
 * it before going back or reloading. Deliberately free of app context and
 * of the primitives: it has to render when they cannot.
 */
import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { appCore } from "../state/app";

interface State {
  failed: boolean;
  exporting: boolean;
  note: string;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { failed: false, exporting: false, note: "" };

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error("render failed", error, info.componentStack);
  }

  private readonly exportCurrent = async () => {
    const { project, audio } = appCore.getState().studio;
    if (!project) return;
    this.setState({ exporting: true, note: "" });
    // A cloud work that could not be decoded still has its original file.
    const saved = await appCore.actions.exportWork(
      audio ? { kind: "mix" } : { kind: "original" },
    );
    this.setState({
      exporting: false,
      note: saved ? "已导出当前音频。" : "导出没有完成，请重试。",
    });
  };

  render() {
    if (!this.state.failed) return this.props.children;
    const { project, audio } = appCore.getState().studio;
    const exportable = !!project && (!!audio || !!project.audioBlob);
    return (
      <div className="crash" data-testid="error-boundary">
        <div className="crash-card" role="alert">
          <h1>界面出了点问题</h1>
          <p>
            「我的作品」里的内容没有受影响。可以先导出当前的音频，再回到界面或重新加载。
          </p>
          <div className="crash-actions">
            {exportable && project && (
              <button
                type="button"
                className="btn btn-primary"
                data-testid="crash-export"
                disabled={this.state.exporting}
                onClick={() => void this.exportCurrent()}
              >
                <span className="btn-label">
                  导出当前音频《{project.title}》
                </span>
              </button>
            )}
            <button
              type="button"
              className="btn"
              data-testid="crash-retry"
              onClick={() => this.setState({ failed: false, note: "" })}
            >
              回到界面
            </button>
            <button
              type="button"
              className="btn"
              data-testid="crash-reload"
              onClick={() => window.location.reload()}
            >
              重新加载
            </button>
          </div>
          {this.state.note && (
            <p className="crash-note" role="status">
              {this.state.note}
            </p>
          )}
        </div>
      </div>
    );
  }
}
