import sharp from 'sharp';
import { DATA_DRAGON_VERSION } from '../constants';

interface ProfileRank {
	tier: string;
	rank: string;
	leaguePoints: number;
	wins: number;
	losses: number;
}
interface ProfileParticipant {
	puuid: string;
	riotIdGameName: string | null;
	summonerName: string | null;
	championName: string;
	championId: number;
	teamId: number | null;
	win: boolean;
	kills: number;
	deaths: number;
	assists: number;
	item0: number | null;
	item1: number | null;
	item2: number | null;
	item3: number | null;
	item4: number | null;
	item5: number | null;
	item6: number | null;
}
interface ProfileMatch {
	matchId: string;
	playerPuuid: string;
	playerWin: boolean;
	queueId: number;
	queueLabel: string;
	gameMode: string;
	gameStartTimestamp: Date;
	gameDuration: number;
	participants: ProfileParticipant[];
}
interface ProfileMastery { championId: number; championPoints: number; championLevel: number }
interface ChampionStat { championId: number; championName: string; games: number; wins: number; masteryPoints: number }

export interface ProfileRenderData {
	displayName: string;
	gameName: string;
	tagLine: string;
	region: string;
	summonerLevel: number;
	profileIconId: number;
	solo?: ProfileRank;
	flex?: ProfileRank;
	tft?: ProfileRank;
	matches: ProfileMatch[];
	masteries: ProfileMastery[];
	championStats: ChampionStat[];
	badges: string[];
	positions: string[];
	streak: { type: 'WIN' | 'LOSS' | 'NONE'; count: number };
}

const imageCache = new Map<string, Promise<string | null>>();
const IMAGE_TIMEOUT_MS = 4_000;
const WIDTH = 1600;

export async function renderProfileImage(data: ProfileRenderData): Promise<Buffer> {
	const matches = data.matches.slice(0, 5);
	const urls = new Set<string>();
	urls.add(profileIconUrl(data.profileIconId));
	for (const match of matches) for (const participant of match.participants) {
		if (participant.championName) urls.add(championIconUrl(participant.championName));
		for (const item of [participant.item0, participant.item1, participant.item2, participant.item3, participant.item4, participant.item5, participant.item6]) {
			if (item && item > 0) urls.add(itemIconUrl(item));
		}
	}
	for (const stat of data.championStats.slice(0, 6)) urls.add(championIconUrl(stat.championName));
	const images = new Map<string, string | null>();
	await Promise.all([...urls].map(async (url) => images.set(url, await imageDataUri(url))));
	const svg = buildSvg(data, images);
	return sharp(Buffer.from(svg)).png().toBuffer();
}

function buildSvg(data: ProfileRenderData, images: Map<string, string | null>): string {
	const height = 760 + Math.max(1, Math.min(data.matches.length, 5)) * 290 + 260;
	const profileIcon = images.get(profileIconUrl(data.profileIconId));
	const badgeLabels = data.badges.map(badgeLabel);
	const positions = data.positions.map(positionLabel);
	const matchCards = data.matches.slice(0, 5).map((match, index) => buildMatchCard(match, images, 750 + index * 290)).join('');
	const championCards = data.championStats.slice(0, 6).map((champion, index) => {
		const x = 72 + index * 242;
		const icon = images.get(championIconUrl(champion.championName));
		const winrate = champion.games ? Math.round((champion.wins / champion.games) * 100) : 0;
		return `<rect x="${x}" y="${height - 205}" width="220" height="126" rx="10" fill="#151a22" stroke="#29313d"/>
			${icon ? `<image href="${icon}" x="${x + 14}" y="${height - 190}" width="54" height="54"/>` : ''}
			<text x="${x + 80}" y="${height - 166}" class="white" font-size="19" font-weight="700">${escapeXml(champion.championName)}</text>
			<text x="${x + 80}" y="${height - 140}" class="muted" font-size="14">${champion.games} partidas</text>
			<text x="${x + 14}" y="${height - 103}" class="white" font-size="17">${winrate}% WR</text>
			<text x="${x + 206}" y="${height - 103}" class="muted" font-size="14" text-anchor="end">${champion.wins}W ${champion.games - champion.wins}L</text>
			<text x="${x + 14}" y="${height - 88}" class="muted" font-size="12">${formatPoints(champion.masteryPoints)} mastery pts</text>`;
	}).join('');
	const badgesSvg = badgeLabels.length ? badgeLabels.slice(0, 6).map((badge, i) => pill(72 + (i % 3) * 195, 310 + Math.floor(i / 3) * 42, badge, '#202b38', '#b8c9dc')).join('') : pill(72, 310, 'Sin distinciones todavía', '#1b2028', '#778392');
	const positionsSvg = positions.length ? positions.map((position, i) => pill(1000 + (i % 2) * 190, 175 + Math.floor(i / 2) * 42, position, '#202b38', '#b8c9dc')).join('') : pill(1000, 175, 'Posición en análisis', '#1b2028', '#778392');
	const streakText = data.streak.type === 'NONE' ? 'SIN PARTIDAS' : `${data.streak.count} ${data.streak.type === 'WIN' ? 'VICTORIAS' : 'DERROTAS'} SEGUIDAS`;
	const streakColor = data.streak.type === 'WIN' ? '#75d6a0' : data.streak.type === 'LOSS' ? '#e17d86' : '#8793a3';

	return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}">
		<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0b1018"/><stop offset="1" stop-color="#111722"/></linearGradient><linearGradient id="banner" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#182535"/><stop offset="1" stop-color="#121820"/></linearGradient><style>
			.white{fill:#f2f5f8;font-family:Arial,sans-serif}.muted{fill:#8e9aaa;font-family:Arial,sans-serif}.tiny{fill:#748092;font-family:Arial,sans-serif;letter-spacing:1.5px}.mono{font-family:monospace}
		</style></defs>
		<rect width="${WIDTH}" height="${height}" fill="url(#bg)"/><rect x="32" y="32" width="1536" height="${height - 64}" rx="18" fill="#10151d" stroke="#283241"/>
		<rect x="54" y="54" width="1492" height="238" rx="14" fill="url(#banner)" stroke="#2d3c4d"/>
		${profileIcon ? `<image href="${profileIcon}" x="84" y="94" width="150" height="150" preserveAspectRatio="xMidYMid slice"/>` : '<rect x="84" y="94" width="150" height="150" rx="10" fill="#252f3c"/>'}
		<rect x="84" y="94" width="150" height="150" rx="10" fill="none" stroke="#70849a" stroke-width="2"/>
		<text x="270" y="124" class="tiny" font-size="15">CAPYGG PLAYER CARD · ${escapeXml(data.region)}</text>
		<text x="270" y="178" class="white" font-size="46" font-weight="700">${escapeXml(data.displayName)}</text>
		<text x="270" y="215" class="muted" font-size="22">${escapeXml(data.gameName)}#${escapeXml(data.tagLine)}</text>
		<text x="270" y="254" class="muted" font-size="17">SUMMONER LEVEL <tspan class="white" font-weight="700">${data.summonerLevel}</tspan></text>
		<line x1="930" y1="82" x2="930" y2="265" stroke="#344252"/>
		<text x="1000" y="124" class="tiny" font-size="15">POSICIONES</text>${positionsSvg}
		<text x="72" y="350" class="tiny" font-size="15">DISTINCIONES</text>${badgesSvg}
		<text x="1000" y="350" class="tiny" font-size="15">RACHA ACTUAL</text><text x="1000" y="386" fill="${streakColor}" font-family="Arial,sans-serif" font-size="23" font-weight="700">${streakText}</text>
		<line x1="72" y1="420" x2="1528" y2="420" stroke="#29313d"/>
		<text x="72" y="462" class="tiny" font-size="15">RANKED</text>
		${rankCard('SOLO / DUO', data.solo, 72, 486)}${rankCard('FLEX', data.flex, 550, 486)}${rankCard('TFT', data.tft, 1028, 486)}
		<text x="72" y="710" class="tiny" font-size="15">HISTORIAL · TODOS LOS 10 JUGADORES Y SUS BUILDS</text>
		${matchCards || '<text x="72" y="770" class="muted" font-size="20">Todavía no hay partidas sincronizadas.</text>'}
		<text x="72" y="${height - 232}" class="tiny" font-size="15">CHAMPION POOL · ÚLTIMAS 100 PARTIDAS DE SUMMONER’S RIFT</text>
		${championCards || `<text x="72" y="${height - 170}" class="muted" font-size="18">Todavía no hay suficientes datos de campeones.</text>`}
		<text x="72" y="${height - 58}" class="muted mono" font-size="13">CAPYGG · RIOT GAMES DATA · PERFIL ACTUALIZADO EN SEGUNDO PLANO</text>
	</svg>`;
}

function rankCard(label: string, rank: ProfileRank | undefined, x: number, y: number): string {
	const name = rank ? `${rank.tier}${['MASTER', 'GRANDMASTER', 'CHALLENGER'].includes(rank.tier) ? '' : ` ${rank.rank}`}` : 'UNRANKED';
	const record = rank ? `${rank.leaguePoints} LP · ${rank.wins}W ${rank.losses}L` : 'Sin datos de rango';
	return `<rect x="${x}" y="${y}" width="450" height="174" rx="12" fill="#151b24" stroke="#2a3543"/>
		<text x="${x + 24}" y="${y + 34}" class="tiny" font-size="13">${label}</text>
		<text x="${x + 24}" y="${y + 92}" class="white" font-size="32" font-weight="700">${escapeXml(name)}</text>
		<text x="${x + 24}" y="${y + 132}" class="muted" font-size="18">${escapeXml(record)}</text>`;
}

function buildMatchCard(match: ProfileMatch, images: Map<string, string | null>, y: number): string {
	const participants = [...match.participants].sort((a, b) => (a.teamId ?? 0) - (b.teamId ?? 0));
	const left = participants.slice(0, 5);
	const right = participants.slice(5, 10);
	const won = match.playerWin;
	const date = new Date(match.gameStartTimestamp).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit' });
	return `<rect x="72" y="${y}" width="1456" height="270" rx="12" fill="#141a23" stroke="#2a3543"/>
		<text x="96" y="${y + 30}" fill="${won ? '#76d5a0' : '#e17e87'}" font-family="Arial,sans-serif" font-size="15" font-weight="700">${won ? 'VICTORIA' : 'DERROTA'}</text>
		<text x="240" y="${y + 30}" class="white" font-size="16" font-weight="700">${escapeXml(match.queueLabel)}</text>
		<text x="1510" y="${y + 30}" class="muted" font-size="14" text-anchor="end">${date} · ${Math.floor(match.gameDuration / 60)} min</text>
		<line x1="800" y1="${y + 46}" x2="800" y2="${y + 254}" stroke="#2b3542"/>
		${left.map((participant, index) => participantRow(participant, images, 96, y + 52 + index * 39, participant.puuid === match.playerPuuid)).join('')}
		${right.map((participant, index) => participantRow(participant, images, 824, y + 52 + index * 39, participant.puuid === match.playerPuuid)).join('')}`;
}

function participantRow(participant: ProfileParticipant, images: Map<string, string | null>, x: number, y: number, isProfilePlayer: boolean): string {
	const icon = images.get(championIconUrl(participant.championName));
	const name = participant.riotIdGameName || participant.summonerName || 'Jugador';
	const items = [participant.item0, participant.item1, participant.item2, participant.item3, participant.item4, participant.item5, participant.item6]
		.filter((item): item is number => Boolean(item && item > 0));
	const itemIcons = items.map((item, index) => {
		const image = images.get(itemIconUrl(item));
		const itemX = x + 420 + index * 30;
		return image ? `<image href="${image}" x="${itemX}" y="${y + 1}" width="25" height="25"/>` : `<rect x="${itemX}" y="${y + 1}" width="25" height="25" rx="4" fill="#303b49"/>`;
	}).join('');
	return `${isProfilePlayer ? `<rect x="${x - 6}" y="${y - 2}" width="690" height="31" rx="5" fill="#253a35"/>` : ''}${icon ? `<image href="${icon}" x="${x}" y="${y}" width="28" height="28"/>` : `<rect x="${x}" y="${y}" width="28" height="28" fill="#293443"/>`}
		<text x="${x + 38}" y="${y + 19}" class="white" font-size="14">${escapeXml(truncate(name, 17))}</text>
		<text x="${x + 260}" y="${y + 19}" class="muted mono" font-size="13">${participant.kills}/${participant.deaths}/${participant.assists}</text>
		${itemIcons}`;
}

function pill(x: number, y: number, label: string, background: string, foreground: string): string {
	const width = Math.max(120, Math.min(184, label.length * 8 + 28));
	return `<rect x="${x}" y="${y}" width="${width}" height="30" rx="15" fill="${background}" stroke="#354354"/><text x="${x + width / 2}" y="${y + 20}" fill="${foreground}" font-family="Arial,sans-serif" font-size="13" text-anchor="middle">${escapeXml(label)}</text>`;
}

function badgeLabel(key: string): string {
	const labels: Record<string, string> = { MAIN: 'MAIN', ARAM_PLAYER: 'ARAM PLAYER', ARAM_MAYHEM_ENJOYER: 'MAYHEM ENJOYER', SOLOQ_ABUSER: 'SOLOQ ABUSER', OTP: 'OTP' };
	return labels[key] ?? key.replaceAll('_', ' ');
}
function positionLabel(key: string): string {
	const labels: Record<string, string> = { TOP: 'TOP', JUNGLE: 'JUNGLE', MID: 'MID', ADC: 'ADC', SUPPORT: 'SUPPORT' };
	return labels[key.toUpperCase()] ?? key.toUpperCase();
}
function championIconUrl(name: string): string { return `https://ddragon.leagueoflegends.com/cdn/${DATA_DRAGON_VERSION}/img/champion/${encodeURIComponent(name)}.png`; }
function itemIconUrl(id: number): string { return `https://ddragon.leagueoflegends.com/cdn/${DATA_DRAGON_VERSION}/img/item/${id}.png`; }
function profileIconUrl(id: number): string { return `https://ddragon.leagueoflegends.com/cdn/${DATA_DRAGON_VERSION}/img/profileicon/${id}.png`; }
function formatPoints(value: number): string { return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : value >= 1_000 ? `${(value / 1_000).toFixed(0)}K` : String(value); }
function truncate(value: string, max: number): string { return value.length > max ? `${value.slice(0, max - 1)}…` : value; }
function escapeXml(value: string): string { return value.replace(/[<>&'"]/g, (character) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[character] ?? character); }

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
			return `data:${contentType};base64,${Buffer.from(await response.arrayBuffer()).toString('base64')}`;
		} finally { clearTimeout(timeout); }
	})().catch(() => null);
	imageCache.set(url, request);
	return request;
}
