import { ApplyOptions } from '@sapphire/decorators';
import { InteractionHandler, InteractionHandlerTypes } from '@sapphire/framework';
import { ActionRowBuilder, ButtonInteraction, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { FORM_FIELD_IDS, INTERACTION_IDS } from '../lib/constants';
import { buildAlreadyLinkedMessage, buildVerificationInProgressMessage } from '../lib/embeds/verification';
import { ephemeralNoticeMessage, ephemeralV2 } from '../lib/ui';

@ApplyOptions<InteractionHandler.Options>({
	interactionHandlerType: InteractionHandlerTypes.Button
})
export class VerifyStartHandler extends InteractionHandler {
	public override parse(interaction: ButtonInteraction) {
		return interaction.customId === INTERACTION_IDS.verifyStart ? this.some() : this.none();
	}

	public override async run(interaction: ButtonInteraction) {
		try {
			const account = await this.container.prisma.riotAccount.findUnique({ where: { discordId: interaction.user.id } });
			if (account) {
				return interaction.reply(ephemeralV2(buildAlreadyLinkedMessage(account.gameName, account.tagLine, account.region)));
			}

			const inProgress = await this.container.prisma.verificationChallenge.findFirst({
				where: { discordId: interaction.user.id, startedAt: { not: null } }
			});
			if (inProgress) return interaction.reply(ephemeralV2(buildVerificationInProgressMessage()));

			const modal = new ModalBuilder().setCustomId(INTERACTION_IDS.verifyAccountModal).setTitle('Verificar cuenta de Riot');
			const riotId = new TextInputBuilder()
				.setCustomId(FORM_FIELD_IDS.riotId)
				.setLabel('Riot ID (Nombre#TAG)')
				.setPlaceholder('Ejemplo#LAS')
				.setStyle(TextInputStyle.Short)
				.setRequired(true)
				.setMaxLength(22);
			const region = new TextInputBuilder()
				.setCustomId(FORM_FIELD_IDS.region)
				.setLabel('Región')
				.setPlaceholder('LAS, LAN, BR, NA, EUW, EUNE, KR, JP, OCE o TR')
				.setStyle(TextInputStyle.Short)
				.setRequired(true)
				.setMaxLength(4);

			modal.addComponents(
				new ActionRowBuilder<TextInputBuilder>().addComponents(riotId),
				new ActionRowBuilder<TextInputBuilder>().addComponents(region)
			);
			return interaction.showModal(modal);
		} catch (error) {
			this.container.logger.error(error);
			if (!interaction.replied && !interaction.deferred) {
				return interaction.reply(ephemeralNoticeMessage('error', 'No pude iniciar la verificación. Intentá nuevamente.'));
			}
			return;
		}
	}
}