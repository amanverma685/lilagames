import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Session, Socket } from "@heroiclabs/nakama-js";
import {
  clientErrorMessage,
  createNakamaClient,
  getSessionPlayerId,
  nakamaRpc,
  nakamaRpcOverSocket,
} from "./nakamaClient";
import { parseWinLineIndex, WIN_LINE_LABELS } from "./boardGeometry";
import { playClick, playWin, resumeAudioContext } from "./gameAudio";
import { fetchLocalLeaderboardRows, isLocalBackend, LocalGameSession } from "./localGame";
import {
  dedupeLeaderboardByUsername,
  LOCAL_BOT_USER_ID,
  type GameMode,
  type LeaderboardRow,
  type MatchStatePayload,
} from "./gameTypes";
import { loadPreferences, savePreferences, type GamePreferences } from "./gamePreferences";
import { GameBoard } from "./components/GameBoard";
import { GameMenuPanel } from "./components/GameMenuPanel";
import { GameToolbar } from "./components/GameToolbar";
import "./App.css";

const OP_SNAPSHOT = 1;
const OP_MOVE = 2;
const OP_ERROR = 3;

type Phase = "nickname" | "lobby" | "queue" | "waiting_room" | "playing" | "result";

function readRoomFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const q = new URLSearchParams(window.location.search).get("room");
    if (!q) return null;
    const t = q.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (t.length < 4 || t.length > 16) return null;
    return t;
  } catch {
    return null;
  }
}

/** Nakama match ids are UUID-shaped strings; allow any hex variant (not only RFC “v4” nibble patterns). */
function isNakamaMatchUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s.trim().toLowerCase());
}

/** Nakama authoritative match id from invite link `?match=uuid` (hash fragment e.g. `#nakama` does not affect `search`). */
function readNakamaMatchFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const q = new URLSearchParams(window.location.search).get("match");
    if (!q) return null;
    const t = q.trim().toLowerCase();
    if (!isNakamaMatchUuid(t)) return null;
    return t;
  } catch {
    return null;
  }
}

function humanizeLocalError(code: string): string {
  switch (code) {
    case "room_not_found":
      return "Room not found or it expired.";
    case "cannot_join_own_room":
      return "You can’t join a room you created in this same tab.";
    case "already_in_match":
      return "You’re already in a match.";
    case "bad_room_code":
      return "That room code isn’t valid.";
    case "no_rematch_session":
      return "Rematch isn’t available (start a new game).";
    case "no_rematch_offer":
      return "No rematch request to accept.";
    case "rematch_pending":
      return "A rematch is already pending.";
    default:
      return code;
  }
}

function decodeMatchData(data: Uint8Array): string {
  return new TextDecoder().decode(data);
}

function sanitizeNickname(raw: string): string {
  const t = raw.trim().slice(0, 24);
  return t.length > 0 ? t : "Player";
}

/** Used when the user continues without typing a name (local + Nakama). */
function generateRandomNickname(): string {
  let suffix: string;
  try {
    suffix =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID().replace(/-/g, "").slice(0, 8)
        : Math.random().toString(36).slice(2, 10);
  } catch {
    suffix = Math.random().toString(36).slice(2, 10);
  }
  const base = `Guest_${suffix}`;
  return base.slice(0, 24);
}

/** Maps server `reason` codes (e.g. line_4) to player-facing copy. */
function formatMatchEndReason(reason: string): string {
  if (!reason) return "";
  if (reason === "board_full") return "All squares filled.";
  if (reason === "opponent_left") return "Opponent left the match.";
  if (reason === "turn_timeout") return "Time ran out.";
  if (reason === "host_left") return "Host left before the game started.";
  const idx = parseWinLineIndex(reason);
  if (idx !== null) return `Three in a row — ${WIN_LINE_LABELS[idx]}.`;
  return reason;
}

export default function App() {
  const client = useRef(createNakamaClient()).current;
  const socketRef = useRef<Socket | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const matchIdRef = useRef<string | null>(null);
  const mmTicketRef = useRef<string | null>(null);
  const localSessionRef = useRef<LocalGameSession | null>(null);
  const lbModalGenRef = useRef(0);

  const [phase, setPhase] = useState<Phase>("nickname");
  const [nickname, setNickname] = useState(() => generateRandomNickname());
  const [mode, setMode] = useState<GameMode>("classic");
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  /** Incrementing key triggers CSS animation each time the server rejects a move (not your turn). */
  const [opponentTurnNoticeKey, setOpponentTurnNoticeKey] = useState<number | null>(null);
  const opponentTurnNoticeSeqRef = useRef(0);
  const [matchState, setMatchState] = useState<MatchStatePayload | null>(null);
  const [myUserId, setMyUserId] = useState<string | null>(null);
  const [leaderboard, setLeaderboard] = useState<LeaderboardRow[]>([]);
  const [nowTick, setNowTick] = useState(0);
  const [lbModalOpen, setLbModalOpen] = useState(false);
  const [lbModalRows, setLbModalRows] = useState<LeaderboardRow[]>([]);
  const [lbModalLoading, setLbModalLoading] = useState(false);
  const [lbModalErr, setLbModalErr] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<GamePreferences>(() => loadPreferences());
  const [menuOpen, setMenuOpen] = useState(false);
  const [lastMoveIndex, setLastMoveIndex] = useState<number | null>(null);
  const [hostedRoomCode, setHostedRoomCode] = useState<string | null>(null);
  const [urlRoomToJoin, setUrlRoomToJoin] = useState<string | null>(() =>
    typeof window !== "undefined" && isLocalBackend() ? readRoomFromUrl() : null,
  );
  const [joinCodeDraft, setJoinCodeDraft] = useState("");
  const [nakamaJoinDraft, setNakamaJoinDraft] = useState("");
  const [nakamaPrivateHost, setNakamaPrivateHost] = useState(false);
  const [rematchOfferFrom, setRematchOfferFrom] = useState<string | null>(null);
  const [rematchOutgoing, setRematchOutgoing] = useState(false);
  const [rematchNotice, setRematchNotice] = useState<string | null>(null);
  const rematchOfferFromRef = useRef<string | null>(null);
  const [resultOutcomeDismissed, setResultOutcomeDismissed] = useState(false);

  useLayoutEffect(() => {
    rematchOfferFromRef.current = rematchOfferFrom;
  }, [rematchOfferFrom]);

  useEffect(() => {
    if (phase === "result") setResultOutcomeDismissed(false);
  }, [phase]);

  useEffect(() => {
    if (opponentTurnNoticeKey === null) return;
    const ms = 2350;
    const t = window.setTimeout(() => setOpponentTurnNoticeKey(null), ms);
    return () => window.clearTimeout(t);
  }, [opponentTurnNoticeKey]);

  const showOpponentTurnNotice = useCallback(() => {
    opponentTurnNoticeSeqRef.current += 1;
    setOpponentTurnNoticeKey(opponentTurnNoticeSeqRef.current);
  }, []);

  const prevBoardRef = useRef<number[] | null>(null);
  const winChimeSigRef = useRef<string>("");
  const urlJoinStartedRef = useRef(false);
  const nakMatchJoinStartedRef = useRef(false);

  const local = isLocalBackend();

  const applyPreferences = useCallback((next: GamePreferences) => {
    setPrefs(next);
  }, []);

  const toggleSound = useCallback(() => {
    const next = { ...prefs, soundOn: !prefs.soundOn };
    savePreferences(next);
    setPrefs(next);
    void resumeAudioContext();
  }, [prefs]);

  const fetchLeaderboard = useCallback(async () => {
    if (local) {
      localSessionRef.current?.requestLeaderboard();
      return;
    }
    const session = sessionRef.current;
    if (!session) return;
    try {
      const res = await nakamaRpc(client, session, "leaderboard_top", {});
      const p = res.payload;
      const parsed: LeaderboardRow[] =
        typeof p === "string"
          ? JSON.parse(p)
          : Array.isArray(p)
            ? (p as LeaderboardRow[])
            : [];
      setLeaderboard(dedupeLeaderboardByUsername(parsed));
    } catch {
      setLeaderboard([]);
    }
  }, [client, local]);

  const closeLeaderboardModal = useCallback(() => {
    lbModalGenRef.current += 1;
    setLbModalOpen(false);
    setLbModalErr(null);
    setLbModalLoading(false);
    setLbModalRows([]);
  }, []);

  const openLeaderboardModal = useCallback(async () => {
    const gen = ++lbModalGenRef.current;
    setLbModalOpen(true);
    setLbModalLoading(true);
    setLbModalErr(null);
    setLbModalRows([]);
    try {
      if (local) {
        const rows = await fetchLocalLeaderboardRows(sanitizeNickname(nickname));
        if (gen !== lbModalGenRef.current) return;
        setLbModalRows(dedupeLeaderboardByUsername(rows));
      } else {
        const session = sessionRef.current;
        if (!session) {
          if (gen !== lbModalGenRef.current) return;
          setLbModalErr("Sign in with a nickname first.");
          return;
        }
        const res = await nakamaRpc(client, session, "leaderboard_top", {});
        const p = res.payload;
        const parsed: LeaderboardRow[] =
          typeof p === "string"
            ? JSON.parse(p)
            : Array.isArray(p)
              ? (p as LeaderboardRow[])
              : [];
        if (gen !== lbModalGenRef.current) return;
        setLbModalRows(dedupeLeaderboardByUsername(parsed));
      }
    } catch (e) {
      if (gen !== lbModalGenRef.current) return;
      setLbModalErr(e instanceof Error ? e.message : "Failed to load");
      setLbModalRows([]);
    } finally {
      if (gen === lbModalGenRef.current) setLbModalLoading(false);
    }
  }, [client, local, nickname]);

  useEffect(() => {
    if (phase !== "playing" || matchState?.mode !== "timed" || !matchState?.deadlineUnix) {
      return;
    }
    const id = window.setInterval(() => setNowTick((n) => n + 1), 500);
    return () => clearInterval(id);
  }, [phase, matchState?.mode, matchState?.deadlineUnix]);

  useEffect(() => {
    if (!lbModalOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLbModalOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lbModalOpen]);

  useEffect(() => {
    if (!rematchNotice) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setRematchNotice(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rematchNotice]);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  useEffect(() => {
    if (!matchState?.board) return;
    const b = matchState.board;
    if (b.every((x) => x === 0)) {
      prevBoardRef.current = [...b];
      setLastMoveIndex(null);
      return;
    }
    const prev = prevBoardRef.current;
    prevBoardRef.current = [...b];
    if (!prev) return;
    for (let i = 0; i < 9; i++) {
      if (b[i] !== 0 && prev[i] === 0) {
        setLastMoveIndex(i);
        return;
      }
    }
  }, [matchState?.board]);

  useEffect(() => {
    if (phase !== "result" || !matchState || matchState.status !== "win" || !myUserId) return;
    if (matchState.winnerUserId !== myUserId) return;
    const sig = `${matchState.reason}:${matchState.board.join("")}`;
    if (winChimeSigRef.current === sig) return;
    winChimeSigRef.current = sig;
    playWin(prefs.soundOn);
  }, [phase, matchState, prefs.soundOn, myUserId]);

  const teardownNakama = useCallback(async () => {
    const sock = socketRef.current;
    if (sock) {
      try {
        const mid = matchIdRef.current;
        if (mid) {
          await sock.leaveMatch(mid);
        }
      } catch {
        /* ignore */
      }
      sock.disconnect(true);
    }
    socketRef.current = null;
    matchIdRef.current = null;
    mmTicketRef.current = null;
  }, []);

  const processNakamaSnapshot = useCallback(
    (snap: MatchStatePayload) => {
      setStatusMsg(null);
      if (snap.status === "abandoned") {
        setMatchState(null);
        setPhase("lobby");
        setHostedRoomCode(null);
        setNakamaPrivateHost(false);
        setStatusMsg(snap.reason === "host_left" ? "The host left the room." : "Room closed.");
        void teardownNakama();
        return;
      }
      setMatchState(snap);
      if (snap.status !== "playing") {
        setPhase("result");
        void fetchLeaderboard();
        return;
      }
      if (!local && snap.players.length < 2) {
        setPhase("waiting_room");
      } else {
        setPhase("playing");
      }
    },
    [fetchLeaderboard, local, teardownNakama],
  );

  const attachNakamaMatchHandlers = useCallback(
    (sock: Socket) => {
      sock.onmatchdata = (md) => {
        if (md.op_code === OP_SNAPSHOT) {
          try {
            const snap = JSON.parse(decodeMatchData(md.data)) as MatchStatePayload;
            processNakamaSnapshot(snap);
          } catch {
            /* ignore */
          }
          return;
        }
        if (md.op_code === OP_ERROR) {
          try {
            const err = JSON.parse(decodeMatchData(md.data)) as { code?: string; for?: string };
            const uid = sessionRef.current?.user_id;
            if (err.for && uid && err.for !== uid) return;
            if (err.code === "not_your_turn") {
              showOpponentTurnNotice();
              return;
            }
            setStatusMsg(err.code ?? "error");
          } catch {
            /* ignore */
          }
        }
      };
      sock.onmatchmakermatched = async (mm) => {
        try {
          const m = await sock.joinMatch(mm.match_id, mm.token);
          matchIdRef.current = m.match_id;
          setPhase("playing");
        } catch (e) {
          setStatusMsg(e instanceof Error ? e.message : "Join failed");
          setPhase("lobby");
        }
      };
    },
    [processNakamaSnapshot, showOpponentTurnNotice],
  );

  const teardownLocal = useCallback(() => {
    localSessionRef.current?.disconnect();
    localSessionRef.current = null;
  }, []);

  const makeLocalSession = useCallback(() => {
    return new LocalGameSession(nickname, {
      onReady: (uid) => setMyUserId(uid),
      onQueued: () => setPhase("queue"),
      onSnapshot: (snap, lb) => {
        setStatusMsg(null);
        setRematchOfferFrom(null);
        setRematchOutgoing(false);
        setRematchNotice(null);
        setMatchState(snap);
        if (lb && lb.length > 0) {
          setLeaderboard(dedupeLeaderboardByUsername(lb));
        }
        if (snap.status !== "playing") {
          setPhase("result");
          if (!lb || lb.length === 0) {
            localSessionRef.current?.requestLeaderboard();
          }
        } else {
          setPhase("playing");
        }
      },
      onError: (c) => {
        if (["room_not_found", "cannot_join_own_room", "bad_room_code"].includes(c)) {
          urlJoinStartedRef.current = false;
        }
        if (["no_rematch_session", "rematch_pending"].includes(c)) {
          setRematchOutgoing(false);
        }
        if (c === "not_your_turn") {
          showOpponentTurnNotice();
          return;
        }
        setStatusMsg(humanizeLocalError(c));
      },
      onQueueCancelled: () => {},
      onLeaderboard: (rows) => setLeaderboard(dedupeLeaderboardByUsername(rows)),
      onRoomCreated: (code, m) => {
        setStatusMsg(null);
        setHostedRoomCode(code);
        setMode(m);
        setPhase("waiting_room");
      },
      onRoomCancelled: () => {
        setHostedRoomCode(null);
        setPhase("lobby");
      },
      onRematchOffer: (from) => {
        setRematchOfferFrom(from);
        setRematchOutgoing(false);
      },
      onRematchDeclined: () => {
        setRematchOfferFrom(null);
        setRematchOutgoing(false);
        setRematchNotice("Rematch declined.");
      },
      onRematchWithdrawn: () => {
        const hadIncoming = rematchOfferFromRef.current;
        setRematchOfferFrom(null);
        setRematchOutgoing(false);
        if (hadIncoming) setRematchNotice("They cancelled the rematch request.");
      },
      onRematchAborted: () => {
        setRematchOfferFrom(null);
        setRematchOutgoing(false);
        setRematchNotice("Rematch cancelled — other player left.");
      },
    });
  }, [nickname, showOpponentTurnNotice]);

  const onNicknameContinue = async () => {
    setStatusMsg(null);
    const trimmed = nickname.trim();
    const name = trimmed.length > 0 ? sanitizeNickname(trimmed) : generateRandomNickname();
    setNickname(name);
    if (local) {
      setMyUserId(getSessionPlayerId());
      setPhase("lobby");
      return;
    }
    try {
      const session = await client.authenticateDevice(getSessionPlayerId(), true, name);
      sessionRef.current = session;
      setMyUserId(session.user_id || null);
      await client.updateAccount(session, { username: name });
      setPhase("lobby");
      const inviteMatchId = readNakamaMatchFromUrl();
      if (inviteMatchId && !nakMatchJoinStartedRef.current) {
        nakMatchJoinStartedRef.current = true;
        void joinNakamaMatchFromId(inviteMatchId);
      }
    } catch (e) {
      setStatusMsg(e instanceof Error ? e.message : "Auth failed");
    }
  };

  const startLocalHuman = async () => {
    setStatusMsg(null);
    setMatchState(null);
    setHostedRoomCode(null);
    winChimeSigRef.current = "";
    prevBoardRef.current = null;
    setLastMoveIndex(null);
    try {
      if (!localSessionRef.current) {
        localSessionRef.current = makeLocalSession();
      }
      await localSessionRef.current.connect();
      localSessionRef.current.queue(mode);
      setPhase("queue");
    } catch (e) {
      setStatusMsg(e instanceof Error ? e.message : "Connection failed");
      teardownLocal();
    }
  };

  const startLocalBot = async () => {
    setStatusMsg(null);
    setMatchState(null);
    setHostedRoomCode(null);
    winChimeSigRef.current = "";
    prevBoardRef.current = null;
    setLastMoveIndex(null);
    try {
      if (!localSessionRef.current) {
        localSessionRef.current = makeLocalSession();
      }
      await localSessionRef.current.connect();
      localSessionRef.current.startBot(mode);
    } catch (e) {
      setStatusMsg(e instanceof Error ? e.message : "Connection failed");
      teardownLocal();
    }
  };

  const startCreateRoom = async () => {
    setStatusMsg(null);
    setMatchState(null);
    setHostedRoomCode(null);
    winChimeSigRef.current = "";
    prevBoardRef.current = null;
    setLastMoveIndex(null);
    try {
      if (!localSessionRef.current) {
        localSessionRef.current = makeLocalSession();
      }
      await localSessionRef.current.connect();
      localSessionRef.current.createRoom(mode);
    } catch (e) {
      setStatusMsg(e instanceof Error ? e.message : "Connection failed");
      teardownLocal();
    }
  };

  const joinRoomFromCode = async (raw: string) => {
    const c = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (c.length < 4) {
      setStatusMsg("Enter a room code (at least 4 characters).");
      return;
    }
    setStatusMsg(null);
    setMatchState(null);
    setHostedRoomCode(null);
    winChimeSigRef.current = "";
    prevBoardRef.current = null;
    setLastMoveIndex(null);
    try {
      if (!localSessionRef.current) {
        localSessionRef.current = makeLocalSession();
      }
      await localSessionRef.current.connect();
      localSessionRef.current.joinRoom(c);
      setJoinCodeDraft("");
      if (typeof window !== "undefined") {
        window.history.replaceState({}, "", window.location.pathname);
      }
    } catch (e) {
      setStatusMsg(e instanceof Error ? e.message : "Connection failed");
      teardownLocal();
    }
  };

  const startQueue = async () => {
    if (local) {
      await startLocalHuman();
      return;
    }
    setStatusMsg(null);
    const session = sessionRef.current;
    if (!session) {
      setPhase("nickname");
      return;
    }
    await teardownNakama();
    const sock = client.createSocket(client.useSSL, false);
    socketRef.current = sock;
    attachNakamaMatchHandlers(sock);
    matchIdRef.current = null;
    mmTicketRef.current = null;
    setMatchState(null);

    try {
      await sock.connect(session, true);
      const ticket = await sock.addMatchmaker(`+properties.mode:${mode}`, 2, 2, { mode });
      mmTicketRef.current = ticket.ticket;
      setPhase("queue");
    } catch (e) {
      setStatusMsg(e instanceof Error ? e.message : "Socket failed");
      sock.disconnect(true);
      socketRef.current = null;
    }
  };

  const startCreateNakamaPrivate = useCallback(async () => {
    setStatusMsg(null);
    setMatchState(null);
    winChimeSigRef.current = "";
    prevBoardRef.current = null;
    setLastMoveIndex(null);
    const session = sessionRef.current;
    if (!session) {
      setPhase("nickname");
      return;
    }
    await teardownNakama();
    const sock = client.createSocket(client.useSSL, false);
    socketRef.current = sock;
    attachNakamaMatchHandlers(sock);
    mmTicketRef.current = null;
    try {
      await sock.connect(session, true);
      const res = await nakamaRpcOverSocket(sock, "create_private_match", { mode });
      const payload = res.payload;
      const raw =
        typeof payload === "string"
          ? (JSON.parse(payload) as { matchId?: string })
          : (payload as { matchId?: string });
      const matchId = raw.matchId;
      if (!matchId) {
        throw new Error("Server did not return a match id");
      }
      matchIdRef.current = matchId;
      setHostedRoomCode(matchId);
      setNakamaPrivateHost(true);
      setPhase("waiting_room");
      await sock.joinMatch(matchId);
    } catch (e) {
      setStatusMsg(clientErrorMessage(e) || "Could not create room");
      setHostedRoomCode(null);
      setNakamaPrivateHost(false);
      await teardownNakama();
      setPhase("lobby");
    }
  }, [attachNakamaMatchHandlers, client, mode, teardownNakama]);

  const startNakamaBot = useCallback(async () => {
    setStatusMsg(null);
    setMatchState(null);
    winChimeSigRef.current = "";
    prevBoardRef.current = null;
    setLastMoveIndex(null);
    setHostedRoomCode(null);
    setNakamaPrivateHost(false);
    const session = sessionRef.current;
    if (!session) {
      setPhase("nickname");
      return;
    }
    await teardownNakama();
    const sock = client.createSocket(client.useSSL, false);
    socketRef.current = sock;
    attachNakamaMatchHandlers(sock);
    mmTicketRef.current = null;
    try {
      await sock.connect(session, true);
      const res = await nakamaRpcOverSocket(sock, "create_bot_match", { mode });
      const payload = res.payload;
      const raw =
        typeof payload === "string"
          ? (JSON.parse(payload) as { matchId?: string })
          : (payload as { matchId?: string });
      const matchId = raw.matchId;
      if (!matchId) {
        throw new Error("Server did not return a match id");
      }
      matchIdRef.current = matchId;
      await sock.joinMatch(matchId);
    } catch (e) {
      setStatusMsg(clientErrorMessage(e) || "Could not start bot match");
      await teardownNakama();
      setPhase("lobby");
    }
  }, [attachNakamaMatchHandlers, client, mode, teardownNakama]);

  const joinNakamaMatchFromId = useCallback(
    async (matchIdRaw: string) => {
      const matchId = matchIdRaw.trim().toLowerCase();
      if (!isNakamaMatchUuid(matchId)) {
        nakMatchJoinStartedRef.current = false;
        setStatusMsg("Enter a valid match ID (UUID from your friend).");
        return;
      }
      setStatusMsg(null);
      setMatchState(null);
      winChimeSigRef.current = "";
      prevBoardRef.current = null;
      setLastMoveIndex(null);
      const session = sessionRef.current;
      if (!session) {
        nakMatchJoinStartedRef.current = false;
        setPhase("nickname");
        return;
      }
      await teardownNakama();
      const sock = client.createSocket(client.useSSL, false);
      socketRef.current = sock;
      attachNakamaMatchHandlers(sock);
      mmTicketRef.current = null;
      matchIdRef.current = matchId;
      try {
        await sock.connect(session, true);
        await sock.joinMatch(matchId);
        setNakamaJoinDraft("");
        if (typeof window !== "undefined") {
          window.history.replaceState({}, "", window.location.pathname);
        }
      } catch (e) {
        nakMatchJoinStartedRef.current = false;
        setStatusMsg(e instanceof Error ? e.message : "Could not join match");
        matchIdRef.current = null;
        await teardownNakama();
      }
    },
    [attachNakamaMatchHandlers, client, teardownNakama],
  );

  const cancelQueue = async () => {
    if (local) {
      localSessionRef.current?.cancelQueue();
      setPhase("lobby");
      return;
    }
    const sock = socketRef.current;
    const t = mmTicketRef.current;
    if (sock && t) {
      try {
        await sock.removeMatchmaker(t);
      } catch {
        /* ignore */
      }
    }
    await teardownNakama();
    setPhase("lobby");
  };

  const leaveMatch = async () => {
    winChimeSigRef.current = "";
    prevBoardRef.current = null;
    setLastMoveIndex(null);
    setRematchOfferFrom(null);
    setRematchOutgoing(false);
    setRematchNotice(null);
    if (local) {
      localSessionRef.current?.leaveMatch();
      teardownLocal();
      setMatchState(null);
      setPhase("lobby");
      return;
    }
    const sock = socketRef.current;
    const mid = matchIdRef.current;
    if (sock && mid) {
      try {
        await sock.leaveMatch(mid);
      } catch {
        /* ignore */
      }
    }
    await teardownNakama();
    setHostedRoomCode(null);
    setNakamaPrivateHost(false);
    setMatchState(null);
    setPhase("lobby");
  };

  const handleToolbarRestart = () => {
    if (local && phase === "waiting_room") {
      localSessionRef.current?.cancelRoom();
      setHostedRoomCode(null);
      setPhase("lobby");
      setStatusMsg(null);
      return;
    }
    if (!local && phase === "waiting_room") {
      setHostedRoomCode(null);
      setNakamaPrivateHost(false);
    }
    void leaveMatch();
  };

  const sendMove = async (index: number) => {
    if (local) {
      if (!matchState || matchState.status !== "playing") return;
      localSessionRef.current?.move(index);
      return;
    }
    const sock = socketRef.current;
    const mid = matchIdRef.current;
    if (!sock || !mid || !matchState || matchState.status !== "playing") return;
    if (matchState.players.length < 2) return;
    try {
      await sock.sendMatchState(mid, OP_MOVE, JSON.stringify({ index }));
    } catch {
      setStatusMsg("send failed");
    }
  };

  const playAgain = async () => {
    winChimeSigRef.current = "";
    prevBoardRef.current = null;
    setLastMoveIndex(null);
    setRematchOfferFrom(null);
    setRematchOutgoing(false);
    setRematchNotice(null);
    setHostedRoomCode(null);
    urlJoinStartedRef.current = false;
    nakMatchJoinStartedRef.current = false;
    setNakamaPrivateHost(false);
    if (local) {
      teardownLocal();
    } else {
      await teardownNakama();
    }
    setMatchState(null);
    setPhase("lobby");
  };

  const handleToolbarHome = () => {
    void resumeAudioContext();
    setMenuOpen(false);
    if (typeof window !== "undefined") {
      window.history.replaceState({}, "", window.location.pathname);
    }
    urlJoinStartedRef.current = false;
    nakMatchJoinStartedRef.current = false;
    if (phase === "queue") {
      void cancelQueue();
      return;
    }
    if (phase === "result") {
      void playAgain();
      return;
    }
    if (phase === "lobby") {
      setStatusMsg(null);
      return;
    }
    handleToolbarRestart();
  };

  useEffect(() => {
    if (!local || phase !== "lobby" || !urlRoomToJoin || urlJoinStartedRef.current) return;
    urlJoinStartedRef.current = true;
    const code = urlRoomToJoin;
    setUrlRoomToJoin(null);
    if (typeof window !== "undefined") {
      window.history.replaceState({}, "", window.location.pathname);
    }
    void (async () => {
      try {
        if (!localSessionRef.current) {
          localSessionRef.current = makeLocalSession();
        }
        await localSessionRef.current.connect();
        localSessionRef.current.joinRoom(code);
      } catch (e) {
        urlJoinStartedRef.current = false;
        setStatusMsg(e instanceof Error ? e.message : "Could not join room");
      }
    })();
  }, [local, phase, urlRoomToJoin, makeLocalSession]);

  /** Join invite link (`?match=`) after lobby is shown, e.g. returning player with session from a prior tab state. Reads live `location.search` so we never miss the id due to stale React state. */
  useEffect(() => {
    if (local || phase !== "lobby" || nakMatchJoinStartedRef.current) return;
    const mid = readNakamaMatchFromUrl();
    if (!mid) return;
    nakMatchJoinStartedRef.current = true;
    void joinNakamaMatchFromId(mid);
  }, [joinNakamaMatchFromId, local, phase]);

  const secondsLeft = useMemo(() => {
    if (!matchState?.deadlineUnix || matchState.mode !== "timed") return null;
    return Math.max(0, matchState.deadlineUnix - Math.floor(Date.now() / 1000));
  }, [matchState?.deadlineUnix, matchState?.mode, nowTick]);

  const myPlayerSymbol = useMemo((): 1 | 2 => {
    if (!matchState || !myUserId) return 1;
    const me = matchState.players.find((p) => p.userId === myUserId);
    return me?.symbol === 2 ? 2 : 1;
  }, [matchState, myUserId]);

  const turnGlyph = useMemo(() => {
    if (!matchState) return prefs.glyphMe;
    return matchState.turnSymbol === myPlayerSymbol ? prefs.glyphMe : prefs.glyphThem;
  }, [matchState, myPlayerSymbol, prefs.glyphMe, prefs.glyphThem]);

  const turnPhrase = useMemo(() => {
    if (!matchState || matchState.status !== "playing" || !myUserId) return "";
    if (matchState.turnSymbol === myPlayerSymbol) return "Your turn";
    const opp = matchState.players.find((p) => p.userId !== myUserId);
    const raw = (opp?.username ?? "").trim();
    const name = raw.length > 0 ? raw : "Opponent";
    return `${name}'s turn`;
  }, [matchState, myUserId, myPlayerSymbol]);

  const turnActorLine = useMemo(() => {
    if (!matchState || !myUserId || matchState.status !== "playing") return "";
    const me = matchState.players.find((p) => p.userId === myUserId);
    const opp = matchState.players.find((p) => p.userId !== myUserId);
    const myTurn = matchState.turnSymbol === myPlayerSymbol;
    if (myTurn) {
      return `${me?.username ?? "You"} (you) · ${prefs.glyphMe}`;
    }
    const on = (opp?.username ?? "").trim() || "Opponent";
    return `${on} (opp) · ${prefs.glyphThem}`;
  }, [matchState, myUserId, myPlayerSymbol, prefs.glyphMe, prefs.glyphThem]);

  const vsLocalBot = useMemo(
    () => Boolean(matchState?.players.some((p) => p.userId === LOCAL_BOT_USER_ID)),
    [matchState?.players],
  );

  const resultTitle = () => {
    if (!matchState || !myUserId) return "Game over";
    if (matchState.status === "draw") return "Draw";
    if (matchState.winnerUserId === myUserId) return "Winner! +200 pts";
    return "You lost";
  };

  const showToolbar = phase !== "nickname";
  const showRestartBtn = phase === "playing" || phase === "waiting_room";

  const copyRoomId = async () => {
    if (!hostedRoomCode) return;
    try {
      await navigator.clipboard.writeText(hostedRoomCode);
      setStatusMsg(
        nakamaPrivateHost
          ? "Match ID copied — your friend enters it under Join game on the home screen."
          : "Room ID copied — your friend enters it on the home screen and taps Join game.",
      );
    } catch {
      setStatusMsg("Could not copy — select the ID above and copy manually.");
    }
  };

  const canHumanRematch = local && !vsLocalBot;

  return (
    <div className="app-shell" style={{ backgroundColor: prefs.backgroundColor }}>
      {showToolbar ? (
        <GameToolbar
          onHome={handleToolbarHome}
          onMenu={() => {
            void resumeAudioContext();
            setMenuOpen(true);
          }}
          onRestart={handleToolbarRestart}
          onLeaderboard={() => void openLeaderboardModal()}
          soundOn={prefs.soundOn}
          onToggleSound={toggleSound}
          showRestart={showRestartBtn}
        />
      ) : null}

      <GameMenuPanel
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        preferences={prefs}
        onApply={applyPreferences}
      />

      {phase === "nickname" && (
        <div className="app-main app-main--home">
          <div className="home-backdrop" aria-hidden />
          <div className="home-panel">
            <header className="home-header">
              <p className="home-eyebrow">Welcome</p>
              <h1 className="home-title">Pick a name</h1>
              <p className="home-lede">
                Each browser tab is its own player. Leave the name blank and tap Continue to get a random guest name.
              </p>
            </header>
            <div className="home-nickname-form">
              <div className="home-nickname-input-wrap">
                <input
                  className="input home-nickname-input"
                  placeholder="Nickname (optional)"
                  value={nickname}
                  onChange={(e) => setNickname(e.target.value)}
                  maxLength={24}
                  autoComplete="username"
                />
                {nickname.trim() ? (
                  <button
                    type="button"
                    className="home-input-clear"
                    aria-label="Clear nickname"
                    onClick={() => setNickname("")}
                  >
                    ×
                  </button>
                ) : null}
              </div>
              {statusMsg ? <p className="home-error">{statusMsg}</p> : null}
              <div className="home-nickname-actions">
                <button type="button" className="home-cta home-cta--primary" onClick={() => void onNicknameContinue()}>
                  <span className="home-cta-title">Continue</span>
                  <span className="home-cta-sub">Uses a random name if you leave the field empty</span>
                </button>
                {local ? (
                  <button type="button" className="home-cancel" onClick={() => void openLeaderboardModal()}>
                    View leaderboard
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      )}

      {phase === "lobby" && (
        <div className="app-main app-main--home">
          <div className="home-backdrop" aria-hidden />
          <div className="home-panel">
            <header className="home-header">
              <p className="home-eyebrow">Lila Games</p>
              <h1 className="home-title">Tic-Tac-Toe</h1>
              <p className="home-lede">
                {local
                  ? "Bot practice, matchmaking, or create a room and share the room ID so a friend can join."
                  : "Random matchmaking, play vs server bot, or create a private room and share the match ID with your friend."}
              </p>
            </header>

            <section className="home-section" aria-labelledby="home-mode-label">
              <h2 id="home-mode-label" className="home-section-title">
                Mode
              </h2>
              <div className="mode-chips" role="radiogroup" aria-label="Game mode">
                <label className={`mode-chip ${mode === "classic" ? "mode-chip--on" : ""}`}>
                  <input
                    type="radio"
                    name="mode"
                    className="mode-chip-input"
                    checked={mode === "classic"}
                    onChange={() => setMode("classic")}
                  />
                  <span className="mode-chip-label">Classic</span>
                  <span className="mode-chip-desc">Take your time</span>
                </label>
                <label className={`mode-chip ${mode === "timed" ? "mode-chip--on" : ""}`}>
                  <input
                    type="radio"
                    name="mode"
                    className="mode-chip-input"
                    checked={mode === "timed"}
                    onChange={() => setMode("timed")}
                  />
                  <span className="mode-chip-label">Timed</span>
                  <span className="mode-chip-desc">30s per move</span>
                </label>
              </div>
            </section>

            {statusMsg ? <p className="home-error">{statusMsg}</p> : null}

            <section className="home-section" aria-labelledby="home-start-label">
              <h2 id="home-start-label" className="home-section-title">
                Start
              </h2>
              <div className="home-actions">
                {local ? (
                  <>
                    <button type="button" className="home-cta home-cta--primary" onClick={() => void startLocalBot()}>
                      <span className="home-cta-title">Play vs Bot</span>
                      <span className="home-cta-sub">Practice locally against a strong minimax opponent</span>
                    </button>
                    <button type="button" className="home-cta home-cta--secondary" onClick={() => void startCreateRoom()}>
                      <span className="home-cta-title">Create room</span>
                      <span className="home-cta-sub">You get a room ID — copy it for your friend; they paste it and tap Join game</span>
                    </button>
                    <button type="button" className="home-cta home-cta--secondary" onClick={() => void startQueue()}>
                      <span className="home-cta-title">Find human (queue)</span>
                      <span className="home-cta-sub">Two tabs, same mode — queue on both to auto-pair</span>
                    </button>
                    <div className="home-join-row">
                      <input
                        className="input home-join-input"
                        placeholder="Paste room ID from host"
                        value={joinCodeDraft}
                        onChange={(e) => setJoinCodeDraft(e.target.value.toUpperCase())}
                        maxLength={12}
                        autoCapitalize="characters"
                      />
                      <button type="button" className="home-join-btn btn secondary" onClick={() => void joinRoomFromCode(joinCodeDraft)}>
                        Join game
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <button type="button" className="home-cta home-cta--primary" onClick={() => void startQueue()}>
                      <span className="home-cta-title">Find match</span>
                      <span className="home-cta-sub">Matchmaking pairs you with a random opponent (same mode)</span>
                    </button>
                    <button type="button" className="home-cta home-cta--secondary" onClick={() => void startNakamaBot()}>
                      <span className="home-cta-title">Play vs Bot</span>
                      <span className="home-cta-sub">Server-side minimax — no score entry for the bot</span>
                    </button>
                    <button type="button" className="home-cta home-cta--secondary" onClick={() => void startCreateNakamaPrivate()}>
                      <span className="home-cta-title">Private room</span>
                      <span className="home-cta-sub">Server creates a match — share the match ID so your friend can join</span>
                    </button>
                    <div className="home-join-row">
                      <input
                        className="input home-join-input"
                        placeholder="Friend’s match ID (UUID)"
                        value={nakamaJoinDraft}
                        onChange={(e) => setNakamaJoinDraft(e.target.value)}
                        spellCheck={false}
                        autoComplete="off"
                      />
                      <button
                        type="button"
                        className="home-join-btn btn secondary"
                        onClick={() => void joinNakamaMatchFromId(nakamaJoinDraft)}
                      >
                        Join game
                      </button>
                    </div>
                  </>
                )}
              </div>
            </section>

            <p className="home-hint">
              Symbols, background color, and sound are under Options in the toolbar — only you see those choices.
            </p>
          </div>
        </div>
      )}

      {phase === "queue" && (
        <div className="app-main app-main--home">
          <div className="home-backdrop" aria-hidden />
          <div className="home-panel">
            <header className="home-header">
              <p className="home-eyebrow">Matchmaking</p>
              <h1 className="home-title">Finding a player…</h1>
              <p className="home-lede">
                {local
                  ? `Open another tab, choose the same mode (${mode === "timed" ? "Timed" : "Classic"}), and queue again — you’ll pair automatically.`
                  : "Hang tight — we’re searching for an opponent. This usually takes a few seconds."}
              </p>
            </header>
            <div className="home-queue-visual" aria-hidden>
              <span className="home-queue-dot" />
              <span className="home-queue-dot" />
              <span className="home-queue-dot" />
            </div>
            <button type="button" className="home-cancel" onClick={() => void cancelQueue()}>
              Cancel search
            </button>
          </div>
        </div>
      )}

      {phase === "waiting_room" && hostedRoomCode && (
        <div className="app-main app-main--home">
          <div className="home-backdrop" aria-hidden />
          <div className="home-panel">
            <header className="home-header">
              <p className="home-eyebrow">Private room</p>
              <h1 className="home-title">Waiting for friend…</h1>
              <p className="home-lede">
                {nakamaPrivateHost
                  ? "Share the match ID. Your friend enters it under Join game on the home screen. Mode is the one you chose when creating this room (Classic or Timed above)."
                  : local
                    ? `Tell your friend the room ID. They enter it on the home screen and tap Join game. Mode for this room: ${mode === "timed" ? "Timed" : "Classic"}.`
                    : "Waiting for a second player to join this match."}
              </p>
            </header>
            {nakamaPrivateHost || local ? (
              <div className="room-code-block">
                <p className="home-section-title" style={{ marginBottom: "0.35rem" }}>
                  {nakamaPrivateHost ? "Match ID" : "Room ID"}
                </p>
                <div className="room-code-with-actions">
                  <div className={`room-code-display ${nakamaPrivateHost ? "room-code-display--uuid" : ""}`}>{hostedRoomCode}</div>
                  <button
                    type="button"
                    className="btn secondary room-copy-pill"
                    onClick={() => void copyRoomId()}
                    aria-label={nakamaPrivateHost ? "Copy match ID to clipboard" : "Copy room ID to clipboard"}
                  >
                    Copy
                  </button>
                </div>
                <div className="room-invite-actions">
                  <button type="button" className="home-cta home-cta--primary" onClick={() => void copyRoomId()}>
                    <span className="home-cta-title">{nakamaPrivateHost ? "Copy match ID" : "Copy room ID"}</span>
                    <span className="home-cta-sub">
                      {nakamaPrivateHost
                        ? "Friend enters this UUID under Join game on the home screen"
                        : "Friend enters this on the home screen → Join game"}
                    </span>
                  </button>
                </div>
              </div>
            ) : null}
            {statusMsg ? (
              <p
                className={
                  /copied/i.test(statusMsg) && !statusMsg.toLowerCase().startsWith("could not")
                    ? "room-copy-feedback"
                    : "home-error"
                }
              >
                {statusMsg}
              </p>
            ) : null}
            <button type="button" className="home-cancel" onClick={handleToolbarRestart}>
              Cancel room
            </button>
          </div>
        </div>
      )}

      {phase === "playing" && matchState && (
        <div className="app-main app-main--full">
          <div className="screen play screen--fullscreen">
            {vsLocalBot ? (
              <p className="muted small screen-play-hint">
                Vs bot — practice match; board UI and prefs work the same as human games.
              </p>
            ) : null}
            <div className="turn-row turn-row--stack" aria-live="polite">
              <span className="turn-badge turn-badge--glyph">{turnGlyph}</span>
              <div className="turn-row-body">
                <span className="turn-text">{turnPhrase || "Turn"}</span>
                {turnActorLine ? <span className="turn-sub">{turnActorLine}</span> : null}
              </div>
              {secondsLeft !== null ? <span className="timer">{secondsLeft}s</span> : null}
            </div>
            <GameBoard
              board={matchState.board}
              status={matchState.status}
              reason={matchState.reason}
              myPlayerSymbol={myPlayerSymbol}
              glyphMe={prefs.glyphMe}
              glyphThem={prefs.glyphThem}
              lastMoveIndex={lastMoveIndex}
              interactive
              onCellClick={(i) => void sendMove(i)}
              onPlayClickSound={() => playClick(prefs.soundOn)}
            />
            {opponentTurnNoticeKey !== null ? (
              <div className="play-turn-toast-slot" aria-live="polite">
                <div key={opponentTurnNoticeKey} className="play-turn-toast">
                  Opponent&apos;s turn
                </div>
              </div>
            ) : null}
            {statusMsg && <p className="error small">{statusMsg}</p>}
          </div>
        </div>
      )}

      {phase === "result" && matchState && (
        <div className="app-main app-main--full">
          <div className="screen dark screen--fullscreen screen--result">
            <div className="result-layout">
              <div className="result-layout__main">
                <div className="result-layout__board">
                  {vsLocalBot ? <p className="muted small result-hint">vs Bot — practice match</p> : null}
                  <GameBoard
                    board={matchState.board}
                    status={matchState.status}
                    reason={matchState.reason}
                    myPlayerSymbol={myPlayerSymbol}
                    glyphMe={prefs.glyphMe}
                    glyphThem={prefs.glyphThem}
                    lastMoveIndex={lastMoveIndex}
                    interactive={false}
                    className="game-board-wrap--result"
                  />
                </div>
                <div className="result-layout__actions">
                  <div className="result-play-again-wrap">
                    <button type="button" className="btn primary result-play-again" onClick={() => void playAgain()}>
                      Play again
                    </button>
                  </div>

                  {canHumanRematch ? (
                    <div className="result-rematch">
                      {rematchOutgoing ? (
                        <>
                          <p className="muted small result-rematch-lede">Waiting for opponent to accept…</p>
                          <button
                            type="button"
                            className="btn secondary wide"
                            onClick={() => localSessionRef.current?.rematchDecline()}
                          >
                            Cancel request
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="btn secondary wide"
                          onClick={() => {
                            setStatusMsg(null);
                            setRematchOutgoing(true);
                            localSessionRef.current?.rematchPropose();
                          }}
                        >
                          Request rematch
                        </button>
                      )}
                    </div>
                  ) : null}
                </div>
              </div>
              <aside className="result-layout__sidebar" aria-label="Leaderboard">
                <div className="result-lb-scroll">
                  <div className="lb-block lb-block--embedded">
                    <h3>Leaderboard</h3>
                    <table className="lb-table">
                      <thead>
                        <tr>
                          <th>#</th>
                          <th>Player</th>
                          <th>W/L/D</th>
                          <th>Streak</th>
                          <th>Score</th>
                        </tr>
                      </thead>
                      <tbody>
                        {leaderboard.length === 0 ? (
                          <tr>
                            <td colSpan={5} className="muted small">
                              No entries yet
                            </td>
                          </tr>
                        ) : (
                          leaderboard.map((r, idx) => {
                            const meta = r.metadata || {};
                            const w = Number(meta.wins ?? 0);
                            const l = Number(meta.losses ?? 0);
                            const d = Number(meta.draws ?? 0);
                            const streak = Number(meta.streak ?? r.subscore ?? 0);
                            const uname = r.username ?? "—";
                            const rid = r.ownerId;
                            const you = myUserId && rid === myUserId;
                            return (
                              <tr key={rid ?? idx}>
                                <td>{r.rank ?? idx + 1}</td>
                                <td>
                                  {uname}
                                  {you ? " (you)" : ""}
                                </td>
                                <td>
                                  {w}/{l}/{d}
                                </td>
                                <td>{streak}</td>
                                <td>{r.score ?? 0}</td>
                              </tr>
                            );
                          })
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </aside>
            </div>
          </div>
        </div>
      )}

      {phase === "result" && matchState && !resultOutcomeDismissed ? (
        <div
          className="modal-root modal-root--game-result"
          role="dialog"
          aria-modal="true"
          aria-labelledby="game-result-title"
          onClick={() => setResultOutcomeDismissed(true)}
        >
          <div className="modal-panel modal-panel--game-result" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="modal-x"
              aria-label="Close result summary"
              onClick={() => setResultOutcomeDismissed(true)}
            >
              ×
            </button>
            <div className="game-result-modal__icon" aria-hidden>
              {matchState.status === "draw" ? "=" : matchState.winnerUserId === myUserId ? "★" : "×"}
            </div>
            <h2 id="game-result-title" className="game-result-modal__title">
              {resultTitle()}
            </h2>
            {matchState.reason ? (
              <p className="game-result-modal__reason muted small">{formatMatchEndReason(matchState.reason)}</p>
            ) : null}
            <button type="button" className="btn primary wide game-result-modal__cta" onClick={() => setResultOutcomeDismissed(true)}>
              Continue
            </button>
          </div>
        </div>
      ) : null}

      {canHumanRematch && phase === "result" && rematchOfferFrom ? (
        <div
          className="modal-root modal-root--rematch"
          role="dialog"
          aria-modal="true"
          aria-labelledby="rematch-offer-title"
        >
          <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
            <h3 id="rematch-offer-title">Rematch</h3>
            <p className="muted small rematch-modal-lede">
              <strong>{rematchOfferFrom}</strong> wants a rematch.
            </p>
            <div className="result-rematch-actions">
              <button type="button" className="btn primary" onClick={() => localSessionRef.current?.rematchAccept()}>
                Accept
              </button>
              <button
                type="button"
                className="btn secondary"
                onClick={() => {
                  setRematchOfferFrom(null);
                  localSessionRef.current?.rematchDecline();
                }}
              >
                Decline
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {rematchNotice ? (
        <div
          className="modal-root modal-root--rematch"
          role="dialog"
          aria-modal="true"
          aria-labelledby="rematch-notice-title"
          onClick={() => setRematchNotice(null)}
        >
          <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
            <button type="button" className="modal-x" aria-label="Close" onClick={() => setRematchNotice(null)}>
              ×
            </button>
            <h3 id="rematch-notice-title">Rematch</h3>
            <p className="muted small rematch-notice-body">{rematchNotice}</p>
            <button type="button" className="btn primary wide" onClick={() => setRematchNotice(null)}>
              OK
            </button>
          </div>
        </div>
      ) : null}

      {lbModalOpen && (
          <div
            className="modal-root"
            role="dialog"
            aria-modal="true"
            aria-labelledby="lb-modal-title"
            onClick={() => closeLeaderboardModal()}
          >
            <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
              <button type="button" className="modal-x" aria-label="Close" onClick={() => closeLeaderboardModal()}>
                ×
              </button>
              <h3 id="lb-modal-title">Leaderboard</h3>
              {lbModalLoading && <p className="muted">Loading…</p>}
              {lbModalErr && <p className="error">{lbModalErr}</p>}
              {!lbModalLoading && !lbModalErr && (
                <table className="lb-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Player</th>
                      <th>W/L/D</th>
                      <th>Streak</th>
                      <th>Score</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lbModalRows.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="muted small">
                          No entries yet
                        </td>
                      </tr>
                    ) : (
                      lbModalRows.map((r, idx) => {
                        const meta = r.metadata || {};
                        const w = Number(meta.wins ?? 0);
                        const l = Number(meta.losses ?? 0);
                        const d = Number(meta.draws ?? 0);
                        const streak = Number(meta.streak ?? r.subscore ?? 0);
                        const uname = r.username ?? "—";
                        const rid = r.ownerId;
                        const you = myUserId && rid === myUserId;
                        return (
                          <tr key={rid ?? idx}>
                            <td>{r.rank ?? idx + 1}</td>
                            <td>
                              {uname}
                              {you ? " (you)" : ""}
                            </td>
                            <td>
                              {w}/{l}/{d}
                            </td>
                            <td>{streak}</td>
                            <td>{r.score ?? 0}</td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              )}
              <button type="button" className="btn primary wide" onClick={() => closeLeaderboardModal()}>
                Back to Play
              </button>
            </div>
          </div>
        )}
    </div>
  );
}
