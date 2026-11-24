-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ChampionMastery" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "puuid" TEXT NOT NULL,
    "championId" INTEGER NOT NULL,
    "championLevel" INTEGER NOT NULL,
    "championPoints" INTEGER NOT NULL,
    "lastPlayTime" DATETIME,
    "championPointsSinceLevel" INTEGER NOT NULL,
    "championPointsUntilNextLevel" INTEGER NOT NULL,
    "tokensEarned" INTEGER NOT NULL,
    "chestGranted" BOOLEAN,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ChampionMastery_puuid_fkey" FOREIGN KEY ("puuid") REFERENCES "RiotAccount" ("puuid") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ChampionMastery" ("championId", "championLevel", "championPoints", "championPointsSinceLevel", "championPointsUntilNextLevel", "chestGranted", "id", "lastPlayTime", "puuid", "tokensEarned", "updatedAt") SELECT "championId", "championLevel", "championPoints", "championPointsSinceLevel", "championPointsUntilNextLevel", "chestGranted", "id", "lastPlayTime", "puuid", "tokensEarned", "updatedAt" FROM "ChampionMastery";
DROP TABLE "ChampionMastery";
ALTER TABLE "new_ChampionMastery" RENAME TO "ChampionMastery";
CREATE INDEX "ChampionMastery_puuid_championPoints_idx" ON "ChampionMastery"("puuid", "championPoints");
CREATE INDEX "ChampionMastery_championId_championPoints_idx" ON "ChampionMastery"("championId", "championPoints");
CREATE UNIQUE INDEX "ChampionMastery_puuid_championId_key" ON "ChampionMastery"("puuid", "championId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
