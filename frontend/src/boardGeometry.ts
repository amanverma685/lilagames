/** Same order as server `checkWin` in server/main.go */
export const WIN_LINES: [number, number, number][] = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

export const WIN_LINE_LABELS = [
  "Top row",
  "Middle row",
  "Bottom row",
  "Left column",
  "Middle column",
  "Right column",
  "Main diagonal",
  "Anti-diagonal",
] as const;

export function parseWinLineIndex(reason: string): number | null {
  const m = /^line_(\d+)$/.exec(reason);
  if (!m) return null;
  const idx = Number(m[1]);
  if (!Number.isInteger(idx) || idx < 0 || idx >= WIN_LINES.length) return null;
  return idx;
}

export function getWinningCells(reason: string, status: string): [number, number, number] | null {
  if (status !== "win") return null;
  const idx = parseWinLineIndex(reason);
  if (idx === null) return null;
  return WIN_LINES[idx];
}

/** Normalized 0–100 coords for SVG overlay over 3×3 grid */
export function cellCenterPct(index: number): { x: number; y: number } {
  const row = Math.floor(index / 3);
  const col = index % 3;
  return {
    x: ((col + 0.5) / 3) * 100,
    y: ((row + 0.5) / 3) * 100,
  };
}
