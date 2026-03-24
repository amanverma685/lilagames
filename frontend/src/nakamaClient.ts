import { Client } from "@heroiclabs/nakama-js";

function envBool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v === "") return fallback;
  return v === "true" || v === "1";
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
