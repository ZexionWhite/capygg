/** Human-readable names for Riot's League of Legends queue IDs. */
const QUEUE_LABELS: Readonly<Record<number, string>> = {
	0: 'Custom',
	400: 'Normal Draft',
	420: 'Ranked Solo/Duo',
	430: 'Normal Blind',
	440: 'Ranked Flex',
	450: 'ARAM',
	480: 'Swiftplay',
	490: 'Quickplay',
	700: 'Clash',
	720: 'ARAM Clash',
	830: 'Co-op vs AI (Intro)',
	840: 'Co-op vs AI (Beginner)',
	850: 'Co-op vs AI (Intermediate)',
	900: 'URF',
	1020: 'One for All',
	1300: 'Nexus Blitz',
	1400: 'Ultimate Spellbook',
	1700: 'Arena',
	1900: 'Pick URF',
	2400: 'ARAM Mayhem'
};

export function getQueueLabel(queueId: number): string {
	return QUEUE_LABELS[queueId] ?? `Queue ${queueId}`;
}
