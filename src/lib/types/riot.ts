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

export interface RiotMatchParticipant {
	puuid: string;
	championName: string;
	win: boolean;
	kills: number;
	deaths: number;
	assists: number;
	placement?: number;
	isTft?: boolean;
}

export interface RiotMatchSummary {
	matchId: string;
	queueId: number;
	gameMode: string;
	gameStartTimestamp: number;
	gameDuration: number;
	participant: RiotMatchParticipant;
}
