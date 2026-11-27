/**
 * Cálculo del "Poder" de un jugador con un campeón. Son funciones puras (sin base de datos ni Discord)
 * para poder probarlas solas. La fórmula no se muestra en la imagen: se ajusta tocando las constantes.
 */

/** Solo/Duo y Flex. Los demás modos no cuentan para el ranking. */
export const RANKED_QUEUE_IDS = [420, 440] as const;

/** Cuánto vale una partida según la cola: una Solo/Duo vale el doble que una Flex. */
const QUEUE_WEIGHT: Record<number, number> = { 420: 1, 440: 0.5 };

/** Actividad mínima para aparecer: partidas rankeds con ese campeón en los últimos N días. */
export const MIN_RECENT_GAMES = 10;
export const RECENT_WINDOW_DAYS = 30;

/** Con pocas partidas el puntaje se acerca al promedio neutro. Es "cuántas partidas valen como 50% de confianza". */
const CONFIDENCE_GAMES = 30;
const NEUTRAL_GAME_SCORE = 0.5;

/** Peso de cada parte del puntaje final (suman 1). */
export const POWER_WEIGHTS = { performance: 0.6, elo: 0.25, mastery: 0.15 } as const;

/** Elo que se asume cuando todavía no tenemos el rango guardado de la cuenta. */
const UNKNOWN_ELO_NORM = 0.3;

export function queueWeight(queueId: number): number {
	return QUEUE_WEIGHT[queueId] ?? 0;
}

/* -------------------------------------------------------------------------- */
/*  Impacto de una partida                                                     */
/* -------------------------------------------------------------------------- */

/** Lo que se necesita de cada jugador de una partida. Los campos vacíos se ignoran. */
export interface GameSide {
	puuid: string;
	teamId: number | null;
	teamPosition: string | null;
	kills: number;
	deaths: number;
	assists: number;
	damage: number | null;
	gold: number | null;
	cs: number | null;
	vision: number | null;
}

type MetricKey = 'kda' | 'damage' | 'gold' | 'cs' | 'vision';

const DEFAULT_WEIGHTS: Record<MetricKey, number> = { kda: 0.3, damage: 0.25, gold: 0.2, cs: 0.15, vision: 0.1 };
const SUPPORT_WEIGHTS: Record<MetricKey, number> = { kda: 0.35, damage: 0.1, gold: 0.1, cs: 0, vision: 0.45 };

function metrics(side: GameSide): Record<MetricKey, number | null> {
	return {
		kda: (side.kills + side.assists) / Math.max(1, side.deaths),
		damage: side.damage,
		gold: side.gold,
		cs: side.cs,
		vision: side.vision
	};
}

/**
 * Qué tan bien jugó `me` comparado con su rival directo (mismo rol del otro equipo; si no se sabe, el promedio del equipo enemigo).
 * Devuelve un valor entre 0 y 1 (0,5 = parejo) o `null` si no hay forma de comparar.
 */
export function gameImpact(me: GameSide, lobby: readonly GameSide[]): number | null {
	if (me.teamId === null) return null;

	const enemies = lobby.filter((player) => player.teamId !== null && player.teamId !== me.teamId);
	if (enemies.length === 0) return null;

	const lane = me.teamPosition ? enemies.find((enemy) => enemy.teamPosition === me.teamPosition) : undefined;
	const mine = metrics(me);
	const weights = me.teamPosition === 'UTILITY' ? SUPPORT_WEIGHTS : DEFAULT_WEIGHTS;

	let total = 0;
	let used = 0;

	for (const key of Object.keys(weights) as MetricKey[]) {
		const weight = weights[key];
		const mineValue = mine[key];
		if (weight === 0 || mineValue === null) continue;

		let otherValue: number | null;
		if (lane) {
			otherValue = metrics(lane)[key];
		} else {
			const values = enemies.map((enemy) => metrics(enemy)[key]).filter((value): value is number => value !== null);
			otherValue = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
		}
		if (otherValue === null) continue;

		const sum = mineValue + otherValue;
		total += weight * (sum > 0 ? (mineValue - otherValue) / sum : 0);
		used += weight;
	}

	if (used === 0) return null;
	// Diferencia relativa (-1..1) -> 0..1, con una curva suave para que un día excepcional no se salga de escala.
	return 0.5 + 0.5 * Math.tanh(2 * (total / used));
}

/** Puntaje de una partida (0..1): mitad resultado, mitad impacto. Sin datos de impacto cuenta como parejo. */
export function gameScore(win: boolean, impact: number | null): number {
	return 0.45 * (win ? 1 : 0) + 0.55 * (impact ?? NEUTRAL_GAME_SCORE);
}

/* -------------------------------------------------------------------------- */
/*  Agregado y puntaje final                                                   */
/* -------------------------------------------------------------------------- */

export interface WeightedGame {
	weight: number;
	score: number;
}

/** Promedio ponderado de las partidas, corregido por confianza (pocas partidas => más cerca de lo neutro). */
export function adjustedPerformance(games: readonly WeightedGame[]): { value: number; weightedGames: number } {
	let weightedGames = 0;
	let weightedScore = 0;
	for (const game of games) {
		weightedGames += game.weight;
		weightedScore += game.weight * game.score;
	}

	const value = (weightedScore + CONFIDENCE_GAMES * NEUTRAL_GAME_SCORE) / (weightedGames + CONFIDENCE_GAMES);
	return { value, weightedGames };
}

const TIER_BASE: Record<string, number> = {
	IRON: 0,
	BRONZE: 400,
	SILVER: 800,
	GOLD: 1200,
	PLATINUM: 1600,
	EMERALD: 2000,
	DIAMOND: 2400,
	MASTER: 2800,
	GRANDMASTER: 2800,
	CHALLENGER: 2800
};
const DIVISION_BASE: Record<string, number> = { IV: 0, III: 100, II: 200, I: 300 };
const APEX_TIERS = new Set(['MASTER', 'GRANDMASTER', 'CHALLENGER']);
const ELO_SCALE = 3300;

/** Elo normalizado (0..1). Un Challenger con muchos LP llega a 1. */
export function eloNorm(tier: string | null | undefined, division: string | null | undefined, lp: number | null | undefined): number {
	const key = (tier ?? '').toUpperCase();
	const base = TIER_BASE[key];
	if (base === undefined) return UNKNOWN_ELO_NORM;

	const divisionPoints = APEX_TIERS.has(key) ? 0 : (DIVISION_BASE[(division ?? '').toUpperCase()] ?? 0);
	return clamp01((base + divisionPoints + Math.max(0, lp ?? 0)) / ELO_SCALE);
}

/** Maestría normalizada (0..1) en escala logarítmica: 1M de puntos o más es el tope. */
export function masteryNorm(points: number | null | undefined): number {
	const value = Math.max(0, points ?? 0);
	return clamp01(Math.log(1 + value / 50_000) / Math.log(1 + 1_000_000 / 50_000));
}

export interface PowerBreakdown {
	/** 0..100 */
	total: number;
	performance: number;
	elo: number;
	mastery: number;
}

export function powerScore(input: { performance: number; elo: number; mastery: number }): PowerBreakdown {
	// El promedio de partidas rara vez pasa de 0,70: se estira 0,40..0,70 a 0..1.
	const performance = clamp01((input.performance - 0.4) / 0.3);
	const total = 100 * (POWER_WEIGHTS.performance * performance + POWER_WEIGHTS.elo * input.elo + POWER_WEIGHTS.mastery * input.mastery);
	return { total, performance, elo: input.elo, mastery: input.mastery };
}

function clamp01(value: number): number {
	return Math.min(1, Math.max(0, value));
}