import { Server } from "socket.io";
import { Room, TeamColor, TimerSetting } from "./types";
import { findPlayerInRoom } from "./room-manager";

export function buildTurnOrder(room: Room): string[] {
	const colors: TeamColor[] =
		room.config.teamCount === 2 ? ["green", "blue"] : ["green", "blue", "red"];

	const byTeam = colors.map((c) => room.teams[c].players.map((p) => p.id));
	const max = Math.max(...byTeam.map((t) => t.length));
	const order: string[] = [];

	for (let i = 0; i < max; i++) {
		for (const teamPlayers of byTeam) {
			if (i < teamPlayers.length) order.push(teamPlayers[i]);
		}
	}
	return order;
}

// Picks the starting offset into the (already team-alternating) turn order based
// on the room's startingPlayerMode. The order array is never reshuffled — only
// where play begins changes, which keeps team alternation intact for every mode.
export function resolveStartIndex(room: Room, order: string[]): number {
	if (order.length === 0) return 0;
	const mode = room.config.startingPlayerMode ?? "default";
	if (mode === "random") return Math.floor(Math.random() * order.length);
	if (mode === "manual") {
		const idx = order.indexOf(room.config.startingPlayerId ?? "");
		return idx === -1 ? 0 : idx; // -1 is guarded at game:start; fall back safely
	}
	return 0;
}

export function getCurrentPlayer(room: Room) {
	const id = room.turnOrder[room.currentTurnIndex];
	return id ? findPlayerInRoom(room, id) : undefined;
}

export function advanceTurn(room: Room): Room {
	return { ...room, currentTurnIndex: (room.currentTurnIndex + 1) % room.turnOrder.length };
}

export function startTimer(
	room: Room,
	io: Server,
	timerSetting: TimerSetting,
	onExpire: () => void,
): ReturnType<typeof setInterval> | undefined {
	if (timerSetting === "off") return undefined;

	let remaining = timerSetting as number;
	const interval = setInterval(() => {
		remaining -= 1;
		io.to(room.code).emit("timer:tick", { remaining });
		if (remaining <= 0) {
			clearInterval(interval);
			onExpire();
		}
	}, 1000);

	return interval;
}

export function clearTimer(room: Room): Room {
	if (room.timerRef) clearInterval(room.timerRef);
	return { ...room, timerRef: undefined, turnEndsAt: undefined };
}
