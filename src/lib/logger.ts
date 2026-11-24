import { container } from '@sapphire/framework';

export function createLogger(scope: string) {
	const prefix = `[${scope}]`;

	return {
		debug(message: string, ...details: unknown[]): void {
			container.logger.debug(`${prefix} ${message}`, ...details);
		},
		info(message: string, ...details: unknown[]): void {
			container.logger.info(`${prefix} ${message}`, ...details);
		},
		warn(message: string, ...details: unknown[]): void {
			container.logger.warn(`${prefix} ${message}`, ...details);
		},
		error(message: string, ...details: unknown[]): void {
			container.logger.error(`${prefix} ${message}`, ...details);
		}
	};
}
