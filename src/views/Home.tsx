import { useEffect, useState } from "react";
import { Sparkles, Zap, Users, Plus, ChevronRight } from "lucide-react";
import { fetchLeaderboard, type LeaderboardRow } from "@/lib/api";
import { getNickname } from "@/lib/player";

interface Props {
  onDaily: () => void;
  onEndless: (theme?: string) => void;
  onCrowd: () => void;
  onMakeCard: () => void;
}

const THEME_CHIPS = ["money", "email & messages", "code & infra", "health", "home & IoT", "data & privacy"];

export default function Home({ onDaily, onEndless, onCrowd, onMakeCard }: Props) {
  const [board, setBoard] = useState<LeaderboardRow[]>([]);
  const [nickname, setNickname] = useState("");

  useEffect(() => {
    setNickname(getNickname());
    fetchLeaderboard(3).then(setBoard).catch(() => setBoard([]));
  }, []);

  return (
    <div className="mx-auto max-w-3xl px-4 pb-16">
      <div className="pt-10 pb-8 text-center">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 shadow-lg shadow-emerald-200">
          <Sparkles className="h-7 w-7 text-white" />
        </div>
        <h1 className="text-4xl font-black tracking-tight text-slate-900 sm:text-5xl">
          Should the agent do <span className="text-emerald-600">this</span>?
        </h1>
        <p className="mx-auto mt-3 max-w-md text-slate-600">
          Judge AI-agent calls. Beat Jev's probabilities. See where the crowd lands.
        </p>
        <p className="mt-2 text-sm text-slate-400">
          Playing as <span className="font-semibold text-slate-600">{nickname}</span>
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <button
          onClick={onDaily}
          className="group relative overflow-hidden rounded-3xl bg-slate-900 p-6 text-left text-white shadow-xl transition-transform hover:-translate-y-0.5"
        >
          <div className="absolute -right-6 -top-6 h-28 w-28 rounded-full bg-emerald-500/20 blur-xl" />
          <Zap className="mb-3 h-6 w-6 text-emerald-400" />
          <div className="text-xl font-bold">Daily deck</div>
          <div className="mt-1 text-sm text-slate-300">10 cards. Same for everyone today.</div>
          <ChevronRight className="absolute bottom-5 right-5 h-5 w-5 text-slate-500 transition-transform group-hover:translate-x-1" />
        </button>

        <button
          onClick={() => onEndless()}
          className="group relative overflow-hidden rounded-3xl border border-slate-200 bg-white p-6 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md"
        >
          <Users className="mb-3 h-6 w-6 text-sky-500" />
          <div className="text-xl font-bold text-slate-900">Endless</div>
          <div className="mt-1 text-sm text-slate-500">Random cards, filtered by theme.</div>
          <ChevronRight className="absolute bottom-5 right-5 h-5 w-5 text-slate-300 transition-transform group-hover:translate-x-1" />
        </button>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {THEME_CHIPS.map((t) => (
          <button
            key={t}
            onClick={() => onEndless(t)}
            className="rounded-full border border-slate-200 bg-white px-4 py-1.5 text-sm font-medium text-slate-600 transition hover:border-emerald-300 hover:bg-emerald-50 hover:text-emerald-700"
          >
            {t}
          </button>
        ))}
      </div>

      <button
        onClick={onCrowd}
        className="mt-4 w-full rounded-3xl border-2 border-dashed border-amber-300 bg-amber-50/60 p-5 text-left transition hover:bg-amber-50"
      >
        <div className="font-bold text-amber-900">Agree with the crowd?</div>
        <div className="text-sm text-amber-700">
          A variant: predict what most players picked, instead of what Jev thinks.
        </div>
      </button>

      <button
        onClick={onMakeCard}
        className="mt-4 flex w-full items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white py-3 text-sm font-semibold text-slate-700 transition hover:border-slate-300 hover:bg-slate-50"
      >
        <Plus className="h-4 w-4" /> Make a card
      </button>

      {board.length > 0 && (
        <div className="mt-8">
          <h2 className="mb-3 text-sm font-bold uppercase tracking-wider text-slate-400">Leaderboard</h2>
          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
            {board.slice(0, 5).map((row, i) => (
              <div
                key={row.nickname + i}
                className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5 text-sm last:border-0"
              >
                <span className="font-medium text-slate-700">
                  <span className="mr-2 text-slate-400">{i + 1}.</span> {row.nickname}
                </span>
                <span className="font-bold text-emerald-600">{row.avg_points} avg</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
