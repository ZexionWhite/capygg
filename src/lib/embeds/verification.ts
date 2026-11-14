import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { DATA_DRAGON_VERSION, INTERACTION_IDS } from '../constants';

export function buildVerificationPanelEmbed(): EmbedBuilder {
	return new EmbedBuilder()
		.setColor(0x5865f2)
		.setTitle('Verificación de cuenta de League of Legends')
		.setDescription(
			'Verificá tu cuenta para obtener el rol de región. Próximamente también podrás obtener tu rol de elo y consultar tu perfil competitivo.'
		);
}

export function buildVerificationPanelComponents(): ActionRowBuilder<ButtonBuilder> {
	return new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder().setCustomId(INTERACTION_IDS.verifyStart).setLabel('Verificar cuenta').setStyle(ButtonStyle.Primary),
		new ButtonBuilder().setCustomId(INTERACTION_IDS.verifyReport).setLabel('Reportar error').setStyle(ButtonStyle.Secondary)
	);
}

export function buildChallengeEmbed(gameName: string, tagLine: string, iconId: number, expiresAt: Date): EmbedBuilder {
	return new EmbedBuilder()
		.setColor(0xf1c40f)
		.setTitle('Completá la verificación')
		.setDescription(
			`Poné el icono de perfil **${iconId}** en tu cuenta de League of Legends y luego presioná **Ya lo cambié, verificar**. El proceso de comprobación puede demorar entre **5 y 10 minutos**.`
		)
		.addFields(
			{ name: 'Cuenta', value: `${gameName}#${tagLine}`, inline: true },
			{ name: 'Icono requerido', value: `${iconId}`, inline: true },
			{ name: 'Expira', value: `<t:${Math.floor(expiresAt.getTime() / 1_000)}:R>`, inline: true }
		)
		.setThumbnail(`https://ddragon.leagueoflegends.com/cdn/${DATA_DRAGON_VERSION}/img/profileicon/${iconId}.png`);
}

export function buildChallengeComponents(challengeId: number): ActionRowBuilder<ButtonBuilder> {
	return new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder()
			.setCustomId(`${INTERACTION_IDS.verifyCheckPrefix}${challengeId}`)
			.setLabel('Ya lo cambié, verificar')
			.setStyle(ButtonStyle.Success),
		new ButtonBuilder().setCustomId(`${INTERACTION_IDS.verifyCancelPrefix}${challengeId}`).setLabel('Cancelar').setStyle(ButtonStyle.Secondary)
	);
}

export function buildVerificationSuccessEmbed(region: string, gameName: string, tagLine: string): EmbedBuilder {
	return new EmbedBuilder()
		.setColor(0x57f287)
		.setTitle('Cuenta verificada')
		.setDescription(`**${gameName}#${tagLine}** quedó vinculada correctamente.`)
		.addFields({ name: 'Región', value: region });
}
