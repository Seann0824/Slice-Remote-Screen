export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = Exclude<ThemePreference, "system">;

export const THEME_STORAGE_KEY = "slice-remote-screen.theme";
const DARK_THEME_QUERY = "(prefers-color-scheme: dark)";

export function isThemePreference(value: string | null): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

export function readThemePreference(): ThemePreference {
  if (typeof window === "undefined") return "system";
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(value) ? value : "system";
  } catch {
    return "system";
  }
}

export function resolveTheme(
  preference: ThemePreference,
  systemDark = typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(DARK_THEME_QUERY).matches,
): ResolvedTheme {
  return preference === "system" ? (systemDark ? "dark" : "light") : preference;
}

export function applyTheme(theme: ResolvedTheme) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  const themeColor = getComputedStyle(root).getPropertyValue("--color-canvas").trim();
  if (themeColor) {
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", themeColor);
  }
}

export function initializeTheme() {
  const preference = readThemePreference();
  applyTheme(resolveTheme(preference));
  return preference;
}

export function watchSystemTheme(onChange: (dark: boolean) => void) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => undefined;
  }
  const media = window.matchMedia(DARK_THEME_QUERY);
  const handleChange = (event: MediaQueryListEvent) => onChange(event.matches);
  media.addEventListener("change", handleChange);
  return () => media.removeEventListener("change", handleChange);
}

