import { useState } from "react";
import type { GamePreferences } from "../gamePreferences";
import { clampGlyph, DEFAULT_PREFERENCES, savePreferences } from "../gamePreferences";

const PRESET_GLYPHS = ["✕", "○", "♔", "♕", "♚", "♛", "★", "●", "▲", "🦁", "🐯", "🔥", "💎", "⚡"];

const BG_SWATCHES = ["#0d3d36", "#1a1a2e", "#16213e", "#0f3460", "#2d132c", "#1b1b1b", "#2c1810", "#1a3a3a"];

function randomDarkBackground(): string {
  if (Math.random() < 0.45) {
    const i = Math.floor(Math.random() * BG_SWATCHES.length);
    return BG_SWATCHES[i] ?? "#1a1a2e";
  }
  const h = Math.floor(Math.random() * 360);
  const s = 28 + Math.floor(Math.random() * 38);
  const l = 12 + Math.floor(Math.random() * 18);
  return `hsl(${h} ${s}% ${l}%)`;
}

function pickTwoDistinctGlyphs(): [string, string] {
  const pool = PRESET_GLYPHS;
  const pick = () => pool[Math.floor(Math.random() * pool.length)] ?? "✕";
  const a = pick();
  let b = pick();
  let guard = 0;
  while (b === a && pool.length > 1 && guard++ < 32) {
    b = pick();
  }
  return [a, b];
}

type Props = {
  open: boolean;
  onClose: () => void;
  preferences: GamePreferences;
  onApply: (next: GamePreferences) => void;
};

export function GameMenuPanel({ open, onClose, preferences, onApply }: Props) {
  const [customMe, setCustomMe] = useState("");
  const [customThem, setCustomThem] = useState("");

  if (!open) return null;

  const applyPresetMe = (g: string) => {
    const next = { ...preferences, glyphMe: clampGlyph(g, DEFAULT_PREFERENCES.glyphMe) };
    savePreferences(next);
    onApply(next);
  };

  const applyPresetThem = (g: string) => {
    const next = { ...preferences, glyphThem: clampGlyph(g, DEFAULT_PREFERENCES.glyphThem) };
    savePreferences(next);
    onApply(next);
  };

  const applyCustomMe = () => {
    const next = { ...preferences, glyphMe: clampGlyph(customMe, preferences.glyphMe) };
    savePreferences(next);
    onApply(next);
    setCustomMe("");
  };

  const applyCustomThem = () => {
    const next = { ...preferences, glyphThem: clampGlyph(customThem, preferences.glyphThem) };
    savePreferences(next);
    onApply(next);
    setCustomThem("");
  };

  const setBg = (hex: string) => {
    const next = { ...preferences, backgroundColor: hex };
    savePreferences(next);
    onApply(next);
  };

  const applyRandomLook = () => {
    const [gMe, gThem] = pickTwoDistinctGlyphs();
    const next: GamePreferences = {
      ...preferences,
      backgroundColor: randomDarkBackground(),
      glyphMe: clampGlyph(gMe, DEFAULT_PREFERENCES.glyphMe),
      glyphThem: clampGlyph(gThem, DEFAULT_PREFERENCES.glyphThem),
    };
    savePreferences(next);
    onApply(next);
  };

  return (
    <div className="menu-overlay" role="dialog" aria-modal="true" aria-labelledby="menu-title" onClick={onClose}>
      <div className="menu-panel" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="modal-x" aria-label="Close menu" onClick={onClose}>
          ×
        </button>
        <div className="menu-panel-header">
          <h2 id="menu-title" className="menu-title">
            Game menu
          </h2>
          <p className="muted small menu-panel-lede">Symbols and colors are only on your screen — not sent to other players.</p>
        </div>

        <div className="menu-random-row">
          <button type="button" className="btn secondary menu-random-btn wide" onClick={applyRandomLook}>
            Random
          </button>
          <p className="muted small menu-random-hint">New background, your mark, and their mark (local only).</p>
        </div>

        <div className="menu-panel-grid">
          <div className="menu-panel-col menu-panel-col--bg">
            <section className="menu-section menu-section--compact">
              <h3>Background</h3>
              <div className="menu-color-row">
                <label className="menu-color-label">
                  Color
                  <input
                    type="color"
                    value={preferences.backgroundColor}
                    onChange={(e) => setBg(e.target.value)}
                    className="menu-color-input"
                  />
                </label>
                <div className="menu-swatches">
                  {BG_SWATCHES.map((c) => (
                    <button
                      key={c}
                      type="button"
                      className={`menu-swatch ${preferences.backgroundColor === c ? "menu-swatch--active" : ""}`}
                      style={{ background: c }}
                      onClick={() => setBg(c)}
                      aria-label={`Background ${c}`}
                    />
                  ))}
                </div>
              </div>
            </section>
          </div>

          <div className="menu-panel-col menu-panel-col--mark-me">
            <section className="menu-section menu-section--compact">
              <h3>My mark</h3>
              <div className="menu-presets menu-presets--fixed">
                {PRESET_GLYPHS.map((g) => (
                  <button
                    key={`me-${g}`}
                    type="button"
                    className={`menu-glyph-btn menu-glyph-btn--me ${preferences.glyphMe === g ? "menu-glyph-btn--active-me" : ""}`}
                    onClick={() => applyPresetMe(g)}
                    aria-pressed={preferences.glyphMe === g}
                  >
                    {g}
                  </button>
                ))}
              </div>
              <div className="menu-custom-row">
                <input
                  className="input menu-input"
                  placeholder="Custom (emoji or text)"
                  value={customMe}
                  onChange={(e) => setCustomMe(e.target.value)}
                  maxLength={32}
                />
                <button type="button" className="btn secondary menu-apply" onClick={applyCustomMe}>
                  Apply
                </button>
              </div>
            </section>
          </div>

          <div className="menu-panel-col menu-panel-col--mark-them">
            <section className="menu-section menu-section--compact">
              <h3>Their mark (on your screen)</h3>
              <div className="menu-presets menu-presets--fixed">
                {PRESET_GLYPHS.map((g) => (
                  <button
                    key={`them-${g}`}
                    type="button"
                    className={`menu-glyph-btn menu-glyph-btn--them ${preferences.glyphThem === g ? "menu-glyph-btn--active-them" : ""}`}
                    onClick={() => applyPresetThem(g)}
                    aria-pressed={preferences.glyphThem === g}
                  >
                    {g}
                  </button>
                ))}
              </div>
              <div className="menu-custom-row">
                <input
                  className="input menu-input"
                  placeholder="Custom"
                  value={customThem}
                  onChange={(e) => setCustomThem(e.target.value)}
                  maxLength={32}
                />
                <button type="button" className="btn secondary menu-apply" onClick={applyCustomThem}>
                  Apply
                </button>
              </div>
            </section>
          </div>
        </div>

        <div className="menu-panel-footer">
          <button type="button" className="btn primary wide menu-done-btn" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
