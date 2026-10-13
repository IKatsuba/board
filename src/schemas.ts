// Appendix B of docs/design.md as const objects: the CLI's --json contract,
// turned into types by json-schema-to-ts and validated by the tests with Ajv;
// nothing validates at run time (decision 48). One shape per thing.
import type { FromSchema } from "json-schema-to-ts";

export const defs = {
	Time: {
		type: "string",
		pattern:
			"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$",
	},
	ProjectKey: {
		type: "string",
		pattern: "^[A-Z][A-Z0-9]{0,9}$",
	},
	Key: {
		type: "string",
		pattern: "^[A-Z][A-Z0-9]{0,9}-[1-9][0-9]*$",
	},
	QuestionId: {
		type: "string",
		pattern: "^Q[1-9][0-9]*$",
	},
	MilestoneName: {
		type: "string",
		pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$",
	},
	Status: {
		enum: ["backlog", "ready", "active", "blocked", "done", "cancelled"],
	},
	Priority: {
		enum: ["urgent", "high", "normal", "low"],
	},
	EventId: {
		type: "integer",
		minimum: 1,
	},
	Events: {
		type: "array",
		items: {
			$ref: "#/$defs/EventId",
		},
	},
	Project: {
		type: "object",
		additionalProperties: false,
		required: ["key", "name", "directory", "created_at"],
		properties: {
			key: {
				$ref: "#/$defs/ProjectKey",
			},
			name: {
				type: "string",
			},
			directory: {
				type: "string",
			},
			created_at: {
				$ref: "#/$defs/Time",
			},
		},
	},
	TaskRef: {
		type: "object",
		additionalProperties: false,
		required: ["key", "title", "status"],
		properties: {
			key: {
				$ref: "#/$defs/Key",
			},
			title: {
				type: "string",
			},
			status: {
				$ref: "#/$defs/Status",
			},
		},
	},
	TaskSummary: {
		type: "object",
		additionalProperties: false,
		required: [
			"key",
			"title",
			"status",
			"priority",
			"milestone",
			"parent",
			"holder",
			"ready",
			"created_at",
			"updated_at",
		],
		properties: {
			key: {
				$ref: "#/$defs/Key",
			},
			title: {
				type: "string",
			},
			status: {
				$ref: "#/$defs/Status",
			},
			priority: {
				$ref: "#/$defs/Priority",
			},
			milestone: {
				type: ["string", "null"],
			},
			parent: {
				oneOf: [
					{
						$ref: "#/$defs/Key",
					},
					{
						type: "null",
					},
				],
			},
			holder: {
				type: ["string", "null"],
			},
			ready: {
				type: "boolean",
			},
			created_at: {
				$ref: "#/$defs/Time",
			},
			updated_at: {
				$ref: "#/$defs/Time",
			},
		},
	},
	Task: {
		type: "object",
		additionalProperties: false,
		required: [
			"key",
			"title",
			"status",
			"priority",
			"milestone",
			"parent",
			"holder",
			"ready",
			"created_at",
			"updated_at",
			"body",
			"created_by",
			"waits",
			"waited_by",
			"children",
			"claim",
			"questions",
		],
		properties: {
			key: {
				$ref: "#/$defs/Key",
			},
			title: {
				type: "string",
			},
			status: {
				$ref: "#/$defs/Status",
			},
			priority: {
				$ref: "#/$defs/Priority",
			},
			milestone: {
				type: ["string", "null"],
			},
			parent: {
				oneOf: [
					{
						$ref: "#/$defs/Key",
					},
					{
						type: "null",
					},
				],
			},
			holder: {
				type: ["string", "null"],
			},
			ready: {
				type: "boolean",
			},
			created_at: {
				$ref: "#/$defs/Time",
			},
			updated_at: {
				$ref: "#/$defs/Time",
			},
			body: {
				type: "string",
			},
			created_by: {
				type: "string",
			},
			waits: {
				type: "array",
				items: {
					$ref: "#/$defs/TaskRef",
				},
			},
			waited_by: {
				type: "array",
				items: {
					$ref: "#/$defs/TaskRef",
				},
			},
			children: {
				type: "array",
				items: {
					$ref: "#/$defs/TaskRef",
				},
			},
			claim: {
				oneOf: [
					{
						$ref: "#/$defs/Claim",
					},
					{
						type: "null",
					},
				],
			},
			questions: {
				type: "array",
				items: {
					$ref: "#/$defs/Question",
				},
			},
		},
	},
	Claim: {
		type: "object",
		additionalProperties: false,
		required: [
			"key",
			"title",
			"holder",
			"since",
			"until",
			"minutes_left",
			"directory",
			"branch",
		],
		properties: {
			key: {
				$ref: "#/$defs/Key",
			},
			title: {
				type: "string",
			},
			holder: {
				type: "string",
			},
			since: {
				$ref: "#/$defs/Time",
			},
			until: {
				$ref: "#/$defs/Time",
			},
			minutes_left: {
				type: "integer",
				minimum: 0,
				maximum: 1440,
			},
			directory: {
				type: ["string", "null"],
			},
			branch: {
				type: ["string", "null"],
			},
		},
	},
	Option: {
		type: "object",
		additionalProperties: false,
		required: ["label", "detail"],
		properties: {
			label: {
				type: "string",
			},
			detail: {
				type: ["string", "null"],
			},
		},
	},
	Answer: {
		type: "object",
		additionalProperties: false,
		required: ["choice", "text", "by", "as", "at"],
		properties: {
			choice: {
				type: ["integer", "null"],
				minimum: 1,
			},
			text: {
				type: ["string", "null"],
			},
			by: {
				type: "string",
			},
			as: {
				enum: ["owner", "delegate"],
			},
			at: {
				$ref: "#/$defs/Time",
			},
		},
	},
	Question: {
		type: "object",
		additionalProperties: false,
		required: [
			"id",
			"key",
			"text",
			"options",
			"recommended",
			"asked_by",
			"asked_at",
			"status",
			"answer",
			"validated",
		],
		properties: {
			id: {
				$ref: "#/$defs/QuestionId",
			},
			key: {
				$ref: "#/$defs/Key",
			},
			text: {
				type: "string",
			},
			options: {
				type: "array",
				minItems: 2,
				maxItems: 6,
				items: {
					$ref: "#/$defs/Option",
				},
			},
			recommended: {
				type: "integer",
				minimum: 1,
				maximum: 6,
			},
			asked_by: {
				type: "string",
			},
			asked_at: {
				$ref: "#/$defs/Time",
			},
			status: {
				enum: ["open", "answered", "withdrawn"],
			},
			answer: {
				oneOf: [
					{
						$ref: "#/$defs/Answer",
					},
					{
						type: "null",
					},
				],
			},
			validated: {
				oneOf: [
					{
						type: "object",
						additionalProperties: false,
						required: ["by", "at"],
						properties: {
							by: {
								type: "string",
							},
							at: {
								$ref: "#/$defs/Time",
							},
						},
					},
					{
						type: "null",
					},
				],
			},
		},
	},
	Milestone: {
		type: "object",
		additionalProperties: false,
		required: ["name", "position", "delivers", "status", "tasks"],
		properties: {
			name: {
				$ref: "#/$defs/MilestoneName",
			},
			position: {
				type: "integer",
				minimum: 1,
			},
			delivers: {
				type: "string",
			},
			status: {
				enum: ["done", "current", "planned"],
			},
			tasks: {
				type: "object",
				additionalProperties: false,
				required: ["total", "done", "cancelled", "left"],
				properties: {
					total: {
						type: "integer",
						minimum: 0,
					},
					done: {
						type: "integer",
						minimum: 0,
					},
					cancelled: {
						type: "integer",
						minimum: 0,
					},
					left: {
						type: "integer",
						minimum: 0,
					},
				},
			},
		},
	},
	Place: {
		type: "object",
		additionalProperties: false,
		required: ["name", "position", "of", "left"],
		properties: {
			name: {
				$ref: "#/$defs/MilestoneName",
			},
			position: {
				type: "integer",
				minimum: 1,
			},
			of: {
				type: "integer",
				minimum: 1,
			},
			left: {
				type: "integer",
				minimum: 0,
			},
		},
	},
	Event: {
		type: "object",
		additionalProperties: false,
		required: [
			"id",
			"at",
			"actor",
			"kind",
			"project",
			"task",
			"milestone",
			"data",
		],
		properties: {
			id: {
				$ref: "#/$defs/EventId",
			},
			at: {
				$ref: "#/$defs/Time",
			},
			actor: {
				type: "string",
			},
			kind: {
				$ref: "#/$defs/Kind",
			},
			project: {
				oneOf: [
					{
						$ref: "#/$defs/ProjectKey",
					},
					{
						type: "null",
					},
				],
			},
			task: {
				oneOf: [
					{
						$ref: "#/$defs/Key",
					},
					{
						type: "null",
					},
				],
			},
			milestone: {
				type: ["string", "null"],
			},
			data: {
				type: "object",
			},
		},
	},
	Kind: {
		enum: [
			"board_created",
			"project_added",
			"project_edited",
			"project_removed",
			"task_added",
			"task_edited",
			"task_status",
			"task_moved",
			"waits_changed",
			"claimed",
			"claim_extended",
			"claim_released",
			"claim_expired",
			"comment",
			"handover",
			"question_asked",
			"question_answered",
			"question_validated",
			"question_withdrawn",
			"milestone_added",
			"milestone_edited",
			"milestone_deleted",
			"milestone_done",
			"milestone_reopened",
		],
	},
} as const;

// json-schema-to-ts resolves `#/$defs/…` only inside the schema that carries
// the $defs, so a shared shape is typed as a $ref with them beside it.
type Def<N extends keyof typeof defs> = FromSchema<{
	$ref: `#/$defs/${N}`;
	$defs: typeof defs;
}>;
export type Project = Def<"Project">;
export type TaskRef = Def<"TaskRef">;
export type TaskSummary = Def<"TaskSummary">;
export type Task = Def<"Task">;
export type Claim = Def<"Claim">;
export type Question = Def<"Question">;
export type Milestone = Def<"Milestone">;
export type Place = Def<"Place">;
export type Event = Def<"Event">;
export type Kind = Def<"Kind">;
export type Status = Def<"Status">;
export type Priority = Def<"Priority">;

/** Every refusal board makes, from every command, printed on stderr under --json. */
export const errorShape = {
	type: "object",
	additionalProperties: false,
	required: ["error"],
	properties: {
		error: {
			type: "object",
			additionalProperties: false,
			required: ["code", "message", "next", "details"],
			properties: {
				code: {
					enum: [
						"not_found",
						"claim_held",
						"not_claimed",
						"not_ready",
						"invalid_transition",
						"already_answered",
						"cycle",
						"invalid_argument",
						"busy",
						"storage",
						"no_board",
						"no_project",
						"project_exists",
						"damaged",
						"not_a_board",
						"schema_mismatch",
						"registry",
						"internal",
					],
				},
				message: {
					type: "string",
				},
				next: {
					type: "string",
				},
				details: {
					type: "object",
					additionalProperties: false,
					properties: {
						what: {
							enum: ["project", "task", "question", "milestone"],
						},
						id: {
							type: "string",
						},
						field: {
							type: "string",
						},
						reason: {
							type: "string",
						},
						from: {
							type: "string",
						},
						to: {
							type: "string",
						},
						allowed: {
							type: "array",
							items: {
								type: "string",
							},
						},
						path: {
							type: "array",
							items: {
								type: "string",
							},
						},
						claim: {
							$ref: "#/$defs/Claim",
						},
						task: {
							$ref: "#/$defs/TaskSummary",
						},
						question: {
							$ref: "#/$defs/Question",
						},
						project: {
							$ref: "#/$defs/Project",
						},
						projects: {
							type: "array",
							items: {
								$ref: "#/$defs/Project",
							},
						},
						cwd: {
							type: "string",
						},
						git: {
							enum: ["found", "not_a_repo", "missing", "failed"],
						},
						git_root: {
							type: ["string", "null"],
						},
						file: {
							type: "string",
						},
						sqlite: {
							type: "string",
						},
					},
				},
			},
		},
	},
	$defs: defs,
} as const;
export type ErrorBody = FromSchema<typeof errorShape>["error"];

/**
 * What `--json` prints, per command. `milestone ls`, `sql` and `watch`
 * are the exceptions as built: an array, rows, and a stream of events.
 */
export const outputs = {
	status: {
		type: "object",
		additionalProperties: false,
		required: [
			"project",
			"counts",
			"milestones",
			"current",
			"claims",
			"questions",
			"last_event",
		],
		properties: {
			project: {
				$ref: "#/$defs/Project",
			},
			counts: {
				type: "object",
				additionalProperties: false,
				required: [
					"backlog",
					"ready",
					"active",
					"blocked",
					"done",
					"cancelled",
				],
				properties: {
					backlog: {
						type: "integer",
						minimum: 0,
					},
					ready: {
						type: "integer",
						minimum: 0,
					},
					active: {
						type: "integer",
						minimum: 0,
					},
					blocked: {
						type: "integer",
						minimum: 0,
					},
					done: {
						type: "integer",
						minimum: 0,
					},
					cancelled: {
						type: "integer",
						minimum: 0,
					},
				},
			},
			milestones: {
				type: "array",
				items: {
					$ref: "#/$defs/Milestone",
				},
			},
			current: {
				oneOf: [
					{
						$ref: "#/$defs/Place",
					},
					{
						type: "null",
					},
				],
			},
			claims: {
				type: "array",
				items: {
					$ref: "#/$defs/Claim",
				},
			},
			questions: {
				type: "object",
				additionalProperties: false,
				required: ["open", "to_validate"],
				properties: {
					open: {
						type: "integer",
						minimum: 0,
					},
					to_validate: {
						type: "integer",
						minimum: 0,
					},
				},
			},
			last_event: {
				type: "integer",
				minimum: 0,
			},
		},
		$defs: defs,
	},
	ls: {
		type: "object",
		additionalProperties: false,
		required: ["project", "tasks", "total", "next_offset"],
		properties: {
			project: {
				oneOf: [
					{
						$ref: "#/$defs/ProjectKey",
					},
					{
						const: "*",
					},
				],
			},
			tasks: {
				type: "array",
				items: {
					$ref: "#/$defs/TaskSummary",
				},
			},
			total: {
				type: "integer",
				minimum: 0,
			},
			next_offset: {
				type: ["integer", "null"],
				minimum: 0,
			},
		},
		$defs: defs,
	},
	show: {
		type: "object",
		additionalProperties: false,
		required: ["task", "events", "cursor", "more"],
		properties: {
			task: {
				$ref: "#/$defs/Task",
			},
			events: {
				type: "array",
				maxItems: 200,
				items: {
					$ref: "#/$defs/Event",
				},
			},
			cursor: {
				type: "integer",
				minimum: 0,
			},
			more: {
				type: "boolean",
			},
		},
		$defs: defs,
	},
	next: {
		type: "object",
		additionalProperties: false,
		required: ["project", "task", "from", "milestone", "waiting"],
		properties: {
			project: {
				$ref: "#/$defs/ProjectKey",
			},
			task: {
				oneOf: [
					{
						$ref: "#/$defs/TaskSummary",
					},
					{
						type: "null",
					},
				],
			},
			from: {
				enum: ["current", "unassigned", "later", "milestone", null],
			},
			milestone: {
				oneOf: [
					{
						$ref: "#/$defs/Place",
					},
					{
						type: "null",
					},
				],
			},
			waiting: {
				type: "object",
				additionalProperties: false,
				required: ["blocked", "active", "waits_open"],
				properties: {
					blocked: {
						type: "integer",
						minimum: 0,
					},
					active: {
						type: "integer",
						minimum: 0,
					},
					waits_open: {
						type: "integer",
						minimum: 0,
					},
				},
			},
		},
		$defs: defs,
	},
	add: {
		type: "object",
		additionalProperties: false,
		required: ["task", "events"],
		properties: {
			task: {
				$ref: "#/$defs/Task",
			},
			events: {
				$ref: "#/$defs/Events",
			},
		},
		$defs: defs,
	},
	edit: {
		type: "object",
		additionalProperties: false,
		required: ["task", "changed", "events"],
		properties: {
			task: {
				$ref: "#/$defs/Task",
			},
			changed: {
				type: "array",
				uniqueItems: true,
				items: {
					enum: [
						"title",
						"body",
						"priority",
						"status",
						"parent",
						"milestone",
						"waits",
					],
				},
			},
			events: {
				$ref: "#/$defs/Events",
			},
		},
		$defs: defs,
	},
	claim: {
		type: "object",
		additionalProperties: false,
		required: ["claim", "task", "events"],
		properties: {
			claim: {
				$ref: "#/$defs/Claim",
			},
			task: {
				$ref: "#/$defs/TaskSummary",
			},
			events: {
				$ref: "#/$defs/Events",
			},
		},
		$defs: defs,
	},
	extend: {
		type: "object",
		additionalProperties: false,
		required: ["claim", "events"],
		properties: {
			claim: {
				$ref: "#/$defs/Claim",
			},
			events: {
				$ref: "#/$defs/Events",
			},
		},
		$defs: defs,
	},
	release: {
		type: "object",
		additionalProperties: false,
		required: ["task", "released", "events"],
		properties: {
			task: {
				$ref: "#/$defs/TaskSummary",
			},
			released: {
				$ref: "#/$defs/Claim",
			},
			events: {
				$ref: "#/$defs/Events",
			},
		},
		$defs: defs,
	},
	comment: {
		type: "object",
		additionalProperties: false,
		required: ["event", "events"],
		properties: {
			event: {
				$ref: "#/$defs/Event",
			},
			events: {
				$ref: "#/$defs/Events",
			},
		},
		$defs: defs,
	},
	handover: {
		type: "object",
		additionalProperties: false,
		required: ["event", "events"],
		properties: {
			event: {
				$ref: "#/$defs/Event",
			},
			events: {
				$ref: "#/$defs/Events",
			},
		},
		$defs: defs,
	},
	ask: {
		type: "object",
		additionalProperties: false,
		required: ["question", "task", "events"],
		properties: {
			question: {
				$ref: "#/$defs/Question",
			},
			task: {
				$ref: "#/$defs/TaskSummary",
			},
			events: {
				$ref: "#/$defs/Events",
			},
		},
		$defs: defs,
	},
	answer: {
		type: "object",
		additionalProperties: false,
		required: ["question", "task", "events"],
		properties: {
			question: {
				$ref: "#/$defs/Question",
			},
			task: {
				$ref: "#/$defs/TaskSummary",
			},
			events: {
				$ref: "#/$defs/Events",
			},
		},
		$defs: defs,
	},
	validate: {
		type: "object",
		additionalProperties: false,
		required: ["question", "events"],
		properties: {
			question: {
				$ref: "#/$defs/Question",
			},
			events: {
				$ref: "#/$defs/Events",
			},
		},
		$defs: defs,
	},
	questions: {
		type: "object",
		additionalProperties: false,
		required: ["project", "questions"],
		properties: {
			project: {
				oneOf: [
					{
						$ref: "#/$defs/ProjectKey",
					},
					{
						const: "*",
					},
				],
			},
			questions: {
				type: "array",
				items: {
					$ref: "#/$defs/Question",
				},
			},
		},
		$defs: defs,
	},
	"milestone add": {
		type: "object",
		additionalProperties: false,
		required: ["project", "milestone", "chain", "events"],
		properties: {
			project: {
				$ref: "#/$defs/ProjectKey",
			},
			milestone: {
				$ref: "#/$defs/Milestone",
			},
			chain: {
				type: "array",
				items: {
					$ref: "#/$defs/MilestoneName",
				},
			},
			events: {
				$ref: "#/$defs/Events",
			},
		},
		$defs: defs,
	},
	"milestone edit": {
		type: "object",
		additionalProperties: false,
		required: ["project", "milestone", "chain", "changed", "events"],
		properties: {
			project: {
				$ref: "#/$defs/ProjectKey",
			},
			milestone: {
				$ref: "#/$defs/Milestone",
			},
			chain: {
				type: "array",
				items: {
					$ref: "#/$defs/MilestoneName",
				},
			},
			changed: {
				type: "array",
				uniqueItems: true,
				items: {
					enum: ["name", "delivers", "position"],
				},
			},
			events: {
				$ref: "#/$defs/Events",
			},
		},
		$defs: defs,
	},
	"milestone rm": {
		type: "object",
		additionalProperties: false,
		required: ["project", "deleted", "chain", "events"],
		properties: {
			project: {
				$ref: "#/$defs/ProjectKey",
			},
			deleted: {
				$ref: "#/$defs/MilestoneName",
			},
			chain: {
				type: "array",
				items: {
					$ref: "#/$defs/MilestoneName",
				},
			},
			events: {
				$ref: "#/$defs/Events",
			},
		},
		$defs: defs,
	},
	"project add": {
		type: "object",
		additionalProperties: false,
		required: ["key", "name", "directory", "created_at"],
		properties: {
			key: {
				$ref: "#/$defs/ProjectKey",
			},
			name: {
				type: "string",
			},
			directory: {
				type: "string",
			},
			created_at: {
				$ref: "#/$defs/Time",
			},
		},
		$defs: defs,
	},
	"project edit": {
		type: "object",
		additionalProperties: false,
		required: ["key", "name", "directory", "created_at"],
		properties: {
			key: {
				$ref: "#/$defs/ProjectKey",
			},
			name: {
				type: "string",
			},
			directory: {
				type: "string",
			},
			created_at: {
				$ref: "#/$defs/Time",
			},
		},
		$defs: defs,
	},
	"project rm": {
		type: "object",
		additionalProperties: false,
		required: ["key", "name", "directory", "created_at"],
		properties: {
			key: {
				$ref: "#/$defs/ProjectKey",
			},
			name: {
				type: "string",
			},
			directory: {
				type: "string",
			},
			created_at: {
				$ref: "#/$defs/Time",
			},
		},
		$defs: defs,
	},
	"project ls": {
		type: "object",
		additionalProperties: false,
		required: ["projects", "here"],
		properties: {
			projects: {
				type: "array",
				items: {
					type: "object",
					additionalProperties: false,
					required: ["project", "open", "closed", "current"],
					properties: {
						project: {
							$ref: "#/$defs/Project",
						},
						open: {
							type: "integer",
							minimum: 0,
						},
						closed: {
							type: "integer",
							minimum: 0,
						},
						current: {
							oneOf: [
								{
									$ref: "#/$defs/Place",
								},
								{
									type: "null",
								},
							],
						},
					},
				},
			},
			here: {
				oneOf: [
					{
						$ref: "#/$defs/ProjectKey",
					},
					{
						type: "null",
					},
				],
			},
		},
		$defs: defs,
	},
} as const;
export type Command = keyof typeof outputs;
export type Output<C extends Command> = FromSchema<(typeof outputs)[C]>;
export type ProjectList = Output<"project ls">;
