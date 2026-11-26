import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type ContainerBuilder } from 'discord.js';
import { INTERACTION_IDS } from '../constants.js';
import { COLORS, container, divider, profileIconUrl, reportButtonRow, text, textWithThumbnail, unixTime } from '../ui.js';

/** Panel permanente que se publica en el canal de verificación. */
export function buildVerificationPanel(): ContainerBuilder {
	return container(COLORS.primary)
		.addTextDisplayComponents(
			text('# Verificación de cuenta de League of Legends'),
			text('Vinculá tu cuenta de Riot para acceder a las funciones de la comunidad.')
		)
		.addSeparatorComponents(divider())
		.addTextDisplayComponents(
			text(
				[
					'### ¿Qué obtenés al verificarte?',
					'- Tu **rol de región**',
					'- Tu **rol de elo** según tu rango de Solo/Duo',
					'- Tu **perfil competitivo** con `/profile`'
				].join('\n')
			)
		)
		.addSeparatorComponents(divider())
		.addTextDisplayComponents(text('-# Solo te pedimos cambiar tu icono de invocador por uno que te indicamos. Nunca te pedimos tu contraseña.'))
		.addActionRowComponents(
			new ActionRowBuilder<ButtonBuilder>().addComponents(
				new ButtonBuilder().setCustomId(INTERACTION_IDS.verifyStart).setLabel('Verificar cuenta').setStyle(ButtonStyle.Primary),
				new ButtonBuilder().setCustomId(INTERACTION_IDS.verifyReport).setLabel('Reportar error').setStyle(ButtonStyle.Secondary)
			)
		);
}

export function buildAlreadyLinkedMessage(gameName: string, tagLine: string, region: string): ContainerBuilder {
	return container(COLORS.primary).addTextDisplayComponents(
		text(`### Cuenta ya vinculada\nYa tenés vinculada la cuenta **${gameName}#${tagLine}** en la región **${region}**.`)
	);
}

export function buildVerificationInProgressMessage(): ContainerBuilder {
	return container(COLORS.warning).addTextDisplayComponents(
		text(
			'### ⏳ Verificación en curso\nYa estamos comprobando tu cuenta. Cuando termine te enviaremos el resultado por mensaje directo. Si querés empezar de nuevo, cancelá la verificación desde el mensaje anterior.'
		)
	);
}

/** Primer paso: el usuario debe cambiar su icono de perfil. */
export function buildChallengeMessage(challengeId: number, gameName: string, tagLine: string, iconId: number, expiresAt: Date): ContainerBuilder {
	return container(COLORS.warning)
		.addSectionComponents(
			textWithThumbnail(
				[
					'### Completá la verificación',
					`Poné el icono de perfil de la imagen en tu cuenta de League of Legends y después presioná **Ya cambié la foto de perfil**.`
				].join('\n'),
				profileIconUrl(iconId)
			)
		)
		.addSeparatorComponents(divider())
		.addTextDisplayComponents(
			text(`**Cuenta:** ${gameName}#${tagLine}\n**Icono requerido:** ${iconId}\n**Tenés tiempo hasta:** <t:${unixTime(expiresAt)}:R>`)
		)
		.addActionRowComponents(
			new ActionRowBuilder<ButtonBuilder>().addComponents(
				new ButtonBuilder()
					.setCustomId(`${INTERACTION_IDS.verifyCheckPrefix}${challengeId}`)
					.setLabel('Ya cambié la foto de perfil')
					.setStyle(ButtonStyle.Success),
				new ButtonBuilder()
					.setCustomId(`${INTERACTION_IDS.verifyCancelPrefix}${challengeId}`)
					.setLabel('Cancelar')
					.setStyle(ButtonStyle.Secondary)
			)
		);
}

/** Segundo paso: el mensaje del desafío se edita y avisa que la comprobación tarda de 5 a 10 minutos. */
export function buildVerificationPendingMessage(
	challengeId: number,
	gameName: string,
	tagLine: string,
	iconId: number,
	firstCheckAt: Date
): ContainerBuilder {
	return container(COLORS.warning)
		.addSectionComponents(
			textWithThumbnail(
				[
					'### ⏳ Verificación en proceso',
					'Riot tarda en actualizar el icono de perfil, así que la comprobación toma **de 5 a 10 minutos**.',
					'Cuando termine te enviaremos el resultado por **mensaje directo**.'
				].join('\n'),
				profileIconUrl(iconId)
			)
		)
		.addSeparatorComponents(divider())
		.addTextDisplayComponents(
			text(`**Cuenta:** ${gameName}#${tagLine}\n**Primera comprobación:** <t:${unixTime(firstCheckAt)}:R>`),
			text('-# Mantené el icono puesto hasta que recibas el mensaje y revisá que tengas los mensajes directos del servidor habilitados.')
		)
		.addActionRowComponents(
			new ActionRowBuilder<ButtonBuilder>().addComponents(
				new ButtonBuilder()
					.setCustomId(`${INTERACTION_IDS.verifyCancelPrefix}${challengeId}`)
					.setLabel('Cancelar verificación')
					.setStyle(ButtonStyle.Danger)
			)
		);
}

/** Mensaje directo que se envía cuando la cuenta quedó vinculada. */
export function buildVerificationSuccessMessage(options: {
	guildId: string;
	guildName: string;
	gameName: string;
	tagLine: string;
	region: string;
	iconId: number;
	summonerLevel: number;
	roleAssigned: boolean;
	eloRole: { tier: string; assigned: boolean } | null;
}): ContainerBuilder {
	const lines = [
		`**Cuenta:** ${options.gameName}#${options.tagLine}`,
		`**Región:** ${options.region}`,
		`**Nivel:** ${options.summonerLevel}`,
		`**Rol de región:** ${options.roleAssigned ? 'asignado' : 'no se pudo asignar'}`
	];
	if (options.eloRole) lines.push(`**Rol de elo (${options.eloRole.tier}):** ${options.eloRole.assigned ? 'asignado' : 'no se pudo asignar'}`);
	else lines.push('**Rol de elo:** sin rango en Solo/Duo');

	const result = container(COLORS.success)
		.addSectionComponents(
			textWithThumbnail(
				`### ✅ Cuenta verificada\nTu cuenta quedó vinculada correctamente en **${options.guildName}**.`,
				profileIconUrl(options.iconId)
			)
		)
		.addSeparatorComponents(divider())
		.addTextDisplayComponents(text(lines.join('\n')));

	const hasRoleProblem = !options.roleAssigned || (options.eloRole !== null && !options.eloRole.assigned);
	if (hasRoleProblem) {
		result.addTextDisplayComponents(
			text('-# Si falta algún rol, avisale a un administrador: tiene que ejecutar `/setup` y revisar los permisos del bot.')
		);
	}

	return result.addSeparatorComponents(divider()).addActionRowComponents(reportButtonRow(options.guildId));
}

/** Mensaje directo que se envía cuando no se pudo confirmar el cambio de icono. */
export function buildVerificationFailedMessage(guildId: string, guildName: string, reason: string): ContainerBuilder {
	return container(COLORS.danger)
		.addTextDisplayComponents(
			text(`### ❌ No pude completar la verificación\n${reason}`),
			text(`-# Podés volver a intentarlo desde el panel de verificación de **${guildName}**.`)
		)
		.addSeparatorComponents(divider())
		.addActionRowComponents(reportButtonRow(guildId));
}