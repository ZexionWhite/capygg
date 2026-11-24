import { ApplyOptions } from '@sapphire/decorators';
import { Command } from '@sapphire/framework';
import { ApplicationCommandOptionType, AttachmentBuilder } from 'discord.js';
import { renderProfileImage } from '../lib/profile/render';
import { isRegion } from '../lib/types';
import { noticeMessage } from '../lib/ui';

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

			const [rankRows, matchRows, masteries, awards, preferences] = await Promise.all([
				this.container.prisma.rankSnapshot.findMany({ where: { puuid: account.puuid }, orderBy: { createdAt: 'desc' }, take: 30 }),
				this.container.prisma.matchParticipant.findMany({
					where: { puuid: account.puuid },
					include: { match: { include: { participants: true } } },
					orderBy: { match: { gameStartTimestamp: 'desc' } },
					take: 20
				}),
				this.container.prisma.championMastery.findMany({ where: { puuid: account.puuid }, orderBy: { championPoints: 'desc' }, take: 8 }),
				interaction.guildId
					? this.container.prisma.distinctionAward.findMany({ where: { guildId: interaction.guildId, discordId: target.id }, orderBy: { awardedAt: 'asc' } })
					: Promise.resolve([]),
				interaction.guildId
					? this.container.prisma.playerGuildPreference.findUnique({ where: { guildId_discordId: { guildId: interaction.guildId, discordId: target.id } } })
					: Promise.resolve(null)
			]);

			const latestRanks = new Map<string, (typeof rankRows)[number]>();
			for (const row of rankRows) if (!latestRanks.has(row.queue)) latestRanks.set(row.queue, row);
			const solo = latestRanks.get('RANKED_SOLO_5x5');
			const flex = latestRanks.get('RANKED_FLEX_SR');
			const tft = [...latestRanks.values()].find((row) => row.queue.startsWith('RANKED_TFT'));
			const matches = matchRows.map((row) => ({
				matchId: row.match.matchId,
				playerPuuid: account.puuid,
				playerWin: row.win,
				queueId: row.match.queueId,
				queueLabel: row.match.queueLabel,
				gameMode: row.match.gameMode,
				gameStartTimestamp: row.match.gameStartTimestamp,
				gameDuration: row.match.gameDuration,
				participants: row.match.participants
			}));
			const streak = calculateStreak(matchRows.map((row) => row.win));
			const championPool = await this.container.prisma.matchParticipant.findMany({
				where: { puuid: account.puuid, match: { queueId: { in: [400, 420, 430, 440, 480, 490, 700] } } },
				orderBy: { match: { gameStartTimestamp: 'desc' } },
				take: 100
			});
			const championStats = new Map<number, { games: number; wins: number; championName: string }>();
			const masteryPoints = new Map(masteries.map((mastery) => [mastery.championId, mastery.championPoints]));
			for (const match of championPool) {
				const current = championStats.get(match.championId) ?? { games: 0, wins: 0, championName: match.championName };
				current.games++;
				if (match.win) current.wins++;
				championStats.set(match.championId, current);
			}

			const image = await renderProfileImage({
				displayName: target.globalName ?? target.username,
				gameName: account.gameName,
				tagLine: account.tagLine,
				region: account.region,
				summonerLevel: account.summonerLevel ?? 0,
				profileIconId: account.profileIconId ?? 0,
				solo: solo ? { tier: solo.tier, rank: solo.division, leaguePoints: solo.lp, wins: solo.wins, losses: solo.losses } : undefined,
				flex: flex ? { tier: flex.tier, rank: flex.division, leaguePoints: flex.lp, wins: flex.wins, losses: flex.losses } : undefined,
				tft: tft ? { tier: tft.tier, rank: tft.division, leaguePoints: tft.lp, wins: tft.wins, losses: tft.losses } : undefined,
				matches,
				masteries: masteries.map((mastery) => ({ championId: mastery.championId, championPoints: mastery.championPoints, championLevel: mastery.championLevel })),
				championStats: [...championStats.entries()].map(([championId, stats]) => ({ championId, ...stats, masteryPoints: masteryPoints.get(championId) ?? 0 })).sort((a, b) => b.games - a.games),
				badges: [...new Set(awards.map((award) => award.key))],
				positions: preferences?.primaryLane ? [preferences.primaryLane] : [],
				streak
			});
			return interaction.editReply({ files: [new AttachmentBuilder(image, { name: 'profile.png' })], allowedMentions: { parse: [] } });
		} catch (error) {
			this.container.logger.error(error);
			return interaction.editReply(noticeMessage('error', 'No pude generar el perfil. Puede que todavía no haya datos sincronizados; probá de nuevo cuando termine la sincronización inicial.'));
		}
	}
}

function calculateStreak(results: boolean[]): { type: 'WIN' | 'LOSS' | 'NONE'; count: number } {
	if (!results.length) return { type: 'NONE', count: 0 };
	const first = results[0];
	let count = 0;
	for (const result of results) { if (result !== first) break; count++; }
	return { type: first ? 'WIN' : 'LOSS', count };
}
