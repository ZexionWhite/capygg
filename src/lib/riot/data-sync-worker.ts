
import { createLogger } from '../logger.js';
import { refreshAllPlayerAutomation } from '../player/automation.js';
import { scheduleCronJob } from '../scheduler.js';
import { syncChampionMasteries, syncMatchBackfill, syncMatchHistory } from './data-sync.js';

const logger = createLogger('riot.data-worker');

let workerStarted = false;
let masterySyncRunning = false;
let matchSyncRunning = false;

/** Starts the Riot data refresh jobs once the Discord client is ready. */
export function startRiotDataWorkers(): void {
	if (workerStarted) return;
	workerStarted = true;

	scheduleCronJob(
		'riot-champion-mastery-sync',
		'0 0 */6 * * *',
		runMasterySync,
		{ runOnStart: true }
	);

	scheduleCronJob(
		'riot-match-history-sync',
		'0 */10 * * * *',
		runMatchSync,
		{ runOnStart: true }
	);

	// Deep history backfill (up to 500 matches per account). A newly linked player is picked up within a few minutes.
	scheduleCronJob(
		'riot-match-backfill',
		'0 */3 * * * *',
		() => syncMatchBackfill(),
		{ runOnStart: true }
	);

	// Lane, OTP and distinction roles. Runs after the data syncs have had time to store new matches.
	scheduleCronJob(
		'player-automation',
		'0 */15 * * * *',
		refreshAllPlayerAutomation,
		{ runOnStart: true }
	);

	logger.info('Champion mastery, match history, match backfill and player automation workers started.');
}

async function runMasterySync(): Promise<string> {
	if (masterySyncRunning) {
		logger.warn('Champion mastery sync skipped: previous execution is still running.');
		return 'Skipped: previous execution still running';
	}

	masterySyncRunning = true;

	try {
		return await syncChampionMasteries();
	} finally {
		masterySyncRunning = false;
	}
}

async function runMatchSync(): Promise<string> {
	if (matchSyncRunning) {
		logger.warn('Match history sync skipped: previous execution is still running.');
		return 'Skipped: previous execution still running';
	}

	matchSyncRunning = true;

	try {
		return await syncMatchHistory();
	} finally {
		matchSyncRunning = false;
	}
}
