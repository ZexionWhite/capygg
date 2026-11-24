-- Persist champion mastery and League of Legends match history.
ALTER TABLE "RiotAccount" ADD COLUMN "masterySyncedAt" DATETIME;
ALTER TABLE "RiotAccount" ADD COLUMN "matchesSyncedAt" DATETIME;
ALTER TABLE "RiotAccount" ADD COLUMN "matchHistoryBackfilledAt" DATETIME;

CREATE TABLE "ChampionMastery" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "puuid" TEXT NOT NULL,
    "championId" INTEGER NOT NULL,
    "championLevel" INTEGER NOT NULL,
    "championPoints" INTEGER NOT NULL,
    "lastPlayTime" DATETIME,
    "championPointsSinceLevel" INTEGER NOT NULL,
    "championPointsUntilNextLevel" INTEGER NOT NULL,
    "tokensEarned" INTEGER NOT NULL,
    "chestGranted" BOOLEAN NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ChampionMastery_puuid_fkey" FOREIGN KEY ("puuid") REFERENCES "RiotAccount" ("puuid") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ChampionMastery_puuid_championId_key" ON "ChampionMastery"("puuid", "championId");
CREATE INDEX "ChampionMastery_puuid_championPoints_idx" ON "ChampionMastery"("puuid", "championPoints");
CREATE INDEX "ChampionMastery_championId_championPoints_idx" ON "ChampionMastery"("championId", "championPoints");

CREATE TABLE "MatchRecord" (
    "matchId" TEXT NOT NULL PRIMARY KEY,
    "region" TEXT NOT NULL,
    "queueId" INTEGER NOT NULL,
    "queueLabel" TEXT NOT NULL,
    "gameMode" TEXT NOT NULL,
    "gameType" TEXT,
    "mapId" INTEGER,
    "gameStartTimestamp" DATETIME NOT NULL,
    "gameDuration" INTEGER NOT NULL,
    "gameVersion" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE INDEX "MatchRecord_gameStartTimestamp_idx" ON "MatchRecord"("gameStartTimestamp");
CREATE INDEX "MatchRecord_queueId_gameStartTimestamp_idx" ON "MatchRecord"("queueId", "gameStartTimestamp");

CREATE TABLE "MatchParticipant" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "matchId" TEXT NOT NULL,
    "puuid" TEXT NOT NULL,
    "summonerName" TEXT,
    "riotIdGameName" TEXT,
    "riotIdTagLine" TEXT,
    "championId" INTEGER NOT NULL,
    "championName" TEXT NOT NULL,
    "teamId" INTEGER,
    "teamPosition" TEXT,
    "individualPosition" TEXT,
    "win" BOOLEAN NOT NULL,
    "kills" INTEGER NOT NULL,
    "deaths" INTEGER NOT NULL,
    "assists" INTEGER NOT NULL,
    "champLevel" INTEGER,
    "totalDamageDealtToChampions" INTEGER,
    "visionScore" INTEGER,
    "item0" INTEGER,
    "item1" INTEGER,
    "item2" INTEGER,
    "item3" INTEGER,
    "item4" INTEGER,
    "item5" INTEGER,
    "item6" INTEGER,
    "placement" INTEGER,
    CONSTRAINT "MatchParticipant_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "MatchRecord" ("matchId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "MatchParticipant_matchId_puuid_key" ON "MatchParticipant"("matchId", "puuid");
CREATE INDEX "MatchParticipant_puuid_matchId_idx" ON "MatchParticipant"("puuid", "matchId");
CREATE INDEX "MatchParticipant_puuid_championId_idx" ON "MatchParticipant"("puuid", "championId");
