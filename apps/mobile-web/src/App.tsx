import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { AppProfile, HostPermissions, InstalledApp, NormalizedRegion, RemoteTarget } from "@slice/protocol";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  cn,
  Input,
} from "@slice/design-system";
import {
  Check,
  CircleAlert,
  Grid2X2,
  Monitor,
  PanelsTopLeft,
  Plus,
  Scan,
} from "lucide-react";
import { hostApi } from "./api";
import { AppHoneycomb } from "./components/app-honeycomb";
import { AppIcon } from "./components/app-icon";
import { RegionLayoutCanvas } from "./components/region-layout-canvas";
import { FULL_REGION, RemoteCanvas } from "./components/remote-canvas";
import { useRemoteStream } from "./components/use-remote-stream";
import { loadProfile, saveRegions } from "./profiles";

type ViewMode = "apps" | "regions" | "app" | "desktop";

function pickApplicationTargets(targets: RemoteTarget[]) {
  const apps = new Map<string, RemoteTarget>();
  for (const target of targets.filter((item) => item.kind === "window")) {
    const key = target.bundleIdentifier || target.appName || target.title;
    const current = apps.get(key);
    const area = target.frame.width * target.frame.height;
    const currentArea = current ? current.frame.width * current.frame.height : 0;
    if (!current || area > currentArea) apps.set(key, target);
  }
  return [...apps.values()].sort((a, b) => {
    const aCodex = /codex/i.test(`${a.appName} ${a.title}`) ? 1 : 0;
    const bCodex = /codex/i.test(`${b.appName} ${b.title}`) ? 1 : 0;
    return bCodex - aCodex || (a.appName || a.title).localeCompare(b.appName || b.title);
  });
}

function findTargetForApp(app: InstalledApp, targets: RemoteTarget[]) {
  const windows = targets.filter((target) => target.kind === "window");
  const matches = windows.filter((target) => app.bundleIdentifier
    ? target.bundleIdentifier === app.bundleIdentifier
    : (target.appName || "").localeCompare(app.appName, undefined, { sensitivity: "accent" }) === 0);
  return matches.sort((left, right) => (
    right.frame.width * right.frame.height - left.frame.width * left.frame.height
  ))[0] ?? null;
}

function sortApplications(apps: InstalledApp[]) {
  return [...apps].sort((left, right) => {
    const leftCodex = /codex/i.test(`${left.appName} ${left.bundleIdentifier}`) ? 1 : 0;
    const rightCodex = /codex/i.test(`${right.appName} ${right.bundleIdentifier}`) ? 1 : 0;
    return rightCodex - leftCodex
      || Number(right.hasOpenWindow) - Number(left.hasOpenWindow)
      || left.appName.localeCompare(right.appName);
  });
}

function DockAction({
  label,
  onClick,
  children,
  className,
}: {
  label: string;
  onClick?: () => void;
  children: ReactNode;
  className?: string;
}) {
  const content = (
    <>
      {children}
      <span className="pointer-events-none absolute -top-10 left-1/2 hidden -translate-x-1/2 whitespace-nowrap rounded-control bg-black/85 px-2 py-1 text-[0.6875rem] text-white shadow-lg group-hover:block">
        {label}
      </span>
    </>
  );
  const actionClassName = cn(
    "group relative flex size-12 shrink-0 items-center justify-center rounded-[1rem] border border-white/10 bg-white/10 text-white shadow-lg transition duration-150 ease-product hover:-translate-y-1 hover:bg-white/20 focus-visible:outline-white active:scale-95",
    !onClick && "cursor-default hover:translate-y-0 hover:bg-white/10",
    className,
  );
  return onClick ? (
    <button className={actionClassName} type="button" aria-label={label} title={label} onClick={onClick}>
      {content}
    </button>
  ) : (
    <div className={actionClassName} aria-label={label} title={label} role="img">
      {content}
    </div>
  );
}

function DockSeparator() {
  return <span className="mx-1 h-9 w-px shrink-0 bg-white/20" aria-hidden="true" />;
}

function FullscreenDock({ children }: { children: ReactNode }) {
  return (
    <div className="pointer-events-none absolute inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-[9999] flex flex-col items-center">
      <nav
        className="pointer-events-auto flex max-w-full items-end gap-1 overflow-visible rounded-[1.75rem] border border-white/15 bg-black/65 px-2.5 py-2.5 shadow-[0_16px_50px_rgb(0_0_0/35%)] backdrop-blur-2xl"
        aria-label="全屏控制"
      >
        {children}
      </nav>
    </div>
  );
}

export default function App() {
  const [permissions, setPermissions] = useState<HostPermissions | null>(null);
  const [targets, setTargets] = useState<RemoteTarget[]>([]);
  const [installedApps, setInstalledApps] = useState<InstalledApp[]>([]);
  const [selectedAppId, setSelectedAppId] = useState<number | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("apps");
  const [profile, setProfile] = useState<AppProfile | null>(null);
  const [editing, setEditing] = useState(false);
  const [editingRegionId, setEditingRegionId] = useState<string | null>(null);
  const [layoutEditing, setLayoutEditing] = useState(false);
  const [draftRegion, setDraftRegion] = useState<NormalizedRegion | null>(null);
  const [draftName, setDraftName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingProfile, setSavingProfile] = useState(false);
  const handleRemoteError = useCallback((message: string) => setError(message), []);

  const applicationTargets = useMemo(() => pickApplicationTargets(targets), [targets]);
  const applicationCatalog = useMemo(() => sortApplications(installedApps.map((app) => ({
    ...app,
    hasOpenWindow: Boolean(findTargetForApp(app, targets)),
  }))), [installedApps, targets]);
  const displayTarget = useMemo(() => targets.find((target) => target.kind === "display") ?? null, [targets]);
  const selectedApp = useMemo(() => (
    applicationTargets.find((target) => target.id === selectedAppId) ?? applicationTargets[0] ?? null
  ), [applicationTargets, selectedAppId]);
  const activeTarget = viewMode === "desktop" ? displayTarget : viewMode === "apps" ? null : selectedApp;
  const immersive = viewMode === "app" || viewMode === "desktop";
  const appCanvas = viewMode === "apps";
  const canvasView = appCanvas || viewMode === "regions" || immersive;
  const stream = useRemoteStream(activeTarget, handleRemoteError);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [nextPermissions, nextApplications] = await Promise.all([hostApi.permissions(), hostApi.apps()]);
      setPermissions(nextPermissions);
      setInstalledApps(nextApplications);
      if (!nextPermissions.screenRecording) {
        setTargets([]);
        setSelectedAppId(null);
        setError(null);
        return;
      }
      const nextTargets = await hostApi.targets();
      const nextApps = pickApplicationTargets(nextTargets);
      setTargets(nextTargets);
      setSelectedAppId((current) => {
        if (current != null && nextApps.some((target) => target.id === current)) return current;
        return nextApps.find((target) => /codex/i.test(`${target.appName} ${target.title}`))?.id ?? nextApps[0]?.id ?? null;
      });
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    let cancelled = false;
    setProfile(null);
    setEditing(false);
    setEditingRegionId(null);
    setLayoutEditing(false);
    setDraftRegion(null);
    if (selectedApp) {
      void loadProfile(selectedApp)
        .then((nextProfile) => { if (!cancelled) setProfile(nextProfile); })
        .catch((profileError) => {
          if (!cancelled) handleRemoteError(profileError instanceof Error ? profileError.message : String(profileError));
        });
    }
    return () => { cancelled = true; };
  }, [handleRemoteError, selectedApp]);

  const requestPermissions = async () => {
    try {
      await hostApi.requestPermissions();
      await load();
    } catch (permissionError) {
      setError(permissionError instanceof Error ? permissionError.message : String(permissionError));
    }
  };

  const selectApplication = async (app: InstalledApp) => {
    try {
      let nextTargets = targets;
      let target = findTargetForApp(app, nextTargets);
      if (!target) {
        if (!permissions?.screenRecording) throw new Error("先授权屏幕录制，否则打开了 App 也看不到画面。");
        await hostApi.launchApp(app.path);
        for (let attempt = 0; attempt < 12 && !target; attempt += 1) {
          await new Promise((resolve) => window.setTimeout(resolve, 400));
          nextTargets = await hostApi.targets();
          target = findTargetForApp(app, nextTargets);
        }
        setTargets(nextTargets);
        setInstalledApps(await hostApi.apps());
      }
      if (!target) throw new Error(`${app.appName} 已启动，但没有可共享窗口。它可能是菜单栏或后台应用。`);
      setSelectedAppId(target.id);
      setViewMode("app");
      setError(null);
    } catch (selectionError) {
      setError(selectionError instanceof Error ? selectionError.message : String(selectionError));
    }
  };

  const closeApplication = async (app: InstalledApp) => {
    try {
      await hostApi.closeApp(app.path);
      await new Promise((resolve) => window.setTimeout(resolve, 300));
      await load();
      setError(null);
    } catch (closeError) {
      setError(closeError instanceof Error ? closeError.message : String(closeError));
    }
  };

  const beginRegion = () => {
    setLayoutEditing(false);
    setEditingRegionId(null);
    setDraftRegion(null);
    setDraftName("");
    setEditing(true);
  };

  const editRegion = (region: NormalizedRegion) => {
    setLayoutEditing(false);
    setEditingRegionId(region.id);
    setDraftRegion({ ...region, layout: region.layout ? { ...region.layout } : undefined });
    setDraftName(region.name);
    setEditing(true);
  };

  const persistRegions = async (regions: NormalizedRegion[]) => {
    if (!selectedApp || savingProfile) return;
    setSavingProfile(true);
    try {
      setProfile(await saveRegions(selectedApp, regions));
    } catch (profileError) {
      handleRemoteError(profileError instanceof Error ? profileError.message : String(profileError));
    } finally {
      setSavingProfile(false);
    }
  };

  const saveRegion = async () => {
    if (!selectedApp || !profile || !draftRegion || !draftName.trim() || savingProfile) return;
    const id = editingRegionId
      ?? globalThis.crypto.randomUUID?.()
      ?? `region-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const nextRegion = { ...draftRegion, id, name: draftName.trim() };
    const nextRegions = editingRegionId
      ? profile.regions.map((region) => region.id === editingRegionId ? nextRegion : region)
      : [...profile.regions, nextRegion];
    await persistRegions(nextRegions);
    setDraftRegion(null);
    setDraftName("");
    setEditingRegionId(null);
    setEditing(false);
  };

  const removeRegion = async (regionId: string) => {
    if (!selectedApp || !profile || savingProfile) return;
    await persistRegions(profile.regions.filter((region) => region.id !== regionId));
  };

  return (
    <main className={cn(
      canvasView
        ? "h-dvh w-full overflow-hidden bg-inset"
        : "mx-auto flex min-h-dvh w-full max-w-3xl flex-col gap-5 px-4 pb-8 pt-[max(1.25rem,env(safe-area-inset-top))] sm:px-6",
    )}>
      {canvasView && permissions && (!permissions.screenRecording || !permissions.accessibility) ? (
        <Alert className="absolute inset-x-4 top-[max(5rem,env(safe-area-inset-top))] z-30 mx-auto max-w-md shadow-overlay" variant="destructive">
          <CircleAlert />
          <AlertTitle>系统权限未完成</AlertTitle>
          <AlertDescription>
            屏幕录制：{permissions.screenRecording ? "已授权" : "未授权"}；辅助功能：{permissions.accessibility ? "已授权" : "未授权"}。
            <Button className="mt-3" size="sm" variant="danger" onClick={() => void requestPermissions()}>申请权限</Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {!canvasView && permissions && (!permissions.screenRecording || !permissions.accessibility) ? (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertTitle>系统权限未完成</AlertTitle>
          <AlertDescription>
            屏幕录制：{permissions.screenRecording ? "已授权" : "未授权"}；辅助功能：{permissions.accessibility ? "已授权" : "未授权"}。
            <Button className="mt-3" size="sm" variant="danger" onClick={() => void requestPermissions()}>申请权限</Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {canvasView && error ? (
        <Alert className="absolute inset-x-4 top-[max(5rem,env(safe-area-inset-top))] z-30 mx-auto max-w-md shadow-overlay" variant="destructive">
          <CircleAlert />
          <AlertTitle>操作失败</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {!canvasView && error ? (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertTitle>操作失败</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {viewMode === "apps" ? (
        <section className="h-full" aria-labelledby="apps-heading">
          <h1 id="apps-heading" className="sr-only">选择应用</h1>
          {applicationCatalog.length ? (
            <AppHoneycomb
              apps={applicationCatalog}
              onSelect={selectApplication}
              onCloseApp={closeApplication}
              onOpenDesktop={() => setViewMode("desktop")}
              displayAvailable={Boolean(displayTarget)}
              fullScreen
            />
          ) : (
            <Card className="mx-4 mt-4" variant="outlined">
              <CardHeader>
                <CardTitle>{loading ? "正在读取已安装应用…" : "没有找到已安装应用"}</CardTitle>
                <CardDescription>应用目录读取失败；这和窗口是否打开不是一回事。</CardDescription>
              </CardHeader>
            </Card>
          )}
        </section>
      ) : null}

      {viewMode === "regions" && selectedApp ? (
        <section className="fixed inset-0 overflow-hidden bg-ink" aria-labelledby="regions-heading">
          <h2 id="regions-heading" className="sr-only">{selectedApp.appName || selectedApp.title}区域画布</h2>
          {profile ? (
            editing ? (
              <RemoteCanvas
                key={`crop-${editingRegionId ?? "new"}`}
                target={selectedApp}
                stream={stream}
                onError={handleRemoteError}
                selectionMode
                selection={draftRegion}
                onSelectionChange={setDraftRegion}
                onSelectionComplete={() => setDraftName((value) => value || `区域 ${profile.regions.length + 1}`)}
                fillViewport
              />
            ) : (
              <RegionLayoutCanvas
                target={selectedApp}
                stream={stream}
                regions={profile.regions}
                editing={layoutEditing}
                onCommit={(regions) => void persistRegions(regions)}
                onEditCrop={editRegion}
                onRemove={(regionId) => void removeRegion(regionId)}
                onError={handleRemoteError}
                fullScreen
              />
            )
          ) : (
            <div className="flex h-full items-center justify-center text-body-sm text-white/65">正在读取区域配置…</div>
          )}

          {editing ? (
            <div className="absolute inset-x-3 bottom-[max(6rem,calc(env(safe-area-inset-bottom)+5rem))] z-[9999] mx-auto flex w-[calc(100%-1.5rem)] max-w-lg items-center gap-2 rounded-sheet border border-white/15 bg-black/70 p-2 shadow-overlay backdrop-blur-xl">
              <Input
                id="region-name"
                className="min-w-0 flex-1 border-0 bg-transparent text-white placeholder:text-white/45 hover:bg-white/10 focus:bg-white/10 focus:ring-0"
                value={draftName}
                placeholder="区域名称"
                aria-label="区域名称"
                onChange={(event) => setDraftName(event.target.value)}
              />
              <Button variant="primary" disabled={!draftRegion || !draftName.trim() || savingProfile} onClick={saveRegion}>
                {editingRegionId ? "保存" : "添加"}
              </Button>
              <Button className="text-white hover:bg-white/15" variant="ghost" onClick={() => { setEditing(false); setEditingRegionId(null); setDraftRegion(null); }}>
                取消
              </Button>
            </div>
          ) : null}

          <FullscreenDock>
            <DockAction label="应用画板" onClick={() => setViewMode("apps")}><Grid2X2 className="size-6" /></DockAction>
            <DockSeparator />
            <DockAction label="返回完整应用" onClick={() => setViewMode("app")} className="size-14 rounded-[1.15rem] bg-white p-1 hover:bg-white">
              <AppIcon target={selectedApp} className="size-full rounded-[0.9rem]" />
            </DockAction>
            {profile?.regions.length ? (
              <DockAction label={layoutEditing ? "完成布局" : "调整布局"} onClick={() => setLayoutEditing((value) => !value)}>
                {layoutEditing ? <Check className="size-6" /> : <PanelsTopLeft className="size-6" />}
              </DockAction>
            ) : null}
            {!editing ? <DockAction label="添加区域" onClick={beginRegion}><Plus className="size-6" /></DockAction> : null}
          </FullscreenDock>
          {error ? <Alert className="absolute inset-x-3 top-20 z-[10000]" variant="destructive"><CircleAlert /><AlertDescription>{error}</AlertDescription></Alert> : null}
        </section>
      ) : null}

      {viewMode === "app" && selectedApp ? (
        <section className="fixed inset-0 overflow-hidden bg-ink" aria-labelledby="app-heading">
          <h2 id="app-heading" className="sr-only">{selectedApp.appName || selectedApp.title}</h2>
          <RemoteCanvas target={selectedApp} stream={stream} region={FULL_REGION} onError={handleRemoteError} fillViewport />
          <FullscreenDock>
            <DockAction label="应用画板" onClick={() => setViewMode("apps")}><Grid2X2 className="size-6" /></DockAction>
            <DockSeparator />
            <DockAction label={selectedApp.appName || selectedApp.title} className="size-14 rounded-[1.15rem] bg-white p-1 hover:bg-white">
              <AppIcon target={selectedApp} className="size-full rounded-[0.9rem]" />
            </DockAction>
            <DockAction label="交互区域" onClick={() => setViewMode("regions")}><PanelsTopLeft className="size-6" /></DockAction>
          </FullscreenDock>
          {error ? <Alert className="absolute inset-x-3 top-20" variant="destructive"><CircleAlert /><AlertDescription>{error}</AlertDescription></Alert> : null}
        </section>
      ) : null}

      {viewMode === "desktop" ? (
        <section className="fixed inset-0 bg-ink" aria-labelledby="desktop-heading">
          <h2 id="desktop-heading" className="sr-only">完整桌面</h2>
          {displayTarget ? (
            <RemoteCanvas target={displayTarget} stream={stream} onError={handleRemoteError} fillViewport />
          ) : <p className="text-body-sm text-muted">没有可用显示器。</p>}
          <FullscreenDock>
            <DockAction label="完整 App" onClick={() => setViewMode("app")}><Scan className="size-6" /></DockAction>
            <DockSeparator />
            <DockAction label="完整桌面" className="size-14 rounded-[1.15rem] bg-white/15 hover:bg-white/25"><Monitor className="size-6" /></DockAction>
          </FullscreenDock>
          {error ? <Alert className="absolute inset-x-3 top-20" variant="destructive"><CircleAlert /><AlertDescription>{error}</AlertDescription></Alert> : null}
        </section>
      ) : null}

    </main>
  );
}
