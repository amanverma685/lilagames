package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"github.com/heroiclabs/nakama-common/api"
	"github.com/heroiclabs/nakama-common/runtime"
)

const (
	matchName = "tic_tac_toe"

	opSnapshot int64 = 1
	opMove     int64 = 2
	opError    int64 = 3

	defaultLeaderboardID = "tic_tac_toe_global"

	turnSecondsTimed = 30
	pointsWin        = 200
	pointsDraw       = 50

	botMoveDelay = time.Second

	// Must match frontend LOCAL_BOT_USER_ID / local-server BOT_ID.
	botUserID = "__bot__"
)

type gameMode string

const (
	modeClassic gameMode = "classic"
	modeTimed   gameMode = "timed"
)

type playerSlot struct {
	UserID   string `json:"userId"`
	Username string `json:"username"`
	Symbol   int    `json:"symbol"` // 1 = X, 2 = O
}

// MatchState is authoritative game state (JSON snapshot sent to clients).
type MatchState struct {
	Board       [9]int       `json:"board"`
	Players     []playerSlot `json:"players"`
	TurnSymbol  int          `json:"turnSymbol"` // 1 or 2
	Status      string       `json:"status"`     // playing, win, draw, forfeit
	WinnerID    string       `json:"winnerUserId"`
	Reason      string       `json:"reason"`
	Mode        string       `json:"mode"`
	DeadlineSec int64        `json:"deadlineUnix"` // unix seconds; 0 if not timed
	VsBot       bool         `json:"vsBot"`
	TickRate    int          `json:"-"`
	// Earliest Unix ms at which the bot may move; 0 means no delay armed (see tryApplyBotMove).
	BotMoveEarliestMs int64 `json:"-"`
}

type moveMsg struct {
	Index int `json:"index"`
}

func leaderboardIDFromEnv(ctx context.Context) string {
	if env, ok := ctx.Value(runtime.RUNTIME_CTX_ENV).(map[string]string); ok {
		if v := env["LEADERBOARD_ID"]; v != "" {
			return v
		}
	}
	return defaultLeaderboardID
}

func InitModule(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, initializer runtime.Initializer) error {
	lbID := leaderboardIDFromEnv(ctx)
	if err := nk.LeaderboardCreate(ctx, lbID, true, "desc", "incr", "", map[string]interface{}{
		"game": "tic_tac_toe",
	}, true); err != nil {
		logger.Info("leaderboard create (ok if exists): %v", err)
	}

	if err := initializer.RegisterMatch(matchName, func(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule) (runtime.Match, error) {
		return &TicMatch{}, nil
	}); err != nil {
		return err
	}

	if err := initializer.RegisterMatchmakerMatched(func(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, entries []runtime.MatchmakerEntry) (string, error) {
		if len(entries) != 2 {
			return "", fmt.Errorf("expected 2 players, got %d", len(entries))
		}
		mode := string(modeClassic)
		for _, e := range entries {
			if props := e.GetProperties(); props != nil {
				if m, ok := props["mode"].(string); ok && (m == string(modeTimed) || m == string(modeClassic)) {
					mode = m
					break
				}
			}
		}
		matchID, err := nk.MatchCreate(ctx, matchName, map[string]interface{}{
			"mode": mode,
		})
		if err != nil {
			return "", err
		}
		return matchID, nil
	}); err != nil {
		return err
	}

	if err := initializer.RegisterRpc("leaderboard_top", rpcLeaderboardTop); err != nil {
		return err
	}

	if err := initializer.RegisterRpc("create_private_match", rpcCreatePrivateMatch); err != nil {
		return err
	}

	if err := initializer.RegisterRpc("create_bot_match", rpcCreateBotMatch); err != nil {
		return err
	}

	return nil
}

func rpcCreatePrivateMatch(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, payload string) (string, error) {
	_ = logger
	userID, ok := ctx.Value(runtime.RUNTIME_CTX_USER_ID).(string)
	if !ok || userID == "" {
		return "", fmt.Errorf("must be signed in to create a room")
	}
	var in struct {
		Mode string `json:"mode"`
	}
	if payload != "" {
		_ = json.Unmarshal([]byte(payload), &in)
	}
	mode := string(modeClassic)
	switch in.Mode {
	case string(modeTimed):
		mode = string(modeTimed)
	case string(modeClassic):
		mode = string(modeClassic)
	}
	matchID, err := nk.MatchCreate(ctx, matchName, map[string]interface{}{
		"mode": mode,
	})
	if err != nil {
		return "", err
	}
	b, err := json.Marshal(map[string]string{"matchId": matchID})
	if err != nil {
		return "", err
	}
	return string(b), nil
}

func rpcCreateBotMatch(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, payload string) (string, error) {
	_ = logger
	userID, ok := ctx.Value(runtime.RUNTIME_CTX_USER_ID).(string)
	if !ok || userID == "" {
		return "", fmt.Errorf("must be signed in to start a bot match")
	}
	var in struct {
		Mode string `json:"mode"`
	}
	if payload != "" {
		_ = json.Unmarshal([]byte(payload), &in)
	}
	mode := string(modeClassic)
	switch in.Mode {
	case string(modeTimed):
		mode = string(modeTimed)
	case string(modeClassic):
		mode = string(modeClassic)
	}
	matchID, err := nk.MatchCreate(ctx, matchName, map[string]interface{}{
		"mode":   mode,
		"vs_bot": true,
	})
	if err != nil {
		return "", err
	}
	b, err := json.Marshal(map[string]string{"matchId": matchID})
	if err != nil {
		return "", err
	}
	return string(b), nil
}

func rpcLeaderboardTop(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, payload string) (string, error) {
	lbID := leaderboardIDFromEnv(ctx)
	records, _, _, _, err := nk.LeaderboardRecordsList(ctx, lbID, nil, 20, "", 0)
	if err != nil {
		return "", err
	}
	out := make([]map[string]interface{}, 0, len(records))
	for _, r := range records {
		var metaOut interface{}
		if prev := recordMetadataMap(r.GetMetadata()); prev != nil {
			metaOut = prev
		}
		out = append(out, map[string]interface{}{
			"rank":     r.Rank,
			"ownerId":  r.OwnerId,
			"username": recordUsername(r),
			"score":    r.Score,
			"subscore": r.Subscore,
			"metadata": metaOut,
		})
	}
	b, err := json.Marshal(out)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// TicMatch implements server-authoritative tic-tac-toe.
type TicMatch struct{}

func (m *TicMatch) MatchInit(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, params map[string]interface{}) (interface{}, int, string) {
	mode := modeClassic
	if raw, ok := params["mode"].(string); ok {
		if raw == string(modeTimed) {
			mode = modeTimed
		}
	}
	vsBot := false
	if v, ok := params["vs_bot"]; ok {
		switch t := v.(type) {
		case bool:
			vsBot = t
		case string:
			vsBot = t == "true" || t == "1"
		}
	}
	st := &MatchState{
		Status:   "playing",
		Mode:     string(mode),
		TickRate: 5,
		VsBot:    vsBot,
	}
	label := fmt.Sprintf("game=tic_tac_toe mode=%s", st.Mode)
	if vsBot {
		label = label + " vs_bot=1"
	}
	return st, st.TickRate, label
}

func (m *TicMatch) MatchJoinAttempt(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, dispatcher runtime.MatchDispatcher, tick int64, state interface{}, presence runtime.Presence, metadata map[string]string) (interface{}, bool, string) {
	st := state.(*MatchState)
	if st.Status != "playing" {
		return st, false, "match finished"
	}
	uid := presence.GetUserId()
	if st.VsBot {
		if uid == botUserID {
			return st, false, "bot is server-managed"
		}
		for _, p := range st.Players {
			if p.UserID == uid {
				return st, true, ""
			}
		}
		humans := 0
		for _, p := range st.Players {
			if p.UserID != botUserID {
				humans++
			}
		}
		if humans >= 1 {
			return st, false, "room full"
		}
		return st, true, ""
	}
	for _, p := range st.Players {
		if p.UserID == uid {
			return st, true, ""
		}
	}
	if len(st.Players) >= 2 {
		return st, false, "room full"
	}
	return st, true, ""
}

func (m *TicMatch) MatchJoin(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, dispatcher runtime.MatchDispatcher, tick int64, state interface{}, presences []runtime.Presence) interface{} {
	st := state.(*MatchState)
	for _, presence := range presences {
		uid := presence.GetUserId()
		if st.VsBot && uid == botUserID {
			continue
		}
		exists := false
		for _, p := range st.Players {
			if p.UserID == uid {
				exists = true
				break
			}
		}
		if exists {
			continue
		}
		symbol := 1
		if len(st.Players) == 1 {
			symbol = 2
		}
		st.Players = append(st.Players, playerSlot{
			UserID:   uid,
			Username: presence.GetUsername(),
			Symbol:   symbol,
		})
	}
	if st.VsBot {
		ensureBotPlayer(st)
	}
	if len(st.Players) == 2 && st.TurnSymbol == 0 {
		st.TurnSymbol = 1
	}
	if st.Mode == string(modeTimed) && len(st.Players) == 2 && st.DeadlineSec == 0 {
		st.DeadlineSec = time.Now().Add(time.Duration(turnSecondsTimed) * time.Second).Unix()
	}
	_ = broadcastState(dispatcher, st, nil)
	return st
}

func (m *TicMatch) MatchLeave(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, dispatcher runtime.MatchDispatcher, tick int64, state interface{}, presences []runtime.Presence) interface{} {
	st := state.(*MatchState)
	if st.Status != "playing" {
		return st
	}
	for _, gone := range presences {
		leaverID := gone.GetUserId()
		wasPlayer := false
		for _, pl := range st.Players {
			if pl.UserID == leaverID {
				wasPlayer = true
				break
			}
		}
		if !wasPlayer {
			continue
		}
		var opponentID string
		for _, pl := range st.Players {
			if pl.UserID != leaverID {
				opponentID = pl.UserID
				break
			}
		}
		if opponentID != "" {
			st.Status = "forfeit"
			st.WinnerID = opponentID
			st.Reason = "opponent_left"
			applyMatchResults(ctx, nk, st)
			_ = broadcastState(dispatcher, st, nil)
			return st
		}
		// Sole player left (e.g. host waiting in a private room) — no leaderboard update.
		st.Status = "abandoned"
		st.WinnerID = ""
		st.Reason = "host_left"
		_ = broadcastState(dispatcher, st, nil)
		return st
	}
	return st
}

func (m *TicMatch) MatchLoop(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, dispatcher runtime.MatchDispatcher, tick int64, state interface{}, messages []runtime.MatchData) interface{} {
	_ = logger
	_ = db
	st := state.(*MatchState)

	if st.Status == "playing" && st.Mode == string(modeTimed) && len(st.Players) == 2 && st.DeadlineSec > 0 {
		if time.Now().Unix() >= st.DeadlineSec {
			// Current mover forfeits.
			for _, pl := range st.Players {
				if pl.Symbol == st.TurnSymbol {
					for _, other := range st.Players {
						if other.UserID != pl.UserID {
							st.Status = "forfeit"
							st.WinnerID = other.UserID
							st.Reason = "turn_timeout"
							applyMatchResults(ctx, nk, st)
							_ = broadcastState(dispatcher, st, nil)
							return st
						}
					}
				}
			}
		}
	}

	for _, msg := range messages {
		if msg.GetOpCode() != opMove {
			continue
		}
		sender := msg.GetUserId()
		var mv moveMsg
		if err := json.Unmarshal(msg.GetData(), &mv); err != nil || mv.Index < 0 || mv.Index > 8 {
			_ = sendError(dispatcher, sender, "invalid_move_payload")
			continue
		}
		if st.Status != "playing" {
			_ = sendError(dispatcher, sender, "game_over")
			continue
		}
		if len(st.Players) < 2 {
			_ = sendError(dispatcher, sender, "waiting_for_opponent")
			continue
		}
		var mover *playerSlot
		for i := range st.Players {
			if st.Players[i].UserID == sender {
				mover = &st.Players[i]
				break
			}
		}
		if mover == nil {
			_ = sendError(dispatcher, sender, "not_in_match")
			continue
		}
		if mover.Symbol != st.TurnSymbol {
			_ = sendError(dispatcher, sender, "not_your_turn")
			continue
		}
		if st.Board[mv.Index] != 0 {
			_ = sendError(dispatcher, sender, "cell_taken")
			continue
		}
		ended := completeMove(ctx, nk, st, sender, mv.Index)
		_ = broadcastState(dispatcher, st, nil)
		if ended {
			continue
		}
		tryApplyBotMove(ctx, nk, dispatcher, st)
	}
	if len(messages) == 0 {
		tryApplyBotMove(ctx, nk, dispatcher, st)
	}
	return st
}

func (m *TicMatch) MatchTerminate(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, dispatcher runtime.MatchDispatcher, tick int64, state interface{}, graceSeconds int) interface{} {
	return state
}

func (m *TicMatch) MatchSignal(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, dispatcher runtime.MatchDispatcher, tick int64, state interface{}, data string) (interface{}, string) {
	return state, ""
}

func ensureBotPlayer(st *MatchState) {
	if !st.VsBot {
		return
	}
	hasBot := false
	humans := 0
	for _, p := range st.Players {
		if p.UserID == botUserID {
			hasBot = true
		} else {
			humans++
		}
	}
	if hasBot || humans != 1 {
		return
	}
	st.Players = append(st.Players, playerSlot{
		UserID:   botUserID,
		Username: "Bot",
		Symbol:   2,
	})
}

// completeMove applies a validated move; returns true if the match ended (win/draw).
func completeMove(ctx context.Context, nk runtime.NakamaModule, st *MatchState, userID string, idx int) (ended bool) {
	var mover *playerSlot
	for i := range st.Players {
		if st.Players[i].UserID == userID {
			mover = &st.Players[i]
			break
		}
	}
	if mover == nil || mover.Symbol != st.TurnSymbol || idx < 0 || idx > 8 || st.Board[idx] != 0 {
		return false
	}
	st.Board[idx] = mover.Symbol
	if w, line := checkWin(st.Board); w != 0 {
		st.Status = "win"
		st.WinnerID = userID
		st.Reason = fmt.Sprintf("line_%v", line)
		applyMatchResults(ctx, nk, st)
		return true
	}
	if boardFull(st.Board) {
		st.Status = "draw"
		st.Reason = "board_full"
		applyMatchResults(ctx, nk, st)
		return true
	}
	st.TurnSymbol = 3 - st.TurnSymbol
	if st.Mode == string(modeTimed) {
		st.DeadlineSec = time.Now().Add(time.Duration(turnSecondsTimed) * time.Second).Unix()
	}
	return false
}

func terminalMinimaxScore(b [9]int, botSym, humSym int) (score int, done bool) {
	w, _ := checkWin(b)
	if w == botSym {
		return 10, true
	}
	if w == humSym {
		return -10, true
	}
	if boardFull(b) {
		return 0, true
	}
	return 0, false
}

func minimaxTTT(b [9]int, isMax bool, botSym, humSym int) int {
	if sc, ok := terminalMinimaxScore(b, botSym, humSym); ok {
		return sc
	}
	if isMax {
		best := -1000000
		for i := 0; i < 9; i++ {
			if b[i] != 0 {
				continue
			}
			nb := b
			nb[i] = botSym
			v := minimaxTTT(nb, false, botSym, humSym)
			if v > best {
				best = v
			}
		}
		return best
	}
	best := 1000000
	for i := 0; i < 9; i++ {
		if b[i] != 0 {
			continue
		}
		nb := b
		nb[i] = humSym
		v := minimaxTTT(nb, true, botSym, humSym)
		if v < best {
			best = v
		}
	}
	return best
}

func minimaxPick(board [9]int, botSym int) int {
	humSym := 3 - botSym
	bestI := -1
	bestV := -1000000
	for i := 0; i < 9; i++ {
		if board[i] != 0 {
			continue
		}
		nb := board
		nb[i] = botSym
		v := minimaxTTT(nb, false, botSym, humSym)
		if v > bestV {
			bestV = v
			bestI = i
		}
	}
	return bestI
}

func tryApplyBotMove(ctx context.Context, nk runtime.NakamaModule, dispatcher runtime.MatchDispatcher, st *MatchState) {
	if !st.VsBot || st.Status != "playing" || len(st.Players) < 2 {
		return
	}
	var bot *playerSlot
	for i := range st.Players {
		if st.Players[i].UserID == botUserID {
			bot = &st.Players[i]
			break
		}
	}
	if bot == nil || bot.Symbol != st.TurnSymbol {
		return
	}
	nowMs := time.Now().UnixMilli()
	if st.BotMoveEarliestMs == 0 {
		st.BotMoveEarliestMs = nowMs + botMoveDelay.Milliseconds()
		return
	}
	if nowMs < st.BotMoveEarliestMs {
		return
	}

	idx := minimaxPick(st.Board, bot.Symbol)
	if idx < 0 || st.Board[idx] != 0 {
		return
	}
	st.BotMoveEarliestMs = 0
	_ = completeMove(ctx, nk, st, botUserID, idx)
	_ = broadcastState(dispatcher, st, nil)
}

func sendError(dispatcher runtime.MatchDispatcher, userID string, code string) error {
	payload, _ := json.Marshal(map[string]string{"code": code, "for": userID})
	return dispatcher.BroadcastMessage(opError, payload, nil, nil, true)
}

func broadcastState(dispatcher runtime.MatchDispatcher, st *MatchState, sender runtime.Presence) error {
	b, err := json.Marshal(st)
	if err != nil {
		return err
	}
	return dispatcher.BroadcastMessage(opSnapshot, b, nil, sender, true)
}

func boardFull(b [9]int) bool {
	for _, c := range b {
		if c == 0 {
			return false
		}
	}
	return true
}

func checkWin(b [9]int) (symbol int, line string) {
	lines := [][3]int{
		{0, 1, 2}, {3, 4, 5}, {6, 7, 8},
		{0, 3, 6}, {1, 4, 7}, {2, 5, 8},
		{0, 4, 8}, {2, 4, 6},
	}
	for i, ln := range lines {
		a, c, d := ln[0], ln[1], ln[2]
		if b[a] != 0 && b[a] == b[c] && b[a] == b[d] {
			return b[a], fmt.Sprintf("%d", i)
		}
	}
	return 0, ""
}

func applyMatchResults(ctx context.Context, nk runtime.NakamaModule, st *MatchState) {
	lbID := leaderboardIDFromEnv(ctx)
	switch st.Status {
	case "win", "forfeit":
		for _, pl := range st.Players {
			if pl.UserID == st.WinnerID {
				_ = adjustLeaderboard(ctx, nk, lbID, pl.UserID, pl.Username, pointsWin, true, false, false)
			} else {
				_ = adjustLeaderboard(ctx, nk, lbID, pl.UserID, pl.Username, 0, false, true, false)
			}
		}
	case "draw":
		for _, pl := range st.Players {
			_ = adjustLeaderboard(ctx, nk, lbID, pl.UserID, pl.Username, pointsDraw, false, false, true)
		}
	}
}

func recordUsername(r *api.LeaderboardRecord) string {
	if r == nil {
		return ""
	}
	if u := r.GetUsername(); u != nil {
		return u.GetValue()
	}
	return ""
}

func recordMetadataMap(raw string) map[string]interface{} {
	if raw == "" {
		return nil
	}
	var m map[string]interface{}
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		return nil
	}
	return m
}

func metaInt(m map[string]interface{}, key string) int64 {
	if m == nil {
		return 0
	}
	v, ok := m[key]
	if !ok {
		return 0
	}
	switch t := v.(type) {
	case float64:
		return int64(t)
	case int64:
		return t
	case int:
		return int64(t)
	case string:
		var n int64
		_, _ = fmt.Sscanf(t, "%d", &n)
		return n
	default:
		return 0
	}
}

func adjustLeaderboard(ctx context.Context, nk runtime.NakamaModule, lbID, userID, username string, deltaScore int64, win, loss, draw bool) error {
	if userID == botUserID {
		return nil
	}
	setOp := int(api.Operator_SET)
	recs, _, _, _, err := nk.LeaderboardRecordsList(ctx, lbID, []string{userID}, 1, "", 0)
	if err != nil {
		return err
	}
	var oldScore int64
	wins, losses, draws, streak := int64(0), int64(0), int64(0), int64(0)
	if len(recs) > 0 {
		oldScore = recs[0].Score
		if prev := recordMetadataMap(recs[0].GetMetadata()); prev != nil {
			wins = metaInt(prev, "wins")
			losses = metaInt(prev, "losses")
			draws = metaInt(prev, "draws")
			streak = metaInt(prev, "streak")
		}
	}
	if win {
		wins++
		streak++
	} else if loss {
		losses++
		streak = 0
	} else if draw {
		draws++
		streak = 0
	}
	newScore := oldScore + deltaScore
	meta := map[string]interface{}{
		"wins":   wins,
		"losses": losses,
		"draws":  draws,
		"streak": streak,
	}
	_, err = nk.LeaderboardRecordWrite(ctx, lbID, userID, username, newScore, streak, meta, &setOp)
	return err
}
