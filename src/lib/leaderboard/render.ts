import { dataDragonVersion, ddragonUrls, localImage, rankEmblemPath, remoteImageAny } from '../profile/assets.js';
import { nextId, vectorIcon } from '../profile/icons.js';
import { C, image, line, pillShape, rasterize, text, textWidth, tierColor, winRate, type FontName, type ProfileRank } from '../profile/render.js';

/* -------------------------------------------------------------------------- */
/*  Datos que recibe el render                                                 */
/* -------------------------------------------------------------------------- */

export type LeaderboardQueue = 'SOLO' | 'FLEX' | 'TFT';

export interface LeaderboardEntry extends ProfileRank {
	/** Posición global (1 = primero). */
	position: number;
	/** Nombre de Discord del miembro (ya sin emojis). */
	displayName: string;
	gameName: string;
	tagLine: string;
	profileIconId: number;
	/** Campeón OTP/main. Solo se carga para el top 3 (fondo de la fila). */
	championName: string | null;
}

export interface LeaderboardRenderData {
	guildName: string;
	queue: LeaderboardQueue;
	/** Página actual, desde 0. */
	page: number;
	totalPages: number;
	totalPlayers: number;
	pageSize: number;
	/** Solo las filas de la página actual. */
	entries: LeaderboardEntry[];
	/** Fila de quien ejecutó el comando (si tiene rango en esta cola). */
	self: LeaderboardEntry | null;
	/** Cuentas vinculadas todavía sin datos de esta cola. */
	pending: number;
	now?: Date;
}

/* -------------------------------------------------------------------------- */
/*  Assets y constantes de diseño                                              */
/* -------------------------------------------------------------------------- */

/** Portada del header (el capybara). Opcional: si no existe, el header se ve solo con el brillo. */
export const LEADERBOARD_COVER_PATH = 'brand/leaderboard-cover.png';

/** Mini escudo de rango para las filas 4+: `assets/lol/minicrests/minicrest_emerald.png`. Si falta, se usa el emblema grande reducido. */
export function minicrestPath(tier: string | null | undefined): string {
	return `lol/minicrests/minicrest_${(tier || 'unranked').toLowerCase()}.png`;
}

export const WIDTH = 1200;
export const CARD_X = 20;
export const CARD_W = 1160;

export const HEADER_TOP = 15;
export const HEADER_H = 300;
export const TABLE_TOP = 335;

export const BIG_H = 106;
export const BIG_PITCH = 116;
export const ROW_H = 56;
export const ROW_PITCH = 62;

/** Cuántas filas llevan el fondo con el campeón (el top 3 global). */
export const PODIUM_SIZE = 3;
/** Qué tan abajo (0..1) del splash queda el centro de la fila. Subilo si se ve mucho pecho y poca cara. */
const SPLASH_FOCUS_Y = 0.3;

const APEX_TIERS = new Set(['MASTER', 'GRANDMASTER', 'CHALLENGER']);

export interface Medal {
	main: string;
	light: string;
	dark: string;
}

export const MEDALS: Medal[] = [
	{ main: '#f3b94d', light: '#ffe3a0', dark: '#b27a1c' },
	{ main: '#c3cbe0', light: '#f1f3fc', dark: '#7a84a3' },
	{ main: '#e0905f', light: '#ffcba5', dark: '#a0532a' }
];

const QUEUE_TABS: Array<{ key: LeaderboardQueue; label: string; icon: 'trophy' | 'swords' | 'helmet' }> = [
	{ key: 'SOLO', label: 'Solo/Duo', icon: 'trophy' },
	{ key: 'FLEX', label: 'Flex 5v5', icon: 'swords' },
	{ key: 'TFT', label: 'TFT', icon: 'helmet' }
];

export interface Ctx {
	remote: Map<string, string | null>;
	local: Map<string, string | null>;
	urls: ReturnType<typeof ddragonUrls>;
	now: Date;
}

/* -------------------------------------------------------------------------- */
/*  Punto de entrada                                                           */
/* -------------------------------------------------------------------------- */

export async function renderLeaderboardImage(data: LeaderboardRenderData): Promise<Buffer> {
	const version = await dataDragonVersion();
	const urls = ddragonUrls(version);
	const people = [...data.entries, ...(data.self ? [data.self] : [])];

	const iconUrls = new Set<number>(people.map((person) => person.profileIconId));
	const splashes = new Set<string>(people.filter((person) => person.position <= PODIUM_SIZE && person.championName).map((person) => urls.splash(person.championName!)));
	const tiers = new Set<string>(people.map((person) => person.tier.toUpperCase()));

	const remote = new Map<string, string | null>();
	const local = new Map<string, string | null>();

	await Promise.all([
		...[...iconUrls].map(async (id) => remote.set(urls.profileIcon(id), await remoteImageAny([urls.profileIcon(id), urls.profileIconFallback(id)]))),
		...[...splashes].map(async (url) => remote.set(url, await remoteImageAny([url]))),
		...[...tiers].map(async (tier) => {
			local.set(`emblem:${tier}`, await localImage(rankEmblemPath(tier), { size: 320 }));
			local.set(`crest:${tier}`, await localImage(minicrestPath(tier), { size: 128 }));
		}),
		localImage('lol/ranks/unranked.png', { size: 320 }).then((value) => local.set('emblem:UNRANKED', value)),
		localImage(LEADERBOARD_COVER_PATH, { size: 1400, trim: false }).then((value) => local.set('cover', value)),
		localImage('brand/capygg.png', { size: 128 }).then((value) => local.set('logo', value))
	]);

	return rasterize(buildSvg(data, { remote, local, urls, now: data.now ?? new Date() }));
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

export function fitText(content: string, size: number, maxWidth: number, font: FontName, min = 14): { content: string; size: number } {
	const width = textWidth(content, size, font);
	if (width <= maxWidth) return { content, size };

	const fitted = Math.max(min, Math.floor((size * maxWidth) / width));
	if (textWidth(content, fitted, font) <= maxWidth) return { content, size: fitted };

	let cut = content;
	while (cut.length > 1 && textWidth(`${cut}…`, fitted, font) > maxWidth) cut = cut.slice(0, -1);
	return { content: `${cut.trimEnd()}…`, size: fitted };
}

export function cardRect(y: number, h: number, extra = ''): string {
	return `<rect x="${CARD_X}" y="${y}" width="${CARD_W}" height="${h}" rx="16" fill="${C.card}"/>${extra}<rect x="${CARD_X + 0.5}" y="${y + 0.5}" width="${CARD_W - 1}" height="${h - 1}" rx="15.5" fill="none" stroke="${C.cardBorder}"/>`;
}

export function tierParts(entry: ProfileRank): { tier: string; detail: string } {
	const tier = entry.tier.toUpperCase();
	return { tier, detail: APEX_TIERS.has(tier) || !entry.division ? tier : `${tier} ${entry.division}` };
}

export function emblemImage(ctx: Ctx, tier: string, x: number, y: number, w: number, h: number): string {
	const key = tier.toUpperCase();
	const href = ctx.local.get(`emblem:${key}`) ?? ctx.local.get('emblem:UNRANKED') ?? null;
	if (href) return `<image xlink:href="${href}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid meet"/>`;

	const size = Math.min(w, h);
	const cx = x + w / 2;
	const cy = y + h / 2;
	return `<path d="M${cx} ${cy - size * 0.4} L${cx + size * 0.4} ${cy - size * 0.1} L${cx} ${cy + size * 0.4} L${cx - size * 0.4} ${cy - size * 0.1} Z" fill="${tierColor({ tier } as ProfileRank)}" opacity=".85"/>`;
}

/** Mini escudo; si no está el archivo usa el emblema grande reducido. */
export function crestImage(ctx: Ctx, tier: string, x: number, y: number, w: number, h: number): string {
	const href = ctx.local.get(`crest:${tier.toUpperCase()}`);
	if (href) return `<image xlink:href="${href}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid meet"/>`;
	return emblemImage(ctx, tier, x, y, w, h);
}

export function avatar(ctx: Ctx, entry: { profileIconId: number; gameName: string }, cx: number, cy: number, diameter: number, ring: string, ringWidth: number): string {
	const href = ctx.remote.get(ctx.urls.profileIcon(entry.profileIconId));
	const r = diameter / 2;
	return (
		image(href, cx - r, cy - r, diameter, diameter, { circle: true, fallbackFill: '#1a1d2b', fallbackLetter: entry.gameName.charAt(0).toUpperCase() }) +
		`<circle cx="${cx}" cy="${cy}" r="${r - ringWidth / 2 + 0.5}" fill="none" stroke="${ring}" stroke-width="${ringWidth}"/>`
	);
}

function riotId(entry: LeaderboardEntry): string {
	return `${entry.gameName}#${entry.tagLine}`;
}

function rate(entry: ProfileRank): { percent: number; color: string; record: string } {
	const percent = winRate(entry.wins, entry.losses);
	const games = entry.wins + entry.losses;
	return { percent, color: games === 0 ? '#8a90a6' : percent >= 50 ? C.winText : C.lossText, record: `${entry.wins}V ${entry.losses}D` };
}

/* -------------------------------------------------------------------------- */
/*  Íconos vectoriales                                                         */
/* -------------------------------------------------------------------------- */

export function iconGroup(x: number, y: number, size: number, body: string): string {
	return `<g transform="translate(${x} ${y}) scale(${size / 24})" fill="none" stroke-linecap="round" stroke-linejoin="round">${body}</g>`;
}

const STAR = 'M12 7.4l1.2 2.5 2.7.4-2 1.9.5 2.7-2.4-1.3-2.4 1.3.5-2.7-2-1.9 2.7-.4z';

export function trophyIcon(x: number, y: number, size: number, stroke: string, withStar = true): string {
	return iconGroup(
		x,
		y,
		size,
		`<path d="M7 3.5h10v5.2a5 5 0 0 1-10 0z" stroke="${stroke}" stroke-width="1.6"/><path d="M7 5H4.2v1.9A3 3 0 0 0 7 9.8M17 5h2.8v1.9a3 3 0 0 1-2.8 2.9" stroke="${stroke}" stroke-width="1.6"/><path d="M12 13.7v3.3M8.6 20.5h6.8M9.8 17h4.4" stroke="${stroke}" stroke-width="1.6"/>${withStar ? `<path d="${STAR}" fill="${stroke}" stroke="none"/>` : ''}`
	);
}

export function swordsIcon(x: number, y: number, size: number, stroke: string): string {
	return iconGroup(
		x,
		y,
		size,
		`<path d="M4.5 4.5l9.8 9.8M19.5 4.5l-9.8 9.8" stroke="${stroke}" stroke-width="1.8"/><path d="M12.4 16.6l2.6-2.6M11.6 16.6L9 14M5.2 19.8l2.4-2.4M18.8 19.8l-2.4-2.4" stroke="${stroke}" stroke-width="1.8"/>`
	);
}

export function helmetIcon(x: number, y: number, size: number, stroke: string): string {
	return iconGroup(
		x,
		y,
		size,
		`<path d="M12 2.8l7.8 4.4v9.6L12 21.2l-7.8-4.4V7.2z" stroke="${stroke}" stroke-width="1.7"/><path d="M8.2 10.2h7.6M12 10.2v6.2" stroke="${stroke}" stroke-width="1.7"/>`
	);
}

export function sparkle(cx: number, cy: number, size: number, fill: string, opacity: number): string {
	return `<path transform="translate(${cx} ${cy}) scale(${size / 8})" d="M0 -8C1 -2 2 -1 8 0C2 1 1 2 0 8C-1 2 -2 1 -8 0C-2 -1 -1 -2 0 -8Z" fill="${fill}" opacity="${opacity}"/>`;
}

/** Corona de laurel a los costados del número del podio. */
export function laurel(cx: number, cy: number, medal: Medal): string {
	const out: string[] = [];
	const radius = 40;
	const leaves = 6;

	for (const side of [-1, 1] as const) {
		const point = (t: number) => {
			// Recorre el arco de abajo hacia arriba (t: 0..1).
			const angle = ((side === -1 ? 255 - t * 130 : -75 + t * 130) * Math.PI) / 180;
			return { x: cx + radius * Math.cos(angle) * 0.9, y: cy - radius * Math.sin(angle) };
		};

		const start = point(0);
		const end = point(1);
		out.push(`<path d="M${start.x.toFixed(1)} ${start.y.toFixed(1)} A${radius * 0.9} ${radius} 0 0 ${side === -1 ? 1 : 0} ${end.x.toFixed(1)} ${end.y.toFixed(1)}" fill="none" stroke="${medal.dark}" stroke-width="1.6" stroke-linecap="round"/>`);

		for (let index = 0; index < leaves; index++) {
			const t = index / (leaves - 1);
			const here = point(t);
			const next = point(Math.min(1, t + 0.04));
			const prev = point(Math.max(0, t - 0.04));
			const tangent = (Math.atan2(next.y - prev.y, next.x - prev.x) * 180) / Math.PI;
			const outward = side === -1 ? -1 : 1;
			const lx = here.x + outward * 5;
			out.push(`<ellipse cx="${lx.toFixed(1)}" cy="${here.y.toFixed(1)}" rx="9" ry="3.8" transform="rotate(${(tangent + outward * -28).toFixed(1)} ${lx.toFixed(1)} ${here.y.toFixed(1)})" fill="${t > 0.5 ? medal.main : medal.dark}" opacity="${(0.7 + t * 0.3).toFixed(2)}"/>`);
		}
	}

	return out.join('');
}

/* -------------------------------------------------------------------------- */
/*  Header                                                                     */
/* -------------------------------------------------------------------------- */

function header(ctx: Ctx, data: LeaderboardRenderData): string {
	const out: string[] = [];
	const clip = nextId('lbhdr');
	const fadeX = nextId('lbfx');
	const fadeY = nextId('lbfy');
	const glow = nextId('lbglow');
	const trophy = nextId('lbtr');
	const tabGlow = nextId('lbtg');
	const coverHref = ctx.local.get('cover');

	out.push(`<defs>
		<clipPath id="${clip}"><rect x="${CARD_X}" y="${HEADER_TOP}" width="${CARD_W}" height="${HEADER_H}" rx="16"/></clipPath>
		<linearGradient id="${fadeX}" gradientUnits="userSpaceOnUse" x1="520" y1="0" x2="840" y2="0"><stop offset="0" stop-color="${C.card}" stop-opacity="1"/><stop offset="1" stop-color="${C.card}" stop-opacity="0"/></linearGradient>
		<linearGradient id="${fadeY}" gradientUnits="userSpaceOnUse" x1="0" y1="190" x2="0" y2="${HEADER_TOP + HEADER_H}"><stop offset="0" stop-color="${C.card}" stop-opacity="0"/><stop offset="1" stop-color="${C.card}" stop-opacity="1"/></linearGradient>
		<radialGradient id="${glow}" gradientUnits="userSpaceOnUse" cx="930" cy="140" r="340"><stop offset="0" stop-color="#7a58ee" stop-opacity="0.3"/><stop offset="1" stop-color="#7a58ee" stop-opacity="0"/></radialGradient>
		<linearGradient id="${trophy}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#a98cff"/><stop offset="1" stop-color="#5b3fe0"/></linearGradient>
		<filter id="${tabGlow}" x="-30%" y="-60%" width="160%" height="220%"><feGaussianBlur stdDeviation="9"/></filter>
	</defs>`);

	out.push(`<rect x="${CARD_X}" y="${HEADER_TOP}" width="${CARD_W}" height="${HEADER_H}" rx="16" fill="${C.card}"/>`);
	out.push(`<g clip-path="url(#${clip})">`);
	out.push(`<rect x="${CARD_X}" y="${HEADER_TOP}" width="${CARD_W}" height="${HEADER_H}" fill="url(#${glow})"/>`);
	if (coverHref) out.push(`<image xlink:href="${coverHref}" x="500" y="${HEADER_TOP - 10}" width="680" height="${HEADER_H + 10}" preserveAspectRatio="xMidYMid slice" opacity="0.95"/>`);
	out.push(`<rect x="${CARD_X}" y="${HEADER_TOP}" width="${CARD_W}" height="${HEADER_H}" fill="url(#${fadeX})"/>`);
	out.push(`<rect x="${CARD_X}" y="${HEADER_TOP}" width="${CARD_W}" height="${HEADER_H}" fill="url(#${fadeY})"/>`);
	out.push('</g>');
	out.push(`<rect x="${CARD_X + 0.5}" y="${HEADER_TOP + 0.5}" width="${CARD_W - 1}" height="${HEADER_H - 1}" rx="15.5" fill="none" stroke="${C.cardBorder}"/>`);

	out.push(text(47, 46, 'LEAGUE PROFILE / LEADERBOARD', { size: 14, weight: 500, fill: '#6c7189', spacing: 2.4 }));

	out.push(trophyIcon(54, 76, 112, `url(#${trophy})`));
	out.push(text(192, 142, 'Leaderboard', { font: 'rajdhani', size: 72, weight: 700, fill: '#e6e9f8' }));

	const prefix = 'Los mejores jugadores de CapyGG en ';
	const guild = fitText(data.guildName, 28, Math.max(120, 600 - textWidth(prefix, 28, 'rajdhani')), 'rajdhani', 18);
	out.push(text(194, 184, `${prefix}${guild.content}`, { font: 'rajdhani', size: guild.size, weight: 500, fill: '#8a90aa' }));

	// Cola activa
	let x = 50;
	const y = 233;
	const h = 46;
	for (const tab of QUEUE_TABS) {
		const active = tab.key === data.queue;
		const w = 18 + 22 + 10 + textWidth(tab.label, 17) + 26;
		const stroke = active ? '#a58cff' : '#7d84a0';

		if (active) {
			out.push(`<rect x="${x + 4}" y="${y + 6}" width="${w - 8}" height="${h - 12}" rx="14" fill="#6d4ff0" opacity=".45" filter="url(#${tabGlow})"/>`);
			out.push(pillShape(x, y, w, h, '#1c1350', '#6d4ff0'));
		} else {
			out.push(pillShape(x, y, w, h, '#0d0f18', '#2b2e40'));
		}

		const iconX = x + 18;
		const iconY = y + (h - 22) / 2;
		out.push(tab.icon === 'trophy' ? trophyIcon(iconX, iconY, 22, stroke, false) : tab.icon === 'swords' ? swordsIcon(iconX, iconY, 22, stroke) : helmetIcon(iconX, iconY, 22, stroke));
		out.push(text(x + 18 + 22 + 10, y + h / 2 + 6, tab.label, { size: 17, weight: active ? 600 : 500, fill: active ? '#f1eeff' : '#9aa0b8' }));
		x += w + 12;
	}

	return out.join('');
}

/* -------------------------------------------------------------------------- */
/*  Filas                                                                      */
/* -------------------------------------------------------------------------- */

function bigRow(ctx: Ctx, entry: LeaderboardEntry, y: number): string {
	const medal = MEDALS[Math.min(entry.position, PODIUM_SIZE) - 1]!;
	const color = tierColor(entry);
	const out: string[] = [];
	const clip = nextId('lbrow');
	const tint = nextId('lbtint');
	const border = nextId('lbbrd');
	const fade = nextId('lbfade');
	const num = nextId('lbnum');
	const blur = nextId('lbblur');
	const shade = nextId('lbshade');
	const cy = y + BIG_H / 2;

	const splash = entry.championName ? ctx.remote.get(ctx.urls.splash(entry.championName)) : null;
	const icon = ctx.remote.get(ctx.urls.profileIcon(entry.profileIconId));

	out.push(`<defs>
		<clipPath id="${clip}"><rect x="36" y="${y}" width="1128" height="${BIG_H}" rx="14"/></clipPath>
		<linearGradient id="${tint}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${medal.main}" stop-opacity="0.3"/><stop offset="0.55" stop-color="${medal.main}" stop-opacity="0.08"/><stop offset="1" stop-color="${medal.main}" stop-opacity="0.12"/></linearGradient>
		<linearGradient id="${border}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${medal.main}"/><stop offset="1" stop-color="${medal.dark}" stop-opacity="0.55"/></linearGradient>
		<linearGradient id="${fade}" gradientUnits="userSpaceOnUse" x1="330" y1="0" x2="760" y2="0"><stop offset="0" stop-color="#0b0d14" stop-opacity="1"/><stop offset="1" stop-color="#0b0d14" stop-opacity="0"/></linearGradient>
		<linearGradient id="${shade}" gradientUnits="userSpaceOnUse" x1="760" y1="0" x2="1164" y2="0"><stop offset="0" stop-color="#05060a" stop-opacity="0"/><stop offset="1" stop-color="#05060a" stop-opacity="0.55"/></linearGradient>
		<linearGradient id="${num}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${medal.light}"/><stop offset="1" stop-color="${medal.main}"/></linearGradient>
		<filter id="${blur}" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="14"/></filter>
	</defs>`);

	out.push(`<rect x="36" y="${y}" width="1128" height="${BIG_H}" rx="14" fill="#0b0d14"/>`);
	out.push(`<g clip-path="url(#${clip})">`);

	// Fondo: splash del campeón (o el ícono difuminado si todavía no hay main/OTP)
	if (splash) {
		const w = 780;
		const hh = Math.round(w * (717 / 1215));
		out.push(`<image xlink:href="${splash}" x="${1164 - w + 40}" y="${(cy - hh * SPLASH_FOCUS_Y).toFixed(1)}" width="${w}" height="${hh}" preserveAspectRatio="xMidYMid slice" opacity="0.55"/>`);
	} else if (icon) {
		out.push(`<image xlink:href="${icon}" x="640" y="${y - 150}" width="420" height="420" preserveAspectRatio="xMidYMid slice" opacity="0.2" filter="url(#${blur})"/>`);
	}
	out.push(`<rect x="36" y="${y}" width="1128" height="${BIG_H}" fill="url(#${fade})"/>`);
	if (splash) out.push(`<rect x="36" y="${y}" width="1128" height="${BIG_H}" fill="url(#${shade})"/>`);
	out.push(`<rect x="36" y="${y}" width="1128" height="${BIG_H}" fill="url(#${tint})"/>`);
	out.push(`<rect x="36" y="${y}" width="8" height="${BIG_H}" fill="${medal.main}"/>`);
	out.push('</g>');
	out.push(`<rect x="36.75" y="${y + 0.75}" width="1126.5" height="${BIG_H - 1.5}" rx="13.5" fill="none" stroke="url(#${border})" stroke-width="1.5"/>`);

	// Posición
	out.push(laurel(122, cy, medal));
	out.push(text(122, cy + 20, String(entry.position), { font: 'rajdhani', size: 62, weight: 700, fill: `url(#${num})`, anchor: 'middle' }));

	// Jugador
	out.push(avatar(ctx, entry, 266, cy, 80, medal.main, 3));
	const name = fitText(entry.displayName, 34, 320, 'rajdhani', 22);
	const tag = fitText(riotId(entry), 22, 320, 'rajdhani', 15);
	out.push(text(326, cy - 4, name.content, { font: 'rajdhani', size: name.size, weight: 700, fill: '#f0f2fc' }));
	out.push(text(327, cy + 25, tag.content, { font: 'rajdhani', size: tag.size, weight: 500, fill: '#a0a6bd' }));

	// Winrate
	const wr = rate(entry);
	out.push(text(706, cy + 3, `${wr.percent}%`, { font: 'rajdhani', size: 32, weight: 700, fill: wr.color, anchor: 'middle' }));
	out.push(text(706, cy + 26, wr.record, { size: 14, weight: 500, fill: '#9aa0b8', anchor: 'middle' }));

	// Elo
	out.push(emblemImage(ctx, entry.tier, 790, cy - 46, 130, 92));
	const parts = tierParts(entry);
	const label = fitText(parts.detail, 35, 215, 'rajdhani', 22);
	out.push(text(936, cy - 2, label.content, { font: 'rajdhani', size: label.size, weight: 700, fill: '#eef0fb' }));
	out.push(text(937, cy + 29, `${entry.lp} LP`, { font: 'rajdhani', size: 29, weight: 600, fill: color }));

	return out.join('');
}

function compactRow(ctx: Ctx, entry: LeaderboardEntry, y: number, isSelf: boolean): string {
	const out: string[] = [];
	const cy = y + ROW_H / 2;
	const clip = nextId('lbcr');

	out.push(`<defs><clipPath id="${clip}"><rect x="36" y="${y}" width="1128" height="${ROW_H}" rx="11"/></clipPath></defs>`);
	out.push(`<rect x="36" y="${y}" width="1128" height="${ROW_H}" rx="11" fill="${isSelf ? '#120f33' : '#0d0f17'}"/>`);
	if (isSelf) out.push(`<g clip-path="url(#${clip})"><rect x="36" y="${y}" width="6" height="${ROW_H}" fill="#7b5cff"/></g>`);
	out.push(`<rect x="36.5" y="${y + 0.5}" width="1127" height="${ROW_H - 1}" rx="10.5" fill="none" stroke="${isSelf ? '#4a35a8' : '#1f2230'}"/>`);

	const position = String(entry.position);
	out.push(text(100, cy + 9, position, { font: 'rajdhani', size: position.length > 3 ? 20 : position.length > 2 ? 23 : 27, weight: 700, fill: isSelf ? '#cdbfff' : '#a9afc7', anchor: 'middle' }));

	out.push(avatar(ctx, entry, 224, cy, 42, '#2b2e40', 2));
	const name = fitText(entry.displayName, 22, 330, 'rajdhani', 16);
	const tag = fitText(riotId(entry), 16.5, 330, 'rajdhani', 13);
	out.push(text(260, cy - 3, name.content, { font: 'rajdhani', size: name.size, weight: 700, fill: '#e9ecf8' }));
	out.push(text(261, cy + 16, tag.content, { font: 'rajdhani', size: tag.size, weight: 500, fill: '#8a90a6' }));

	const wr = rate(entry);
	out.push(text(690, cy + 8, `${wr.percent}%`, { font: 'rajdhani', size: 22, weight: 700, fill: wr.color, anchor: 'end' }));
	out.push(text(704, cy + 6, wr.record, { size: 13.5, weight: 500, fill: '#8a90a6' }));

	out.push(crestImage(ctx, entry.tier, 846, cy - 21, 50, 42));
	const parts = tierParts(entry);
	out.push(text(908, cy + 7.5, parts.detail, { font: 'rajdhani', size: 22, weight: 600, fill: '#dfe3f4', spacing: 0.6 }));
	out.push(text(1146, cy + 6, `${entry.lp} LP`, { size: 16, weight: 500, fill: '#8f95ad', anchor: 'end' }));

	return out.join('');
}

/* -------------------------------------------------------------------------- */
/*  Paginador                                                                  */
/* -------------------------------------------------------------------------- */

/** Números de página a mostrar: 1 2 3 … N (con la actual en el medio si está lejos). */
export function pageWindow(current: number, total: number): Array<number | '…'> {
	if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1);

	const wanted = new Set<number>([1, total, current - 1, current, current + 1]);
	if (current <= 3) [2, 3].forEach((page) => wanted.add(page));
	if (current >= total - 2) [total - 1, total - 2].forEach((page) => wanted.add(page));

	const pages = [...wanted].filter((page) => page >= 1 && page <= total).sort((a, b) => a - b);
	const out: Array<number | '…'> = [];
	pages.forEach((page, index) => {
		const previous = pages[index - 1];
		if (previous !== undefined && page - previous === 2) out.push(previous + 1);
		else if (previous !== undefined && page - previous > 2) out.push('…');
		out.push(page);
	});
	return out;
}

export function pager(data: Pick<LeaderboardRenderData, 'page' | 'pageSize' | 'totalPages' | 'totalPlayers' | 'pending'> & { entries: readonly unknown[] }, y: number): string {
	const out: string[] = [];
	const first = data.page * data.pageSize + 1;
	const last = Math.min(data.totalPlayers, first + data.entries.length - 1);

	out.push(`<circle cx="62" cy="${y + 18}" r="7.5" fill="none" stroke="#6c7189" stroke-width="1.3"/><path d="M62 ${y + 17.2}v4.4" stroke="#6c7189" stroke-width="1.4" stroke-linecap="round"/><circle cx="62" cy="${y + 14.4}" r=".9" fill="#6c7189"/>`);
	const pending = data.pending > 0 ? ` · ${data.pending} sin datos` : '';
	out.push(text(78, y + 23, `Mostrando ${first}–${last} de ${data.totalPlayers} jugador${data.totalPlayers === 1 ? '' : 'es'}${pending}`, { size: 15, fill: '#7c8299' }));

	const items = pageWindow(data.page + 1, data.totalPages);
	const box = 38;
	const gap = 8;
	const count = items.length + 2;
	let x = 1150 - (count * box + (count - 1) * gap);

	const arrow = (direction: 'left' | 'right', disabled: boolean) => {
		const stroke = disabled ? '#3d4157' : '#c9cde0';
		const cx = x + box / 2;
		const d = direction === 'left' ? `M${cx + 3} ${y + 11}l-6.5 7 6.5 7` : `M${cx - 3} ${y + 11}l6.5 7-6.5 7`;
		return `<rect x="${x + 0.5}" y="${y + 0.5}" width="${box - 1}" height="35" rx="8" fill="#0d0f18" stroke="#2b2e40"/><path d="${d}" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
	};

	out.push(arrow('left', data.page === 0));
	x += box + gap;

	for (const item of items) {
		if (item === '…') {
			out.push(text(x + box / 2, y + 24, '…', { size: 17, fill: '#8a90a6', anchor: 'middle' }));
		} else if (item === data.page + 1) {
			out.push(`<rect x="${x}" y="${y}" width="${box}" height="36" rx="8" fill="#6a46ee"/>`);
			out.push(text(x + box / 2, y + 24, String(item), { size: 16, weight: 600, fill: '#ffffff', anchor: 'middle' }));
		} else {
			out.push(`<rect x="${x + 0.5}" y="${y + 0.5}" width="${box - 1}" height="35" rx="8" fill="#0d0f18" stroke="#2b2e40"/>`);
			out.push(text(x + box / 2, y + 24, String(item), { size: 16, weight: 500, fill: '#c9cde0', anchor: 'middle' }));
		}
		x += box + gap;
	}

	out.push(arrow('right', data.page >= data.totalPages - 1));
	return out.join('');
}

/* -------------------------------------------------------------------------- */
/*  "Tu posición" y pie                                                        */
/* -------------------------------------------------------------------------- */

export const SELF_H = 100;

function selfBar(ctx: Ctx, entry: LeaderboardEntry, y: number): string {
	const out: string[] = [];
	const bg = nextId('lbself');
	const clip = nextId('lbselfc');
	const cy = y + SELF_H / 2;
	const color = tierColor(entry);

	out.push(`<defs>
		<linearGradient id="${bg}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#2a1a78"/><stop offset="0.55" stop-color="#171046"/><stop offset="1" stop-color="#241466"/></linearGradient>
		<clipPath id="${clip}"><rect x="${CARD_X}" y="${y}" width="${CARD_W}" height="${SELF_H}" rx="16"/></clipPath>
	</defs>`);
	out.push(`<rect x="${CARD_X}" y="${y}" width="${CARD_W}" height="${SELF_H}" rx="16" fill="url(#${bg})"/>`);
	out.push(`<g clip-path="url(#${clip})"><rect x="${CARD_X}" y="${y}" width="6" height="${SELF_H}" fill="#8a66ff"/></g>`);
	out.push(`<rect x="${CARD_X + 0.75}" y="${y + 0.75}" width="${CARD_W - 1.5}" height="${SELF_H - 1.5}" rx="15.5" fill="none" stroke="#5a3fd0" stroke-width="1.5"/>`);

	out.push(sparkle(76, y + 32, 11, '#9d82ff', 0.95), sparkle(58, y + 64, 6, '#9d82ff', 0.55), sparkle(1114, y + 70, 12, '#9d82ff', 0.6), sparkle(1096, y + 30, 5, '#9d82ff', 0.45));

	out.push(text(104, y + 38, 'Tu posición', { size: 16, weight: 500, fill: '#b3a6f5' }));
	const position = `#${entry.position}`;
	out.push(text(104, y + 80, position, { font: 'rajdhani', size: position.length > 5 ? 38 : 48, weight: 700, fill: '#ffffff' }));

	out.push(avatar(ctx, entry, 330, cy, 68, '#8a66ff', 3));
	const name = fitText(entry.displayName, 30, 340, 'rajdhani', 20);
	const tag = fitText(riotId(entry), 21, 340, 'rajdhani', 14);
	out.push(text(378, cy - 3, name.content, { font: 'rajdhani', size: name.size, weight: 700, fill: '#f3f1ff' }));
	out.push(text(379, cy + 23, tag.content, { font: 'rajdhani', size: tag.size, weight: 500, fill: '#aaa1d8' }));

	out.push(line(790, y + 18, 790, y + SELF_H - 18, '#3b2d84'));
	out.push(emblemImage(ctx, entry.tier, 820, cy - 40, 130, 80));
	const parts = tierParts(entry);
	const label = fitText(parts.detail, 32, 190, 'rajdhani', 20);
	out.push(text(966, cy - 2, label.content, { font: 'rajdhani', size: label.size, weight: 700, fill: '#f6f4ff' }));
	out.push(text(967, cy + 28, `${entry.lp} LP`, { font: 'rajdhani', size: 27, weight: 600, fill: color }));

	return out.join('');
}

export function footer(ctx: Ctx, y: number): string {
	const logo = ctx.local.get('logo');
	const out: string[] = [];

	out.push(text(26, y, `© ${ctx.now.getFullYear()} CAPYGG  /  DATA FROM RIOT GAMES API`, { size: 13, weight: 500, fill: '#5f647c', spacing: 1.4 }));
	out.push(text(1172, y + 4, 'CapyGG', { size: 20, weight: 600, fill: '#c9cde0', anchor: 'end' }));
	out.push(logo ? `<image xlink:href="${logo}" x="1050" y="${y - 22}" width="36" height="32" preserveAspectRatio="xMidYMid meet"/>` : vectorIcon('capybara', 1052, y - 22, 34));
	return out.join('');
}

/* -------------------------------------------------------------------------- */
/*  Documento                                                                  */
/* -------------------------------------------------------------------------- */

function buildSvg(data: LeaderboardRenderData, ctx: Ctx): string {
	const parts: string[] = [];
	parts.push(header(ctx, data));

	// Tabla
	const rows: string[] = [];
	let y = TABLE_TOP + 68;
	for (const entry of data.entries) {
		if (entry.position <= PODIUM_SIZE) {
			rows.push(bigRow(ctx, entry, y));
			y += BIG_PITCH;
		} else {
			rows.push(compactRow(ctx, entry, y, data.self?.position === entry.position));
			y += ROW_PITCH;
		}
	}

	if (!data.entries.length) {
		rows.push(text(600, y + 40, 'No hay jugadores en esta página.', { size: 16, fill: C.faint, anchor: 'middle' }));
		y += 80;
	}

	const lastEntry = data.entries.at(-1);
	const lastBottom = y - (lastEntry && lastEntry.position <= PODIUM_SIZE ? BIG_PITCH - BIG_H : ROW_PITCH - ROW_H);
	const pagerY = lastBottom + 18;
	const tableBottom = pagerY + 36 + 18;

	parts.push(cardRect(TABLE_TOP, tableBottom - TABLE_TOP));
	const label = (x: number, content: string, anchor: 'start' | 'middle' | 'end' = 'start') => text(x, TABLE_TOP + 38, content, { size: 14, weight: 500, fill: '#7b8199', spacing: 2.2, anchor });
	parts.push(label(100, 'RANK', 'middle'), label(222, 'JUGADOR'), label(706, 'WINRATE', 'middle'), label(908, 'ELO'));
	parts.push(line(36, TABLE_TOP + 54, 1164, TABLE_TOP + 54));
	parts.push(...rows);
	parts.push(pager(data, pagerY));

	let bottom = tableBottom;
	if (data.self) {
		const selfY = tableBottom + 16;
		parts.push(selfBar(ctx, data.self, selfY));
		bottom = selfY + SELF_H;
	}

	const footerY = bottom + 44;
	parts.push(footer(ctx, footerY));

	const height = footerY + 38;
	const bg = nextId('lbbg');

	return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}">
<defs><linearGradient id="${bg}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.pageTop}"/><stop offset="1" stop-color="${C.pageBottom}"/></linearGradient></defs>
<rect width="${WIDTH}" height="${height}" fill="url(#${bg})"/>
${parts.join('\n')}
</svg>`;
}