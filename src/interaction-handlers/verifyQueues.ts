import { ApplyOptions } from '@sapphire/decorators';
import { InteractionHandler, InteractionHandlerTypes } from '@sapphire/framework';
import { StringSelectMenuInteraction } from 'discord.js';
import { INTERACTION_IDS } from '../lib/constants';
import { ephemeralNoticeMessage } from '../lib/ui';

const QUEUE_LABELS: Record<string, string> = { SOLO: 'SoloQ', FLEX: 'Flex', NORMALS: 'Normals', ARAM: 'ARAM' };

@ApplyOptions<InteractionHandler.Options>({ interactionHandlerType: InteractionHandlerTypes.SelectMenu })
export class VerifyQueuesHandler extends InteractionHandler {
	public override parse(interaction: StringSelectMenuInteraction) {
		return interaction.customId === INTERACTION_IDS.verifyQueues ? this.some() : this.none();
	}

	public override async run(interaction: StringSelectMenuInteraction) {
		if (!interaction.guildId) return interaction.reply(ephemeralNoticeMessage('error', 'Esto solo se puede configurar dentro de un servidor.'));
		const selected = new Set(interaction.values);
		await this.container.prisma.playerGuildPreference.upsert({
			where: { guildId_discordId: { guildId: interaction.guildId, discordId: interaction.user.id } },
			create: {
				guildId: interaction.guildId,
				discordId: interaction.user.id,
				playsSolo: selected.has('SOLO'),
				playsFlex: selected.has('FLEX'),
				playsNormals: selected.has('NORMALS'),
				playsAram: selected.has('ARAM')
			},
			update: {
				playsSolo: selected.has('SOLO'),
				playsFlex: selected.has('FLEX'),
				playsNormals: selected.has('NORMALS'),
				playsAram: selected.has('ARAM')
			}
		});

		return interaction.update({ content: `Preferencias guardadas: ${[...selected].map((value) => QUEUE_LABELS[value] ?? value).join(', ')}.`, components: [] });
	}
}
