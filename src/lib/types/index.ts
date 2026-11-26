import { ELO_TIERS, QUEUES, REGIONS } from '../constants.js';

export type EloTier = keyof typeof ELO_TIERS;
export type Region = keyof typeof REGIONS;
export type QueueType = keyof typeof QUEUES;

export function isRegion(value: string): value is Region {
	return Object.hasOwn(REGIONS, value);
}

export function isEloTier(value: string): value is EloTier {
    return Object.keys(ELO_TIERS).some(
        tier => tier.toUpperCase() === value.toUpperCase()
    );
}

export function normalizeEloTier(value: string): EloTier | null {
    const tier = Object.keys(ELO_TIERS).find(
        key => key.toUpperCase() === value.toUpperCase()
    );

    return tier as EloTier | undefined ?? null;
}