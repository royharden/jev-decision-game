import { motion } from "framer-motion";
import { Share2, RotateCcw, Home, Trophy } from "lucide-react";
import { type CardResult, type Option } from "@/lib/types";
import { jevTruthDistribution } from "@/lib/scoring";
import { OPTION_META } from "@/lib/ui";

interface Props {
  results: CardResult[];
  modeLabel: string;
  onPlayAgain: () => void;
  onHome: () => void;
}

function jevTopOf(probsSnapshot: Record<Option, number>): Option {
  return (Object.entries(probsSnapshot) as [Option, number][]).sort((a, b) => b[1] - a[1])[0][0];
}

function resultSquare(r: CardResult): string {
  const jevTop = jevTopOf(r.jevProbsSnapshot);
  if (r.answer.pick === jevTop) {
    return r.answer.confidence >= 0.75 ? "\u{1F7E9}" : "\u{1F7E8}"; // green / yellow
  }
  return "\u{1F7E5}"; // red
}

export default function Results({ results, modeLabel, onPlayAgain, onHome }: Props) {
  const totalPoints = results.reduce((a, r) => a + r.points, 0);
  const matches = results.filter((r) => jevTopOf(r.jevProbsSnapshot) === r.answer.pick).length;
  const bestStreak = results.reduce((m, r) => Math.max(m, r.streakAfter), 0);
  const grid = results.map(resultSquare).join("");

  const share = () => {
    const text = `Jev Decision Game — ${modeLabel}\n${grid}\n${totalPoints} pts · ${matches}/${results.length} matched Jev · best streak ${bestStreak}`;
    if (navigator.share) {
      navigator.share({ text }).catch(() => {});
    } else {
      navigator.clipboard?.writeText(text).catch(() => {});
    }
  };

  return (
    <div className="mx-auto max-w-2xl px-4 pb-24 pt-10">
      <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}>
        <div className="rounded-3xl bg-slate-900 p-8 text-center text-white shadow-2xl">
          <Trophy className="mx-auto mb-3 h-10 w-10 text-amber-400" />
          <div className="text-sm font-medium text-slate-400">{modeLabel} complete</div>
          <div className="mt-1 text-5xl font-black tracking-tight">{totalPoints}</div>
          <div className="mt-1 text-sm text-slate-400">points</div>
          <div className="mt-4 flex justify-center gap-6 text-sm">
            <div>
              <div className="text-xl font-bold text-emerald-400">{matches}/{results.length}</div>
              <div className="text-slate-400">matched Jev</div>
            </div>
            <div>
              <div className="text-xl font-bold text-amber-400">{bestStreak}</div>
              <div className="text-slate-400">best streak</div>
            </div>
          </div>
          <div className="mt-5 select-none text-2xl tracking-widest">{grid}</div>
        </div>
      </motion.div>

      <div className="mt-6 space-y-3">
        {results.map((r, i) => (
          <motion.div
            key={r.card.id + i}
            initial={{ x: -20, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            transition={{ delay: i * 0.05 }}
            className="rounded-2xl border border-slate-200 bg-white p-4"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">{r.card.theme}</div>
                <div className="mt-0.5 text-sm font-semibold text-slate-800">{r.card.action}</div>
                <div className="mt-1 text-xs text-slate-500">
                  You: {OPTION_META[r.answer.pick].label} · Jev: {OPTION_META[jevTopOf(r.jevProbsSnapshot)].label}
                  {r.contrarian && <span className="ml-2 font-bold text-purple-600">+20 contrarian</span>}
                </div>
              </div>
              <div className="shrink-0 text-right">
                <div className="text-lg font-black text-emerald-600">+{r.points}</div>
                <div className="text-[11px] text-slate-400">Brier {r.brier.toFixed(2)}</div>
              </div>
            </div>
          </motion.div>
        ))}
      </div>

      <div className="mt-8 grid grid-cols-3 gap-3">
        <button
          onClick={share}
          className="flex flex-col items-center gap-1 rounded-2xl border border-slate-200 bg-white py-3 text-xs font-semibold text-slate-700 hover:bg-slate-50"
        >
          <Share2 className="h-4 w-4" /> Share
        </button>
        <button
          onClick={onPlayAgain}
          className="flex flex-col items-center gap-1 rounded-2xl bg-slate-900 py-3 text-xs font-semibold text-white hover:bg-slate-800"
        >
          <RotateCcw className="h-4 w-4" /> Play again
        </button>
        <button
          onClick={onHome}
          className="flex flex-col items-center gap-1 rounded-2xl border border-slate-200 bg-white py-3 text-xs font-semibold text-slate-700 hover:bg-slate-50"
        >
          <Home className="h-4 w-4" /> Home
        </button>
      </div>
    </div>
  );
}
