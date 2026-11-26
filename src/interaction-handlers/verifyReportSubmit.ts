import { ApplyOptions } from '@sapphire/decorators';
import { InteractionHandler, InteractionHandlerTypes } from '@sapphire/framework';
import { ChannelType, MessageFlags, ModalSubmitInteraction, PermissionFlagsBits } from 'discord.js';
import { FORM_FIELD_IDS, INTERACTION_IDS } from '../lib/constants.js';
import { buildErrorReportMessage } from '../lib/embeds/report.js';
import { noticeMessage, v2 } from '../lib/ui.js';

@ApplyOptions<InteractionHandler.Options>({
	interactionHandlerType: InteractionHandlerTypes.ModalSubmit
})
export class VerifyReportSubmitHandler extends InteractionHandler {
	public override parse(interaction: ModalSubmitInteraction) {
		if (!interaction.customId.startsWith(INTERACTION_IDS.verifyReportModalPrefix)) return this.none();
		const guildId = interaction.customId.slice(INTERACTION_IDS.verifyReportModalPrefix.length);
		return /^\d+$/.test(guildId) ? this.some(guildId) : this.none();
	}

	public override async run(interaction: ModalSubmitInteraction, parsedData: unknown) {
		await interaction.deferReply({ flags: MessageFlags.Ephemeral });

		try {
			const guildId = typeof parsedData === 'string' ? parsedData : '';
			const guild = await this.container.client.guilds.fetch(guildId).catch(() => null);
			if (!guild) return interaction.editReply(noticeMessage('error', 'No pude encontrar el servidor al que corresponde este reporte.'));

			const member = await guild.members.fetch(interaction.user.id).catch(() => null);
			if (!member) return interaction.editReply(noticeMessage('error', 'Solo los miembros del servidor pueden enviar reportes.'));

			const guildConfig = await this.container.prisma.guild.findUnique({ where: { id: guild.id } });
			if (!guildConfig?.reportChannelId) {
				return interaction.editReply(noticeMessage('warning', 'Los administradores todavía no configuraron un canal de reportes.'));
			}

			const channel = await guild.channels.fetch(guildConfig.reportChannelId);
			if (!channel || channel.type !== ChannelType.GuildText) {
				return interaction.editReply(noticeMessage('error', 'El canal de reportes configurado ya no existe o no es un canal de texto.'));
			}

			const botMember = guild.members.me;
			const permissions = botMember ? channel.permissionsFor(botMember) : null;
			if (!permissions?.has(PermissionFlagsBits.SendMessages) || !permissions.has(PermissionFlagsBits.EmbedLinks)) {
				return interaction.editReply(noticeMessage('error', 'No puedo enviar reportes porque me faltan permisos en el canal configurado.'));
			}

			const category = interaction.fields.getTextInputValue(FORM_FIELD_IDS.category).trim();
			const description = interaction.fields.getTextInputValue(FORM_FIELD_IDS.description).trim();
			const reference = interaction.fields.getTextInputValue(FORM_FIELD_IDS.reference).trim() || null;
			if (!category || !description) return interaction.editReply(noticeMessage('error', 'La categoría y la descripción son obligatorias.'));

			const report = await this.container.prisma.errorReport.create({
				data: {
					guildId: guild.id,
					discordId: interaction.user.id,
					category,
					description,
					reference
				}
			});

			await channel.send({
				...v2(buildErrorReportMessage(interaction.user, category, description, reference, report.createdAt)),
				allowedMentions: { parse: [] }
			});
			return interaction.editReply(noticeMessage('success', 'Gracias por ayudarnos a mejorar el bot.', 'Reporte enviado'));
		} catch (error) {
			this.container.logger.error(error);
			return interaction.editReply(noticeMessage('error', 'No pude enviar el reporte. Intentá nuevamente más tarde.'));
		}
	}
}