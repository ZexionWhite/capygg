import { REGIONS } from '../constants';
import type { Region } from '../types';
import type {
	RiotAccountResponse,
	RiotApiErrorKind,
	RiotChampionMastery,
	RiotLeagueEntry,
	RiotMatchDetails,
	RiotMatchSummary,
	RiotSummonerResponse
} from '../types/riot';
import { createLogger } from '../logger';
import { riotRateLimiter, riotRequestQueue } from './request-queue';
import type { RiotRequestPriority } from './request-queue';

const REQUEST_TIMEOUT_MS = 8_000;
const logger = createLogger('riot');
export class RiotApiError extends Error {
	public constructor(
		public readonly kind: RiotApiErrorKind,
		message: string,
		public readonly status?: number
	) {
		super(message);
		this.name = 'RiotApiError';
	}
}

export class RiotClient {
	private readonly apiKey = process.env.RIOT_API_KEY;

	public async getAccountByRiotId(
		gameName: string,
		tagLine: string,
		region: Region,
		priority: RiotRequestPriority = 'normal'
	): Promise<RiotAccountResponse> {
		const route = REGIONS[region].regionalRoute;
		const data = await this.request<unknown>(
			`https://${route}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`,
			priority
		);

		if (!this.isAccountResponse(data)) {
			throw new RiotApiError('UNKNOWN', 'Riot returned an invalid account response.');
		}

		return data;
	}

	public async getAccountByPuuid(puuid: string, region: Region, priority: RiotRequestPriority = 'normal'): Promise<RiotAccountResponse> {
		const route = REGIONS[region].regionalRoute;
		const data = await this.request<unknown>(
			`https://${route}.api.riotgames.com/riot/account/v1/accounts/by-puuid/${encodeURIComponent(puuid)}`,
			priority
		);

		if (!this.isAccountResponse(data)) {
			throw new RiotApiError('UNKNOWN', 'Riot returned an invalid account response.');
		}

		return data;
	}

	public async getSummonerByPuuid(puuid: string, region: Region, priority: RiotRequestPriority = 'normal'): Promise<RiotSummonerResponse> {
		const platform = REGIONS[region].platform;
		const data = await this.request<unknown>(
			`https://${platform}.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${encodeURIComponent(puuid)}`,
			priority
		);

		if (!this.isSummonerResponse(data)) {
			throw new RiotApiError('UNKNOWN', 'Riot returned an invalid summoner response.');
		}

		return data;
	}

	public async getLeagueEntriesByPuuid(puuid: string, region: Region, priority: RiotRequestPriority = 'normal'): Promise<RiotLeagueEntry[]> {
		const platform = REGIONS[region].platform;
		const data = await this.request<unknown>(
			`https://${platform}.api.riotgames.com/lol/league/v4/entries/by-puuid/${encodeURIComponent(puuid)}`,
			priority
		);
		if (!this.isLeagueEntriesResponse(data)) throw new RiotApiError('UNKNOWN', 'Riot returned an invalid League response.');
		return data;
	}

	public async getTftLeagueEntriesByPuuid(puuid: string, region: Region, priority: RiotRequestPriority = 'normal'): Promise<RiotLeagueEntry[]> {
		const platform = REGIONS[region].platform;
		const data = await this.request<unknown>(
			`https://${platform}.api.riotgames.com/tft/league/v1/by-puuid/${encodeURIComponent(puuid)}`,
			priority
		);
		if (!this.isLeagueEntriesResponse(data)) throw new RiotApiError('UNKNOWN', 'Riot returned an invalid TFT response.');
		return data;
	}

	public async getChampionMasteriesByPuuid(
		puuid: string,
		region: Region,
		priority: RiotRequestPriority = 'normal'
	): Promise<RiotChampionMastery[]> {
		const platform = REGIONS[region].platform;
		const data = await this.request<unknown>(
			`https://${platform}.api.riotgames.com/lol/champion-mastery/v4/champion-masteries/by-puuid/${encodeURIComponent(puuid)}`,
			priority
		);
		if (!this.isChampionMasteriesResponse(data)) throw new RiotApiError('UNKNOWN', 'Riot returned an invalid champion mastery response.');
		return data;
	}

	public async getMatchIdsByPuuid(
		puuid: string,
		region: Region,
		count = 5,
		priority: RiotRequestPriority = 'normal',
		start = 0
	): Promise<string[]> {
		const route = REGIONS[region].regionalRoute;
		const data = await this.request<unknown>(
			`https://${route}.api.riotgames.com/lol/match/v5/matches/by-puuid/${encodeURIComponent(puuid)}/ids?start=${Math.max(0, Math.floor(start))}&count=${Math.min(100, Math.max(0, Math.floor(count)))}`,
			priority
		);
		if (!Array.isArray(data) || !data.every((value): value is string => typeof value === 'string')) {
			throw new RiotApiError('UNKNOWN', 'Riot returned an invalid match list.');
		}
		return data;
	}

	public async getMatchById(matchId: string, puuid: string, region: Region, priority: RiotRequestPriority = 'normal'): Promise<RiotMatchSummary> {
		const route = REGIONS[region].regionalRoute;
		const data = await this.request<unknown>(`https://${route}.api.riotgames.com/lol/match/v5/matches/${encodeURIComponent(matchId)}`, priority);
		if (!this.isMatchResponse(data)) throw new RiotApiError('UNKNOWN', 'Riot returned an invalid match response.');

		const participant = data.info.participants.find((value) => value.puuid === puuid);
		if (!participant) throw new RiotApiError('UNKNOWN', 'Riot match did not contain the requested player.');

		return {
			matchId: data.metadata.matchId,
			queueId: data.info.queueId,
			gameMode: data.info.gameMode,
			gameStartTimestamp: data.info.gameStartTimestamp,
			gameDuration: data.info.gameDuration,
			participant
		};
	}

	/** Fetches the complete Match-V5 payload, including every participant. */
	public async getMatchDetails(matchId: string, region: Region, priority: RiotRequestPriority = 'normal'): Promise<RiotMatchDetails> {
		const route = REGIONS[region].regionalRoute;
		const data = await this.request<unknown>(`https://${route}.api.riotgames.com/lol/match/v5/matches/${encodeURIComponent(matchId)}`, priority);
		if (!this.isMatchResponse(data)) throw new RiotApiError('UNKNOWN', 'Riot returned an invalid match response.');
		const info = data.info as typeof data.info & { gameType?: string; mapId?: number; gameVersion?: string };
		return {
			matchId: data.metadata.matchId,
			queueId: info.queueId,
			gameMode: info.gameMode,
			gameType: info.gameType,
			mapId: info.mapId,
			gameStartTimestamp: info.gameStartTimestamp,
			gameDuration: info.gameDuration,
			gameVersion: info.gameVersion,
			participants: info.participants
		};
	}

	public async getTftMatchIdsByPuuid(puuid: string, region: Region, count = 5, priority: RiotRequestPriority = 'normal'): Promise<string[]> {
		const route = REGIONS[region].regionalRoute;
		const data = await this.request<unknown>(
			`https://${route}.api.riotgames.com/tft/match/v1/matches/by-puuid/${encodeURIComponent(puuid)}/ids?start=0&count=${count}`,
			priority
		);
		if (!Array.isArray(data) || !data.every((value): value is string => typeof value === 'string')) {
			throw new RiotApiError('UNKNOWN', 'Riot returned an invalid TFT match list.');
		}
		return data;
	}

	public async getTftMatchById(
		matchId: string,
		puuid: string,
		region: Region,
		priority: RiotRequestPriority = 'normal'
	): Promise<RiotMatchSummary> {
		const route = REGIONS[region].regionalRoute;
		const data = await this.request<unknown>(`https://${route}.api.riotgames.com/tft/match/v1/matches/${encodeURIComponent(matchId)}`, priority);
		if (!this.isTftMatchResponse(data)) throw new RiotApiError('UNKNOWN', 'Riot returned an invalid TFT match response.');

		const participant = data.info.participants.find((value) => value.puuid === puuid);
		if (!participant) throw new RiotApiError('UNKNOWN', 'TFT match did not contain the requested player.');

		return {
			matchId: data.metadata.matchId,
			queueId: data.info.queueId,
			gameMode: data.info.tftGameType,
			gameStartTimestamp: data.info.gameDatetime,
			gameDuration: data.info.gameLength,
			participant: {
				puuid: participant.puuid,
				championName: '',
				win: participant.placement === 1,
				kills: 0,
				deaths: 0,
				assists: 0,
				placement: participant.placement,
				isTft: true
			}
		};
	}

	private async request<T>(url: string, priority: RiotRequestPriority = 'normal'): Promise<T> {
		if (!this.apiKey) {
			throw new RiotApiError('KEY_INVALID_OR_EXPIRED', 'RIOT_API_KEY is not configured.', 401);
		}
		const apiKey = this.apiKey;

		const endpoint = this.endpointLabel(url);
		const rateLimitRegion = new URL(url).hostname;

		return riotRequestQueue.enqueue(priority, async () => {
			for (let attempt = 0; attempt < 2; attempt++) {
				await riotRateLimiter.waitUntilAllowed(rateLimitRegion, endpoint);
				const startedAt = Date.now();

				try {
					const controller = new AbortController();
					const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
					let response: Response;

					try {
						response = await fetch(url, {
							headers: { 'X-Riot-Token': apiKey },
							signal: controller.signal
						});
					} finally {
						clearTimeout(timeout);
					}

					const duration = Date.now() - startedAt;
					riotRateLimiter.observeResponse(rateLimitRegion, endpoint, response, startedAt);

					if (response.status === 429) {
						const retryAfter = riotRateLimiter.getRetryAfterMs(response);
						logger.warn(`GET ${endpoint} -> HTTP 429 (${duration}ms)${attempt === 0 ? ' · retrying after cooldown' : ''}.`);
						await response.body?.cancel().catch(() => undefined);
						if (attempt === 0) continue;
						throw new RiotApiError(
							'RATE_LIMITED',
							`Riot API rate limit reached${retryAfter === null ? '' : ` (retry after ${Math.ceil(retryAfter / 1_000)}s)`}.`,
							429
						);
					}

					logger.debug(`GET ${endpoint} -> HTTP ${response.status} (${duration}ms).`);
					if (response.ok) return (await response.json()) as T;

					if (response.status >= 500 && attempt === 0) {
						await new Promise((resolve) => setTimeout(resolve, 1_000));
						continue;
					}

					const body = await response.text().catch(() => '');
					throw this.errorForStatus(response.status, body);
				} catch (error) {
					if (error instanceof RiotApiError) throw error;
					const duration = Date.now() - startedAt;

					if (error instanceof DOMException && error.name === 'AbortError') {
						logger.warn(`GET ${endpoint} timed out after ${duration}ms.`);
						throw new RiotApiError('UNAVAILABLE', 'Riot request timed out.');
					}

					logger.warn(`GET ${endpoint} failed after ${duration}ms: ${String(error)}`);
					throw new RiotApiError('UNAVAILABLE', 'Riot could not be reached.');
				}
			}

			throw new RiotApiError('UNAVAILABLE', 'Riot request failed after retry.');
		});
	}

	/** Removes player identifiers from request paths before writing them to logs. */
	private endpointLabel(url: string): string {
		return new URL(url).pathname
			.replace(/\/by-riot-id\/[^/]+\/[^/]+/i, '/by-riot-id/:gameName/:tagLine')
			.replace(/\/by-puuid\/[^/]+/i, '/by-puuid/:puuid')
			.replace(/\/matches\/[^/]+/i, '/matches/:matchId');
	}

	private errorForStatus(status: number, body = ''): RiotApiError {
		if (status === 400 && /decrypt/i.test(body)) {
			return new RiotApiError('INVALID_PUUID', 'Riot could not decrypt the PUUID (it was issued for another API key).', status);
		}
		if (status === 401 || status === 403) return new RiotApiError('KEY_INVALID_OR_EXPIRED', 'Riot API key rejected.', status);
		if (status === 404) return new RiotApiError('NOT_FOUND', 'Riot account was not found.', status);
		if (status === 429) return new RiotApiError('RATE_LIMITED', 'Riot API rate limit reached.', status);
		if (status >= 500) return new RiotApiError('UNAVAILABLE', 'Riot API is unavailable.', status);
		return new RiotApiError('UNKNOWN', `Riot API returned HTTP ${status}.${body ? ` Body: ${body.slice(0, 200)}` : ''}`, status);
	}

	private isAccountResponse(data: unknown): data is RiotAccountResponse {
		if (!data || typeof data !== 'object') return false;
		const value = data as Record<string, unknown>;
		return typeof value.puuid === 'string' && typeof value.gameName === 'string' && typeof value.tagLine === 'string';
	}

	private isSummonerResponse(data: unknown): data is RiotSummonerResponse {
		if (!data || typeof data !== 'object') return false;
		const value = data as Record<string, unknown>;
		return typeof value.puuid === 'string' && typeof value.profileIconId === 'number' && typeof value.summonerLevel === 'number';
	}

	private isLeagueEntriesResponse(data: unknown): data is RiotLeagueEntry[] {
		return (
			Array.isArray(data) &&
			data.every((entry) => {
				if (!entry || typeof entry !== 'object') return false;
				const value = entry as Record<string, unknown>;
				return (
					typeof value.queueType === 'string' &&
					typeof value.tier === 'string' &&
					typeof value.rank === 'string' &&
					typeof value.leaguePoints === 'number' &&
					typeof value.wins === 'number' &&
					typeof value.losses === 'number'
				);
			})
		);
	}

	private isChampionMasteriesResponse(data: unknown): data is RiotChampionMastery[] {
		return (
			Array.isArray(data) &&
			data.every((entry) => {
				if (!entry || typeof entry !== 'object') return false;

				const value = entry as Record<string, unknown>;

				return (
					typeof value.puuid === 'string' &&
					typeof value.championId === 'number' &&
					typeof value.championLevel === 'number' &&
					typeof value.championPoints === 'number' &&
					typeof value.lastPlayTime === 'number' &&
					typeof value.championPointsSinceLastLevel === 'number' &&
					typeof value.championPointsUntilNextLevel === 'number' &&
					typeof value.tokensEarned === 'number' &&
					(value.chestGranted === undefined || value.chestGranted === null || typeof value.chestGranted === 'boolean')
				);
			})
		);
	}

	private isMatchResponse(data: unknown): data is {
		metadata: { matchId: string; participants: string[] };
		info: {
			queueId: number;
			gameMode: string;
			gameStartTimestamp: number;
			gameDuration: number;
			gameType?: string;
			mapId?: number;
			gameVersion?: string;
			participants: RiotMatchSummary['participant'][];
		};
	} {
		if (!data || typeof data !== 'object') return false;
		const value = data as Record<string, unknown>;
		const metadata = value.metadata;
		const info = value.info;
		if (!metadata || typeof metadata !== 'object' || !info || typeof info !== 'object') return false;
		const metadataValue = metadata as Record<string, unknown>;
		const infoValue = info as Record<string, unknown>;
		const participants = infoValue.participants;
		return (
			typeof metadataValue.matchId === 'string' &&
			Array.isArray(metadataValue.participants) &&
			metadataValue.participants.every((puuid): puuid is string => typeof puuid === 'string') &&
			typeof infoValue.queueId === 'number' &&
			typeof infoValue.gameMode === 'string' &&
			typeof infoValue.gameStartTimestamp === 'number' &&
			typeof infoValue.gameDuration === 'number' &&
			Array.isArray(participants) &&
			participants.every((participant) => this.isMatchParticipant(participant))
		);
	}

	private isMatchParticipant(data: unknown): data is RiotMatchSummary['participant'] {
		if (!data || typeof data !== 'object') return false;
		const value = data as Record<string, unknown>;
		return (
			typeof value.puuid === 'string' &&
			typeof value.championName === 'string' &&
			typeof value.win === 'boolean' &&
			typeof value.kills === 'number' &&
			typeof value.deaths === 'number' &&
			typeof value.assists === 'number'
		);
	}

	private isTftMatchResponse(data: unknown): data is {
		metadata: { matchId: string };
		info: {
			queueId: number;
			tftGameType: string;
			gameDatetime: number;
			gameLength: number;
			participants: Array<{ puuid: string; placement: number }>;
		};
	} {
		if (!data || typeof data !== 'object') return false;
		const value = data as Record<string, unknown>;
		const metadata = value.metadata;
		const info = value.info;
		if (!metadata || typeof metadata !== 'object' || !info || typeof info !== 'object') return false;
		const metadataValue = metadata as Record<string, unknown>;
		const infoValue = info as Record<string, unknown>;
		const participants = infoValue.participants;
		return (
			typeof metadataValue.matchId === 'string' &&
			typeof infoValue.queueId === 'number' &&
			typeof infoValue.tftGameType === 'string' &&
			typeof infoValue.gameDatetime === 'number' &&
			typeof infoValue.gameLength === 'number' &&
			Array.isArray(participants) &&
			participants.every((participant) => {
				if (!participant || typeof participant !== 'object') return false;
				const participantValue = participant as Record<string, unknown>;
				return typeof participantValue.puuid === 'string' && typeof participantValue.placement === 'number';
			})
		);
	}
}

export const riotClient = new RiotClient();
