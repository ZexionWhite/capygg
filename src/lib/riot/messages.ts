import { RiotApiError } from './client.js';

export function riotErrorMessage(error: unknown): string {
	if (!(error instanceof RiotApiError)) return 'Ocurrió un error inesperado al consultar Riot.';

	switch (error.kind) {
		case 'NOT_FOUND':
			return 'No encontré esa cuenta de Riot. Revisá el Riot ID y la región.';
		case 'RATE_LIMITED':
			return 'Riot está limitando temporalmente las consultas. Intentá nuevamente en unos minutos.';
		case 'KEY_INVALID_OR_EXPIRED':
			return 'La API de Riot no está disponible porque la clave del bot es inválida o venció. Es un problema del bot, no de tu cuenta.';
		case 'UNAVAILABLE':
			return 'La API de Riot no está disponible en este momento. Intentá nuevamente más tarde.';
		case 'UNKNOWN':
			return 'Riot devolvió una respuesta inesperada. Intentá nuevamente más tarde.';
		case 'INVALID_PUUID':
			return 'No pude actualizar los datos de esa cuenta. Si cambió su Riot ID, hay que volver a vincularla.';
	}
}
