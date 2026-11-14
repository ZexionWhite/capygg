-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_VerificationChallenge" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "discordId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "puuid" TEXT NOT NULL,
    "gameName" TEXT NOT NULL,
    "tagLine" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "requiredIconId" INTEGER NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "startedAt" DATETIME,
    "nextCheckAt" DATETIME,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_VerificationChallenge" ("createdAt", "discordId", "expiresAt", "gameName", "guildId", "id", "puuid", "region", "requiredIconId", "tagLine") SELECT "createdAt", "discordId", "expiresAt", "gameName", "guildId", "id", "puuid", "region", "requiredIconId", "tagLine" FROM "VerificationChallenge";
DROP TABLE "VerificationChallenge";
ALTER TABLE "new_VerificationChallenge" RENAME TO "VerificationChallenge";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
