import { invalidParameter, isGiven } from "../../shared/validation.ts";

const TYPE_TOKEN = /^[^\s/,-][^\s/,]*$/;
const OBJECT_NAME = /^[^\s/-][^\s/]*$/;
const NAMESPACE_NAME = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

export const NAMESPACE_DESCRIPTION =
	"Namespace: 1 to 63 lowercase letters, digits and hyphens, starting and ending with a letter or digit. Empty means not set.";

export function isTypeToken(value: string): boolean {
	return TYPE_TOKEN.test(value);
}

export function isObjectName(value: string): boolean {
	return OBJECT_NAME.test(value);
}

export function namespaceError(value: string | undefined): string | undefined {
	if (!isGiven(value) || NAMESPACE_NAME.test(value)) {
		return undefined;
	}
	return invalidParameter(
		"namespace",
		"give one namespace name: 1 to 63 characters, lowercase letters, digits and hyphens, starting and ending with a letter or digit",
		"pass flags as separate parameters",
	);
}
