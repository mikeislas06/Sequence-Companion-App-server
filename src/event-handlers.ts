import { Server, Socket } from "socket.io";
import { z } from "zod";
import {
	createRoom,
	getRoom,
	joinRoom,
	joinTeam,
	leaveRoom,
	resetRoom,
	canStartGame,
	toPublicRoom,
	setRoom,
} from "./room-manager";
import {
	buildAndDealHands,
	drawCard,
	playCard,
	replaceDeadCard,
	applyPenalty,
} from "./game-engine";
import {
	buildTurnOrder,
	advanceTurn,
	startTimer,
	clearTimer,
	getCurrentPlayer,
} from "./turn-controller";
import { TeamColor } from "./types";

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const TeamColorSchema = z.enum(["green", "blue", "red"]);
const RoomCodeSchema = z.string().length(4).regex(/^[A-Z0-9]{4}$/);
const PlayerNameSchema = z.string().min(1).max(20).trim();
const CardIdSchema = z.string().regex(/^(2|3|4|5|6|7|8|9|10|[AJQK])[SHDC]-[12]$/);

const GameConfigSchema = z.object({
	teamCount: z.union([z.literal(2), z.literal(3)]),
	maxPlayersPerTeam: z.number().int().min(1).max(6),
	timer: z.union([z.literal("off"), z.literal(30), z.literal(60), z.literal(90)]),
	enforceNoTableTalk: z.boolean(),
	allowDeadCards: z.boolean(),
	showDeckCount: z.boolean(),
});

const CreateRoomSchema = z.object({ hostName: PlayerNameSchema, config: GameConfigSchema });
const JoinRoomSchema = z.object({ roomCode: RoomCodeSchema, playerName: PlayerNameSchema });
const JoinTeamSchema = z.object({ roomCode: RoomCodeSchema, teamColor: TeamColorSchema });
const GameStartSchema = z.object({ roomCode: RoomCodeSchema });
const PlayCardSchema = z.object({ roomCode: RoomCodeSchema, cardId: CardIdSchema });
const DeadCardSchema = z.object({ roomCode: RoomCodeSchema, cardId: CardIdSchema });
const PenaltySchema = z.object({ roomCode: RoomCodeSchema, targetTeam: TeamColorSchema });
const SequenceUpdateSchema = z.object({
	roomCode: RoomCodeSchema,
	teamColor: TeamColorSchema,
	delta: z.union([z.literal(1), z.literal(-1)]),
});
const GameResetSchema = z.object({ roomCode: RoomCodeSchema });

// ---------------------------------------------------------------------------
// Rate limiting — 20 events per socket per second
// ---------------------------------------------------------------------------

const RATE_LIMIT_WINDOW_MS = 1000;
const RATE_LIMIT_MAX = 20;
const rateLimits = new Map<string, { count: number; resetAt: number }>();

function isRateLimited(socketId: string): boolean {
	const now = Date.now();
	const entry = rateLimits.get(socketId);
	if (!entry || now >= entry.resetAt) {
		rateLimits.set(socketId, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
		return false;
	}
	if (entry.count >= RATE_LIMIT_MAX) return true;
	entry.count++;
	return false;
}

// ---------------------------------------------------------------------------
// Safe error handling — only known business errors reach the client
// ---------------------------------------------------------------------------

const SAFE_ERRORS = new Set([
	"Room not found",
	"Room is full",
	"Team is full",
	"Player not in room",
	"Game already started",
	"Only the host can start the game",
	"Only the host can reset the game",
	"Only the host can apply penalties",
	"Only the host can update sequences",
	"Not your turn",
	"Dead card rule disabled",
	"Table talk penalty disabled",
	"Game not in progress",
	"Card not found in hand",
	"No cards remaining",
	"Could not replace dead card",
	"Each team must have at least 1 player",
	"Teams must have the same number of players",
	"Total player count must be 3, 6, 9 or 12 for 3 teams",
	"Total player count must be an even number between 2 and 12 for 2 teams",
	"Server is at capacity. Try again later.",
]);

function emitError(socket: Socket, e: unknown): void {
	if (e instanceof z.ZodError) {
		socket.emit("error", { message: "Invalid request data." });
	} else if (e instanceof Error && SAFE_ERRORS.has(e.message)) {
		socket.emit("error", { message: e.message });
	} else {
		console.error("[socket error]", e);
		socket.emit("error", { message: "An unexpected error occurred." });
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function broadcast(io: Server, code: string, room: ReturnType<typeof getRoom>) {
	if (room) io.to(code).emit("room:updated", toPublicRoom(room));
}

function beginTurn(io: Server, roomCode: string) {
	const room = getRoom(roomCode);
	if (!room) return;

	const player = getCurrentPlayer(room);
	if (!player) return;

	const timerRef = startTimer(room, io, room.config.timer, () => {
		const current = getRoom(roomCode);
		if (!current) return;
		const advanced = advanceTurn(clearTimer(current));
		setRoom(advanced);
		beginTurn(io, roomCode);
	});

	room.timerRef = timerRef;
	setRoom(room);

	io.to(roomCode).emit("turn:started", {
		currentPlayerId: player.id,
		currentPlayerName: player.name,
		teamColor: player.teamColor,
		timerSetting: room.config.timer,
		deckCount: room.config.showDeckCount ? room.deck.length : undefined,
	});
}

// ---------------------------------------------------------------------------
// Event registration
// ---------------------------------------------------------------------------

export function registerHandlers(io: Server): void {
	io.on("connection", (socket: Socket) => {
		// Per-socket rate limiting applied to every event
		socket.use(([_event, ..._args], next) => {
			if (isRateLimited(socket.id)) {
				socket.emit("error", { message: "Too many requests. Please slow down." });
				return;
			}
			next();
		});

		socket.on("room:create", (raw: unknown) => {
			try {
				const payload = CreateRoomSchema.parse(raw);
				const room = createRoom(socket.id, payload.hostName, payload.config);
				socket.join(room.code);
				socket.emit("room:created", { roomCode: room.code, playerId: socket.id });
				broadcast(io, room.code, room);
			} catch (e) {
				emitError(socket, e);
			}
		});

		socket.on("room:join", (raw: unknown) => {
			try {
				const payload = JoinRoomSchema.parse(raw);
				const room = joinRoom(payload.roomCode, socket.id, payload.playerName);
				socket.join(payload.roomCode);
				socket.emit("room:joined", { roomCode: payload.roomCode, playerId: socket.id });
				broadcast(io, payload.roomCode, room);
			} catch (e) {
				emitError(socket, e);
			}
		});

		socket.on("team:join", (raw: unknown) => {
			try {
				const payload = JoinTeamSchema.parse(raw);
				const room = joinTeam(payload.roomCode, socket.id, payload.teamColor);
				broadcast(io, payload.roomCode, room);
			} catch (e) {
				emitError(socket, e);
			}
		});

		socket.on("game:start", (raw: unknown) => {
			try {
				const { roomCode } = GameStartSchema.parse(raw);
				let room = getRoom(roomCode);
				if (!room) throw new Error("Room not found");
				if (socket.id !== room.hostId) throw new Error("Only the host can start the game");

				const { valid, reason } = canStartGame(room);
				if (!valid) throw new Error(reason);

				room = buildAndDealHands(room);
				room.turnOrder = buildTurnOrder(room);
				room.currentTurnIndex = 0;
				room.status = "in_game";
				setRoom(room);

				// Send each player their private hand only
				for (const team of Object.values(room.teams)) {
					for (const player of team.players) {
						io.to(player.id).emit("hand:dealt", { hand: player.hand });
					}
				}

				io.to(roomCode).emit("game:started", toPublicRoom(room));
				beginTurn(io, roomCode);
			} catch (e) {
				emitError(socket, e);
			}
		});

		socket.on("card:play", (raw: unknown) => {
			try {
				const payload = PlayCardSchema.parse(raw);
				let room = getRoom(payload.roomCode);
				if (!room) throw new Error("Room not found");

				const current = getCurrentPlayer(room);
				if (current?.id !== socket.id) throw new Error("Not your turn");

				const { room: afterPlay, card } = playCard(room, socket.id, payload.cardId);
				if (!card) throw new Error("Card not found in hand");

				const { room: afterDraw, drawnCard, reshuffled } = drawCard(afterPlay, socket.id);
				if (!drawnCard) throw new Error("No cards remaining");

				room = advanceTurn(clearTimer(afterDraw));
				setRoom(room);
				broadcast(io, payload.roomCode, room);

				io.to(payload.roomCode).emit("card:played", {
					playerId: socket.id,
					card,
					deckCount: room.config.showDeckCount ? room.deck.length : undefined,
				});

				if (reshuffled) io.to(payload.roomCode).emit("deck:reshuffled");

				// Send updated hand privately to the player who drew
				const updatedPlayer = Object.values(room.teams)
					.flatMap((t) => t.players)
					.find((p) => p.id === socket.id);
				if (updatedPlayer)
					io.to(socket.id).emit("hand:updated", { hand: updatedPlayer.hand });

				beginTurn(io, payload.roomCode);
			} catch (e) {
				emitError(socket, e);
			}
		});

		socket.on("card:dead", (raw: unknown) => {
			try {
				const payload = DeadCardSchema.parse(raw);
				let room = getRoom(payload.roomCode);
				if (!room) throw new Error("Room not found");
				if (!room.config.allowDeadCards) throw new Error("Dead card rule disabled");

				const current = getCurrentPlayer(room);
				if (current?.id !== socket.id) throw new Error("Not your turn");

				const {
					room: afterReplace,
					replacement,
					reshuffled,
				} = replaceDeadCard(room, socket.id, payload.cardId);
				if (!replacement) throw new Error("Could not replace dead card");

				setRoom(afterReplace);
				broadcast(io, payload.roomCode, afterReplace);

				if (reshuffled) io.to(payload.roomCode).emit("deck:reshuffled");

				const updatedPlayer = Object.values(afterReplace.teams)
					.flatMap((t) => t.players)
					.find((p) => p.id === socket.id);
				if (updatedPlayer)
					io.to(socket.id).emit("hand:updated", { hand: updatedPlayer.hand });

				io.to(payload.roomCode).emit("deck:count", { count: afterReplace.deck.length });
			} catch (e) {
				emitError(socket, e);
			}
		});

		socket.on("penalty:apply", (raw: unknown) => {
			try {
				const payload = PenaltySchema.parse(raw);
				let room = getRoom(payload.roomCode);
				if (!room) throw new Error("Room not found");
				if (!room.config.enforceNoTableTalk) throw new Error("Table talk penalty disabled");
				if (socket.id !== room.hostId) throw new Error("Only the host can apply penalties");

				room = applyPenalty(room, payload.targetTeam);
				setRoom(room);

				io.to(payload.roomCode).emit("penalty:applied", {
					teamColor: payload.targetTeam,
					reason: "No table talk violation",
				});

				for (const player of room.teams[payload.targetTeam].players) {
					io.to(player.id).emit("hand:updated", { hand: player.hand });
				}
			} catch (e) {
				emitError(socket, e);
			}
		});

		socket.on("sequence:update", (raw: unknown) => {
			try {
				const { roomCode, teamColor, delta } = SequenceUpdateSchema.parse(raw);
				const room = getRoom(roomCode);
				if (!room) throw new Error("Room not found");
				if (socket.id !== room.hostId) throw new Error("Only the host can update sequences");
				if (room.status !== "in_game") throw new Error("Game not in progress");

				room.sequences[teamColor] = Math.max(0, (room.sequences[teamColor] ?? 0) + delta);

				const winCount = room.config.teamCount === 2 ? 2 : 1;
				const activeColors: TeamColor[] =
					room.config.teamCount === 2 ? ["green", "blue"] : ["green", "blue", "red"];
				const winner = activeColors.find((c) => room.sequences[c] >= winCount);

				if (winner) {
					room.winnerTeam = winner;
					room.status = "game_over";
					if (room.timerRef) clearInterval(room.timerRef);
				}

				setRoom(room);
				broadcast(io, roomCode, room);

				if (winner) {
					io.to(roomCode).emit("game:over", { winnerTeam: winner });
				}
			} catch (e) {
				emitError(socket, e);
			}
		});

		socket.on("game:reset", (raw: unknown) => {
			try {
				const { roomCode } = GameResetSchema.parse(raw);
				const room = getRoom(roomCode);
				if (!room) throw new Error("Room not found");
				if (socket.id !== room.hostId) throw new Error("Only the host can reset the game");

				const reset = resetRoom(roomCode);
				broadcast(io, roomCode, reset);
				io.to(roomCode).emit("game:reset");
			} catch (e) {
				emitError(socket, e);
			}
		});

		socket.on("disconnecting", () => {
			for (const roomCode of socket.rooms) {
				if (roomCode === socket.id) continue;
				const updated = leaveRoom(roomCode, socket.id);
				if (updated) broadcast(io, roomCode, updated);
			}
		});

		socket.on("disconnect", () => {
			rateLimits.delete(socket.id);
		});
	});
}
