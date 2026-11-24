import { ApplyOptions } from '@sapphire/decorators';
import { InteractionHandler, InteractionHandlerTypes } from '@sapphire/framework';
import { ActionRowBuilder, MessageFlags, ModalSubmitInteraction, StringSelectMenuBuilder } from 'discord.js';
import { FORM_FIELD_IDS, INTERACTION_IDS, PROFILE_ICON_CANDIDATES, REGIONS, VERIFICATION } from '../lib/constants';
import { buildChallengeMessage } from '../lib/embeds/verification';
import { RiotApiError, riotClient } from '../lib/riot/client';
import { riotErrorMessage } from '../lib/riot/messages';
import { InvalidRiotIdError, parseRiotId } from '../lib/riot/riot-id';
import { isRegion } from '../lib/types';
import type { Region } from '../lib/types';
import { noticeMessage, v2 } from '../lib/ui';

@ApplyOptions<InteractionHandler.Options>({
	interactionHandlerType: InteractionHandlerTypes.ModalSubmit
})
export class VerifyAccountSubmitHandler extends InteractionHandler {
	public override parse(interaction: ModalSubmitInteraction) {
		return interaction.customId === INTERACTION_IDS.verifyAccountModal ? this.some() : this.none();
	}

	public override async run(interaction: ModalSubmitInteraction) {
		await interaction.deferReply({ flags: MessageFlags.Ephemeral });

		try {
			if (!interaction.guildId)
				return interaction.editReply(noticeMessage('error', 'La verificación solo puede ejecutarse dentro de un servidor.'));
			const { gameName, tagLine } = parseRiotId(interaction.fields.getTextInputValue(FORM_FIELD_IDS.riotId));
			const regionValue = interaction.fields.getTextInputValue(FORM_FIELD_IDS.region).trim().toUpperCase();
			if (!isRegion(regionValue)) {
				return interaction.editReply(noticeMessage('error', `Región inválida. Usá una de estas: ${Object.keys(REGIONS).join(', ')}.`));
			}
			const region: Region = regionValue;
			const account = await riotClient.getAccountByRiotId(gameName, tagLine, region, 'critical');
			const summoner = await riotClient.getSummonerByPuuid(account.puuid, region, 'critical');

			const linkedAccount = await this.container.prisma.riotAccount.findUnique({ where: { puuid: account.puuid } });
			if (linkedAccount && linkedAccount.discordId !== interaction.user.id) {
				return interaction.editReply(noticeMessage('error', 'Esta cuenta de Riot ya está vinculada a otro usuario de Discord.'));
			}

			const requiredIconId = this.chooseIcon(summoner.profileIconId);
			const expiresAt = new Date(Date.now() + VERIFICATION.challengeTtlMs);
			await this.container.prisma.verificationChallenge.deleteMany({ where: { discordId: interaction.user.id } });
			const challenge = await this.container.prisma.verificationChallenge.create({
				data: {
					discordId: interaction.user.id,
					guildId: interaction.guildId,
					puuid: account.puuid,
					gameName: account.gameName,
					tagLine: account.tagLine,
					region,
					requiredIconId,
					expiresAt
				}
			});

			const queueSelect = new StringSelectMenuBuilder()
				.setCustomId(INTERACTION_IDS.verifyQueues)
				.setPlaceholder('Elegí las colas que jugás')
				.setMinValues(1)
				.setMaxValues(4)
				.addOptions(
					{ label: 'SoloQ', value: 'SOLO' },
					{ label: 'Flex', value: 'FLEX' },
					{ label: 'Normals', value: 'NORMALS' },
					{ label: 'ARAM (incluye Mayhem)', value: 'ARAM' }
				);
			await interaction.editReply(v2(buildChallengeMessage(challenge.id, account.gameName, account.tagLine, requiredIconId, expiresAt)));
			return interaction.followUp({
				content: '**¿Qué jugás?** Elegí todas las colas que correspondan. Podés seleccionar las cuatro.',
				components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(queueSelect)],
				flags: MessageFlags.Ephemeral
			});
		} catch (error) {
			this.container.logger.error(error);
			if (error instanceof InvalidRiotIdError) {
				return interaction.editReply(
					noticeMessage('error', 'El Riot ID debe tener el formato `Nombre#TAG` y respetar los límites de longitud.')
				);
			}
			if (error instanceof RiotApiError) return interaction.editReply(noticeMessage('error', riotErrorMessage(error)));
			return interaction.editReply(noticeMessage('error', 'No pude crear el desafío de verificación. Intentá nuevamente más tarde.'));
		}
	}

	private chooseIcon(currentIconId: number): number {
		const available = PROFILE_ICON_CANDIDATES.filter((iconId) => iconId !== currentIconId);
		return available[Math.floor(Math.random() * available.length)] ?? PROFILE_ICON_CANDIDATES[0];
	}
}