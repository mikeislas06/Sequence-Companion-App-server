import { createRoom, joinRoom, joinTeam, canStartGame } from "./room-manager";
import { GameConfig } from "./types";

const cfg2: GameConfig = {
	teamCount: 2,
	maxPlayersPerTeam: 2,
	timer: "off",
	enforceNoTableTalk: false,
	allowDeadCards: true,
	showDeckCount: true,
};

describe("createRoom", () => {
	it("generates a 4-character uppercase room code", () => {
		const room = createRoom("h1", "h1", "Alice", cfg2);
		expect(room.code).toHaveLength(4);
		expect(room.code).toMatch(/^[A-Z0-9]+$/);
	});

	it("puts the host in the pending pool, not on a team", () => {
		const room = createRoom("h1", "h1", "Alice", cfg2);
		expect(room.unassigned.map((p) => p.name)).toEqual(["Alice"]);
		expect(room.teams.green.players).toHaveLength(0);
		expect(room.hostId).toBe("h1");
	});
});

describe("joinRoom", () => {
	it("places new joiners in the pending pool", () => {
		let room = createRoom("h1", "h1", "Alice", cfg2);
		room = joinRoom(room.code, "p2", "p2", "Bob");
		expect(room.unassigned.map((p) => p.name).sort()).toEqual(["Alice", "Bob"]);
		expect(room.teams.blue.players).toHaveLength(0);
	});

	it("throws once every team seat is taken", () => {
		// 2 teams x 1 seat = capacity 2: host + one joiner fills it.
		let room = createRoom("h1", "h1", "Alice", { ...cfg2, maxPlayersPerTeam: 1 });
		room = joinRoom(room.code, "p2", "p2", "Bob");
		expect(() => joinRoom(room.code, "p3", "p3", "Cara")).toThrow("full");
	});
});

describe("joinTeam", () => {
	it("moves a pending player onto the chosen team", () => {
		let room = createRoom("h1", "h1", "Alice", cfg2);
		room = joinRoom(room.code, "p2", "p2", "Bob");
		room = joinTeam(room.code, "p2", "blue");
		expect(room.teams.blue.players.find((p) => p.id === "p2")?.name).toBe("Bob");
		expect(room.unassigned.find((p) => p.id === "p2")).toBeUndefined();
	});

	it("throws when target team is full", () => {
		let room = createRoom("h1", "h1", "Alice", { ...cfg2, maxPlayersPerTeam: 1 });
		room = joinRoom(room.code, "p2", "p2", "Bob");
		room = joinTeam(room.code, "h1", "green"); // green now full (1 seat)
		expect(() => joinTeam(room.code, "p2", "green")).toThrow("full");
	});
});

describe("canStartGame", () => {
	it("valid when 2 teams have equal players and nobody is pending", () => {
		let room = createRoom("h1", "h1", "Alice", cfg2);
		room = joinRoom(room.code, "p2", "p2", "Bob");
		room = joinTeam(room.code, "h1", "green");
		room = joinTeam(room.code, "p2", "blue");
		expect(canStartGame(room).valid).toBe(true);
	});

	it("invalid while players are still pending", () => {
		const room = createRoom("h1", "h1", "Alice", cfg2);
		expect(canStartGame(room).valid).toBe(false);
		expect(canStartGame(room).reason).toMatch(/join a team/i);
	});

	it("invalid for 3-team with non-multiple-of-3 count", () => {
		let room = createRoom("h1", "h1", "Alice", { ...cfg2, teamCount: 3 });
		room = joinRoom(room.code, "p2", "p2", "Bob");
		room = joinTeam(room.code, "h1", "green");
		room = joinTeam(room.code, "p2", "blue");
		expect(canStartGame(room).valid).toBe(false);
	});
});
