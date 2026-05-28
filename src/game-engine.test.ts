import { buildAndDealHands, drawCard, playCard, applyPenalty } from "./game-engine";
import { createRoom, joinRoom, joinTeam } from "./room-manager";
import { GameConfig, Room } from "./types";

function make2PlayerRoom(): Room {
	const config: GameConfig = {
		teamCount: 2,
		maxPlayersPerTeam: 1,
		timer: "off",
		enforceNoTableTalk: true,
		allowDeadCards: true,
		showDeckCount: true,
	};

	let room = createRoom("p1", "p1", "Alice", config);
	room = joinRoom(room.code, "p2", "p2", "Bob");
	room = joinTeam(room.code, "p2", "blue");
	return room;
}

describe("buildAndDealHands", () => {
	it("deals 7 cards to each pplayer in a 2 player game", () => {
		const room = buildAndDealHands(make2PlayerRoom());
		expect(room.teams.green.players[0].hand).toHaveLength(7);
		expect(room.teams.blue.players[0].hand).toHaveLength(7);
		expect(room.deck).toHaveLength(90); // 104 total - 14 dealt
	});

	it("creates 104 total cards (deck + hands)", () => {
		const room = buildAndDealHands(make2PlayerRoom());
		const allCards = [
			...room.deck,
			...Object.values(room.teams).flatMap((team) =>
				team.players.flatMap((player) => player.hand),
			),
		];

		expect(allCards).toHaveLength(104);
		const ids = allCards.map((card) => card.id);
		expect(new Set(ids).size).toBe(104); // all unique
	});
});

describe("drawCard", () => {
	it("moves card from deck to player hand", () => {
		let room = buildAndDealHands(make2PlayerRoom());
		const deckBefore = room.deck.length;
		const { room: after, drawnCard } = drawCard(room, "p1");

		expect(after.deck).toHaveLength(deckBefore - 1);
		expect(after.teams.green.players[0].hand).toHaveLength(8);
		expect(drawnCard).not.toBeNull();
	});

	it("reshuffles discards when deck is empty", () => {
		let room = buildAndDealHands(make2PlayerRoom());
		room = {
			...room,
			discardPile: [...room.deck],
			deck: [],
		};
		const { reshuffled, drawnCard } = drawCard(room, "p1");

		expect(reshuffled).toBe(true);
		expect(drawnCard).not.toBeNull();
	});
});

describe("playCard", () => {
	it("removes card from hand and adds to discard", () => {
		let room = buildAndDealHands(make2PlayerRoom());
		const card = room.teams.green.players[0].hand[0];
		const { room: after, card: played } = playCard(room, "p1", card.id);

		expect(after.teams.green.players[0].hand.find((c) => c.id === card.id)).toBeUndefined();
		expect(after.discardPile).toContainEqual(card);
		expect(played?.id).toBe(card.id);
	});
});

describe("applyPenalty", () => {
	it("removes one card from each player on penalized team", () => {
		let room = buildAndDealHands(make2PlayerRoom());
		const before = room.teams.green.players[0].hand.length;
		room = applyPenalty(room, "green");
		expect(room.teams.green.players[0].hand).toHaveLength(before - 1);
	});
});
