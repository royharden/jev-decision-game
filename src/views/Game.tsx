import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Check, User, Ban, Flame, Award, ChevronDown, Info } from "lucide-react";
import {
  OPTIONS,
  type Answer,
  type CardResult,
  type CardRow,
  type Option,
  type Probabilities,
} from "@/lib/types";
import { jevTruthDistribution, scoreAnswer, scoreAnswerVsCrowd } from "@/lib/scoring";
import { fetchCrowd, fetchRevealExtras, judgeCard, submitVote, type CrowdSplit } from "@/lib/api";
import { formatPct, OPTION_META, themeStyle } from "@/lib/ui";
import { CardFace, GameShell } from "./GameShell";

interface Props {
  cards: CardRow[];
  mode: string;
  onFinished: (results: CardResult[]) => void;
  onExit: () => void;
}

const OPTION_ICONS = { allow: Check, ask_human: User, block: Ban } as const;

function StackedBar({ probs, highlight }: { probs: Record<string, number>; highlight?: Option }) {
  const entries = OPTIONS.map((o) => ({ o, v: probs[o] ?? 0 }));
  return (
    <div className="flex h-3 w-full overflow-hidden rounded-full bg-slate-100">
      {entries.map(({ o, v }) => (
        <div
          key={o}
          className={`${OPTION_META[o].color} transition-all duration-700 ${
            highlight === o ? "ring-2 ring-inset ring-white/70" : ""
          }`}
          style={{ width: `${v * 100}%` }}
        />
      ))}
    </div>
  );
}

function Meter({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="mb-1 flex justify-between text-xs font-medium text-slate-500">
        <span>{label}</span>
        <span className="tabular-nums">{Math.round(value * 100)}%</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
        <div className="h-full rounded-full bg-slate-400 transition-all duration-700" style={{ width: `${value * 100}%` }} />
      </div>
    </div>
  );
}

export default function Game({ cards, mode, onFinished, onExit }: Props) {
  const [idx, setIdx] = useState(0);
  const [pick, setPick] = useState<Option | null>(null);
  const [confidence, setConfidence] = useState(0.75);
  const [phase, setPhase] = useState<"card" | "reveal">("card");
  const [results, setResults] = useState<CardResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [crowd, setCrowd] = useState<CrowdSplit | null>(null);
  const [commentary, setCommentary] = useState("");
  const [showRaw, setShowRaw] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const [timerOn, setTimerOn] = useState(false);
  const startedAt = useRef<number>(Date.now());
  const preloaded = useRef<Set<string>>(new Set());

  const card = cards[idx] ?? null;
  const streak = useMemo(
    () => results.filter((r) => r.streakAfter > 0).length,
    [results]
  );
  const totalPoints = useMemo(() => results.reduce((a, r) => a + r.points, 0), [results]);

  const load = useCallback(async () => {
    if (!card) return;
    setLoading(true);
    setError(null);
    try {
      if (!card.jev_response?.answers?.verdict) {
        await judgeCard(card);
      }
      setLoading(false);
    } catch (e: any) {
      setError(e?.message ?? "Could not reach Jev.");
      setLoading(false);
    }
  }, [card]);

  useEffect(() => {
    load();
  }, [load]);

  // Preload Jev judgment for the next card while the player thinks.
  useEffect(() => {
    const next = cards[idx + 1];
    if (next && !next.jev_response?.answers?.verdict && !preloaded.current.has(next.id)) {
      preloaded.current.add(next.id);
      judgeCard(next).catch(() => {});
    }
  }, [idx, cards]);

  // Timer
  useEffect(() => {
    if (phase !== "card" || !timerOn || pick) return;
    setSecondsLeft(15);
    const t = setInterval(() => {
      setSecondsLeft((s) => {
        if (s === null) return s;
        if (s <= 1) {
          clearInterval(t);
          setPick("ask_human");
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [phase, timerOn, pick, idx]);

  const cardProbs: Probabilities = useMemo(() => {
    return (
      (card?.jev_response?.answers?.verdict?.probabilities as Probabilities | undefined) ?? {
        allow: 1 / 3,
        ask_human: 1 / 3,
        block: 1 / 3,
        uncertain: 0,
      }
    );
  }, [card]);

  const answer = useCallback(
    async (o: Option) => {
      if (pick || !card) return;
      setPick(o);
      const seconds = Math.round((Date.now() - startedAt.current) / 1000);
      const usedProbs = cardProbs;
      try {
        const crowdSplit = await fetchCrowd(card.id);
        const scored =
          mode === "crowd"
            ? (() => {
                const vs = scoreAnswerVsCrowd({
                  pick: o,
                  confidence,
                  crowdCounts: crowdSplit.counts,
                  jevProbs: usedProbs,
                });
                return {
                  points: vs.points,
                  brier: vs.brier,
                  jevBrier: 0,
                  crowdBrier: 0,
                  contrarian: false,
                };
              })()
            : scoreAnswer({
          pick: o,
          confidence,
          jevProbs: usedProbs,
          crowdCounts: crowdSplit.counts,
        });
        const jevTop = (Object.entries(jevTruthDistribution(usedProbs)) as [Option, number][])
          .sort((a, b) => b[1] - a[1])[0][0];
        const prevStreak = results.length ? results[results.length - 1].streakAfter : 0;
        const streakAfter = jevTop === o ? prevStreak + 1 : 0;
        // Points come back from submit-vote, which scores the vote server-side.
        const { points } = await submitVote({ card, pick: o, confidence, mode, seconds });
        setCrowd(crowdSplit);
        fetchRevealExtras(card, crowdSplit, usedProbs).then((r) => setCommentary(r.commentary));
        setPhase("reveal");
        setResults((prev) => [
          ...prev,
          {
            card,
            answer: { pick: o, confidence, seconds },
            points,
            brier: scored.brier,
            jevBrier: scored.jevBrier,
            crowdBrier: scored.crowdBrier,
            contrarian: scored.contrarian,
            streakAfter,
            crowd: crowdSplit.counts,
            earlyCrowd: crowdSplit.early,
            commentary: "",
            jevProbsSnapshot: usedProbs,
          },
        ]);
      } catch (e: any) {
        setError(e?.message ?? "Could not save your answer.");
        setPick(null);
      }
    },
    [pick, card, confidence, cardProbs, results, mode]
  );

  const nextCard = () => {
    if (idx + 1 >= cards.length) {
      onFinished(results);
      return;
    }
    setIdx(idx + 1);
    setPick(null);
    setPhase("card");
    setCrowd(null);
    setCommentary("");
    setShowRaw(false);
    startedAt.current = Date.now();
  };

  const currentResult = results.length > idx ? results[idx] : null;
  const jevAnswer = card?.jev_response?.answers ?? {};

  return (
    <GameShell card={card} loading={loading} error={error} onRetry={load}>
      <div className="mx-auto max-w-2xl px-4 pb-24 pt-6">
        <div className="mb-4 flex items-center justify-between">
          <button onClick={onExit} className="text-sm font-medium text-slate-400 hover:text-slate-600">
            Exit
          </button>
          <div className="flex items-center gap-3 text-sm font-semibold">
            <span className="flex items-center gap-1 text-amber-600">
              <Flame className="h-4 w-4" /> {streak}
            </span>
            <span className="flex items-center gap-1 text-emerald-600">
              <Award className="h-4 w-4" /> {totalPoints}
            </span>
          </div>
        </div>

        <AnimatePresence mode="wait">
          {phase === "card" && card && (
            <motion.div
              key={`card-${card.id}`}
              initial={{ rotateY: 90, opacity: 0 }}
              animate={{ rotateY: 0, opacity: 1 }}
              exit={{ rotateY: -90, opacity: 0 }}
              transition={{ duration: 0.35 }}
            >
              <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-xl shadow-slate-200/50">
                <CardFace card={card} index={idx} total={cards.length} />
                <div className="mt-6 grid grid-cols-3 gap-3">
                  {OPTIONS.map((o) => {
                    const Meta = OPTION_META[o];
                    const Icon = OPTION_ICONS[Meta.icon as keyof typeof OPTION_ICONS];
                    return (
                      <button
                        key={o}
                        onClick={() => answer(o)}
                        className={`flex flex-col items-center gap-2 rounded-2xl border-2 py-4 font-bold transition-all hover:-translate-y-0.5 active:scale-95 ${Meta.soft}`}
                      >
                        <Icon className="h-5 w-5" />
                        {Meta.label}
                      </button>
                    );
                  })}
                </div>
                <div className="mt-5">
                  <div className="mb-1 flex items-center justify-between text-sm">
                    <span className="font-medium text-slate-600">How sure?</span>
                    <span className="font-bold tabular-nums text-slate-900">{Math.round(confidence * 100)}%</span>
                  </div>
                  <input
                    type="range"
                    min={50}
                    max={100}
                    value={Math.round(confidence * 100)}
                    onChange={(e) => setConfidence(Number(e.target.value) / 100)}
                    className="w-full accent-emerald-600"
                  />
                </div>
                <button
                  onClick={() => setTimerOn(!timerOn)}
                  className={`mt-4 text-xs font-medium ${timerOn ? "text-rose-500" : "text-slate-400"}`}
                >
                  {timerOn
                    ? `Timer on — ${secondsLeft ?? 15}s left (click to stop)`
                    : "15-second timer (optional, click to enable)"}
                </button>
              </div>
            </motion.div>
          )}

          {phase === "reveal" && card && currentResult && (
            <motion.div
              key={`reveal-${card.id}`}
              initial={{ y: 40, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ duration: 0.4 }}
            >
              <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-xl shadow-slate-200/50">
                <div className="mb-4 flex items-center justify-between">
                  <h3 className="text-lg font-bold text-slate-900">The reveal</h3>
                  <div className="flex items-center gap-2">
                    {card.order_sensitive && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-500">
                        <Info className="h-3 w-3" /> Jev wasn't sure
                      </span>
                    )}
                    {currentResult.contrarian && (
                      <span className="rounded-full bg-purple-50 px-2.5 py-1 text-xs font-bold text-purple-600">
                        Contrarian hit +20
                      </span>
                    )}
                  </div>
                </div>

                <div className="space-y-4">
                  <div>
                    <div className="mb-1 flex justify-between text-sm">
                      <span className="font-semibold text-slate-700">You</span>
                      <span className="text-slate-400">
                        {OPTION_META[currentResult.answer.pick].label} · {formatPct(currentResult.answer.confidence)}
                      </span>
                    </div>
                    <StackedBar
                      probs={playerProbs(currentResult.answer.pick, currentResult.answer.confidence)}
                      highlight={currentResult.answer.pick}
                    />
                  </div>
                  <div>
                    <div className="mb-1 flex justify-between text-sm">
                      <span className="font-semibold text-slate-700">Jev</span>
                      <span className="text-slate-400">
                        {OPTION_META[jevTopPick(cardProbs)].label} ·{" "}
                        {formatPct(Math.max(...OPTIONS.map((o) => cardProbs[o] ?? 0)))}
                      </span>
                    </div>
                    <StackedBar probs={cardProbs} highlight={jevTopPick(cardProbs)} />
                  </div>
                  {crowd && crowd.total > 0 && (
                    <div>
                      <div className="mb-1 flex justify-between text-sm">
                        <span className="font-semibold text-slate-700">
                          {crowd.early ? "Early crowd" : "Crowd"}
                        </span>
                        <span className="text-slate-400">{crowd.total} vote{crowd.total === 1 ? "" : "s"}</span>
                      </div>
                      <StackedBar probs={crowd.counts} highlight={jevTopPick(crowd.counts)} />
                    </div>
                  )}
                </div>

                <div className="mt-5 grid grid-cols-3 gap-4 rounded-2xl bg-slate-50 p-4">
                  <Meter label="Harm if wrong" value={harmMeter(jevAnswer)} />
                  <Meter label="Reversible" value={jevAnswer.reversible?.noul ?? 0.5} />
                  <Meter label="In scope" value={jevAnswer.in_scope?.noul ?? 0.5} />
                  <Meter label="Info enough" value={jevAnswer.info_enough?.noul ?? 0.5} />
                  <div className="col-span-2 text-right">
                    <div className="text-xs font-medium text-slate-500">Points earned</div>
                    <div className="text-2xl font-black text-emerald-600">+{currentResult.points}</div>
                    <div className="text-[11px] text-slate-400">
                      Brier {currentResult.brier.toFixed(2)} · Jev vs crowd {currentResult.jevBrier.toFixed(2)} · Crowd vs
                      Jev {currentResult.crowdBrier.toFixed(2)}
                    </div>
                  </div>
                </div>

                {commentary && (
                  <div className="mt-4 rounded-2xl border border-emerald-100 bg-emerald-50/60 p-4 text-sm leading-relaxed text-emerald-900">
                    {commentary}
                  </div>
                )}

                <button
                  onClick={() => setShowRaw(!showRaw)}
                  className="mt-4 flex items-center gap-1 text-xs font-medium text-slate-400 hover:text-slate-600"
                >
                  <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showRaw ? "rotate-180" : ""}`} />
                  Raw Jev JSON
                </button>
                {showRaw && (
                  <pre className="mt-2 max-h-64 overflow-auto rounded-xl bg-slate-900 p-4 text-[11px] leading-relaxed text-emerald-300">
                    {JSON.stringify(card.jev_response, null, 2)}
                  </pre>
                )}

                <button
                  onClick={nextCard}
                  className="mt-5 w-full rounded-2xl bg-slate-900 py-3.5 font-bold text-white transition hover:bg-slate-800 active:scale-[0.99]"
                >
                  {idx + 1 >= cards.length ? "See results" : "Next card"}
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </GameShell>
  );
}

function playerProbs(pick: Option, c: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const o of OPTIONS) out[o] = o === pick ? c : (1 - c) / 2;
  return out;
}

function jevTopPick(probs: Record<string, number>): Option {
  return OPTIONS.reduce((best, o) => ((probs[o] ?? 0) > (probs[best] ?? 0) ? o : best), OPTIONS[0]);
}

function harmMeter(jevAnswers: Record<string, any>): number {
  const score = jevAnswers?.harm?.score;
  if (typeof score !== "number") return 0;
  return Math.max(0, Math.min(1, score / 4));
}
