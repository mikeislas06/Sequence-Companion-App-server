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
	id: string; // socket.id
	name: string;
	teamColor: TeamColor;
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
}

export interface Room {
	code: string;
	hostId: string;
	status: RoomStatus;
	config: GameConfig;
	teams: Record<TeamColor, Team>;
	turnOrder: string[];
	currentTurnIndex: number;
	deck: Card[];
	discardPile: Card[];
	lastPlayedCard?: Card;
	winnerTeam?: TeamColor;
	sequences: Record<TeamColor, number>;
	timerRef?: ReturnType<typeof setInterval>;
}

// Safe public shape — never includes hand contents
export interface PublicRoom {
	code: string;
	hostId: string;
	status: RoomStatus;
	config: GameConfig;
	teams: Record<TeamColor, PublicTeam>;
	currentPlayerId?: string;
	deckCount?: number;
	lastPlayedCard?: Card;
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
	teamColor: TeamColor;
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
