import { container } from '@sapphire/framework';
import type { Guild } from 'discord.js';
import type { RiotAccount } from '../../generated/prisma/client.js';
import { QUEUES } from '../constants.js';
import { championDisplayNames, dataDragonVersion } from '../ddragon.js';
import { freshIcons } from '../leaderboard/data.js';
import { createLogger } from '../logger.js';
import { aggregateChampions, cleanDisplayName, detectOtp, formatRelativeTime, REMAKE_MAX_SECONDS, SR_QUEUE_IDS } from '../profile/stats.js';
import type { ChampionCatalogEntry } from '../riot/champion-catalog.js';
import { adjustedPerformance, eloNorm, gameImpact, gameScore, masteryNorm, MIN_RECENT_GAMES, powerScore, queueWeight, RANKED_QUEUE_IDS, RECENT_WINDOW_DAYS, type GameSide, type WeightedGame } from './score.js';
import type { ChampionBoardData, ChampionBoardEntry, ChampionBoardMode, SelfBar } from './render.js';

const log = createLogger('champion-ranking');

export const PAGE_SIZE = 10;
/** El ranking se calcula con lo que ya está guardado; se reutiliza este rato para que cambiar de página sea instantáneo. */
const BOARD_TTL_MS = 10 * 60 * 1_000;
const MAX_CACHED_BOARDS = 40;
const LOBBY_CHUNK_SIZE = 400;
const DAY_MS = 24 * 60 * 60 * 1_000;

/** Los tres campos de `championDisplayNames`/catálogo que hacen falta para dibujar. */
export interface BoardChampion {
	id: number;
	/** Nombre para mostrar (el del catálogo, en español). */
	name: string;
	/** Id de Data Dragon (ej. `MonkeyKing` para Wukong): se usa en las URLs de ícono y splash. */
	key: string;
}

interface BoardRow {
	account: RiotAccount;
	tier: string;
	division: string;
	lp: number;
	/** Valor con el que se ordena. */
	sortValue: number;
	score: string;
	stats: ChampionBoardEntry['stats'];
}

export interface ChampionBoard {
	mode: ChampionBoardMode;
	champion: BoardChampion;
	/** Ordenados de mejor a peor. */
	rows: BoardRow[];
	/** discordId -> cuenta vinculada (para saber si alguien que no aparece tiene la cuenta vinculada o no). */
	linked: Set<string>;
	/** puuid -> rankeds con el campeón en los últimos 30 días (para decirle a alguien cuánto le falta). */
	recentGames: Map<string, number>;
	/** puuid -> si tiene puntos de maestría con el campeón. */
	hasMastery: Set<string>;
	otpCache: Map<string, boolean>;
}

const boardCache = new Map<string, { at: number; board: ChampionBoard }>();

/* -------------------------------------------------------------------------- */
/*  Campeón                                                                    */
/* -------------------------------------------------------------------------- */

/** Id de Data Dragon del campeón: primero el que guardan las partidas, si no se deduce del nombre. */
export async function resolveBoardChampion(champion: ChampionCatalogEntry): Promise<BoardChampion> {
	const fromMatches = await container.prisma.matchParticipant.findFirst({ where: { championId: champion.id }, select: { championName: true } }).catch(() => null);
	if (fromMatches?.championName) return { id: champion.id, name: champion.name, key: fromMatches.championName };

	const normalized = normalizeKey(champion.name);
	const ids = await championDisplayNames(await dataDragonVersion());
	const match = [...ids.keys()].find((id) => normalizeKey(id) === normalized || normalizeKey(ids.get(id) ?? '') === normalized);
	return { id: champion.id, name: champion.name, key: match ?? champion.name.replace(/[^A-Za-z0-9]/g, '') };
}

function normalizeKey(value: string): string {
	return value
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^A-Za-z0-9]/g, '')
		.toLowerCase();
}

/* -------------------------------------------------------------------------- */
/*  Carga                                                                      */
/* -------------------------------------------------------------------------- */

export async function loadChampionBoard(guild: Guild, champion: BoardChampion, mode: ChampionBoardMode): Promise<ChampionBoard> {
	const cacheKey = `${guild.id}|${champion.id}|${mode}`;
	const cached = boardCache.get(cacheKey);
	if (cached && Date.now() - cached.at < BOARD_TTL_MS) return cached.board;

	if (guild.members.cache.size < guild.memberCount) await guild.members.fetch();

	const linked: RiotAccount[] = (await container.prisma.riotAccount.findMany()).filter((account: RiotAccount) => guild.members.cache.has(account.discordId));
	const board: ChampionBoard = {
		mode,
		champion,
		rows: [],
		linked: new Set(linked.map((account) => account.discordId)),
		recentGames: new Map(),
		hasMastery: new Set(),
		otpCache: new Map()
	};

	if (linked.length > 0) {
		if (mode === 'MASTERY') await fillMasteryRows(board, linked);
		else await fillPowerRows(board, linked);
	}

	boardCache.set(cacheKey, { at: Date.now(), board });
	if (boardCache.size > MAX_CACHED_BOARDS) {
		const oldest = [...boardCache.entries()].sort((left, right) => left[1].at - right[1].at)[0];
		if (oldest) boardCache.delete(oldest[0]);
	}

	return board;
}

/** Mejor rango guardado de cada cuenta: Solo/Duo y, si no tiene, Flex. */
async function loadElos(puuids: string[]): Promise<Map<string, { tier: string; division: string; lp: number }>> {
	if (puuids.length === 0) return new Map();

	const snapshots = await container.prisma.rankSnapshot.findMany({ where: { puuid: { in: puuids }, queue: { in: [QUEUES.SOLO, QUEUES.FLEX] } } });
	const elos = new Map<string, { tier: string; division: string; lp: number }>();

	for (const queue of [QUEUES.FLEX, QUEUES.SOLO]) {
		for (const snapshot of snapshots) {
			if (snapshot.queue !== queue || snapshot.tier === 'UNRANKED') continue;
			elos.set(snapshot.puuid, { tier: snapshot.tier, division: snapshot.division, lp: snapshot.lp });
		}
	}
	return elos;
}

async function fillMasteryRows(board: ChampionBoard, accounts: RiotAccount[]): Promise<void> {
	const puuids = accounts.map((account) => account.puuid);
	const [masteries, elos] = await Promise.all([
		container.prisma.championMastery.findMany({ where: { championId: board.champion.id, puuid: { in: puuids }, championPoints: { gt: 0 } }, orderBy: { championPoints: 'desc' } }),
		loadElos(puuids)
	]);

	const accountByPuuid = new Map(accounts.map((account) => [account.puuid, account]));
	const now = new Date();

	for (const mastery of masteries) {
		const account = accountByPuuid.get(mastery.puuid);
		if (!account) continue;

		board.hasMastery.add(mastery.puuid);
		const elo = elos.get(mastery.puuid);
		board.rows.push({
			account,
			tier: elo?.tier ?? 'UNRANKED',
			division: elo?.division ?? '',
			lp: elo?.lp ?? 0,
			sortValue: mastery.championPoints,
			score: formatNumber(mastery.championPoints),
			stats: [{ value: `M${mastery.championLevel}`, tone: mastery.championLevel >= 10 ? 'good' : 'muted' }, { value: mastery.lastPlayTime ? formatRelativeTime(mastery.lastPlayTime, now) : '—', tone: 'muted' }]
		});
	}
}

interface OwnGame {
	puuid: string;
	matchId: string;
	win: boolean;
	kills: number;
	deaths: number;
	assists: number;
	side: GameSide;
	queueId: number;
	startedAt: number;
}

async function fillPowerRows(board: ChampionBoard, accounts: RiotAccount[]): Promise<void> {
	const { prisma } = container;
	const puuids = accounts.map((account) => account.puuid);
	const accountByPuuid = new Map(accounts.map((account) => [account.puuid, account]));
	const recentSince = Date.now() - RECENT_WINDOW_DAYS * DAY_MS;

	// Todas las rankeds guardadas con el campeón: las estadísticas se acumulan, la ventana de 30 días solo es el requisito de actividad.
	const participations = await prisma.matchParticipant.findMany({
		where: { championId: board.champion.id, puuid: { in: puuids }, match: { queueId: { in: [...RANKED_QUEUE_IDS] }, gameDuration: { gte: REMAKE_MAX_SECONDS + 1 } } },
		select: {
			matchId: true,
			puuid: true,
			win: true,
			kills: true,
			deaths: true,
			assists: true,
			teamId: true,
			teamPosition: true,
			totalDamageDealtToChampions: true,
			goldEarned: true,
			totalMinionsKilled: true,
			neutralMinionsKilled: true,
			visionScore: true,
			match: { select: { queueId: true, gameStartTimestamp: true } }
		}
	});

	const gamesByPuuid = new Map<string, OwnGame[]>();
	for (const row of participations) {
		const game: OwnGame = {
			puuid: row.puuid,
			matchId: row.matchId,
			win: row.win,
			kills: row.kills,
			deaths: row.deaths,
			assists: row.assists,
			queueId: row.match.queueId,
			startedAt: row.match.gameStartTimestamp.getTime(),
			side: toSide(row)
		};
		const list = gamesByPuuid.get(row.puuid);
		if (list) list.push(game);
		else gamesByPuuid.set(row.puuid, [game]);
	}

	// Requisito: al menos N rankeds con el campeón en los últimos 30 días.
	const qualified: string[] = [];
	for (const [puuid, games] of gamesByPuuid) {
		const recent = games.filter((game) => game.startedAt >= recentSince).length;
		board.recentGames.set(puuid, recent);
		if (recent >= MIN_RECENT_GAMES) qualified.push(puuid);
	}
	if (qualified.length === 0) return;

	// Para medir el impacto hace falta ver a los 10 jugadores de cada partida.
	const matchIds = [...new Set(qualified.flatMap((puuid) => gamesByPuuid.get(puuid)!.map((game) => game.matchId)))];
	const lobbies = new Map<string, GameSide[]>();
	for (let index = 0; index < matchIds.length; index += LOBBY_CHUNK_SIZE) {
		const chunk = matchIds.slice(index, index + LOBBY_CHUNK_SIZE);
		const lobbyRows = await prisma.matchParticipant.findMany({
			where: { matchId: { in: chunk } },
			select: { matchId: true, puuid: true, kills: true, deaths: true, assists: true, teamId: true, teamPosition: true, totalDamageDealtToChampions: true, goldEarned: true, totalMinionsKilled: true, neutralMinionsKilled: true, visionScore: true }
		});
		for (const row of lobbyRows) {
			const list = lobbies.get(row.matchId);
			if (list) list.push(toSide(row));
			else lobbies.set(row.matchId, [toSide(row)]);
		}
	}

	const [elos, masteries] = await Promise.all([
		loadElos(qualified),
		prisma.championMastery.findMany({ where: { championId: board.champion.id, puuid: { in: qualified } }, select: { puuid: true, championPoints: true } })
	]);
	const pointsByPuuid = new Map(masteries.map((mastery) => [mastery.puuid, mastery.championPoints]));

	for (const puuid of qualified) {
		const account = accountByPuuid.get(puuid);
		const games = gamesByPuuid.get(puuid);
		if (!account || !games) continue;

		const weighted: WeightedGame[] = [];
		let wins = 0;
		let kills = 0;
		let deaths = 0;
		let assists = 0;

		for (const game of games) {
			wins += game.win ? 1 : 0;
			kills += game.kills;
			deaths += game.deaths;
			assists += game.assists;

			const lobby = lobbies.get(game.matchId);
			const impact = lobby ? gameImpact(game.side, lobby) : null;
			weighted.push({ weight: queueWeight(game.queueId), score: gameScore(game.win, impact) });
		}

		const elo = elos.get(puuid);
		const performance = adjustedPerformance(weighted);
		const power = powerScore({
			performance: performance.value,
			elo: eloNorm(elo?.tier, elo?.division, elo?.lp),
			mastery: masteryNorm(pointsByPuuid.get(puuid))
		});

		const winRate = Math.round((wins / games.length) * 100);
		const kda = (kills + assists) / Math.max(1, deaths);

		board.rows.push({
			account,
			tier: elo?.tier ?? 'UNRANKED',
			division: elo?.division ?? '',
			lp: elo?.lp ?? 0,
			sortValue: power.total,
			score: power.total.toFixed(1).replace('.', ','),
			stats: [
				{ value: String(games.length), tone: 'muted' },
				{ value: `${winRate}%`, tone: winRate >= 50 ? 'good' : 'bad' },
				{ value: kda.toFixed(1).replace('.', ','), tone: kda >= 3 ? 'good' : kda < 2 ? 'bad' : 'muted' }
			]
		});
	}

	board.rows.sort((left, right) => right.sortValue - left.sortValue || left.account.gameName.localeCompare(right.account.gameName));
}

function toSide(row: {
	puuid: string;
	kills: number;
	deaths: number;
	assists: number;
	teamId: number | null;
	teamPosition: string | null;
	totalDamageDealtToChampions: number | null;
	goldEarned: number | null;
	totalMinionsKilled: number | null;
	neutralMinionsKilled: number | null;
	visionScore: number | null;
}): GameSide {
	const hasCs = row.totalMinionsKilled !== null || row.neutralMinionsKilled !== null;
	return {
		puuid: row.puuid,
		teamId: row.teamId,
		teamPosition: row.teamPosition || null,
		kills: row.kills,
		deaths: row.deaths,
		assists: row.assists,
		damage: row.totalDamageDealtToChampions,
		gold: row.goldEarned,
		cs: hasCs ? (row.totalMinionsKilled ?? 0) + (row.neutralMinionsKilled ?? 0) : null,
		vision: row.visionScore
	};
}

/* -------------------------------------------------------------------------- */
/*  Página para dibujar                                                        */
/* -------------------------------------------------------------------------- */

export function totalPagesOf(board: ChampionBoard): number {
	return Math.max(1, Math.ceil(board.rows.length / PAGE_SIZE));
}

/** Posición (desde 0) de alguien en el ranking, o -1 si no aparece. */
export function indexOfMember(board: ChampionBoard, discordId: string): number {
	return board.rows.findIndex((row) => row.account.discordId === discordId);
}

export const MODE_LABELS: Record<ChampionBoardMode, string> = { POWER: 'Poder', MASTERY: 'Maestría' };

export async function buildChampionBoardPage(board: ChampionBoard, guild: Guild, page: number, viewerId: string): Promise<ChampionBoardData> {
	const totalPages = totalPagesOf(board);
	const safePage = Math.min(Math.max(page, 0), totalPages - 1);
	const start = safePage * PAGE_SIZE;
	const slice = board.rows.slice(start, start + PAGE_SIZE);

	const selfIndex = indexOfMember(board, viewerId);
	const selfRow = selfIndex >= 0 ? board.rows[selfIndex]! : null;

	const visible = [...slice, ...(selfRow && !slice.includes(selfRow) ? [selfRow] : [])];
	const [icons] = await Promise.all([freshIcons(visible.map((row) => row.account)), ...visible.map((row) => resolveOtp(board, guild.id, row.account.puuid))]);

	const toEntry = (row: BoardRow, index: number): ChampionBoardEntry => {
		const { account } = row;
		return {
			position: index + 1,
			displayName: cleanDisplayName(guild.members.cache.get(account.discordId)?.displayName ?? account.gameName, account.gameName),
			gameName: account.gameName,
			tagLine: account.tagLine,
			profileIconId: icons.get(account.puuid) ?? account.profileIconId ?? 29,
			tier: row.tier,
			division: row.division,
			lp: row.lp,
			score: row.score,
			stats: row.stats,
			isOtp: board.otpCache.get(account.puuid) ?? false
		};
	};

	const entries = slice.map((row, offset) => toEntry(row, start + offset));
	const self: SelfBar = selfRow ? { kind: 'ranked', entry: entries.find((entry) => entry.position === selfIndex + 1) ?? toEntry(selfRow, selfIndex) } : { kind: 'missing', ...(await missingMessage(board, viewerId)) };

	return {
		guildName: cleanDisplayName(guild.name, 'este servidor'),
		mode: board.mode,
		championName: board.champion.name,
		championKey: board.champion.key,
		statColumns: board.mode === 'MASTERY' ? ['NIVEL', 'ÚLTIMA VEZ'] : ['PARTIDAS', 'WR', 'KDA'],
		scoreLabel: board.mode === 'MASTERY' ? 'PUNTOS' : 'PODER',
		page: safePage,
		totalPages,
		totalPlayers: board.rows.length,
		pageSize: PAGE_SIZE,
		entries,
		self
	};
}

/** El texto que ocupa el lugar de "Tu posición" cuando alguien no aparece en el ranking. */
async function missingMessage(board: ChampionBoard, viewerId: string): Promise<{ headline: string; detail: string }> {
	const headline = '¿No aparecés?';
	const champion = board.champion.name;

	if (!board.linked.has(viewerId)) {
		return { headline, detail: 'Todavía no vinculaste tu cuenta de Riot. Vinculala desde el panel de verificación y vas a poder aparecer en el ranking.' };
	}

	if (board.mode === 'MASTERY') {
		return { headline, detail: `Todavía no tenés puntos de maestría con ${champion}. Jugá unas partidas y volvé a mirar.` };
	}

	const account = await container.prisma.riotAccount.findUnique({ where: { discordId: viewerId }, select: { puuid: true } });
	const recent = account ? (board.recentGames.get(account.puuid) ?? 0) : 0;
	const progress = recent > 0 ? ` Ya llevás ${recent} de ${MIN_RECENT_GAMES}, ¡dale que falta poco!` : '';
	return { headline, detail: `Tenés que jugar al menos ${MIN_RECENT_GAMES} rankeds con ${champion} en los últimos ${RECENT_WINDOW_DAYS} días.${progress}` };
}

/** ¿Es OTP de este campeón? Misma regla que el perfil (OTP detectado o forzado por un admin). Se calcula solo para lo que se ve. */
async function resolveOtp(board: ChampionBoard, guildId: string, puuid: string): Promise<void> {
	if (board.otpCache.has(puuid)) return;

	try {
		const { prisma } = container;
		const [srRows, masteries, override] = await Promise.all([
			prisma.matchParticipant.findMany({
				where: { puuid, match: { queueId: { in: SR_QUEUE_IDS } } },
				orderBy: { match: { gameStartTimestamp: 'desc' } },
				take: 100,
				select: { championId: true, championName: true, win: true }
			}),
			prisma.championMastery.findMany({ where: { puuid }, select: { championId: true, championPoints: true } }),
			prisma.otpOverride.findFirst({ where: { guildId, puuid, championId: board.champion.id } })
		]);

		const otp = detectOtp(aggregateChampions(srRows), srRows.length, masteries);
		board.otpCache.set(puuid, override !== null || otp?.championId === board.champion.id);
	} catch (error) {
		log.warn(`No pude calcular si ${puuid} es OTP de ${board.champion.name}`, error);
		board.otpCache.set(puuid, false);
	}
}

/** 1234567 -> "1.234.567" */
function formatNumber(value: number): string {
	return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}