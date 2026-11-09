export function isGiven(value: string | undefined): value is string {
	return value !== undefined && value !== "";
}

export function invalidParameter(field: string, form: string, fix: string): string {
	return `Invalid parameter "${field}": ${form}; ${fix}.`;
}

export function nulCharacterError(params: Record<string, unknown>): string | undefined {
	for (const [field, value] of Object.entries(params)) {
		if (typeof value === "string" && value.includes("\0")) {
			return `Invalid parameter "${field}": NUL characters are not allowed.`;
		}
	}
	return undefined;
}
