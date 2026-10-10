import { AlertTriangle, RotateCw, Bot } from "lucide-react";
import type { CardRow } from "@/lib/types";
import { themeStyle } from "@/lib/ui";

interface Props {
  card: CardRow | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  children: React.ReactNode;
}

export function GameShell({ card, loading, error, onRetry, children }: Props) {
  if (loading) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 text-slate-500">
        <RotateCw className="h-6 w-6 animate-spin" />
        <p className="text-sm">Dealing cards...</p>
      </div>
    );
  }
  if (error) {
    return (
      <div className="mx-auto mt-16 max-w-md rounded-3xl border border-rose-200 bg-rose-50 p-6 text-center">
        <AlertTriangle className="mx-auto mb-2 h-6 w-6 text-rose-500" />
        <p className="text-sm text-rose-700">{error}</p>
        <button
          onClick={onRetry}
          className="mt-4 rounded-xl bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-700"
        >
          Try again
        </button>
      </div>
    );
  }
  if (!card) {
    return (
      <div className="mx-auto mt-16 max-w-md rounded-3xl border border-slate-200 bg-white p-8 text-center">
        <p className="text-slate-600">No cards available for this mode yet.</p>
        <button
          onClick={onRetry}
          className="mt-4 rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
        >
          Back
        </button>
      </div>
    );
  }
  return <>{children}</>;
}

export function CardFace({ card, index, total }: { card: CardRow; index: number; total: number }) {
  const ts = themeStyle(card.theme);
  return (
    <div className="mb-4">
      <div className="mb-3 flex items-center justify-between">
        <span className={`inline-flex items-center gap-1.5 rounded-full ${ts.bg} ${ts.text} px-3 py-1 text-xs font-semibold ring-1 ${ts.ring}`}>
          <Bot className="h-3.5 w-3.5" />
          {card.agent_role}
        </span>
        <span className="text-xs font-medium text-slate-400">
          {index + 1} / {total}
        </span>
      </div>
      <h2 className="text-2xl font-extrabold leading-tight tracking-tight text-slate-900 sm:text-3xl">
        {card.action}
      </h2>
      <p className="mt-3 text-slate-600 leading-relaxed">{card.context}</p>
    </div>
  );
}
