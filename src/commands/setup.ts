import { ApplyOptions } from '@sapphire/decorators';
import { Command } from '@sapphire/framework';
import { DiscordAPIError, MessageFlags, PermissionFlagsBits, type ColorResolvable, type Guild, type Role } from 'discord.js';
import { ELO_TIERS, REGIONS } from '../lib/constants';
import type { EloTier, Region } from '../lib/types';
import { noticeMessage } from '../lib/ui';

@ApplyOptions<Command.Options>({
	description: 'Create or reuse the roles required by the bot',
	requiredUserPermissions: PermissionFlagsBits.Administrator
})
export class SetupCommand extends Command {
	public override registerApplicationCommands(registry: Command.Registry) {
		registry.registerChatInputCommand({
			name: this.name,
			description: this.description,
			defaultMemberPermissions: PermissionFlagsBits.Administrator
		});
	}

	public override async chatInputRun(interaction: Command.ChatInputCommandInteraction) {
		await interaction.deferReply({ flags: MessageFlags.Ephemeral });

		const guild = interaction.guild;
		if (!guild) {
			return interaction.editReply(noticeMessage('error', 'Este comando solo puede ejecutarse dentro de un servidor.'));
		}

		const botMember = guild.members.me;
		if (!botMember?.permissions.has(PermissionFlagsBits.ManageRoles)) {
			return interaction.editReply(
				noticeMessage('error', 'No puedo ejecutar la configuración porque me falta el permiso **Gestionar roles**.')
			);
		}

		try {
			await this.container.prisma.guild.upsert({
				where: { id: guild.id },
				create: { id: guild.id },
				update: {}
			});

			let created = 0;
			let reused = 0;

			for (const tier of Object.keys(ELO_TIERS) as EloTier[]) {
				const result = await this.ensureRole(guild, tier, 'ELO', ELO_TIERS[tier].color);
				created += result.created ? 1 : 0;
				reused += result.created ? 0 : 1;
			}

			for (const region of Object.keys(REGIONS) as Region[]) {
				const result = await this.ensureRole(guild, region, 'REGION');
				created += result.created ? 1 : 0;
				reused += result.created ? 0 : 1;
			}

			return interaction.editReply(
				noticeMessage(
					'success',
					`Se crearon **${created}** roles y se reutilizaron **${reused}** roles existentes.\nSiguiente paso: usá \`/set-verify-channel\` para publicar el panel de verificación.`,
					'Configuración completada'
				)
			);
		} catch (error) {
			this.container.logger.error(error);
			return interaction.editReply(
				noticeMessage('error', 'No pude completar la configuración. Revisá los permisos del bot y los logs para más detalles.')
			);
		}
	}

	private async ensureRole(
		guild: Guild,
		key: EloTier | Region,
		kind: 'ELO' | 'REGION',
		color?: ColorResolvable
	): Promise<{ role: Role; created: boolean }> {
		const storedRole = await this.container.prisma.guildRole.findUnique({
			where: { guildId_key: { guildId: guild.id, key } }
		});

		if (storedRole) {
			const existingRole = await this.fetchRole(guild, storedRole.roleId);
			if (existingRole) return { role: existingRole, created: false };
		}

		const role = await guild.roles.create({
			name: key,
			color,
			reason: `Initial ${kind.toLowerCase()} role setup`
		});

		await this.container.prisma.guildRole.upsert({
			where: { guildId_key: { guildId: guild.id, key } },
			create: { guildId: guild.id, key, kind, roleId: role.id },
			update: { kind, roleId: role.id }
		});

		return { role, created: true };
	}

	private async fetchRole(guild: Guild, roleId: string): Promise<Role | null> {
		try {
			return await guild.roles.fetch(roleId);
		} catch (error) {
			if (error instanceof DiscordAPIError && error.code === 10011) return null;
			throw error;
		}
	}
}