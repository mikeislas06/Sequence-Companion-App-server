import { Card, JackType, Rank, Room, Suit, TeamColor } from "./types";
import { findPlayerInRoom } from "./room-manager";

const SUITS: Suit[] = ["S", "H", "D", "C"];
const RANKS: Rank[] = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];

const HAND_SIZES: Record<number, number> = {
	2: 7,
	3: 6,
	4: 6,
	6: 5,
	8: 4,
	9: 4,
	10: 3,
	12: 3,
};

function getJackType(suit: Suit): JackType {
	return suit === "S" || suit === "C" ? "one-eyed" : "two-eyed";
}

function buildDeck(): Card[] {
	const cards: Card[] = [];
	for (let copy = 1; copy <= 2; copy++) {
		for (const suit of SUITS) {
			for (const rank of RANKS) {
				const card: Card = {
					id: `${rank}${suit}-${copy}`,
					rank,
					suit,
				};

				if (rank === "J") {
					card.jackType = getJackType(suit);
				}
				cards.push(card);
			}
		}
	}
	return cards;
}

function shuffle<T>(arr: T[]): T[] {
	const result = [...arr];
	for (let i = result.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[result[i], result[j]] = [result[j], result[i]];
	}
	return result;
}

export function buildAndDealHands(room: Room): Room {
	const allPlayers = Object.values(room.teams).flatMap((team) => team.players);
	const handSize = HAND_SIZES[allPlayers.length] || 3; // default to 3 if unexpected player count
	const deck = shuffle(buildDeck());

	let i = 0;
	for (const player of allPlayers) {
		player.hand = deck.slice(i, i + handSize);
		player.handLimit = handSize;
		i += handSize;
	}

	return {
		...room,
		deck: deck.slice(i),
		discardPile: [],
	};
}

export function drawCard(
	room: Room,
	playerId: string,
): { room: Room; drawnCard: Card | null; reshuffled: boolean } {
	let deck = [...room.deck];
	let discardPile = [...room.discardPile];
	let reshuffled = false;

	if (deck.length === 0) {
		deck = shuffle(discardPile);
		discardPile = [];
		reshuffled = true;
	}

	if (deck.length === 0) return { room, drawnCard: null, reshuffled: false }; // no cards left to draw

	const [drawnCard, ...remaining] = deck;
	const player = findPlayerInRoom(room, playerId);
	if (player) player.hand = [...player.hand, drawnCard];

	return {
		room: { ...room, deck: remaining, discardPile },
		drawnCard,
		reshuffled,
	};
}

export function playCard(
	room: Room,
	playerId: string,
	cardId: string,
): { room: Room; card: Card | null } {
	const player = findPlayerInRoom(room, playerId);
	if (!player) return { room, card: null };

	const cardIndex = player.hand.findIndex((c) => c.id === cardId);
	if (cardIndex === -1) return { room, card: null };

	const [card] = player.hand.splice(cardIndex, 1);
	return {
		room: { ...room, discardPile: [...room.discardPile, card], lastPlayedCard: card },
		card,
	};
}

export function replaceDeadCard(
	room: Room,
	playerId: string,
	cardId: string,
): { room: Room; replacement: Card | null; reshuffled: boolean } {
	const { room: afterPlay } = playCard(room, playerId, cardId);
	const { room: afterDraw, drawnCard, reshuffled } = drawCard(afterPlay, playerId);
	return { room: afterDraw, replacement: drawnCard, reshuffled };
}

export function applyPenalty(room: Room, teamColor: TeamColor): Room {
	const team = room.teams[teamColor];
	for (const player of team.players) {
		if (player.hand.length > 0) {
			const [removed] = player.hand.splice(player.hand.length - 1, 1);
			room.discardPile.push(removed);
		}
	}
	return { ...room };
}
