import { join } from 'path';

export const rootDir = join(__dirname, '..', '..');
export const srcDir = join(rootDir, 'src');

export const ELO_TIERS = {
	IRON: { color: '#795548' },
	BRONZE: { color: '#A8754C' },
	SILVER: { color: '#A9B5C5' },
	GOLD: { color: '#E5B83B' },
	PLATINUM: { color: '#32B8A5' },
	EMERALD: { color: '#20A878' },
	DIAMOND: { color: '#55A8D8' },
	MASTER: { color: '#B78AE8' },
	GRANDMASTER: { color: '#E5A1C8' },
	CHALLENGER: { color: '#E34D4D' }
} as const;

export const REGIONS = {
	LAS: { platform: 'la2', regionalRoute: 'americas' },
	LAN: { platform: 'la1', regionalRoute: 'americas' },
	BR: { platform: 'br1', regionalRoute: 'americas' },
	NA: { platform: 'na1', regionalRoute: 'americas' },
	EUW: { platform: 'euw1', regionalRoute: 'europe' },
	EUNE: { platform: 'eun1', regionalRoute: 'europe' },
	KR: { platform: 'kr', regionalRoute: 'asia' },
	JP: { platform: 'jp1', regionalRoute: 'asia' },
	OCE: { platform: 'oc1', regionalRoute: 'sea' },
	TR: { platform: 'tr1', regionalRoute: 'europe' }
} as const;

export const QUEUES = {
	SOLO: 'RANKED_SOLO_5x5',
	FLEX: 'RANKED_FLEX_SR'
} as const;

export const INTERACTION_IDS = {
	verifyStart: 'verify:start',
	verifyReport: 'verify:report',
	verifyAccountModal: 'verify:account',
	verifyReportModal: 'verify:report-modal',
	verifyCheckPrefix: 'verify:check:',
	verifyCancelPrefix: 'verify:cancel:'
} as const;

export const FORM_FIELD_IDS = {
	riotId: 'riot_id',
	region: 'region',
	category: 'category',
	description: 'description',
	reference: 'reference'
} as const;

export const PROFILE_ICON_CANDIDATES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19] as const;

export const DATA_DRAGON_VERSION = '16.22.1';
