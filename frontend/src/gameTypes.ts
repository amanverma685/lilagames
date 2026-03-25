/** Must match `BOT_ID` in `local-server/server.mjs` and bot id in Nakama `server/main.go`. */
export const LOCAL_BOT_USER_ID = "__bot__";

export type GameMode = "classic" | "timed";

export interface PlayerSlot {
  userId: string;
  username: string;
  symbol: number;
}

export interface MatchStatePayload {
  board: number[];
  players: PlayerSlot[];
  turnSymbol: number;
  status: "playing" | "win" | "draw" | "forfeit" | "abandoned";
  winnerUserId: string;
  reason: string;
  mode: string;
  deadlineUnix: number;
  /** Present when the match was created via `create_bot_match` (optional; bot is also detectable via `LOCAL_BOT_USER_ID`). */
  vsBot?: boolean;
}

export interface LeaderboardRow {
  rank?: number;
  ownerId?: string;
  username?: string;
  score?: number;
  subscore?: number;
  metadata?: Record<string, unknown>;
}

/** Nakama / JSON may ship `metadata` as a JSON string, or snake_case fields on the row. */
export function coerceLeaderboardMetadata(raw: unknown): Record<string, unknown> {
  if (raw == null) return {};
  if (typeof raw === "string") {
    const t = raw.trim();
    if (!t) return {};
    try {
      const p = JSON.parse(t) as unknown;
      if (p !== null && typeof p === "object" && !Array.isArray(p)) return p as Record<string, unknown>;
    } catch {
      /* ignore */
    }
    return {};
  }
  if (typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  return {};
}

function metaNumber(meta: Record<string, unknown>, ...keys: string[]): number {
  for (const key of keys) {
    const v = meta[key];
    if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
    if (typeof v === "string" && v.trim() !== "") {
      const n = Number(v);
      if (Number.isFinite(n)) return Math.trunc(n);
    }
  }
  return 0;
}

/** Wins / losses / draws / streak / score for UI — reads metadata robustly, then subscore for streak. */
export function leaderboardDisplayStats(row: LeaderboardRow): {
  wins: number;
  losses: number;
  draws: number;
  streak: number;
  score: number;
} {
  const meta = coerceLeaderboardMetadata(row.metadata);
  const wins = metaNumber(meta, "wins", "Wins");
  const losses = metaNumber(meta, "losses", "Losses");
  const draws = metaNumber(meta, "draws", "Draws");
  const hasStreakInMeta = Object.prototype.hasOwnProperty.call(meta, "streak") || Object.prototype.hasOwnProperty.call(meta, "Streak");
  const streakFromMeta = metaNumber(meta, "streak", "Streak");
  const streakFromSub = Number.isFinite(Number(row.subscore)) ? Math.trunc(Number(row.subscore)) : 0;
  const streak = hasStreakInMeta ? streakFromMeta : streakFromSub;
  const score = Number.isFinite(Number(row.score)) ? Math.trunc(Number(row.score)) : 0;
  return { wins, losses, draws, streak, score };
}

export function normalizeLeaderboardRowFromApi(row: unknown): LeaderboardRow | null {
  if (row === null || typeof row !== "object" || Array.isArray(row)) return null;
  const r = row as Record<string, unknown>;
  const rankRaw = r.rank ?? r.Rank;
  let rank: number | undefined;
  if (typeof rankRaw === "number" && Number.isFinite(rankRaw)) rank = Math.trunc(rankRaw);
  else if (typeof rankRaw === "string" && rankRaw.trim() !== "") {
    const n = Number(rankRaw);
    if (Number.isFinite(n)) rank = Math.trunc(n);
  }
  const ownerRaw = r.ownerId ?? r.owner_id ?? r.OwnerId;
  const ownerId = ownerRaw != null && String(ownerRaw).trim() !== "" ? String(ownerRaw) : undefined;
  const usernameRaw = r.username ?? r.Username;
  const username = typeof usernameRaw === "string" ? usernameRaw : undefined;
  const scoreRaw = r.score ?? r.Score;
  const score =
    typeof scoreRaw === "number" && Number.isFinite(scoreRaw)
      ? Math.trunc(scoreRaw)
      : typeof scoreRaw === "string" && scoreRaw.trim() !== ""
        ? Math.trunc(Number(scoreRaw))
        : undefined;
  const subRaw = r.subscore ?? r.Subscore;
  const subscore =
    typeof subRaw === "number" && Number.isFinite(subRaw)
      ? Math.trunc(subRaw)
      : typeof subRaw === "string" && subRaw.trim() !== ""
        ? Math.trunc(Number(subRaw))
        : undefined;
  const metaRaw = r.metadata ?? r.Metadata;
  return {
    rank,
    ownerId,
    username,
    score,
    subscore,
    metadata: coerceLeaderboardMetadata(metaRaw),
  };
}

export function parseLeaderboardRpcPayload(payload: unknown): LeaderboardRow[] {
  let raw: unknown;
  if (payload === undefined || payload === null) return [];
  if (typeof payload === "string") {
    try {
      raw = JSON.parse(payload) as unknown;
    } catch {
      return [];
    }
  } else {
    raw = payload;
  }
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeLeaderboardRowFromApi).filter((x): x is LeaderboardRow => x !== null);
}

/**
 * One row per nickname (case-insensitive). Keeps the first entry from the server list
 * (best rank / score). Reuses the same name across tabs/devices no longer repeats.
 */
export function dedupeLeaderboardByUsername(rows: LeaderboardRow[]): LeaderboardRow[] {
  const seen = new Set<string>();
  const out: LeaderboardRow[] = [];
  let anon = 0;
  for (const r of rows) {
    const raw = (r.username ?? "").trim();
    const key =
      raw.length > 0 ? raw.toLowerCase() : `__owner:${r.ownerId ?? `anon_${anon++}`}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out.map((r, i) => ({ ...r, rank: i + 1 }));
}
