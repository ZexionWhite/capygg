import { container } from '@sapphire/framework';
import type { Guild } from 'discord.js';
import type { VerificationChallenge } from '../../generated/prisma/client';
import { QUEUES, VERIFICATION } from '../constants';
import { buildVerificationFailedMessage, buildVerificationSuccessMessage } from '../embeds/verification';
import { riotClient } from '../riot/client';
import { riotErrorMessage } from '../riot/messages';
import { isEloTier, isRegion } from '../types';
import type { Region } from '../types';
import { noticeMessage, v2 } from '../ui';

let timer: NodeJS.Timeout | null = null;
let running = false;

/** Inicia el revisor de verificaciones pendientes. Es seguro llamarlo más de una vez. */
export function startVerificationWorker(): void {
	if (timer) return;
	timer = setInterval(() => void runVerificationCycle(), VERIFICATION.pollIntervalMs);
	void runVerificationCycle();
}

async function runVerificationCycle(): Promise<void> {
	if (running) return;
	running = true;

	try {
		const now = new Date();
		await container.prisma.verificationChallenge.deleteMany({ where: { startedAt: null, expiresAt: { lt: now } } });

		const due = await container.prisma.verificationChallenge.findMany({
			where: { startedAt: { not: null }, nextCheckAt: { lte: now } },
			orderBy: { nextCheckAt: 'asc' }
		});

		for (const challenge of due) {
			try {
				await processChallenge(challenge);
			} catch (error) {
				container.logger.error(error);
			}
		}
	} catch (error) {
		container.logger.error(error);
	} finally {
		running = false;
	}
}

async function processChallenge(challenge: VerificationChallenge): Promise<void> {
	if (!isRegion(challenge.region)) {
		await container.prisma.verificationChallenge.delete({ where: { id: challenge.id } });
		await notifyFailure(challenge, 'El desafío tenía una región inválida.');
		return;
	}
	const region: Region = challenge.region;

	let lastError: unknown = null;
	let summoner: Awaited<ReturnType<typeof riotClient.getSummonerByPuuid>> | null = null;
	try {
		summoner = await riotClient.getSummonerByPuuid(challenge.puuid, region);
	} catch (error) {
		container.logger.error(error);
		lastError = error;
	}

	if (summoner && summoner.profileIconId === challenge.requiredIconId) {
		await completeVerification(challenge, region, summoner.profileIconId, summoner.summonerLevel);
		return;
	}

	const attempts = challenge.attempts + 1;
	if (attempts < VERIFICATION.maxAttempts) {
		await container.prisma.verificationChallenge.update({
			where: { id: challenge.id },
			data: { attempts, nextCheckAt: new Date(Date.now() + VERIFICATION.checkDelayMs) }
		});
		return;
	}

	await container.prisma.verificationChallenge.delete({ where: { id: challenge.id } });
	const reason = lastError
		? riotErrorMessage(lastError)
		: `Después de ${(VERIFICATION.checkDelayMs * VERIFICATION.maxAttempts) / 60_000} minutos todavía veo otro icono en tu cuenta. Revisá que hayas puesto el icono pedido y volvé a intentarlo.`;
	await notifyFailure(challenge, reason);
}

async function completeVerification(challenge: VerificationChallenge, region: Region, iconId: number, summonerLevel: number): Promise<void> {
	const linkedAccount = await container.prisma.riotAccount.findUnique({ where: { puuid: challenge.puuid } });
	if (linkedAccount && linkedAccount.discordId !== challenge.discordId) {
		await container.prisma.verificationChallenge.delete({ where: { id: challenge.id } });
		await notifyFailure(challenge, 'Esta cuenta de Riot ya está vinculada a otro usuario de Discord.');
		return;
	}

	const existingAccount = await container.prisma.riotAccount.findUnique({ where: { discordId: challenge.discordId } });
	if (existingAccount) {
		await container.prisma.verificationChallenge.delete({ where: { id: challenge.id } });
		await notifyFailure(
			challenge,
			`Ya tenés vinculada la cuenta **${existingAccount.gameName}#${existingAccount.tagLine}**. Usá \`/unlink\` si querés cambiarla.`
		);
		return;
	}

	let soloTier: string | null = null;
	try {
		const entries = await riotClient.getLeagueEntriesByPuuid(challenge.puuid, region);
		soloTier = entries.find((entry) => entry.queueType === QUEUES.SOLO)?.tier ?? null;
	} catch (error) {
		container.logger.error(error);
	}

	await container.prisma.riotAccount.create({
		data: {
			puuid: challenge.puuid,
			discordId: challenge.discordId,
			gameName: challenge.gameName,
			tagLine: challenge.tagLine,
			region,
			profileIconId: iconId,
			summonerLevel
		}
	});
	await container.prisma.verificationChallenge.delete({ where: { id: challenge.id } });

	const guild = await fetchGuild(challenge.guildId);
	const roleAssigned = guild ? await assignStoredRole(guild, challenge.discordId, region) : false;
	const eloRole =
		soloTier && isEloTier(soloTier)
			? { tier: soloTier, assigned: guild ? await assignStoredRole(guild, challenge.discordId, soloTier) : false }
			: null;

	await sendToUser(
		challenge,
		v2(
			buildVerificationSuccessMessage({
				guildId: challenge.guildId,
				guildName: guild?.name ?? 'el servidor',
				gameName: challenge.gameName,
				tagLine: challenge.tagLine,
				region,
				iconId,
				summonerLevel,
				roleAssigned,
				eloRole
			})
		)
	);
}

async function notifyFailure(challenge: VerificationChallenge, reason: string): Promise<void> {
	const guild = await fetchGuild(challenge.guildId);
	await sendToUser(challenge, v2(buildVerificationFailedMessage(challenge.guildId, guild?.name ?? 'el servidor', reason)));
}

/** Envía el resultado por DM. Si el usuario tiene los DMs cerrados, deja un aviso corto en el canal de verificación. */
async function sendToUser(challenge: VerificationChallenge, message: ReturnType<typeof v2>): Promise<void> {
	try {
		const user = await container.client.users.fetch(challenge.discordId);
		await user.send(message);
		return;
	} catch (error) {
		container.logger.warn(`No pude enviar el DM de verificación a ${challenge.discordId}: ${String(error)}`);
	}

	try {
		const guildConfig = await container.prisma.guild.findUnique({ where: { id: challenge.guildId } });
		const guild = await fetchGuild(challenge.guildId);
		if (!guild || !guildConfig?.verifyChannelId) return;
		const channel = await guild.channels.fetch(guildConfig.verifyChannelId);
		if (!channel?.isSendable()) return;

		const fallback = await channel.send({
			...noticeMessage(
				'warning',
				`<@${challenge.discordId}> terminó tu verificación, pero no pude enviarte el resultado por mensaje directo. Revisá tus roles o usá \`/profile\`; si no quedó vinculada, repetí el proceso desde este panel.`
			),
			allowedMentions: { users: [challenge.discordId] }
		});
		setTimeout(() => void fallback.delete().catch(() => null), 2 * 60 * 1_000);
	} catch (error) {
		container.logger.error(error);
	}
}

async function fetchGuild(guildId: string): Promise<Guild | null> {
	try {
		return await container.client.guilds.fetch(guildId);
	} catch (error) {
		container.logger.error(error);
		return null;
	}
}

async function assignStoredRole(guild: Guild, discordId: string, key: string): Promise<boolean> {
	try {
		const storedRole = await container.prisma.guildRole.findUnique({ where: { guildId_key: { guildId: guild.id, key } } });
		if (!storedRole) return false;
		const role = await guild.roles.fetch(storedRole.roleId);
		if (!role) return false;
		const member = await guild.members.fetch(discordId);
		await member.roles.add(role);
		return true;
	} catch (error) {
		container.logger.error(error);
		return false;
	}
}