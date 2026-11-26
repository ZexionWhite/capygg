import { createLogger } from '../logger.js';

export type RiotRequestPriority = 'critical' | 'normal' | 'background';

export interface RiotQueueActiveRequest {
	priority: RiotRequestPriority;
	region: string;
	method: string;
	startedAt: number;
}

export interface RiotQueueSnapshot {
	active: number;
	maxConcurrent: number;
	activeRequests: RiotQueueActiveRequest[];
	pendingByRegion: Record<string, number>;
	completed: number;
	failed: number;
	pending: number;
	pendingByPriority: Record<RiotRequestPriority, number>;
	oldestPendingMs: number;
	nextRateLimitDelayMs: number;
}

type QueueEntry = {
    priority: RiotRequestPriority;
    region: string;
    method: string;
    sequence: number;
    queuedAt: number;
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

class RiotRequestQueue {
    private readonly pending: QueueEntry[] = [];
    private active = 0;
    private readonly activeRequests = new Map<number, RiotQueueActiveRequest>();
    private completed = 0;
    private failed = 0;
    private sequence = 0;
    private wakeTimer: ReturnType<typeof setTimeout> | undefined;

    public getSnapshot(): RiotQueueSnapshot {
        const now = Date.now();
        const pendingByPriority: Record<RiotRequestPriority, number> = { critical: 0, normal: 0, background: 0 };
        const pendingByRegion: Record<string, number> = {};
        for (const entry of this.pending) {
            pendingByPriority[entry.priority]++;
            pendingByRegion[entry.region] = (pendingByRegion[entry.region] ?? 0) + 1;
        }
        const oldest = this.pending.reduce((value, entry) => Math.min(value, entry.sequence), Number.POSITIVE_INFINITY);
        const oldestEntry = this.pending.find((entry) => entry.sequence === oldest);
        const delays = this.pending.map((entry) => riotRateLimiter.getDelayMs(entry.region, entry.method));
        return {
            active: this.active,
            maxConcurrent: MAX_CONCURRENT_REQUESTS,
            activeRequests: [...this.activeRequests.values()],
            pendingByRegion,
            completed: this.completed,
            failed: this.failed,
            pending: this.pending.length,
            pendingByPriority,
            oldestPendingMs: oldestEntry ? Math.max(0, now - oldestEntry.queuedAt) : 0,
            nextRateLimitDelayMs: delays.length ? Math.min(...delays) : 0
        };
    }

    public enqueue<T>(
        priority: RiotRequestPriority,
        region: string,
        method: string,
        task: () => Promise<T>
    ): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            this.pending.push({
                priority,
                region,
                method,
                sequence: this.sequence++,
                queuedAt: Date.now(),
                task: async () => task(),
                resolve: (value) => resolve(value as T),
                reject
            });

            this.pending.sort(
                (left, right) =>
                    PRIORITY_WEIGHT[left.priority] - PRIORITY_WEIGHT[right.priority] ||
                    left.sequence - right.sequence
            );

            if (this.active >= MAX_CONCURRENT_REQUESTS || this.pending.length > 1) {
                logger.debug(
                    `Queued ${priority} request (${this.pending.length} waiting, ${this.active} active).`
                );
            }

            this.pump();
        });
    }

    private pump(): void {
        if (this.wakeTimer) {
            clearTimeout(this.wakeTimer);
            this.wakeTimer = undefined;
        }

        while (this.active < MAX_CONCURRENT_REQUESTS && this.pending.length > 0) {
            const eligibleIndex = this.pending.findIndex(
                (entry) => riotRateLimiter.getDelayMs(entry.region, entry.method) <= 0
            );

            if (eligibleIndex === -1) {
                this.scheduleWakeUp();
                return;
            }

            const [entry] = this.pending.splice(eligibleIndex, 1);
            if (!entry) continue;

            this.active++;
            const startedAt = Date.now();
            this.activeRequests.set(entry.sequence, { priority: entry.priority, region: entry.region, method: entry.method, startedAt });

            void entry
                .task()
                .then((value) => { this.completed++; entry.resolve(value); }, (error) => { this.failed++; entry.reject(error); })
                .finally(() => {
                    this.active--;
                    this.activeRequests.delete(entry.sequence);
                    this.pump();
                });
        }
    }

    private scheduleWakeUp(): void {
        if (this.active >= MAX_CONCURRENT_REQUESTS || this.pending.length === 0) return;

        const nextDelay = Math.min(
            ...this.pending.map((entry) =>
                riotRateLimiter.getDelayMs(entry.region, entry.method)
            )
        );

        if (!Number.isFinite(nextDelay)) return;

        const delay = Math.max(1, nextDelay);

        logger.debug(
            `No eligible requests; queue will resume in ${delay}ms (${this.pending.length} waiting).`
        );

        this.wakeTimer = setTimeout(() => {
            this.wakeTimer = undefined;
            this.pump();
        }, delay);
    }
}

type RateWindow = {
    limit: number;
    seconds: number;
    blockedUntil: number;
};

/**
 * Aprende los límites comunicados por Riot y mantiene bloqueos por host y método.
 */
class RiotRateLimiter {
    private readonly applicationWindows = new Map<string, RateWindow[]>();
    private readonly methodWindows = new Map<string, RateWindow[]>();
    private readonly serviceBlockedUntil = new Map<string, number>();
    private readonly applicationBlockedUntil = new Map<string, number>();
    private readonly methodBlockedUntil = new Map<string, number>();

    /**
     * Devuelve cuánto falta para que una solicitud pueda ejecutarse.
     * Cero significa que puede entrar a la cola de ejecución.
     */
    public getDelayMs(region: string, method: string): number {
        const blockedUntil = Math.max(
            this.serviceBlockedUntil.get(region) ?? 0,
            this.applicationBlockedUntil.get(region) ?? 0,
            this.methodBlockedUntil.get(`${region}:${method}`) ?? 0,
            ...(this.applicationWindows.get(region) ?? []).map(
                (window) => window.blockedUntil
            ),
            ...(this.methodWindows.get(`${region}:${method}`) ?? []).map(
                (window) => window.blockedUntil
            )
        );

        return Math.max(0, blockedUntil - Date.now());
    }

    /**
     * Se conserva para otros consumidores que necesiten esperar explícitamente.
     * La cola principal no debe llamar a este método dentro de una tarea activa.
     */
    public async waitUntilAllowed(region: string, method: string): Promise<void> {
        while (true) {
            const delay = this.getDelayMs(region, method);
            if (delay <= 0) return;

            logger.debug(`Waiting ${delay}ms for Riot rate limit (${region} · ${method}).`);
            await new Promise<void>((resolve) => setTimeout(resolve, delay));
        }
    }

    public observeResponse(
        region: string,
        method: string,
        response: Response,
        requestStartedAt: number
    ): void {
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
            this.applicationBlockedUntil.set(
                region,
                Math.max(this.applicationBlockedUntil.get(region) ?? 0, blockedUntil)
            );
            this.blockWindows(this.applicationWindows.get(region), blockedUntil);
        } else if (limitType === 'method') {
            const key = `${region}:${method}`;

            this.methodBlockedUntil.set(
                key,
                Math.max(this.methodBlockedUntil.get(key) ?? 0, blockedUntil)
            );
            this.blockWindows(this.methodWindows.get(key), blockedUntil);
        } else {
            // Los límites de servicio y los 429 sin tipo se acotan al host de Riot.
            this.serviceBlockedUntil.set(
                region,
                Math.max(this.serviceBlockedUntil.get(region) ?? 0, blockedUntil)
            );
        }

        logger.warn(
            `Riot rate limit reached (${limitType ?? 'unknown'}); pausing ${region} for ${retryAfter}ms.`
        );
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

            const observedBlock =
                count && count.value >= limit.value
                    ? requestStartedAt + limit.seconds * 1_000
                    : 0;

            return {
                limit: limit.value,
                seconds: limit.seconds,
                blockedUntil: Math.max(
                    previous[index]?.blockedUntil ?? 0,
                    observedBlock
                )
            };
        });

        store.set(key, windows);
    }

    private parseHeader(value: string): Array<{ value: number; seconds: number }> {
        return value.split(',').flatMap((part) => {
            const [rawValue, rawSeconds] = part.trim().split(':');
            const limit = Number(rawValue);
            const seconds = Number(rawSeconds);

            return Number.isFinite(limit) &&
                limit > 0 &&
                Number.isFinite(seconds) &&
                seconds > 0
                ? [{ value: limit, seconds }]
                : [];
        });
    }

    private blockWindows(
        windows: RateWindow[] | undefined,
        blockedUntil: number
    ): void {
        for (const window of windows ?? []) {
            window.blockedUntil = Math.max(window.blockedUntil, blockedUntil);
        }
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
