import { ApplyOptions } from '@sapphire/decorators';
import { Command } from '@sapphire/framework';
import {
	ApplicationCommandOptionType,
	ChannelType,
	EmbedBuilder,
	PermissionFlagsBits,
	TextChannel,
	type Guild,
	type GuildMember,
	type Message
} from 'discord.js';
import { buildVerificationPanelComponents, buildVerificationPanelEmbed } from '../lib/embeds/verification';

@ApplyOptions<Command.Options>({
	description: 'Configure the account verification channel',
	requiredUserPermissions: PermissionFlagsBits.Administrator
})
export class SetVerifyChannelCommand extends Command {
	public override registerApplicationCommands(registry: Command.Registry) {
		registry.registerChatInputCommand({
			name: 'set-verify-channel',
			description: this.description,
			defaultMemberPermissions: PermissionFlagsBits.Administrator,
			options: [
				{
					name: 'canal',
					description: 'Canal donde se publicará el panel de verificación',
					type: ApplicationCommandOptionType.Channel,
					required: true,
					channelTypes: [ChannelType.GuildText]
				},
				{
					name: 'canal_reportes',
					description: 'Canal donde se recibirán los reportes de errores',
					type: ApplicationCommandOptionType.Channel,
					required: false,
					channelTypes: [ChannelType.GuildText]
				}
			]
		});
	}

	public override async chatInputRun(interaction: Command.ChatInputCommandInteraction) {
		await interaction.deferReply({ ephemeral: true });

		const guild = interaction.guild;
		const verifyChannel = interaction.options.getChannel('canal', true);
		const reportChannel = interaction.options.getChannel('canal_reportes');

		if (!guild || verifyChannel.type !== ChannelType.GuildText || !(verifyChannel instanceof TextChannel)) {
			return interaction.editReply('Este comando solo puede ejecutarse en un servidor y requiere un canal de texto.');
		}

		if (reportChannel && (reportChannel.type !== ChannelType.GuildText || !(reportChannel instanceof TextChannel))) {
			return interaction.editReply('El canal de reportes debe ser un canal de texto.');
		}

		const botMember = guild.members.me;
		if (!botMember) return interaction.editReply('No pude encontrar mi miembro dentro de este servidor.');

		const verifyPermissionError = this.getChannelPermissionError(verifyChannel, botMember);
		if (verifyPermissionError) return interaction.editReply(verifyPermissionError);

		if (reportChannel) {
			const reportPermissionError = this.getChannelPermissionError(reportChannel, botMember);
			if (reportPermissionError) return interaction.editReply(`Canal de reportes: ${reportPermissionError}`);
		}

		try {
			const existingGuild = await this.container.prisma.guild.findUnique({ where: { id: guild.id } });
			const oldMessage = existingGuild
				? await this.fetchPreviousMessage(guild, existingGuild.verifyChannelId, existingGuild.verifyMessageId)
				: null;
			const panel = {
				embeds: [buildVerificationPanelEmbed()],
				components: [buildVerificationPanelComponents()]
			};

			let message: Message;
			if (oldMessage?.channelId === verifyChannel.id) {
				message = await oldMessage.edit(panel);
			} else {
				if (oldMessage) {
					try {
						await oldMessage.delete();
					} catch (error) {
						this.container.logger.warn(`Could not delete previous verification message: ${String(error)}`);
					}
				}
				message = await verifyChannel.send(panel);
			}

			await this.container.prisma.guild.upsert({
				where: { id: guild.id },
				create: {
					id: guild.id,
					verifyChannelId: verifyChannel.id,
					verifyMessageId: message.id,
					...(reportChannel ? { reportChannelId: reportChannel.id } : {})
				},
				update: {
					verifyChannelId: verifyChannel.id,
					verifyMessageId: message.id,
					...(reportChannel ? { reportChannelId: reportChannel.id } : {})
				}
			});

			return interaction.editReply({
				embeds: [new EmbedBuilder().setColor(0x57f287).setDescription(`Panel de verificación publicado en ${verifyChannel}.`)]
			});
		} catch (error) {
			this.container.logger.error(error);
			return interaction.editReply('No pude publicar el panel de verificación. Revisá los permisos y los logs.');
		}
	}

	private getChannelPermissionError(channel: TextChannel, botMember: GuildMember): string | null {
		const permissions = channel.permissionsFor(botMember);
		if (!permissions?.has(PermissionFlagsBits.ViewChannel)) return 'No tengo permiso para ver ese canal.';
		if (!permissions.has(PermissionFlagsBits.SendMessages)) return 'No tengo permiso para enviar mensajes.';
		if (!permissions.has(PermissionFlagsBits.EmbedLinks)) return 'No tengo permiso para insertar enlaces/embeds.';
		return null;
	}

	private async fetchPreviousMessage(guild: Guild, channelId: string | null, messageId: string | null): Promise<Message | null> {
		if (!channelId || !messageId) return null;

		try {
			const channel = await guild.channels.fetch(channelId);
			if (!channel || !channel.isTextBased() || channel.isDMBased()) return null;
			return await channel.messages.fetch(messageId);
		} catch (error) {
			this.container.logger.warn(`Could not fetch previous verification message: ${String(error)}`);
			return null;
		}
	}
}
