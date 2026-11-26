import { createLogger } from '../logger.js';
import { scheduleCronJob } from '../scheduler.js';

const DATA_DRAGON_BASE_URL = 'https://ddragon.leagueoflegends.com';
const DATA_DRAGON_LOCALE = 'es_AR';
const REQUEST_TIMEOUT_MS = 10_000;

const logger = createLogger('riot.champion-catalog');

export interface ChampionCatalogEntry {
	id: number;
	name: string;
}

interface DataDragonChampion {
	key: string;
	name: string;
}

interface DataDragonChampionResponse {
	data: Record<string, DataDragonChampion>;
}

let champions: readonly ChampionCatalogEntry[] = [];
let currentVersion: string | null = null;
let refreshPromise: Promise<string> | null = null;
let workerStarted = false;

function normalizeSearch(value: string): string {
	return value
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.trim();
}

async function fetchJson<T>(url: string): Promise<T> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

	try {
		const response = await fetch(url, { signal: controller.signal });

		if (!response.ok) {
			throw new Error(`Data Dragon returned HTTP ${response.status}.`);
		}

		return (await response.json()) as T;
	} finally {
		clearTimeout(timeout);
	}
}

/**
 * Downloads the latest champion catalog from Riot Data Dragon.
 * Existing cached data is preserved if the refresh fails.
 */
export function refreshChampionCatalog(): Promise<string> {
	if (refreshPromise) return refreshPromise;

	refreshPromise = (async () => {
		const versions = await fetchJson<unknown>(
			`${DATA_DRAGON_BASE_URL}/api/versions.json`
		);

		if (!Array.isArray(versions) || typeof versions[0] !== 'string') {
			throw new Error('Data Dragon returned an invalid versions list.');
		}

		const version = versions[0];

		const response = await fetchJson<DataDragonChampionResponse>(
			`${DATA_DRAGON_BASE_URL}/cdn/${version}/data/${DATA_DRAGON_LOCALE}/champion.json`
		);

		if (!response.data || typeof response.data !== 'object') {
			throw new Error('Data Dragon returned an invalid champion catalog.');
		}

		const nextChampions = Object.values(response.data)
			.map((champion) => ({
				id: Number(champion.key),
				name: champion.name
			}))
			.filter(
				(champion) =>
					Number.isSafeInteger(champion.id) &&
					champion.id > 0 &&
					typeof champion.name === 'string' &&
					champion.name.length > 0
			)
			.sort((a, b) => a.name.localeCompare(b.name));

		if (nextChampions.length === 0) {
			throw new Error('Data Dragon returned an empty champion catalog.');
		}

		champions = nextChampions;
		currentVersion = version;

		logger.info(
			`Champion catalog loaded: ${champions.length} champions (Data Dragon ${version}).`
		);

		return `${champions.length} champions · Data Dragon ${version}`;
	})().finally(() => {
		refreshPromise = null;
	});

	return refreshPromise;
}

/**
 * Ensures the catalog is available before using it.
 */
async function ensureChampionCatalog(): Promise<void> {
	if (champions.length > 0) return;
	await refreshChampionCatalog();
}

/**
 * Returns up to 25 Discord autocomplete suggestions.
 */
export async function getChampionAutocompleteChoices(
	query: string
): Promise<{ name: string; value: string }[]> {
	await ensureChampionCatalog();

	const normalizedQuery = normalizeSearch(query);

	const matches = champions
		.filter((champion) => {
			if (!normalizedQuery) return true;

			return (
				normalizeSearch(champion.name).includes(normalizedQuery) ||
				String(champion.id).includes(normalizedQuery)
			);
		})
		.sort((a, b) => {
			if (!normalizedQuery) return 0;

			const aStartsWith = normalizeSearch(a.name).startsWith(normalizedQuery);
			const bStartsWith = normalizeSearch(b.name).startsWith(normalizedQuery);

			if (aStartsWith !== bStartsWith) return aStartsWith ? -1 : 1;

			return a.name.localeCompare(b.name);
		})
		.slice(0, 25);

	return matches.map((champion) => ({
		name: `${champion.name} (${champion.id})`,
		value: String(champion.id)
	}));
}

/**
 * Resolves a numeric champion ID against the current catalog.
 */
export async function getChampionById(
	championId: number
): Promise<ChampionCatalogEntry | null> {
	await ensureChampionCatalog();

	return champions.find((champion) => champion.id === championId) ?? null;
}

/**
 * Starts periodic catalog refreshes.
 */
export function startChampionCatalogWorker(): void {
	if (workerStarted) return;
	workerStarted = true;

	scheduleCronJob(
		'riot-champion-catalog-refresh',
		'0 0 */6 * * *',
		refreshChampionCatalog,
		{ runOnStart: true }
	);
}

/** Returns the currently cached Data Dragon version. */
export function getChampionCatalogVersion(): string | null {
	return currentVersion;
}
