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
	return { ...room, timerRef: undefined };
}
