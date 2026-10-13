import type { ErrorBody } from "./schemas.ts";

type Details = ErrorBody["details"];
type Code = ErrorBody["code"];

/** One refusal: the details a code carries are required, the rest absent. */
type Case<
	C extends Code,
	Need extends keyof Details = never,
	May extends keyof Details = never,
> = {
	code: C;
	message: string;
	next: string;
	details: Required<Pick<Details, Need>> & Pick<Details, May>;
};

/** Every refusal board makes, one case per code of Appendix B's error table. */
export type BoardError =
	| Case<"not_found", "what" | "id">
	| Case<"claim_held", "claim">
	| Case<"not_claimed">
	| Case<"not_ready", "task" | "reason">
	| Case<"invalid_transition", never, "from" | "to" | "allowed" | "reason">
	| Case<"already_answered", "question">
	| Case<"cycle", "path">
	| Case<"invalid_argument", "field", "reason">
	| Case<"busy">
	| Case<"storage", "sqlite">
	| Case<"no_board", "reason", "file">
	| Case<"no_project", "cwd" | "git" | "git_root" | "projects", "reason">
	| Case<"project_exists", "field" | "project">
	| Case<"damaged", "sqlite">
	| Case<"not_a_board">
	| Case<"schema_mismatch", "from" | "to">
	| Case<"registry", "reason">
	| Case<"internal", "reason">;

/**
 * A BoardError thrown through a transaction: Prisma rolls back on any throw,
 * and the adapters catch this one to answer with its error.
 */
export class Refusal extends Error {
	constructor(readonly error: BoardError) {
		super(error.message);
		this.name = "Refusal";
	}
}

export function refuse(error: BoardError): never {
	throw new Refusal(error);
}

/** A refusal's line on stderr, the code in a fixed place: `board: <code>: …`. */
export function errorText(error: BoardError): string {
	return `board: ${error.code}: ${error.message} ${error.next}`;
}

/** `internal`: an exception in board's own code, whose change was rolled back. */
export function internalError(error: unknown): BoardError {
	const reason =
		error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	return {
		code: "internal",
		message: `board failed inside: ${reason}`,
		next: "Report it; nothing was changed.",
		details: { reason },
	};
}

/** `registry`: the versions of board could not be read; only `board upgrade` asks. */
export function registryError(error: unknown): BoardError {
	const reason = error instanceof Error ? error.message : String(error);
	return {
		code: "registry",
		message: `board could not read the versions of @chorded/board from registry.npmjs.org: ${reason}`,
		next: "Check the network and try again; nothing was changed.",
		details: { reason },
	};
}
