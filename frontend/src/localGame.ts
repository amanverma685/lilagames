import type { GameMode, LeaderboardRow, MatchStatePayload } from "./gameTypes";
import { getSessionPlayerId } from "./nakamaClient";

export function localWsUrl(): string {
  return import.meta.env.VITE_LOCAL_WS_URL || "ws://127.0.0.1:8787";
}

export function isLocalBackend(): boolean {
  return import.meta.env.VITE_BACKEND === "local";
}

/** HTTP API for leaderboard etc. (see local-server). */
export function localHttpBase(): string {
  return import.meta.env.VITE_LOCAL_HTTP_URL || "http://127.0.0.1:8788";
}

/**
 * Loads leaderboard over the same WebSocket server as gameplay (port 8787 by default).
 * Use this when the optional HTTP leaderboard port (8788) is not running — avoids "Failed to fetch".
 */
export function fetchLocalLeaderboardRows(nickname: string): Promise<LeaderboardRow[]> {
  const url = localWsUrl();
  const name = nickname.trim().slice(0, 24) || "Player";
  const userId = getSessionPlayerId();

  return new Promise((resolve, reject) => {
    let settled = false;
    let serverReady = false;
    const ws = new WebSocket(url);

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(tid);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      fn();
    };

    const tid = window.setTimeout(() => {
      finish(() => reject(new Error("Timed out connecting to the local game server.")));
    }, 12_000);

    ws.onerror = () => {
      finish(() =>
        reject(
          new Error(
            "Could not connect to the local game server. From the project root run: npm run dev:local-server",
          ),
        ),
      );
    };

    ws.onclose = () => {
      if (settled) return;
      finish(() =>
        reject(
          new Error(
            serverReady
              ? "Connection closed before the leaderboard was received."
              : "Could not connect to the local game server. From the project root run: npm run dev:local-server",
          ),
        ),
      );
    };

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "hello", userId, nickname: name }));
    };

    ws.onmessage = (ev) => {
      let msg: { type?: string; rows?: unknown };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.type === "ready" && !serverReady) {
        serverReady = true;
        ws.send(JSON.stringify({ type: "leaderboard" }));
        return;
      }
      if (msg.type === "leaderboard" && Array.isArray(msg.rows)) {
        finish(() => resolve(msg.rows as LeaderboardRow[]));
      }
    };
  });
}

export type LocalGameHandlers = {
  onReady: (userId: string) => void;
  onQueued: () => void;
  onSnapshot: (state: MatchStatePayload, leaderboard: LeaderboardRow[] | null) => void;
  onError: (code: string) => void;
  onQueueCancelled: () => void;
  onLeaderboard: (rows: LeaderboardRow[]) => void;
  onRoomCreated?: (roomCode: string, mode: GameMode) => void;
  onRoomCancelled?: () => void;
  onRematchOffer?: (fromUsername: string) => void;
  onRematchDeclined?: () => void;
  onRematchWithdrawn?: () => void;
  onRematchAborted?: () => void;
};

/**
 * Thin WebSocket client for local-server (authoritative snapshots).
 */
export class LocalGameSession {
  private ws: WebSocket | null = null;
  private handlers: LocalGameHandlers;
  private userId: string;
  private nickname: string;
  private connectPromise: Promise<void> | null = null;

  constructor(nickname: string, handlers: LocalGameHandlers) {
    this.nickname = nickname;
    this.userId = getSessionPlayerId();
    this.handlers = handlers;
  }

  getUserId() {
    return this.userId;
  }

  connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }
    if (this.ws?.readyState === WebSocket.CONNECTING && this.connectPromise) {
      return this.connectPromise;
    }
    this.disconnect();

    this.connectPromise = new Promise((resolve, reject) => {
      let serverReady = false;
      let finished = false;
      const url = localWsUrl();
      const ws = new WebSocket(url);
      this.ws = ws;

      const fail = (msg: string) => {
        if (finished || serverReady) return;
        finished = true;
        this.connectPromise = null;
        reject(new Error(msg));
      };

      ws.onclose = () => {
        if (this.ws !== ws) return;
        this.ws = null;
        if (!serverReady) {
          fail(`WebSocket closed (${url})`);
        } else {
          // Was connected; allow connect() to open a new socket next time.
          this.connectPromise = null;
        }
      };
      ws.onerror = () => fail(`WebSocket error (${url})`);

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "hello", userId: this.userId, nickname: this.nickname }));
      };

      ws.onmessage = (ev) => {
        let msg: {
          type?: string;
          userId?: string;
          state?: MatchStatePayload;
          leaderboard?: LeaderboardRow[] | null;
          code?: string;
          rows?: LeaderboardRow[];
          roomCode?: string;
          mode?: string;
          fromUsername?: string;
        };
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        if (msg.type === "ready" && !serverReady) {
          serverReady = true;
          this.handlers.onReady(msg.userId || this.userId);
          if (!finished) {
            finished = true;
            resolve();
          }
          return;
        }
        if (!serverReady) return;

        if (msg.type === "queued") {
          this.handlers.onQueued();
          return;
        }
        if (msg.type === "queue_cancelled") {
          this.handlers.onQueueCancelled();
          return;
        }
        if (msg.type === "room_created" && msg.roomCode) {
          const m = msg.mode === "timed" ? "timed" : "classic";
          this.handlers.onRoomCreated?.(msg.roomCode, m);
          return;
        }
        if (msg.type === "room_cancelled") {
          this.handlers.onRoomCancelled?.();
          return;
        }
        if (msg.type === "rematch_offer") {
          this.handlers.onRematchOffer?.(String(msg.fromUsername ?? "Player"));
          return;
        }
        if (msg.type === "rematch_declined") {
          this.handlers.onRematchDeclined?.();
          return;
        }
        if (msg.type === "rematch_withdrawn") {
          this.handlers.onRematchWithdrawn?.();
          return;
        }
        if (msg.type === "rematch_aborted") {
          this.handlers.onRematchAborted?.();
          return;
        }
        if (msg.type === "snapshot") {
          this.handlers.onSnapshot(msg.state as MatchStatePayload, msg.leaderboard ?? null);
          return;
        }
        if (msg.type === "error") {
          this.handlers.onError(msg.code || "error");
          return;
        }
        if (msg.type === "leaderboard" && Array.isArray(msg.rows)) {
          this.handlers.onLeaderboard(msg.rows as LeaderboardRow[]);
        }
      };
    });
    return this.connectPromise;
  }

  private sendOrThrow(obj: object) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(
        "Not connected to the local game server. From the project root run: npm run dev:local-server",
      );
    }
    this.ws.send(JSON.stringify(obj));
  }

  queue(mode: GameMode) {
    this.sendOrThrow({ type: "queue", mode });
  }

  startBot(mode: GameMode) {
    this.sendOrThrow({ type: "start_bot", mode });
  }

  createRoom(mode: GameMode) {
    this.sendOrThrow({ type: "create_room", mode });
  }

  joinRoom(roomCode: string) {
    this.sendOrThrow({ type: "join_room", roomCode: roomCode.trim().toUpperCase() });
  }

  cancelRoom() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "cancel_room" }));
    }
  }

  rematchPropose() {
    this.sendOrThrow({ type: "rematch_propose" });
  }

  rematchAccept() {
    this.sendOrThrow({ type: "rematch_accept" });
  }

  rematchDecline() {
    this.sendOrThrow({ type: "rematch_decline" });
  }

  cancelQueue() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "cancel_queue" }));
    }
  }

  move(index: number) {
    this.sendOrThrow({ type: "move", index });
  }

  leaveMatch() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "leave_match" }));
    }
  }

  requestLeaderboard() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "leaderboard" }));
    }
  }

  disconnect() {
    this.connectPromise = null;
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
  }
}
