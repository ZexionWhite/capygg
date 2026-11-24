export type RiotApiErrorKind = 'NOT_FOUND' | 'RATE_LIMITED' | 'KEY_INVALID_OR_EXPIRED' | 'INVALID_PUUID' | 'UNAVAILABLE' | 'UNKNOWN';

export interface RiotAccountResponse {
	puuid: string;
	gameName: string;
	tagLine: string;
}

export interface RiotSummonerResponse {
	puuid: string;
	profileIconId: number;
	summonerLevel: number;
}

export interface RiotLeagueEntry {
	queueType: string;
	tier: string;
	rank: string;
	leaguePoints: number;
	wins: number;
	losses: number;
}

export interface RiotChampionMastery {
	puuid: string;
	championId: number;
	championLevel: number;
	championPoints: number;
	lastPlayTime: number;
	championPointsSinceLastLevel: number;
	championPointsUntilNextLevel: number;
	tokensEarned: number;
	chestGranted?: boolean | null;
}

export interface RiotMatchParticipant {
	puuid: string;
	championName: string;
	championId?: number;
	teamId?: number;
	teamPosition?: string;
	individualPosition?: string;
	summonerName?: string;
	riotIdGameName?: string;
	riotIdTagline?: string;
	champLevel?: number;
	totalDamageDealtToChampions?: number;
	visionScore?: number;
	item0?: number;
	item1?: number;
	item2?: number;
	item3?: number;
	item4?: number;
	item5?: number;
	item6?: number;
	win: boolean;
	kills: number;
	deaths: number;
	assists: number;
	placement?: number;
	summoner1Id?: number;
	summoner2Id?: number;
	totalMinionsKilled?: number;
	neutralMinionsKilled?: number;
	goldEarned?: number;
	totalDamageTaken?: number;
	totalHeal?: number;
	wardsPlaced?: number;
	wardsKilled?: number;
	baronKills?: number;
	dragonKills?: number;
	perks?: unknown;
	isTft?: boolean;
}

export interface RiotMatchDetails {
	matchId: string;
	queueId: number;
	gameMode: string;
	gameType?: string;
	mapId?: number;
	gameStartTimestamp: number;
	gameDuration: number;
	gameVersion?: string;
	participants: RiotMatchParticipant[];
}

export interface RiotMatchSummary {
	matchId: string;
	queueId: number;
	gameMode: string;
	gameStartTimestamp: number;
	gameDuration: number;
	participant: RiotMatchParticipant;
}
