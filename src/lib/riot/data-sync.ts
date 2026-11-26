
import { container } from '@sapphire/framework';
import { createLogger } from '../logger.js';
import type { RiotAccount } from '../../generated/prisma/client.js';
import { isRegion } from '../types/index.js';
import type { Region } from '../types/index.js';
import type { RiotChampionMastery, RiotMatchParticipant } from '../types/riot.js';
import { RiotApiError, riotClient } from './client.js';
import { getQueueLabel } from './queue-labels.js';
import type { RiotRequestPriority } from './request-queue.js';

const logger = createLogger('riot.data-sync');
const MASTERY_TTL_MS = 6 * 60 * 60 * 1_000;
const MATCH_TTL_MS = 10 * 60 * 1_000;
const INITIAL_MATCH_BACKFILL_COUNT = 20;
const REGULAR_MATCH_SYNC_COUNT = 10;

/** How many matches (counting every game mode) each account gets in its deep history backfill. */
export const MATCH_BACKFILL_TARGET = 500;
const BACKFILL_PAGE_SIZE = 25;
/** Time budget of one backfill run; the job runs every few minutes. */
const BACKFILL_RUN_BUDGET_MS = 4 * 60 * 1_000;
/** Pacing: 2 s per Riot request (~30/min) so the backfill never uses the whole key and commands stay responsive. */
const BACKFILL_MS_PER_REQUEST = 2_000;

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

type MatchOutcome = 'stored' | 'completed' | 'present' | 'missing';

/**
 * Fetches one match and stores it with all its participants.
 * - `present`: already stored (no Riot request needed).
 * - `completed`: was stored before spells/CS were saved; now filled in.
 * - `missing`: Riot lists the id but the match no longer exists (404). It is skipped, not an error.
 */
async function ingestMatch(
	account: RiotAccount,
	region: Region,
	matchId: string,
	priority: RiotRequestPriority
): Promise<MatchOutcome> {
	const existing = await container.prisma.matchRecord.findUnique({
		where: { matchId },
		select: {
			participants: { where: { puuid: account.puuid }, select: { summoner1Id: true } }
		}
	});

	// Matches stored before summoner spells and CS were saved are fetched once more to complete them.
	if (existing && existing.participants[0]?.summoner1Id != null) {
		return 'present';
	}

	let details: Awaited<ReturnType<typeof riotClient.getMatchDetails>>;
	try {
		details = await riotClient.getMatchDetails(matchId, region, priority);
	} catch (error) {
		if (error instanceof RiotApiError && error.kind === 'NOT_FOUND') {
			return 'missing';
		}
		throw error;
	}

	// Riot assigns the literal PUUID "BOT" to bot participants.
	// Since every bot shares that identifier, they cannot be
	// represented individually with the current database constraint.
	const botParticipants = details.participants.filter((participant) => participant.puuid === 'BOT');
	const realParticipants = details.participants.filter((participant) => participant.puuid !== 'BOT');

	if (botParticipants.length > 0) {
		logger.debug(`Skipping ${botParticipants.length} bot participants in match ${matchId}.`);
	}

	const participantIds = realParticipants.map((participant) => participant.puuid);
	const uniqueParticipantIds = new Set(participantIds);

	if (uniqueParticipantIds.size !== participantIds.length) {
		logger.warn(`Duplicate player PUUIDs in match ${matchId}: ${participantIds.length - uniqueParticipantIds.size} duplicates.`);
	}

	const participantsByPuuid = new Map(realParticipants.map((participant) => [participant.puuid, participant]));
	const wasCreated = await persistMatch(details, account.region, [...participantsByPuuid.values()]);

	return wasCreated ? 'stored' : 'completed';
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
				if ((await ingestMatch(account, region, matchId, priority)) === 'stored') {
					stored++;
				}
			} catch (error) {
				matchErrors++;
				logger.warn(`Could not persist match ${matchId} (${account.gameName}#${account.tagLine}).`, error);
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
		logger.warn(`Match history sync failed for ${account.gameName}#${account.tagLine}.`, error);
	}

	return { stored, errors: matchErrors };
}

/* -------------------------------------------------------------------------- */
/*  Deep history backfill                                                      */
/* -------------------------------------------------------------------------- */

export interface BackfillPageResult {
	/** The account with its updated progress. */
	account: RiotAccount;
	stored: number;
	errors: number;
	/** Riot requests made by this page (the match list plus every match detail). */
	requests: number;
	/** True when the account reached the target or the end of its history. */
	done: boolean;
	/** True when the page was not processed (a regular sync of the same account is running). */
	skipped: boolean;
}

/**
 * Processes ONE page of an account's deep history, starting where the previous page stopped.
 * Progress lives in `matchHistoryBackfillOffset`; `matchHistoryBackfillComplete` marks the end, either because the
 * target was reached or because Riot returned fewer ids than requested (accounts with a shorter history).
 * New games shift the history, so pages may overlap; already stored matches are skipped without a Riot request.
 */
export async function backfillAccountMatches(
	account: RiotAccount,
	region: Region,
	priority: RiotRequestPriority = 'background'
): Promise<BackfillPageResult> {
	const idle = (overrides: Partial<BackfillPageResult> = {}): BackfillPageResult => ({
		account,
		stored: 0,
		errors: 0,
		requests: 0,
		done: account.matchHistoryBackfillComplete,
		skipped: false,
		...overrides
	});

	if (account.matchHistoryBackfillComplete) return idle();
	if (inFlightMatchSync.has(account.puuid)) return idle({ skipped: true });

	const offset = account.matchHistoryBackfillOffset;
	const pageSize = Math.min(BACKFILL_PAGE_SIZE, MATCH_BACKFILL_TARGET - offset);

	if (pageSize <= 0) {
		const finished = await markBackfillFinished(account, offset);
		return idle({ account: finished, done: true });
	}

	let ids: string[];
	try {
		ids = await riotClient.getMatchIdsByPuuid(account.puuid, region, pageSize, priority, offset);
	} catch (error) {
		logger.warn(`Backfill: could not list matches for ${account.gameName}#${account.tagLine} (offset ${offset}).`, error);
		return idle({ errors: 1, requests: 1 });
	}

	let stored = 0;
	let errors = 0;
	let requests = 1;

	for (const matchId of ids) {
		try {
			const outcome = await ingestMatch(account, region, matchId, priority);
			if (outcome !== 'present') requests++;
			if (outcome === 'stored') stored++;
		} catch (error) {
			errors++;
			requests++;
			logger.warn(`Backfill: could not persist match ${matchId} (${account.gameName}#${account.tagLine}).`, error);
		}
	}

	// If the whole page failed (outage, rate limit) progress is kept as is and the page is retried on the next run.
	if (ids.length > 0 && errors === ids.length) {
		return idle({ errors, requests });
	}

	const nextOffset = offset + ids.length;
	const done = ids.length < pageSize || nextOffset >= MATCH_BACKFILL_TARGET;
	const updated = done
		? await markBackfillFinished(account, nextOffset)
		: await container.prisma.riotAccount.update({
				where: { puuid: account.puuid },
				data: { matchHistoryBackfillOffset: nextOffset }
			});

	return { account: updated, stored, errors, requests, done, skipped: false };
}

function markBackfillFinished(account: RiotAccount, offset: number): Promise<RiotAccount> {
	return container.prisma.riotAccount.update({
		where: { puuid: account.puuid },
		data: {
			matchHistoryBackfillOffset: offset,
			matchHistoryBackfillComplete: true,
			matchHistoryBackfilledAt: account.matchHistoryBackfilledAt ?? new Date()
		}
	});
}

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * Backfill job: walks the accounts that still have history to fetch, one page each in turn (least progress first, so a
 * newly linked player starts right away), until the run budget is spent. Paced to leave room for interactive requests.
 */
export async function syncMatchBackfill(options: { msPerRequest?: number; budgetMs?: number } = {}): Promise<string> {
	const msPerRequest = options.msPerRequest ?? BACKFILL_MS_PER_REQUEST;
	const deadline = Date.now() + (options.budgetMs ?? BACKFILL_RUN_BUDGET_MS);

	const pending = await container.prisma.riotAccount.findMany({
		where: { matchHistoryBackfillComplete: false },
		orderBy: [{ matchHistoryBackfillOffset: 'asc' }, { linkedAt: 'asc' }]
	});
	if (pending.length === 0) return 'Nothing to backfill';

	const queue = [...pending];
	let pages = 0;
	let stored = 0;
	let errors = 0;
	let completed = 0;

	while (queue.length > 0 && Date.now() < deadline) {
		const account = queue.shift()!;

		if (!isRegion(account.region)) {
			logger.warn(`Skipping backfill for ${account.gameName}#${account.tagLine}: invalid region "${account.region}".`);
			continue;
		}

		const startedAt = Date.now();
		const result = await backfillAccountMatches(account, account.region);
		if (result.skipped) continue;

		pages++;
		stored += result.stored;
		errors += result.errors;

		if (result.done) {
			completed++;
			logger.info(
				`Backfill complete for ${account.gameName}#${account.tagLine}: ${result.account.matchHistoryBackfillOffset} matches scanned.`
			);
		} else if (result.account.matchHistoryBackfillOffset > account.matchHistoryBackfillOffset) {
			// Only accounts that made progress go back to the end of the line.
			queue.push(result.account);
		}

		const wait = result.requests * msPerRequest - (Date.now() - startedAt);
		if (wait > 0 && Date.now() + wait < deadline) await sleep(wait);
	}

	return `${stored} matches stored · ${pages} pages · ${completed} accounts completed · ${queue.length} pending · ${errors} errors`;
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
