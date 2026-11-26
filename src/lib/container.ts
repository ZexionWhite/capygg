import type { PrismaClient } from '../generated/prisma/client.js';

declare module '@sapphire/pieces' {
	interface Container {
		prisma: PrismaClient;
	}
}
