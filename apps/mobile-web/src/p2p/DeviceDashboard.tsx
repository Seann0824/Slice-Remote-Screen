import { useEffect, useState, type ReactNode } from "react";
import { Badge, Button, Card, CardDescription, CardHeader, CardTitle, cn } from "@slice/design-system";
import { Bell, ChevronDown, CircleHelp, Computer, Info, Menu, Monitor, Plus, Settings, Smartphone, Star, UserCircle } from "lucide-react";
import { signalingHttpUrl } from "./signaling";

type DeviceInfo = {
  device_name: string;
  created_at: string;
};

type DeviceStatus = {
  device: DeviceInfo | null;
  online: boolean;
};

async function loadDeviceStatus() {
  const response = await fetch(signalingHttpUrl("/api/device"), {
    credentials: "include",
    cache: "no-store",
  });
  if (!response.ok) throw new Error("无法读取设备状态");
  return await response.json() as DeviceStatus;
}

function NavigationItem({ active, icon, label, onClick }: { active?: boolean; icon: ReactNode; label: string; onClick?: () => void }) {
  return (
    <button
      className={cn(
        "flex w-full items-center gap-3 rounded-control px-3 py-2.5 text-left text-body-sm transition hover:bg-selected",
        active ? "bg-selected font-medium" : "text-muted",
      )}
      type="button"
      onClick={onClick}
    >
      {icon}
      <span>{label}</span>
      {active ? <ChevronDown className="ml-auto" /> : null}
    </button>
  );
}

export function DeviceDashboard({ onConnect }: { onConnect: () => void }) {
  const [status, setStatus] = useState<DeviceStatus | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    void loadDeviceStatus()
      .then(setStatus)
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, []);

  const device = status?.device;

  return (
    <main className="min-h-dvh bg-canvas">
      <div className="mx-auto grid min-h-dvh max-w-[1180px] grid-cols-1 md:grid-cols-[220px_1fr]">
        <aside className="border-b border-line bg-inset/70 p-4 md:border-b-0 md:border-r md:p-5">
          <div className="mb-8 flex items-center gap-2 px-2 text-title-sm font-semibold tracking-tight">
            <span className="grid size-8 place-items-center rounded-control bg-ink text-canvas">S</span>
            <span>Slice Remote</span>
          </div>
          <div className="flex flex-col gap-1">
            <p className="px-3 pb-2 text-label font-medium uppercase tracking-eyebrow text-muted">我的设备</p>
            <NavigationItem active icon={<Monitor />} label="全部设备" />
            <NavigationItem icon={<Computer />} label="电脑" />
            <NavigationItem icon={<Smartphone />} label="手机 / 平板" />
          </div>
          <div className="mt-8 flex flex-col gap-1">
            <p className="px-3 pb-2 text-label font-medium uppercase tracking-eyebrow text-muted">远程协助</p>
            <NavigationItem icon={<Star />} label="收藏设备" />
            <NavigationItem icon={<CircleHelp />} label="帮助与反馈" />
          </div>
          <Button className="mt-10 w-full justify-start" variant="ghost">
            <Settings />
            设置
          </Button>
        </aside>

        <section className="min-w-0">
          <header className="flex min-h-16 items-center justify-between border-b border-line bg-surface px-5 md:px-10">
            <div className="flex items-center gap-3">
              <Button className="md:hidden" size="icon" variant="ghost" aria-label="打开菜单"><Menu /></Button>
              <h1 className="m-0 text-title-sm font-semibold">全部设备</h1>
            </div>
            <div className="flex items-center gap-1 text-muted">
              <Button size="icon" variant="ghost" aria-label="添加设备"><Plus /></Button>
              <Button size="icon" variant="ghost" aria-label="通知"><Bell /></Button>
              <Button size="icon" variant="ghost" aria-label="账户"><UserCircle /></Button>
            </div>
          </header>

          <div className="flex flex-col gap-8 p-5 md:p-10">
            <Card className="border-line-strong bg-surface" variant="outlined">
              <CardHeader className="flex-row items-start justify-between gap-4">
                <div className="flex gap-3">
                  <Info className="mt-0.5 shrink-0 text-link" />
                  <div>
                    <CardTitle className="text-body-sm">先在 Mac 上安装 Host App</CardTitle>
                    <CardDescription className="mt-1">安装后登录同一个 Slice 账号，设备会自动出现在这里，不需要 token。</CardDescription>
                  </div>
                </div>
                <Button size="icon-sm" variant="ghost" aria-label="关闭提示"><span aria-hidden="true">×</span></Button>
              </CardHeader>
            </Card>

            {error ? <p className="m-0 text-body-sm text-danger-ink">{error}</p> : null}

            <section aria-labelledby="computer-group">
              <div className="mb-3 flex items-center gap-2">
                <ChevronDown />
                <h2 id="computer-group" className="m-0 text-body-sm font-semibold">电脑</h2>
                <Badge variant="secondary">{device ? 1 : 0}</Badge>
              </div>
              {device ? (
                <Card className="transition hover:border-line-strong hover:shadow-nav" variant="outlined">
                  <div className="flex flex-wrap items-center gap-4 p-4 md:p-5">
                    <div className="grid size-12 shrink-0 place-items-center rounded-control bg-ink text-canvas">
                      <Computer />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="m-0 truncate text-body-sm font-semibold">{device.device_name}</h3>
                        <Badge variant={status?.online ? "default" : "secondary"}>{status?.online ? "在线" : "离线"}</Badge>
                      </div>
                      <p className="m-0 mt-1 text-body-sm text-muted">{status?.online ? "可以开始远程操作" : "打开 Mac Host App 后会自动上线"}</p>
                    </div>
                    <Button disabled={!status?.online} onClick={onConnect}>
                      进入控制台
                    </Button>
                  </div>
                </Card>
              ) : (
                <Card variant="outlined">
                  <CardHeader>
                    <CardTitle>还没有已连接的 Mac</CardTitle>
                    <CardDescription>先打开 Slice Remote Screen Host，登录账号并完成 macOS 权限授权。</CardDescription>
                  </CardHeader>
                </Card>
              )}
            </section>

            <section aria-labelledby="mobile-group">
              <div className="mb-3 flex items-center gap-2">
                <ChevronDown />
                <h2 id="mobile-group" className="m-0 text-body-sm font-semibold">手机 / 平板</h2>
                <Badge variant="secondary">0</Badge>
              </div>
              <Card className="border-dashed" variant="outlined">
                <CardHeader className="items-center text-center">
                  <Smartphone className="text-muted" />
                  <CardTitle className="text-body-sm">控制设备会自动记录</CardTitle>
                  <CardDescription>当前浏览器就是控制端，不需要额外安装手机 App。</CardDescription>
                </CardHeader>
              </Card>
            </section>
          </div>
        </section>
      </div>
    </main>
  );
}
