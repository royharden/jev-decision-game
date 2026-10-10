export const THEME_COLORS: Record<string, { bg: string; text: string; ring: string; dot: string }> = {
  money: { bg: "bg-emerald-100", text: "text-emerald-800", ring: "ring-emerald-300", dot: "bg-emerald-500" },
  "email & messages": { bg: "bg-sky-100", text: "text-sky-800", ring: "ring-sky-300", dot: "bg-sky-500" },
  "code & infra": { bg: "bg-amber-100", text: "text-amber-800", ring: "ring-amber-300", dot: "bg-amber-500" },
  health: { bg: "bg-rose-100", text: "text-rose-800", ring: "ring-rose-300", dot: "bg-rose-500" },
  "home & IoT": { bg: "bg-teal-100", text: "text-teal-800", ring: "ring-teal-300", dot: "bg-teal-500" },
  "data & privacy": { bg: "bg-indigo-50", text: "text-slate-800", ring: "ring-slate-300", dot: "bg-slate-500" },
};

export function themeStyle(theme: string) {
  return (
    THEME_COLORS[theme] ?? { bg: "bg-slate-100", text: "text-slate-700", ring: "ring-slate-300", dot: "bg-slate-500" }
  );
}

export const OPTION_META: Record<
  string,
  { label: string; icon: "check" | "user" | "ban"; color: string; soft: string }
> = {
  allow: { label: "Allow", icon: "check", color: "bg-emerald-500", soft: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  ask_human: { label: "Ask a human", icon: "user", color: "bg-amber-500", soft: "bg-amber-50 text-amber-700 border-amber-200" },
  block: { label: "Block", icon: "ban", color: "bg-rose-500", soft: "bg-rose-50 text-rose-700 border-rose-200" },
};

export function formatPct(n: number): string {
  return `${Math.round(n * 100)}%`;
}
