import { Resvg } from '@resvg/resvg-js';
import { ELO_TIERS } from '../constants.js';
import { championDisplayNames, summonerSpellFiles } from '../ddragon.js';
import { bundledFontFiles, dataDragonVersion, ddragonUrls, localImage, positionIconPath, rankEmblemPath, remoteImage, remoteImageAny } from './assets.js';
import { nextId, vectorIcon, type IconName } from './icons.js';
import { formatClock, formatRelativeTime, type ProfileDistinction, type ProfilePosition, type StreakType } from './stats.js';

/* -------------------------------------------------------------------------- */
/*  Datos que recibe el render                                                 */
/* -------------------------------------------------------------------------- */

export interface ProfileRank {
	tier: string;
	division: string;
	lp: number;
	wins: number;
	losses: number;
}

export interface ProfileMatchPlayer {
	championName: string;
	isSelf: boolean;
}

export interface ProfileMatchRow {
	win: boolean;
	remake: boolean;
	queueLabel: string;
	durationSeconds: number;
	startedAt: Date;
	championName: string;
	champLevel: number | null;
	kills: number;
	deaths: number;
	assists: number;
	cs: number | null;
	/** Hasta 6 items (sin huecos). */
	items: number[];
	/** Trinket (centinela, barrido, lente...). */
	trinket: number | null;
	/** IDs de los hechizos de invocador (sin los 0). */
	spells: number[];
	teams: { ally: ProfileMatchPlayer[]; enemy: ProfileMatchPlayer[] } | null;
	/** 0..1 */
	killParticipation: number | null;
	tag: 'MVP' | 'ACE' | null;
}

export interface ProfileChampionStat {
	championName: string;
	games: number;
	wins: number;
	masteryLevel: number | null;
}

export interface ProfileRenderData {
	/** Nombre de la cuenta de Discord: es el título grande del perfil. */
	displayName: string;
	gameName: string;
	tagLine: string;
	region: string;
	summonerLevel: number;
	profileIconId: number;
	solo?: ProfileRank;
	flex?: ProfileRank;
	tft?: ProfileRank;
	positions: ProfilePosition[];
	/** Ya filtradas y ordenadas (máximo 3). */
	distinctions: ProfileDistinction[];
	isOtp: boolean;
	/** Campeón con el que es OTP, si se conoce. */
	otpChampion: string | null;
	mainChampion: string | null;
	streak: { type: StreakType; count: number };
	recent: { wins: number; losses: number };
	matches: ProfileMatchRow[];
	championPool: ProfileChampionStat[];
	now?: Date;
}

/* -------------------------------------------------------------------------- */
/*  Constantes de diseño (medidas sobre la referencia, canvas de 1200 px)      */
/* -------------------------------------------------------------------------- */

const WIDTH = 1200;
const RENDER_SCALE = 1.5;
export const MATCH_ROWS = 5;

export const C = {
	pageTop: '#06070d',
	pageBottom: '#0a0b14',
	card: '#0b0d14',
	cardBorder: '#292c3b',
	panel: '#0e1018',
	panelBorder: '#222534',
	divider: '#1e2131',
	text: '#e1e4f0',
	strong: '#eceffa',
	muted: '#8b91a8',
	soft: '#a3a9c0',
	faint: '#646a83',
	win: '#62cf81',
	winText: '#5fe083',
	winBorder: '#1c2f27',
	loss: '#e25f6b',
	lossText: '#f0636e',
	lossBorder: '#33202a',
	neutral: '#6b7189',
	gold: '#f3b94d',
	green: '#5fe39a'
};

export type FontName = 'inter' | 'rajdhani';

/* -------------------------------------------------------------------------- */
/*  Punto de entrada                                                           */
/* -------------------------------------------------------------------------- */

interface Ctx {
	names: Map<string, string>;
	spellFiles: Map<number, string>;
	remote: Map<string, string | null>;
	local: Map<string, string | null>;
	urls: ReturnType<typeof ddragonUrls>;
	now: Date;
}

export async function renderProfileImage(data: ProfileRenderData): Promise<Buffer> {
	const version = await dataDragonVersion();
	const urls = ddragonUrls(version);
	const matches = data.matches.slice(0, MATCH_ROWS);
	const pool = data.championPool.slice(0, 4);

	const [names, spellFiles] = await Promise.all([championDisplayNames(version), summonerSpellFiles(version)]);

	const remoteUrls = new Set<string>([urls.profileIcon(data.profileIconId)]);
	if (data.mainChampion) remoteUrls.add(urls.splash(data.mainChampion));
	for (const match of matches) {
		remoteUrls.add(urls.champion(match.championName));
		for (const item of match.items) remoteUrls.add(urls.item(item));
		if (match.trinket) remoteUrls.add(urls.item(match.trinket));
		for (const spell of match.spells) {
			const file = spellFiles.get(spell);
			if (file) remoteUrls.add(urls.spell(file));
		}
		for (const player of [...(match.teams?.ally ?? []), ...(match.teams?.enemy ?? [])]) remoteUrls.add(urls.champion(player.championName));
	}
	for (const champion of pool) remoteUrls.add(urls.champion(champion.championName));

	const localPaths = new Set<string>(['lol/ranks/unranked.png', 'brand/capygg.png']);
	for (const rank of [data.solo, data.flex, data.tft]) if (rank) localPaths.add(rankEmblemPath(rank.tier));
	for (const position of data.positions) localPaths.add(positionIconPath(position.key));
	for (const name of ['crown', 'flame', 'flameGreen', 'close', 'mainChampion'] as const) localPaths.add(iconPath(name)!);
	for (const distinction of data.distinctions) localPaths.add(distinctionIconPath(distinction.key));

	const remote = new Map<string, string | null>();
	const local = new Map<string, string | null>();
	await Promise.all([
		...[...remoteUrls].map(async (url) => remote.set(url, url === urls.profileIcon(data.profileIconId) ? await remoteImageAny([url, urls.profileIconFallback(data.profileIconId)]) : await remoteImage(url))),
		...[...localPaths].map(async (path) => local.set(path, await localImage(path, { size: path.startsWith('lol/ranks') ? 320 : 128 })))
	]);

	const svg = buildSvg(data, { names, spellFiles, remote, local, urls, now: data.now ?? new Date() });
	return rasterize(svg);
}

export function rasterize(svg: string): Buffer {
	const fontFiles = bundledFontFiles();
	const resvg = new Resvg(svg, {
		fitTo: { mode: 'zoom', value: RENDER_SCALE },
		font: fontFiles.length
			? { fontFiles, loadSystemFonts: false, defaultFontFamily: 'Inter' }
			: { loadSystemFonts: true, defaultFontFamily: 'Inter' }
	});

	return resvg.render().asPng();
}

/* -------------------------------------------------------------------------- */
/*  Helpers de SVG                                                             */
/* -------------------------------------------------------------------------- */

export function esc(value: string): string {
	return value.replace(/[<>&'"]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[char] ?? char);
}

export interface TextOptions {
	font?: FontName;
	size: number;
	weight?: number;
	fill?: string;
	anchor?: 'start' | 'middle' | 'end';
	spacing?: number;
}

export function text(x: number, y: number, content: string, o: TextOptions): string {
	const family = o.font === 'rajdhani' ? 'Rajdhani' : 'Inter';
	return `<text x="${x}" y="${y}" font-family="${family}" font-size="${o.size}" font-weight="${o.weight ?? 400}" fill="${o.fill ?? C.text}"${
		o.anchor && o.anchor !== 'start' ? ` text-anchor="${o.anchor}"` : ''
	}${o.spacing ? ` letter-spacing="${o.spacing}"` : ''}>${esc(content)}</text>`;
}

/** Anchos (en em) por tipo de carácter, medidos con las fuentes incluidas. */
const WIDTHS: Record<FontName, { space: number; narrow: number; wide: number; upper: number; digit: number; lower: number }> = {
	inter: { space: 0.225, narrow: 0.287, wide: 0.935, upper: 0.64, digit: 0.646, lower: 0.559 },
	rajdhani: { space: 0.191, narrow: 0.262, wide: 0.749, upper: 0.501, digit: 0.519, lower: 0.486 }
};

/** Ancho aproximado del texto (error medio ~5%). Alcanza para dimensionar pastillas y acomodar elementos en fila. */
export function textWidth(content: string, size: number, font: FontName = 'inter', spacing = 0): number {
	const table = WIDTHS[font];
	let units = 0;
	for (const char of content) {
		if (char === ' ') units += table.space;
		else if ('iljtf.,:;|!\'·•'.includes(char)) units += table.narrow;
		else if ('mwMW'.includes(char)) units += table.wide;
		else if (/[A-Z]/.test(char)) units += table.upper;
		else if (/[0-9]/.test(char)) units += table.digit;
		else units += table.lower;
	}
	return units * size + spacing * content.length;
}

/** `MonkeyKing` -> `Wukong`; si Data Dragon no respondió, separa las mayúsculas (`MissFortune` -> `Miss Fortune`). */
function championLabel(ctx: Ctx, championName: string): string {
	return ctx.names.get(championName) ?? championName.replace(/([a-z])([A-Z])/g, '$1 $2');
}

export function truncate(value: string, max: number): string {
	return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function line(x1: number, y1: number, x2: number, y2: number, stroke = C.divider): string {
	return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="1"/>`;
}

export interface ImageOptions {
	radius?: number;
	circle?: boolean;
	fit?: 'slice' | 'meet';
	fallbackFill?: string;
	fallbackLetter?: string;
	opacity?: number;
}

export function image(href: string | null | undefined, x: number, y: number, w: number, h: number, o: ImageOptions = {}): string {
	const id = nextId('clip');
	const clip = o.circle ? `<circle cx="${x + w / 2}" cy="${y + h / 2}" r="${w / 2}"/>` : `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${o.radius ?? 0}"/>`;
	const opacity = o.opacity !== undefined ? ` opacity="${o.opacity}"` : '';
	let body: string;

	if (href) {
		body = `<image xlink:href="${href}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="${o.fit === 'meet' ? 'xMidYMid meet' : 'xMidYMid slice'}"${opacity}/>`;
	} else {
		body = `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${o.fallbackFill ?? '#1a1d2b'}"/>`;
		if (o.fallbackLetter) body += text(x + w / 2, y + h / 2 + h * 0.17, o.fallbackLetter, { font: 'rajdhani', size: h * 0.5, weight: 700, fill: C.faint, anchor: 'middle' });
	}

	return `<clipPath id="${id}">${clip}</clipPath><g clip-path="url(#${id})">${body}</g>`;
}

export function pillShape(x: number, y: number, w: number, h: number, fill: string, stroke: string): string {
	return `<rect x="${x + 0.65}" y="${y + 0.65}" width="${w - 1.3}" height="${h - 1.3}" rx="${(h - 1.3) / 2}" fill="${fill}" stroke="${stroke}" stroke-width="1.3"/>`;
}

/* -------------------------------------------------------------------------- */
/*  Íconos (asset local si existe, vector si no)                               */
/* -------------------------------------------------------------------------- */

function iconPath(name: IconName): string | null {
	switch (name) {
		case 'crown':
			return 'ui/icons/crown.png';
		case 'flame':
			return 'ui/icons/flame.png';
		case 'flameGreen':
			return 'ui/icons/flame-green.png';
		case 'close':
			return 'ui/icons/close.png';
		case 'mainChampion':
			return 'ui/icons/main-champion.png';
		case 'capybara':
			return 'brand/capygg.png';
		default:
			return null;
	}
}

function distinctionIconPath(key: string): string {
	return `ui/distinctions/${key.toLowerCase()}.png`;
}

const VECTOR_DISTINCTIONS = new Set(['otp', 'aram_player', 'aram_mayhem_enjoyer', 'soloq_abuser']);

function icon(ctx: Ctx, name: IconName, x: number, y: number, size: number): string {
	const path = iconPath(name);
	const href = path ? ctx.local.get(path) : null;
	return href ? `<image xlink:href="${href}" x="${x}" y="${y}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid meet"/>` : vectorIcon(name, x, y, size);
}

function distinctionIcon(ctx: Ctx, key: string, x: number, y: number, size: number): string {
	const href = ctx.local.get(distinctionIconPath(key));
	if (href) return `<image xlink:href="${href}" x="${x}" y="${y}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid meet"/>`;

	const lower = key.toLowerCase();
	return vectorIcon(VECTOR_DISTINCTIONS.has(lower) ? (lower as IconName) : 'distinction', x, y, size);
}

/* -------------------------------------------------------------------------- */
/*  Rank                                                                       */
/* -------------------------------------------------------------------------- */

const APEX_TIERS = new Set(['MASTER', 'GRANDMASTER', 'CHALLENGER']);

export function tierName(rank: ProfileRank | undefined): string {
	if (!rank) return 'UNRANKED';
	const tier = rank.tier.toUpperCase();
	return APEX_TIERS.has(tier) || !rank.division ? tier : `${tier} ${rank.division}`;
}

export function tierColor(rank: ProfileRank | undefined): string {
	const tier = (rank?.tier ?? 'UNRANKED').toUpperCase();
	const key = (Object.keys(ELO_TIERS) as Array<keyof typeof ELO_TIERS>).find((candidate) => candidate.toUpperCase() === tier);
	return key ? ELO_TIERS[key].color : ELO_TIERS.Unranked.color;
}

export function winRate(wins: number, losses: number): number {
	return wins + losses > 0 ? Math.round((wins / (wins + losses)) * 100) : 0;
}

function emblem(ctx: Ctx, rank: ProfileRank | undefined, x: number, y: number, size: number): string {
	const href = ctx.local.get(rankEmblemPath(rank?.tier)) ?? ctx.local.get('lol/ranks/unranked.png') ?? null;
	if (href) return `<image xlink:href="${href}" x="${x}" y="${y}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid meet"/>`;

	const color = tierColor(rank);
	return `<path d="M${x + size / 2} ${y + size * 0.1} L${x + size * 0.9} ${y + size * 0.4} L${x + size / 2} ${y + size * 0.9} L${x + size * 0.1} ${y + size * 0.4} Z" fill="${color}" opacity=".85"/>`;
}

/* -------------------------------------------------------------------------- */
/*  Secciones                                                                  */
/* -------------------------------------------------------------------------- */

const CARD_X = 20;
const CARD_W = 1160;

function card(y: number, h: number, extra = ''): string {
	return `<rect x="${CARD_X}" y="${y}" width="${CARD_W}" height="${h}" rx="16" fill="${C.card}"/>${extra}<rect x="${CARD_X + 0.5}" y="${y + 0.5}" width="${CARD_W - 1}" height="${h - 1}" rx="15.5" fill="none" stroke="${C.cardBorder}"/>`;
}

function headerCard(ctx: Ctx, data: ProfileRenderData): string {
	const top = 15;
	const height = 557;
	const out: string[] = [];
	const clip = nextId('hdr');
	const fadeX = nextId('fadeX');
	const fadeY = nextId('fadeY');
	const glow = nextId('glow');
	const blur = nextId('blur');
	const tint = tierColor(data.solo ?? data.flex);

	const splashHref = data.mainChampion ? ctx.remote.get(ctx.urls.splash(data.mainChampion)) : null;
	const iconHref = ctx.remote.get(ctx.urls.profileIcon(data.profileIconId));

	out.push(`<defs>
		<clipPath id="${clip}"><rect x="${CARD_X}" y="${top}" width="${CARD_W}" height="${height}" rx="16"/></clipPath>
		<linearGradient id="${fadeX}" gradientUnits="userSpaceOnUse" x1="300" y1="0" x2="760" y2="0"><stop offset="0" stop-color="${C.card}" stop-opacity="1"/><stop offset="1" stop-color="${C.card}" stop-opacity="0"/></linearGradient>
		<linearGradient id="${fadeY}" gradientUnits="userSpaceOnUse" x1="0" y1="250" x2="0" y2="${top + height}"><stop offset="0" stop-color="${C.card}" stop-opacity="0"/><stop offset="0.75" stop-color="${C.card}" stop-opacity="1"/></linearGradient>
		<radialGradient id="${glow}" gradientUnits="userSpaceOnUse" cx="958" cy="170" r="300"><stop offset="0" stop-color="${tint}" stop-opacity="0.22"/><stop offset="1" stop-color="${tint}" stop-opacity="0"/></radialGradient>
		<filter id="${blur}" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="26"/></filter>
	</defs>`);
	out.push(card(top, height));
	out.push('<g clip-path="url(#' + clip + ')">');

	if (splashHref) {
		out.push(`<image xlink:href="${splashHref}" x="330" y="${top - 30}" width="870" height="513" preserveAspectRatio="xMidYMid slice" opacity="0.24"/>`);
	} else if (iconHref) {
		out.push(`<image xlink:href="${iconHref}" x="560" y="${top - 140}" width="640" height="640" preserveAspectRatio="xMidYMid slice" opacity="0.2" filter="url(#${blur})"/>`);
	}
	out.push(`<rect x="${CARD_X}" y="${top}" width="${CARD_W}" height="${height}" fill="url(#${glow})"/>`);
	out.push(`<rect x="${CARD_X}" y="${top}" width="${CARD_W}" height="${height}" fill="url(#${fadeX})"/>`);
	out.push(`<rect x="${CARD_X}" y="${top}" width="${CARD_W}" height="${height}" fill="url(#${fadeY})"/>`);
	out.push('</g>');
	out.push(`<rect x="${CARD_X + 0.5}" y="${top + 0.5}" width="${CARD_W - 1}" height="${height - 1}" rx="15.5" fill="none" stroke="${C.cardBorder}"/>`);

	out.push(text(47, 46, `LEAGUE PROFILE / ${data.region.toUpperCase()}`, { size: 14, weight: 500, fill: '#6c7189', spacing: 2.4 }));

	// Ícono de invocador
	out.push(image(iconHref, 54, 77, 190, 190, { radius: 4, fallbackFill: '#1a1d2b', fallbackLetter: data.gameName.charAt(0).toUpperCase() }));
	out.push(`<rect x="55" y="78" width="188" height="188" rx="3.5" fill="none" stroke="#868aa3" stroke-width="2"/>`);

	// Nombre
	let nameSize = 60;
	const nameWidth = textWidth(data.displayName, nameSize, 'rajdhani');
	if (nameWidth > 525) nameSize = Math.max(30, Math.floor((nameSize * 525) / nameWidth));
	out.push(text(281, 146, data.displayName, { font: 'rajdhani', size: nameSize, weight: 700, fill: '#dfe3f1' }));
	out.push(text(281, 187, `${data.gameName}#${data.tagLine}${data.summonerLevel > 0 ? ` • Nivel ${data.summonerLevel}` : ''}`, { font: 'rajdhani', size: 29, weight: 500, fill: '#858ba3' }));

	out.push(headerPills(ctx, data));

	// Rank principal: el texto se alinea contra el borde derecho y el emblema se adapta al espacio que queda.
	const headline = data.solo ?? data.flex;
	const tierWord = tierName(headline).split(' ')[0] ?? 'UNRANKED';
	const detail = !headline ? 'Sin clasificar' : APEX_TIERS.has(tierWord) || !headline.division ? `${headline.lp} LP` : `${headline.division} · ${headline.lp} LP`;
	const fitSize = (content: string, size: number) => {
		const width = textWidth(content, size, 'rajdhani');
		return width > 175 ? Math.floor((size * 175) / width) : size;
	};
	const tierSize = fitSize(tierWord, 38);
	const detailSize = fitSize(detail, 34);
	const lineWidth = Math.max(textWidth(tierWord, tierSize, 'rajdhani'), textWidth(detail, detailSize, 'rajdhani'));
	const textX = Math.round(1150 - lineWidth);
	const emblemSize = Math.max(110, Math.min(170, textX - 14 - 866));
	out.push(line(845, 150, 845, 266, '#20232f'));
	out.push(emblem(ctx, headline, textX - 14 - emblemSize, 164 - emblemSize / 2, emblemSize));
	out.push(text(textX, 178, tierWord, { font: 'rajdhani', size: tierSize, weight: 700, fill: '#e3e6f4' }));
	out.push(text(textX, 217, detail, { font: 'rajdhani', size: detailSize, weight: 500, fill: '#868ca3' }));

	out.push(line(53, 298, 1148, 298));

	// Posiciones | Distinciones | Racha
	out.push(line(357, 322, 357, 392, '#232635'), line(914, 322, 914, 392, '#232635'));
	const sectionTitle = (x: number, label: string) => text(x, 335, label, { size: 14.5, weight: 500, fill: '#7b8199', spacing: 2.3 });
	out.push(sectionTitle(53, 'POSICIONES'), sectionTitle(416, 'DISTINCIONES'), sectionTitle(986, 'RACHA ACTUAL'));
	out.push(positionPills(ctx, data));
	out.push(distinctionsRow(ctx, data));
	out.push(streakChips(ctx, data));

	out.push(line(53, 415, 1148, 415));
	out.push(rankCard(ctx, 'RANKED SOLO / DUO', data.solo, 51), rankCard(ctx, 'FLEX 5V5', data.flex, 422), rankCard(ctx, 'TFT', data.tft, 793));

	return out.join('');
}

function headerPills(ctx: Ctx, data: ProfileRenderData): string {
	const y = 212;
	const h = 45;
	const startX = 278;
	const limit = 836; // a partir de acá empieza el bloque del rank
	const gap = 11;

	type Kind = 'otp' | 'main' | 'streak';
	interface Spec {
		kind: Kind;
		label: string;
		pad: number;
		icon: number;
		iconGap: number;
		font: number;
		width: number;
	}

	// Medidas de cada pastilla: normales, o compactas cuando no entran.
	const metrics = (kind: Kind, compact: boolean) =>
		compact
			? { pad: 14, icon: 22, iconGap: 9, right: 16, font: 17 }
			: kind === 'otp'
				? { pad: 17, icon: 25, iconGap: 12, right: 22, font: 19 }
				: kind === 'main'
					? { pad: 17, icon: 26, iconGap: 12, right: 24, font: 18 }
					: { pad: 17, icon: 24, iconGap: 11, right: 24, font: 18 };

	const spec = (kind: Kind, label: string, compact: boolean): Spec => {
		const m = metrics(kind, compact);
		return { kind, label, pad: m.pad, icon: m.icon, iconGap: m.iconGap, font: m.font, width: m.pad + m.icon + m.iconGap + textWidth(label, m.font) + m.right };
	};

	const champion = (name: string | null, max: number) => (name ? truncate(championLabel(ctx, name), max) : null);
	const build = (compact: boolean, maxChampionChars: number, withStreak: boolean): Spec[] => {
		const specs: Spec[] = [];
		const otpName = champion(data.otpChampion, maxChampionChars);
		const mainName = champion(data.mainChampion, maxChampionChars);

		if (data.isOtp) specs.push(spec('otp', otpName ? `OTP ${otpName}` : 'OTP', compact));
		if (mainName) specs.push(spec('main', `Main · ${mainName}`, compact));
		if (withStreak && data.streak.type !== 'NONE' && data.streak.count >= 3) {
			const win = data.streak.type === 'WIN';
			const noun = win ? (data.streak.count === 1 ? 'victoria' : 'victorias') : data.streak.count === 1 ? 'derrota' : 'derrotas';
			specs.push(spec('streak', `${data.streak.count} ${noun}`, compact));
		}
		return specs;
	};
	const total = (specs: Spec[]) => specs.reduce((sum, item) => sum + item.width, 0) + gap * Math.max(0, specs.length - 1);

	// Si no entran: pastillas compactas, después nombres más cortos y, como último recurso, sin la pastilla de racha.
	const attempts = [build(false, 14, true), build(true, 14, true), build(true, 9, true), build(true, 9, false)];
	const specs = attempts.find((candidate) => startX + total(candidate) <= limit) ?? attempts[attempts.length - 1]!;

	const out: string[] = [];
	let x = startX;

	for (const item of specs) {
		const iconY = y + (h - item.icon) / 2;
		const textX = x + item.pad + item.icon + item.iconGap;
		const baseline = y + h / 2 + item.font * 0.35;

		if (item.kind === 'otp') {
			out.push(pillShape(x, y, item.width, h, '#0d2216', '#357a4b'));
			out.push(icon(ctx, 'crown', x + item.pad, iconY, item.icon));
			out.push(text(textX, baseline, item.label, { size: item.font, weight: 600, fill: C.green }));
		} else if (item.kind === 'main') {
			out.push(pillShape(x, y, item.width, h, '#1b1247', '#4a35a8'));
			out.push(icon(ctx, 'mainChampion', x + item.pad, iconY, item.icon));
			out.push(text(textX, baseline, item.label, { size: item.font, weight: 500, fill: '#e7e3ff' }));
		} else {
			const win = data.streak.type === 'WIN';
			out.push(pillShape(x, y, item.width, h, win ? '#0d1017' : '#1a0f14', win ? '#2a2e3d' : '#5a2a33'));
			out.push(icon(ctx, win ? 'flame' : 'close', x + item.pad, iconY, item.icon));
			out.push(text(textX, baseline, item.label, { size: item.font, weight: 500, fill: win ? '#dfe3ef' : '#f2a9b0' }));
		}

		x += item.width + gap;
	}

	return out.join('');
}

function positionPills(ctx: Ctx, data: ProfileRenderData): string {
	if (!data.positions.length) return text(53, 374, 'Sin datos suficientes', { size: 15, fill: C.faint });

	const out: string[] = [];
	const labels: Record<string, string> = { TOP: 'TOP', JUNGLE: 'JG', MID: 'MID', ADC: 'ADC', SUPPORT: 'SUP', FILL: 'FILL' };
	let x = 53;

	for (const position of data.positions) {
		const label = labels[position.key] ?? position.key;
		const w = 15 + 24 + 8 + textWidth(label, 19, 'rajdhani', 1.2) + 17;
		const href = ctx.local.get(positionIconPath(position.key));

		out.push(pillShape(x, 348, w, 40, '#10111e', '#4c5068'));
		if (href) out.push(`<image xlink:href="${href}" x="${x + 14}" y="356" width="24" height="24" preserveAspectRatio="xMidYMid meet" opacity="0.95"/>`);
		else out.push(`<circle cx="${x + 26}" cy="368" r="9" fill="none" stroke="#7d84a0" stroke-width="2"/>`);
		out.push(text(x + 47, 374.5, label, { font: 'rajdhani', size: 19, weight: 600, fill: '#dde2f3', spacing: 1.2 }));
		x += w + 11;
	}

	return out.join('');
}

function distinctionsRow(ctx: Ctx, data: ProfileRenderData): string {
	if (!data.distinctions.length) return text(417, 374, 'Todavía sin distinciones', { size: 15, fill: C.faint });

	const out: string[] = [];
	let x = 417;

	for (const distinction of data.distinctions) {
		const gold = distinction.key === 'OTP';
		out.push(distinctionIcon(ctx, distinction.key, x, 351, 36));
		out.push(text(x + 45, 375.5, distinction.label, { size: 17, weight: gold ? 600 : 500, fill: gold ? C.gold : '#d9dded' }));
		x += 45 + textWidth(distinction.label, 17) + 28;
	}

	return out.join('');
}

function streakChips(ctx: Ctx, data: ProfileRenderData): string {
	const out: string[] = [];
	out.push(icon(ctx, 'flameGreen', 985, 356, 27));
	out.push(text(1022, 376, `${data.recent.wins}V`, { font: 'rajdhani', size: 22, weight: 700, fill: C.winText }));
	out.push(line(1066, 358, 1066, 384, '#2a2d3d'));
	out.push(icon(ctx, 'close', 1087, 357, 26));
	out.push(text(1124, 376, `${data.recent.losses}D`, { font: 'rajdhani', size: 22, weight: 700, fill: '#e6e9f6' }));
	return out.join('');
}

function rankCard(ctx: Ctx, label: string, rank: ProfileRank | undefined, x: number): string {
	const y = 432;
	const out: string[] = [];

	out.push(`<rect x="${x + 0.5}" y="${y + 0.5}" width="357" height="114" rx="12" fill="${C.panel}" stroke="${C.panelBorder}"/>`);
	out.push(emblem(ctx, rank, x + 22, y + 15, 88));
	out.push(text(x + 136, y + 30, label, { size: 13.5, weight: 500, fill: '#8a8fa6', spacing: 1.2 }));
	out.push(text(x + 136, y + 68, tierName(rank), { font: 'rajdhani', size: 31, weight: 700, fill: '#e6e9f6' }));
	out.push(
		text(x + 136, y + 97, rank ? `${rank.lp} LP • ${rank.wins}W ${rank.losses}L (${winRate(rank.wins, rank.losses)}%)` : 'Sin partidas clasificadas', {
			size: 16.5,
			fill: '#9096ad'
		})
	);

	return out.join('');
}

/* -------------------------------------------------------------------------- */
/*  Historial                                                                  */
/* -------------------------------------------------------------------------- */

const HISTORY_TOP = 594;
const ROW_START = 649;
const ROW_PITCH = 101;
const ROW_HEIGHT = 94;

function historyCard(ctx: Ctx, data: ProfileRenderData): { svg: string; bottom: number } {
	const matches = data.matches.slice(0, MATCH_ROWS);
	const bottom = matches.length ? ROW_START + ROW_PITCH * matches.length : ROW_START + 92;
	const out: string[] = [card(HISTORY_TOP, bottom - HISTORY_TOP)];

	out.push(text(47, 631, 'MATCH HISTORY', { font: 'rajdhani', size: 25, weight: 700, fill: '#dfe3f1', spacing: 1.3 }));
	out.push(text(1153, 627, 'ÚLTIMAS PARTIDAS', { size: 13.5, weight: 500, fill: '#7c8299', spacing: 1.6, anchor: 'end' }));

	if (!matches.length) {
		out.push(text(600, ROW_START + 44, 'Todavía no hay partidas sincronizadas.', { size: 16, fill: C.faint, anchor: 'middle' }));
	}

	matches.forEach((match, index) => out.push(matchRow(ctx, match, ROW_START + index * ROW_PITCH)));
	return { svg: out.join(''), bottom };
}

function matchRow(ctx: Ctx, match: ProfileMatchRow, y: number): string {
	const out: string[] = [];
	const tone = match.remake ? 'neutral' : match.win ? 'win' : 'loss';
	const accent = tone === 'win' ? C.win : tone === 'loss' ? C.loss : C.neutral;
	const label = tone === 'win' ? 'VICTORIA' : tone === 'loss' ? 'DERROTA' : 'REMAKE';
	const labelColor = tone === 'win' ? C.winText : tone === 'loss' ? C.lossText : C.muted;
	const border = tone === 'win' ? C.winBorder : tone === 'loss' ? C.lossBorder : C.panelBorder;
	const gradient = nextId('row');
	const clip = nextId('rowclip');

	out.push(`<defs><clipPath id="${clip}"><rect x="36" y="${y}" width="1128" height="${ROW_HEIGHT}" rx="10"/></clipPath>
		<linearGradient id="${gradient}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${accent}" stop-opacity="0.17"/><stop offset="1" stop-color="${accent}" stop-opacity="0.035"/></linearGradient></defs>`);
	out.push(`<rect x="36" y="${y}" width="1128" height="${ROW_HEIGHT}" rx="10" fill="#0b0e13"/>`);
	out.push(`<g clip-path="url(#${clip})"><rect x="36" y="${y}" width="1128" height="${ROW_HEIGHT}" fill="url(#${gradient})"/><rect x="36" y="${y}" width="8" height="${ROW_HEIGHT}" fill="${accent}"/></g>`);
	out.push(`<rect x="36.5" y="${y + 0.5}" width="1127" height="${ROW_HEIGHT - 1}" rx="9.5" fill="none" stroke="${border}"/>`);

	// Resultado
	out.push(text(73, y + 37, label, { font: 'rajdhani', size: 24, weight: 700, fill: labelColor, spacing: 0.6 }));
	out.push(text(73, y + 60, `${truncate(match.queueLabel, 20)} · ${formatClock(match.durationSeconds)}`, { size: 14.5, fill: C.soft }));
	out.push(text(73, y + 82, formatRelativeTime(match.startedAt, ctx.now), { size: 14.5, fill: '#989eb5' }));

	// Campeón + nivel + hechizos de invocador
	const champHref = ctx.remote.get(ctx.urls.champion(match.championName));
	out.push(image(champHref, 262, y + 10, 76, 76, { circle: true, fallbackLetter: match.championName.charAt(0) }));
	out.push(`<circle cx="300" cy="${y + 48}" r="37.5" fill="none" stroke="#2b2e40" stroke-width="2"/>`);
	if (match.champLevel) {
		out.push(`<circle cx="322" cy="${y + 72}" r="15" fill="#090a10" stroke="#3a3d50" stroke-width="1.5"/>`);
		out.push(text(322, y + 77.5, String(match.champLevel), { size: 14.5, weight: 700, fill: C.strong, anchor: 'middle' }));
	}
	match.spells.slice(0, 2).forEach((spell, index) => {
		const file = ctx.spellFiles.get(spell);
		const sy = y + 23 + index * 26;
		out.push(image(file ? ctx.remote.get(ctx.urls.spell(file)) : null, 346, sy, 22, 22, { radius: 4, fallbackFill: '#171a27' }));
		out.push(`<rect x="346.5" y="${sy + 0.5}" width="21" height="21" rx="3.5" fill="none" stroke="#2f3347"/>`);
	});

	// KDA
	const ratio = ((match.kills + match.assists) / Math.max(1, match.deaths)).toFixed(1);
	out.push(text(384, y + 45, `${match.kills} / ${match.deaths} / ${match.assists}`, { font: 'rajdhani', size: 26, weight: 700, fill: C.strong }));
	out.push(text(384, y + 69, `${ratio} KDA${match.cs !== null ? ` · ${match.cs} CS` : ''}`, { size: 14.5, fill: '#9aa0b8' }));

	// Items (hasta 6) y trinket en su lugar fijo, así quedan alineados entre filas
	match.items.slice(0, 6).forEach((item, index) => {
		const x = 522 + index * 38;
		out.push(image(ctx.remote.get(ctx.urls.item(item)), x, y + 30, 35, 35, { radius: 5, fallbackFill: '#171a27' }));
		out.push(`<rect x="${x + 0.5}" y="${y + 30.5}" width="34" height="34" rx="4.5" fill="none" stroke="#3a3f58"/>`);
	});
	if (match.trinket) {
		out.push(image(ctx.remote.get(ctx.urls.item(match.trinket)), 754, y + 31, 33, 33, { circle: true, fallbackFill: '#171a27' }));
		out.push(`<circle cx="770.5" cy="${y + 47.5}" r="16" fill="none" stroke="#3a3f58"/>`);
	}

	// Equipos
	if (match.teams) {
		out.push(line(802, y + 14, 802, y + 80, '#23262f'));
		out.push(teamGrid(ctx, match.teams.ally, 812, y));
		out.push(text(924, y + 53, 'vs', { size: 14, weight: 500, fill: '#8a90a6', anchor: 'middle' }));
		out.push(teamGrid(ctx, match.teams.enemy, 953, y));
		out.push(line(1058, y + 14, 1058, y + 80, '#23262f'));
	}

	// Participación en kills y MVP/ACE
	const kp = match.killParticipation;
	const hasTag = match.tag !== null;
	const center = match.teams ? 1111 : 1100;
	if (kp !== null) {
		out.push(text(center, y + (hasTag ? 46 : 56), `${Math.round(kp * 100)}% KP`, { font: 'rajdhani', size: 25, weight: 700, fill: labelColor, anchor: 'middle' }));
	}
	if (match.tag) {
		const gold = match.tag === 'MVP';
		out.push(pillShape(center - 27, y + 58, 54, 23, gold ? '#2a2108' : '#1d1740', gold ? '#b78a2f' : '#5b45b8'));
		out.push(text(center, y + 74, match.tag, { size: 12.5, weight: 700, fill: gold ? '#f2c24f' : '#bba9ff', anchor: 'middle', spacing: 0.4 }));
	}

	return out.join('');
}

function teamGrid(ctx: Ctx, players: ProfileMatchPlayer[], x: number, y: number): string {
	return players
		.slice(0, 6)
		.map((player, index) => {
			const px = x + (index % 3) * 29;
			const py = y + 22 + Math.floor(index / 3) * 31;
			const href = ctx.remote.get(ctx.urls.champion(player.championName));
			const stroke = player.isSelf ? '#f1f3fb' : '#2b2e40';
			return `${image(href, px, py, 25, 25, { radius: 4, fallbackLetter: player.championName.charAt(0) })}<rect x="${px + 0.5}" y="${py + 0.5}" width="24" height="24" rx="3.5" fill="none" stroke="${stroke}" stroke-width="${player.isSelf ? 1.6 : 1}"/>`;
		})
		.join('');
}

/* -------------------------------------------------------------------------- */
/*  Champion pool y pie                                                        */
/* -------------------------------------------------------------------------- */

function poolCard(ctx: Ctx, data: ProfileRenderData, top: number): { svg: string; bottom: number } {
	const pool = data.championPool.slice(0, 4);
	const height = 150;
	const out: string[] = [card(top, height)];

	out.push(text(47, top + 28, 'CHAMPION POOL', { font: 'rajdhani', size: 21, weight: 700, fill: '#dfe3f1', spacing: 1.2 }));
	out.push(text(1153, top + 24, 'ÚLTIMAS 100 · SUMMONER’S RIFT', { size: 13, weight: 500, fill: '#7c8299', spacing: 1.4, anchor: 'end' }));

	if (!pool.length) {
		out.push(text(600, top + 88, 'Todavía no hay suficientes partidas para armar el pool.', { size: 16, fill: C.faint, anchor: 'middle' }));
		return { svg: out.join(''), bottom: top + height };
	}

	const maxGames = Math.max(...pool.map((champion) => champion.games), 1);
	const cardW = 267;

	pool.forEach((champion, index) => {
		const x = 42 + index * (cardW + 16);
		const y = top + 38;
		const rate = winRate(champion.wins, champion.games - champion.wins);
		const href = ctx.remote.get(ctx.urls.champion(champion.championName));
		const barW = 151;

		out.push(`<rect x="${x + 0.5}" y="${y + 0.5}" width="${cardW - 1}" height="93" rx="12" fill="${C.panel}" stroke="${C.panelBorder}"/>`);
		out.push(image(href, x + 16, y + 11, 70, 70, { radius: 8, fallbackLetter: champion.championName.charAt(0) }));
		out.push(`<rect x="${x + 16.5}" y="${y + 11.5}" width="69" height="69" rx="7.5" fill="none" stroke="#2b2e40"/>`);
		if (champion.masteryLevel) {
			out.push(`<circle cx="${x + 80}" cy="${y + 75}" r="13" fill="#090a10" stroke="#3a3d50" stroke-width="1.5"/>`);
			out.push(text(x + 80, y + 80, String(champion.masteryLevel), { size: 13, weight: 700, fill: C.strong, anchor: 'middle' }));
		}
		out.push(text(x + 104, y + 34, truncate(championLabel(ctx, champion.championName), 14), { size: 17, weight: 600, fill: '#e6e9f6' }));
		out.push(text(x + 104, y + 57, `${champion.games} partidas · ${rate}%`, { size: 14, fill: '#9aa0b8' }));
		out.push(`<rect x="${x + 104}" y="${y + 66}" width="${barW}" height="7" rx="3.5" fill="#20232f"/>`);
		out.push(`<rect x="${x + 104}" y="${y + 66}" width="${Math.max(8, Math.round((champion.games / maxGames) * barW))}" height="7" rx="3.5" fill="#a9bdd2"/>`);
	});

	return { svg: out.join(''), bottom: top + height };
}

function footer(ctx: Ctx, y: number): string {
	const logoHref = ctx.local.get('brand/capygg.png');
	const out: string[] = [];

	out.push(text(26, y, `© ${ctx.now.getFullYear()} CAPYGG  /  DATA FROM RIOT GAMES API`, { size: 13, weight: 500, fill: '#5f647c', spacing: 1.4 }));
	out.push(text(1172, y + 4, 'CapyGG', { size: 20, weight: 600, fill: '#c9cde0', anchor: 'end' }));
	out.push(
		logoHref
			? `<image xlink:href="${logoHref}" x="1050" y="${y - 22}" width="36" height="32" preserveAspectRatio="xMidYMid meet"/>`
			: vectorIcon('capybara', 1052, y - 22, 34)
	);
	return out.join('');
}

/* -------------------------------------------------------------------------- */
/*  Documento                                                                  */
/* -------------------------------------------------------------------------- */

function buildSvg(data: ProfileRenderData, ctx: Ctx): string {
	const history = historyCard(ctx, data);
	const pool = poolCard(ctx, data, history.bottom + 27);
	const footerY = pool.bottom + 44;
	const height = pool.bottom + 82;
	const bg = nextId('bg');

	return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}">
<defs><linearGradient id="${bg}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.pageTop}"/><stop offset="1" stop-color="${C.pageBottom}"/></linearGradient></defs>
<rect width="${WIDTH}" height="${height}" fill="url(#${bg})"/>
${headerCard(ctx, data)}
${history.svg}
${pool.svg}
${footer(ctx, footerY)}
</svg>`;
}