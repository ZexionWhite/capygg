import { ApplyOptions } from '@sapphire/decorators';
import { InteractionHandler, InteractionHandlerTypes } from '@sapphire/framework';
import { ButtonInteraction } from 'discord.js';
import { INTERACTION_IDS, QUEUES } from '../lib/constants';
import { buildVerificationSuccessEmbed } from '../lib/embeds/verification';
import { riotClient } from '../lib/riot/client';
import { riotErrorMessage } from '../lib/riot/messages';
import { isEloTier, isRegion } from '../lib/types';
import type { Region } from '../lib/types';

const pendingChallenges = new Set<number>();
const CHECK_DELAY_MS = 5 * 60 * 1_000;

type VerificationAttemptResult = 'COMPLETED' | 'RETRY' | 'STOPPED';

@ApplyOptions<InteractionHandler.Options>({
	interactionHandlerType: InteractionHandlerTypes.Button
})
export class VerifyCheckHandler extends InteractionHandler {
	public override parse(interaction: ButtonInteraction) {
		if (!interaction.customId.startsWith(INTERACTION_IDS.verifyCheckPrefix)) return this.none();
		const challengeId = Number(interaction.customId.slice(INTERACTION_IDS.verifyCheckPrefix.length));
		return Number.isSafeInteger(challengeId) && challengeId > 0 ? this.some(challengeId) : this.none();
	}

	public override async run(interaction: ButtonInteraction, parsedData: unknown) {
		await interaction.deferReply({ ephemeral: true });

		try {
			const challengeId = typeof parsedData === 'number' ? parsedData : NaN;
			const challenge = await this.container.prisma.verificationChallenge.findUnique({ where: { id: challengeId } });
			if (!challenge || challenge.discordId !== interaction.user.id || challenge.guildId !== interaction.guildId) {
				return interaction.editReply('Este desafío de verificación no existe o no te pertenece.');
			}

			if (challenge.expiresAt.getTime() <= Date.now()) {
				await this.container.prisma.verificationChallenge.delete({ where: { id: challenge.id } });
				return interaction.editReply('El desafío expiró. Iniciá la verificación nuevamente desde el panel.');
			}

			if (pendingChallenges.has(challenge.id)) {
				return interaction.editReply('El proceso ya está en curso. Te avisaré cuando termine la comprobación.');
			}

			pendingChallenges.add(challenge.id);
			await interaction.editReply(
				'El proceso de verificación empezó. Riot puede tardar unos minutos en actualizar el icono; haré una primera comprobación en 5 minutos y otra 5 minutos después.'
			);
			void this.runDelayedVerification(interaction, challenge.id);
			return;
		} catch (error) {
			this.container.logger.error(error);
			return interaction.editReply(riotErrorMessage(error));
		}
	}

	private async runDelayedVerification(interaction: ButtonInteraction, challengeId: number): Promise<void> {
		try {
			await this.wait(CHECK_DELAY_MS);
			if ((await this.attemptVerification(interaction, challengeId)) !== 'RETRY') return;

			await this.safeEditReply(interaction, 'Todavía no veo el icono solicitado. Haré una última comprobación dentro de 5 minutos.');
			await this.wait(CHECK_DELAY_MS);
			if ((await this.attemptVerification(interaction, challengeId)) !== 'RETRY') return;

			await this.container.prisma.verificationChallenge.deleteMany({ where: { id: challengeId } });
			await this.safeEditReply(interaction, 'No pude confirmar el cambio de icono después de 10 minutos. Si ya lo cambiaste, iniciá la verificación nuevamente.');
		} catch (error) {
			this.container.logger.error(error);
			await this.safeEditReply(interaction, 'La verificación no pudo completarse. Intentá nuevamente más tarde.');
		} finally {
			pendingChallenges.delete(challengeId);
		}
	}

	private async attemptVerification(interaction: ButtonInteraction, challengeId: number): Promise<VerificationAttemptResult> {
		const challenge = await this.container.prisma.verificationChallenge.findUnique({ where: { id: challengeId } });
		if (!challenge || challenge.discordId !== interaction.user.id || challenge.guildId !== interaction.guildId) return 'STOPPED';
		if (!isRegion(challenge.region)) {
			await this.container.prisma.verificationChallenge.delete({ where: { id: challenge.id } });
			await this.safeEditReply(interaction, 'El desafío tiene una región inválida. Iniciá la verificación nuevamente.');
			return 'STOPPED';
		}

		const region: Region = challenge.region;
		let summoner;
		try {
			summoner = await riotClient.getSummonerByPuuid(challenge.puuid, region);
		} catch (error) {
			this.container.logger.error(error);
			return 'RETRY';
		}
		if (summoner.profileIconId !== challenge.requiredIconId) return 'RETRY';

		let soloRank;
		try {
			const leagueEntries = await riotClient.getLeagueEntriesByPuuid(challenge.puuid, region);
			soloRank = leagueEntries.find((entry) => entry.queueType === QUEUES.SOLO);
		} catch (error) {
			this.container.logger.error(error);
		}

		const linkedAccount = await this.container.prisma.riotAccount.findUnique({ where: { puuid: challenge.puuid } });
		if (linkedAccount && linkedAccount.discordId !== interaction.user.id) {
			await this.container.prisma.verificationChallenge.delete({ where: { id: challenge.id } });
			await this.safeEditReply(interaction, 'Esta cuenta de Riot ya está vinculada a otro usuario de Discord.');
			return 'STOPPED';
		}

		await this.container.prisma.riotAccount.create({
			data: {
				puuid: challenge.puuid,
				discordId: interaction.user.id,
				gameName: challenge.gameName,
				tagLine: challenge.tagLine,
				region: challenge.region,
				profileIconId: summoner.profileIconId,
				summonerLevel: summoner.summonerLevel
			}
		});
		await this.container.prisma.verificationChallenge.delete({ where: { id: challenge.id } });

		const { roleAssigned, eloRoleAssigned } = await this.assignRoles(interaction, challenge.guildId, challenge.region, soloRank);
		const embed = buildVerificationSuccessEmbed(challenge.region, challenge.gameName, challenge.tagLine);
		if (!roleAssigned) {
			embed.addFields({
				name: 'Rol de región',
				value: 'No se pudo asignar. Un administrador debe ejecutar `/setup` y revisar los permisos del bot.'
			});
		}
		if (soloRank && !eloRoleAssigned) {
			embed.addFields({
				name: 'Rol de elo',
				value: 'No se pudo asignar. Un administrador debe ejecutar `/setup` y revisar los permisos del bot.'
			});
		}

		try {
			await interaction.user.send({ embeds: [embed] });
		} catch (error) {
			this.container.logger.error(error);
		}
		await this.safeEditReply(interaction, { content: 'La cuenta quedó vinculada correctamente. También te envié un mensaje directo.', embeds: [] });
		return 'COMPLETED';
	}

	private async assignRoles(interaction: ButtonInteraction, guildId: string, region: string, soloRank: { tier: string } | undefined) {
		let roleAssigned = false;
		let eloRoleAssigned = false;
		if (!interaction.guild) return { roleAssigned, eloRoleAssigned };

		const regionRole = await this.container.prisma.guildRole.findUnique({
			where: { guildId_key: { guildId, key: region } }
		});
		if (regionRole) {
			try {
				const role = await interaction.guild.roles.fetch(regionRole.roleId);
				if (role) {
					const member = await interaction.guild.members.fetch(interaction.user.id);
					await member.roles.add(role);
					roleAssigned = true;
				}
			} catch (error) {
				this.container.logger.error(error);
			}
		}

		if (soloRank && isEloTier(soloRank.tier)) {
			const eloRole = await this.container.prisma.guildRole.findUnique({
				where: { guildId_key: { guildId, key: soloRank.tier } }
			});
			if (eloRole) {
				try {
					const role = await interaction.guild.roles.fetch(eloRole.roleId);
					if (role) {
						const member = await interaction.guild.members.fetch(interaction.user.id);
						await member.roles.add(role);
						eloRoleAssigned = true;
					}
				} catch (error) {
					this.container.logger.error(error);
				}
			}
		}
		return { roleAssigned, eloRoleAssigned };
	}

	private async safeEditReply(interaction: ButtonInteraction, content: string | { content: string; embeds: [] }): Promise<void> {
		try {
			await interaction.editReply(content);
		} catch (error) {
			this.container.logger.error(error);
		}
	}

	private async wait(milliseconds: number): Promise<void> {
		await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
	}
}
