import type { Session, Socket } from "@heroiclabs/nakama-js";
import { Client } from "@heroiclabs/nakama-js";

function envBool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v === "") return fallback;
  return v === "true" || v === "1";
}

/** Build-time connection summary for RPC / WebSocket troubleshooting. */
export function nakamaConnectionSummary(): string {
  const host = import.meta.env.VITE_NAKAMA_HOST || "127.0.0.1";
  const port = String(import.meta.env.VITE_NAKAMA_PORT || "7350");
  const useSSL = envBool(import.meta.env.VITE_NAKAMA_USE_SSL, false);
  const scheme = useSSL ? "https/wss" : "http/ws";
  if (host.includes("://")) {
    return `${scheme} — INVALID: VITE_NAKAMA_HOST must be the hostname only (no https:// prefix). Got: ${host}`;
  }
  return `${scheme} host=${host} port=${port}`;
}

function isLikelyRpcIdMustSetMessage(msg: string): boolean {
  return msg.includes("RPC ID must be set");
}

function isFetchResponse(x: unknown): x is Response {
  return typeof x === "object" && x !== null && typeof (x as Response).json === "function";
}

/** nakama-js rejects failed HTTP with the raw `Response` — normalize to Error with JSON body message. */
export async function nakamaHttpFailureToError(err: unknown): Promise<Error> {
  if (err instanceof Error) {
    return err;
  }
  if (isFetchResponse(err)) {
    try {
      const j = (await err.json()) as { message?: string; error?: string };
      const m = j.message ?? j.error ?? `${err.status} ${err.statusText}`;
      return new Error(m);
    } catch {
      return new Error(`${err.status} ${err.statusText}`);
    }
  }
  return new Error(String(err));
}

export async function enhanceRpcError(err: unknown, rpcId: string): Promise<Error> {
  const e = await nakamaHttpFailureToError(err);
  const base = e.message;
  if (isLikelyRpcIdMustSetMessage(base)) {
    return new Error(
      `${base} (${rpcId}). On Nakama 3.24.x, HTTP RPC is broken (bad path id). This app falls back to WebSocket RPC; ` +
        `if you still see this, redeploy the server with NAKAMA_VERSION 3.25+ (see Dockerfile). ${nakamaConnectionSummary()}`,
    );
  }
  return e;
}

/** Human-readable message for UI (avoids "[object Response]" from uncaught fetch rejections). */
export function clientErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "object" && e !== null) {
    const o = e as Record<string, unknown>;
    if (typeof o.message === "string") return o.message;
  }
  const s = String(e);
  if (s === "[object Response]") return "Request failed — check your connection or refresh the page.";
  return s || "Something went wrong";
}

function normalizeSocketRpcResult(raw: unknown): { id?: string; payloadRaw?: string } {
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const o = raw as Record<string, unknown>;
  if ("rpc" in o && o.rpc !== null && typeof o.rpc === "object") {
    return normalizeSocketRpcResult(o.rpc);
  }
  const id = typeof o.id === "string" ? o.id : undefined;
  const payloadRaw = typeof o.payload === "string" ? o.payload : undefined;
  return { id, payloadRaw };
}

function parseRpcPayloadLikeClient(payloadRaw: string | undefined): unknown {
  if (payloadRaw === undefined || payloadRaw === "") {
    return undefined;
  }
  try {
    return JSON.parse(payloadRaw);
  } catch {
    return payloadRaw;
  }
}

type RpcOk = Awaited<ReturnType<Client["rpc"]>>;

/**
 * RPC over the realtime socket — sends `id` in the envelope (works on Nakama 3.24+).
 * Use when you already have an open socket (e.g. private room / bot flow).
 */
export async function nakamaRpcOverSocket(socket: Socket, rpcId: string, body: object): Promise<RpcOk> {
  const payloadStr = JSON.stringify(body);
  try {
    const raw = await socket.rpc(rpcId, payloadStr);
    const { id, payloadRaw } = normalizeSocketRpcResult(raw);
    return {
      id,
      payload: parseRpcPayloadLikeClient(payloadRaw) as object | undefined,
    };
  } catch (e) {
    throw await enhanceRpcError(e, rpcId);
  }
}

async function nakamaRpcViaEphemeralSocket(
  client: Client,
  session: Session,
  rpcId: string,
  body: object,
): Promise<RpcOk> {
  const sock = client.createSocket(client.useSSL, false);
  try {
    await sock.connect(session, true);
    return await nakamaRpcOverSocket(sock, rpcId, body);
  } finally {
    try {
      sock.disconnect(true);
    } catch {
      /* ignore */
    }
  }
}

export async function nakamaRpc(
  client: Client,
  session: Session,
  rpcId: string,
  body: object,
): Promise<RpcOk> {
  let rpcIdMissing = false;
  try {
    return await client.rpc(session, rpcId, body);
  } catch (e) {
    if (isFetchResponse(e) && e.status === 400) {
      try {
        const j = (await e.clone().json()) as { message?: string; error?: string };
        const m = j.message ?? j.error ?? "";
        rpcIdMissing = isLikelyRpcIdMustSetMessage(m);
      } catch {
        /* ignore */
      }
    } else {
      const conv = await nakamaHttpFailureToError(e);
      rpcIdMissing = isLikelyRpcIdMustSetMessage(conv.message);
    }
    if (rpcIdMissing) {
      try {
        return await nakamaRpcViaEphemeralSocket(client, session, rpcId, body);
      } catch (e2) {
        throw await enhanceRpcError(e2, rpcId);
      }
    }
    throw await enhanceRpcError(e, rpcId);
  }
}

export function createNakamaClient(): Client {
  const host = import.meta.env.VITE_NAKAMA_HOST || "127.0.0.1";
  const port = import.meta.env.VITE_NAKAMA_PORT || "7350";
  const serverKey = import.meta.env.VITE_NAKAMA_SERVER_KEY || "defaultkey";
  const useSSL = envBool(import.meta.env.VITE_NAKAMA_USE_SSL, false);
  return new Client(serverKey, host, port, useSSL);
}

/**
 * Stable device id across tabs (optional legacy / backups).
 */
export function getDeviceId(): string {
  const key = "lila_ttt_device_id";
  let id = localStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(key, id);
  }
  return id;
}

declare global {
  interface Window {
    /** Per browsing context; not copied when duplicating a tab (unlike sessionStorage). */
    __lilaTttTabPlayerId?: string;
  }
}

/**
 * Unique player identity per tab/window for device auth and the local WS server.
 *
 * sessionStorage is copied when you duplicate a tab, which made both tabs log in as the
 * same Nakama user — the matchmaker then never pairs you with a "second player".
 * A fresh UUID on each `window` keeps every tab distinct while this document lives.
 */
export function getSessionPlayerId(): string {
  try {
    if (!window.__lilaTttTabPlayerId) {
      window.__lilaTttTabPlayerId = crypto.randomUUID();
    }
    return window.__lilaTttTabPlayerId;
  } catch {
    return `tab_${Math.random().toString(36).slice(2, 12)}`;
  }
}
