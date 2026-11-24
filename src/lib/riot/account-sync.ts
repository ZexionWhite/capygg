import { container } from '@sapphire/framework';
import type { RiotAccount } from '../../generated/prisma/client';
import type { Region } from '../types';
import type { RiotSummonerResponse } from '../types/riot';
import { RiotApiError, riotClient } from './client';
import { createLogger } from '../logger';

const logger = createLogger('riot.account-sync');

/**
 * Los PUUID de Riot se cifran por API key: al cambiar de key, los guardados dejan de servir (HTTP 400).
 * Esto vuelve a resolver el PUUID desde el Riot ID guardado y actualiza la base.
 */
export async function refreshStoredPuuid(account: RiotAccount, region: Region): Promise<RiotAccount> {
	const fresh = await riotClient.getAccountByRiotId(account.gameName, account.tagLine, region);
	if (fresh.puuid === account.puuid) return account;

	const taken = await container.prisma.riotAccount.findUnique({ where: { puuid: fresh.puuid } });
	if (taken) throw new RiotApiError('INVALID_PUUID', 'The refreshed PUUID is already stored for another account.');

	return container.prisma.$transaction(async (tx) => {
		await tx.rankSnapshot.updateMany({ where: { puuid: account.puuid }, data: { puuid: fresh.puuid } });
		await tx.matchParticipant.updateMany({ where: { puuid: account.puuid }, data: { puuid: fresh.puuid } });
		await tx.otpOverride.updateMany({ where: { puuid: account.puuid }, data: { puuid: fresh.puuid } });
		return tx.riotAccount.update({
			where: { puuid: account.puuid },
			data: { puuid: fresh.puuid, gameName: fresh.gameName, tagLine: fresh.tagLine }
		});
	});
}

export async function getSummonerRefreshingPuuid(
	account: RiotAccount,
	region: Region
): Promise<{ account: RiotAccount; summoner: RiotSummonerResponse }> {
	try {
		return { account, summoner: await riotClient.getSummonerByPuuid(account.puuid, region) };
	} catch (error) {
		if (!(error instanceof RiotApiError) || error.kind !== 'INVALID_PUUID') throw error;
	}

	const refreshed = await refreshStoredPuuid(account, region);
	logger.info(`PUUID actualizado para ${refreshed.gameName}#${refreshed.tagLine}`);
	return { account: refreshed, summoner: await riotClient.getSummonerByPuuid(refreshed.puuid, region) };
}

const RIOT_ID_SYNC_TTL_MS = 60 * 60 * 1_000;
const lastRiotIdSync = new Map<string, number>();

/** Si la persona cambió su Riot ID, actualiza el nombre guardado. Nunca falla: ante cualquier error devuelve la cuenta tal cual. */
export async function syncRiotId(account: RiotAccount, region: Region): Promise<RiotAccount> {
	const last = lastRiotIdSync.get(account.puuid) ?? 0;
	if (Date.now() - last < RIOT_ID_SYNC_TTL_MS) return account;
	lastRiotIdSync.set(account.puuid, Date.now());

	try {
		const current = await riotClient.getAccountByPuuid(account.puuid, region);
		if (current.gameName === account.gameName && current.tagLine === account.tagLine) return account;

		logger.info(`Riot ID actualizado: ${account.gameName}#${account.tagLine} -> ${current.gameName}#${current.tagLine}`);
		return await container.prisma.riotAccount.update({
			where: { puuid: account.puuid },
			data: { gameName: current.gameName, tagLine: current.tagLine }
		});
	} catch (error) {
		logger.warn(`No pude sincronizar el Riot ID de ${account.gameName}#${account.tagLine}: ${String(error)}`);
		return account;
	}
}