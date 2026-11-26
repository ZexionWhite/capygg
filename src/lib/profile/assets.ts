import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { rootDir } from '../constants.js';
import { dataDragonVersion } from '../ddragon.js';
import { createLogger } from '../logger.js';

export { dataDragonVersion };

const log = createLogger('profile');

export const ASSETS_DIR = join(rootDir, 'assets');

/* -------------------------------------------------------------------------- */
/*  Assets locales (carpeta /assets del repo)                                  */
/* -------------------------------------------------------------------------- */

interface LocalImageOptions {
	/** Lado máximo en px al que se reduce la imagen antes de embeberla. */
	size?: number;
	/** Recorta el margen transparente. */
	trim?: boolean;
}

const MISSING_RECHECK_MS = 60_000;
const localCache = new Map<string, { value: string | null; checkedAt: number }>();

/**
 * Devuelve un asset local como data URI, ya recortado y reducido (los emblemas de rank vienen en 1280x720 / 2560x1440).
 * Si el archivo no existe devuelve `null` y el render usa su fallback vectorial. Un archivo faltante se vuelve a buscar
 * cada 60 s, así que alcanza con copiarlo a la carpeta, sin reiniciar el bot.
 */
export async function localImage(relativePath: string, { size = 256, trim = true }: LocalImageOptions = {}): Promise<string | null> {
	const key = `${relativePath}|${size}|${trim}`;
	const cached = localCache.get(key);
	if (cached && (cached.value !== null || Date.now() - cached.checkedAt < MISSING_RECHECK_MS)) return cached.value;

	let value: string | null = null;
	const file = join(ASSETS_DIR, relativePath);

	if (existsSync(file)) {
		try {
			let pipeline = sharp(await readFile(file));
			if (trim) pipeline = sharp(await pipeline.trim().toBuffer());
			const buffer = await pipeline.resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
			value = `data:image/png;base64,${buffer.toString('base64')}`;
		} catch (error) {
			log.warn(`No pude procesar el asset "${relativePath}", se usa el fallback.`, error);
		}
	}

	localCache.set(key, { value, checkedAt: Date.now() });
	return value;
}

export function rankEmblemPath(tier: string | null | undefined): string {
	return `lol/ranks/${(tier || 'unranked').toLowerCase()}.png`;
}

const POSITION_FILES = { TOP: 'top', JUNGLE: 'jungle', MID: 'middle', ADC: 'bottom', SUPPORT: 'utility', FILL: 'fill' } as const;
export type PositionKey = keyof typeof POSITION_FILES;

export function positionIconPath(position: PositionKey): string {
	return `lol/positions/${POSITION_FILES[position]}.png`;
}

/* -------------------------------------------------------------------------- */
/*  Fuentes                                                                    */
/* -------------------------------------------------------------------------- */

const FONT_NAMES = ['Inter-Regular', 'Inter-Medium', 'Inter-SemiBold', 'Rajdhani-Medium', 'Rajdhani-SemiBold', 'Rajdhani-Bold'] as const;
let fontFiles: string[] | null = null;

/** Fuentes incluidas en el repo (assets/fonts). El render no depende de las fuentes del sistema. */
export function bundledFontFiles(): string[] {
	if (fontFiles) return fontFiles;

	const present = FONT_NAMES.map((name) => join(ASSETS_DIR, 'fonts', `${name}.ttf`)).filter((file) => existsSync(file));
	if (present.length < FONT_NAMES.length) {
		log.warn(`Faltan fuentes en assets/fonts (${present.length}/${FONT_NAMES.length}). El perfil se va a ver con otra tipografía.`);
	}

	fontFiles = present;
	return present;
}

/* -------------------------------------------------------------------------- */
/*  Imágenes remotas (Data Dragon)                                             */
/* -------------------------------------------------------------------------- */

const REMOTE_TIMEOUT_MS = 4_000;
const REMOTE_MAX_BYTES = 3 * 1024 * 1024;
const REMOTE_FAILURE_TTL_MS = 5 * 60_000;
const REMOTE_CACHE_LIMIT = 800;
const remoteCache = new Map<string, Promise<string | null>>();

/** Descarga una imagen como data URI. Cachea los aciertos y los fallos (por 5 min). Nunca lanza: devuelve `null`. */
export function remoteImage(url: string): Promise<string | null> {
	const existing = remoteCache.get(url);
	if (existing) return existing;

	const request = download(url).then((result) => {
		if (result === null) setTimeout(() => remoteCache.delete(url), REMOTE_FAILURE_TTL_MS).unref();
		return result;
	});

	remoteCache.set(url, request);
	if (remoteCache.size > REMOTE_CACHE_LIMIT) {
		const oldest = remoteCache.keys().next().value;
		if (oldest !== undefined) remoteCache.delete(oldest);
	}

	return request;
}

/** Prueba cada URL en orden y devuelve la primera imagen que se pudo descargar. Los fallos quedan cacheados, así que reintentar es barato. */
export async function remoteImageAny(urls: readonly string[]): Promise<string | null> {
	for (const url of urls) {
		const result = await remoteImage(url);
		if (result) return result;
	}
	return null;
}

function sniffImageType(bytes: Buffer): string | null {
	if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
	if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
	if (bytes.length > 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
	if (bytes.length > 6 && bytes.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
	return null;
}

async function download(url: string): Promise<string | null> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REMOTE_TIMEOUT_MS);

	try {
		const response = await fetch(url, { signal: controller.signal });
		if (!response.ok) return null;

		const bytes = Buffer.from(await response.arrayBuffer());
		if (bytes.length === 0 || bytes.length > REMOTE_MAX_BYTES) return null;

		// El formato se detecta por los bytes: no se confía en el header ni en la extensión (ej. una página de error con 200).
		const contentType = sniffImageType(bytes);
		if (!contentType) return null;

		return `data:${contentType};base64,${bytes.toString('base64')}`;
	} catch {
		return null;
	} finally {
		clearTimeout(timeout);
	}
}

export function ddragonUrls(version: string) {
	const base = `https://ddragon.leagueoflegends.com/cdn/${version}/img`;
	return {
		champion: (name: string) => `${base}/champion/${encodeURIComponent(name)}.png`,
		item: (id: number) => `${base}/item/${id}.png`,
		spell: (file: string) => `${base}/spell/${encodeURIComponent(file)}`,
		profileIcon: (id: number) => `${base}/profileicon/${id}.png`,
		/** Community Dragon publica los íconos nuevos apenas salen, sin esperar al próximo parche de Data Dragon. */
		profileIconFallback: (id: number) => `https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/profile-icons/${id}.jpg`,
		splash: (name: string) => `https://ddragon.leagueoflegends.com/cdn/img/champion/splash/${encodeURIComponent(name)}_0.jpg`
	};
}
