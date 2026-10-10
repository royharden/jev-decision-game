const PLAYER_ID_KEY = "jev.player_id";
const NICKNAME_KEY = "jev.nickname";

const NICK_PREFIXES = [
  "Swift", "Calm", "Bright", "Sharp", "Bold", "Quick", "Steady", "Clever",
];
const NICK_SUFFIXES = [
  "Judge", "Agent", "Owl", "Compass", "Anchor", "Pilot", "Scale", "Ledger",
];

function randomId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `p-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

export function getPlayerId(): string {
  let id = localStorage.getItem(PLAYER_ID_KEY);
  if (!id) {
    id = randomId();
    localStorage.setItem(PLAYER_ID_KEY, id);
  }
  return id;
}

export function getNickname(): string {
  let nick = localStorage.getItem(NICKNAME_KEY);
  if (!nick) {
    nick = `${NICK_PREFIXES[Math.floor(Math.random() * NICK_PREFIXES.length)]}-${
      NICK_SUFFIXES[Math.floor(Math.random() * NICK_SUFFIXES.length)]
    }${Math.floor(Math.random() * 90 + 10)}`;
    localStorage.setItem(NICKNAME_KEY, nick);
  }
  return nick;
}

export function setNickname(nick: string): void {
  localStorage.setItem(NICKNAME_KEY, nick.trim().slice(0, 24) || getNickname());
}
