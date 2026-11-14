export class InvalidRiotIdError extends Error {
	public constructor() {
		super('Invalid Riot ID format.');
		this.name = 'InvalidRiotIdError';
	}
}

export function parseRiotId(value: string): { gameName: string; tagLine: string } {
	const separator = value.lastIndexOf('#');
	const gameName = value.slice(0, separator).trim();
	const tagLine = value.slice(separator + 1).trim();
	if (separator <= 0 || !gameName || !tagLine || gameName.length > 16 || tagLine.length > 5) {
		throw new InvalidRiotIdError();
	}
	return { gameName, tagLine };
}
