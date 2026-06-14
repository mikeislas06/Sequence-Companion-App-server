import { buildTurnOrder, resolveStartIndex, advanceTurn, getCurrentPlayer } from "./turn-controller";
import { createRoom, joinRoom, joinTeam } from "./room-manager";
import { GameConfig, Room } from "./types";

function makeRoom(teamCount: 2 | 3, perTeam: number): Room {
	const cfg: GameConfig = {
		teamCount,
		maxPlayersPerTeam: perTeam,
		timer: "off",
		enforceNoTableTalk: false,
		allowDeadCards: true,
		showDeckCount: true,
	};
	let room = createRoom("p1", "p1", "P1", cfg);
	room = joinTeam(room.code, "p1", "green"); // host picks green
	let n = 2;
	const colors = teamCount === 2 ? ["blue"] : ["blue", "red"];
	for (const color of colors) {
		for (let i = 0; i < perTeam; i++) {
			room = joinRoom(room.code, `p${n}`, `p${n}`, `P${n}`);
			room = joinTeam(room.code, `p${n}`, color as "blue" | "red");
			n++;
		}
	}
	// Fill green to match perTeam
	for (let i = 1; i < perTeam; i++) {
		room = joinRoom(room.code, `pg${i}`, `pg${i}`, `PG${i}`);
		room = joinTeam(room.code, `pg${i}`, "green");
	}
	return room;
}

describe("buildTurnOrder", () => {
	it("interleaves green/blue for 2 teams with 2 players each", () => {
		const room = makeRoom(2, 2);
		const order = buildTurnOrder(room);
		const teamOf = (id: string) =>
			Object.values(room.teams).find((t) => t.players.some((p) => p.id === id))?.color;
		expect(order.map(teamOf)).toEqual(["green", "blue", "green", "blue"]);
	});

	it("interleaves 3 teams with 1 player each", () => {
		const room = makeRoom(3, 1);
		const order = buildTurnOrder(room);
		const teamOf = (id: string) =>
			Object.values(room.teams).find((t) => t.players.some((p) => p.id === id))?.color;
		expect(order.map(teamOf)).toEqual(["green", "blue", "red"]);
	});
});

describe("resolveStartIndex", () => {
	it("defaults to 0 (first green player) when mode is absent", () => {
		const room = makeRoom(3, 2);
		const order = buildTurnOrder(room);
		expect(resolveStartIndex(room, order)).toBe(0);
	});

	it("returns the index of the manually selected starter without reshuffling order", () => {
		const room = makeRoom(3, 2);
		const order = buildTurnOrder(room);
		const target = order[3]; // some non-first player
		room.config.startingPlayerMode = "manual";
		room.config.startingPlayerId = target;
		expect(resolveStartIndex(room, order)).toBe(3);
		expect(order).toEqual(buildTurnOrder(room)); // order itself unchanged
	});

	it("falls back to 0 when manual starter is missing from the order", () => {
		const room = makeRoom(2, 2);
		const order = buildTurnOrder(room);
		room.config.startingPlayerMode = "manual";
		room.config.startingPlayerId = "nobody";
		expect(resolveStartIndex(room, order)).toBe(0);
	});

	it("random mode returns a valid in-range index", () => {
		const room = makeRoom(3, 2);
		const order = buildTurnOrder(room);
		room.config.startingPlayerMode = "random";
		for (let i = 0; i < 50; i++) {
			const idx = resolveStartIndex(room, order);
			expect(idx).toBeGreaterThanOrEqual(0);
			expect(idx).toBeLessThan(order.length);
		}
	});
});

describe("advanceTurn", () => {
	it("wraps from last index back to 0", () => {
		let room = makeRoom(2, 1);
		room.turnOrder = buildTurnOrder(room);
		room.currentTurnIndex = room.turnOrder.length - 1;
		expect(advanceTurn(room).currentTurnIndex).toBe(0);
	});
});
