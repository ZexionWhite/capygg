import { ApplyOptions } from '@sapphire/decorators';
import { InteractionHandler, InteractionHandlerTypes } from '@sapphire/framework';
import { ButtonInteraction } from 'discord.js';
import { INTERACTION_IDS } from '../lib/constants';

@ApplyOptions<InteractionHandler.Options>({
	interactionHandlerType: InteractionHandlerTypes.Button
})
export class VerifyCancelHandler extends InteractionHandler {
	public override parse(interaction: ButtonInteraction) {
		if (!interaction.customId.startsWith(INTERACTION_IDS.verifyCancelPrefix)) return this.none();
		const challengeId = Number(interaction.customId.slice(INTERACTION_IDS.verifyCancelPrefix.length));
		return Number.isSafeInteger(challengeId) && challengeId > 0 ? this.some(challengeId) : this.none();
	}

	public override async run(interaction: ButtonInteraction, parsedData: unknown) {
		await interaction.deferUpdate();

		try {
			const challengeId = typeof parsedData === 'number' ? parsedData : NaN;
			const challenge = await this.container.prisma.verificationChallenge.findUnique({ where: { id: challengeId } });
			if (challenge?.discordId === interaction.user.id) {
				await this.container.prisma.verificationChallenge.delete({ where: { id: challenge.id } });
			}
			return interaction.editReply({ content: 'Verificación cancelada.', embeds: [], components: [] });
		} catch (error) {
			this.container.logger.error(error);
			return interaction.editReply({ content: 'No pude cancelar la verificación. Intentá nuevamente.', components: [] });
		}
	}
}
