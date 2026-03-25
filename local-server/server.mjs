/**
 * Local authoritative tic-tac-toe over WebSocket (no Nakama / Docker).
 * Human vs human (queue) or human vs minimax bot.
 */
import http from "http";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.LOCAL_WS_PORT || 8787);
const HTTP_PORT = Number(process.env.LOCAL_HTTP_PORT || 8788);
const TURN_SEC = 30;
const BOT_ID = "__bot__";

/** @typedef {{ userId: string, username: string, symbol: number }} Player */

/** @type {Map<string, { username: string, wins: number, losses: number, draws: number, streak: number, score: number }>} */
const stats = new Map();

/** @type {Array<{ ws: import('ws'), userId: string, nickname: string, mode: string }>} */
const queue = [];

/** @type {Map<string, Match>} */
const matches = new Map();

/** @type {Map<string, { hostWs: import('ws'), mode: string }>} */
const waitingRooms = new Map();

/**
 * After a human vs human match ends, both sockets can negotiate rematch.
 * @type {Map<string, { wsA: import('ws'), wsB: import('ws'), mode: string, proposalFrom: string | null, order: { userId: string, username: string, symbol: number }[] }>}
 */
const rematchByKey = new Map();

let matchIdSeq = 1;

const ROOM_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function makeRoomCode() {
  let s = "";
  for (let i = 0; i < 6; i++) s += ROOM_CHARS[Math.floor(Math.random() * ROOM_CHARS.length)];
  return s;
}

function cancelWaitingRoom(ws) {
  const c = ws.__waitingRoomCode;
  if (c && waitingRooms.get(c)?.hostWs === ws) {
    waitingRooms.delete(c);
    delete ws.__waitingRoomCode;
  }
}

/** @returns {[string, object] | null} */
function findRematchSlot(ws) {
  for (const [key, slot] of rematchByKey) {
    if (slot.wsA === ws || slot.wsB === ws) return [key, slot];
  }
  return null;
}

function removeRematchForWs(ws) {
  for (const [key, slot] of [...rematchByKey.entries()]) {
    if (slot.wsA !== ws && slot.wsB !== ws) continue;
    rematchByKey.delete(key);
    const other = slot.wsA === ws ? slot.wsB : slot.wsA;
    if (other && other.readyState === 1) {
      other.send(JSON.stringify({ type: "rematch_aborted" }));
    }
  }
}

class Match {
  /**
   * @param {string} id
   * @param {string} mode
   * @param {import('ws')|null} wsA
   * @param {import('ws')|null} wsB
   * @param {Player} playerA
   * @param {Player} playerB
   */
  constructor(id, mode, wsA, wsB, playerA, playerB) {
    this.id = id;
    this.mode = mode;
    this.wsA = wsA;
    this.wsB = wsB;
    this.timer = null;
    this.state = {
      board: Array(9).fill(0),
      players: [playerA, playerB],
      turnSymbol: 1,
      status: /** @type {'playing'|'win'|'draw'|'forfeit'} */ ("playing"),
      winnerUserId: "",
      reason: "",
      mode,
      deadlineUnix: mode === "timed" ? Math.floor(Date.now() / 1000) + TURN_SEC : 0,
    };
  }

  isBotMatch() {
    return this.state.players.some((p) => p.userId === BOT_ID);
  }

  snapshot() {
    const st = this.state;
    return {
      board: [...st.board],
      players: st.players.map((p) => ({ ...p })),
      turnSymbol: st.turnSymbol,
      status: st.status,
      winnerUserId: st.winnerUserId,
      reason: st.reason,
      mode: st.mode,
      deadlineUnix: st.deadlineUnix,
    };
  }

  /** @param {import('ws')|null} ws */
  send(ws, obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  broadcast(payload) {
    const msg = { type: "snapshot", state: payload.state, leaderboard: payload.leaderboard ?? null };
    this.send(this.wsA, msg);
    this.send(this.wsB, msg);
  }

  endMatch() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.wsA && this.wsB && !this.isBotMatch()) {
      const [p1, p2] = this.state.players;
      const k =
        p1.userId < p2.userId ? `${p1.userId}|${p2.userId}` : `${p2.userId}|${p1.userId}`;
      rematchByKey.set(k, {
        wsA: this.wsA,
        wsB: this.wsB,
        mode: this.state.mode,
        proposalFrom: null,
        order: [
          { userId: p1.userId, username: p1.username, symbol: p1.symbol },
          { userId: p2.userId, username: p2.username, symbol: p2.symbol },
        ],
      });
    }
    if (this.wsA) this.wsA.__matchId = null;
    if (this.wsB) this.wsB.__matchId = null;
    matches.delete(this.id);
  }

  forfeit(leaverId, reasonKey) {
    const st = this.state;
    if (st.status !== "playing") return;
    const other = st.players.find((p) => p.userId !== leaverId);
    if (!other) return;
    st.status = "forfeit";
    st.winnerUserId = other.userId;
    st.reason = reasonKey;
    st.deadlineUnix = 0;
    applyStats(this);
    this.broadcast({ state: this.snapshot(), leaderboard: leaderboardTop() });
    this.endMatch();
  }

  ensureTickTimer() {
    if (this.state.mode !== "timed" || this.state.status !== "playing") return;
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (!matches.has(this.id)) {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        return;
      }
      this.tickTimed();
    }, 1000);
  }

  tickTimed() {
    const st = this.state;
    if (st.status !== "playing" || st.mode !== "timed" || !st.deadlineUnix) return;
    if (Math.floor(Date.now() / 1000) < st.deadlineUnix) return;
    const current = st.players.find((p) => p.symbol === st.turnSymbol);
    const other = current ? st.players.find((p) => p.userId !== current.userId) : null;
    if (!current || !other) return;
    st.status = "forfeit";
    st.winnerUserId = other.userId;
    st.reason = "turn_timeout";
    st.deadlineUnix = 0;
    applyStats(this);
    this.broadcast({ state: this.snapshot(), leaderboard: leaderboardTop() });
    this.endMatch();
  }

  /**
   * @param {string} userId
   * @param {number} index
   */
  applyMove(userId, index) {
    const st = this.state;
    if (st.status !== "playing") return { ok: false, code: "game_over" };
    const mover = st.players.find((p) => p.userId === userId);
    if (!mover) return { ok: false, code: "not_in_match" };
    if (mover.symbol !== st.turnSymbol) return { ok: false, code: "not_your_turn" };
    if (!Number.isInteger(index) || index < 0 || index > 8) return { ok: false, code: "invalid_move_payload" };
    if (st.board[index] !== 0) return { ok: false, code: "cell_taken" };

    st.board[index] = mover.symbol;
    const w = checkWin(st.board);
    if (w.sym) {
      st.status = "win";
      st.winnerUserId = userId;
      st.reason = `line_${w.line}`;
      st.deadlineUnix = 0;
      applyStats(this);
      this.broadcast({ state: this.snapshot(), leaderboard: leaderboardTop() });
      this.endMatch();
      return { ok: true };
    }
    if (boardFull(st.board)) {
      st.status = "draw";
      st.reason = "board_full";
      st.deadlineUnix = 0;
      applyStats(this);
      this.broadcast({ state: this.snapshot(), leaderboard: leaderboardTop() });
      this.endMatch();
      return { ok: true };
    }
    st.turnSymbol = 3 - st.turnSymbol;
    if (st.mode === "timed") {
      st.deadlineUnix = Math.floor(Date.now() / 1000) + TURN_SEC;
    }
    this.broadcast({ state: this.snapshot(), leaderboard: null });
    this.ensureTickTimer();
    if (this.isBotMatch() && st.status === "playing") {
      const bot = st.players.find((p) => p.userId === BOT_ID);
      if (bot && st.turnSymbol === bot.symbol) {
        scheduleBotMove(this);
      }
    }
    return { ok: true };
  }
}

function checkWin(board) {
  const lines = [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8],
    [0, 3, 6],
    [1, 4, 7],
    [2, 5, 8],
    [0, 4, 8],
    [2, 4, 6],
  ];
  for (let i = 0; i < lines.length; i++) {
    const [a, b, c] = lines[i];
    if (board[a] !== 0 && board[a] === board[b] && board[a] === board[c]) {
      return { sym: board[a], line: String(i) };
    }
  }
  return { sym: 0, line: "" };
}

function boardFull(board) {
  return board.every((c) => c !== 0);
}

function ensurePlayerStats(userId, username) {
  if (!stats.has(userId)) {
    stats.set(userId, { username, wins: 0, losses: 0, draws: 0, streak: 0, score: 0 });
  } else if (username) {
    stats.get(userId).username = username;
  }
}

const PTS_WIN = 200;
const PTS_DRAW = 50;

/** @param {Match} match */
function applyStats(match) {
  const st = match.state;
  for (const p of st.players) {
    if (p.userId === BOT_ID) continue;
    ensurePlayerStats(p.userId, p.username);
  }
  if (st.status === "win" || st.status === "forfeit") {
    for (const p of st.players) {
      if (p.userId === BOT_ID) continue;
      const s = stats.get(p.userId);
      if (p.userId === st.winnerUserId) {
        s.wins += 1;
        s.streak += 1;
        s.score += PTS_WIN;
      } else {
        s.losses += 1;
        s.streak = 0;
      }
    }
  } else if (st.status === "draw") {
    for (const p of st.players) {
      if (p.userId === BOT_ID) continue;
      const s = stats.get(p.userId);
      s.draws += 1;
      s.streak = 0;
      s.score += PTS_DRAW;
    }
  }
}

function leaderboardTop() {
  const rows = [...stats.entries()]
    .map(([ownerId, s]) => ({
      rank: 0,
      ownerId,
      username: s.username,
      score: s.score,
      subscore: s.streak,
      metadata: { wins: s.wins, losses: s.losses, draws: s.draws, streak: s.streak },
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 100);
  rows.forEach((r, idx) => {
    r.rank = idx + 1;
  });
  return rows;
}

function removeFromQueue(ws) {
  const i = queue.findIndex((q) => q.ws === ws);
  if (i >= 0) queue.splice(i, 1);
}

function tryPairHuman(mode) {
  const waiting = queue.filter((q) => q.mode === mode);
  if (waiting.length < 2) return;
  const q1 = waiting[0];
  const q2 = waiting[1];
  removeFromQueue(q1.ws);
  removeFromQueue(q2.ws);
  const id = `m${matchIdSeq++}`;
  const playerA = { userId: q1.userId, username: q1.nickname, symbol: 1 };
  const playerB = { userId: q2.userId, username: q2.nickname, symbol: 2 };
  const match = new Match(id, mode, q1.ws, q2.ws, playerA, playerB);
  matches.set(id, match);
  q1.ws.__matchId = id;
  q2.ws.__matchId = id;
  match.broadcast({ state: match.snapshot(), leaderboard: null });
  match.ensureTickTimer();
}

/** @param {Match} match */
function scheduleBotMove(match) {
  setTimeout(() => {
    if (!matches.has(match.id) || match.state.status !== "playing") return;
    const st = match.state;
    const bot = st.players.find((p) => p.userId === BOT_ID);
    if (!bot || st.turnSymbol !== bot.symbol) return;
    const idx = minimaxPick(st.board, bot.symbol);
    if (idx < 0) return;
    match.applyMove(BOT_ID, idx);
  }, 1000);
}

function minimaxPick(board, botSym) {
  const humSym = botSym === 2 ? 1 : 2;

  /** @param {number[]} b */
  function terminalScore(b) {
    const w = checkWin(b);
    if (w.sym === botSym) return 10;
    if (w.sym === humSym) return -10;
    if (boardFull(b)) return 0;
    return null;
  }

  /** @param {number[]} b @param {boolean} isMax */
  function minimax(b, isMax) {
    const sc = terminalScore(b);
    if (sc !== null) return sc;
    if (isMax) {
      let best = -Infinity;
      for (let i = 0; i < 9; i++) {
        if (b[i] !== 0) continue;
        const nb = [...b];
        nb[i] = botSym;
        best = Math.max(best, minimax(nb, false));
      }
      return best;
    }
    let best = Infinity;
    for (let i = 0; i < 9; i++) {
      if (b[i] !== 0) continue;
      const nb = [...b];
      nb[i] = humSym;
      best = Math.min(best, minimax(nb, true));
    }
    return best;
  }

  let bestI = -1;
  let bestV = -Infinity;
  for (let i = 0; i < 9; i++) {
    if (board[i] !== 0) continue;
    const nb = [...board];
    nb[i] = botSym;
    const v = minimax(nb, false);
    if (v > bestV) {
      bestV = v;
      bestI = i;
    }
  }
  return bestI;
}

/** @param {import('ws')} ws @param {string} code @param {string|null} forUser */
function sendError(ws, code, forUser) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify({ type: "error", code, for: forUser ?? null }));
  }
}

http
  .createServer((req, res) => {
    const url = req.url?.split("?")[0] || "";
    if (url === "/leaderboard" && req.method === "GET") {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.end(JSON.stringify(leaderboardTop()));
      return;
    }
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  })
  .listen(HTTP_PORT, () => {
    console.log(`Local HTTP leaderboard http://127.0.0.1:${HTTP_PORT}/leaderboard`);
  });

const wss = new WebSocketServer({ port: PORT });
console.log(`Local tic-tac-toe WS server on ws://127.0.0.1:${PORT}`);

wss.on("connection", (ws) => {
  ws.__userId = null;
  ws.__nickname = "";
  ws.__matchId = null;

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const type = msg.type;

    if (type === "hello") {
      ws.__userId = String(msg.userId || "").slice(0, 64) || `u_${Math.random().toString(36).slice(2, 10)}`;
      ws.__nickname = String(msg.nickname || "Player").slice(0, 24);
      ensurePlayerStats(ws.__userId, ws.__nickname);
      ws.send(JSON.stringify({ type: "ready", userId: ws.__userId }));
      return;
    }

    if (!ws.__userId) {
      sendError(ws, "send_hello_first", null);
      return;
    }

    if (type === "queue") {
      removeFromQueue(ws);
      cancelWaitingRoom(ws);
      const mode = msg.mode === "timed" ? "timed" : "classic";
      if (ws.__matchId && matches.has(ws.__matchId)) {
        sendError(ws, "already_in_match", ws.__userId);
        return;
      }
      queue.push({ ws, userId: ws.__userId, nickname: ws.__nickname, mode });
      ws.send(JSON.stringify({ type: "queued" }));
      tryPairHuman(mode);
      return;
    }

    if (type === "create_room") {
      removeFromQueue(ws);
      cancelWaitingRoom(ws);
      const mode = msg.mode === "timed" ? "timed" : "classic";
      if (ws.__matchId && matches.has(ws.__matchId)) {
        sendError(ws, "already_in_match", ws.__userId);
        return;
      }
      let code = makeRoomCode();
      while (waitingRooms.has(code)) code = makeRoomCode();
      waitingRooms.set(code, { hostWs: ws, mode });
      ws.__waitingRoomCode = code;
      ws.send(JSON.stringify({ type: "room_created", roomCode: code, mode }));
      return;
    }

    if (type === "join_room") {
      removeFromQueue(ws);
      cancelWaitingRoom(ws);
      const code = String(msg.roomCode || "")
        .trim()
        .toUpperCase()
        .slice(0, 16);
      if (!code) {
        sendError(ws, "bad_room_code", ws.__userId);
        return;
      }
      if (ws.__matchId && matches.has(ws.__matchId)) {
        sendError(ws, "already_in_match", ws.__userId);
        return;
      }
      const entry = waitingRooms.get(code);
      if (!entry) {
        sendError(ws, "room_not_found", ws.__userId);
        return;
      }
      if (entry.hostWs.__userId === ws.__userId) {
        sendError(ws, "cannot_join_own_room", ws.__userId);
        return;
      }
      waitingRooms.delete(code);
      delete entry.hostWs.__waitingRoomCode;
      const id = `m${matchIdSeq++}`;
      const playerA = {
        userId: entry.hostWs.__userId,
        username: entry.hostWs.__nickname,
        symbol: 1,
      };
      const playerB = { userId: ws.__userId, username: ws.__nickname, symbol: 2 };
      const match = new Match(id, entry.mode, entry.hostWs, ws, playerA, playerB);
      matches.set(id, match);
      entry.hostWs.__matchId = id;
      ws.__matchId = id;
      match.broadcast({ state: match.snapshot(), leaderboard: null });
      match.ensureTickTimer();
      return;
    }

    if (type === "cancel_room") {
      const c = ws.__waitingRoomCode;
      if (c && waitingRooms.get(c)?.hostWs === ws) {
        waitingRooms.delete(c);
        delete ws.__waitingRoomCode;
        ws.send(JSON.stringify({ type: "room_cancelled" }));
      }
      return;
    }

    if (type === "rematch_propose") {
      const hit = findRematchSlot(ws);
      if (!hit) {
        sendError(ws, "no_rematch_session", ws.__userId);
        return;
      }
      const [, slot] = hit;
      if (slot.proposalFrom) {
        sendError(ws, "rematch_pending", ws.__userId);
        return;
      }
      slot.proposalFrom = ws.__userId;
      const other = slot.wsA === ws ? slot.wsB : slot.wsA;
      if (other && other.readyState === 1) {
        other.send(
          JSON.stringify({ type: "rematch_offer", fromUsername: String(ws.__nickname || "Player") }),
        );
      }
      return;
    }

    if (type === "rematch_accept") {
      const hit = findRematchSlot(ws);
      if (!hit) {
        sendError(ws, "no_rematch_session", ws.__userId);
        return;
      }
      const [rkey, slot] = hit;
      if (!slot.proposalFrom || slot.proposalFrom === ws.__userId) {
        sendError(ws, "no_rematch_offer", ws.__userId);
        return;
      }
      rematchByKey.delete(rkey);
      const [o1, o2] = slot.order;
      const pa = { userId: o1.userId, username: o1.username, symbol: o1.symbol };
      const pb = { userId: o2.userId, username: o2.username, symbol: o2.symbol };
      const wa = slot.wsA.__userId === pa.userId ? slot.wsA : slot.wsB;
      const wb = slot.wsA.__userId === pb.userId ? slot.wsA : slot.wsB;
      const id = `m${matchIdSeq++}`;
      const match = new Match(id, slot.mode, wa, wb, pa, pb);
      matches.set(id, match);
      wa.__matchId = id;
      wb.__matchId = id;
      match.broadcast({ state: match.snapshot(), leaderboard: null });
      match.ensureTickTimer();
      return;
    }

    if (type === "rematch_decline") {
      const hit = findRematchSlot(ws);
      if (!hit) return;
      const [, slot] = hit;
      if (!slot.proposalFrom) return;
      const proposerWs =
        slot.proposalFrom === slot.wsA.__userId ? slot.wsA : slot.wsB;
      const proposeeWs = proposerWs === slot.wsA ? slot.wsB : slot.wsA;
      slot.proposalFrom = null;
      if (ws === proposerWs) {
        if (proposeeWs && proposeeWs.readyState === 1) {
          proposeeWs.send(JSON.stringify({ type: "rematch_withdrawn" }));
        }
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: "rematch_withdrawn" }));
        }
      } else if (proposerWs && proposerWs.readyState === 1) {
        proposerWs.send(JSON.stringify({ type: "rematch_declined" }));
      }
      return;
    }

    if (type === "start_bot") {
      removeFromQueue(ws);
      cancelWaitingRoom(ws);
      const mode = msg.mode === "timed" ? "timed" : "classic";
      if (ws.__matchId && matches.has(ws.__matchId)) {
        sendError(ws, "already_in_match", ws.__userId);
        return;
      }
      const id = `m${matchIdSeq++}`;
      const human = { userId: ws.__userId, username: ws.__nickname, symbol: 1 };
      const bot = { userId: BOT_ID, username: "Bot", symbol: 2 };
      const match = new Match(id, mode, ws, null, human, bot);
      matches.set(id, match);
      ws.__matchId = id;
      match.broadcast({ state: match.snapshot(), leaderboard: null });
      match.ensureTickTimer();
      return;
    }

    if (type === "cancel_queue") {
      removeFromQueue(ws);
      ws.send(JSON.stringify({ type: "queue_cancelled" }));
      return;
    }

    if (type === "move") {
      const mid = ws.__matchId;
      const match = mid ? matches.get(mid) : null;
      if (!match) {
        sendError(ws, "no_match", ws.__userId);
        return;
      }
      const r = match.applyMove(ws.__userId, Number(msg.index));
      if (!r.ok) sendError(ws, r.code, ws.__userId);
      return;
    }

    if (type === "leave_match") {
      const mid = ws.__matchId;
      const match = mid ? matches.get(mid) : null;
      if (match && match.state.status === "playing") {
        match.forfeit(ws.__userId, "opponent_left");
      } else {
        ws.__matchId = null;
      }
      return;
    }

    if (type === "leaderboard") {
      ws.send(JSON.stringify({ type: "leaderboard", rows: leaderboardTop() }));
      return;
    }
  });

  ws.on("close", () => {
    removeFromQueue(ws);
    cancelWaitingRoom(ws);
    removeRematchForWs(ws);
    const mid = ws.__matchId;
    const match = mid ? matches.get(mid) : null;
    if (match && match.state.status === "playing") {
      match.forfeit(ws.__userId, "opponent_left");
    }
  });
});
