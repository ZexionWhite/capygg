import os from 'node:os';
import { prisma } from '../lib/prisma.js';
import { riotRequestQueue } from '../lib/riot/request-queue.js';
import { telemetry } from '../lib/telemetry.js';
import { getBotClient } from '../lib/bot.js';

export interface OverviewData {
	accounts: number;
	guilds: number;
	pendingVerifications: number;
	matches: number;
	participants: number;
	commands: number;
	ping: number;
	queue: ReturnType<typeof riotRequestQueue.getSnapshot>;
	memoryMb: number;
	totalMemoryMb: number;
	cpuPercent: number | null;
	uptimeSeconds: number;
}

export interface AccountRow {
	puuid: string;
	discordId: string;
	gameName: string;
	tagLine: string;
	region: string;
	linkedAt: Date;
	soloRank: string;
	flexRank: string;
	level: number | null;
	matchCount: number;
}

export interface GuildRow {
	id: string;
	name: string;
	memberCount: number;
	cachedMembers: number;
	verifiedCount: number;
	verifiedIsExact: boolean;
	configured: boolean;
}

let previousCpuSample: { idle: number; total: number } | null = null;

function sampleCpuUsage(): number | null {
	const cpus = os.cpus();
	if (!cpus.length) return null;
	const sample = cpus.reduce((total, cpu) => {
		const times = cpu.times;
		return { idle: total.idle + times.idle, total: total.total + times.user + times.nice + times.sys + times.idle + times.irq };
	}, { idle: 0, total: 0 });
	const previous = previousCpuSample;
	previousCpuSample = sample;
	if (!previous) return null;
	const totalDelta = sample.total - previous.total;
	const idleDelta = sample.idle - previous.idle;
	if (totalDelta <= 0) return null;
	return Number((100 * (1 - idleDelta / totalDelta)).toFixed(1));
}

export async function loadOverview(): Promise<OverviewData> {
	const client = getBotClient();
	const [accounts, pendingVerifications, matches, participants] = await Promise.all([
		prisma.riotAccount.count(),
		prisma.verificationChallenge.count(),
		prisma.matchRecord.count(),
		prisma.matchParticipant.count()
	]);
	const memory = process.memoryUsage();
	return {
		accounts,
		guilds: client?.guilds.cache.size ?? 0,
		pendingVerifications,
		matches,
		participants,
		commands: telemetry.getCommandCount(),
		ping: client?.ws.ping ?? -1,
		queue: riotRequestQueue.getSnapshot(),
		memoryMb: Math.round(memory.rss / 1024 / 1024),
		totalMemoryMb: Math.round(os.totalmem() / 1024 / 1024),
		cpuPercent: sampleCpuUsage(),
		uptimeSeconds: Math.floor(process.uptime())
	};
}

export async function loadAccounts(): Promise<AccountRow[]> {
	const accounts = await prisma.riotAccount.findMany({
		orderBy: { linkedAt: 'desc' }
	});

	if (!accounts.length) return [];

	const puuids = accounts.map((account) => account.puuid);

	const [snapshots, matchCounts] = await Promise.all([
		prisma.rankSnapshot.findMany({
			where: { puuid: { in: puuids } },
			orderBy: { createdAt: 'desc' }
		}),
		prisma.matchParticipant.groupBy({
			by: ['puuid'],
			where: { puuid: { in: puuids } },
			_count: { _all: true }
		})
	]);

	const latest = new Map<string, { SOLO?: string; FLEX?: string }>();

	for (const snapshot of snapshots) {
		const entry = latest.get(snapshot.puuid) ?? {};

		if (snapshot.queue === 'RANKED_SOLO_5x5' && !entry.SOLO) {
			entry.SOLO = `${snapshot.tier} ${snapshot.division} · ${snapshot.lp} LP`;
		}

		if (snapshot.queue === 'RANKED_FLEX_SR' && !entry.FLEX) {
			entry.FLEX = `${snapshot.tier} ${snapshot.division} · ${snapshot.lp} LP`;
		}

		latest.set(snapshot.puuid, entry);
	}

	const matchesByPuuid = new Map(
		matchCounts.map((entry) => [entry.puuid, entry._count._all])
	);

	return accounts.map((account) => ({
		puuid: account.puuid,
		discordId: account.discordId,
		gameName: account.gameName,
		tagLine: account.tagLine,
		region: account.region,
		linkedAt: account.linkedAt,
		soloRank: latest.get(account.puuid)?.SOLO ?? 'Unranked',
		flexRank: latest.get(account.puuid)?.FLEX ?? 'Unranked',
		level: account.summonerLevel,
		matchCount: matchesByPuuid.get(account.puuid) ?? 0
	}));
}

export async function loadGuilds(): Promise<GuildRow[]> {
	const client = getBotClient();
	if (!client) return [];
	const [verifiedAccounts, configuredGuilds] = await Promise.all([
		prisma.riotAccount.findMany({ select: { discordId: true } }),
		prisma.guild.findMany({ select: { id: true } })
	]);
	const verifiedIds = new Set(verifiedAccounts.map((account) => account.discordId));
	const configuredIds = new Set(configuredGuilds.map((guild) => guild.id));
	return [...client.guilds.cache.values()].map((guild) => ({
		id: guild.id,
		name: guild.name,
		memberCount: guild.memberCount,
		cachedMembers: guild.members.cache.size,
		verifiedCount: guild.members.cache.filter((member) => verifiedIds.has(member.id)).size,
		verifiedIsExact: guild.members.cache.size >= guild.memberCount,
		configured: configuredIds.has(guild.id)
	})).sort((a, b) => a.name.localeCompare(b.name));
}

export async function fetchGuildMemberStats(guildId: string): Promise<GuildRow | null> {
	const client = getBotClient();
	const guild = client?.guilds.cache.get(guildId);
	if (!guild) return null;
	await guild.members.fetch();
	const verifiedAccounts = await prisma.riotAccount.findMany({ select: { discordId: true } });
	const verifiedIds = new Set(verifiedAccounts.map((account) => account.discordId));
	const configured = await prisma.guild.findUnique({ where: { id: guildId }, select: { id: true } });
	return {
		id: guild.id,
		name: guild.name,
		memberCount: guild.memberCount,
		cachedMembers: guild.members.cache.size,
		verifiedCount: guild.members.cache.filter((member) => verifiedIds.has(member.id)).size,
		verifiedIsExact: guild.members.cache.size >= guild.memberCount,
		configured: Boolean(configured)
	};
}

export async function loadDatabaseStats(): Promise<Record<string, number>> {
	const [accounts, ranks, matches, participants, challenges, guilds, masteries, reports] = await Promise.all([
		prisma.riotAccount.count(),
		prisma.rankSnapshot.count(),
		prisma.matchRecord.count(),
		prisma.matchParticipant.count(),
		prisma.verificationChallenge.count(),
		prisma.guild.count(),
		prisma.championMastery.count(),
		prisma.errorReport.count()
	]);
	return { accounts, ranks, matches, participants, challenges, guilds, masteries, reports };
}

export function getRuntimeSettings(): Array<{ name: string; value: string }> {
	const keys = ['NODE_ENV', 'LOG_LEVEL', 'RIOT_API_KEY', 'DISCORD_TOKEN', 'DATABASE_URL'];
	return keys.map((name) => ({
		name,
		value: name.endsWith('_KEY') || name.endsWith('_TOKEN') || name === 'DATABASE_URL'
			? (process.env[name] ? 'Configured · value hidden' : 'Not configured')
			: (process.env[name] ?? 'Default')
	}));
}

export function formatDuration(seconds: number): string {
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const remaining = seconds % 60;
	if (hours) return `${hours}h ${minutes}m`;
	if (minutes) return `${minutes}m ${remaining}s`;
	return `${remaining}s`;
}

export function formatTime(timestamp: number | null): string {
	if (!timestamp) return '—';
	return new Date(timestamp).toLocaleTimeString('en-GB', { hour12: false });
}


export function getMetricsSnapshot() {
	return telemetry.getApiMetrics();
}
