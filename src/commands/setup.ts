import { ApplyOptions } from '@sapphire/decorators';
import { Command } from '@sapphire/framework';
import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import { migrateLegacyRoleKeys, roleDefinitions, syncGuildRole, type RoleSyncOutcome } from '../lib/roles.js';
import { noticeMessage } from '../lib/ui.js';

@ApplyOptions<Command.Options>({
	description: 'Create, reuse or update the roles required by the bot',
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

			await migrateLegacyRoleKeys();

			const counts: Record<RoleSyncOutcome, number> = { created: 0, updated: 0, reused: 0 };
			const failed: string[] = [];

			for (const definition of roleDefinitions()) {
				try {
					counts[await syncGuildRole(guild, definition)]++;
				} catch (error) {
					this.container.logger.error(`[setup] ${guild.id}: no pude sincronizar el rol "${definition.name}".`, error);
					failed.push(definition.name);
				}
			}

			const summary = `Se crearon **${counts.created}** roles, se actualizaron **${counts.updated}** y se reutilizaron **${counts.reused}**.`;

			if (failed.length > 0) {
				return interaction.editReply(
					noticeMessage(
						'warning',
						`${summary}\nNo pude procesar: ${failed.map((name) => `**${name}**`).join(', ')}.\nRevisá que el rol del bot esté **por encima** de esos roles y tenga el permiso **Gestionar roles**.`,
						'Configuración incompleta'
					)
				);
			}

			return interaction.editReply(
				noticeMessage(
					'success',
					`${summary}\nSiguiente paso: usá \`/set-verify-channel\` para publicar el panel de verificación.`,
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
}