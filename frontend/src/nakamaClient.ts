import type { Session } from "@heroiclabs/nakama-js";
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

/**
 * Nakama returns `RPC ID must be set` when the HTTP RPC path is malformed (missing id segment).
 * Common causes: VITE_NAKAMA_HOST points at the static site or a proxy that strips `/v2/rpc/<id>`.
 */
export function enhanceRpcError(err: unknown, rpcId: string): Error {
  const base = err instanceof Error ? err.message : String(err);
  if (base.includes("RPC ID must be set")) {
    return new Error(
      `${base} (${rpcId}). The RPC id was missing from the request path — usually the client is not ` +
        `talking to the Nakama API host, or a reverse proxy rewrote the URL. ${nakamaConnectionSummary()} ` +
        `Ensure VITE_NAKAMA_SERVER_KEY matches Nakama server_key.`,
    );
  }
  return err instanceof Error ? err : new Error(base);
}

export async function nakamaRpc(
  client: Client,
  session: Session,
  rpcId: string,
  body: object,
): Promise<ReturnType<Client["rpc"]>> {
  try {
    return await client.rpc(session, rpcId, body);
  } catch (e) {
    throw enhanceRpcError(e, rpcId);
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
