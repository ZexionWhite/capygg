/** Cálculos puros del perfil (sin base de datos ni Discord), pensados para poder probarse solos. */

export const SR_QUEUE_IDS = [400, 420, 430, 440, 480, 490, 700];
export const REMAKE_MAX_SECONDS = 300;

/** Misma regla que usa la automatización para dar el rol OTP. */
export const OTP_RULE = { minMasteryPoints: 1_000_000, minGames: 100, minShare: 0.7 } as const;

export const LANE_ORDER = ['TOP', 'JUNGLE', 'MID', 'ADC', 'SUPPORT'] as const;
export type LaneKey = (typeof LANE_ORDER)[number];

export type PositionKey = LaneKey | 'FILL';
export interface ProfilePosition {
	key: PositionKey;
	/** Fracción de partidas en esa posición (0..1). */
	share?: number;
}

/** Riot devuelve TOP, JUNGLE, MIDDLE, BOTTOM y UTILITY. */
export function normalizeLane(position: string | null | undefined): LaneKey | null {
	const value = (position ?? '').toUpperCase();
	if (value === 'MIDDLE') return 'MID';
	if (value === 'BOTTOM') return 'ADC';
	if (value === 'UTILITY') return 'SUPPORT';
	return (LANE_ORDER as readonly string[]).includes(value) ? (value as LaneKey) : null;
}

export function pickPositions(
	rows: ReadonlyArray<{ teamPosition: string | null; individualPosition: string | null }>,
	fallbackLane: string | null
): ProfilePosition[] {
	const counts = new Map<LaneKey, number>();
	let total = 0;

	for (const row of rows) {
		const lane = normalizeLane(row.teamPosition) ?? normalizeLane(row.individualPosition);
		if (!lane) continue;
		counts.set(lane, (counts.get(lane) ?? 0) + 1);
		total++;
	}

	if (total < 10) {
		const lane = normalizeLane(fallbackLane);
		return lane ? [{ key: lane }] : [];
	}

	const strong = [...counts.entries()]
		.map(([key, games]) => ({ key, share: games / total }))
		.filter((entry) => entry.share >= 0.2)
		.sort((a, b) => b.share - a.share)
		.slice(0, 3);

	// Si ninguna línea domina (la principal está por debajo del 30%), el jugador es Fill.
	return strong.length && strong[0]!.share >= 0.3 ? strong : [{ key: 'FILL' }];
}

export interface ChampionGames {
	championId: number;
	championName: string;
	games: number;
	wins: number;
}

export function aggregateChampions(rows: ReadonlyArray<{ championId: number; championName: string; win: boolean }>): ChampionGames[] {
	const byChampion = new Map<number, ChampionGames>();

	for (const row of rows) {
		const current = byChampion.get(row.championId) ?? { championId: row.championId, championName: row.championName, games: 0, wins: 0 };
		current.games++;
		if (row.win) current.wins++;
		byChampion.set(row.championId, current);
	}

	return [...byChampion.values()].sort((a, b) => b.games - a.games || b.wins - a.wins);
}

export function detectOtp(
	champions: readonly ChampionGames[],
	totalGames: number,
	masteries: ReadonlyArray<{ championId: number; championPoints: number }>
): ChampionGames | null {
	const top = champions[0];
	if (!top || totalGames < OTP_RULE.minGames) return null;
	if (top.games / totalGames < OTP_RULE.minShare) return null;

	const mastery = masteries.find((entry) => entry.championId === top.championId);
	return mastery && mastery.championPoints > OTP_RULE.minMasteryPoints ? top : null;
}

/** El campeón más jugado, si tiene una muestra mínima. */
export function detectMain(champions: readonly ChampionGames[]): ChampionGames | null {
	const top = champions[0];
	return top && top.games >= 10 ? top : null;
}

export type StreakType = 'WIN' | 'LOSS' | 'NONE';

/** `results` va de la partida más nueva a la más vieja. */
export function calculateStreak(results: readonly boolean[]): { type: StreakType; count: number } {
	const first = results[0];
	if (first === undefined) return { type: 'NONE', count: 0 };

	let count = 0;
	for (const result of results) {
		if (result !== first) break;
		count++;
	}

	return { type: first ? 'WIN' : 'LOSS', count };
}

export function recentRecord(results: readonly boolean[], window = 10): { wins: number; losses: number } {
	const slice = results.slice(0, window);
	const wins = slice.filter(Boolean).length;
	return { wins, losses: slice.length - wins };
}

export interface MatchPlayer {
	puuid: string;
	teamId: number | null;
	teamPosition: string | null;
	championName: string;
	win: boolean;
	kills: number;
	deaths: number;
	assists: number;
	totalDamageDealtToChampions: number | null;
	visionScore: number | null;
}

/** MVP si el jugador tuvo el mejor desempeño de los 10 y ganó, ACE si lo tuvo y perdió. */
export function performanceTag(participants: readonly MatchPlayer[], selfPuuid: string): 'MVP' | 'ACE' | null {
	if (participants.length !== 10) return null;
	if (participants.some((player) => player.totalDamageDealtToChampions === null)) return null;

	const score = (player: MatchPlayer) =>
		((player.kills + player.assists * 0.7) / Math.max(1, player.deaths)) * 10 + (player.totalDamageDealtToChampions ?? 0) / 1_000 + (player.visionScore ?? 0) * 0.1;

	const best = participants.reduce((top, player) => (score(player) > score(top) ? player : top));
	if (best.puuid !== selfPuuid) return null;

	return best.win ? 'MVP' : 'ACE';
}

/** Participación en kills del equipo, de 0 a 1. */
export function killParticipation(participants: readonly MatchPlayer[], selfPuuid: string): number | null {
	const self = participants.find((player) => player.puuid === selfPuuid);
	if (!self || self.teamId === null) return null;

	const teamKills = participants.filter((player) => player.teamId === self.teamId).reduce((total, player) => total + player.kills, 0);
	if (teamKills <= 0) return null;

	return Math.min(1, (self.kills + self.assists) / teamKills);
}

export interface TeamSplit<T> {
	ally: T[];
	enemy: T[];
}

/** Separa aliados y enemigos y los ordena por línea. Devuelve `null` si no es un 5v5 normal (ej. Arena). */
export function splitTeams<T extends MatchPlayer>(participants: readonly T[], selfPuuid: string): TeamSplit<T> | null {
	const self = participants.find((player) => player.puuid === selfPuuid);
	if (!self || self.teamId === null || participants.length > 10) return null;

	const byLane = (a: T, b: T) => laneRank(a.teamPosition) - laneRank(b.teamPosition);
	const ally = participants.filter((player) => player.teamId === self.teamId).sort(byLane);
	const enemy = participants.filter((player) => player.teamId !== self.teamId).sort(byLane);

	return ally.length && enemy.length ? { ally, enemy } : null;
}

function laneRank(position: string | null): number {
	const lane = normalizeLane(position);
	return lane ? LANE_ORDER.indexOf(lane) : LANE_ORDER.length;
}

export function formatClock(totalSeconds: number): string {
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = Math.floor(totalSeconds % 60);
	return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function formatRelativeTime(date: Date, now: Date = new Date()): string {
	const seconds = Math.max(0, Math.floor((now.getTime() - date.getTime()) / 1_000));
	if (seconds < 60) return 'Hace instantes';

	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `Hace ${minutes} min`;

	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `Hace ${hours}h`;

	const days = Math.floor(hours / 24);
	if (days < 30) return `Hace ${days}d`;

	return date.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

export const DISTINCTION_LABELS: Readonly<Record<string, string>> = {
	OTP: 'OTP',
	ARAM_PLAYER: 'ARAM Player',
	ARAM_MAYHEM_ENJOYER: 'Mayhem Enjoyer',
	SOLOQ_ABUSER: 'SoloQ Abuser'
};

const DISTINCTION_PRIORITY = ['OTP', 'ARAM_PLAYER', 'ARAM_MAYHEM_ENJOYER', 'SOLOQ_ABUSER'];

export interface ProfileDistinction {
	key: string;
	label: string;
}

/** Ordena las distinciones por prioridad y deja las `max` primeras (el espacio del perfil es limitado). */
export function pickDistinctions(activeKeys: readonly string[], max = 3): ProfileDistinction[] {
	const unique = [...new Set(activeKeys)];
	const rank = (key: string) => {
		const index = DISTINCTION_PRIORITY.indexOf(key);
		return index === -1 ? DISTINCTION_PRIORITY.length : index;
	};

	return unique
		.sort((a, b) => rank(a) - rank(b))
		.slice(0, max)
		.map((key) => ({ key, label: DISTINCTION_LABELS[key] ?? key.replaceAll('_', ' ').toLowerCase().replace(/(^|\s)\S/g, (char) => char.toUpperCase()) }));
}

/**
 * Los nombres de Discord suelen traer emojis, que las fuentes incluidas no dibujan. Se quitan y, si no queda nada, se usa `fallback`.
 */
export function cleanDisplayName(name: string, fallback: string): string {
	const cleaned = name
		.replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\u200d\ufe0f]/gu, '')
		.replace(/\s+/g, ' ')
		.trim();
	return cleaned || fallback;
}
