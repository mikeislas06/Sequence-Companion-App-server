import { Server, Socket } from "socket.io";
import {
	createRoom,
	getRoom,
	joinRoom,
	joinTeam,
	leaveRoom,
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
import {
	CreateRoomPayload,
	JoinRoomPayload,
	JoinTeamPayload,
	PlayCardPayload,
	DeadCardPayload,
	PenaltyPayload,
	TeamColor,
} from "./types";

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

export function registerHandlers(io: Server): void {
	io.on("connection", (socket: Socket) => {
		socket.on("room:create", (payload: CreateRoomPayload) => {
			try {
				const room = createRoom(socket.id, payload.hostName, payload.config);
				socket.join(room.code);
				socket.emit("room:created", { roomCode: room.code, playerId: socket.id });
				broadcast(io, room.code, room);
			} catch (e) {
				socket.emit("error", { message: (e as Error).message });
			}
		});

		socket.on("room:join", (payload: JoinRoomPayload) => {
			try {
				const room = joinRoom(payload.roomCode, socket.id, payload.playerName);
				socket.join(payload.roomCode);
				socket.emit("room:joined", { roomCode: payload.roomCode, playerId: socket.id });
				broadcast(io, payload.roomCode, room);
			} catch (e) {
				socket.emit("error", { message: (e as Error).message });
			}
		});

		socket.on("team:join", (payload: JoinTeamPayload) => {
			try {
				const room = joinTeam(payload.roomCode, socket.id, payload.teamColor);
				broadcast(io, payload.roomCode, room);
			} catch (e) {
				socket.emit("error", { message: (e as Error).message });
			}
		});

		socket.on("game:start", ({ roomCode }: { roomCode: string }) => {
			try {
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
				socket.emit("error", { message: (e as Error).message });
			}
		});

		socket.on("card:play", (payload: PlayCardPayload) => {
			try {
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
				socket.emit("error", { message: (e as Error).message });
			}
		});

		socket.on("card:dead", (payload: DeadCardPayload) => {
			try {
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

				if (reshuffled) io.to(payload.roomCode).emit("deck:reshuffled");

				const updatedPlayer = Object.values(afterReplace.teams)
					.flatMap((t) => t.players)
					.find((p) => p.id === socket.id);
				if (updatedPlayer)
					io.to(socket.id).emit("hand:updated", { hand: updatedPlayer.hand });

				io.to(payload.roomCode).emit("deck:count", { count: afterReplace.deck.length });
			} catch (e) {
				socket.emit("error", { message: (e as Error).message });
			}
		});

		socket.on("penalty:apply", (payload: PenaltyPayload) => {
			try {
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
				socket.emit("error", { message: (e as Error).message });
			}
		});

		socket.on("disconnect", () => {
			// Socket.io room cleanup happens automatically on disconnect
		});
	});
}
