import { expect } from "bun:test";
import Ajv2020 from "ajv/dist/2020";

// Appendix B is JSON Schema 2020-12; strict mode would refuse keywords the
// schemas use only as documentation (decision 48).
const ajv = new Ajv2020({ strict: false, allErrors: true });

/** Ajv's errors for `value` against `schema`, or null when it is accepted. */
export function issues(schema: unknown, value: unknown) {
	const validate = ajv.compile(schema as object);
	return validate(value) ? null : validate.errors;
}

/** Fails the test unless `schema` accepts `value`. */
export function expectValid(schema: unknown, value: unknown): void {
	expect(issues(schema, value)).toBeNull();
}
