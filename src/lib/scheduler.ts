import { schedule } from 'node-cron';
import { createLogger } from './logger';

const logger = createLogger('cron');

interface CronJobOptions {
	runOnStart?: boolean;
	timezone?: string;
}

interface RegisteredJob {
	task: ReturnType<typeof schedule>;
}

const jobs = new Map<string, RegisteredJob>();

export function scheduleCronJob(
	name: string,
	expression: string,
	handler: () => Promise<string | void>,
	options: CronJobOptions = {}
): void {
	jobs.get(name)?.task.stop();

	let running = false;

	const execute = async (): Promise<void> => {
		if (running) {
			logger.warn(`${name} skipped: previous execution is still running.`);
			return;
		}

		running = true;
		const startedAt = Date.now();

		logger.info(`${name} started.`);

		try {
			const summary = await handler();
			const duration = Date.now() - startedAt;

			logger.info(
				`${name} completed in ${duration}ms${summary ? ` · ${summary}` : ''}.`
			);
		} catch (error) {
			logger.error(`${name} failed after ${Date.now() - startedAt}ms.`, error);
		} finally {
			running = false;
		}
	};

	const task = schedule(
		expression,
		() => void execute(),
		options.timezone ? { timezone: options.timezone } : undefined
	);

	jobs.set(name, { task });

	logger.info(
		`${name} scheduled (${expression})${options.timezone ? ` · ${options.timezone}` : ''}.`
	);

	if (options.runOnStart) void execute();
}

export function stopCronJobs(): void {
	for (const [name, job] of jobs) {
		job.task.stop();
		logger.info(`${name} stopped.`);
	}

	jobs.clear();
}
