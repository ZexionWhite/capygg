import type { ContainerBuilder, User } from 'discord.js';
import { COLORS, container, divider, text, unixTime } from '../ui.js';

export function buildErrorReportMessage(
	user: User,
	category: string,
	description: string,
	reference: string | null,
	createdAt: Date
): ContainerBuilder {
	const quotedDescription = description
		.slice(0, 2_000)
		.split('\n')
		.map((line) => `> ${line}`)
		.join('\n');

	return container(COLORS.danger)
		.addTextDisplayComponents(
			text('### 🐞 Nuevo reporte de error'),
			text(
				[
					`**Usuario:** <@${user.id}> (${user.username} · \`${user.id}\`)`,
					`**Categoría:** ${category.slice(0, 100)}`,
					`**Referencia:** ${(reference || 'No especificada').slice(0, 200)}`,
					`**Fecha:** <t:${unixTime(createdAt)}:F>`
				].join('\n')
			)
		)
		.addSeparatorComponents(divider())
		.addTextDisplayComponents(text(`**Descripción**\n${quotedDescription}`));
}