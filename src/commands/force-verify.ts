import { ApplyOptions } from '@sapphire/decorators';
import { Command } from '@sapphire/framework';
import { ApplicationCommandOptionType, MessageFlags, PermissionFlagsBits, type Guild, type GuildMember } from 'discord.js';
import { QUEUES, REGIONS } from '../lib/constants';
import { RiotApiError, riotClient } from '../lib/riot/client';
import { riotErrorMessage } from '../lib/riot/messages';
import { InvalidRiotIdError, parseRiotId } from '../lib/riot/riot-id';
import { isRegion, normalizeEloTier } from '../lib/types';
import type { Region } from '../lib/types';
import { noticeMessage } from '../lib/ui';

const regionChoices = Object.keys(REGIONS).map((region) => ({ name: region, value: region }));

@ApplyOptions<Command.Options>({
	description: 'Force link a member League of Legends account',
	requiredUserPermissions: PermissionFlagsBits.Administrator
})
export class ForceVerifyCommand extends Command {
	public override registerApplicationCommands(registry: Command.Registry) {
		registry.registerChatInputCommand({
			name: this.name,
			description: this.description,
			defaultMemberPermissions: PermissionFlagsBits.Administrator,
			options: [
				{
					name: 'usuario',
					description: 'Miembro al que se vinculará la cuenta',
					type: ApplicationCommandOptionType.User,
					required: true
				},
				{
					name: 'riot_id',
					description: 'Riot ID con formato Nombre#TAG',
					type: ApplicationCommandOptionType.String,
					required: true
				},
				{
					name: 'region',
					description: 'Región de la cuenta',
					type: ApplicationCommandOptionType.String,
					required: true,
					choices: regionChoices
				}
			]
		});
	}

	public override async chatInputRun(interaction: Command.ChatInputCommandInteraction) {
		await interaction.deferReply({ flags: MessageFlags.Ephemeral });

		try {
			if (!interaction.guild) return interaction.editReply(noticeMessage('error', 'Este comando solo puede ejecutarse dentro de un servidor.'));
			const user = interaction.options.getUser('usuario', true);
			let member: GuildMember;
			try {
				member = await interaction.guild.members.fetch(user.id);
			} catch (error) {
				this.container.logger.error(error);
				return interaction.editReply(noticeMessage('error', 'No pude encontrar ese miembro dentro del servidor.'));
			}
			if (!member) return interaction.editReply(noticeMessage('error', 'El usuario seleccionado no pertenece a este servidor.'));

			const { gameName, tagLine } = parseRiotId(interaction.options.getString('riot_id', true));
			const regionValue = interaction.options.getString('region', true).toUpperCase();
			if (!isRegion(regionValue))
				return interaction.editReply(noticeMessage('error', `Región inválida. Usá una de estas: ${Object.keys(REGIONS).join(', ')}.`));
			const region: Region = regionValue;

			const account = await riotClient.getAccountByRiotId(gameName, tagLine, region, 'critical');
			const summoner = await riotClient.getSummonerByPuuid(account.puuid, region, 'critical');
			const linkedAccount = await this.container.prisma.riotAccount.findUnique({ where: { puuid: account.puuid } });
			if (linkedAccount && linkedAccount.discordId !== user.id) {
				return interaction.editReply(
					noticeMessage('error', 'Esa cuenta de Riot ya está vinculada a otro usuario. Usá `/force-unlink` primero si corresponde.')
				);
			}

			const previousAccount = await this.container.prisma.riotAccount.findUnique({ where: { discordId: user.id } });
			await this.container.prisma.$transaction(async (transaction) => {
				await transaction.verificationChallenge.deleteMany({ where: { discordId: user.id } });
				await transaction.riotAccount.deleteMany({ where: { discordId: user.id } });
				await transaction.riotAccount.create({
					data: {
						puuid: account.puuid,
						discordId: user.id,
						gameName: account.gameName,
						tagLine: account.tagLine,
						region,
						profileIconId: summoner.profileIconId,
						summonerLevel: summoner.summonerLevel
					}
				});
			});

			if (previousAccount && previousAccount.region !== region) {
				try {
					await this.removeRegionRole(interaction.guild, member, previousAccount.region);
				} catch (error) {
					this.container.logger.error(error);
				}
			}
			let roleAssigned = false;
			try {
				roleAssigned = await this.assignRegionRole(interaction.guild, member, region);
			} catch (error) {
				this.container.logger.error(error);
			}
			let eloRoleAssigned = false;
			let soloRank;
			try {
				soloRank = (await riotClient.getLeagueEntriesByPuuid(account.puuid, region, 'critical')).find((entry) => entry.queueType === QUEUES.SOLO);
			} catch (error) {
				this.container.logger.error(error);
			}
			const soloTier = soloRank ? normalizeEloTier(soloRank.tier) : null;
			if (soloTier) {
				try {
					eloRoleAssigned = await this.assignEloRole(interaction.guild, member, soloTier);
				} catch (error) {
					this.container.logger.error(error);
				}
			}
			const lines = [`Se vinculó **${account.gameName}#${account.tagLine}** a ${user}.`];
			if (!roleAssigned) lines.push('**Rol de región:** no se pudo asignar. Ejecutá `/setup` y verificá los permisos del bot.');
			if (soloRank && !eloRoleAssigned) lines.push('**Rol de elo:** no se pudo asignar. Ejecutá `/setup` y verificá los permisos del bot.');
			return interaction.editReply(noticeMessage('success', lines.join('\n'), 'Cuenta vinculada forzosamente'));
		} catch (error) {
			this.container.logger.error(error);
			if (error instanceof InvalidRiotIdError) {
				return interaction.editReply(
					noticeMessage('error', 'El Riot ID debe tener el formato `Nombre#TAG` y respetar los límites de longitud.')
				);
			}
			if (error instanceof RiotApiError) return interaction.editReply(noticeMessage('error', riotErrorMessage(error)));
			return interaction.editReply(noticeMessage('error', 'No pude completar la vinculación forzada. Revisá los logs para más detalles.'));
		}
	}

	private async removeRegionRole(guild: Guild, member: GuildMember, value: string) {
		if (!isRegion(value)) return;
		const storedRole = await this.container.prisma.guildRole.findUnique({
			where: { guildId_key: { guildId: guild.id, key: value } }
		});
		if (!storedRole) return;
		const role = await guild.roles.fetch(storedRole.roleId);
		if (role) await member.roles.remove(role);
	}

	private async assignRegionRole(guild: Guild, member: GuildMember, region: Region): Promise<boolean> {
		const storedRole = await this.container.prisma.guildRole.findUnique({
			where: { guildId_key: { guildId: guild.id, key: region } }
		});
		if (!storedRole) return false;
		const role = await guild.roles.fetch(storedRole.roleId);
		if (!role) return false;
		await member.roles.add(role);
		return true;
	}

	private async assignEloRole(guild: Guild, member: GuildMember, tier: string): Promise<boolean> {
		const storedRole = await this.container.prisma.guildRole.findUnique({
			where: { guildId_key: { guildId: guild.id, key: tier } }
		});
		if (!storedRole) return false;
		const role = await guild.roles.fetch(storedRole.roleId);
		if (!role) return false;
		await member.roles.add(role);
		return true;
	}
}