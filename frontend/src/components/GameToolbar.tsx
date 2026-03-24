type Props = {
  onMenu: () => void;
  onRestart: () => void;
  onLeaderboard: () => void;
  soundOn: boolean;
  onToggleSound: () => void;
  showRestart: boolean;
};

function IconMenu() {
  return (
    <svg className="toolbar-ico" viewBox="0 0 24 24" aria-hidden>
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        d="M4 6h16M4 12h16M4 18h16"
      />
    </svg>
  );
}

function IconRestart() {
  return (
    <svg className="toolbar-ico" viewBox="0 0 24 24" aria-hidden>
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M21 12a9 9 0 11-2.64-6.36M21 3v6h-6"
      />
    </svg>
  );
}

function IconSoundOn() {
  return (
    <svg className="toolbar-ico" viewBox="0 0 24 24" aria-hidden>
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M11 5L6 9H3v6h3l5 4V5zM15.5 8.5a5 5 0 010 7M18 6a8 8 0 010 12"
      />
    </svg>
  );
}

function IconSoundOff() {
  return (
    <svg className="toolbar-ico" viewBox="0 0 24 24" aria-hidden>
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M11 5L6 9H3v6h3l5 4V5zM23 9l-6 6M17 9l6 6"
      />
    </svg>
  );
}

function IconLeaderboard() {
  return (
    <svg className="toolbar-ico" viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="14" width="5" height="7" rx="1" />
      <rect x="9.5" y="10" width="5" height="11" rx="1" />
      <rect x="16" y="6" width="5" height="15" rx="1" />
    </svg>
  );
}

export function GameToolbar({ onMenu, onRestart, onLeaderboard, soundOn, onToggleSound, showRestart }: Props) {
  return (
    <header className="game-toolbar game-toolbar--side" aria-label="Game actions">
      <button type="button" className="toolbar-btn" onClick={onMenu}>
        <IconMenu />
        <span className="toolbar-btn-label">Menu</span>
      </button>
      {showRestart ? (
        <button
          type="button"
          className="toolbar-btn"
          onClick={onRestart}
          title="Leave match and return to lobby"
        >
          <IconRestart />
          <span className="toolbar-btn-label">Restart</span>
        </button>
      ) : null}
      <button
        type="button"
        className={`toolbar-btn ${soundOn ? "" : "toolbar-btn--muted"}`}
        onClick={onToggleSound}
        title={soundOn ? "Sound on" : "Sound off"}
        aria-pressed={soundOn}
      >
        {soundOn ? <IconSoundOn /> : <IconSoundOff />}
        <span className="toolbar-btn-label">{soundOn ? "Sound on" : "Muted"}</span>
      </button>
      <button type="button" className="toolbar-btn" onClick={onLeaderboard} aria-label="Leaderboard">
        <IconLeaderboard />
        <span className="toolbar-btn-label-split" aria-hidden>
          <span>Leader</span>
          <span>board</span>
        </span>
      </button>
    </header>
  );
}
