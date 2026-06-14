export type Suit = "S" | "H" | "D" | "C";
export type Rank = "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "10" | "J" | "Q" | "K" | "A";
export type JackType = "two-eyed" | "one-eyed";
export type TeamColor = "green" | "blue" | "red";
export type TimerSetting = "off" | 30 | 60 | 90;
export type RoomStatus = "lobby" | "in_game" | "game_over";

export interface Card {
	id: string; // e.g. "KS_1", "JH_2"
	rank: Rank;
	suit: Suit;
	jackType?: JackType;
}

export interface Player {
	id: string;       // stable UUID — persists across reconnects
	socketId: string; // current transport socket — changes on reconnect
	name: string;
	// null while the player is in the pending pool (joined the room but hasn't
	// picked a team yet). Always a concrete color once on a team / in a game.
	teamColor: TeamColor | null;
	hand: Card[];
	handLimit: number;
}

export interface Team {
	color: TeamColor;
	players: Player[];
	maxPlayers: number;
}

export interface GameConfig {
	teamCount: 2 | 3;
	maxPlayersPerTeam: number;
	timer: TimerSetting;
	enforceNoTableTalk: boolean;
	allowDeadCards: boolean;
	showDeckCount: boolean;
	// Sequences a team must complete to win. Standard play is 2 for 2 teams and
	// 1 for 3 teams; with 3 teams the host may opt into 2 to make games longer.
	// Optional for backward-compat — resolve with winningSequencesFor() when absent.
	winningSequences?: 1 | 2;
	// How the starting player is chosen. The turn order itself (team-alternating)
	// is never reshuffled — only the starting offset into it changes.
	//   "default" (or absent) → first green player starts (legacy behavior)
	//   "random"  → server picks a random starting offset
	//   "manual"  → host pre-selects the starter on the lobby (startingPlayerId)
	startingPlayerMode?: "default" | "random" | "manual";
	// Stable id of the host-selected starter; only used when startingPlayerMode === "manual".
	startingPlayerId?: string;
}

export interface Room {
	code: string;
	hostId: string;
	status: RoomStatus;
	config: GameConfig;
	teams: Record<TeamColor, Team>;
	// Players who have joined the room but not yet picked a team. They must all
	// pick a team before the game can start.
	unassigned: Player[];
	turnOrder: string[];
	currentTurnIndex: number;
	deck: Card[];
	discardPile: Card[];
	lastPlayedCard?: Card;
	lastPlayedBy?: string; // name of the player who played lastPlayedCard
	winnerTeam?: TeamColor;
	sequences: Record<TeamColor, number>;
	timerRef?: ReturnType<typeof setInterval>;
	turnEndsAt?: number; // epoch ms when the active turn timer expires (for reconnect resync)
	creatorId: string; // stable id of the original host — immutable, used to restore host on rejoin
	lastActivity: number;
}

// Safe public shape — never includes hand contents
export interface PublicRoom {
	code: string;
	hostId: string;
	status: RoomStatus;
	config: GameConfig;
	teams: Record<TeamColor, PublicTeam>;
	unassigned: PublicPlayer[];
	currentPlayerId?: string;
	deckCount?: number;
	lastPlayedCard?: Card;
	lastPlayedBy?: string;
	sequences: Record<TeamColor, number>;
	winnerTeam?: TeamColor;
}

export interface PublicTeam {
	color: TeamColor;
	players: PublicPlayer[];
	maxPlayers: number;
}

export interface PublicPlayer {
	id: string;
	name: string;
	teamColor: TeamColor | null;
	cardCount: number;
}

// Socket event payloads — Client → Server
export interface CreateRoomPayload {
	hostName: string;
	config: GameConfig;
}
export interface JoinRoomPayload {
	roomCode: string;
	playerName: string;
}
export interface JoinTeamPayload {
	roomCode: string;
	teamColor: TeamColor;
}
export interface PlayCardPayload {
	roomCode: string;
	cardId: string;
}
export interface DeadCardPayload {
	roomCode: string;
	cardId: string;
}
export interface PenaltyPayload {
	roomCode: string;
	targetTeam: TeamColor;
}
