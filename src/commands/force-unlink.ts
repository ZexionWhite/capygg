import { ApplyOptions } from '@sapphire/decorators';
import { Command } from '@sapphire/framework';
import { ApplicationCommandOptionType, MessageFlags, PermissionFlagsBits, type GuildMember } from 'discord.js';
import { ELO_TIERS } from '../lib/constants';
import { isEloTier } from '../lib/types';
import { noticeMessage } from '../lib/ui';
import { removeManagedPlayerRoles } from '../lib/roles';

@ApplyOptions<Command.Options>({
	description: 'Force unlink a member League of Legends account',
	requiredUserPermissions: PermissionFlagsBits.Administrator
})
export class ForceUnlinkCommand extends Command {
	public override registerApplicationCommands(registry: Command.Registry) {
		registry.registerChatInputCommand({
			name: this.name,
			description: this.description,
			defaultMemberPermissions: PermissionFlagsBits.Administrator,
			options: [
				{
					name: 'usuario',
					description: 'Miembro cuya cuenta se desvinculará',
					type: ApplicationCommandOptionType.User,
					required: true
				}
			]
		});
	}

	public override async chatInputRun(interaction: Command.ChatInputCommandInteraction) {
		await interaction.deferReply({ flags: MessageFlags.Ephemeral });

		try {
			if (!interaction.guild) return interaction.editReply(noticeMessage('error', 'Este comando solo puede ejecutarse dentro de un servidor.'));
			const user = interaction.options.getUser('usuario', true);
			let member: GuildMember;
			try {
				member = await interaction.guild.members.fetch(user.id);
			} catch (error) {
				this.container.logger.error(error);
				return interaction.editReply(noticeMessage('error', 'No pude encontrar ese miembro dentro del servidor.'));
			}
			if (!member) return interaction.editReply(noticeMessage('error', 'El usuario seleccionado no pertenece a este servidor.'));

			const account = await this.container.prisma.riotAccount.findUnique({ where: { discordId: user.id } });
			if (!account) return interaction.editReply(noticeMessage('warning', 'Ese usuario no tiene una cuenta de League of Legends vinculada.'));

			await this.container.prisma.$transaction([
				this.container.prisma.riotAccount.delete({ where: { puuid: account.puuid } }),
				this.container.prisma.verificationChallenge.deleteMany({ where: { discordId: user.id } })
			]);

			const guild = interaction.guild;
			const roleRemoved = await this.removeStoredRole(guild.id, guild, member, account.region);
			const eloRolesRemoved = await Promise.all(
				Object.keys(ELO_TIERS)
					.filter(isEloTier)
					.map((tier) => this.removeStoredRole(guild.id, guild, member, tier))
			);
			const eloRoleCount = eloRolesRemoved.filter(Boolean).length;
			await removeManagedPlayerRoles(guild, member);
			await this.container.prisma.playerGuildPreference.deleteMany({ where: { guildId: guild.id, discordId: user.id } });

			const lines = [`Se desvinculó **${account.gameName}#${account.tagLine}** de ${user}.`];
			if (!roleRemoved) lines.push('**Rol de región:** no se encontró o no se pudo quitar.');
			lines.push(`**Roles de elo:** se quitaron ${eloRoleCount} rol${eloRoleCount === 1 ? '' : 'es'}.`);
			return interaction.editReply(noticeMessage('success', lines.join('\n'), 'Cuenta desvinculada por un administrador'));
		} catch (error) {
			this.container.logger.error(error);
			return interaction.editReply(noticeMessage('error', 'No pude forzar la desvinculación. Revisá los permisos y los logs.'));
		}
	}

	private async removeStoredRole(
		guildId: string,
		guild: NonNullable<Command.ChatInputCommandInteraction['guild']>,
		member: GuildMember,
		key: string
	) {
		try {
			const storedRole = await this.container.prisma.guildRole.findUnique({
				where: { guildId_key: { guildId, key } }
			});
			if (!storedRole) return false;
			const role = await guild.roles.fetch(storedRole.roleId);
			if (!role) return false;
			await member.roles.remove(role);
			return true;
		} catch (error) {
			this.container.logger.error(error);
			return false;
		}
	}
}