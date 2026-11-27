import { ApplyOptions } from '@sapphire/decorators';
import { Command } from '@sapphire/framework';
import { ActionRowBuilder, ApplicationCommandOptionType, AttachmentBuilder, ButtonBuilder, ButtonStyle, ComponentType } from 'discord.js';
import { buildLeaderboardPage, indexOfMember, loadStandings, PAGE_SIZE, QUEUE_LABELS, totalPagesOf } from '../lib/leaderboard/data.js';
import { renderLeaderboardImage, type LeaderboardQueue } from '../lib/leaderboard/render.js';
import { ephemeralNoticeMessage, noticeMessage } from '../lib/ui.js';

/** Tiempo que los botones de página siguen activos. */
const PAGINATION_TIME_MS = 3 * 60 * 1_000;
const PREVIOUS_BUTTON_ID = 'leaderboard:previous';
const NEXT_BUTTON_ID = 'leaderboard:next';
const SELF_BUTTON_ID = 'leaderboard:self';

function parseQueue(value: string | null): LeaderboardQueue {
	return value === 'FLEX' || value === 'TFT' ? value : 'SOLO';
}

@ApplyOptions<Command.Options>({
	description: 'Show the ranked leaderboard of linked members'
})
export class LeaderboardCommand extends Command {
	public override registerApplicationCommands(registry: Command.Registry) {
		registry.registerChatInputCommand({
			name: this.name,
			description: this.description,
			options: [
				{
					name: 'cola',
					description: 'Cola del ranking (por defecto Solo/Duo)',
					type: ApplicationCommandOptionType.String,
					required: false,
					choices: [
						{ name: 'Solo/Duo', value: 'SOLO' },
						{ name: 'Flex 5v5', value: 'FLEX' },
						{ name: 'TFT', value: 'TFT' }
					]
				}
			]
		});
	}

	public override async chatInputRun(interaction: Command.ChatInputCommandInteraction) {
		await interaction.deferReply();

		try {
			const guild = interaction.guild;
			if (!guild) return interaction.editReply(noticeMessage('error', 'Este comando solo puede ejecutarse dentro de un servidor.'));

			const queue = parseQueue(interaction.options.getString('cola'));
			const label = QUEUE_LABELS[queue];

			const snapshot = await loadStandings(guild, queue);
			if (snapshot.totalAccounts === 0) return interaction.editReply(noticeMessage('info', 'Todavía no hay cuentas vinculadas en este servidor.'));

			if (snapshot.standings.length === 0) {
				if (snapshot.failed > 0) {
					return interaction.editReply(noticeMessage('warning', `No pude consultar **${label}** en Riot en este momento. Probá de nuevo en un rato.`));
				}
				return interaction.editReply(noticeMessage('info', `Nadie en este servidor tiene rango en **${label}** todavía.`));
			}

			const totalPages = totalPagesOf(snapshot);
			const ownIndex = indexOfMember(snapshot, interaction.user.id);

			const buildBoard = async (page: number, disabled = false) => {
				const data = await buildLeaderboardPage(snapshot, guild, page, interaction.user.id);
				const image = await renderLeaderboardImage(data);
				// El nombre cambia por página para que Discord no reutilice la imagen cacheada de la anterior.
				const file = new AttachmentBuilder(image, {
					name: `leaderboard-${queue.toLowerCase()}-${data.page + 1}.png`,
					description: `Ranking ${label}, página ${data.page + 1} de ${totalPages}`
				});

				return {
					content: '',
					files: [file],
					// Reemplaza la imagen anterior en vez de sumar una nueva al mensaje.
					attachments: [],
					components: totalPages > 1 ? [this.controls(data.page, totalPages, ownIndex >= 0, disabled)] : [],
					allowedMentions: { parse: [] }
				};
			};

			const message = await interaction.editReply(await buildBoard(0));
			if (totalPages <= 1) return message;

			let currentPage = 0;
			let busy = false;
			const collector = message.createMessageComponentCollector({ componentType: ComponentType.Button, time: PAGINATION_TIME_MS });

			collector.on('collect', async (button) => {
				try {
					if (button.user.id !== interaction.user.id) {
						await button.reply(ephemeralNoticeMessage('warning', 'Solo quien ejecutó el comando puede cambiar de página.'));
						return;
					}

					// Armar la imagen puede tardar más de 3 segundos: se confirma el click y se edita después.
					await button.deferUpdate();
					if (busy) return;
					busy = true;

					try {
						if (button.customId === NEXT_BUTTON_ID) currentPage = Math.min(currentPage + 1, totalPages - 1);
						else if (button.customId === PREVIOUS_BUTTON_ID) currentPage = Math.max(currentPage - 1, 0);
						else if (button.customId === SELF_BUTTON_ID && ownIndex >= 0) currentPage = Math.floor(ownIndex / PAGE_SIZE);

						await button.editReply(await buildBoard(currentPage));
					} finally {
						busy = false;
					}
				} catch (error) {
					this.container.logger.error(error);
				}
			});

			collector.on('end', () => {
				// Solo se desactivan los botones: la imagen actual queda como está.
				void interaction.editReply({ components: [this.controls(currentPage, totalPages, ownIndex >= 0, true)] }).catch(() => null);
			});

			return message;
		} catch (error) {
			this.container.logger.error(error);
			return interaction.editReply(noticeMessage('error', 'No pude generar el ranking. Intentá nuevamente más tarde.'));
		}
	}

	private controls(page: number, totalPages: number, hasSelf: boolean, disabled: boolean): ActionRowBuilder<ButtonBuilder> {
		const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
			new ButtonBuilder()
				.setCustomId(PREVIOUS_BUTTON_ID)
				.setLabel('Anterior')
				.setStyle(ButtonStyle.Secondary)
				.setDisabled(disabled || page === 0)
		);

		if (hasSelf) {
			row.addComponents(new ButtonBuilder().setCustomId(SELF_BUTTON_ID).setLabel('Mi posición').setStyle(ButtonStyle.Primary).setDisabled(disabled));
		}

		row.addComponents(
			new ButtonBuilder()
				.setCustomId(NEXT_BUTTON_ID)
				.setLabel('Siguiente')
				.setStyle(ButtonStyle.Secondary)
				.setDisabled(disabled || page === totalPages - 1)
		);

		return row;
	}
}