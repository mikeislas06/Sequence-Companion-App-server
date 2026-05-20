import { randomInt } from "crypto";
import { GameConfig, Player, PublicPlayer, PublicRoom, PublicTeam, Room, TeamColor } from "./types";

const rooms = new Map<string, Room>();
const CODE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const VALID_3_TEAMS_COUNTS = new Set([3, 6, 9, 12]);
const MAX_ROOMS = 500;
const ROOM_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

function generateCode(): string {
	let code = "";
	for (let i = 0; i < 4; i++) {
		code += CODE_CHARS[randomInt(CODE_CHARS.length)];
	}
	return code;
}

function getActiveColors(teamCount: 2 | 3): TeamColor[] {
	return teamCount === 2 ? ["green", "blue"] : ["green", "blue", "red"];
}

function makePlayer(id: string, name: string, teamColor: TeamColor): Player {
	return {
		id,
		name,
		teamColor,
		hand: [],
		handLimit: 0,
	};
}

export function createRoom(hostId: string, hostName: string, config: GameConfig): Room {
	if (rooms.size >= MAX_ROOMS) throw new Error("Server is at capacity. Try again later.");

	let code: string;
	do {
		code = generateCode();
	} while (rooms.has(code));

	const room: Room = {
		code,
		hostId,
		status: "lobby",
		config,
		teams: {
			green: {
				color: "green",
				players: [makePlayer(hostId, hostName, "green")],
				maxPlayers: config.maxPlayersPerTeam,
			},
			blue: {
				color: "blue",
				players: [],
				maxPlayers: config.maxPlayersPerTeam,
			},
			red: {
				color: "red",
				players: [],
				maxPlayers: config.teamCount === 3 ? config.maxPlayersPerTeam : 0,
			},
		},
		turnOrder: [],
		currentTurnIndex: 0,
		deck: [],
		discardPile: [],
		sequences: { green: 0, blue: 0, red: 0 },
		lastActivity: Date.now(),
	};

	rooms.set(code, room);
	return room;
}

export function getRoom(code: string): Room | undefined {
	return rooms.get(code);
}

export function setRoom(room: Room): void {
	rooms.set(room.code, { ...room, lastActivity: Date.now() });
}

export function joinRoom(code: string, playerId: string, playerName: string): Room {
	const room = rooms.get(code);
	if (!room) throw new Error("Room not found");
	if (room.status !== "lobby") throw new Error("Game already started");
	if (findPlayerInRoom(room, playerId)) return room; // already in room (reconnect)

	const colors: TeamColor[] = room.config.teamCount === 2 ? ["green", "blue"] : ["green", "blue", "red"];
	const targetColor = colors.find((c) => {
		const team = room.teams[c];
		return team.maxPlayers === 0 || team.players.length < team.maxPlayers;
	});
	if (!targetColor) throw new Error("Room is full");

	room.teams[targetColor].players.push(makePlayer(playerId, playerName, targetColor));
	setRoom(room);
	return room;
}

export function joinTeam(code: string, playerId: string, teamColor: TeamColor): Room {
	const room = rooms.get(code);
	if (!room) throw new Error("Room not found");

	const player = findPlayerInRoom(room, playerId);
	if (!player) throw new Error("Player not in room");

	if (player.teamColor === teamColor) return room; // already on this team

	const target = room.teams[teamColor];
	if (target.maxPlayers > 0 && target.players.length >= target.maxPlayers) {
		throw new Error("Team is full");
	}

	// Remove from current team
	for (const color of Object.keys(room.teams) as TeamColor[]) {
		room.teams[color].players = room.teams[color].players.filter((p) => p.id !== playerId);
	}

	player.teamColor = teamColor;
	target.players.push(player);
	setRoom(room);
	return room;
}

export function leaveRoom(code: string, playerId: string): Room | null {
	const room = rooms.get(code);
	if (!room) return null;

	for (const color of Object.keys(room.teams) as TeamColor[]) {
		room.teams[color].players = room.teams[color].players.filter((p) => p.id !== playerId);
	}

	const remaining = Object.values(room.teams).flatMap((t) => t.players);
	if (remaining.length === 0) {
		rooms.delete(code);
		return null;
	}

	if (room.hostId === playerId && remaining[0]) {
		room.hostId = remaining[0].id;
	}

	setRoom(room);
	return room;
}

export function canStartGame(room: Room): { valid: boolean; reason?: string } {
	const colors = getActiveColors(room.config.teamCount);
	const sizes = colors.map((c) => room.teams[c].players.length);
	const total = sizes.reduce((a, b) => a + b, 0);

	if (sizes.some((s) => s === 0))
		return { valid: false, reason: "Each team must have at least 1 player" };
	if (!sizes.every((s) => s === sizes[0]))
		return { valid: false, reason: "Teams must have the same number of players" };
	if (room.config.teamCount === 3 && !VALID_3_TEAMS_COUNTS.has(total))
		return { valid: false, reason: "Total player count must be 3, 6, 9 or 12 for 3 teams" };
	if (room.config.teamCount === 2 && (total < 2 || total > 12 || total % 2 !== 0))
		return {
			valid: false,
			reason: "Total player count must be an even number between 2 and 12 for 2 teams",
		};

	return { valid: true };
}

export function toPublicRoom(room: Room): PublicRoom {
	const allColors: TeamColor[] = ["green", "blue", "red"];
	const teams = Object.fromEntries(
		allColors.map((color) => {
			const team = room.teams[color];
			const publicTeam: PublicTeam = {
				color,
				maxPlayers: team.maxPlayers,
				players: team.players.map(
					(p): PublicPlayer => ({
						id: p.id,
						name: p.name,
						teamColor: p.teamColor,
						cardCount: p.hand.length,
					}),
				),
			};
			return [color, publicTeam];
		}),
	) as Record<TeamColor, PublicTeam>;

	return {
		code: room.code,
		hostId: room.hostId,
		status: room.status,
		config: room.config,
		teams,
		currentPlayerId: room.turnOrder[room.currentTurnIndex],
		deckCount: room.config.showDeckCount ? room.deck.length : undefined,
		lastPlayedCard: room.lastPlayedCard,
		sequences: room.sequences,
		winnerTeam: room.winnerTeam,
	};
}

export function resetRoom(code: string): Room {
	const room = rooms.get(code);
	if (!room) throw new Error("Room not found");

	if (room.timerRef) clearInterval(room.timerRef);

	for (const team of Object.values(room.teams)) {
		for (const player of team.players) {
			player.hand = [];
			player.handLimit = 0;
		}
	}

	room.status = "lobby";
	room.deck = [];
	room.discardPile = [];
	room.turnOrder = [];
	room.currentTurnIndex = 0;
	room.sequences = { green: 0, blue: 0, red: 0 };
	room.winnerTeam = undefined;
	room.lastPlayedCard = undefined;
	room.timerRef = undefined;

	setRoom(room);
	return room;
}

export function findPlayerInRoom(room: Room, playerId: string): Player | undefined {
	for (const team of Object.values(room.teams)) {
		const player = team.players.find((p) => p.id === playerId);
		if (player) return player;
	}
	return undefined;
}

// Evict rooms idle longer than ROOM_TTL_MS
setInterval(() => {
	const now = Date.now();
	for (const [code, room] of rooms) {
		if (now - room.lastActivity > ROOM_TTL_MS) {
			if (room.timerRef) clearInterval(room.timerRef);
			rooms.delete(code);
		}
	}
}, CLEANUP_INTERVAL_MS).unref();
