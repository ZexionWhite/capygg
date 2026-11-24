import { ApplyOptions } from '@sapphire/decorators';
import { Command } from '@sapphire/framework';
import { ApplicationCommandOptionType, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { noticeMessage } from '../lib/ui';

@ApplyOptions<Command.Options>({
	description: 'Force verify an existing OTP and assign the OTP role',
	requiredUserPermissions: PermissionFlagsBits.Administrator
})
export class ForceVerifyOtpCommand extends Command {
	public override registerApplicationCommands(registry: Command.Registry) {
		registry.registerChatInputCommand({
			name: this.name,
			description: this.description,
			defaultMemberPermissions: PermissionFlagsBits.Administrator,
			options: [
				{ name: 'usuario', description: 'Miembro que ya es OTP', type: ApplicationCommandOptionType.User, required: true },
				{ name: 'champion_id', description: 'ID numérico del campeón OTP', type: ApplicationCommandOptionType.Integer, required: true, minValue: 1 },
				{ name: 'motivo', description: 'Motivo de la verificación manual', type: ApplicationCommandOptionType.String, required: false, maxLength: 300 }
			]
		});
	}

	public override async chatInputRun(interaction: Command.ChatInputCommandInteraction) {
		await interaction.deferReply({ flags: MessageFlags.Ephemeral });
		if (!interaction.guildId || !interaction.guild) return interaction.editReply(noticeMessage('error', 'Este comando solo puede ejecutarse dentro de un servidor.'));
		const user = interaction.options.getUser('usuario', true);
		const championId = interaction.options.getInteger('champion_id', true);
		const reason = interaction.options.getString('motivo');
		const account = await this.container.prisma.riotAccount.findUnique({ where: { discordId: user.id } });
		if (!account) return interaction.editReply(noticeMessage('error', 'Ese usuario no tiene una cuenta de Riot vinculada.'));

		const storedRole = await this.container.prisma.guildRole.findUnique({ where: { guildId_key: { guildId: interaction.guildId, key: 'OTP' } } });
		if (!storedRole) return interaction.editReply(noticeMessage('error', 'No existe el rol OTP. Ejecutá `/setup` primero.'));
		const role = await interaction.guild.roles.fetch(storedRole.roleId).catch(() => null);
		if (!role) return interaction.editReply(noticeMessage('error', 'El rol OTP guardado ya no existe. Volvé a ejecutar `/setup`.'));
		const member = await interaction.guild.members.fetch(user.id).catch(() => null);
		if (!member) return interaction.editReply(noticeMessage('error', 'No pude encontrar al miembro en el servidor.'));

		await this.container.prisma.otpOverride.create({
			data: { guildId: interaction.guildId, discordId: user.id, puuid: account.puuid, championId, actorDiscordId: interaction.user.id, reason }
		});
		await this.container.prisma.distinctionAward.create({ data: { guildId: interaction.guildId, discordId: user.id, key: 'OTP', source: 'manual' } });
		await this.container.prisma.auditLog.create({
			data: {
				guildId: interaction.guildId,
				actorDiscordId: interaction.user.id,
				action: 'FORCE_VERIFY_OTP',
				details: JSON.stringify({ targetDiscordId: user.id, puuid: account.puuid, championId, reason })
			}
		});
		await member.roles.add(role, `OTP verificado manualmente por ${interaction.user.id}`);
		return interaction.editReply(noticeMessage('success', `Se verificó manualmente a ${user} como OTP. Campeón ID: **${championId}**. Admin responsable: ${interaction.user}.`, 'OTP verificado'));
	}
}
