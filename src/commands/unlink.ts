import { ApplyOptions } from '@sapphire/decorators';
import { Command } from '@sapphire/framework';
import { MessageFlags, type GuildMember } from 'discord.js';
import { ELO_TIERS } from '../lib/constants';
import { isEloTier, isRegion } from '../lib/types';
import { noticeMessage } from '../lib/ui';
import { removeManagedPlayerRoles } from '../lib/roles';

@ApplyOptions<Command.Options>({
	description: 'Unlink your League of Legends account'
})
export class UnlinkCommand extends Command {
	public override registerApplicationCommands(registry: Command.Registry) {
		registry.registerChatInputCommand({
			name: this.name,
			description: this.description
		});
	}

	public override async chatInputRun(interaction: Command.ChatInputCommandInteraction) {
		await interaction.deferReply({ flags: MessageFlags.Ephemeral });

		try {
			if (!interaction.guild) return interaction.editReply(noticeMessage('error', 'Este comando solo puede ejecutarse dentro de un servidor.'));
			const account = await this.container.prisma.riotAccount.findUnique({ where: { discordId: interaction.user.id } });
			if (!account) return interaction.editReply(noticeMessage('warning', 'No tenés ninguna cuenta de League of Legends vinculada.'));

			await this.container.prisma.$transaction([
				this.container.prisma.riotAccount.delete({ where: { puuid: account.puuid } }),
				this.container.prisma.verificationChallenge.deleteMany({ where: { discordId: interaction.user.id } })
			]);

			const guild = interaction.guild;
			const member = await guild.members.fetch(interaction.user.id);
			const regionRoleRemoved = await this.removeStoredRole(guild, member, account.region);
			const eloRolesRemoved = await Promise.all(
				Object.keys(ELO_TIERS)
					.filter(isEloTier)
					.map((tier) => this.removeStoredRole(guild, member, tier))
			);
			const eloRoleCount = eloRolesRemoved.filter(Boolean).length;
			await removeManagedPlayerRoles(guild, member);
			await this.container.prisma.playerGuildPreference.deleteMany({ where: { guildId: guild.id, discordId: interaction.user.id } });
			const lines = [`Se desvinculó **${account.gameName}#${account.tagLine}** correctamente.`];
			if (!regionRoleRemoved) lines.push('**Rol de región:** no se encontró o no se pudo quitar.');
			lines.push(`**Roles de elo:** se quitaron ${eloRoleCount} rol${eloRoleCount === 1 ? '' : 'es'}.`);
			return interaction.editReply(noticeMessage('success', lines.join('\n'), 'Cuenta desvinculada'));
		} catch (error) {
			this.container.logger.error(error);
			return interaction.editReply(noticeMessage('error', 'No pude desvincular tu cuenta. Intentá nuevamente más tarde.'));
		}
	}

	private async removeStoredRole(
		guild: NonNullable<Command.ChatInputCommandInteraction['guild']>,
		member: GuildMember,
		value: string
	): Promise<boolean> {
		if (!isRegion(value) && !isEloTier(value)) return false;
		const storedRole = await this.container.prisma.guildRole.findUnique({
			where: { guildId_key: { guildId: guild.id, key: value } }
		});
		if (!storedRole) return false;
		try {
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