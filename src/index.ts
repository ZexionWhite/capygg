import './lib/setup.js';
import './lib/container.js';
import { startBot, stopBot } from './lib/bot.js';

void startBot().catch(async () => {
	await stopBot().catch(() => undefined);
	process.exitCode = 1;
});

const shutdown = async () => {
	await stopBot().catch(() => undefined);
	process.exit(0);
};

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
