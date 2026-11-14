import { ApplyOptions } from '@sapphire/decorators';
import { InteractionHandler, InteractionHandlerTypes } from '@sapphire/framework';
import { ChannelType, ModalSubmitInteraction, PermissionFlagsBits } from 'discord.js';
import { FORM_FIELD_IDS, INTERACTION_IDS } from '../lib/constants';
import { buildErrorReportEmbed } from '../lib/embeds/report';

@ApplyOptions<InteractionHandler.Options>({
	interactionHandlerType: InteractionHandlerTypes.ModalSubmit
})
export class VerifyReportSubmitHandler extends InteractionHandler {
	public override parse(interaction: ModalSubmitInteraction) {
		return interaction.customId === INTERACTION_IDS.verifyReportModal ? this.some() : this.none();
	}

	public override async run(interaction: ModalSubmitInteraction) {
		await interaction.deferReply({ ephemeral: true });

		try {
			if (!interaction.guildId || !interaction.guild) return interaction.editReply('Los reportes solo pueden enviarse desde un servidor.');
			const guild = await this.container.prisma.guild.findUnique({ where: { id: interaction.guildId } });
			if (!guild?.reportChannelId) return interaction.editReply('Los administradores todavía no configuraron un canal de reportes.');

			const channel = await interaction.guild.channels.fetch(guild.reportChannelId);
			if (!channel || channel.type !== ChannelType.GuildText) {
				return interaction.editReply('El canal de reportes configurado ya no existe o no es un canal de texto.');
			}

			const botMember = interaction.guild.members.me;
			const permissions = botMember ? channel.permissionsFor(botMember) : null;
			if (!permissions?.has(PermissionFlagsBits.SendMessages) || !permissions.has(PermissionFlagsBits.EmbedLinks)) {
				return interaction.editReply('No puedo enviar reportes porque me faltan permisos en el canal configurado.');
			}

			const category = interaction.fields.getTextInputValue(FORM_FIELD_IDS.category).trim();
			const description = interaction.fields.getTextInputValue(FORM_FIELD_IDS.description).trim();
			const reference = interaction.fields.getTextInputValue(FORM_FIELD_IDS.reference).trim() || null;
			if (!category || !description) return interaction.editReply('La categoría y la descripción son obligatorias.');

			const report = await this.container.prisma.errorReport.create({
				data: {
					guildId: interaction.guildId,
					discordId: interaction.user.id,
					category,
					description,
					reference
				}
			});

			await channel.send({
				embeds: [buildErrorReportEmbed(interaction.user, category, description, reference, report.createdAt)],
				allowedMentions: { users: [] }
			});
			return interaction.editReply('Reporte enviado correctamente. Gracias por ayudarnos a mejorar el bot.');
		} catch (error) {
			this.container.logger.error(error);
			return interaction.editReply('No pude enviar el reporte. Intentá nuevamente más tarde.');
		}
	}
}
