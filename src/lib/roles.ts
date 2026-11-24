import { container } from '@sapphire/framework';
import { DiscordAPIError, resolveColor, type Guild, type Role } from 'discord.js';
import { ELO_TIERS, LEGACY_ROLE_KEYS, REGIONS } from './constants';
import type { EloTier, Region } from './types';

export type RoleKind = 'ELO' | 'REGION';

export interface RoleDefinition {
	/** Identificador estable guardado en la base. Si se cambia, hay que registrar el cambio en LEGACY_ROLE_KEYS. */
	key: string;
	kind: RoleKind;
	/** Nombre visible del rol en Discord (por ahora igual a la key). */
	name: string;
	/** `null` = el bot no toca el color del rol. */
	color: number | null;
}

export type RoleSyncOutcome = 'created' | 'updated' | 'reused';

/** Todos los roles que el bot gestiona. Las próximas features (posiciones, colas) se suman acá. */
export function roleDefinitions(): RoleDefinition[] {
	const elo = (Object.keys(ELO_TIERS) as EloTier[]).map(
		(tier): RoleDefinition => ({ key: tier, kind: 'ELO', name: tier, color: resolveColor(ELO_TIERS[tier].color) })
	);
	const regions = (Object.keys(REGIONS) as Region[]).map((region): RoleDefinition => ({ key: region, kind: 'REGION', name: region, color: null }));

	return [...elo, ...regions];
}

/**
 * Pasa las filas de `GuildRole` guardadas con una key vieja a la key nueva, conservando el `roleId`.
 * Solo toca la base de datos: el nombre del rol en Discord se actualiza con /setup. Es idempotente.
 * Devuelve cuántas filas procesó.
 */
export async function migrateLegacyRoleKeys(): Promise<number> {
	let processed = 0;

	for (const [legacyKey, currentKey] of Object.entries(LEGACY_ROLE_KEYS)) {
		const legacyRows = await container.prisma.guildRole.findMany({ where: { key: legacyKey } });

		for (const row of legacyRows) {
			const current = await container.prisma.guildRole.findUnique({
				where: { guildId_key: { guildId: row.guildId, key: currentKey } }
			});

			if (current) {
				// Ya hay un rol registrado con la key nueva: gana ese y se descarta la fila vieja.
				await container.prisma.guildRole.delete({ where: { id: row.id } });
				container.logger.warn(
					`[roles] ${row.guildId}: ya existía "${currentKey}", se descartó la fila vieja "${legacyKey}" (el rol ${row.roleId} queda sin gestionar).`
				);
			} else {
				await container.prisma.guildRole.update({ where: { id: row.id }, data: { key: currentKey } });
				container.logger.info(`[roles] ${row.guildId}: key "${legacyKey}" migrada a "${currentKey}" (rol ${row.roleId} conservado).`);
			}
			processed++;
		}
	}

	return processed;
}

/**
 * Deja un rol de Discord alineado con su definición:
 * - Si hay un rol guardado y existe, lo reutiliza y corrige nombre/color si difieren (`updated`/`reused`).
 * - Si no hay rol guardado o fue borrado en Discord, crea uno nuevo y guarda su ID (`created`).
 */
export async function syncGuildRole(guild: Guild, definition: RoleDefinition): Promise<RoleSyncOutcome> {
	const where = { guildId_key: { guildId: guild.id, key: definition.key } };
	const stored = await container.prisma.guildRole.findUnique({ where });

	if (stored) {
		const existing = await fetchRole(guild, stored.roleId);
		if (existing) {
			if (stored.kind !== definition.kind) await container.prisma.guildRole.update({ where, data: { kind: definition.kind } });
			return (await alignRole(existing, definition)) ? 'updated' : 'reused';
		}
	}

	const role = await guild.roles.create({
		name: definition.name,
		...(definition.color === null ? {} : { color: definition.color }),
		reason: `Initial ${definition.kind.toLowerCase()} role setup`
	});

	await container.prisma.guildRole.upsert({
		where,
		create: { guildId: guild.id, key: definition.key, kind: definition.kind, roleId: role.id },
		update: { kind: definition.kind, roleId: role.id }
	});

	return 'created';
}

/** Corrige nombre y color si difieren. Devuelve `true` si tuvo que editar el rol. */
async function alignRole(role: Role, definition: RoleDefinition): Promise<boolean> {
	const changes: { name?: string; color?: number } = {};
	if (role.name !== definition.name) changes.name = definition.name;
	if (definition.color !== null && role.color !== definition.color) changes.color = definition.color;
	if (Object.keys(changes).length === 0) return false;

	await role.edit({ ...changes, reason: 'CapyGG: sincronización de roles' });
	container.logger.info(`[roles] ${role.guild.id}: rol ${role.id} actualizado (${Object.keys(changes).join(', ')}) -> "${definition.name}".`);
	return true;
}

async function fetchRole(guild: Guild, roleId: string): Promise<Role | null> {
	try {
		return await guild.roles.fetch(roleId);
	} catch (error) {
		if (error instanceof DiscordAPIError && error.code === 10011) return null;
		throw error;
	}
}