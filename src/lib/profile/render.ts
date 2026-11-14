import sharp from 'sharp';
import { DATA_DRAGON_VERSION } from '../constants';
import type { RiotLeagueEntry, RiotMatchSummary } from '../types/riot';

export interface ProfileRenderData {
	displayName: string;
	gameName: string;
	tagLine: string;
	region: string;
	summonerLevel: number;
	profileIconId: number;
	solo: RiotLeagueEntry | undefined;
	flex: RiotLeagueEntry | undefined;
	tft: RiotLeagueEntry | undefined;
	matches: RiotMatchSummary[];
}

const imageCache = new Map<string, Promise<string | null>>();
const IMAGE_TIMEOUT_MS = 4_000;

export async function renderProfileImage(data: ProfileRenderData): Promise<Buffer> {
	const profileIcon = await imageDataUri(
		`https://ddragon.leagueoflegends.com/cdn/${DATA_DRAGON_VERSION}/img/profileicon/${data.profileIconId}.png`
	);
	const [soloRankIcon, flexRankIcon, tftRankIcon] = await Promise.all([rankImage(data.solo), rankImage(data.flex), rankImage(data.tft)]);
	const championIcons = await Promise.all(
		data.matches.map((match) =>
			match.participant.isTft || !match.participant.championName
				? Promise.resolve(null)
				: imageDataUri(
						`https://ddragon.leagueoflegends.com/cdn/${DATA_DRAGON_VERSION}/img/champion/${encodeURIComponent(
							match.participant.championName
						)}.png`
					)
		)
	);

	const svg = buildSvg(data, profileIcon, soloRankIcon, flexRankIcon, tftRankIcon, championIcons);
	return sharp(Buffer.from(svg)).png().toBuffer();
}

async function rankImage(rank: RiotLeagueEntry | undefined): Promise<string | null> {
	if (!rank) return null;
	const emblemUrl = `https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-static-data/global/default/assets/ux/ranked-emblems/Rank=${encodeURIComponent(
		rank.tier
	)}.png`;
	return (await imageDataUri(emblemUrl)) ?? buildRankFallbackIcon(rank.tier);
}

async function imageDataUri(url: string): Promise<string | null> {
	const cached = imageCache.get(url);
	if (cached) return cached;

	const request = (async () => {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS);
		try {
			const response = await fetch(url, { signal: controller.signal });
			if (!response.ok) return null;
			const contentType = response.headers.get('content-type') ?? 'image/png';
			const bytes = Buffer.from(await response.arrayBuffer());
			return `data:${contentType};base64,${bytes.toString('base64')}`;
		} finally {
			clearTimeout(timeout);
		}
	})().catch(() => null);
	imageCache.set(url, request);
	return request;
}

function buildSvg(
	data: ProfileRenderData,
	profileIcon: string | null,
	soloRankIcon: string | null,
	flexRankIcon: string | null,
	tftRankIcon: string | null,
	championIcons: Array<string | null>
): string {
	const matchCards = data.matches.map((match, index) => buildMatchCard(match, championIcons[index] ?? null, 60 + index * 260)).join('');
	const displayName = escapeXml(data.displayName);
	const accountName = escapeXml(`${data.gameName}#${data.tagLine}`);

	return `<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="920" viewBox="0 0 1400 920">
		<rect width="1400" height="920" fill="#090a0d"/>
		<rect x="36" y="36" width="1328" height="848" rx="14" fill="#101217" stroke="#262a31"/>
		<text x="72" y="92" fill="#8f98a6" font-family="Helvetica Neue,Arial,sans-serif" font-size="16" letter-spacing="3">LEAGUE PROFILE / ${escapeXml(data.region)}</text>
		${profileIcon ? `<image href="${profileIcon}" x="72" y="132" width="132" height="132" preserveAspectRatio="xMidYMid slice"/>` : '<rect x="72" y="132" width="132" height="132" fill="#252a33"/>'}
		<text x="238" y="176" fill="#f3f5f7" font-family="Helvetica Neue,Arial,sans-serif" font-size="42" font-weight="700">${displayName}</text>
		<text x="238" y="214" fill="#8f98a6" font-family="Helvetica Neue,Arial,sans-serif" font-size="20">${accountName}</text>
		<text x="238" y="254" fill="#c6ccd5" font-family="Helvetica Neue,Arial,sans-serif" font-size="18">SUMMONER LEVEL <tspan fill="#f3f5f7" font-weight="700">${data.summonerLevel}</tspan></text>
		<line x1="72" y1="310" x2="1328" y2="310" stroke="#292e36"/>
		<text x="72" y="356" fill="#8f98a6" font-family="Helvetica Neue,Arial,sans-serif" font-size="15" letter-spacing="2">RANKED SOLO / DUO</text>
		<text x="540" y="356" fill="#8f98a6" font-family="Helvetica Neue,Arial,sans-serif" font-size="15" letter-spacing="2">FLEX 5V5</text>
		<text x="930" y="356" fill="#8f98a6" font-family="Helvetica Neue,Arial,sans-serif" font-size="15" letter-spacing="2">TFT</text>
		${rankBlock(data.solo, soloRankIcon, 72, 382, true)}
		${rankBlock(data.flex, flexRankIcon, 540, 382, false)}
		${rankBlock(data.tft, tftRankIcon, 930, 382, false)}
		<line x1="72" y1="570" x2="1328" y2="570" stroke="#292e36"/>
		<text x="72" y="616" fill="#8f98a6" font-family="Helvetica Neue,Arial,sans-serif" font-size="15" letter-spacing="2">ÚLTIMAS PARTIDAS</text>
		${matchCards || '<text x="72" y="690" fill="#747d8a" font-family="Helvetica Neue,Arial,sans-serif" font-size="20">No hay partidas recientes disponibles.</text>'}
		<text x="72" y="850" fill="#56606d" font-family="monospace" font-size="14">© 2026 CAPYGG  /  DATA FROM RIOT GAMES API</text>
	</svg>`;
}

function rankBlock(rank: RiotLeagueEntry | undefined, image: string | null, x: number, y: number, large: boolean): string {
	if (!rank) {
		return `<text x="${x}" y="${y + 56}" fill="#f3f5f7" font-family="Helvetica Neue,Arial,sans-serif" font-size="${large ? 52 : 30}" font-weight="700">UNRANKED</text>`;
	}

	const tier = ['MASTER', 'GRANDMASTER', 'CHALLENGER'].includes(rank.tier) ? rank.tier : `${rank.tier} ${rank.rank}`;
	const lp = `${rank.leaguePoints} LP`;
	return `${image ? `<image href="${image}" x="${x}" y="${y - 12}" width="${large ? 118 : 76}" height="${large ? 118 : 76}" preserveAspectRatio="xMidYMid meet"/>` : ''}
		<text x="${x + (large ? 142 : 96)}" y="${y + (large ? 36 : 20)}" fill="#f3f5f7" font-family="Helvetica Neue,Arial,sans-serif" font-size="${large ? 44 : 27}" font-weight="700">${escapeXml(tier)}</text>
		<text x="${x + (large ? 142 : 96)}" y="${y + (large ? 74 : 52)}" fill="#aeb6c2" font-family="Helvetica Neue,Arial,sans-serif" font-size="${large ? 22 : 17}">${lp}  ·  ${rank.wins}W ${rank.losses}L</text>`;
}

function buildMatchCard(match: RiotMatchSummary, icon: string | null, x: number): string {
	const result = match.participant.win ? 'VICTORIA' : 'DERROTA';
	const resultColor = match.participant.win ? '#7ecb9b' : '#dc8187';
	const queue = match.participant.isTft ? 'TFT' : queueLabel(match.queueId, match.gameMode);
	const date = new Date(match.gameStartTimestamp).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' });
	const stats = match.participant.isTft
		? `TOP ${match.participant.placement ?? '-'}`
		: `${match.participant.kills}/${match.participant.deaths}/${match.participant.assists}`;

	return `<rect x="${x}" y="646" width="240" height="150" rx="8" fill="#15181e" stroke="#292e36"/>
		${icon ? `<image href="${icon}" x="${x + 16}" y="664" width="54" height="54" preserveAspectRatio="xMidYMid slice"/>` : `<rect x="${x + 16}" y="664" width="54" height="54" fill="#272d36"/>`}
		<text x="${x + 84}" y="680" fill="${resultColor}" font-family="Helvetica Neue,Arial,sans-serif" font-size="13" font-weight="700" letter-spacing="1">${result}</text>
		<text x="${x + 84}" y="704" fill="#f3f5f7" font-family="Helvetica Neue,Arial,sans-serif" font-size="17" font-weight="700">${escapeXml(queue)}</text>
		<text x="${x + 16}" y="748" fill="#c6ccd5" font-family="monospace" font-size="16">${escapeXml(stats)}</text>
		<text x="${x + 16}" y="776" fill="#747d8a" font-family="Helvetica Neue,Arial,sans-serif" font-size="14">${date}</text>`;
}

function queueLabel(queueId: number, gameMode: string): string {
	const labels: Record<number, string> = {
		400: 'DRAFT 5V5',
		420: 'SOLOQ',
		430: 'BLIND 5V5',
		440: 'FLEX 5V5',
		450: 'ARAM',
		490: 'QUICKPLAY',
		700: 'CLASH',
		830: 'COOP VS AI',
		840: 'COOP VS AI',
		850: 'COOP VS AI',
		900: 'URF',
		1020: 'ONE FOR ALL',
		1300: 'NEXUS BLITZ',
		1400: 'ULTIMATE SPELLBOOK',
		1700: 'SWIFTPLAY'
	};
	return labels[queueId] ?? escapeXml(gameMode).toUpperCase();
}

function buildRankFallbackIcon(tier: string): string {
	const colors: Record<string, string> = {
		IRON: '#795548',
		BRONZE: '#A8754C',
		SILVER: '#A9B5C5',
		GOLD: '#E5B83B',
		PLATINUM: '#32B8A5',
		EMERALD: '#20A878',
		DIAMOND: '#55A8D8',
		MASTER: '#B78AE8',
		GRANDMASTER: '#E5A1C8',
		CHALLENGER: '#E34D4D'
	};
	const color = colors[tier] ?? '#8f98a6';
	const initials = tier.slice(0, 2);
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160">
		<path d="M80 10 143 43v74l-63 33-63-33V43z" fill="#101217" stroke="${color}" stroke-width="8"/>
		<path d="m80 28 42 23v50l-42 22-42-22V51z" fill="${color}" opacity=".22"/>
		<path d="m80 38 25 43-25 16-25-16z" fill="${color}"/>
		<text x="80" y="126" text-anchor="middle" fill="#f3f5f7" font-family="Arial,sans-serif" font-size="22" font-weight="700">${initials}</text>
	</svg>`;
	return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

function escapeXml(value: string): string {
	return value.replace(/[<>&'"]/g, (character) => {
		const entities: Record<string, string> = { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' };
		return entities[character] ?? character;
	});
}
