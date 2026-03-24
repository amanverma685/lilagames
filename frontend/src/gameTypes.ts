/** Must match `BOT_ID` in `local-server/server.mjs` (human vs bot matches). */
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
}

export interface LeaderboardRow {
  rank?: number;
  ownerId?: string;
  username?: string;
  score?: number;
  subscore?: number;
  metadata?: Record<string, unknown>;
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
