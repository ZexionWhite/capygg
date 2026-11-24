import { ApplyOptions } from '@sapphire/decorators';
import { Command } from '@sapphire/framework';
import { ApplicationCommandOptionType, AttachmentBuilder } from 'discord.js';
import { QUEUES } from '../lib/constants';
import { RiotApiError, riotClient } from '../lib/riot/client';
import { riotErrorMessage } from '../lib/riot/messages';
import { renderProfileImage } from '../lib/profile/render';
import { isRegion } from '../lib/types';
import type { Region } from '../lib/types';
import type { RiotLeagueEntry, RiotMatchSummary } from '../lib/types/riot';
import { noticeMessage } from '../lib/ui';
import { getSummonerRefreshingPuuid, syncRiotId } from '../lib/riot/account-sync';

@ApplyOptions<Command.Options>({
	description: 'Show a League of Legends profile'
})
export class ProfileCommand extends Command {
	public override registerApplicationCommands(registry: Command.Registry) {
		registry.registerChatInputCommand({
			name: this.name,
			description: this.description,
			options: [
				{
					name: 'usuario',
					description: 'Miembro cuyo perfil querés consultar',
					type: ApplicationCommandOptionType.User,
					required: false
				}
			]
		});
	}

	public override async chatInputRun(interaction: Command.ChatInputCommandInteraction) {
		await interaction.deferReply();

		try {
			const target = interaction.options.getUser('usuario') ?? interaction.user;
			const stored = await this.container.prisma.riotAccount.findUnique({ where: { discordId: target.id } });
			if (!stored) return interaction.editReply(noticeMessage('warning', `${target} no tiene una cuenta de League of Legends vinculada.`));
			if (!isRegion(stored.region)) return interaction.editReply(noticeMessage('error', 'La cuenta vinculada tiene una región inválida.'));
			const region: Region = stored.region;

			const { account: linked, summoner } = await getSummonerRefreshingPuuid(stored, region);
			const account = await syncRiotId(linked, region);
			const [leagueEntries, tftEntries, matchIds, tftMatchIds] = await Promise.all([
				riotClient.getLeagueEntriesByPuuid(account.puuid, region),
				this.getTftEntries(account.puuid, region),
				riotClient.getMatchIdsByPuuid(account.puuid, region, 10),
				this.getTftMatchIds(account.puuid, region, 10)
			]);
			const matches = await this.getRecentMatches(account.puuid, region, matchIds, tftMatchIds);

			const image = await renderProfileImage({
				displayName: target.globalName ?? target.username,
				gameName: account.gameName,
				tagLine: account.tagLine,
				region,
				summonerLevel: summoner.summonerLevel,
				profileIconId: summoner.profileIconId,
				solo: leagueEntries.find((entry) => entry.queueType === QUEUES.SOLO),
				flex: leagueEntries.find((entry) => entry.queueType === QUEUES.FLEX),
				tft: tftEntries.find((entry) => entry.queueType.startsWith('RANKED_TFT')),
				matches
			});

			return interaction.editReply({
				files: [new AttachmentBuilder(image, { name: 'profile.png' })],
				allowedMentions: { parse: [] }
			});
		} catch (error) {
			this.container.logger.error(error);
			if (error instanceof RiotApiError) return interaction.editReply(noticeMessage('error', riotErrorMessage(error)));
			return interaction.editReply(noticeMessage('error', 'No pude generar el perfil. Intentá nuevamente más tarde.'));
		}
	}

	private async getTftEntries(puuid: string, region: Region): Promise<RiotLeagueEntry[]> {
		try {
			return await riotClient.getTftLeagueEntriesByPuuid(puuid, region);
		} catch (error) {
			if (this.isTftUnavailable(error)) return [];
			throw error;
		}
	}

	private async getTftMatchIds(puuid: string, region: Region, count = 5): Promise<string[]> {
		try {
			return await riotClient.getTftMatchIdsByPuuid(puuid, region, count);
		} catch (error) {
			if (this.isTftUnavailable(error)) return [];
			throw error;
		}
	}

	/** 404 = sin datos de TFT; 403 = la key no tiene acceso a TFT. En ambos casos el perfil sigue sin TFT. */
	private isTftUnavailable(error: unknown): boolean {
		return error instanceof RiotApiError && (error.kind === 'NOT_FOUND' || error.status === 403);
	}

	private async getRecentMatches(puuid: string, region: Region, matchIds: string[], tftMatchIds: string[]): Promise<RiotMatchSummary[]> {
		const results = await Promise.allSettled([
			...matchIds.map((matchId) => riotClient.getMatchById(matchId, puuid, region)),
			...tftMatchIds.map((matchId) => riotClient.getTftMatchById(matchId, puuid, region))
		]);

		return results
			.filter((result): result is PromiseFulfilledResult<RiotMatchSummary> => result.status === 'fulfilled')
			.map((result) => result.value)
			.sort((left, right) => right.gameStartTimestamp - left.gameStartTimestamp)
			.slice(0, 5);
	}
}