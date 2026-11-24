import { createLogger } from '../logger';

export type RiotRequestPriority = 'critical' | 'normal' | 'background';

type QueueEntry = {
	priority: RiotRequestPriority;
	sequence: number;
	task: () => Promise<unknown>;
	resolve: (value: unknown) => void;
	reject: (reason: unknown) => void;
};

const PRIORITY_WEIGHT: Record<RiotRequestPriority, number> = {
	critical: 0,
	normal: 1,
	background: 2
};

const MAX_CONCURRENT_REQUESTS = 2;
const logger = createLogger('riot.queue');

/** Cola en memoria: prioriza solicitudes de usuarios sin bloquear las que ya están en curso. */
class RiotRequestQueue {
	private readonly pending: QueueEntry[] = [];
	private active = 0;
	private sequence = 0;

	public enqueue<T>(priority: RiotRequestPriority, task: () => Promise<T>): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			this.pending.push({
				priority,
				sequence: this.sequence++,
				task: async () => task(),
				resolve: (value) => resolve(value as T),
				reject
			});
			if (this.active >= MAX_CONCURRENT_REQUESTS || this.pending.length > 1) {
				logger.debug(`Queued ${priority} request (${this.pending.length} waiting).`);
			}
			this.pending.sort(
				(left, right) => PRIORITY_WEIGHT[left.priority] - PRIORITY_WEIGHT[right.priority] || left.sequence - right.sequence
			);
			this.pump();
		});
	}

	private pump(): void {
		while (this.active < MAX_CONCURRENT_REQUESTS && this.pending.length > 0) {
			const entry = this.pending.shift();
			if (!entry) return;

			this.active++;
			void entry
				.task()
				.then(entry.resolve, entry.reject)
				.finally(() => {
					this.active--;
					this.pump();
				});
		}
	}
}

type RateWindow = { limit: number; seconds: number; blockedUntil: number };

/** Aprende los límites comunicados por Riot y mantiene bloqueos por host y método. */
class RiotRateLimiter {
	private readonly applicationWindows = new Map<string, RateWindow[]>();
	private readonly methodWindows = new Map<string, RateWindow[]>();
	private readonly serviceBlockedUntil = new Map<string, number>();
	private readonly applicationBlockedUntil = new Map<string, number>();
	private readonly methodBlockedUntil = new Map<string, number>();

	public async waitUntilAllowed(region: string, method: string): Promise<void> {
		while (true) {
			const now = Date.now();
			const blockedUntil = Math.max(
				this.serviceBlockedUntil.get(region) ?? 0,
				this.applicationBlockedUntil.get(region) ?? 0,
				this.methodBlockedUntil.get(`${region}:${method}`) ?? 0,
				...(this.applicationWindows.get(region) ?? []).map((window) => window.blockedUntil),
				...(this.methodWindows.get(`${region}:${method}`) ?? []).map((window) => window.blockedUntil)
			);
			const delay = blockedUntil - now;
			if (delay <= 0) return;
			logger.debug(`Waiting ${delay}ms for Riot rate limit (${region} · ${method}).`);
			await new Promise((resolve) => setTimeout(resolve, delay));
		}
	}

	public observeResponse(region: string, method: string, response: Response, requestStartedAt: number): void {
		this.updateWindows(
			this.applicationWindows,
			region,
			response.headers.get('X-App-Rate-Limit'),
			response.headers.get('X-App-Rate-Limit-Count'),
			requestStartedAt
		);
		this.updateWindows(
			this.methodWindows,
			`${region}:${method}`,
			response.headers.get('X-Method-Rate-Limit'),
			response.headers.get('X-Method-Rate-Limit-Count'),
			requestStartedAt
		);

		if (response.status !== 429) return;

		const retryAfter = this.retryAfterMs(response.headers.get('Retry-After')) ?? 5_000;
		const limitType = response.headers.get('X-Rate-Limit-Type')?.toLowerCase();
		const blockedUntil = Date.now() + retryAfter;

		if (limitType === 'application') {
			this.applicationBlockedUntil.set(region, Math.max(this.applicationBlockedUntil.get(region) ?? 0, blockedUntil));
			this.blockWindows(this.applicationWindows.get(region), blockedUntil);
		} else if (limitType === 'method') {
			this.methodBlockedUntil.set(`${region}:${method}`, Math.max(this.methodBlockedUntil.get(`${region}:${method}`) ?? 0, blockedUntil));
			this.blockWindows(this.methodWindows.get(`${region}:${method}`), blockedUntil);
		} else {
			// Service limits and 429s without a type are conservatively scoped to this Riot host.
			this.serviceBlockedUntil.set(region, Math.max(this.serviceBlockedUntil.get(region) ?? 0, blockedUntil));
		}

		logger.warn(`Riot rate limit reached (${limitType ?? 'unknown'}); pausing ${region} for ${retryAfter}ms.`);
	}

	public getRetryAfterMs(response: Response): number | null {
		return this.retryAfterMs(response.headers.get('Retry-After'));
	}

	private updateWindows(
		store: Map<string, RateWindow[]>,
		key: string,
		limitsHeader: string | null,
		countsHeader: string | null,
		requestStartedAt: number
	): void {
		if (!limitsHeader || !countsHeader) return;

		const limits = this.parseHeader(limitsHeader);
		const counts = this.parseHeader(countsHeader);
		if (limits.length === 0 || limits.length !== counts.length) return;

		const previous = store.get(key) ?? [];
		const windows = limits.map((limit, index) => {
			const count = counts[index];
			const observedBlock = count && count.value >= limit.value ? requestStartedAt + limit.seconds * 1_000 : 0;
			return {
				limit: limit.value,
				seconds: limit.seconds,
				blockedUntil: Math.max(previous[index]?.blockedUntil ?? 0, observedBlock)
			};
		});
		store.set(key, windows);
	}

	private parseHeader(value: string): Array<{ value: number; seconds: number }> {
		return value.split(',').flatMap((part) => {
			const [rawValue, rawSeconds] = part.trim().split(':');
			const limit = Number(rawValue);
			const seconds = Number(rawSeconds);
			return Number.isFinite(limit) && limit > 0 && Number.isFinite(seconds) && seconds > 0 ? [{ value: limit, seconds }] : [];
		});
	}

	private blockWindows(windows: RateWindow[] | undefined, blockedUntil: number): void {
		for (const window of windows ?? []) window.blockedUntil = Math.max(window.blockedUntil, blockedUntil);
	}

	private retryAfterMs(value: string | null): number | null {
		if (!value) return null;
		const seconds = Number(value);
		if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
		const date = Date.parse(value);
		return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
	}
}

export const riotRequestQueue = new RiotRequestQueue();
export const riotRateLimiter = new RiotRateLimiter();
