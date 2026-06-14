import { randomUUID } from "crypto";
import { Server, Socket } from "socket.io";
import { z } from "zod";
import {
	createRoom,
	getRoom,
	joinRoom,
	joinTeam,
	leaveRoom,
	markDisconnected,
	rejoinRoom,
	resetRoom,
	canStartGame,
	toPublicRoom,
	setRoom,
	findPlayerBySocketId,
	winningSequencesFor,
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
	winningSequences: z.union([z.literal(1), z.literal(2)]).optional(),
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
const LeaveRoomSchema = z.object({ roomCode: RoomCodeSchema });
const RejoinSchema = z.object({
	roomCode: RoomCodeSchema,
	playerId: z.string().uuid(),
	playerName: PlayerNameSchema.optional(),
});

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
// Stable player ID lookup — decouples socket.id from player identity
// ---------------------------------------------------------------------------

// Maps each socket connection to the stable player UUID assigned at join time.
// Updated on every reconnect via player:rejoin.
const socketToStableId = new Map<string, { roomCode: string; stableId: string }>();

function getStableId(socketId: string): string | undefined {
	return socketToStableId.get(socketId)?.stableId;
}

// Resolves the acting player's stable id for a gameplay event. Prefers the
// socket→id map, but falls back to locating the player by their live socketId
// inside the room (and re-registers the map). This keeps a reconnected socket
// able to act even if its map entry was ever lost — the failure mode behind a
// player getting wrongly told "Not your turn" after reconnecting mid-game.
function resolveStableId(socket: Socket, roomCode: string): string | undefined {
	const mapped = getStableId(socket.id);
	if (mapped) return mapped;

	const room = getRoom(roomCode);
	if (!room) return undefined;
	const player = findPlayerBySocketId(room, socket.id);
	if (!player) return undefined;

	socketToStableId.set(socket.id, { roomCode, stableId: player.id });
	return player.id;
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
	const seconds = room.config.timer === "off" ? 0 : (room.config.timer as number);
	room.turnEndsAt = seconds > 0 ? Date.now() + seconds * 1000 : undefined;
	setRoom(room);

	io.to(roomCode).emit("turn:started", {
		currentPlayerId: player.id,
		currentPlayerName: player.name,
		teamColor: player.teamColor,
		timerSetting: room.config.timer,
		remaining: seconds,
		deckCount: room.config.showDeckCount ? room.deck.length : undefined,
	});
}

// Computes how many whole seconds remain on the active turn timer, for
// resyncing a client that just reconnected. Returns the full timer length when
// the room has no live deadline (e.g. timer disabled).
function remainingSeconds(room: ReturnType<typeof getRoom>): number {
	if (!room) return 0;
	if (room.config.timer === "off") return 0;
	if (!room.turnEndsAt) return room.config.timer as number;
	return Math.max(0, Math.ceil((room.turnEndsAt - Date.now()) / 1000));
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
				const stableId = randomUUID();
				const room = createRoom(socket.id, stableId, payload.hostName, payload.config);
				socketToStableId.set(socket.id, { roomCode: room.code, stableId });
				socket.join(room.code);
				socket.emit("room:created", { roomCode: room.code, playerId: stableId });
				broadcast(io, room.code, room);
			} catch (e) {
				emitError(socket, e);
			}
		});

		socket.on("room:join", (raw: unknown) => {
			try {
				const payload = JoinRoomSchema.parse(raw);
				const stableId = randomUUID();
				const room = joinRoom(payload.roomCode, socket.id, stableId, payload.playerName);
				socketToStableId.set(socket.id, { roomCode: payload.roomCode, stableId });
				socket.join(payload.roomCode);
				socket.emit("room:joined", { roomCode: payload.roomCode, playerId: stableId });
				broadcast(io, payload.roomCode, room);
			} catch (e) {
				emitError(socket, e);
			}
		});

		socket.on("player:rejoin", (raw: unknown) => {
			try {
				const { roomCode, playerId, playerName } = RejoinSchema.parse(raw);

				// Try to find the existing player slot (covers in_game and lobby)
				const result = rejoinRoom(roomCode, playerId, socket.id);
				if (result) {
					socketToStableId.set(socket.id, { roomCode, stableId: playerId });
					socket.join(roomCode);

					const { room: rejoinedRoom, player } = result;
					const current =
						rejoinedRoom.status === "in_game" ? getCurrentPlayer(rejoinedRoom) : undefined;

					// Single authoritative snapshot so the client can land on the right
					// screen (lobby / game / game-over) with the full current state —
					// crucial when the app was fully closed and reopened to "/".
					socket.emit("session:resync", {
						roomCode,
						playerId,
						room: toPublicRoom(rejoinedRoom),
						hand: player.hand,
						currentPlayerId: current?.id,
						timerSetting: rejoinedRoom.config.timer,
						remaining: remainingSeconds(rejoinedRoom),
					});

					// Also fire the granular events the in-place pages already listen
					// for, so a same-page reconnect resumes without waiting.
					if (player.hand.length > 0) {
						socket.emit("hand:dealt", { hand: player.hand });
					}
					if (current) {
						socket.emit("turn:started", {
							currentPlayerId: current.id,
							currentPlayerName: current.name,
							teamColor: current.teamColor,
							timerSetting: rejoinedRoom.config.timer,
							remaining: remainingSeconds(rejoinedRoom),
							deckCount: rejoinedRoom.config.showDeckCount
								? rejoinedRoom.deck.length
								: undefined,
						});
					}

					// Send the freshest room snapshot to everyone (roster, host, etc.)
					broadcast(io, roomCode, rejoinedRoom);
					return;
				}

				// Player not found — try re-adding them to an open lobby
				const room = getRoom(roomCode);
				if (room && room.status === "lobby" && playerName) {
					const rejoined = joinRoom(roomCode, socket.id, playerId, playerName);
					socketToStableId.set(socket.id, { roomCode, stableId: playerId });
					socket.join(roomCode);
					const player = rejoined.teams &&
						Object.values(rejoined.teams)
							.flatMap((t) => t.players)
							.find((p) => p.id === playerId);
					socket.emit("session:resync", {
						roomCode,
						playerId,
						room: toPublicRoom(rejoined),
						hand: player?.hand ?? [],
						currentPlayerId: undefined,
						timerSetting: rejoined.config.timer,
						remaining: 0,
					});
					broadcast(io, roomCode, rejoined);
					return;
				}

				// The saved session points at a room that no longer exists (server
				// restarted, room expired, or the game ended). This is an expected
				// outcome of an auto-rejoin on app open — not a user-facing error.
				// Tell the client to quietly drop its stale session instead.
				socket.emit("session:invalid", { roomCode });
			} catch (e) {
				emitError(socket, e);
			}
		});

		socket.on("team:join", (raw: unknown) => {
			try {
				const payload = JoinTeamSchema.parse(raw);
				const stableId = resolveStableId(socket, payload.roomCode);
				if (!stableId) throw new Error("Player not in room");
				const room = joinTeam(payload.roomCode, stableId, payload.teamColor);
				broadcast(io, payload.roomCode, room);
			} catch (e) {
				emitError(socket, e);
			}
		});

		socket.on("game:start", (raw: unknown) => {
			try {
				const { roomCode } = GameStartSchema.parse(raw);
				const stableId = resolveStableId(socket, roomCode);
				let room = getRoom(roomCode);
				if (!room) throw new Error("Room not found");
				if (stableId !== room.hostId) throw new Error("Only the host can start the game");

				const { valid, reason } = canStartGame(room);
				if (!valid) throw new Error(reason);

				room = buildAndDealHands(room);
				room.turnOrder = buildTurnOrder(room);
				room.currentTurnIndex = 0;
				room.status = "in_game";
				setRoom(room);

				// Send each player their private hand via their current socket connection
				for (const team of Object.values(room.teams)) {
					for (const player of team.players) {
						if (player.socketId) {
							io.to(player.socketId).emit("hand:dealt", { hand: player.hand });
						}
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
				const stableId = resolveStableId(socket, payload.roomCode);
				let room = getRoom(payload.roomCode);
				if (!room) throw new Error("Room not found");

				const current = getCurrentPlayer(room);
				if (current?.id !== stableId) throw new Error("Not your turn");

				const { room: afterPlay, card } = playCard(room, stableId!, payload.cardId);
				if (!card) throw new Error("Card not found in hand");

				const { room: afterDraw, drawnCard, reshuffled } = drawCard(afterPlay, stableId!);
				if (!drawnCard) throw new Error("No cards remaining");

				room = advanceTurn(clearTimer(afterDraw));
				setRoom(room);
				broadcast(io, payload.roomCode, room);

				io.to(payload.roomCode).emit("card:played", {
					playerId: stableId,
					card,
					deckCount: room.config.showDeckCount ? room.deck.length : undefined,
				});

				if (reshuffled) io.to(payload.roomCode).emit("deck:reshuffled");

				// Send updated hand privately to the player who drew
				const updatedPlayer = Object.values(room.teams)
					.flatMap((t) => t.players)
					.find((p) => p.id === stableId);
				if (updatedPlayer) {
					io.to(socket.id).emit("hand:updated", { hand: updatedPlayer.hand });
				}

				beginTurn(io, payload.roomCode);
			} catch (e) {
				emitError(socket, e);
			}
		});

		socket.on("card:dead", (raw: unknown) => {
			try {
				const payload = DeadCardSchema.parse(raw);
				const stableId = resolveStableId(socket, payload.roomCode);
				let room = getRoom(payload.roomCode);
				if (!room) throw new Error("Room not found");
				if (!room.config.allowDeadCards) throw new Error("Dead card rule disabled");

				const current = getCurrentPlayer(room);
				if (current?.id !== stableId) throw new Error("Not your turn");

				const {
					room: afterReplace,
					replacement,
					reshuffled,
				} = replaceDeadCard(room, stableId!, payload.cardId);
				if (!replacement) throw new Error("Could not replace dead card");

				setRoom(afterReplace);
				broadcast(io, payload.roomCode, afterReplace);

				if (reshuffled) io.to(payload.roomCode).emit("deck:reshuffled");

				const updatedPlayer = Object.values(afterReplace.teams)
					.flatMap((t) => t.players)
					.find((p) => p.id === stableId);
				if (updatedPlayer) {
					io.to(socket.id).emit("hand:updated", { hand: updatedPlayer.hand });
				}

				io.to(payload.roomCode).emit("deck:count", { count: afterReplace.deck.length });
			} catch (e) {
				emitError(socket, e);
			}
		});

		socket.on("penalty:apply", (raw: unknown) => {
			try {
				const payload = PenaltySchema.parse(raw);
				const stableId = resolveStableId(socket, payload.roomCode);
				let room = getRoom(payload.roomCode);
				if (!room) throw new Error("Room not found");
				if (!room.config.enforceNoTableTalk) throw new Error("Table talk penalty disabled");
				if (stableId !== room.hostId) throw new Error("Only the host can apply penalties");

				room = applyPenalty(room, payload.targetTeam);
				setRoom(room);

				io.to(payload.roomCode).emit("penalty:applied", {
					teamColor: payload.targetTeam,
					reason: "No table talk violation",
				});

				// Send updated hands privately to penalised players via their current socket
				for (const player of room.teams[payload.targetTeam].players) {
					if (player.socketId) {
						io.to(player.socketId).emit("hand:updated", { hand: player.hand });
					}
				}
			} catch (e) {
				emitError(socket, e);
			}
		});

		socket.on("sequence:update", (raw: unknown) => {
			try {
				const { roomCode, teamColor, delta } = SequenceUpdateSchema.parse(raw);
				const stableId = resolveStableId(socket, roomCode);
				const room = getRoom(roomCode);
				if (!room) throw new Error("Room not found");
				if (stableId !== room.hostId) throw new Error("Only the host can update sequences");
				if (room.status !== "in_game") throw new Error("Game not in progress");

				room.sequences[teamColor] = Math.max(0, (room.sequences[teamColor] ?? 0) + delta);

				const winCount = winningSequencesFor(room.config);
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
				const stableId = resolveStableId(socket, roomCode);
				const room = getRoom(roomCode);
				if (!room) throw new Error("Room not found");
				if (stableId !== room.hostId) throw new Error("Only the host can reset the game");

				const reset = resetRoom(roomCode);
				broadcast(io, roomCode, reset);
				io.to(roomCode).emit("game:reset");
			} catch (e) {
				emitError(socket, e);
			}
		});

		// Intentional leave (the player tapped "Leave Room"). Removes the slot
		// for good, unlike a transient disconnect which preserves it for rejoin.
		socket.on("room:leave", (raw: unknown) => {
			try {
				const { roomCode } = LeaveRoomSchema.parse(raw);
				const stableId = resolveStableId(socket, roomCode);
				if (!stableId) return;
				const updated = leaveRoom(roomCode, stableId);
				socketToStableId.delete(socket.id);
				socket.leave(roomCode);
				if (updated) broadcast(io, roomCode, updated);
			} catch (e) {
				emitError(socket, e);
			}
		});

		socket.on("disconnecting", () => {
			// A dropped socket is treated as transient: keep the player's slot so
			// they can rejoin with full state. Permanent removal happens only via
			// the explicit room:leave event above.
			for (const roomCode of socket.rooms) {
				if (roomCode === socket.id) continue;
				const updated = markDisconnected(roomCode, socket.id);
				if (updated) broadcast(io, roomCode, updated);
			}
		});

		socket.on("disconnect", () => {
			rateLimits.delete(socket.id);
			socketToStableId.delete(socket.id);
		});
	});
}
