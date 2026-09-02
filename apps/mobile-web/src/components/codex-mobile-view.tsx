import { useMemo, useState } from "react";
import type { AppProfile, NormalizedRegion, RemoteTarget } from "@slice/protocol";
import { Button, cn } from "@slice/design-system";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  LayoutDashboard,
  MousePointer2,
  MoreHorizontal,
  Send,
  Settings2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { AppIcon } from "./app-icon";
import { FULL_REGION, RemoteCanvas } from "./remote-canvas";
import type { RemoteStream } from "./use-remote-stream";
import type { RemoteClient } from "../remote-client";
import { CODEX_REGION_IDS, getCodexRegion } from "../adapters/codex";

type CodexMobileViewProps = {
  target: RemoteTarget;
  profile: AppProfile;
  stream: RemoteStream;
  remote: RemoteClient;
  onError: (message: string) => void;
  onBack: () => void;
  onOpenRegions: () => void;
  onOpenMouseMode: () => void;
};

function centerOf(region: NormalizedRegion) {
  return { x: region.x + region.width / 2, y: region.y + region.height / 2 };
}

export function CodexMobileView({
  target,
  profile,
  stream,
  remote,
  onError,
  onBack,
  onOpenRegions,
  onOpenMouseMode,
}: CodexMobileViewProps) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [canvasZoom, setCanvasZoom] = useState(1);
  const [controlsVisible, setControlsVisible] = useState(false);
  const regions = profile.regions;
  const conversation = useMemo(
    () => getCodexRegion(regions, CODEX_REGION_IDS.conversation) ?? FULL_REGION,
    [regions],
  );
  const composer = useMemo(
    () => getCodexRegion(regions, CODEX_REGION_IDS.composer) ?? conversation,
    [conversation, regions],
  );

  const runRemote = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const scrollConversation = (deltaY: number) => runRemote(() => {
    const point = centerOf(conversation);
    return remote.gesture(target, { type: "scroll", x: point.x, y: point.y, deltaX: 0, deltaY });
  });

  const focusComposer = () => {
    const point = centerOf(composer);
    return remote.click(target, point.x, point.y);
  };

  const sendPrompt = () => {
    const text = draft.trim();
    if (!text) return;
    return runRemote(async () => {
      await focusComposer();
      await remote.type(target, text);
      await remote.key(target, { key: "enter", modifiers: [] });
      setDraft("");
    });
  };

  return (
    <section className="fixed inset-0 overflow-hidden bg-[#101010] text-white" aria-label="Codex 手机适配">
      {controlsVisible ? <header className="absolute inset-x-0 top-0 z-40 flex items-center gap-2 border-b border-white/10 bg-black/55 px-3 pb-2 pt-[max(0.65rem,env(safe-area-inset-top))] backdrop-blur-xl">
        <Button size="icon-sm" variant="ghost" className="text-white hover:bg-white/15" aria-label="返回应用画板" onClick={onBack}>
          <ArrowLeft />
        </Button>
        <AppIcon target={target} className="size-8 rounded-[0.6rem]" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">Codex</p>
          <p className="truncate text-[0.6875rem] text-white/55">对话区已适配 · 原生窗口仍可访问</p>
        </div>
        <Button size="icon-sm" variant="ghost" className="text-white hover:bg-white/15" aria-label="编辑区域" title="编辑区域" onClick={onOpenRegions}>
          <Settings2 />
        </Button>
        <Button size="icon-sm" variant="ghost" className="text-white hover:bg-white/15" aria-label="鼠标模式" title="鼠标模式" onClick={onOpenMouseMode}>
          <MousePointer2 />
        </Button>
        <Button size="icon-sm" variant="ghost" className="text-white hover:bg-white/15" aria-label="隐藏控制栏" title="隐藏控制栏" onClick={() => setControlsVisible(false)}>
          <X />
        </Button>
      </header> : null}

      <div className="absolute inset-0 overflow-hidden">
        <div className="absolute inset-0 overflow-hidden bg-ink">
          <div
            className="h-full w-full"
            style={{ transform: `scale(${canvasZoom})`, transformOrigin: "center center" }}
          >
            <RemoteCanvas
              target={target}
              stream={stream}
              region={conversation}
              onError={onError}
              fillViewport={false}
              fillContainer
              fit="contain"
              initialInteractionMode="touch"
              showStatus={false}
            />
          </div>
        </div>
        {controlsVisible ? <div className="pointer-events-none absolute inset-x-3 top-[max(4.5rem,calc(env(safe-area-inset-top)+3.75rem))] flex items-start justify-between gap-2">
          <span className="rounded-full border border-white/10 bg-black/55 px-2.5 py-1 text-[0.6875rem] text-white/65 backdrop-blur-md">Codex 对话 · 画面兜底</span>
          <div className="pointer-events-auto flex items-center gap-1 rounded-full border border-white/10 bg-black/55 p-1 backdrop-blur-md">
            <Button size="icon-sm" variant="ghost" className="size-9 text-white hover:bg-white/15" aria-label="向上滚动" disabled={busy} onClick={() => void scrollConversation(-1000)}>
              <ArrowUp />
            </Button>
            <Button size="icon-sm" variant="ghost" className="size-9 text-white hover:bg-white/15" aria-label="向下滚动" disabled={busy} onClick={() => void scrollConversation(1000)}>
              <ArrowDown />
            </Button>
            <span className="mx-0.5 h-5 w-px bg-white/15" aria-hidden="true" />
            <Button size="icon-sm" variant="ghost" className="size-9 text-white hover:bg-white/15" aria-label="缩小画布" disabled={canvasZoom <= 1} onClick={() => setCanvasZoom((value) => Math.max(1, Number((value - 0.25).toFixed(2))))}>
              <ZoomOut />
            </Button>
            <span className="min-w-10 text-center text-[0.6875rem] text-white/75">{Math.round(canvasZoom * 100)}%</span>
            <Button size="icon-sm" variant="ghost" className="size-9 text-white hover:bg-white/15" aria-label="放大画布" disabled={canvasZoom >= 3} onClick={() => setCanvasZoom((value) => Math.min(3, Number((value + 0.25).toFixed(2))))}>
              <ZoomIn />
            </Button>
          </div>
        </div> : null}
      </div>

      {controlsVisible ? <form
        className="absolute inset-x-0 bottom-0 z-40 border-t border-white/10 bg-black/70 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2 backdrop-blur-2xl"
        onSubmit={(event) => { event.preventDefault(); void sendPrompt(); }}
      >
        <div className="mx-auto flex max-w-3xl items-end gap-2 rounded-[1.15rem] border border-white/15 bg-white/[0.08] p-2 shadow-[0_12px_35px_rgb(0_0_0/25%)]">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void sendPrompt();
              }
            }}
            rows={1}
            maxLength={4096}
            placeholder="给 Codex 发消息…"
            aria-label="Codex 消息"
            className="max-h-28 min-h-10 min-w-0 flex-1 resize-none bg-transparent px-2 py-2 text-base text-white outline-none placeholder:text-white/40"
          />
          <Button type="submit" size="icon" variant="primary" aria-label="发送消息" disabled={busy || !draft.trim()}>
            <Send />
          </Button>
        </div>
        <div className="mx-auto mt-1.5 flex max-w-3xl items-center justify-between px-1 text-[0.6875rem] text-white/45">
          <span>Enter 发送 · Shift+Enter 换行</span>
          <button type="button" className={cn("inline-flex items-center gap-1 hover:text-white", busy && "pointer-events-none opacity-50")} onClick={onOpenRegions}>
            <LayoutDashboard className="size-3.5" /> 调整布局
          </button>
        </div>
      </form> : null}
      {!controlsVisible ? (
        <Button
          size="icon"
          variant="ghost"
          className="absolute bottom-[max(1rem,env(safe-area-inset-bottom))] right-3 z-50 size-11 rounded-full border border-white/20 bg-black/65 text-white shadow-overlay backdrop-blur-xl hover:bg-black/80"
          aria-label="显示 Codex 控制栏"
          title="显示控制栏"
          onClick={() => setControlsVisible(true)}
        >
          <MoreHorizontal />
        </Button>
      ) : null}
    </section>
  );
}
