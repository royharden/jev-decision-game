export const OPTIONS = ["allow", "ask_human", "block"] as const;
export type Option = (typeof OPTIONS)[number];
export type Probabilities = Record<Option | "uncertain", number>;

export const THEMES = [
  "money",
  "email & messages",
  "code & infra",
  "health",
  "home & IoT",
  "data & privacy",
] as const;
export type Theme = (typeof THEMES)[number];

export type CardSource = "seed" | "llm" | "player";

export interface CardRow {
  id: string;
  agent_role: string;
  action: string;
  context: string;
  theme: string;
  source: CardSource;
  jev_response: JevResponse | null;
  verdict_probs: Probabilities | null;
  harm: number | null;
  order_sensitive: boolean | null;
  latency_ms: number | null;
  cost_usd: number | null;
  created_at: string;
}

export interface NoulAnswer {
  type: "noul";
  noul: number;
  confidence?: number;
}

export interface ChoiceAnswer {
  type: "choice";
  choice: Option | "uncertain";
  confidence: number;
  probabilities: Probabilities;
}

export interface ScoreAnswer {
  type: "score";
  score: number;
  confidence: number;
  legend?: Record<string, string>;
  probabilities?: Record<string, number>;
}

export interface JevAnswers {
  verdict?: ChoiceAnswer;
  verdict_rev?: ChoiceAnswer;
  harm?: ScoreAnswer;
  reversible?: NoulAnswer;
  in_scope?: NoulAnswer;
  info_enough?: NoulAnswer;
  [key: string]: unknown;
}

export interface JevResponse {
  answers: JevAnswers;
  model: string;
  usage: { input_tokens: number; output_tokens: number };
  latency_ms?: number;
  cost_usd?: number;
  order_sensitive?: boolean;
  cached?: boolean;
}

export interface VoteRow {
  id: string;
  card_id: string;
  player_id: string;
  nickname: string;
  pick: Option;
  confidence: number;
  points: number;
  mode: string;
  created_at: string;
}

export interface GameMode {
  id: "daily" | "endless" | "crowd" | "theme";
  label: string;
}

export interface Answer {
  pick: Option;
  confidence: number; // 0.5–1
  seconds: number | null;
}

export interface CardResult {
  card: CardRow;
  answer: Answer;
  points: number;
  brier: number;
  jevBrier: number;
  crowdBrier: number;
  contrarian: boolean;
  streakAfter: number;
  crowd: Record<Option, number> | null;
  earlyCrowd: boolean;
  commentary: string;
  /** Jev's verdict probabilities at answer time, for the results grid. */
  jevProbsSnapshot: Probabilities;
}
