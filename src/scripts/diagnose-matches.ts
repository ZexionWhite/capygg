
import 'dotenv/config';

import { container } from '@sapphire/framework';
import { riotClient } from '../lib/riot/client';

const originalLogger = container.logger;

container.logger = {
	debug: (...args: unknown[]) => console.debug('[DEBUG]', ...args),
	info: (...args: unknown[]) => console.info('[INFO]', ...args),
	warn: (...args: unknown[]) => console.warn('[WARN]', ...args),
	error: (...args: unknown[]) => console.error('[ERROR]', ...args)
} as typeof container.logger;

async function main(): Promise<void> {
	const matches = [
		'LA2_1626598071',
		'LA2_1626583189'
	];

	try {
		for (const matchId of matches) {
			try {
				const details = await riotClient.getMatchDetails(
					matchId,
					'LAS',
					'background'
				);

				console.log(`\n${matchId}: ${details.participants.length} participants`);

				for (const participant of details.participants) {
					console.log({
						puuid: participant.puuid.length <= 3
                            ? participant.puuid
                            : '[PLAYER_PUUID]',
						championName: participant.championName,
						teamId: participant.teamId,
						teamPosition: participant.teamPosition
					});
				}
			} catch (error) {
				console.error(`Failed to diagnose ${matchId}:`, error);
			}
		}
	} finally {
		container.logger = originalLogger;
	}
}

main().catch(console.error);
