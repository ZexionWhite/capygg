import { EmbedBuilder, type User } from 'discord.js';

export function buildErrorReportEmbed(user: User, category: string, description: string, reference: string | null, createdAt: Date): EmbedBuilder {
	return new EmbedBuilder()
		.setColor(0xed4245)
		.setTitle('Nuevo reporte de error')
		.addFields(
			{ name: 'Usuario', value: `${user.tag} (${user.id})` },
			{ name: 'Categoría', value: category },
			{ name: 'Descripción', value: description.slice(0, 1_024) },
			{ name: 'Referencia', value: (reference || 'No especificada').slice(0, 1_024) }
		)
		.setTimestamp(createdAt);
}
