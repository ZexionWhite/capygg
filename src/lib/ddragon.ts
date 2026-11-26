import { DATA_DRAGON_VERSION } from './constants';

const VERSIONS_URL = 'https://ddragon.leagueoflegends.com/api/versions.json';
const REQUEST_TIMEOUT_MS = 4_000;
const VERSION_TTL_MS = 6 * 60 * 60_000;
const VERSION_RETRY_MS = 5 * 60_000;

let known = DATA_DRAGON_VERSION;
let cache: { value: Promise<string>; fetchedAt: number } | null = null;

/** Última versión conocida de Data Dragon, sin esperar a la red (arranca con `DATA_DRAGON_VERSION`). */
export function knownDataDragonVersion(): string {
	return known;
}

/** Última versión de Data Dragon (se consulta a Riot como máximo cada 6 h). Si Riot no responde usa la última conocida. */
export function dataDragonVersion(): Promise<string> {
	if (cache && Date.now() - cache.fetchedAt < VERSION_TTL_MS) return cache.value;

	const value = fetchLatestVersion().then((version) => {
		if (version) {
			known = version;
			return version;
		}

		// Reintenta antes si falló.
		if (cache) cache.fetchedAt = Date.now() - VERSION_TTL_MS + VERSION_RETRY_MS;
		return known;
	});
	cache = { value, fetchedAt: Date.now() };
	return value;
}

async function fetchLatestVersion(): Promise<string | null> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

	try {
		const response = await fetch(VERSIONS_URL, { signal: controller.signal });
		if (!response.ok) return null;

		const list: unknown = await response.json();
		const latest = Array.isArray(list) ? list[0] : null;
		return typeof latest === 'string' && /^\d+(\.\d+){1,3}$/.test(latest) ? latest : null;
	} catch {
		return null;
	} finally {
		clearTimeout(timeout);
	}
}

/* -------------------------------------------------------------------------- */
/*  Datos estáticos por versión: hechizos de invocador y nombres de campeones  */
/* -------------------------------------------------------------------------- */

const STATIC_RETRY_MS = 5 * 60_000;
const staticCache = new Map<string, Promise<Map<never, never>>>();

async function fetchJson(url: string): Promise<unknown> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS * 2);

	try {
		const response = await fetch(url, { signal: controller.signal });
		return response.ok ? await response.json() : null;
	} catch {
		return null;
	} finally {
		clearTimeout(timeout);
	}
}

/** Cachea por versión. Si la carga falla (mapa vacío) se reintenta a los 5 min. */
function cachedStatic<K, V>(key: string, load: () => Promise<Map<K, V>>): Promise<Map<K, V>> {
	const existing = staticCache.get(key);
	if (existing) return existing as unknown as Promise<Map<K, V>>;

	const promise = load().then((result) => {
		if (result.size === 0) setTimeout(() => staticCache.delete(key), STATIC_RETRY_MS).unref();
		return result;
	});
	staticCache.set(key, promise as unknown as Promise<Map<never, never>>);
	return promise;
}

/** ID numérico del hechizo -> archivo de imagen (ej. 4 -> `SummonerFlash.png`). */
export function summonerSpellFiles(version: string): Promise<Map<number, string>> {
	return cachedStatic(`spells:${version}`, async () => {
		const files = new Map<number, string>();
		const json = (await fetchJson(`https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/summoner.json`)) as {
			data?: Record<string, { key?: string; image?: { full?: string } }>;
		} | null;

		for (const spell of Object.values(json?.data ?? {})) {
			const id = Number(spell.key);
			if (Number.isInteger(id) && spell.image?.full) files.set(id, spell.image.full);
		}
		return files;
	});
}

/** Id de Riot -> nombre para mostrar (ej. `MonkeyKing` -> `Wukong`, `AurelionSol` -> `Aurelion Sol`). */
export function championDisplayNames(version: string): Promise<Map<string, string>> {
	return cachedStatic(`champions:${version}`, async () => {
		const names = new Map<string, string>();
		const json = (await fetchJson(`https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/champion.json`)) as {
			data?: Record<string, { id?: string; name?: string }>;
		} | null;

		for (const champion of Object.values(json?.data ?? {})) {
			if (champion.id && champion.name) names.set(champion.id, champion.name);
		}
		return names;
	});
}
