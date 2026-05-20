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
		const room = createRoom("h1", "Alice", cfg2);
		expect(room.code).toHaveLength(4);
		expect(room.code).toMatch(/^[A-Z0-9]+$/);
	});

	it("puts the host in green team", () => {
		const room = createRoom("h1", "Alice", cfg2);
		expect(room.teams.green.players[0].name).toBe("Alice");
		expect(room.hostId).toBe("h1");
	});
});

describe("joinTeam", () => {
	it("moves player to the chosen team", () => {
		let room = createRoom("h1", "Alice", cfg2);
		room = joinRoom(room.code, "p2", "Bob");
		room = joinTeam(room.code, "p2", "blue");
		expect(room.teams.blue.players.find((p) => p.id === "p2")?.name).toBe("Bob");
		expect(room.teams.green.players.find((p) => p.id === "p2")).toBeUndefined();
	});

	it("throws when target team is full", () => {
		let room = createRoom("h1", "Alice", { ...cfg2, maxPlayersPerTeam: 1 });
		room = joinRoom(room.code, "p2", "Bob"); // auto-routes p2 to blue
		expect(() => joinTeam(room.code, "p2", "green")).toThrow("full"); // green is full (h1)
	});
});

describe("canStartGame", () => {
	it("valid when 2 teams have equal players", () => {
		let room = createRoom("h1", "Alice", cfg2);
		room = joinRoom(room.code, "p2", "Bob");
		room = joinTeam(room.code, "p2", "blue");
		expect(canStartGame(room).valid).toBe(true);
	});

	it("invalid when teams are unequal", () => {
		const room = createRoom("h1", "Alice", cfg2);
		expect(canStartGame(room).valid).toBe(false);
	});

	it("invalid for 3-team with non-multiple-of-3 count", () => {
		let room = createRoom("h1", "Alice", { ...cfg2, teamCount: 3 });
		room = joinRoom(room.code, "p2", "Bob");
		room = joinTeam(room.code, "p2", "blue");
		expect(canStartGame(room).valid).toBe(false);
	});
});
