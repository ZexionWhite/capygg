import { ApplyOptions } from '@sapphire/decorators';
import { InteractionHandler, InteractionHandlerTypes } from '@sapphire/framework';
import { ActionRowBuilder, ButtonInteraction, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { FORM_FIELD_IDS, INTERACTION_IDS } from '../lib/constants';

@ApplyOptions<InteractionHandler.Options>({
	interactionHandlerType: InteractionHandlerTypes.Button
})
export class VerifyReportHandler extends InteractionHandler {
	public override parse(interaction: ButtonInteraction) {
		return interaction.customId === INTERACTION_IDS.verifyReport ? this.some() : this.none();
	}

	public override async run(interaction: ButtonInteraction) {
		try {
			const modal = new ModalBuilder().setCustomId(INTERACTION_IDS.verifyReportModal).setTitle('Reportar un error');
			const category = new TextInputBuilder()
				.setCustomId(FORM_FIELD_IDS.category)
				.setLabel('Categoría')
				.setStyle(TextInputStyle.Short)
				.setRequired(true)
				.setMaxLength(100);
			const description = new TextInputBuilder()
				.setCustomId(FORM_FIELD_IDS.description)
				.setLabel('Descripción')
				.setStyle(TextInputStyle.Paragraph)
				.setRequired(true)
				.setMaxLength(2_000);
			const reference = new TextInputBuilder()
				.setCustomId(FORM_FIELD_IDS.reference)
				.setLabel('Referencia (opcional)')
				.setStyle(TextInputStyle.Short)
				.setRequired(false)
				.setMaxLength(200);

			modal.addComponents(
				new ActionRowBuilder<TextInputBuilder>().addComponents(category),
				new ActionRowBuilder<TextInputBuilder>().addComponents(description),
				new ActionRowBuilder<TextInputBuilder>().addComponents(reference)
			);
			return interaction.showModal(modal);
		} catch (error) {
			this.container.logger.error(error);
			if (!interaction.replied && !interaction.deferred) {
				return interaction.reply({ content: 'No pude abrir el formulario de reporte. Intentá nuevamente.', ephemeral: true });
			}
			return;
		}
	}
}
