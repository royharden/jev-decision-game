import { useEffect, useMemo, useState } from "react";
import {
  ScatterChart, Scatter, XAxis, YAxis, ZAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  BarChart, Bar, Cell,
} from "recharts";
import { Activity, DollarSign, Target } from "lucide-react";
import { fetchPlayerVotes } from "@/lib/api";
import { fetchAllCards } from "@/lib/api";
import type { CardRow, Option, VoteRow } from "@/lib/types";
import { jevTruthDistribution } from "@/lib/scoring";

interface Props {
  onExit: () => void;
}

const BINS = [50, 60, 70, 80, 90, 100];

function bucketOf(c: number): number {
  const pct = Math.round(c * 100);
  for (let i = BINS.length - 1; i >= 0; i--) {
    if (pct >= BINS[i]) return BINS[i];
  }
  return 50;
}

export default function Stats({ onExit }: Props) {
  const [votes, setVotes] = useState<VoteRow[]>([]);
  const [cards, setCards] = useState<CardRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([fetchPlayerVotes(), fetchAllCards()])
      .then(([v, c]) => {
        setVotes(v);
        setCards(c);
      })
      .finally(() => setLoading(false));
  }, []);

  const cardById = useMemo(() => new Map(cards.map((c) => [c.id, c])), [cards]);

  const calibration = useMemo(() => {
    const bins = BINS.map((b) => ({ bucket: b, stated: 0, matched: 0, count: 0 }));
    for (const v of votes) {
      const card = cardById.get(v.card_id);
      if (!card?.verdict_probs) continue;
      const truth = jevTruthDistribution(card.verdict_probs as any);
      const jevTop = (Object.entries(truth) as [Option, number][]).sort((a, b) => b[1] - a[1])[0][0];
      const bin = bins.find((b) => b.bucket === bucketOf(v.confidence));
      if (!bin) continue;
      bin.count += 1;
      bin.stated += v.confidence;
      if (v.pick === jevTop) bin.matched += 1;
    }
    return bins
      .filter((b) => b.count > 0)
      .map((b) => ({
        bucket: `${b.bucket}%`,
        stated: Math.round((b.stated / b.count) * 100),
        matched: Math.round((b.matched / b.count) * 100),
        count: b.count,
      }));
  }, [votes, cardById]);

  const byTheme = useMemo(() => {
    const map = new Map<string, { total: number; count: number; matched: number }>();
    for (const v of votes) {
      const card = cardById.get(v.card_id);
      if (!card) continue;
      const entry = map.get(card.theme) ?? { total: 0, count: 0, matched: 0 };
      entry.total += v.points ?? 0;
      entry.count += 1;
      const probs = card.verdict_probs;
      if (probs) {
        const truth = jevTruthDistribution(probs as any);
        const jevTop = (Object.entries(truth) as [Option, number][]).sort((a, b) => b[1] - a[1])[0][0];
        if (v.pick === jevTop) entry.matched += 1;
      }
      map.set(card.theme, entry);
    }
    return [...map.entries()].map(([theme, e]) => ({
      theme,
      avg: e.count ? Math.round(e.total / e.count) : 0,
      accuracy: e.count ? Math.round((e.matched / e.count) * 100) : 0,
    }));
  }, [votes, cardById]);

  const totalCost = useMemo(
    () => cards.reduce((a, c) => a + (c.cost_usd ?? 0), 0),
    [cards]
  );

  if (loading) {
    return <div className="p-16 text-center text-sm text-slate-400">Loading your stats...</div>;
  }

  if (votes.length === 0) {
    return (
      <div className="mx-auto max-w-md px-4 pt-20 text-center">
        <Target className="mx-auto mb-3 h-8 w-8 text-slate-300" />
        <p className="text-slate-500">Play a few cards and your calibration chart will appear here.</p>
        <button onClick={onExit} className="mt-4 rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white">
          Back
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 pb-24 pt-6">
      <button onClick={onExit} className="mb-4 text-sm font-medium text-slate-400 hover:text-slate-600">
        Back
      </button>
      <h1 className="text-2xl font-black tracking-tight text-slate-900">Your stats</h1>
      <p className="mt-1 text-sm text-slate-500">{votes.length} cards answered</p>

      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <Activity className="mb-2 h-4 w-4 text-emerald-500" />
          <div className="text-2xl font-black text-slate-900">
            {Math.round(votes.reduce((a, v) => a + v.points, 0) / votes.length)}
          </div>
          <div className="text-xs text-slate-500">avg points per card</div>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <DollarSign className="mb-2 h-4 w-4 text-amber-500" />
          <div className="text-2xl font-black text-slate-900">${totalCost.toFixed(4)}</div>
          <div className="text-xs text-slate-500">Jev cost so far (all players)</div>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <Target className="mb-2 h-4 w-4 text-sky-500" />
          <div className="text-2xl font-black text-slate-900">
            {Math.round((votes.filter((v) => v.points >= 60).length / votes.length) * 100)}%
          </div>
          <div className="text-xs text-slate-500">cards scored 60+ points</div>
        </div>
      </div>

      <div className="mt-6 rounded-2xl border border-slate-200 bg-white p-5">
        <h2 className="text-sm font-bold text-slate-700">Calibration: stated confidence vs. matched Jev</h2>
        <p className="mb-3 text-xs text-slate-400">Points on the diagonal mean perfectly calibrated.</p>
        <div style={{ width: "100%", height: 260 }}>
          <ResponsiveContainer>
            <ScatterChart margin={{ top: 10, right: 20, bottom: 20, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis
                type="number"
                dataKey="stated"
                name="Stated confidence"
                domain={[45, 105]}
                tick={{ fontSize: 11, fill: "#94a3b8" }}
              />
              <YAxis
                type="number"
                dataKey="matched"
                name="Matched Jev %"
                domain={[0, 105]}
                tick={{ fontSize: 11, fill: "#94a3b8" }}
              />
              <ZAxis type="number" dataKey="count" range={[60, 400]} />
              <Tooltip
                formatter={(val: any, name: any) => [`${val}${name === "Matched Jev %" ? "%" : ""}`, String(name)]}
                contentStyle={{ borderRadius: 12, fontSize: 12 }}
              />
              <Scatter data={calibration} fill="#10b981" />
            </ScatterChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-5">
        <h2 className="mb-3 text-sm font-bold text-slate-700">Average points by theme</h2>
        <div style={{ width: "100%", height: 240 }}>
          <ResponsiveContainer>
            <BarChart data={byTheme} margin={{ top: 5, right: 10, bottom: 5, left: -20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
              <XAxis dataKey="theme" tick={{ fontSize: 10, fill: "#94a3b8" }} interval={0} />
              <YAxis tick={{ fontSize: 11, fill: "#94a3b8" }} />
              <Tooltip contentStyle={{ borderRadius: 12, fontSize: 12 }} />
              <Bar dataKey="avg" radius={[6, 6, 0, 0]}>
                {byTheme.map((_, i) => (
                  <Cell key={i} fill={["#10b981", "#0ea5e9", "#f59e0b", "#f43f5e", "#14b8a6", "#64748b"][i % 6]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
