import { container, LogLevel, SapphireClient } from '@sapphire/framework';
import { GatewayIntentBits } from 'discord.js';
import { prisma } from './prisma.js';
import { instrumentLogger, telemetry } from './telemetry.js';
import type { ApiProvider } from './telemetry.js';
import { stopCronJobs } from './scheduler.js';

container.prisma = prisma;

let client: SapphireClient | null = null;
let loginPromise: Promise<SapphireClient> | null = null;
let fetchInstrumented = false;

function instrumentExternalFetch(): void {
	if (fetchInstrumented) return;
	fetchInstrumented = true;
	const originalFetch = globalThis.fetch.bind(globalThis);
	globalThis.fetch = async (...args: Parameters<typeof fetch>): Promise<Response> => {
		const input = args[0];
		let provider: ApiProvider | null = null;
		try {
			const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
			const hostname = new URL(requestUrl).hostname;
			if (hostname.endsWith('api.riotgames.com')) provider = 'riot';
			else if (hostname.endsWith('ddragon.leagueoflegends.com')) provider = 'ddragon';
			else if (hostname.endsWith('communitydragon.org')) provider = 'communitydragon';
		} catch {
			return originalFetch(...args);
		}
		if (!provider) return originalFetch(...args);
		const startedAt = Date.now();
		let status = 599;
		try {
			const response = await originalFetch(...args);
			status = response.status;
			return response;
		} finally {
			telemetry.recordApiRequest(provider, Date.now() - startedAt, status);
		}
	};
}

function getConfiguredLogLevel(): string {
	return (process.env.LOG_LEVEL?.trim() || (process.env.NODE_ENV === 'production' ? 'info' : 'debug')).toLowerCase();
}

function createClient(silentLogs: boolean): SapphireClient {
	instrumentExternalFetch();
	const configuredLogLevel = getConfiguredLogLevel();
	const logLevels: Record<string, LogLevel> = {
		trace: LogLevel.Trace,
		debug: LogLevel.Debug,
		info: LogLevel.Info,
		warn: LogLevel.Warn,
		error: LogLevel.Error,
		fatal: LogLevel.Fatal,
		none: LogLevel.None
	};
	const instance = new SapphireClient({
		defaultPrefix: '!',
		caseInsensitiveCommands: true,
		logger: { level: logLevels[configuredLogLevel] ?? LogLevel.Info },
		intents: [
			GatewayIntentBits.DirectMessages,
			GatewayIntentBits.GuildMessages,
			GatewayIntentBits.GuildMembers,
			GatewayIntentBits.Guilds,
			GatewayIntentBits.MessageContent
		],
		loadMessageCommandListeners: true
	});

	instrumentLogger(instance.logger, silentLogs);
	if (container.logger !== instance.logger) instrumentLogger(container.logger, silentLogs);
	instrumentDiscordRest(instance);
	instance.on('interactionCreate', (interaction) => {
		if (interaction.isChatInputCommand()) telemetry.recordCommand();
	});
	return instance;
}

function instrumentDiscordRest(instance: SapphireClient): void {
	const rest = instance.rest as unknown as { request: (...args: unknown[]) => Promise<unknown> };
	const original = rest.request.bind(rest);
	rest.request = async (...args: unknown[]) => {
		const startedAt = Date.now();
		let status = 200;
		try {
			return await original(...args);
		} catch (error) {
			status = 500;
			const candidate = error as { status?: number; code?: number };
			if (typeof candidate?.status === 'number') status = candidate.status;
			else if (typeof candidate?.code === 'number' && candidate.code >= 400) status = candidate.code;
			throw error;
		} finally {
			telemetry.recordApiRequest('discord', Date.now() - startedAt, status);
		}
	};
}

export async function startBot(options: { silentLogs?: boolean } = {}): Promise<SapphireClient> {
	if (client?.isReady()) return client;
	if (loginPromise) return loginPromise;
	const instance = client ?? createClient(options.silentLogs ?? false);
	client = instance;
	loginPromise = (async () => {
		try {
			instance.logger.info(`Logging in (LOG_LEVEL=${getConfiguredLogLevel()})`);
			await instance.login();
			instance.logger.info('CapyGG connected to Discord Gateway.');
			return instance;
		} catch (error) {
			instance.logger.fatal(error);
			await instance.destroy();
			client = null;
			throw error;
		} finally {
			loginPromise = null;
		}
	})();
	return loginPromise;
}

export function getBotClient(): SapphireClient | null {
	return client;
}

export async function stopBot(): Promise<void> {
	stopCronJobs();
	if (client) {
		const current = client;
		client = null;
		await current.destroy();
	}
	await prisma.$disconnect();
}
