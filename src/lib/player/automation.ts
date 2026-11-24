import { container } from '@sapphire/framework';
import type { Guild, GuildMember } from 'discord.js';
import { createLogger } from '../logger';

const logger = createLogger('player-automation');

const SR_QUEUES = [400, 420, 430, 440, 480, 490, 700];
const ARAM_QUEUES = [450, 720, 2400];

const LANE_KEYS = ['TOP', 'JUNGLE', 'MID', 'ADC', 'SUPPORT'] as const;

type LaneKey = (typeof LANE_KEYS)[number];

/**
 * Re-evaluates lane, OTP and profile distinctions
 * after new match/mastery data is persisted.
 */
export async function refreshPlayerAutomation(puuid: string): Promise<void> {
	const account = await container.prisma.riotAccount.findUnique({
		where: { puuid }
	});

	if (!account) return;

	const guildRecords = await container.prisma.guild.findMany();

	const [masteries, matches] = await Promise.all([
		container.prisma.championMastery.findMany({
			where: { puuid },
			orderBy: { championPoints: 'desc' }
		}),
		container.prisma.matchParticipant.findMany({
			where: {
				puuid,
				match: {
					queueId: { in: [...SR_QUEUES, ...ARAM_QUEUES] }
				}
			},
			include: { match: true },
			orderBy: {
				match: { gameStartTimestamp: 'desc' }
			},
			take: 250
		})
	]);

	const srMatches = matches.filter((entry) => SR_QUEUES.includes(entry.match.queueId));
	const lastHundred = srMatches.slice(0, 100);

	const championCounts = countBy(lastHundred, (entry) => String(entry.championId));
	const topChampion = Object.entries(championCounts).sort((a, b) => b[1] - a[1])[0];

	const topMastery = masteries.find((entry) => entry.championId === Number(topChampion?.[0]));

	const otpEarnedByStats = Boolean(
		topMastery &&
		topMastery.championPoints > 1_000_000 &&
		lastHundred.length >= 100 &&
		(topChampion?.[1] ?? 0) / 100 >= 0.7
	);

	const lane = detectLane(srMatches);

	const [aramCount, soloCount, mayhemCount] = await Promise.all([
		container.prisma.matchParticipant.count({
			where: {
				puuid,
				match: { queueId: { in: ARAM_QUEUES } }
			}
		}),
		container.prisma.matchParticipant.count({
			where: {
				puuid,
				match: { queueId: 420 }
			}
		}),
		container.prisma.matchParticipant.count({
			where: {
				puuid,
				match: {
					OR: [{ queueId: 2400 }, { gameMode: { contains: 'MAYHEM' } }]
				}
			}
		})
	]);

	for (const guildRecord of guildRecords) {
		// Prisma Guild is a database record.
		// Fetch the actual Discord.js Guild before managing roles or members.
		const guild = await container.client.guilds.fetch(guildRecord.id).catch(() => null);

		if (!guild) continue;

		const override = await container.prisma.otpOverride.findFirst({
			where: {
				guildId: guildRecord.id,
				puuid
			}
		});

		const otpEarned = otpEarnedByStats || Boolean(override);

		const member = await safeFetchMember(guild, account.discordId);

		if (!member) continue;

		// OTP remains an independent Discord role, not a distinction.
		await syncRole(guild, member, 'OTP', otpEarned);

		// Persist the player's detected primary lane.
		await container.prisma.playerGuildPreference.upsert({
			where: {
				guildId_discordId: {
					guildId: guildRecord.id,
					discordId: account.discordId
				}
			},
			create: {
				guildId: guildRecord.id,
				discordId: account.discordId,
				primaryLane: lane
			},
			update: {
				primaryLane: lane
			}
		});

		// Synchronize lane roles.
		for (const key of LANE_KEYS) {
			await syncRole(guild, member, `LANE_${key}`, lane === key);
		}

		// Only actual distinctions are awarded here.
		await award(guildRecord.id, account.discordId, 'ARAM_PLAYER', aramCount >= 20);
		await award(guildRecord.id, account.discordId, 'ARAM_MAYHEM_ENJOYER', mayhemCount >= 1);
		await award(guildRecord.id, account.discordId, 'SOLOQ_ABUSER', soloCount >= 50);

		await syncActiveDistinctionRole(guild, member, account.discordId);
	}
}

function detectLane(
	matches: Array<{
		teamPosition: string | null;
		individualPosition: string | null;
	}>
): LaneKey | null {
	const counts: Record<LaneKey, number> = {
		TOP: 0,
		JUNGLE: 0,
		MID: 0,
		ADC: 0,
		SUPPORT: 0
	};

	for (const match of matches) {
		const position = (match.teamPosition || match.individualPosition || '').toUpperCase();

		const key = position === 'UTILITY' ? 'SUPPORT' : position === 'BOTTOM' ? 'ADC' : position;

		if (LANE_KEYS.includes(key as LaneKey)) {
			counts[key as LaneKey]++;
		}
	}

	const best = LANE_KEYS
		.map((key) => [key, counts[key]] as const)
		.sort((a, b) => b[1] - a[1])[0];

	const validGames = LANE_KEYS.reduce((total, key) => total + counts[key], 0);

	return validGames >= 40 && best[1] / validGames >= 0.35 ? best[0] : null;
}

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
	const result: Record<string, number> = {};

	for (const item of items) {
		const value = key(item);
		result[value] = (result[value] ?? 0) + 1;
	}

	return result;
}

async function award(guildId: string, discordId: string, key: string, earned: boolean): Promise<void> {
	const current = await container.prisma.distinctionAward.findFirst({
		where: {
			guildId,
			discordId,
			key,
			revokedAt: null
		},
		orderBy: {
			awardedAt: 'asc'
		}
	});

	if (earned && !current) {
		await container.prisma.distinctionAward.create({
			data: {
				guildId,
				discordId,
				key
			}
		});
	}

	if (!earned && current) {
		await container.prisma.distinctionAward.updateMany({
			where: {
				guildId,
				discordId,
				key,
				revokedAt: null
			},
			data: {
				revokedAt: new Date()
			}
		});
	}
}

async function syncActiveDistinctionRole(guild: Guild, member: GuildMember, discordId: string): Promise<void> {
	const active = await container.prisma.distinctionAward.findFirst({
		where: {
			guildId: guild.id,
			discordId,
			revokedAt: null,
			key: { not: 'OTP' }
		},
		orderBy: {
			awardedAt: 'asc'
		}
	});

	const roles = await container.prisma.guildRole.findMany({
		where: {
			guildId: guild.id,
			kind: 'DISTINCTION'
		}
	});

	const desiredKey = active ? `DIST_${active.key}` : null;

	for (const stored of roles) {
		const role = await guild.roles.fetch(stored.roleId).catch(() => null);

		if (!role) continue;

		const shouldHave = stored.key === desiredKey;

		if (shouldHave && !member.roles.cache.has(role.id)) {
			await member.roles.add(role).catch((error) =>
				logger.warn(`Could not add distinction ${stored.key}.`, error)
			);
		}

		if (!shouldHave && member.roles.cache.has(role.id)) {
			await member.roles.remove(role).catch((error) =>
				logger.warn(`Could not remove distinction ${stored.key}.`, error)
			);
		}
	}
}

async function syncRole(guild: Guild, member: GuildMember, key: string, shouldHave: boolean): Promise<void> {
	const stored = await container.prisma.guildRole.findUnique({
		where: {
			guildId_key: {
				guildId: guild.id,
				key
			}
		}
	});

	if (!stored) return;

	const role = await guild.roles.fetch(stored.roleId).catch(() => null);

	if (!role) return;

	if (shouldHave && !member.roles.cache.has(role.id)) {
		await member.roles.add(role).catch((error) => logger.warn(`Could not add ${key}.`, error));
	}

	if (!shouldHave && member.roles.cache.has(role.id)) {
		await member.roles.remove(role).catch((error) => logger.warn(`Could not remove ${key}.`, error));
	}
}

async function safeFetchMember(guild: Guild, discordId: string): Promise<GuildMember | null> {
	try {
		return await guild.members.fetch(discordId);
	} catch {
		return null;
	}
}
