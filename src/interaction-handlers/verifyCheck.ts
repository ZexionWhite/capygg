import { ApplyOptions } from '@sapphire/decorators';
import { InteractionHandler, InteractionHandlerTypes } from '@sapphire/framework';
import { ButtonInteraction } from 'discord.js';
import { INTERACTION_IDS, VERIFICATION } from '../lib/constants.js';
import { buildVerificationPendingMessage } from '../lib/embeds/verification.js';
import { noticeMessage, v2 } from '../lib/ui.js';

@ApplyOptions<InteractionHandler.Options>({
	interactionHandlerType: InteractionHandlerTypes.Button
})
export class VerifyCheckHandler extends InteractionHandler {
	public override parse(interaction: ButtonInteraction) {
		if (!interaction.customId.startsWith(INTERACTION_IDS.verifyCheckPrefix)) return this.none();
		const challengeId = Number(interaction.customId.slice(INTERACTION_IDS.verifyCheckPrefix.length));
		return Number.isSafeInteger(challengeId) && challengeId > 0 ? this.some(challengeId) : this.none();
	}

	public override async run(interaction: ButtonInteraction, parsedData: unknown) {
		await interaction.deferUpdate();

		try {
			const challengeId = typeof parsedData === 'number' ? parsedData : NaN;
			const challenge = await this.container.prisma.verificationChallenge.findUnique({ where: { id: challengeId } });
			if (!challenge || challenge.discordId !== interaction.user.id || challenge.guildId !== interaction.guildId) {
				return interaction.editReply(noticeMessage('error', 'Este desafío de verificación no existe o no te pertenece.'));
			}

			const firstCheckAt = challenge.nextCheckAt ?? new Date(Date.now() + VERIFICATION.checkDelayMs);

			// Si ya se tocó el botón antes, solo se vuelve a mostrar el estado actual.
			if (challenge.startedAt) {
				return interaction.editReply(
					v2(buildVerificationPendingMessage(challenge.id, challenge.gameName, challenge.tagLine, challenge.requiredIconId, firstCheckAt))
				);
			}

			if (challenge.expiresAt.getTime() <= Date.now()) {
				await this.container.prisma.verificationChallenge.delete({ where: { id: challenge.id } });
				return interaction.editReply(noticeMessage('warning', 'El desafío expiró. Iniciá la verificación nuevamente desde el panel.'));
			}

			const startedAt = new Date();
			const nextCheckAt = new Date(startedAt.getTime() + VERIFICATION.checkDelayMs);
			await this.container.prisma.verificationChallenge.update({
				where: { id: challenge.id },
				data: { startedAt, nextCheckAt, attempts: 0 }
			});

			return interaction.editReply(
				v2(buildVerificationPendingMessage(challenge.id, challenge.gameName, challenge.tagLine, challenge.requiredIconId, nextCheckAt))
			);
		} catch (error) {
			this.container.logger.error(error);
			return interaction.editReply(noticeMessage('error', 'No pude iniciar la comprobación. Intentá nuevamente en unos minutos.'));
		}
	}
}