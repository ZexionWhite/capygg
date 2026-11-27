import { ApplyOptions } from '@sapphire/decorators';
import { Command } from '@sapphire/framework';
import { ActionRowBuilder, ApplicationCommandOptionType, AttachmentBuilder, AutocompleteInteraction, ButtonBuilder, ButtonStyle, ComponentType } from 'discord.js';
import { buildChampionBoardPage, indexOfMember, loadChampionBoard, MODE_LABELS, PAGE_SIZE, resolveBoardChampion, totalPagesOf } from '../lib/champion-ranking/data.js';
import { renderChampionBoardImage, type ChampionBoardMode } from '../lib/champion-ranking/render.js';
import { getChampionAutocompleteChoices, getChampionById } from '../lib/riot/champion-catalog.js';
import { ephemeralNoticeMessage, noticeMessage } from '../lib/ui.js';

/** Tiempo que los botones de página siguen activos. */
const PAGINATION_TIME_MS = 3 * 60 * 1_000;
const PREVIOUS_BUTTON_ID = 'champion-ranking:previous';
const NEXT_BUTTON_ID = 'champion-ranking:next';
const SELF_BUTTON_ID = 'champion-ranking:self';

function parseMode(value: string | null): ChampionBoardMode {
	return value === 'MASTERY' ? 'MASTERY' : 'POWER';
}

@ApplyOptions<Command.Options>({
	description: 'Show the best players of a champion in this server'
})
export class ChampionRankingCommand extends Command {
	public override registerApplicationCommands(registry: Command.Registry) {
		registry.registerChatInputCommand({
			name: this.name,
			description: this.description,
			options: [
				{
					name: 'campeon',
					description: 'Buscá el campeón por nombre',
					type: ApplicationCommandOptionType.String,
					required: true,
					autocomplete: true
				},
				{
					name: 'tipo',
					description: 'Cómo ordenar el ranking (por defecto Poder)',
					type: ApplicationCommandOptionType.String,
					required: false,
					choices: [
						{ name: MODE_LABELS.POWER, value: 'POWER' },
						{ name: MODE_LABELS.MASTERY, value: 'MASTERY' }
					]
				}
			]
		});
	}

	public override async autocompleteRun(interaction: AutocompleteInteraction) {
		try {
			return await interaction.respond(await getChampionAutocompleteChoices(String(interaction.options.getFocused())));
		} catch (error) {
			this.container.logger.error('Failed to autocomplete champion ranking champions.', error);
			return interaction.respond([]);
		}
	}

	public override async chatInputRun(interaction: Command.ChatInputCommandInteraction) {
		await interaction.deferReply();

		try {
			const guild = interaction.guild;
			if (!guild) return interaction.editReply(noticeMessage('error', 'Este comando solo puede ejecutarse dentro de un servidor.'));

			const championId = Number(interaction.options.getString('campeon', true));
			const catalogEntry = Number.isSafeInteger(championId) && championId > 0 ? await getChampionById(championId) : null;
			if (!catalogEntry) return interaction.editReply(noticeMessage('error', 'No encontré ese campeón. Elegilo de la lista que aparece al escribir.'));

			const mode = parseMode(interaction.options.getString('tipo'));
			const champion = await resolveBoardChampion(catalogEntry);
			const board = await loadChampionBoard(guild, champion, mode);

			const totalPages = totalPagesOf(board);
			const ownIndex = indexOfMember(board, interaction.user.id);

			const buildBoard = async (page: number, disabled = false) => {
				const data = await buildChampionBoardPage(board, guild, page, interaction.user.id);
				const image = await renderChampionBoardImage(data);
				const file = new AttachmentBuilder(image, {
					name: `champion-ranking-${champion.key.toLowerCase()}-${mode.toLowerCase()}-${data.page + 1}.png`,
					description: `Ranking de ${MODE_LABELS[mode]} de ${champion.name}, página ${data.page + 1} de ${totalPages}`
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
				.setEmoji('◀️')
				.setStyle(ButtonStyle.Secondary)
				.setDisabled(disabled || page === 0)
		);

		if (hasSelf) {
			row.addComponents(new ButtonBuilder().setCustomId(SELF_BUTTON_ID).setLabel('Mi posición').setEmoji('📍').setStyle(ButtonStyle.Primary).setDisabled(disabled));
		}

		row.addComponents(
			new ButtonBuilder()
				.setCustomId(NEXT_BUTTON_ID)
				.setLabel('Siguiente')
				.setEmoji('▶️')
				.setStyle(ButtonStyle.Secondary)
				.setDisabled(disabled || page === totalPages - 1)
		);

		return row;
	}
}