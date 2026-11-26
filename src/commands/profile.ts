import { ApplyOptions } from '@sapphire/decorators';
import { Command } from '@sapphire/framework';
import { ApplicationCommandOptionType, AttachmentBuilder } from 'discord.js';
import { createLogger } from '../lib/logger.js';
import { loadProfileData } from '../lib/profile/data.js';
import { renderProfileImage } from '../lib/profile/render.js';
import { isRegion } from '../lib/types/index.js';
import { noticeMessage } from '../lib/ui.js';

const log = createLogger('profile');

@ApplyOptions<Command.Options>({ description: 'Show a League of Legends profile' })
export class ProfileCommand extends Command {
	public override registerApplicationCommands(registry: Command.Registry) {
		registry.registerChatInputCommand({
			name: this.name,
			description: this.description,
			options: [{ name: 'usuario', description: 'Miembro cuyo perfil querés consultar', type: ApplicationCommandOptionType.User, required: false }]
		});
	}

	public override async chatInputRun(interaction: Command.ChatInputCommandInteraction) {
		await interaction.deferReply();

		try {
			const target = interaction.options.getUser('usuario') ?? interaction.user;
			const account = await this.container.prisma.riotAccount.findUnique({ where: { discordId: target.id } });
			if (!account) return interaction.editReply(noticeMessage('warning', `${target} no tiene una cuenta de League of Legends vinculada.`));
			if (!isRegion(account.region)) return interaction.editReply(noticeMessage('error', 'La cuenta vinculada tiene una región inválida.'));

			const startedAt = Date.now();
			const data = await loadProfileData(account, { region: account.region, guildId: interaction.guildId, displayName: target.globalName ?? target.username });
			const loadedAt = Date.now();
			const image = await renderProfileImage(data);
			log.debug(`Perfil de ${account.gameName}#${account.tagLine}: datos ${loadedAt - startedAt}ms, imagen ${Date.now() - loadedAt}ms (${Math.round(image.length / 1024)} KB).`);

			return interaction.editReply({ files: [new AttachmentBuilder(image, { name: 'profile.png' })], allowedMentions: { parse: [] } });
		} catch (error) {
			this.container.logger.error(error);
			return interaction.editReply(
				noticeMessage('error', 'No pude generar el perfil. Puede que todavía no haya datos sincronizados; probá de nuevo cuando termine la sincronización inicial.')
			);
		}
	}
}