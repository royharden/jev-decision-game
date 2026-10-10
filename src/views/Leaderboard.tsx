import { useEffect, useState } from "react";
import { Trophy } from "lucide-react";
import { fetchLeaderboard, type LeaderboardRow } from "@/lib/api";

interface Props {
  onExit: () => void;
}

export default function Leaderboard({ onExit }: Props) {
  const [rows, setRows] = useState<LeaderboardRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"alltime" | "today">("alltime");

  useEffect(() => {
    setLoading(true);
    fetchLeaderboard(tab === "today" ? 1 : 10)
      .then(setRows)
      .finally(() => setLoading(false));
  }, [tab]);

  return (
    <div className="mx-auto max-w-2xl px-4 pb-24 pt-6">
      <button onClick={onExit} className="mb-4 text-sm font-medium text-slate-400 hover:text-slate-600">
        Back
      </button>
      <div className="flex items-center gap-2">
        <Trophy className="h-6 w-6 text-amber-500" />
        <h1 className="text-2xl font-black tracking-tight text-slate-900">Leaderboard</h1>
      </div>
      <p className="mt-1 text-sm text-slate-500">Ranked by average points per card.</p>

      <div className="mt-4 flex gap-2">
        <button
          onClick={() => setTab("today")}
          className={`rounded-full px-4 py-1.5 text-sm font-semibold transition ${
            tab === "today" ? "bg-slate-900 text-white" : "bg-white text-slate-600 border border-slate-200"
          }`}
        >
          Today
        </button>
        <button
          onClick={() => setTab("alltime")}
          className={`rounded-full px-4 py-1.5 text-sm font-semibold transition ${
            tab === "alltime" ? "bg-slate-900 text-white" : "bg-white text-slate-600 border border-slate-200"
          }`}
        >
          All time (min 10 cards)
        </button>
      </div>

      {loading ? (
        <div className="py-16 text-center text-sm text-slate-400">Loading...</div>
      ) : rows.length === 0 ? (
        <div className="py-16 text-center text-sm text-slate-400">
          No qualifying players yet — play 10 cards to appear here.
        </div>
      ) : (
        <div className="mt-4 overflow-hidden rounded-2xl border border-slate-200 bg-white">
          {rows.map((row, i) => (
            <div
              key={row.nickname + i}
              className="flex items-center justify-between border-b border-slate-100 px-4 py-3 last:border-0"
            >
              <div className="flex items-center gap-3">
                <span
                  className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-black ${
                    i === 0
                      ? "bg-amber-100 text-amber-700"
                      : i === 1
                      ? "bg-slate-200 text-slate-600"
                      : i === 2
                      ? "bg-orange-100 text-orange-700"
                      : "bg-slate-50 text-slate-400"
                  }`}
                >
                  {i + 1}
                </span>
                <div>
                  <div className="text-sm font-semibold text-slate-800">{row.nickname}</div>
                  <div className="text-xs text-slate-400">{row.cards} cards</div>
                </div>
              </div>
              <div className="text-right">
                <div className="text-sm font-black text-emerald-600">{row.avg_points}</div>
                <div className="text-[11px] text-slate-400">{row.total_points} total</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
