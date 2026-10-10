import { useState } from "react";
import { CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { submitPlayerCard } from "@/lib/api";
import { THEMES } from "@/lib/types";

interface Props {
  onExit: () => void;
}

export default function MakeCard({ onExit }: Props) {
  const [agentRole, setAgentRole] = useState("");
  const [action, setAction] = useState("");
  const [context, setContext] = useState("");
  const [theme, setTheme] = useState<string>(THEMES[0]);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const valid = agentRole.trim().length > 5 && action.trim().length > 5 && context.trim().length > 10;

  const submit = async () => {
    if (!valid || submitting) return;
    setSubmitting(true);
    setResult(null);
    try {
      const out = await submitPlayerCard({
        agent_role: agentRole.trim(),
        action: action.trim(),
        context: context.trim(),
        theme,
      });
      if (out.accepted) {
        setResult({ ok: true, message: "Card accepted! It will appear in Endless mode for everyone." });
        setAgentRole("");
        setAction("");
        setContext("");
      } else {
        setResult({ ok: false, message: out.reason ?? "The safety check rejected this card." });
      }
    } catch (e: any) {
      setResult({ ok: false, message: e?.message ?? "Something went wrong." });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl px-4 pb-24 pt-6">
      <button onClick={onExit} className="mb-4 text-sm font-medium text-slate-400 hover:text-slate-600">
        Back
      </button>
      <h1 className="text-2xl font-black tracking-tight text-slate-900">Make a card</h1>
      <p className="mt-1 text-sm text-slate-500">
        Describe an AI agent, the action it wants to take, and the facts around it. Jev checks that it reads
        like a real agent decision and passes a safety screen before it's published.
      </p>

      <div className="mt-6 space-y-4 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <div>
          <label className="mb-1 block text-sm font-semibold text-slate-700">Who is the agent?</label>
          <input
            value={agentRole}
            onChange={(e) => setAgentRole(e.target.value)}
            placeholder="e.g. A travel booking agent at an airline"
            className="w-full rounded-xl border border-slate-200 px-4 py-2.5 text-sm outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-semibold text-slate-700">What does it want to do?</label>
          <textarea
            value={action}
            onChange={(e) => setAction(e.target.value)}
            rows={2}
            placeholder="e.g. Cancel and rebook 40 passengers onto a costlier flight"
            className="w-full rounded-xl border border-slate-200 px-4 py-2.5 text-sm outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-semibold text-slate-700">What's the context?</label>
          <textarea
            value={context}
            onChange={(e) => setContext(e.target.value)}
            rows={3}
            placeholder="The facts that make this a close call — include numbers."
            className="w-full rounded-xl border border-slate-200 px-4 py-2.5 text-sm outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-semibold text-slate-700">Theme</label>
          <div className="flex flex-wrap gap-2">
            {THEMES.map((t) => (
              <button
                key={t}
                onClick={() => setTheme(t)}
                className={`rounded-full px-3 py-1.5 text-xs font-semibold transition ${
                  theme === t
                    ? "bg-emerald-600 text-white"
                    : "border border-slate-200 bg-white text-slate-600 hover:border-emerald-300"
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        {result && (
          <div
            className={`flex items-start gap-2 rounded-xl p-3 text-sm ${
              result.ok ? "bg-emerald-50 text-emerald-800" : "bg-rose-50 text-rose-700"
            }`}
          >
            {result.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0" />}
            {result.message}
          </div>
        )}

        <button
          onClick={submit}
          disabled={!valid || submitting}
          className="flex w-full items-center justify-center gap-2 rounded-2xl bg-slate-900 py-3 font-bold text-white transition enabled:hover:bg-slate-800 disabled:opacity-40"
        >
          {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
          {submitting ? "Jev is reviewing your card..." : "Submit card"}
        </button>
      </div>
    </div>
  );
}
