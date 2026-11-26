import { EventEmitter } from 'node:events';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
export type ApiProvider = 'riot' | 'discord' | 'ddragon' | 'communitydragon';

export interface LogEntry {
	id: number;
	timestamp: number;
	level: LogLevel;
	scope: string;
	message: string;
}

export interface ApiMetricSnapshot {
	provider: ApiProvider;
	requestsPerMinute: number;
	totalRequests: number;
	errors: number;
	rateLimited: number;
	errorRate: number;
	averageLatencyMs: number;
	p95LatencyMs: number;
	lastRequestAt: number | null;
	requestsByInterval: number[];
	errorsLastMinute: number;
	rateLimitedLastMinute: number;
	lastStatus: number | null;
}

interface ApiRequestRecord {
	timestamp: number;
	durationMs: number;
	status: number;
}

const MAX_LOGS = 500;
const WINDOW_MS = 60_000;
const LATENCY_SAMPLE_SIZE = 200;
const providers: ApiProvider[] = ['riot', 'discord', 'ddragon', 'communitydragon'];

class Telemetry extends EventEmitter {
	private sequence = 0;
	private readonly logs: LogEntry[] = [];
	private readonly requests = new Map<ApiProvider, ApiRequestRecord[]>(providers.map((provider): [ApiProvider, ApiRequestRecord[]] => [provider, []]));
	private readonly totals = new Map<ApiProvider, { total: number; errors: number; rateLimited: number; latencies: number[] }>(providers.map((provider): [ApiProvider, { total: number; errors: number; rateLimited: number; latencies: number[] }] => [provider, { total: 0, errors: 0, rateLimited: 0, latencies: [] }]));
	private commandCount = 0;

	public addLog(level: LogLevel, scope: string, message: string): void {
		const entry: LogEntry = {
			id: ++this.sequence,
			timestamp: Date.now(),
			level,
			scope,
			message: message.slice(0, 2_000)
		};
		this.logs.push(entry);
		if (this.logs.length > MAX_LOGS) this.logs.splice(0, this.logs.length - MAX_LOGS);
		this.emit('log', entry);
	}

	public getLogs(): LogEntry[] {
		return [...this.logs];
	}

	public recordApiRequest(provider: ApiProvider, durationMs: number, status: number): void {
		const now = Date.now();
		const records = this.requests.get(provider)!;
		const totals = this.totals.get(provider)!;
		records.push({ timestamp: now, durationMs, status });
		while (records.length && now - records[0]!.timestamp > WINDOW_MS) records.shift();
		totals.total++;
		if (status >= 400) totals.errors++;
		if (status === 429) totals.rateLimited++;
		totals.latencies.push(Math.max(0, durationMs));
		if (totals.latencies.length > LATENCY_SAMPLE_SIZE) totals.latencies.shift();
		this.emit('metrics');
	}

	public getApiMetrics(): ApiMetricSnapshot[] {
		const now = Date.now();
		return providers.map((provider) => {
			const records = this.requests.get(provider)!;
			const totals = this.totals.get(provider)!;
			const latencies = [...totals.latencies].sort((a, b) => a - b);
			const averageLatencyMs = latencies.length
				? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length)
				: 0;
			const p95LatencyMs = latencies.length
				? latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * 0.95) - 1)]!
				: 0;
			const errorsLastMinute = records.filter((record) => record.status >= 400 && now - record.timestamp <= WINDOW_MS).length;
			const rateLimitedLastMinute = records.filter((record) => record.status === 429 && now - record.timestamp <= WINDOW_MS).length;
			const requestsByInterval = Array.from({ length: 12 }, (_, index) => {
				const end = now - (11 - index) * 5_000;
				const start = end - 5_000;
				return records.filter((record) => record.timestamp > start && record.timestamp <= end).length;
			});
			return {
				provider,
				requestsPerMinute: records.filter((record) => now - record.timestamp <= WINDOW_MS).length,
				totalRequests: totals.total,
				errors: totals.errors,
				rateLimited: totals.rateLimited,
				errorRate: totals.total ? Number(((totals.errors / totals.total) * 100).toFixed(1)) : 0,
				averageLatencyMs,
				p95LatencyMs,
				lastRequestAt: records.length ? records[records.length - 1]!.timestamp : null,
				requestsByInterval,
				errorsLastMinute,
				rateLimitedLastMinute,
				lastStatus: records.length ? records[records.length - 1]!.status : null
			};
		});
	}

	public recordCommand(): void {
		this.commandCount++;
	}

	public getCommandCount(): number {
		return this.commandCount;
	}
}

export const telemetry = new Telemetry();

/** Wraps Sapphire's logger so the TUI can display the exact same application logs. */
export function instrumentLogger(logger: object, silent = false): void {
	const threshold = (process.env.LOG_LEVEL?.trim() || (process.env.NODE_ENV === 'production' ? 'info' : 'debug')).toLowerCase();
	const weights: Record<LogLevel, number> = { trace: 0, debug: 1, info: 2, warn: 3, error: 4, fatal: 5 };
	const minimum = threshold === 'none' ? Number.POSITIVE_INFINITY : weights[threshold as LogLevel] ?? weights.info;
	const target = logger as Record<string, unknown>;
	for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const) {
		const original = target[level];
		if (typeof original !== 'function' || (original as { __capyggWrapped?: boolean }).__capyggWrapped) continue;
		const wrapped = (...args: unknown[]) => {
			const first = args[0];
			const message = [first, ...args.slice(1)].map((value) => {
				if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
				if (typeof value === 'string') return value;
				try { return JSON.stringify(value); } catch { return String(value); }
			}).join(' ');
			if (weights[level] >= minimum) {
				const scopeMatch = message.match(/^\[([^\]]+)\]\s*/);
				telemetry.addLog(level, scopeMatch?.[1] ?? 'app', scopeMatch ? message.slice(scopeMatch[0].length) : message);
			}
			if (silent) return undefined;
			return (original as (...values: unknown[]) => unknown).apply(logger, args);
		};
		Object.defineProperty(wrapped, '__capyggWrapped', { value: true });
		target[level] = wrapped;
	}
}
