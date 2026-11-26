/**
 * Íconos vectoriales de respaldo. El render usa primero el PNG de `assets/ui/...` si existe
 * y solo cae a estos cuando falta el archivo.
 */
export type IconName =
	| 'crown'
	| 'flame'
	| 'flameGreen'
	| 'close'
	| 'mainChampion'
	| 'otp'
	| 'aram_player'
	| 'aram_mayhem_enjoyer'
	| 'soloq_abuser'
	| 'distinction'
	| 'capybara';

let idCounter = 0;
export const nextId = (prefix: string): string => `${prefix}${++idCounter}`;

function gradient(id: string, from: string, to: string, vertical = true): string {
	return `<linearGradient id="${id}" x1="0" y1="0" x2="${vertical ? 0 : 1}" y2="${vertical ? 1 : 0}"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient>`;
}

const CROWN_PATH = 'M3 8.2l4.6 4.1L12 4.6l4.4 7.7L21 8.2 19.3 18.5H4.7z';
const FLAME_PATH = 'M12.6 2c.5 3.2-1.4 4.9-3 6.9C8 10.8 6.5 12.6 6.5 15.2 6.5 18.9 9 21.8 12 21.8s5.5-2.9 5.5-6.6c0-2.5-1.2-4.1-2.3-5.5-.3 1.3-1 2-1.9 2.3.5-3.2-.9-6.6-1.7-10z';
const FLAME_INNER = 'M12 21.8c-1.8 0-3.1-1.5-3.1-3.4 0-1.8 1.2-2.8 2.1-4.2.5 1 1.1 1.6 1.7 2 .6.5 1.4 1.4 1.4 2.5 0 1.9-.9 3.1-2.1 3.1z';

/** Dibuja un ícono de respaldo dentro de un cuadrado de `size` px con la esquina superior izquierda en (x, y). */
export function vectorIcon(name: IconName, x: number, y: number, size: number): string {
	const wrap = (body: string) => `<g transform="translate(${x} ${y}) scale(${size / 24})">${body}</g>`;
	const id = nextId('ic');

	switch (name) {
		case 'crown':
			return wrap(`<defs>${gradient(id, '#ffd98a', '#e9a23c')}</defs><path d="${CROWN_PATH}" fill="url(#${id})"/><rect x="4.6" y="19.6" width="14.8" height="2.2" rx="1.1" fill="url(#${id})"/>`);
		case 'flame':
			return wrap(`<defs>${gradient(id, '#ffa24d', '#ff5a2b')}</defs><path d="${FLAME_PATH}" fill="url(#${id})"/><path d="${FLAME_INNER}" fill="#ffd58a"/>`);
		case 'flameGreen':
			return wrap(`<defs>${gradient(id, '#8cf7b4', '#25c46f')}</defs><path d="${FLAME_PATH}" fill="url(#${id})"/><path d="${FLAME_INNER}" fill="#d6ffe5"/>`);
		case 'close':
			return wrap(`<path d="M6.2 6.2l11.6 11.6M17.8 6.2L6.2 17.8" stroke="#ef5b68" stroke-width="3.2" stroke-linecap="round" fill="none"/>`);
		case 'mainChampion':
			return wrap(`<defs>${gradient(id, '#c4acff', '#7a58ee')}</defs><path d="M12 1.8l2.7 7.5 7.5 2.7-7.5 2.7L12 22.2l-2.7-7.5L1.8 12l7.5-2.7z" fill="url(#${id})"/><circle cx="12" cy="12" r="2.3" fill="#2b1768"/>`);
		case 'otp':
			return wrap(
				`<defs>${gradient(id, '#ffd98a', '#e9a23c')}</defs><path d="M12 1.4l9.2 5.3v10.6L12 22.6l-9.2-5.3V6.7z" fill="#2c210d" stroke="url(#${id})" stroke-width="1.5" stroke-linejoin="round"/><g transform="translate(5.6 5.2) scale(.53)"><path d="${CROWN_PATH}" fill="url(#${id})"/><rect x="4.6" y="19.6" width="14.8" height="2.2" rx="1.1" fill="url(#${id})"/></g>`
			);
		case 'aram_player':
			return wrap(`<defs>${gradient(id, '#5eead4', '#119e92')}</defs><path d="M12 1.8l8.2 3v6.4c0 5.1-3.5 9.2-8.2 11-4.7-1.8-8.2-5.9-8.2-11V4.8z" fill="url(#${id})"/><path d="M7.9 12.2l3 3 5.3-6.2" stroke="#06312c" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`);
		case 'aram_mayhem_enjoyer':
			return wrap(`<defs>${gradient(id, '#f9a8d4', '#d946a8')}</defs><circle cx="12" cy="12" r="10.4" fill="#2a1030" stroke="url(#${id})" stroke-width="1.5"/><path d="M13.4 3.8L6.6 13.2h4.6l-1 7 7.2-9.6h-4.7z" fill="url(#${id})"/>`);
		case 'soloq_abuser':
			return wrap(`<defs>${gradient(id, '#9b8cff', '#5b45e0')}</defs><circle cx="12" cy="12" r="10.6" fill="url(#${id})"/><path d="M12 5.2a5.6 5.6 0 0 0-5.6 5.6v7l1.9-1.5 1.8 1.5 1.9-1.5 1.9 1.5 1.8-1.5 1.9 1.5v-7A5.6 5.6 0 0 0 12 5.2z" fill="#eae6ff"/><circle cx="9.6" cy="10.6" r="1.3" fill="#3b2aa8"/><circle cx="14.4" cy="10.6" r="1.3" fill="#3b2aa8"/>`);
		case 'distinction':
			return wrap(`<defs>${gradient(id, '#a9b8da', '#6277a6')}</defs><path d="M12 1.8l8 10.2-8 10.2L4 12z" fill="url(#${id})"/><path d="M12 6.4l3.6 5.6-3.6 5.6L8.4 12z" fill="#1a2238" opacity=".55"/>`);
		case 'capybara':
			return wrap(
				`<path d="M2.2 15.6c0-3.2 2.1-5.6 5.3-6.5l1.9-3.2c.5-.9 1.7-1.1 2.5-.5l.8.7c3.7.1 8.1 1.6 9.1 5.7.3 1.2.2 3.2-.4 4.4-.5 1.1-1.6 1.6-2.8 1.6H5.4c-1.8 0-3.2-1.5-3.2-3.5z" fill="#b6bbd0"/><circle cx="9.6" cy="11.6" r="1.1" fill="#0b0c12"/><path d="M3.2 14.1c.9-.2 1.7.1 2.2.8" stroke="#0b0c12" stroke-width="1.1" stroke-linecap="round" fill="none" opacity=".7"/><ellipse cx="12.6" cy="6.1" rx="1.5" ry="1.9" fill="#9096ad"/>`
			);
	}
}
