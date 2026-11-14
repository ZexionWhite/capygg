import type { PrismaClient } from '../generated/prisma/client';

declare module '@sapphire/pieces' {
	interface Container {
		prisma: PrismaClient;
	}
}
