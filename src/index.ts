
import './lib/setup';
import './lib/container';

import { container, LogLevel, SapphireClient } from '@sapphire/framework';
import { GatewayIntentBits } from 'discord.js';
import { prisma } from './lib/prisma';

container.prisma = prisma;

const configuredLogLevel = (
	process.env.LOG_LEVEL?.trim() ||
	(process.env.NODE_ENV === 'production' ? 'info' : 'debug')
).toLowerCase();

const logLevels: Record<string, LogLevel> = {
	trace: LogLevel.Trace,
	debug: LogLevel.Debug,
	info: LogLevel.Info,
	warn: LogLevel.Warn,
	error: LogLevel.Error,
	fatal: LogLevel.Fatal,
	none: LogLevel.None
};

const logLevel = logLevels[configuredLogLevel] ?? LogLevel.Info;

const client = new SapphireClient({
	defaultPrefix: '!',
	caseInsensitiveCommands: true,
	logger: {
		level: logLevel
	},
	intents: [
		GatewayIntentBits.DirectMessages,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.GuildMembers,
		GatewayIntentBits.Guilds,
		GatewayIntentBits.MessageContent
	],
	loadMessageCommandListeners: true
});

const main = async () => {
	try {
		client.logger.info(`Logging in (LOG_LEVEL=${configuredLogLevel})`);
		await client.login();
		client.logger.info('logged in');
	} catch (error) {
		client.logger.fatal(error);
		await client.destroy();
		process.exit(1);
	}
};

void main();
