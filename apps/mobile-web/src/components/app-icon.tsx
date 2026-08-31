import { useEffect, useRef, useState } from "react";
import { cn } from "@slice/design-system";
import { hostApi } from "../api";

const iconCache = new Map<string, Promise<string | null>>();

function loadIcon(bundleIdentifier: string) {
  let icon = iconCache.get(bundleIdentifier);
  if (!icon) {
    icon = hostApi.appIcon(bundleIdentifier)
      .then((blob) => URL.createObjectURL(blob))
      .catch(() => null);
    iconCache.set(bundleIdentifier, icon);
  }
  return icon;
}

type AppIconTarget = {
  appName?: string | null;
  title?: string;
  bundleIdentifier?: string | null;
};

export function AppIcon({ target, className }: { target: AppIconTarget; className?: string }) {
  const [source, setSource] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const name = target.appName || target.title || "?";

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
    setSource(null);
    if (visible && target.bundleIdentifier) {
      void loadIcon(target.bundleIdentifier).then((icon) => { if (!cancelled) setSource(icon); });
    }
    return () => { cancelled = true; };
  }, [target.bundleIdentifier, visible]);

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
