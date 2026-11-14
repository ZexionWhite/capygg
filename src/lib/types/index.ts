import { ELO_TIERS, QUEUES, REGIONS } from '../constants';

export type EloTier = keyof typeof ELO_TIERS;
export type Region = keyof typeof REGIONS;
export type QueueType = keyof typeof QUEUES;

export function isRegion(value: string): value is Region {
	return Object.hasOwn(REGIONS, value);
}

export function isEloTier(value: string): value is EloTier {
	return Object.hasOwn(ELO_TIERS, value);
}
