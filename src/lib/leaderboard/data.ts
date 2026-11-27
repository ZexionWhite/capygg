import { container } from '@sapphire/framework';
import type { Guild } from 'discord.js';
import type { RiotAccount } from '../../generated/prisma/client.js';
import { QUEUES } from '../constants.js';
import { createLogger } from '../logger.js';
import { syncSummoner } from '../profile/data.js';
import { aggregateChampions, cleanDisplayName, detectMain, detectOtp, SR_QUEUE_IDS } from '../profile/stats.js';
import { refreshStoredPuuid } from '../riot/account-sync.js';
import { RiotApiError, riotClient } from '../riot/client.js';
import { isRegion } from '../types/index.js';
import type { RiotLeagueEntry } from '../types/riot.js';
import type { LeaderboardEntry, LeaderboardQueue, LeaderboardRenderData } from './render.js';

const log = createLogger('leaderboard');

/** Cuánto tiempo se reutiliza un rango guardado antes de volver a preguntarle a Riot. */
export const CACHE_TTL_MS = 30 * 60 * 1_000;
/** Tope de cuentas que se actualizan por ejecución (la personal key permite 100 requests cada 2 minutos). */
const MAX_REFRESH_PER_RUN = 30;
const REFRESH_CHUNK_SIZE = 5;
/** Tiempo máximo que se espera a Riot por los íconos de la página antes de dibujar con lo que hay guardado. */
const ICON_REFRESH_BUDGET_MS = 3_500;

export const PAGE_SIZE = 10;
/** Cuántos puestos llevan el fondo con el campeón. Tiene que coincidir con PODIUM_SIZE del render. */
const PODIUM_SIZE = 3;

const TFT_QUEUE = 'RANKED_TFT';
const UNRANKED = 'UNRANKED';
const TIER_ORDER = ['IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD', 'DIAMOND', 'MASTER', 'GRANDMASTER', 'CHALLENGER'];
const DIVISION_ORDER = ['IV', 'III', 'II', 'I'];

export const QUEUE_LABELS: Record<LeaderboardQueue, string> = { SOLO: 'Solo/Duo', FLEX: 'Flex 5v5', TFT: 'TFT' };

/** Nombre de la cola en `RankSnapshot.queue`. */
function snapshotQueue(queue: LeaderboardQueue): string {
	return queue === 'TFT' ? TFT_QUEUE : QUEUES[queue];
}

export interface Standing {
	account: RiotAccount;
	tier: string;
	division: string;
	lp: number;
	wins: number;
	losses: number;
}

export interface LeaderboardSnapshot {
	queue: LeaderboardQueue;
	/** Ordenados de mejor a peor. */
	standings: Standing[];
	/** Cuentas vinculadas sin ningún dato todavía de esta cola. */
	pending: number;
	/** Cuentas que se intentaron actualizar contra Riot y fallaron. */
	failed: number;
	totalAccounts: number;
	/** Campeón del fondo del podio, por puuid (se calcula una sola vez por comando). */
	championCache: Map<string, string | null>;
}

/* -------------------------------------------------------------------------- */
/*  Carga y refresco                                                           */
/* -------------------------------------------------------------------------- */

/** Devuelve el ranking ordenado de los miembros del servidor con cuenta vinculada, actualizando lo vencido. */
export async function loadStandings(guild: Guild, queue: LeaderboardQueue): Promise<LeaderboardSnapshot> {
	const { prisma } = container;
	const queueName = snapshotQueue(queue);

	if (guild.members.cache.size < guild.memberCount) await guild.members.fetch();

	const linked = await prisma.riotAccount.findMany();
	const members = linked.filter((account: RiotAccount) => guild.members.cache.has(account.discordId));

	const empty: LeaderboardSnapshot = { queue, standings: [], pending: 0, failed: 0, totalAccounts: members.length, championCache: new Map() };
	if (members.length === 0) return empty;

	const failed = await refreshStale(members, queue);

	// Se vuelve a leer porque el refresco pudo cambiar PUUIDs y rangos guardados.
	const accounts: RiotAccount[] = await prisma.riotAccount.findMany({ where: { discordId: { in: members.map((account: RiotAccount) => account.discordId) } } });
	const snapshots: Array<{ puuid: string; tier: string; division: string; lp: number; wins: number; losses: number }> = await prisma.rankSnapshot.findMany({
		where: { queue: queueName, puuid: { in: accounts.map((account) => account.puuid) } }
	});
	const snapshotByPuuid = new Map(snapshots.map((snapshot) => [snapshot.puuid, snapshot]));

	const standings: Standing[] = [];
	let pending = 0;
	for (const account of accounts) {
		const snapshot = snapshotByPuuid.get(account.puuid);
		if (!snapshot) {
			pending++;
			continue;
		}
		if (snapshot.tier === UNRANKED) continue;
		standings.push({ account, tier: snapshot.tier, division: snapshot.division, lp: snapshot.lp, wins: snapshot.wins, losses: snapshot.losses });
	}

	standings.sort(compareStandings);
	return { queue, standings, pending, failed, totalAccounts: accounts.length, championCache: new Map() };
}

/** Actualiza contra Riot los rangos que no existen o están vencidos, empezando por los más viejos. Devuelve cuántos fallaron. */
async function refreshStale(accounts: RiotAccount[], queue: LeaderboardQueue): Promise<number> {
	const { prisma } = container;
	const queueName = snapshotQueue(queue);

	const snapshots: Array<{ puuid: string; createdAt: Date }> = await prisma.rankSnapshot.findMany({
		where: { queue: queueName, puuid: { in: accounts.map((account) => account.puuid) } },
		select: { puuid: true, createdAt: true }
	});
	const ageByPuuid = new Map(snapshots.map((snapshot) => [snapshot.puuid, snapshot.createdAt.getTime()]));

	const now = Date.now();
	const stale = accounts
		.filter((account) => now - (ageByPuuid.get(account.puuid) ?? 0) > CACHE_TTL_MS)
		.sort((left, right) => (ageByPuuid.get(left.puuid) ?? 0) - (ageByPuuid.get(right.puuid) ?? 0))
		.slice(0, MAX_REFRESH_PER_RUN);

	let failed = 0;
	for (let index = 0; index < stale.length; index += REFRESH_CHUNK_SIZE) {
		const chunk = stale.slice(index, index + REFRESH_CHUNK_SIZE);
		const results = await Promise.all(chunk.map((account) => fetchEntries(account, queue)));

		// Las escrituras van de a una para no pisar transacciones de SQLite.
		for (const result of results) {
			if (!result) failed++;
			else if (queue === 'TFT') await saveTftSnapshot(result.puuid, result.entries);
			else await saveLolSnapshots(result.puuid, result.entries);
		}
	}

	return failed;
}

async function fetchEntries(account: RiotAccount, queue: LeaderboardQueue): Promise<{ puuid: string; entries: RiotLeagueEntry[] } | null> {
	if (!isRegion(account.region)) return null;
	const region = account.region;
	const request = (puuid: string) => (queue === 'TFT' ? riotClient.getTftLeagueEntriesByPuuid(puuid, region) : riotClient.getLeagueEntriesByPuuid(puuid, region));

	try {
		let current = account;
		const entries = await request(current.puuid).catch(async (error: unknown) => {
			if (!(error instanceof RiotApiError) || error.kind !== 'INVALID_PUUID') throw error;
			current = await refreshStoredPuuid(account, region);
			return request(current.puuid);
		});
		return { puuid: current.puuid, entries };
	} catch (error) {
		log.warn(`No pude actualizar ${account.gameName}#${account.tagLine} (${queue}): ${String(error)}`);
		return null;
	}
}

/** Guarda una fila por cola de LoL (Solo y Flex) para que la otra cola también quede en caché. */
async function saveLolSnapshots(puuid: string, entries: RiotLeagueEntry[]): Promise<void> {
	const createdAt = new Date();
	const rows = Object.values(QUEUES).map((queue) => {
		const entry = entries.find((value) => value.queueType === queue);
		return { puuid, queue, tier: entry?.tier ?? UNRANKED, division: entry?.rank ?? '', lp: entry?.leaguePoints ?? 0, wins: entry?.wins ?? 0, losses: entry?.losses ?? 0, createdAt };
	});

	await container.prisma.$transaction([
		container.prisma.rankSnapshot.deleteMany({ where: { puuid, queue: { in: Object.values(QUEUES) } } }),
		container.prisma.rankSnapshot.createMany({ data: rows })
	]);
}

async function saveTftSnapshot(puuid: string, entries: RiotLeagueEntry[]): Promise<void> {
	const entry = entries.find((value) => value.queueType === TFT_QUEUE);
	const row = {
		puuid,
		queue: TFT_QUEUE,
		tier: entry?.tier ?? UNRANKED,
		division: entry?.rank ?? '',
		lp: entry?.leaguePoints ?? 0,
		wins: entry?.wins ?? 0,
		losses: entry?.losses ?? 0,
		createdAt: new Date()
	};

	await container.prisma.$transaction([container.prisma.rankSnapshot.deleteMany({ where: { puuid, queue: TFT_QUEUE } }), container.prisma.rankSnapshot.create({ data: row })]);
}

function compareStandings(left: Standing, right: Standing): number {
	return (
		TIER_ORDER.indexOf(right.tier) - TIER_ORDER.indexOf(left.tier) ||
		DIVISION_ORDER.indexOf(right.division) - DIVISION_ORDER.indexOf(left.division) ||
		right.lp - left.lp ||
		right.wins + right.losses - (left.wins + left.losses) ||
		left.account.gameName.localeCompare(right.account.gameName)
	);
}

/* -------------------------------------------------------------------------- */
/*  Página para dibujar                                                        */
/* -------------------------------------------------------------------------- */

export function totalPagesOf(snapshot: LeaderboardSnapshot): number {
	return Math.max(1, Math.ceil(snapshot.standings.length / PAGE_SIZE));
}

/** Posición (desde 0) de alguien en el ranking, o -1 si no tiene rango en esta cola. */
export function indexOfMember(snapshot: LeaderboardSnapshot, discordId: string): number {
	return snapshot.standings.findIndex((standing) => standing.account.discordId === discordId);
}

export async function buildLeaderboardPage(snapshot: LeaderboardSnapshot, guild: Guild, page: number, viewerId: string): Promise<LeaderboardRenderData> {
	const totalPages = totalPagesOf(snapshot);
	const safePage = Math.min(Math.max(page, 0), totalPages - 1);
	const start = safePage * PAGE_SIZE;
	const slice = snapshot.standings.slice(start, start + PAGE_SIZE);

	const selfIndex = indexOfMember(snapshot, viewerId);
	const selfStanding = selfIndex >= 0 ? snapshot.standings[selfIndex]! : null;

	// Íconos al día para lo que se ve en pantalla (el de la base solo se guardaba al vincular).
	const visible = [...slice, ...(selfStanding && !slice.includes(selfStanding) ? [selfStanding] : [])];
	const iconByPuuid = await freshIcons(visible.map((standing) => standing.account));

	const toEntry = async (standing: Standing, index: number): Promise<LeaderboardEntry> => {
		const { account } = standing;
		const member = guild.members.cache.get(account.discordId);
		const position = index + 1;

		return {
			position,
			displayName: cleanDisplayName(member?.displayName ?? account.gameName, account.gameName),
			gameName: account.gameName,
			tagLine: account.tagLine,
			profileIconId: iconByPuuid.get(account.puuid) ?? account.profileIconId ?? 29,
			championName: position <= PODIUM_SIZE ? await podiumChampion(snapshot, account.puuid, guild.id) : null,
			tier: standing.tier,
			division: standing.division,
			lp: standing.lp,
			wins: standing.wins,
			losses: standing.losses
		};
	};

	const entries = await Promise.all(slice.map((standing, offset) => toEntry(standing, start + offset)));
	const self = selfStanding ? (entries.find((entry) => entry.position === selfIndex + 1) ?? (await toEntry(selfStanding, selfIndex))) : null;

	return {
		guildName: cleanDisplayName(guild.name, 'este servidor'),
		queue: snapshot.queue,
		page: safePage,
		totalPages,
		totalPlayers: snapshot.standings.length,
		pageSize: PAGE_SIZE,
		entries,
		self,
		pending: snapshot.pending
	};
}

/**
 * Trae de Riot el ícono actual de las cuentas visibles (syncSummoner ya respeta un TTL por cuenta y nunca lanza).
 * Si Riot tarda más del presupuesto, se dibuja con lo guardado y lo nuevo queda listo para la próxima página.
 */
export async function freshIcons(accounts: RiotAccount[]): Promise<Map<string, number | null>> {
	const timeout = new Promise<void>((resolve) => setTimeout(resolve, ICON_REFRESH_BUDGET_MS));
	await Promise.race([Promise.allSettled(accounts.map((account) => (isRegion(account.region) ? syncSummoner(account, account.region) : Promise.resolve(account)))), timeout]);

	const rows: Array<{ puuid: string; profileIconId: number | null }> = await container.prisma.riotAccount.findMany({
		where: { puuid: { in: accounts.map((account) => account.puuid) } },
		select: { puuid: true, profileIconId: true }
	});
	return new Map(rows.map((row) => [row.puuid, row.profileIconId]));
}

/** Campeón OTP (o main) que se usa de fondo en el podio. Misma lógica que el perfil. */
async function podiumChampion(snapshot: LeaderboardSnapshot, puuid: string, guildId: string): Promise<string | null> {
	if (snapshot.championCache.has(puuid)) return snapshot.championCache.get(puuid) ?? null;

	try {
		const { prisma } = container;
		const [srRows, masteries, otpOverride]: [
			Array<{ championId: number; championName: string; win: boolean }>,
			Array<{ championId: number; championPoints: number }>,
			{ championId: number } | null
		] = await Promise.all([
			prisma.matchParticipant.findMany({
				where: { puuid, match: { queueId: { in: SR_QUEUE_IDS } } },
				orderBy: { match: { gameStartTimestamp: 'desc' } },
				take: 100,
				select: { championId: true, championName: true, win: true }
			}),
			prisma.championMastery.findMany({ where: { puuid }, select: { championId: true, championPoints: true } }),
			prisma.otpOverride.findFirst({ where: { guildId, puuid } })
		]);

		const champions = aggregateChampions(srRows);
		const otp = detectOtp(champions, srRows.length, masteries);
		const overrideName = otpOverride ? (champions.find((champion) => champion.championId === otpOverride.championId)?.championName ?? null) : null;
		const name = otp?.championName ?? overrideName ?? detectMain(champions)?.championName ?? null;

		snapshot.championCache.set(puuid, name);
		return name;
	} catch (error) {
		log.warn(`No pude calcular el campeón del podio para ${puuid}: ${String(error)}`);
		return null;
	}
}