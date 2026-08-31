import { useCallback, useEffect, useMemo, useState } from "react";
import type { AppProfile, HostPermissions, InstalledApp, NormalizedRegion, RemoteTarget } from "@slice/protocol";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  cn,
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  Input,
  useTheme,
} from "@slice/design-system";
import {
  AppWindow,
  Check,
  ChevronLeft,
  CircleAlert,
  Grid2X2,
  Laptop,
  Maximize2,
  Monitor,
  Moon,
  PanelsTopLeft,
  Plus,
  RefreshCw,
  Scan,
  Sun,
} from "lucide-react";
import { hostApi } from "./api";
import { AppHoneycomb } from "./components/app-honeycomb";
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

function useCanEditProfiles() {
  const [canEdit, setCanEdit] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(min-width: 768px) and (pointer: fine)");
    const update = () => setCanEdit(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return canEdit;
}

export default function App() {
  const { resolvedTheme, setPreference } = useTheme();
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
  const canEditProfiles = useCanEditProfiles();
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
    setDraftRegion(region);
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

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      setError("当前浏览器不允许网页全屏；把页面添加到手机主屏幕后打开即可全屏运行。");
    }
  };

  return (
    <main className={cn(
      immersive ? "h-dvh w-full overflow-hidden bg-ink" : "mx-auto flex min-h-dvh w-full max-w-3xl flex-col gap-5 px-4 pb-28 pt-[max(1.25rem,env(safe-area-inset-top))] sm:px-6",
    )}>
      {!immersive ? <header className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-control bg-primary text-primary-foreground">
            <Laptop aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <p className="font-utility text-meta uppercase tracking-eyebrow text-muted">Local MVP</p>
            <h1 className="truncate font-display text-title-sm tracking-display">Slice Remote Screen</h1>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Badge variant={error ? "destructive" : "secondary"}>{error ? "异常" : "在线"}</Badge>
          <Button size="icon-sm" variant="ghost" aria-label="刷新应用列表" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={loading ? "animate-spin" : undefined} />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={resolvedTheme === "dark" ? "切换到亮色主题" : "切换到暗色主题"}
            onClick={() => setPreference(resolvedTheme === "dark" ? "light" : "dark")}
          >
            {resolvedTheme === "dark" ? <Sun /> : <Moon />}
          </Button>
        </div>
      </header> : null}

      {!immersive && permissions && (!permissions.screenRecording || !permissions.accessibility) ? (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertTitle>系统权限未完成</AlertTitle>
          <AlertDescription>
            屏幕录制：{permissions.screenRecording ? "已授权" : "未授权"}；辅助功能：{permissions.accessibility ? "已授权" : "未授权"}。
            <Button className="mt-3" size="sm" variant="danger" onClick={() => void requestPermissions()}>申请权限</Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {!immersive && error ? (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertTitle>操作失败</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {!immersive && viewMode !== "apps" && selectedApp ? (
        <section className="flex items-center justify-between gap-3 rounded-card bg-inset px-4 py-3" aria-label="当前应用">
          <div className="min-w-0">
            <p className="text-xs text-muted">{canEditProfiles ? "电脑配置模式" : "当前只共享这个应用"}</p>
            <p className="truncate font-semibold">{selectedApp.appName || selectedApp.title}</p>
          </div>
          <div className="flex items-center gap-2">
            {canEditProfiles ? <Badge variant="outline">配置保存到 Mac</Badge> : null}
            <Button size="sm" variant="ghost" onClick={() => setViewMode("apps")}>更换应用</Button>
          </div>
        </section>
      ) : null}

      {viewMode === "apps" ? (
        <section className="flex flex-col gap-4" aria-labelledby="apps-heading">
          <div>
            <p className="font-utility text-meta uppercase tracking-eyebrow text-muted">第一层 · 应用</p>
            <h2 id="apps-heading" className="mt-1 text-lg font-semibold">{canEditProfiles ? "选择要配置的应用" : "选择手机上要看的应用"}</h2>
            <p className="mt-1 text-body-sm text-muted">应用配置保存在 Mac；手机和电脑都可以继续调整取景与区域布局。</p>
          </div>
          {applicationCatalog.length ? (
            <AppHoneycomb apps={applicationCatalog} onSelect={selectApplication} />
          ) : (
            <Card variant="outlined">
              <CardHeader>
                <CardTitle>{loading ? "正在读取已安装应用…" : "没有找到已安装应用"}</CardTitle>
                <CardDescription>应用目录读取失败；这和窗口是否打开不是一回事。</CardDescription>
              </CardHeader>
            </Card>
          )}
        </section>
      ) : null}

      {viewMode === "regions" && selectedApp && profile ? (
        <section className="flex flex-col gap-4" aria-labelledby="regions-heading">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="font-utility text-meta uppercase tracking-eyebrow text-muted">第二层 · 交互区域</p>
              <h2 id="regions-heading" className="mt-1 text-lg font-semibold">手机交互区域</h2>
              <p className="mt-1 text-body-sm text-muted">取景决定截取 App 的哪里；布局决定它在手机画布上的位置和大小。</p>
            </div>
            {!editing ? <div className="flex flex-wrap justify-end gap-2">
              {profile.regions.length ? (
                <Button
                  size="sm"
                  variant={layoutEditing ? "primary" : "secondary"}
                  onClick={() => setLayoutEditing((value) => !value)}
                >
                  {layoutEditing ? <Check data-icon="inline-start" /> : <PanelsTopLeft data-icon="inline-start" />}
                  {layoutEditing ? "完成布局" : "编辑布局"}
                </Button>
              ) : null}
              <Button size="sm" onClick={beginRegion}><Plus data-icon="inline-start" />添加区域</Button>
            </div> : null}
          </div>

          {editing ? (
            <Card variant="elevated">
              <CardHeader>
                <CardTitle>{editingRegionId ? `调整${draftName}取景` : "在完整 App 上选择区域"}</CardTitle>
                <CardDescription>拖动区域本身改变位置，拖动四个角改变大小；在空白处拖动会重新框选。</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <RemoteCanvas
                  target={selectedApp}
                  stream={stream}
                  onError={handleRemoteError}
                  selectionMode
                  selection={draftRegion}
                  onSelectionChange={setDraftRegion}
                  onSelectionComplete={() => setDraftName((value) => value || `区域 ${profile.regions.length + 1}`)}
                />
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="region-name">区域名称</FieldLabel>
                    <Input
                      id="region-name"
                      value={draftName}
                      placeholder="例如：对话输入区"
                      onChange={(event) => setDraftName(event.target.value)}
                    />
                    <FieldDescription>名称只用于手机端识别，不会触发自动化动作。</FieldDescription>
                  </Field>
                </FieldGroup>
              </CardContent>
              <CardFooter className="gap-2">
                <Button variant="primary" disabled={!draftRegion || !draftName.trim() || savingProfile} onClick={saveRegion}>
                  {editingRegionId ? "保存取景调整" : "保存区域"}
                </Button>
                <Button variant="ghost" onClick={() => { setEditing(false); setEditingRegionId(null); setDraftRegion(null); }}>取消</Button>
              </CardFooter>
            </Card>
          ) : null}

          {!editing && profile.regions.length === 0 ? (
            <Card variant="outlined">
              <CardHeader>
                <CardTitle>还没有交互区域</CardTitle>
                <CardDescription>从完整 App 画面框出输入区、会话区或侧边栏；手机和电脑都能操作。</CardDescription>
              </CardHeader>
              <CardFooter><Button variant="primary" onClick={beginRegion}><Scan data-icon="inline-start" />开始划分</Button></CardFooter>
            </Card>
          ) : null}

          {!editing && profile.regions.length ? (
            <RegionLayoutCanvas
              target={selectedApp}
              stream={stream}
              regions={profile.regions}
              editing={layoutEditing}
              onCommit={(regions) => void persistRegions(regions)}
              onEditCrop={editRegion}
              onRemove={(regionId) => void removeRegion(regionId)}
              onError={handleRemoteError}
            />
          ) : null}
        </section>
      ) : null}

      {viewMode === "regions" && selectedApp && !profile ? (
        <Card variant="outlined">
          <CardHeader>
            <CardTitle>正在读取区域配置…</CardTitle>
            <CardDescription>配置从 Mac Host 获取，不再依赖当前浏览器。</CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      {viewMode === "app" && selectedApp ? (
        <section className="fixed inset-0 overflow-hidden bg-ink" aria-labelledby="app-heading">
          <h2 id="app-heading" className="sr-only">{selectedApp.appName || selectedApp.title}</h2>
          <RemoteCanvas target={selectedApp} stream={stream} region={FULL_REGION} onError={handleRemoteError} fillViewport />
          <div className="absolute inset-x-0 top-0 flex items-center justify-between gap-3 bg-overlay/90 px-3 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] backdrop-blur-xl">
            <Button size="sm" variant="secondary" onClick={() => setViewMode("apps")}><ChevronLeft data-icon="inline-start" />应用</Button>
            <p className="min-w-0 flex-1 truncate text-center text-body-sm font-semibold">{selectedApp.appName || selectedApp.title}</p>
            <Button size="icon-sm" variant="secondary" aria-label="查看交互区域" onClick={() => setViewMode("regions")}><Grid2X2 data-icon="inline-start" /></Button>
            <Button size="icon-sm" variant="secondary" aria-label="进入全屏" onClick={() => void toggleFullscreen()}><Maximize2 data-icon="inline-start" /></Button>
          </div>
          <p className="pointer-events-none absolute inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] rounded-full bg-overlay/90 px-3 py-2 text-center text-xs text-muted shadow-overlay backdrop-blur">
            单指拖动 · 长按右键 · 双指滚动；鼠标左右键与滚轮直通
          </p>
          {error ? <Alert className="absolute inset-x-3 top-20" variant="destructive"><CircleAlert /><AlertDescription>{error}</AlertDescription></Alert> : null}
        </section>
      ) : null}

      {viewMode === "desktop" ? (
        <section className="fixed inset-0 bg-ink" aria-labelledby="desktop-heading">
          <h2 id="desktop-heading" className="sr-only">完整桌面</h2>
          {displayTarget ? (
            <RemoteCanvas target={displayTarget} stream={stream} onError={handleRemoteError} fillViewport />
          ) : <p className="text-body-sm text-muted">没有可用显示器。</p>}
          <div className="absolute inset-x-0 top-0 flex items-center justify-between gap-3 bg-overlay/90 px-3 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] backdrop-blur-xl">
            <Button size="sm" variant="secondary" onClick={() => setViewMode("app")}><Scan data-icon="inline-start" />完整 App</Button>
            <p className="min-w-0 flex-1 truncate text-center text-body-sm font-semibold">完整桌面</p>
            <Button size="icon-sm" variant="secondary" aria-label="进入全屏" onClick={() => void toggleFullscreen()}><Maximize2 data-icon="inline-start" /></Button>
          </div>
          <p className="pointer-events-none absolute inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] rounded-full bg-overlay/90 px-3 py-2 text-center text-xs text-muted shadow-overlay backdrop-blur">
            单指拖动 · 长按右键 · 双指滚动；鼠标左右键与滚轮直通
          </p>
          {error ? <Alert className="absolute inset-x-3 top-20" variant="destructive"><CircleAlert /><AlertDescription>{error}</AlertDescription></Alert> : null}
        </section>
      ) : null}

      {!immersive ? <footer className="fixed inset-x-0 bottom-0 mx-auto w-full max-w-md px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <nav className="grid grid-cols-4 gap-1 rounded-sheet border border-line bg-overlay/95 p-2 shadow-nav backdrop-blur-xl" aria-label="控制层级">
          <Button className="min-w-0 px-2" variant={viewMode === "apps" ? "primary" : "ghost"} size="sm" onClick={() => setViewMode("apps")}><AppWindow />应用</Button>
          <Button className="min-w-0 px-2" variant={viewMode === "regions" ? "primary" : "ghost"} size="sm" disabled={!selectedApp} onClick={() => setViewMode("regions")}><Grid2X2 />区域</Button>
          <Button className="min-w-0 px-2" variant="ghost" size="sm" disabled={!selectedApp} onClick={() => setViewMode("app")}><Scan />App</Button>
          <Button className="min-w-0 px-2" variant="ghost" size="sm" disabled={!displayTarget} onClick={() => setViewMode("desktop")}><Monitor />桌面</Button>
        </nav>
      </footer> : null}
    </main>
  );
}
