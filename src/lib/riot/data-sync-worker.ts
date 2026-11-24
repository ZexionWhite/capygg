
import { createLogger } from '../logger';
import { scheduleCronJob } from '../scheduler';
import { syncChampionMasteries, syncMatchHistory } from './data-sync';

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

	logger.info('Champion mastery and match history workers started.');
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
