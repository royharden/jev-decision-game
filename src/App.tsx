import { useCallback, useEffect, useState } from "react";
import { Home, BarChart3, Trophy, Sparkles } from "lucide-react";
import { fetchAllCards, fetchCardsByTheme, fetchDailyDeck } from "@/lib/api";
import type { CardResult, CardRow } from "@/lib/types";
import HomeView from "@/views/Home";
import Game from "@/views/Game";
import Results from "@/views/Results";
import Stats from "@/views/Stats";
import Leaderboard from "@/views/Leaderboard";
import MakeCard from "@/views/MakeCard";

type Screen =
  | { name: "home" }
  | { name: "game"; cards: CardRow[]; mode: string; label: string }
  | { name: "results"; results: CardResult[]; label: string }
  | { name: "stats" }
  | { name: "leaderboard" }
  | { name: "makecard" };

const MODE_LABELS: Record<string, string> = {
  daily: "Daily deck",
  endless: "Endless",
  crowd: "Agree with the crowd?",
};

export default function App() {
  const [screen, setScreen] = useState<Screen>({ name: "home" });
  const [allCards, setAllCards] = useState<CardRow[]>([]);

  useEffect(() => {
    fetchAllCards()
      .then(setAllCards)
      .catch(() => setAllCards([]));
  }, []);

  const startDaily = useCallback(async () => {
    const deck = await fetchDailyDeck().catch(() => []);
    if (deck.length) {
      setScreen({ name: "game", cards: deck, mode: "daily", label: "Daily deck" });
    }
  }, []);

  const startEndless = useCallback(
    async (theme?: string) => {
      const cards = theme ? await fetchCardsByTheme(theme) : allCards;
      if (cards.length) {
        const shuffled = [...cards].sort(() => Math.random() - 0.5);
        setScreen({ name: "game", cards: shuffled, mode: "endless", label: theme ? `Endless · ${theme}` : "Endless" });
      }
    },
    [allCards]
  );

  const startCrowd = useCallback(() => {
    const shuffled = [...allCards].sort(() => Math.random() - 0.5).slice(0, 10);
    if (shuffled.length) {
      setScreen({ name: "game", cards: shuffled, mode: "crowd", label: "Agree with the crowd?" });
    }
  }, [allCards]);

  const nav = (
    <nav className="fixed bottom-0 left-0 right-0 z-40 border-t border-slate-200 bg-white/90 backdrop-blur">
      <div className="mx-auto flex max-w-3xl items-center justify-around py-2">
        {[
          { icon: Home, label: "Home", active: screen.name === "home", onClick: () => setScreen({ name: "home" }) },
          { icon: BarChart3, label: "Stats", active: screen.name === "stats", onClick: () => setScreen({ name: "stats" }) },
          { icon: Trophy, label: "Ranks", active: screen.name === "leaderboard", onClick: () => setScreen({ name: "leaderboard" }) },
          { icon: Sparkles, label: "Create", active: screen.name === "makecard", onClick: () => setScreen({ name: "makecard" }) },
        ].map(({ icon: Icon, label, active, onClick }) => (
          <button
            key={label}
            onClick={onClick}
            className={`flex flex-col items-center gap-0.5 px-4 py-1 text-[11px] font-semibold transition ${
              active ? "text-emerald-600" : "text-slate-400 hover:text-slate-600"
            }`}
          >
            <Icon className="h-5 w-5" />
            {label}
          </button>
        ))}
      </div>
    </nav>
  );

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-slate-100 text-slate-900">
      {screen.name === "home" && (
        <HomeView
          onDaily={startDaily}
          onEndless={startEndless}
          onCrowd={startCrowd}
          onMakeCard={() => setScreen({ name: "makecard" })}
        />
      )}
      {screen.name === "game" && (
        <Game
          key={screen.mode + screen.label}
          cards={screen.cards}
          mode={screen.mode}
          onFinished={(results) => setScreen({ name: "results", results, label: screen.label })}
          onExit={() => setScreen({ name: "home" })}
        />
      )}
      {screen.name === "results" && (
        <Results
          results={screen.results}
          modeLabel={screen.label}
          onPlayAgain={() => setScreen({ name: "home" })}
          onHome={() => setScreen({ name: "home" })}
        />
      )}
      {screen.name === "stats" && <Stats onExit={() => setScreen({ name: "home" })} />}
      {screen.name === "leaderboard" && <Leaderboard onExit={() => setScreen({ name: "home" })} />}
      {screen.name === "makecard" && <MakeCard onExit={() => setScreen({ name: "home" })} />}
      {nav}
      <div className="h-16" />
    </div>
  );
}
