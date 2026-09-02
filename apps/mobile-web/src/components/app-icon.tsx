import { useEffect, useRef, useState } from "react";
import { cn } from "@slice/design-system";
import { useRemoteClient } from "../remote-client-context";

const iconCache = new Map<string, Promise<string | null>>();
const iconQueue: Array<() => void> = [];
const MAX_CONCURRENT_ICON_REQUESTS = 4;
let activeIconRequests = 0;

function scheduleIconRequest(load: () => Promise<Blob>) {
  return new Promise<Blob>((resolve, reject) => {
    const run = () => {
      activeIconRequests += 1;
      void load().then(resolve, reject).finally(() => {
        activeIconRequests -= 1;
        iconQueue.shift()?.();
      });
    };
    if (activeIconRequests < MAX_CONCURRENT_ICON_REQUESTS) run();
    else iconQueue.push(run);
  });
}

function loadIcon(cacheKey: string, load: () => Promise<Blob>) {
  let icon = iconCache.get(cacheKey);
  if (!icon) {
    icon = scheduleIconRequest(load)
      .then((blob) => URL.createObjectURL(blob))
      .catch((error) => {
        // A transient P2P failure must not poison the icon cache forever.
        iconCache.delete(cacheKey);
        throw error;
      });
    iconCache.set(cacheKey, icon);
  }
  return icon;
}

type AppIconTarget = {
  appName?: string | null;
  title?: string;
  bundleIdentifier?: string | null;
  path?: string | null;
};

export function AppIcon({ target, className }: { target: AppIconTarget; className?: string }) {
  const remote = useRemoteClient();
  const [source, setSource] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const [retry, setRetry] = useState(0);
  const rootRef = useRef<HTMLSpanElement>(null);
  const name = target.appName || target.title || "?";
  const iconKey = target.bundleIdentifier || target.path || null;

  useEffect(() => { setRetry(0); }, [iconKey]);

  useEffect(() => {
    const element = rootRef.current;
    if (!element || visible) return;
    const item = element.closest<HTMLElement>("[role='listitem']");
    if (!item) {
      setVisible(true);
      return;
    }
    const check = () => {
      const rect = item.getBoundingClientRect();
      const intersects = rect.right >= -80 && rect.bottom >= -80
        && rect.left <= window.innerWidth + 80 && rect.top <= window.innerHeight + 80;
      if (Number.parseFloat(item.style.opacity || "0") > 0.15 && intersects) {
        setVisible(true);
        observer.disconnect();
      }
    };
    const observer = new MutationObserver(check);
    observer.observe(item, { attributes: true, attributeFilter: ["style"] });
    check();
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: number | null = null;
    setSource(null);
    if (visible && iconKey) {
      void loadIcon(iconKey, () => remote.appIcon(target.bundleIdentifier || "", target.path || undefined))
        .then((icon) => { if (!cancelled) setSource(icon); })
        .catch(() => {
          if (!cancelled && retry === 0) {
            retryTimer = window.setTimeout(() => setRetry(1), 1_500);
          }
        });
    }
    return () => {
      cancelled = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
    };
  }, [iconKey, remote, retry, target.bundleIdentifier, target.path, visible]);

  return (
    <span ref={rootRef} className={cn("grid overflow-hidden rounded-[22%] bg-surface shadow-overlay", className)} aria-hidden="true">
      {source ? (
        <img className="size-full object-contain" src={source} alt="" draggable={false} />
      ) : (
        <span className="grid size-full place-items-center font-display text-xl text-ink">{name.slice(0, 2)}</span>
      )}
    </span>
  );
}
