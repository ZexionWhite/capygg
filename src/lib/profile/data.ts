import { container } from '@sapphire/framework';
import type { RiotAccount } from '../../generated/prisma/client.js';
import { QUEUES } from '../constants.js';
import { createLogger } from '../logger.js';
import { syncRiotId, getSummonerRefreshingPuuid } from '../riot/account-sync.js';
import { riotClient } from '../riot/client.js';
import { syncAccountMatches } from '../riot/data-sync.js';
import type { Region } from '../types/index.js';
import type { RiotLeagueEntry } from '../types/riot.js';
import { MATCH_ROWS, type ProfileMatchRow, type ProfileRank, type ProfileRenderData } from './render.js';
import {
	aggregateChampions,
	calculateStreak,
	cleanDisplayName,
	detectMain,
	detectOtp,
	killParticipation,
	performanceTag,
	pickDistinctions,
	pickPositions,
	recentRecord,
	REMAKE_MAX_SECONDS,
	splitTeams,
	SR_QUEUE_IDS,
	type MatchPlayer
} from './stats.js';

const log = createLogger('profile');

const TFT_QUEUE = 'RANKED_TFT';
const RANK_QUEUES = [QUEUES.SOLO, QUEUES.FLEX, TFT_QUEUE];
const RANK_TTL_MS = 15 * 60 * 1_000;
const UNRANKED = 'UNRANKED';

/**
 * Arma todo lo que necesita la imagen del perfil a partir de la base de datos.
 * Los rangos se refrescan contra Riot si faltan o tienen más de 15 minutos.
 */
export interface ProfileDataOptions {
	region: Region;
	guildId: string | null;
	/** Nombre de la cuenta de Discord (nombre global o usuario). */
	displayName: string;
}

export async function loadProfileData(storedAccount: RiotAccount, { region, guildId, displayName }: ProfileDataOptions): Promise<ProfileRenderData> {
	const { prisma } = container;

	// El ícono, el nivel y el Riot ID cambian en Riot pero la base solo los guardaba al vincular la cuenta.
	const account = await syncRiotId(await syncSummoner(storedAccount, region), region);
	const { puuid } = account;

	// Rangos y partidas nuevas (de todos los modos) se actualizan antes de leer la base.
	const [rankRows] = await Promise.all([ensureFreshRanks(puuid, region), syncRecentMatches(account, region)]);

	const [recent, srRows, masteries, awards, otpOverride, preference] = await Promise.all([
		prisma.matchParticipant.findMany({
			where: { puuid },
			include: { match: true },
			orderBy: { match: { gameStartTimestamp: 'desc' } },
			take: 30
		}),
		prisma.matchParticipant.findMany({
			where: { puuid, match: { queueId: { in: SR_QUEUE_IDS } } },
			orderBy: { match: { gameStartTimestamp: 'desc' } },
			take: 100,
			select: { championId: true, championName: true, win: true, teamPosition: true, individualPosition: true }
		}),
		prisma.championMastery.findMany({ where: { puuid }, select: { championId: true, championLevel: true, championPoints: true } }),
		guildId
			? prisma.distinctionAward.findMany({ where: { guildId, discordId: account.discordId, revokedAt: null }, orderBy: { awardedAt: 'asc' } })
			: Promise.resolve([]),
		guildId ? prisma.otpOverride.findFirst({ where: { guildId, puuid } }) : Promise.resolve(null),
		guildId ? prisma.playerGuildPreference.findUnique({ where: { guildId_discordId: { guildId, discordId: account.discordId } } }) : Promise.resolve(null)
	]);

	// Ranks
	const latest = new Map(rankRows.map((row) => [row.queue, row]));
	const toRank = (row: (typeof rankRows)[number] | undefined): ProfileRank | undefined =>
		row ? { tier: row.tier, division: row.division, lp: row.lp, wins: row.wins, losses: row.losses } : undefined;

	// Partidas recientes (las del historial llevan a los 10 jugadores)
	const shown = recent.slice(0, MATCH_ROWS);
	const participantRows = shown.length ? await prisma.matchParticipant.findMany({ where: { matchId: { in: shown.map((entry) => entry.matchId) } } }) : [];
	const participantsByMatch = new Map<string, MatchPlayer[]>();
	for (const row of participantRows) participantsByMatch.set(row.matchId, [...(participantsByMatch.get(row.matchId) ?? []), row]);

	const matches: ProfileMatchRow[] = shown.map((entry) => {
		const everyone = participantsByMatch.get(entry.matchId) ?? [];
		const teams = splitTeams(everyone, puuid);
		const items = [entry.item0, entry.item1, entry.item2, entry.item3, entry.item4, entry.item5].filter((item): item is number => typeof item === 'number' && item > 0);

		return {
			win: entry.win,
			remake: entry.match.gameDuration < REMAKE_MAX_SECONDS,
			queueLabel: entry.match.queueLabel,
			durationSeconds: entry.match.gameDuration,
			startedAt: entry.match.gameStartTimestamp,
			championName: entry.championName,
			champLevel: entry.champLevel,
			kills: entry.kills,
			deaths: entry.deaths,
			assists: entry.assists,
			cs: entry.totalMinionsKilled === null && entry.neutralMinionsKilled === null ? null : (entry.totalMinionsKilled ?? 0) + (entry.neutralMinionsKilled ?? 0),
			items,
			trinket: typeof entry.item6 === 'number' && entry.item6 > 0 ? entry.item6 : null,
			spells: [entry.summoner1Id, entry.summoner2Id].filter((spell): spell is number => typeof spell === 'number' && spell > 0),
			teams: teams
				? {
						ally: teams.ally.map((player) => ({ championName: player.championName, isSelf: player.puuid === puuid })),
						enemy: teams.enemy.map((player) => ({ championName: player.championName, isSelf: false }))
					}
				: null,
			killParticipation: killParticipation(everyone, puuid),
			tag: performanceTag(everyone, puuid)
		};
	});

	// Los remakes no cuentan para rachas ni para el récord reciente.
	const results = recent.filter((entry) => entry.match.gameDuration >= REMAKE_MAX_SECONDS).map((entry) => entry.win);

	// Campeones, OTP, posiciones
	const champions = aggregateChampions(srRows);
	const otp = detectOtp(champions, srRows.length, masteries);
	const isOtp = otp !== null || otpOverride !== null;
	const otpChampion = otp?.championName ?? (otpOverride ? (champions.find((champion) => champion.championId === otpOverride.championId)?.championName ?? null) : null);
	const main = detectMain(champions);
	const levelByChampion = new Map(masteries.map((mastery) => [mastery.championId, mastery.championLevel]));

	const activeDistinctions = awards.map((award) => award.key);
	if (isOtp) activeDistinctions.unshift('OTP');

	return {
		displayName: cleanDisplayName(displayName, account.gameName),
		gameName: account.gameName,
		tagLine: account.tagLine,
		region: account.region,
		summonerLevel: account.summonerLevel ?? 0,
		profileIconId: account.profileIconId ?? 0,
		solo: toRank(latest.get(QUEUES.SOLO)),
		flex: toRank(latest.get(QUEUES.FLEX)),
		tft: toRank(latest.get(TFT_QUEUE) ?? rankRows.find((row) => row.queue.startsWith(TFT_QUEUE))),
		positions: pickPositions(srRows, preference?.primaryLane ?? null),
		distinctions: pickDistinctions(activeDistinctions, 3),
		isOtp,
		otpChampion,
		mainChampion: main?.championName ?? null,
		streak: calculateStreak(results),
		recent: recentRecord(results, 10),
		matches,
		championPool: champions.slice(0, 4).map((champion) => ({
			championName: champion.championName,
			games: champion.games,
			wins: champion.wins,
			masteryLevel: levelByChampion.get(champion.championId) ?? null
		}))
	};
}

/**
 * Devuelve los snapshots de Solo/Duo, Flex y TFT. Si falta alguno o hay uno vencido, los pide a Riot
 * (con prioridad alta porque hay un usuario esperando). Si Riot falla se muestran los datos guardados.
 */
async function ensureFreshRanks(puuid: string, region: Region) {
	const { prisma } = container;
	const existing = await prisma.rankSnapshot.findMany({ where: { puuid }, orderBy: { createdAt: 'desc' }, distinct: ['queue'] });

	const now = Date.now();
	const fresh = RANK_QUEUES.every((queue) => {
		const row = existing.find((candidate) => candidate.queue === queue);
		return row !== undefined && now - row.createdAt.getTime() < RANK_TTL_MS;
	});
	if (fresh) return existing;

	const [league, tft] = await Promise.allSettled([
		riotClient.getLeagueEntriesByPuuid(puuid, region, 'critical'),
		riotClient.getTftLeagueEntriesByPuuid(puuid, region, 'critical')
	]);

	const createdAt = new Date();
	const rows: Array<{ puuid: string; queue: string; tier: string; division: string; lp: number; wins: number; losses: number; createdAt: Date }> = [];
	const toRow = (queue: string, entry: RiotLeagueEntry | undefined) => ({
		puuid,
		queue,
		tier: entry?.tier ?? UNRANKED,
		division: entry?.rank ?? '',
		lp: entry?.leaguePoints ?? 0,
		wins: entry?.wins ?? 0,
		losses: entry?.losses ?? 0,
		createdAt
	});

	if (league.status === 'fulfilled') {
		for (const queue of [QUEUES.SOLO, QUEUES.FLEX]) rows.push(toRow(queue, league.value.find((entry) => entry.queueType === queue)));
	} else {
		log.warn(`No pude actualizar los rangos de ${puuid.slice(0, 8)}…: ${String(league.reason)}`);
	}

	if (tft.status === 'fulfilled') {
		rows.push(toRow(TFT_QUEUE, tft.value.find((entry) => entry.queueType === TFT_QUEUE)));
	} else {
		log.debug(`No pude actualizar el rango de TFT de ${puuid.slice(0, 8)}…: ${String(tft.reason)}`);
	}

	if (!rows.length) return existing;

	await prisma.$transaction([
		prisma.rankSnapshot.deleteMany({ where: { puuid, queue: { in: rows.map((row) => row.queue) } } }),
		prisma.rankSnapshot.createMany({ data: rows })
	]);

	return prisma.rankSnapshot.findMany({ where: { puuid }, orderBy: { createdAt: 'desc' }, distinct: ['queue'] });
}

const SUMMONER_TTL_MS = 10 * 60 * 1_000;
const SUMMONER_RETRY_MS = 60 * 1_000;
const lastSummonerSync = new Map<string, number>();

/** Trae el ícono y el nivel actuales de Riot (como máximo cada 10 min por cuenta) y los guarda. Nunca falla: ante un error devuelve la cuenta tal cual. */
export async function syncSummoner(account: RiotAccount, region: Region): Promise<RiotAccount> {
	const last = lastSummonerSync.get(account.puuid) ?? 0;
	if (Date.now() - last < SUMMONER_TTL_MS) return account;
	lastSummonerSync.set(account.puuid, Date.now());

	try {
		const { account: current, summoner } = await getSummonerRefreshingPuuid(account, region);
		if (current.profileIconId === summoner.profileIconId && current.summonerLevel === summoner.summonerLevel) return current;

		return await container.prisma.riotAccount.update({
			where: { puuid: current.puuid },
			data: { profileIconId: summoner.profileIconId, summonerLevel: summoner.summonerLevel }
		});
	} catch (error) {
		log.warn(`No pude actualizar el ícono y el nivel de ${account.gameName}#${account.tagLine}: ${String(error)}`);
		lastSummonerSync.set(account.puuid, Date.now() - SUMMONER_TTL_MS + SUMMONER_RETRY_MS);
		return account;
	}
}

const MATCH_SYNC_TTL_MS = 2 * 60 * 1_000;
const lastMatchSync = new Map<string, number>();

/**
 * Trae las partidas nuevas (cualquier modo) antes de armar el perfil, para no depender de que el cron ya haya corrido.
 * Como máximo cada 2 min por cuenta. Nunca falla: ante un error se muestra lo que ya hay guardado.
 */
async function syncRecentMatches(account: RiotAccount, region: Region): Promise<void> {
	const last = lastMatchSync.get(account.puuid) ?? 0;
	if (Date.now() - last < MATCH_SYNC_TTL_MS) return;
	lastMatchSync.set(account.puuid, Date.now());

	try {
		const { stored, errors } = await syncAccountMatches(account, region, 'critical', 10);
		if (stored > 0 || errors > 0) log.debug(`Partidas de ${account.gameName}#${account.tagLine}: ${stored} nuevas, ${errors} con error.`);
	} catch (error) {
		log.warn(`No pude sincronizar las partidas de ${account.gameName}#${account.tagLine}: ${String(error)}`);
	}
}