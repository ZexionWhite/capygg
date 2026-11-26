import { ApplyOptions } from '@sapphire/decorators';
import { Command } from '@sapphire/framework';
import { ActionRowBuilder, ApplicationCommandOptionType, ButtonBuilder, ButtonStyle, ComponentType, type Guild } from 'discord.js';
import type { RiotAccount } from '../generated/prisma/client';
import { QUEUES } from '../lib/constants';
import { refreshStoredPuuid } from '../lib/riot/account-sync';
import { RiotApiError, riotClient } from '../lib/riot/client';
import { isRegion } from '../lib/types';
import type { RiotLeagueEntry } from '../lib/types/riot';
import { COLORS, container as card, divider, ephemeralNoticeMessage, noticeMessage, text, v2 } from '../lib/ui';

/** Cuánto tiempo se reutiliza un rango guardado antes de volver a preguntarle a Riot. */
const CACHE_TTL_MS = 30 * 60 * 1_000;
/** Tope de cuentas que se actualizan por ejecución (la personal key permite 100 requests cada 2 minutos). */
const MAX_REFRESH_PER_RUN = 30;
const REFRESH_CHUNK_SIZE = 5;
const PAGE_SIZE = 10;
/** Tiempo que los botones de página siguen activos. */
const PAGINATION_TIME_MS = 3 * 60 * 1_000;
const PREVIOUS_BUTTON_ID = 'leaderboard:previous';
const NEXT_BUTTON_ID = 'leaderboard:next';

const TIER_ORDER = ['IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD', 'DIAMOND', 'MASTER', 'GRANDMASTER', 'CHALLENGER'];
const DIVISION_ORDER = ['IV', 'III', 'II', 'I'];
const APEX_TIERS = new Set(['MASTER', 'GRANDMASTER', 'CHALLENGER']);
const MEDALS = ['🥇', '🥈', '🥉'];
const UNRANKED = 'UNRANKED';

interface Standing {
	account: RiotAccount;
	tier: string;
	division: string;
	lp: number;
	wins: number;
	losses: number;
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
						{ name: 'Flex', value: 'FLEX' }
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

			const queueKey = interaction.options.getString('cola') === 'FLEX' ? 'FLEX' : 'SOLO';
			const queue = QUEUES[queueKey];
			const queueLabel = queueKey === 'FLEX' ? 'Flex' : 'Solo/Duo';

			const memberIds = await this.linkedMemberIds(guild);
			if (memberIds.length === 0) return interaction.editReply(noticeMessage('info', 'Todavía no hay cuentas vinculadas en este servidor.'));

			await this.refreshStale(memberIds, queue);

			// Se vuelve a leer porque el refresco pudo cambiar PUUIDs y rangos guardados.
			const accounts = await this.container.prisma.riotAccount.findMany({ where: { discordId: { in: memberIds } } });
			const snapshots = await this.container.prisma.rankSnapshot.findMany({
				where: { queue, puuid: { in: accounts.map((account) => account.puuid) } }
			});
			const snapshotByPuuid = new Map(snapshots.map((snapshot) => [snapshot.puuid, snapshot]));

			const standings: Standing[] = [];
			let pending = 0;
			for (const account of accounts) {
				const snapshot = snapshotByPuuid.get(account.puuid);
				if (!snapshot) {
					pending++;
					continue;
				}
				if (snapshot.tier === UNRANKED) continue;
				standings.push({ account, tier: snapshot.tier, division: snapshot.division, lp: snapshot.lp, wins: snapshot.wins, losses: snapshot.losses });
			}

			if (standings.length === 0) {
				return interaction.editReply(noticeMessage('info', `Nadie en este servidor tiene rango en **${queueLabel}** todavía.`));
			}

			standings.sort(compareStandings);

			const totalPages = Math.ceil(standings.length / PAGE_SIZE);
			const ownIndex = standings.findIndex((standing) => standing.account.discordId === interaction.user.id);

			const buildBoard = (page: number, disabled = false) => {
				const start = page * PAGE_SIZE;
				const lines = standings.slice(start, start + PAGE_SIZE).map((standing, offset) => formatStanding(standing, start + offset));

				const footer: string[] = [];
				if (ownIndex >= 0) footer.push(`**Tu posición:** #${ownIndex + 1} de ${standings.length}`);
				footer.push(`-# Los rangos se actualizan cada ${CACHE_TTL_MS / 60_000} minutos.${totalPages > 1 ? ` Página ${page + 1}/${totalPages}.` : ''}`);
				if (pending > 0) {
					footer.push(`-# ${pending} cuenta${pending === 1 ? '' : 's'} todavía sin datos. Volvé a probar en un par de minutos.`);
				}

				const board = card(COLORS.primary)
					.addTextDisplayComponents(text(`### 🏆 Ranking ${queueLabel} · ${guild.name}`))
					.addSeparatorComponents(divider())
					.addTextDisplayComponents(text(lines.join('\n\n')))
					.addSeparatorComponents(divider())
					.addTextDisplayComponents(text(footer.join('\n')));

				if (totalPages > 1) {
					board.addActionRowComponents(
						new ActionRowBuilder<ButtonBuilder>().addComponents(
							new ButtonBuilder()
								.setCustomId(PREVIOUS_BUTTON_ID)
								.setLabel('Anterior')
								.setStyle(ButtonStyle.Secondary)
								.setDisabled(disabled || page === 0),
							new ButtonBuilder()
								.setCustomId(NEXT_BUTTON_ID)
								.setLabel('Siguiente')
								.setStyle(ButtonStyle.Secondary)
								.setDisabled(disabled || page === totalPages - 1)
						)
					);
				}

				return { ...v2(board), allowedMentions: { parse: [] } };
			};

			const message = await interaction.editReply(buildBoard(0));
			if (totalPages <= 1) return message;

			let currentPage = 0;
			const collector = message.createMessageComponentCollector({ componentType: ComponentType.Button, time: PAGINATION_TIME_MS });

			collector.on('collect', async (button) => {
				try {
					if (button.user.id !== interaction.user.id) {
						await button.reply(ephemeralNoticeMessage('warning', 'Solo quien ejecutó el comando puede cambiar de página.'));
						return;
					}

					currentPage = button.customId === NEXT_BUTTON_ID ? Math.min(currentPage + 1, totalPages - 1) : Math.max(currentPage - 1, 0);
					await button.update(buildBoard(currentPage));
				} catch (error) {
					this.container.logger.error(error);
				}
			});

			collector.on('end', () => {
				void interaction.editReply(buildBoard(currentPage, true)).catch(() => null);
			});

			return message;
		} catch (error) {
			this.container.logger.error(error);
			return interaction.editReply(noticeMessage('error', 'No pude generar el ranking. Intentá nuevamente más tarde.'));
		}
	}

	/** IDs de Discord con cuenta vinculada que están en este servidor. Requiere el intent GuildMembers. */
	private async linkedMemberIds(guild: Guild): Promise<string[]> {
		if (guild.members.cache.size < guild.memberCount) await guild.members.fetch();

		const accounts = await this.container.prisma.riotAccount.findMany({ select: { discordId: true } });
		return accounts.map((account) => account.discordId).filter((discordId) => guild.members.cache.has(discordId));
	}

	/** Actualiza contra Riot los rangos que no existen o están vencidos, empezando por los más viejos. */
	private async refreshStale(memberIds: string[], queue: string): Promise<void> {
		const accounts = await this.container.prisma.riotAccount.findMany({ where: { discordId: { in: memberIds } } });
		const snapshots = await this.container.prisma.rankSnapshot.findMany({
			where: { queue, puuid: { in: accounts.map((account) => account.puuid) } }
		});
		const ageByPuuid = new Map(snapshots.map((snapshot) => [snapshot.puuid, snapshot.createdAt.getTime()]));

		const now = Date.now();
		const stale = accounts
			.filter((account) => now - (ageByPuuid.get(account.puuid) ?? 0) > CACHE_TTL_MS)
			.sort((left, right) => (ageByPuuid.get(left.puuid) ?? 0) - (ageByPuuid.get(right.puuid) ?? 0))
			.slice(0, MAX_REFRESH_PER_RUN);

		for (let index = 0; index < stale.length; index += REFRESH_CHUNK_SIZE) {
			const chunk = stale.slice(index, index + REFRESH_CHUNK_SIZE);
			const results = await Promise.all(chunk.map((account) => this.fetchEntries(account)));

			// Las escrituras van de a una para no pisar transacciones de SQLite.
			for (const result of results) {
				if (result) await this.saveSnapshots(result.puuid, result.entries);
			}
		}
	}

	private async fetchEntries(account: RiotAccount): Promise<{ puuid: string; entries: RiotLeagueEntry[] } | null> {
		if (!isRegion(account.region)) return null;
		const region = account.region;

		try {
			let current = account;
			const entries = await riotClient.getLeagueEntriesByPuuid(current.puuid, region).catch(async (error: unknown) => {
				if (!(error instanceof RiotApiError) || error.kind !== 'INVALID_PUUID') throw error;
				current = await refreshStoredPuuid(account, region);
				return riotClient.getLeagueEntriesByPuuid(current.puuid, region);
			});
			return { puuid: current.puuid, entries };
		} catch (error) {
			this.container.logger.warn(`Leaderboard: no pude actualizar ${account.gameName}#${account.tagLine}: ${String(error)}`);
			return null;
		}
	}

	/** Guarda una fila por cola (Solo y Flex) para que la otra cola también quede en caché. */
	private async saveSnapshots(puuid: string, entries: RiotLeagueEntry[]): Promise<void> {
		const createdAt = new Date();
		const rows = Object.values(QUEUES).map((queue) => {
			const entry = entries.find((value) => value.queueType === queue);
			return {
				puuid,
				queue,
				tier: entry?.tier ?? UNRANKED,
				division: entry?.rank ?? '',
				lp: entry?.leaguePoints ?? 0,
				wins: entry?.wins ?? 0,
				losses: entry?.losses ?? 0,
				createdAt
			};
		});

		await this.container.prisma.$transaction([
			this.container.prisma.rankSnapshot.deleteMany({ where: { puuid, queue: { in: Object.values(QUEUES) } } }),
			this.container.prisma.rankSnapshot.createMany({ data: rows })
		]);
	}
}

function compareStandings(left: Standing, right: Standing): number {
	return (
		TIER_ORDER.indexOf(right.tier) - TIER_ORDER.indexOf(left.tier) ||
		DIVISION_ORDER.indexOf(right.division) - DIVISION_ORDER.indexOf(left.division) ||
		right.lp - left.lp
	);
}

function formatStanding(standing: Standing, index: number): string {
	const { account, tier, division, lp, wins, losses } = standing;
	const place = MEDALS[index] ?? `**${index + 1}.**`;
	const tierName = tier.charAt(0) + tier.slice(1).toLowerCase();
	const rank = APEX_TIERS.has(tier) ? tierName : `${tierName} ${division}`;
	const games = wins + losses;
	const winrate = games > 0 ? Math.round((wins / games) * 100) : 0;

	return `${place} <@${account.discordId}> · **${rank}** · ${lp} LP\n-# ${account.gameName}#${account.tagLine} · ${winrate}% WR · ${games} partidas`;
}