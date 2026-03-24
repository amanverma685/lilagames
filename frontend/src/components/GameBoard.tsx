import { useMemo } from "react";
import { cellCenterPct, getWinningCells } from "../boardGeometry";
import type { MatchStatePayload } from "../gameTypes";

export type GameBoardProps = {
  board: number[];
  status: MatchStatePayload["status"];
  reason: string;
  myPlayerSymbol: 1 | 2;
  glyphMe: string;
  glyphThem: string;
  lastMoveIndex: number | null;
  interactive: boolean;
  onCellClick?: (index: number) => void;
  onPlayClickSound?: () => void;
  className?: string;
};

export function GameBoard({
  board,
  status,
  reason,
  myPlayerSymbol,
  glyphMe,
  glyphThem,
  lastMoveIndex,
  interactive,
  onCellClick,
  onPlayClickSound,
  className = "",
}: GameBoardProps) {
  const winCells = useMemo(() => getWinningCells(reason, status), [reason, status]);
  const winSet = useMemo(() => (winCells ? new Set(winCells) : null), [winCells]);

  const lineGeom = useMemo(() => {
    if (!winCells) return null;
    const [a, , c] = winCells;
    const p1 = cellCenterPct(a);
    const p2 = cellCenterPct(c);
    return { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y };
  }, [winCells]);

  const glyphForCell = (cell: number) => {
    if (cell === 0) return "";
    if (cell === myPlayerSymbol) return glyphMe;
    return glyphThem;
  };

  const handleCell = (i: number) => {
    if (!interactive || board[i] !== 0 || status !== "playing") return;
    onPlayClickSound?.();
    onCellClick?.(i);
  };

  return (
    <div className={`game-board-wrap ${className}`.trim()}>
      <div className="game-board-grid" role="grid" aria-label="Tic-tac-toe board">
        {board.map((cell, i) => {
          const isWin = winSet?.has(i) ?? false;
          const isPop = lastMoveIndex === i && cell !== 0;
          return (
            <button
              key={i}
              type="button"
              role="gridcell"
              className={`game-cell ${isWin ? "game-cell--win" : ""}`.trim()}
              disabled={!interactive || cell !== 0 || status !== "playing"}
              onClick={() => handleCell(i)}
              aria-label={cell === 0 ? `Empty cell ${i + 1}` : `Cell ${i + 1}: ${glyphForCell(cell)}`}
            >
              <span className={`game-cell-mark ${isPop ? "game-cell-mark--animate" : ""}`}>{glyphForCell(cell)}</span>
            </button>
          );
        })}
        {lineGeom && (
          <svg className="game-board-line-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
            <line
              className="game-board-line"
              pathLength={100}
              x1={lineGeom.x1}
              y1={lineGeom.y1}
              x2={lineGeom.x2}
              y2={lineGeom.y2}
            />
          </svg>
        )}
      </div>
    </div>
  );
}
