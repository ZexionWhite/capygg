import { schedule } from 'node-cron';
import { createLogger } from './logger.js';

const logger = createLogger('cron');

interface CronJobOptions {
	runOnStart?: boolean;
	timezone?: string;
}

interface RegisteredJob {
	task: ReturnType<typeof schedule>;
	expression: string;
	timezone?: string;
	registeredAt: number;
	lastRunAt: number | null;
	lastDurationMs: number | null;
	runCount: number;
	failureCount: number;
	running: boolean;
	lastStatus: 'scheduled' | 'running' | 'success' | 'failed' | 'skipped';
	lastSummary: string | null;
	execute: () => Promise<void>;
}

export interface CronJobSnapshot {
	name: string;
	expression: string;
	timezone?: string;
	registeredAt: number;
	lastRunAt: number | null;
	lastDurationMs: number | null;
	runCount: number;
	failureCount: number;
	running: boolean;
	lastStatus: RegisteredJob['lastStatus'];
	lastSummary: string | null;
	nextRunAt: number | null;
}

const jobs = new Map<string, RegisteredJob>();

export function scheduleCronJob(
	name: string,
	expression: string,
	handler: () => Promise<string | void>,
	options: CronJobOptions = {}
): void {
	jobs.get(name)?.task.stop();

	const job: RegisteredJob = {
		task: undefined as unknown as ReturnType<typeof schedule>,
		expression,
		timezone: options.timezone,
		registeredAt: Date.now(),
		lastRunAt: null,
		lastDurationMs: null,
		runCount: 0,
		failureCount: 0,
		running: false,
		lastStatus: 'scheduled',
		lastSummary: null,
		execute: async () => {
			if (job.running) {
				job.lastStatus = 'skipped';
				logger.warn(`${name} skipped: previous execution is still running.`);
				return;
			}
			job.running = true;
			job.lastStatus = 'running';
			job.lastRunAt = Date.now();
			job.runCount++;
			const startedAt = Date.now();
			logger.info(`${name} started.`);
			try {
				const summary = await handler();
				job.lastDurationMs = Date.now() - startedAt;
				job.lastStatus = 'success';
				job.lastSummary = summary ?? null;
				logger.info(`${name} completed in ${job.lastDurationMs}ms${summary ? ` · ${summary}` : ''}.`);
			} catch (error) {
				job.lastDurationMs = Date.now() - startedAt;
				job.lastStatus = 'failed';
				job.failureCount++;
				job.lastSummary = error instanceof Error ? error.message : String(error);
				logger.error(`${name} failed after ${job.lastDurationMs}ms.`, error);
			} finally {
				job.running = false;
			}
		}
	};

	job.task = schedule(
		expression,
		() => void job.execute(),
		options.timezone ? { timezone: options.timezone } : undefined
	);
	jobs.set(name, job);
	logger.info(`${name} scheduled (${expression})${options.timezone ? ` · ${options.timezone}` : ''}.`);
	if (options.runOnStart) void job.execute();
}

export function getCronJobs(): CronJobSnapshot[] {
	return [...jobs.entries()].map(([name, job]) => {
		const task = job.task as unknown as { getNextRun?: () => Date | null };
		let nextRunAt: number | null = null;
		try {
			const next = task.getNextRun?.();
			if (next instanceof Date) nextRunAt = next.getTime();
		} catch {
			// Some node-cron versions do not expose the next scheduled date.
		}
		return {
			name,
			expression: job.expression,
			timezone: job.timezone,
			registeredAt: job.registeredAt,
			lastRunAt: job.lastRunAt,
			lastDurationMs: job.lastDurationMs,
			runCount: job.runCount,
			failureCount: job.failureCount,
			running: job.running,
			lastStatus: job.lastStatus,
			lastSummary: job.lastSummary,
			nextRunAt
		};
	});
}

export async function runCronJob(name: string): Promise<boolean> {
	const job = jobs.get(name);
	if (!job || job.running) return false;
	await job.execute();
	return true;
}

export function stopCronJobs(): void {
	for (const [name, job] of jobs) {
		job.task.stop();
		logger.info(`${name} stopped.`);
	}
	jobs.clear();
}
