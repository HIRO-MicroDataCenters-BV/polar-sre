import { describe, expect, it } from "vitest";
import { invalidParameter, isGiven } from "../validation.ts";

describe("validation", () => {
	it("treats empty strings as absent", () => {
		expect(isGiven(undefined)).toBe(false);
		expect(isGiven("")).toBe(false);
		expect(isGiven(" ")).toBe(true);
		expect(isGiven("web-0")).toBe(true);
	});

	it("formats the text", () => {
		expect(invalidParameter("name", "give one object name", "pass flags as separate parameters")).toBe(
			'Invalid parameter "name": give one object name; pass flags as separate parameters.',
		);
	});
});
