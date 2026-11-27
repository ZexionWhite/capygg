import {
	avatar,
	BIG_H,
	BIG_PITCH,
	CARD_W,
	CARD_X,
	cardRect,
	crestImage,
	emblemImage,
	fitText,
	footer,
	HEADER_H,
	HEADER_TOP,
	laurel,
	LEADERBOARD_COVER_PATH,
	MEDALS,
	minicrestPath,
	pager,
	PODIUM_SIZE,
	ROW_H,
	ROW_PITCH,
	SELF_H,
	sparkle,
	TABLE_TOP,
	tierParts,
	WIDTH,
	type Ctx
} from '../leaderboard/render.js';
import { dataDragonVersion, ddragonUrls, localImage, rankEmblemPath, remoteImageAny } from '../profile/assets.js';
import { nextId } from '../profile/icons.js';
import { C, line, pillShape, rasterize, text, textWidth, tierColor, type ProfileRank } from '../profile/render.js';

/* -------------------------------------------------------------------------- */
/*  Datos que recibe el render                                                 */
/* -------------------------------------------------------------------------- */

export type ChampionBoardMode = 'POWER' | 'MASTERY';

export interface ChampionBoardEntry {
	/** Posición global (1 = primero). */
	position: number;
	displayName: string;
	gameName: string;
	tagLine: string;
	profileIconId: number;
	/** Rango actual (`UNRANKED` si todavía no lo tenemos). */
	tier: string;
	division: string;
	lp: number;
	/** Número grande de la derecha, ya formateado. */
	score: string;
	/** Una celda por columna de stats (mismo orden que `statColumns`). */
	stats: Array<{ value: string; tone?: 'good' | 'bad' | 'muted' }>;
	isOtp: boolean;
}

/** Lo que va en la barra de abajo: tu posición, o el aviso de por qué no aparecés. */
export type SelfBar = { kind: 'ranked'; entry: ChampionBoardEntry } | { kind: 'missing'; headline: string; detail: string };

export interface ChampionBoardData {
	guildName: string;
	mode: ChampionBoardMode;
	/** Nombre para mostrar del campeón. */
	championName: string;
	/** Id de Data Dragon (para ícono y splash). */
	championKey: string;
	statColumns: string[];
	scoreLabel: string;
	/** Página actual, desde 0. */
	page: number;
	totalPages: number;
	totalPlayers: number;
	pageSize: number;
	/** Solo las filas de la página actual. */
	entries: ChampionBoardEntry[];
	self: SelfBar;
	now?: Date;
}

/* -------------------------------------------------------------------------- */
/*  Diseño                                                                     */
/* -------------------------------------------------------------------------- */

const MODE_TABS: Array<{ key: ChampionBoardMode; label: string; icon: 'bolt' | 'crest' }> = [
	{ key: 'POWER', label: 'Poder', icon: 'bolt' },
	{ key: 'MASTERY', label: 'Maestría', icon: 'crest' }
];

/**
 * Posiciones según cuántas columnas de stats tenga el ranking. Con 2 columnas (Maestría) todo se corre a la izquierda
 * para que entre un puntaje largo como 1.500.000 sin pisar el elo.
 */
const LAYOUTS: Record<number, { slots: number[]; bigEloX: number; compactEloX: number; eloLabelX: number }> = {
	2: { slots: [530, 645], bigEloX: 704, compactEloX: 718, eloLabelX: 722 },
	3: { slots: [588, 668, 760], bigEloX: 810, compactEloX: 818, eloLabelX: 822 }
};

function layoutOf(data: ChampionBoardData) {
	return LAYOUTS[data.statColumns.length] ?? LAYOUTS[3]!;
}

const SCORE_RIGHT = 1146;

/* -------------------------------------------------------------------------- */
/*  Punto de entrada                                                           */
/* -------------------------------------------------------------------------- */

export async function renderChampionBoardImage(data: ChampionBoardData): Promise<Buffer> {
	const version = await dataDragonVersion();
	const urls = ddragonUrls(version);
	const people = [...data.entries, ...(data.self.kind === 'ranked' ? [data.self.entry] : [])];
	const tiers = new Set<string>(people.map((person) => person.tier.toUpperCase()));

	const remote = new Map<string, string | null>();
	const local = new Map<string, string | null>();

	await Promise.all([
		...[...new Set(people.map((person) => person.profileIconId))].map(async (id) => remote.set(urls.profileIcon(id), await remoteImageAny([urls.profileIcon(id), urls.profileIconFallback(id)]))),
		remoteImageAny([urls.champion(data.championKey)]).then((value) => remote.set(urls.champion(data.championKey), value)),
		remoteImageAny([urls.splash(data.championKey)]).then((value) => remote.set(urls.splash(data.championKey), value)),
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

function rankOf(entry: ChampionBoardEntry): ProfileRank {
	return { tier: entry.tier, division: entry.division, lp: entry.lp, wins: 0, losses: 0 };
}

function isUnranked(entry: ChampionBoardEntry): boolean {
	return entry.tier.toUpperCase() === 'UNRANKED';
}

function toneColor(tone: 'good' | 'bad' | 'muted' | undefined): string {
	return tone === 'good' ? C.winText : tone === 'bad' ? C.lossText : '#c9cde0';
}

function riotId(entry: ChampionBoardEntry): string {
	return `${entry.gameName}#${entry.tagLine}`;
}

/** Parte un texto en hasta `maxLines` líneas que entren en `maxWidth`. */
function wrap(content: string, size: number, maxWidth: number, maxLines: number): string[] {
	const lines: string[] = [];
	let current = '';

	for (const word of content.split(/\s+/).filter(Boolean)) {
		const candidate = current ? `${current} ${word}` : word;
		if (current && textWidth(candidate, size) > maxWidth) {
			lines.push(current);
			current = word;
		} else {
			current = candidate;
		}
	}
	if (current) lines.push(current);

	if (lines.length > maxLines) {
		const kept = lines.slice(0, maxLines);
		kept[maxLines - 1] = fitText(`${kept[maxLines - 1]} ${lines.slice(maxLines).join(' ')}`, size, maxWidth, 'inter', size).content;
		return kept;
	}
	return lines;
}

function otpTag(x: number, y: number): string {
	return `<rect x="${x}" y="${y}" width="40" height="20" rx="10" fill="#241a5c" stroke="#6d4ff0" stroke-width="1"/>${text(x + 20, y + 14.5, 'OTP', { size: 11.5, weight: 700, fill: '#cdbfff', anchor: 'middle', spacing: 0.6 })}`;
}

/** Nombre + Riot ID (con la etiqueta OTP al lado del nombre si corresponde). */
function playerText(entry: ChampionBoardEntry, x: number, cy: number, o: { nameSize: number; idSize: number; maxWidth: number; nameDy: number; idDy: number; nameColor: string; idColor: string }): string {
	const reserved = entry.isOtp ? 50 : 0;
	const name = fitText(entry.displayName, o.nameSize, o.maxWidth - reserved, 'rajdhani', 16);
	const tag = fitText(riotId(entry), o.idSize, o.maxWidth, 'rajdhani', 13);
	const out = [text(x, cy + o.nameDy, name.content, { font: 'rajdhani', size: name.size, weight: 700, fill: o.nameColor })];

	if (entry.isOtp) out.push(otpTag(x + textWidth(name.content, name.size, 'rajdhani') + 10, cy + o.nameDy - name.size * 0.72));
	out.push(text(x + 1, cy + o.idDy, tag.content, { font: 'rajdhani', size: tag.size, weight: 500, fill: o.idColor }));
	return out.join('');
}

function statCells(data: ChampionBoardData, entry: ChampionBoardEntry, cy: number, size: number): string {
	const slots = layoutOf(data).slots;
	return entry.stats.map((stat, index) => text(slots[index] ?? 700, cy, stat.value, { font: 'rajdhani', size, weight: 700, fill: toneColor(stat.tone), anchor: 'middle' })).join('');
}

/* -------------------------------------------------------------------------- */
/*  Íconos vectoriales de las pastillas                                        */
/* -------------------------------------------------------------------------- */

function modeIcon(kind: 'bolt' | 'crest', x: number, y: number, size: number, stroke: string): string {
	const body =
		kind === 'bolt'
			? `<path d="M13.5 2.8L5 13.6h6.2L10.2 21.2 19 10.2h-6.3z" stroke="${stroke}" stroke-width="1.7"/>`
			: `<path d="M12 3l7.5 3.2v6.1c0 4.1-3.1 7.2-7.5 8.7-4.4-1.5-7.5-4.6-7.5-8.7V6.2z" stroke="${stroke}" stroke-width="1.7"/><path d="M8.6 11.6l2.4 2.4 4.4-4.6" stroke="${stroke}" stroke-width="1.7"/>`;
	return `<g transform="translate(${x} ${y}) scale(${size / 24})" fill="none" stroke-linecap="round" stroke-linejoin="round">${body}</g>`;
}

/* -------------------------------------------------------------------------- */
/*  Header                                                                     */
/* -------------------------------------------------------------------------- */

function header(ctx: Ctx, data: ChampionBoardData): string {
	const out: string[] = [];
	const clip = nextId('cbhdr');
	const fadeX = nextId('cbfx');
	const fadeY = nextId('cbfy');
	const glow = nextId('cbglow');
	const tabGlow = nextId('cbtg');
	const ring = nextId('cbring');
	const frame = nextId('cbframe');
	const splash = ctx.remote.get(ctx.urls.splash(data.championKey)) ?? ctx.local.get('cover');
	const icon = ctx.remote.get(ctx.urls.champion(data.championKey));

	out.push(`<defs>
		<clipPath id="${clip}"><rect x="${CARD_X}" y="${HEADER_TOP}" width="${CARD_W}" height="${HEADER_H}" rx="16"/></clipPath>
		<clipPath id="${frame}"><rect x="62" y="82" width="104" height="104" rx="22"/></clipPath>
		<linearGradient id="${fadeX}" gradientUnits="userSpaceOnUse" x1="480" y1="0" x2="860" y2="0"><stop offset="0" stop-color="${C.card}" stop-opacity="1"/><stop offset="1" stop-color="${C.card}" stop-opacity="0"/></linearGradient>
		<linearGradient id="${fadeY}" gradientUnits="userSpaceOnUse" x1="0" y1="190" x2="0" y2="${HEADER_TOP + HEADER_H}"><stop offset="0" stop-color="${C.card}" stop-opacity="0"/><stop offset="1" stop-color="${C.card}" stop-opacity="1"/></linearGradient>
		<radialGradient id="${glow}" gradientUnits="userSpaceOnUse" cx="930" cy="140" r="340"><stop offset="0" stop-color="#7a58ee" stop-opacity="0.3"/><stop offset="1" stop-color="#7a58ee" stop-opacity="0"/></radialGradient>
		<linearGradient id="${ring}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#a98cff"/><stop offset="1" stop-color="#5b3fe0"/></linearGradient>
		<filter id="${tabGlow}" x="-30%" y="-60%" width="160%" height="220%"><feGaussianBlur stdDeviation="9"/></filter>
	</defs>`);

	out.push(`<rect x="${CARD_X}" y="${HEADER_TOP}" width="${CARD_W}" height="${HEADER_H}" rx="16" fill="${C.card}"/>`);
	out.push(`<g clip-path="url(#${clip})">`);
	out.push(`<rect x="${CARD_X}" y="${HEADER_TOP}" width="${CARD_W}" height="${HEADER_H}" fill="url(#${glow})"/>`);
	if (splash) out.push(`<image xlink:href="${splash}" x="420" y="${HEADER_TOP - 20}" width="760" height="${Math.round(760 * (717 / 1215))}" preserveAspectRatio="xMidYMid slice" opacity="0.9"/>`);
	out.push(`<rect x="${CARD_X}" y="${HEADER_TOP}" width="${CARD_W}" height="${HEADER_H}" fill="url(#${fadeX})"/>`);
	out.push(`<rect x="${CARD_X}" y="${HEADER_TOP}" width="${CARD_W}" height="${HEADER_H}" fill="url(#${fadeY})"/>`);
	out.push('</g>');
	out.push(`<rect x="${CARD_X + 0.5}" y="${HEADER_TOP + 0.5}" width="${CARD_W - 1}" height="${HEADER_H - 1}" rx="15.5" fill="none" stroke="${C.cardBorder}"/>`);

	out.push(text(47, 46, 'LEAGUE PROFILE / CHAMPION RANKING', { size: 14, weight: 500, fill: '#6c7189', spacing: 2.4 }));

	// Retrato del campeón
	out.push(`<rect x="62" y="82" width="104" height="104" rx="22" fill="#12142a"/>`);
	if (icon) out.push(`<g clip-path="url(#${frame})"><image xlink:href="${icon}" x="58" y="78" width="112" height="112" preserveAspectRatio="xMidYMid slice"/></g>`);
	out.push(`<rect x="63" y="83" width="102" height="102" rx="21" fill="none" stroke="url(#${ring})" stroke-width="3"/>`);

	const title = fitText(data.championName, 72, 400, 'rajdhani', 40);
	out.push(text(192, 142, title.content, { font: 'rajdhani', size: title.size, weight: 700, fill: '#e6e9f8' }));

	const subtitle = data.mode === 'MASTERY' ? `Más maestría con ${data.championName} en ${data.guildName}` : `Los mejores ${data.championName} de ${data.guildName}`;
	const fitted = fitText(subtitle, 28, 600, 'rajdhani', 18);
	out.push(text(194, 184, fitted.content, { font: 'rajdhani', size: fitted.size, weight: 500, fill: '#8a90aa' }));

	// Tipo de ranking activo
	let x = 50;
	const y = 233;
	const h = 46;
	for (const tab of MODE_TABS) {
		const active = tab.key === data.mode;
		const w = 18 + 22 + 10 + textWidth(tab.label, 17) + 26;
		const stroke = active ? '#a58cff' : '#7d84a0';

		if (active) {
			out.push(`<rect x="${x + 4}" y="${y + 6}" width="${w - 8}" height="${h - 12}" rx="14" fill="#6d4ff0" opacity=".45" filter="url(#${tabGlow})"/>`);
			out.push(pillShape(x, y, w, h, '#1c1350', '#6d4ff0'));
		} else {
			out.push(pillShape(x, y, w, h, '#0d0f18', '#2b2e40'));
		}

		out.push(modeIcon(tab.icon, x + 18, y + (h - 22) / 2, 22, stroke));
		out.push(text(x + 18 + 22 + 10, y + h / 2 + 6, tab.label, { size: 17, weight: active ? 600 : 500, fill: active ? '#f1eeff' : '#9aa0b8' }));
		x += w + 12;
	}

	return out.join('');
}

/* -------------------------------------------------------------------------- */
/*  Filas                                                                      */
/* -------------------------------------------------------------------------- */

/** Rango a la derecha de los stats: emblema/escudo + elo y LP (o "Sin rango"). */
function eloCell(ctx: Ctx, entry: ChampionBoardEntry, o: { big: boolean; x: number; cy: number }): string {
	const out: string[] = [];
	const unranked = isUnranked(entry);

	if (o.big) {
		out.push(emblemImage(ctx, entry.tier, o.x, o.cy - 35, 92, 70));
		const textX = o.x + 100;
		if (unranked) return out.concat(text(textX, o.cy + 8, 'SIN RANGO', { font: 'rajdhani', size: 22, weight: 600, fill: '#7d84a0', spacing: 0.4 })).join('');

		const label = fitText(tierParts(rankOf(entry)).detail, 27, 128, 'rajdhani', 18);
		out.push(text(textX, o.cy - 1, label.content, { font: 'rajdhani', size: label.size, weight: 700, fill: '#eef0fb' }));
		out.push(text(textX + 1, o.cy + 26, `${entry.lp} LP`, { font: 'rajdhani', size: 22, weight: 600, fill: tierColor(rankOf(entry)) }));
		return out.join('');
	}

	out.push(crestImage(ctx, entry.tier, o.x, o.cy - 21, 50, 42));
	const textX = o.x + 60;
	if (unranked) return out.concat(text(textX, o.cy + 7, 'SIN RANGO', { font: 'rajdhani', size: 19, weight: 600, fill: '#7d84a0', spacing: 0.4 })).join('');

	out.push(text(textX, o.cy - 1, tierParts(rankOf(entry)).detail, { font: 'rajdhani', size: 21, weight: 600, fill: '#dfe3f4', spacing: 0.5 }));
	out.push(text(textX, o.cy + 16, `${entry.lp} LP`, { size: 13.5, weight: 500, fill: '#8f95ad' }));
	return out.join('');
}

function bigRow(ctx: Ctx, data: ChampionBoardData, entry: ChampionBoardEntry, y: number): string {
	const medal = MEDALS[Math.min(entry.position, PODIUM_SIZE) - 1]!;
	const out: string[] = [];
	const clip = nextId('cbrow');
	const tint = nextId('cbtint');
	const border = nextId('cbbrd');
	const num = nextId('cbnum');
	const cy = y + BIG_H / 2;

	out.push(`<defs>
		<clipPath id="${clip}"><rect x="36" y="${y}" width="1128" height="${BIG_H}" rx="14"/></clipPath>
		<linearGradient id="${tint}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${medal.main}" stop-opacity="0.3"/><stop offset="0.55" stop-color="${medal.main}" stop-opacity="0.08"/><stop offset="1" stop-color="${medal.main}" stop-opacity="0.14"/></linearGradient>
		<linearGradient id="${border}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${medal.main}"/><stop offset="1" stop-color="${medal.dark}" stop-opacity="0.55"/></linearGradient>
		<linearGradient id="${num}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${medal.light}"/><stop offset="1" stop-color="${medal.main}"/></linearGradient>
	</defs>`);

	out.push(`<rect x="36" y="${y}" width="1128" height="${BIG_H}" rx="14" fill="#0b0d14"/>`);
	out.push(`<g clip-path="url(#${clip})"><rect x="36" y="${y}" width="1128" height="${BIG_H}" fill="url(#${tint})"/><rect x="36" y="${y}" width="8" height="${BIG_H}" fill="${medal.main}"/></g>`);
	out.push(`<rect x="36.75" y="${y + 0.75}" width="1126.5" height="${BIG_H - 1.5}" rx="13.5" fill="none" stroke="url(#${border})" stroke-width="1.5"/>`);

	out.push(laurel(122, cy, medal));
	out.push(text(122, cy + 20, String(entry.position), { font: 'rajdhani', size: 62, weight: 700, fill: `url(#${num})`, anchor: 'middle' }));

	out.push(avatar(ctx, entry, 252, cy, 76, medal.main, 3));
	out.push(playerText(entry, 308, cy, { nameSize: 32, idSize: 21, maxWidth: 230, nameDy: -4, idDy: 24, nameColor: '#f0f2fc', idColor: '#a0a6bd' }));

	out.push(statCells(data, entry, cy + 10, 30));
	out.push(eloCell(ctx, entry, { big: true, x: layoutOf(data).bigEloX, cy }));
	out.push(text(SCORE_RIGHT + 2, cy + 15, entry.score, { font: 'rajdhani', size: entry.score.length > 7 ? 36 : 44, weight: 700, fill: `url(#${num})`, anchor: 'end' }));

	return out.join('');
}

function compactRow(ctx: Ctx, data: ChampionBoardData, entry: ChampionBoardEntry, y: number, isSelf: boolean): string {
	const out: string[] = [];
	const cy = y + ROW_H / 2;
	const clip = nextId('cbcr');

	out.push(`<defs><clipPath id="${clip}"><rect x="36" y="${y}" width="1128" height="${ROW_H}" rx="11"/></clipPath></defs>`);
	out.push(`<rect x="36" y="${y}" width="1128" height="${ROW_H}" rx="11" fill="${isSelf ? '#120f33' : '#0d0f17'}"/>`);
	if (isSelf) out.push(`<g clip-path="url(#${clip})"><rect x="36" y="${y}" width="6" height="${ROW_H}" fill="#7b5cff"/></g>`);
	out.push(`<rect x="36.5" y="${y + 0.5}" width="1127" height="${ROW_H - 1}" rx="10.5" fill="none" stroke="${isSelf ? '#4a35a8' : '#1f2230'}"/>`);

	const position = String(entry.position);
	out.push(text(100, cy + 9, position, { font: 'rajdhani', size: position.length > 3 ? 20 : position.length > 2 ? 23 : 27, weight: 700, fill: isSelf ? '#cdbfff' : '#a9afc7', anchor: 'middle' }));

	out.push(avatar(ctx, entry, 224, cy, 42, '#2b2e40', 2));
	out.push(playerText(entry, 260, cy, { nameSize: 22, idSize: 16.5, maxWidth: 240, nameDy: -3, idDy: 16, nameColor: '#e9ecf8', idColor: '#8a90a6' }));

	out.push(statCells(data, entry, cy + 8, 22));
	out.push(eloCell(ctx, entry, { big: false, x: layoutOf(data).compactEloX, cy }));
	out.push(text(SCORE_RIGHT, cy + 10, entry.score, { font: 'rajdhani', size: entry.score.length > 7 ? 24 : 29, weight: 700, fill: isSelf ? '#d9ceff' : '#b9a6ff', anchor: 'end' }));

	return out.join('');
}

/* -------------------------------------------------------------------------- */
/*  Barra de abajo                                                             */
/* -------------------------------------------------------------------------- */

function selfBar(ctx: Ctx, data: ChampionBoardData, y: number): string {
	const out: string[] = [];
	const bg = nextId('cbself');
	const clip = nextId('cbselfc');
	const cy = y + SELF_H / 2;
	const self = data.self;

	out.push(`<defs>
		<linearGradient id="${bg}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#2a1a78"/><stop offset="0.55" stop-color="#171046"/><stop offset="1" stop-color="#241466"/></linearGradient>
		<clipPath id="${clip}"><rect x="${CARD_X}" y="${y}" width="${CARD_W}" height="${SELF_H}" rx="16"/></clipPath>
	</defs>`);
	out.push(`<rect x="${CARD_X}" y="${y}" width="${CARD_W}" height="${SELF_H}" rx="16" fill="url(#${bg})"/>`);
	out.push(`<g clip-path="url(#${clip})"><rect x="${CARD_X}" y="${y}" width="6" height="${SELF_H}" fill="#8a66ff"/></g>`);
	out.push(`<rect x="${CARD_X + 0.75}" y="${y + 0.75}" width="${CARD_W - 1.5}" height="${SELF_H - 1.5}" rx="15.5" fill="none" stroke="#5a3fd0" stroke-width="1.5"/>`);
	out.push(sparkle(76, y + 32, 11, '#9d82ff', 0.95), sparkle(58, y + 64, 6, '#9d82ff', 0.55), sparkle(1160, y + 22, 8, '#9d82ff', 0.6), sparkle(1142, y + 14, 4, '#9d82ff', 0.45));
	out.push(text(104, y + 38, 'Tu posición', { size: 16, weight: 500, fill: '#b3a6f5' }));

	if (self.kind === 'missing') {
		out.push(text(104, y + 80, '—', { font: 'rajdhani', size: 48, weight: 700, fill: '#7d6fc4' }));
		out.push(line(224, y + 18, 224, y + SELF_H - 18, '#3b2d84'));
		out.push(text(258, y + 40, self.headline, { font: 'rajdhani', size: 28, weight: 700, fill: '#f6f4ff' }));
		wrap(self.detail, 16, 800, 2).forEach((content, index) => out.push(text(259, y + 65 + index * 21, content, { size: 16, weight: 400, fill: '#c3b9f7' })));
		return out.join('');
	}

	const entry = self.entry;
	const position = `#${entry.position}`;
	out.push(text(104, y + 80, position, { font: 'rajdhani', size: position.length > 5 ? 38 : 48, weight: 700, fill: '#ffffff' }));

	out.push(avatar(ctx, entry, 296, cy, 68, '#8a66ff', 3));
	out.push(playerText(entry, 344, cy, { nameSize: 30, idSize: 21, maxWidth: 320, nameDy: -3, idDy: 23, nameColor: '#f3f1ff', idColor: '#aaa1d8' }));

	out.push(line(700, y + 18, 700, y + SELF_H - 18, '#3b2d84'));
	out.push(text(730, y + 38, data.scoreLabel, { size: 13, weight: 500, fill: '#9d92e0', spacing: 2 }));
	out.push(text(730, y + 80, entry.score, { font: 'rajdhani', size: entry.score.length > 7 ? 38 : 46, weight: 700, fill: '#ffffff' }));

	out.push(line(900, y + 18, 900, y + SELF_H - 18, '#3b2d84'));
	out.push(emblemImage(ctx, entry.tier, 920, cy - 36, 92, 72));
	if (isUnranked(entry)) {
		out.push(text(1022, cy + 8, 'SIN RANGO', { font: 'rajdhani', size: 22, weight: 600, fill: '#a99cf0', spacing: 0.4 }));
	} else {
		const label = fitText(tierParts(rankOf(entry)).detail, 26, 132, 'rajdhani', 18);
		out.push(text(1022, cy - 2, label.content, { font: 'rajdhani', size: label.size, weight: 700, fill: '#f6f4ff' }));
		out.push(text(1023, cy + 24, `${entry.lp} LP`, { font: 'rajdhani', size: 22, weight: 600, fill: tierColor(rankOf(entry)) }));
	}

	return out.join('');
}

/* -------------------------------------------------------------------------- */
/*  Documento                                                                  */
/* -------------------------------------------------------------------------- */

function buildSvg(data: ChampionBoardData, ctx: Ctx): string {
	const parts: string[] = [];
	parts.push(header(ctx, data));

	const rows: string[] = [];
	let y = TABLE_TOP + 68;
	for (const entry of data.entries) {
		if (entry.position <= PODIUM_SIZE) {
			rows.push(bigRow(ctx, data, entry, y));
			y += BIG_PITCH;
		} else {
			rows.push(compactRow(ctx, data, entry, y, data.self.kind === 'ranked' && data.self.entry.position === entry.position));
			y += ROW_PITCH;
		}
	}

	let tableBottom: number;
	if (data.entries.length === 0) {
		rows.push(text(600, y + 40, 'Todavía no hay nadie en este ranking. ¡Podés ser el primero!', { size: 17, fill: '#7c8299', anchor: 'middle' }));
		tableBottom = y + 84;
	} else {
		const last = data.entries.at(-1)!;
		const lastBottom = y - (last.position <= PODIUM_SIZE ? BIG_PITCH - BIG_H : ROW_PITCH - ROW_H);
		const pagerY = lastBottom + 18;
		rows.push(pager({ ...data, pending: 0 }, pagerY));
		tableBottom = pagerY + 36 + 18;
	}

	parts.push(cardRect(TABLE_TOP, tableBottom - TABLE_TOP));

	const label = (x: number, content: string, anchor: 'start' | 'middle' | 'end' = 'start') => text(x, TABLE_TOP + 38, content, { size: 14, weight: 500, fill: '#7b8199', spacing: 2.2, anchor });
	const { slots, eloLabelX } = layoutOf(data);
	parts.push(label(100, 'RANK', 'middle'), label(222, 'JUGADOR'));
	data.statColumns.forEach((column, index) => parts.push(label(slots[index] ?? 700, column, 'middle')));
	parts.push(label(eloLabelX, 'ELO'), label(SCORE_RIGHT, data.scoreLabel, 'end'));
	parts.push(line(36, TABLE_TOP + 54, 1164, TABLE_TOP + 54));
	parts.push(...rows);

	const selfY = tableBottom + 16;
	parts.push(selfBar(ctx, data, selfY));

	const footerY = selfY + SELF_H + 44;
	parts.push(footer(ctx, footerY));

	const height = footerY + 38;
	const bg = nextId('cbbg');

	return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}">
<defs><linearGradient id="${bg}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.pageTop}"/><stop offset="1" stop-color="${C.pageBottom}"/></linearGradient></defs>
<rect width="${WIDTH}" height="${height}" fill="url(#${bg})"/>
${parts.join('\n')}
</svg>`;
}