-- AlterTable
ALTER TABLE "MatchParticipant" ADD COLUMN "baronKills" INTEGER;
ALTER TABLE "MatchParticipant" ADD COLUMN "dragonKills" INTEGER;
ALTER TABLE "MatchParticipant" ADD COLUMN "goldEarned" INTEGER;
ALTER TABLE "MatchParticipant" ADD COLUMN "neutralMinionsKilled" INTEGER;
ALTER TABLE "MatchParticipant" ADD COLUMN "perksJson" TEXT;
ALTER TABLE "MatchParticipant" ADD COLUMN "summoner1Id" INTEGER;
ALTER TABLE "MatchParticipant" ADD COLUMN "summoner2Id" INTEGER;
ALTER TABLE "MatchParticipant" ADD COLUMN "totalDamageTaken" INTEGER;
ALTER TABLE "MatchParticipant" ADD COLUMN "totalHeal" INTEGER;
ALTER TABLE "MatchParticipant" ADD COLUMN "totalMinionsKilled" INTEGER;
ALTER TABLE "MatchParticipant" ADD COLUMN "wardsKilled" INTEGER;
ALTER TABLE "MatchParticipant" ADD COLUMN "wardsPlaced" INTEGER;

-- CreateTable
CREATE TABLE "PlayerGuildPreference" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "guildId" TEXT NOT NULL,
    "discordId" TEXT NOT NULL,
    "playsSolo" BOOLEAN NOT NULL DEFAULT false,
    "playsFlex" BOOLEAN NOT NULL DEFAULT false,
    "playsNormals" BOOLEAN NOT NULL DEFAULT false,
    "playsAram" BOOLEAN NOT NULL DEFAULT false,
    "primaryLane" TEXT,
    "updatedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "DistinctionAward" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "guildId" TEXT NOT NULL,
    "discordId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "awardedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" DATETIME,
    "source" TEXT NOT NULL DEFAULT 'automatic'
);

-- CreateTable
CREATE TABLE "OtpOverride" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "guildId" TEXT NOT NULL,
    "discordId" TEXT NOT NULL,
    "puuid" TEXT NOT NULL,
    "championId" INTEGER NOT NULL,
    "actorDiscordId" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_RiotAccount" (
    "puuid" TEXT NOT NULL PRIMARY KEY,
    "discordId" TEXT NOT NULL,
    "gameName" TEXT NOT NULL,
    "tagLine" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "profileIconId" INTEGER,
    "summonerLevel" INTEGER,
    "linkedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "masterySyncedAt" DATETIME,
    "rankSyncedAt" DATETIME,
    "matchesSyncedAt" DATETIME,
    "matchHistoryBackfilledAt" DATETIME,
    "matchHistoryBackfillOffset" INTEGER NOT NULL DEFAULT 0,
    "matchHistoryBackfillComplete" BOOLEAN NOT NULL DEFAULT false
);
INSERT INTO "new_RiotAccount" ("discordId", "gameName", "linkedAt", "masterySyncedAt", "matchHistoryBackfilledAt", "matchesSyncedAt", "profileIconId", "puuid", "region", "summonerLevel", "tagLine") SELECT "discordId", "gameName", "linkedAt", "masterySyncedAt", "matchHistoryBackfilledAt", "matchesSyncedAt", "profileIconId", "puuid", "region", "summonerLevel", "tagLine" FROM "RiotAccount";
DROP TABLE "RiotAccount";
ALTER TABLE "new_RiotAccount" RENAME TO "RiotAccount";
CREATE UNIQUE INDEX "RiotAccount_discordId_key" ON "RiotAccount"("discordId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "PlayerGuildPreference_discordId_idx" ON "PlayerGuildPreference"("discordId");

-- CreateIndex
CREATE UNIQUE INDEX "PlayerGuildPreference_guildId_discordId_key" ON "PlayerGuildPreference"("guildId", "discordId");

-- CreateIndex
CREATE INDEX "DistinctionAward_guildId_discordId_awardedAt_idx" ON "DistinctionAward"("guildId", "discordId", "awardedAt");

-- CreateIndex
CREATE INDEX "DistinctionAward_guildId_discordId_key_idx" ON "DistinctionAward"("guildId", "discordId", "key");

-- CreateIndex
CREATE INDEX "OtpOverride_guildId_discordId_idx" ON "OtpOverride"("guildId", "discordId");

-- CreateIndex
CREATE INDEX "OtpOverride_puuid_championId_idx" ON "OtpOverride"("puuid", "championId");
