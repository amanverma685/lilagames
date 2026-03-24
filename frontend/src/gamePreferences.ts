export type GamePreferences = {
  backgroundColor: string;
  glyphMe: string;
  glyphThem: string;
  soundOn: boolean;
};

const KEY_BG = "lila_ttt_pref_bg";
const KEY_ME = "lila_ttt_pref_glyph_me";
const KEY_THEM = "lila_ttt_pref_glyph_them";
const KEY_SOUND = "lila_ttt_pref_sound_on";

export const DEFAULT_PREFERENCES: GamePreferences = {
  backgroundColor: "#0d3d36",
  glyphMe: "✕",
  glyphThem: "○",
  soundOn: true,
};

/** Max grapheme clusters to avoid huge layout / abuse */
const MAX_GLYPH_GRAPHEMES = 4;

export function clampGlyph(raw: string, fallback: string): string {
  const s = raw.trim();
  if (!s) return fallback;
  const chars = [...s];
  const sliced = chars.slice(0, MAX_GLYPH_GRAPHEMES).join("");
  return sliced.length > 0 ? sliced : fallback;
}

function readString(key: string, fallback: string, clampAsGlyph: boolean): string {
  try {
    const v = sessionStorage.getItem(key);
    if (v == null) return fallback;
    return clampAsGlyph ? clampGlyph(v, fallback) : v;
  } catch {
    return fallback;
  }
}

function readBool(key: string, fallback: boolean): boolean {
  try {
    const v = sessionStorage.getItem(key);
    if (v === null) return fallback;
    return v === "1" || v === "true";
  } catch {
    return fallback;
  }
}

export function loadPreferences(): GamePreferences {
  return {
    backgroundColor: readString(KEY_BG, DEFAULT_PREFERENCES.backgroundColor, false),
    glyphMe: readString(KEY_ME, DEFAULT_PREFERENCES.glyphMe, true),
    glyphThem: readString(KEY_THEM, DEFAULT_PREFERENCES.glyphThem, true),
    soundOn: readBool(KEY_SOUND, DEFAULT_PREFERENCES.soundOn),
  };
}

export function savePreferences(p: Partial<GamePreferences>): void {
  try {
    if (p.backgroundColor !== undefined) sessionStorage.setItem(KEY_BG, p.backgroundColor);
    if (p.glyphMe !== undefined) sessionStorage.setItem(KEY_ME, clampGlyph(p.glyphMe, DEFAULT_PREFERENCES.glyphMe));
    if (p.glyphThem !== undefined) sessionStorage.setItem(KEY_THEM, clampGlyph(p.glyphThem, DEFAULT_PREFERENCES.glyphThem));
    if (p.soundOn !== undefined) sessionStorage.setItem(KEY_SOUND, p.soundOn ? "1" : "0");
  } catch {
    /* ignore quota / private mode */
  }
}
