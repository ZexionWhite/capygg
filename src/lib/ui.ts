import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	ContainerBuilder,
	MessageFlags,
	SectionBuilder,
	SeparatorBuilder,
	SeparatorSpacingSize,
	TextDisplayBuilder,
	ThumbnailBuilder
} from 'discord.js';
import { INTERACTION_IDS } from './constants';
import { dataDragonVersion, knownDataDragonVersion } from './ddragon';

export const COLORS = {
	primary: 0x5865f2,
	success: 0x57f287,
	warning: 0xf1c40f,
	danger: 0xed4245
} as const;

export type NoticeKind = 'success' | 'error' | 'warning' | 'info';

const NOTICE_STYLES: Record<NoticeKind, { color: number; icon: string }> = {
	success: { color: COLORS.success, icon: '✅' },
	error: { color: COLORS.danger, icon: '❌' },
	warning: { color: COLORS.warning, icon: '⚠️' },
	info: { color: COLORS.primary, icon: 'ℹ️' }
};

/** Mensaje Components V2 público (para canales y DMs). */
export function v2(...containers: ContainerBuilder[]) {
	return { components: containers, flags: MessageFlags.IsComponentsV2 } as const;
}

/** Mensaje Components V2 efímero. Solo para `reply()` / `followUp()`, no para `editReply()`. */
export function ephemeralV2(...containers: ContainerBuilder[]) {
	return { components: containers, flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral } as const;
}

export function text(content: string): TextDisplayBuilder {
	return new TextDisplayBuilder().setContent(content);
}

export function divider(): SeparatorBuilder {
	return new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);
}

export function container(color: number): ContainerBuilder {
	return new ContainerBuilder().setAccentColor(color);
}

export function profileIconUrl(iconId: number): string {
	// Mantiene la versión al día en segundo plano; mientras tanto usa la última conocida.
	void dataDragonVersion();
	return `https://ddragon.leagueoflegends.com/cdn/${knownDataDragonVersion()}/img/profileicon/${iconId}.png`;
}

/** Bloque de texto con una miniatura a la derecha. */
export function textWithThumbnail(content: string, thumbnailUrl: string): SectionBuilder {
	return new SectionBuilder().addTextDisplayComponents(text(content)).setThumbnailAccessory(new ThumbnailBuilder().setURL(thumbnailUrl));
}

export function unixTime(date: Date): number {
	return Math.floor(date.getTime() / 1_000);
}

export function noticeContainer(kind: NoticeKind, content: string, title?: string): ContainerBuilder {
	const { color, icon } = NOTICE_STYLES[kind];
	return container(color).addTextDisplayComponents(text(title ? `### ${icon} ${title}\n${content}` : `${icon} ${content}`));
}

export function noticeMessage(kind: NoticeKind, content: string, title?: string) {
	return v2(noticeContainer(kind, content, title));
}

export function ephemeralNoticeMessage(kind: NoticeKind, content: string, title?: string) {
	return ephemeralV2(noticeContainer(kind, content, title));
}

/** Botón "Reportar error" para mensajes enviados por DM (lleva el ID del servidor). */
export function reportButtonRow(guildId: string): ActionRowBuilder<ButtonBuilder> {
	return new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder()
			.setCustomId(`${INTERACTION_IDS.verifyReportDmPrefix}${guildId}`)
			.setLabel('Reportar un error')
			.setStyle(ButtonStyle.Secondary)
	);
}