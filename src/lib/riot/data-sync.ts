
import { container } from '@sapphire/framework';
import { createLogger } from '../logger';
import type { RiotAccount } from '../../generated/prisma/client';
import { isRegion } from '../types';
import type { Region } from '../types';
import type { RiotChampionMastery, RiotMatchParticipant } from '../types/riot';
import { riotClient } from './client';
import { getQueueLabel } from './queue-labels';
import type { RiotRequestPriority } from './request-queue';

const logger = createLogger('riot.data-sync');
const MASTERY_TTL_MS = 6 * 60 * 60 * 1_000;
const MATCH_TTL_MS = 10 * 60 * 1_000;
const INITIAL_MATCH_BACKFILL_COUNT = 20;
const REGULAR_MATCH_SYNC_COUNT = 10;

export interface SyncSummary {
	accounts: number;
	updated: number;
	errors: number;
}

/** Refreshes all champion mastery entries for every linked account. */
export async function syncChampionMasteries(): Promise<string> {
	const accounts = await container.prisma.riotAccount.findMany({
		orderBy: { linkedAt: 'asc' }
	});
	const summary: SyncSummary = { accounts: accounts.length, updated: 0, errors: 0 };

	for (const account of accounts) {
		if (!isRegion(account.region)) {
			logger.warn(
				`Skipping mastery sync for ${account.gameName}#${account.tagLine}: invalid region "${account.region}".`
			);
			continue;
		}

		if (
			account.masterySyncedAt &&
			Date.now() - account.masterySyncedAt.getTime() < MASTERY_TTL_MS
		) {
			continue;
		}

		try {
			const masteries = await riotClient.getChampionMasteriesByPuuid(
				account.puuid,
				account.region,
				'background'
			);

			await persistMasteries(account.puuid, masteries);

			await container.prisma.riotAccount.update({
				where: { puuid: account.puuid },
				data: { masterySyncedAt: new Date() }
			});

			summary.updated++;
		} catch (error) {
			summary.errors++;
			logger.warn(
				`Champion mastery sync failed for ${account.gameName}#${account.tagLine}.`,
				error
			);
		}
	}

	return `${summary.updated}/${summary.accounts} accounts updated · ${summary.errors} errors`;
}

export interface MatchSyncResult {
	stored: number;
	errors: number;
}

/** Stores up to 20 recent matches on first sync, then keeps the latest 10-match window fresh. */
export async function syncMatchHistory(): Promise<string> {
	const accounts = await container.prisma.riotAccount.findMany({
		orderBy: { linkedAt: 'asc' }
	});
	const summary: SyncSummary = { accounts: accounts.length, updated: 0, errors: 0 };

	for (const account of accounts) {
		if (!isRegion(account.region)) {
			logger.warn(
				`Skipping match sync for ${account.gameName}#${account.tagLine}: invalid region "${account.region}".`
			);
			continue;
		}

		if (
			account.matchesSyncedAt &&
			Date.now() - account.matchesSyncedAt.getTime() < MATCH_TTL_MS
		) {
			continue;
		}

		const result = await syncAccountMatches(account, account.region, 'background');
		summary.updated += result.stored;
		summary.errors += result.errors;
	}

	return `${summary.updated} new matches across ${summary.accounts} accounts · ${summary.errors} errors`;
}

const inFlightMatchSync = new Map<string, Promise<MatchSyncResult>>();

/**
 * Syncs the recent matches (every game mode) of one account.
 * Safe to call from the cron job and from commands at the same time: concurrent calls for the same account share one run.
 * Pass `count` for a quick on-demand refresh; it never marks the initial backfill as done.
 */
export function syncAccountMatches(
	account: RiotAccount,
	region: Region,
	priority: RiotRequestPriority,
	count?: number
): Promise<MatchSyncResult> {
	const running = inFlightMatchSync.get(account.puuid);
	if (running) return running;

	const job = runAccountMatchSync(account, region, priority, count).finally(() => {
		inFlightMatchSync.delete(account.puuid);
	});
	inFlightMatchSync.set(account.puuid, job);
	return job;
}

async function runAccountMatchSync(
	account: RiotAccount,
	region: Region,
	priority: RiotRequestPriority,
	count: number | undefined
): Promise<MatchSyncResult> {
	let stored = 0;
	let matchErrors = 0;

	try {
		const isInitialBackfill = account.matchHistoryBackfilledAt === null;

		const matchIds = await riotClient.getMatchIdsByPuuid(
			account.puuid,
			region,
			count ?? (isInitialBackfill ? INITIAL_MATCH_BACKFILL_COUNT : REGULAR_MATCH_SYNC_COUNT),
			priority
		);

		for (const matchId of matchIds) {
			try {
				const existing = await container.prisma.matchRecord.findUnique({
					where: { matchId },
					select: {
						participants: { where: { puuid: account.puuid }, select: { summoner1Id: true } }
					}
				});

				// Matches stored before summoner spells and CS were saved are fetched once more to complete them.
				if (existing && existing.participants[0]?.summoner1Id != null) {
					continue;
				}

				const details = await riotClient.getMatchDetails(matchId, region, priority);

				// Riot assigns the literal PUUID "BOT" to bot participants.
				// Since every bot shares that identifier, they cannot be
				// represented individually with the current database constraint.
				const botParticipants = details.participants.filter(
					(participant) => participant.puuid === 'BOT'
				);

				const realParticipants = details.participants.filter(
					(participant) => participant.puuid !== 'BOT'
				);

				if (botParticipants.length > 0) {
					logger.debug(
						`Skipping ${botParticipants.length} bot participants in match ${matchId}.`
					);
				}

				const participantIds = realParticipants.map(
					(participant) => participant.puuid
				);
				const uniqueParticipantIds = new Set(participantIds);

				if (uniqueParticipantIds.size !== participantIds.length) {
					logger.warn(
						`Duplicate player PUUIDs in match ${matchId}: ${
							participantIds.length - uniqueParticipantIds.size
						} duplicates.`
					);
				}

				const participantsByPuuid = new Map(
					realParticipants.map((participant) => [
						participant.puuid,
						participant
					])
				);

				const participants = [...participantsByPuuid.values()];

				const wasCreated = await persistMatch(
					details,
					account.region,
					participants
				);

				if (wasCreated) {
					stored++;
				}
			} catch (error) {
				matchErrors++;
				logger.warn(
					`Could not persist match ${matchId} (${account.gameName}#${account.tagLine}).`,
					error
				);
			}
		}

		const updateData: {
			matchesSyncedAt?: Date;
			matchHistoryBackfilledAt?: Date;
		} = {};

		if (matchErrors === 0) {
			updateData.matchesSyncedAt = new Date();

			if (isInitialBackfill && count === undefined) {
				updateData.matchHistoryBackfilledAt = new Date();
			}
		}

		if (Object.keys(updateData).length > 0) {
			await container.prisma.riotAccount.update({
				where: { puuid: account.puuid },
				data: updateData
			});
		}
	} catch (error) {
		matchErrors++;
		logger.warn(
			`Match history sync failed for ${account.gameName}#${account.tagLine}.`,
			error
		);
	}

	return { stored, errors: matchErrors };
}

async function persistMatch(
	details: Awaited<ReturnType<typeof riotClient.getMatchDetails>>,
	region: string,
	participants: RiotMatchParticipant[]
): Promise<boolean> {
	return container.prisma.$transaction(async (tx) => {
		const existing = await tx.matchRecord.findUnique({
			where: { matchId: details.matchId },
			select: { matchId: true }
		});

		const wasCreated = existing === null;

		await tx.matchRecord.upsert({
			where: { matchId: details.matchId },
			create: {
				matchId: details.matchId,
				region,
				queueId: details.queueId,
				queueLabel: getQueueLabel(details.queueId),
				gameMode: details.gameMode,
				gameType: details.gameType ?? null,
				mapId: details.mapId ?? null,
				gameStartTimestamp: new Date(details.gameStartTimestamp),
				gameDuration: details.gameDuration,
				gameVersion: details.gameVersion ?? null
			},
			update: {}
		});

		for (const participant of participants) {
			const data = toParticipantCreateData(participant);

			await tx.matchParticipant.upsert({
				where: {
					matchId_puuid: {
						matchId: details.matchId,
						puuid: participant.puuid
					}
				},
				create: {
					matchId: details.matchId,
					...data
				},
				update: data
			});
		}

		return wasCreated;
	});
}

async function persistMasteries(
	puuid: string,
	masteries: RiotChampionMastery[]
): Promise<void> {
	const data = masteries.map((mastery) => ({
		puuid,
		championId: mastery.championId,
		championLevel: mastery.championLevel,
		championPoints: mastery.championPoints,
		lastPlayTime: mastery.lastPlayTime > 0 ? new Date(mastery.lastPlayTime) : null,
		championPointsSinceLevel: mastery.championPointsSinceLastLevel,
		championPointsUntilNextLevel: mastery.championPointsUntilNextLevel,
		tokensEarned: mastery.tokensEarned,
		chestGranted: mastery.chestGranted ?? null
	}));

	await container.prisma.$transaction(async (tx) => {
		await tx.championMastery.deleteMany({ where: { puuid } });

		if (data.length > 0) {
			await tx.championMastery.createMany({ data });
		}
	});
}

function toParticipantCreateData(participant: RiotMatchParticipant) {
	return {
		puuid: participant.puuid,
		summonerName: participant.summonerName ?? null,
		riotIdGameName: participant.riotIdGameName ?? null,
		riotIdTagLine: participant.riotIdTagline ?? null,
		championId: participant.championId ?? 0,
		championName: participant.championName,
		teamId: participant.teamId ?? null,
		teamPosition: participant.teamPosition ?? null,
		individualPosition: participant.individualPosition ?? null,
		win: participant.win,
		kills: participant.kills,
		deaths: participant.deaths,
		assists: participant.assists,
		champLevel: participant.champLevel ?? null,
		totalDamageDealtToChampions: participant.totalDamageDealtToChampions ?? null,
		visionScore: participant.visionScore ?? null,
		item0: participant.item0 ?? null,
		item1: participant.item1 ?? null,
		item2: participant.item2 ?? null,
		item3: participant.item3 ?? null,
		item4: participant.item4 ?? null,
		item5: participant.item5 ?? null,
		item6: participant.item6 ?? null,
		placement: participant.placement ?? null,
		// 0 = the mode has no summoner spells (e.g. Arena); keeps the column from staying null and triggering re-fetches.
		summoner1Id: participant.summoner1Id ?? 0,
		summoner2Id: participant.summoner2Id ?? 0,
		totalMinionsKilled: participant.totalMinionsKilled ?? null,
		neutralMinionsKilled: participant.neutralMinionsKilled ?? null,
		goldEarned: participant.goldEarned ?? null,
		totalDamageTaken: participant.totalDamageTaken ?? null,
		totalHeal: participant.totalHeal ?? null,
		wardsPlaced: participant.wardsPlaced ?? null,
		wardsKilled: participant.wardsKilled ?? null,
		baronKills: participant.baronKills ?? null,
		dragonKills: participant.dragonKills ?? null
	};
}
