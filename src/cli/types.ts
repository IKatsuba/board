import type { ArgumentValue } from "@cliffy/command";
import { Type, ValidationError } from "@cliffy/command";

/**
 * A value checked against Appendix B's pattern at parse, so a malformed one
 * is a usage error, before the board is opened.
 */
class PatternType extends Type<string> {
	constructor(
		private readonly pattern: RegExp,
		private readonly what: string,
	) {
		super();
	}

	parse({ label, name, value }: ArgumentValue): string {
		if (!this.pattern.test(value)) {
			throw new ValidationError(
				`${label} "${name}" must be ${this.what}, got "${value}".`,
			);
		}
		return value;
	}
}

/** A task key, any case: BRD-12. */
export const keyType = new PatternType(
	/^[A-Za-z][A-Za-z0-9]{0,9}-[1-9][0-9]*$/,
	"a task key such as BRD-12",
);
/** A project key, any case: BRD. */
export const projectType = new PatternType(
	/^[A-Za-z][A-Za-z0-9]{0,9}$/,
	"a project key such as BRD",
);
/** A milestone name, or none. */
export const milestoneType = new PatternType(
	/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/,
	"a milestone name, or none",
);

/** A question id, any case: Q7. */
export const questionType = new PatternType(
	/^[Qq][1-9][0-9]*$/,
	"a question id such as Q7",
);
