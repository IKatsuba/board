# Interfaces on Bun: the MCP server, the CLI, tables

Draft by `interfaces` for the topic `bun`. It answers the brief's
"interfaces" questions with what was tried on this machine (macOS, Bun
1.4.3), and proposes the text that replaces the Dart names in
`docs/design.md` and the library lines of decisions 7, 13, 17 and 18.

## In short

- **MCP: `@modelcontextprotocol/server` and `@modelcontextprotocol/client`
  2.3.1** (the SDK's v2 line, stable, spec 2026-07-28). Its
  `fromJsonSchema()` registers a plain JSON Schema as a tool's input and
  output schema, validated by the Ajv it bundles, in JSON Schema 2020-12 when
  the schema declares no `$schema`. All 17 tools of Appendix B, the `project
  ls` shape and the error shape compile as they are. Appendix B does not
  change. v1 (`@modelcontextprotocol/sdk` 1.32.1) takes Zod only and is not
  usable without rewriting every schema.
- **Decision 13 holds.** board's refusals keep `{error: {code, message,
  next, details}}` with `isError: true`; the SDK's input refusals stay in the
  SDK's shape (`isError: true`, text only). Two details move, named below:
  an output that does not match its schema is no longer a protocol error but
  a text-only `isError` result, and a thrown handler is the same, so board
  must catch everything to answer `internal`.
- **CLI: `@cliffy/command` 1.3.1** (the owner's choice; JSR, installed
  through `npm.jsr.io`). Under Bun it needs no shim: its runtime layer falls
  back to `process` / `node:*` when `Deno` is absent. Nested commands,
  comma-split lists with allowed values (natively), `conflicts`, `required`,
  `depends`, `help [command]`, and exit 64 through `.throwErrors()` and one
  `catch`. It works in a `bun build --compile` binary and in process under
  `bun test` with `.noExit()`. `commander` 15.0.0 met the same list with two
  checks of ours more; it stays in the draft as the option compared.
- **Tables: `@cliffy/table` 1.3.1** (already a dependency of
  `@cliffy/command`), borderless, in place of `cli-table3` 0.6.5, which gave
  the same output. Both count terminal cells, so wide characters align, and a
  newline in a cell continues in its column.
- **No change to the tool or CLI surface is forced.** One small one is
  proposed: `board COMMAND SUBCOMMAND --help` documented beside `board help
  [COMMAND]`, because `help` reaches one level (in both libraries).
- **One defect found in Appendix B, not caused by a package:** the error
  shape's `details` declared `path` twice (an array for `cycle`, a string for
  `no_board`). The lead accepted renaming `no_board`'s to `file` (section 7).

## 1. The MCP server

### What was tried

All in `/tmp/bun-ifc` (scratch, outside the repository), Bun 1.4.3.

| Package | Version | Result |
| --- | --- | --- |
| `@modelcontextprotocol/sdk` (v1) | 1.32.1 | `registerTool` with a JSON Schema object throws `inputSchema must be a Zod schema or raw shape, received an unrecognized object`. Zod cannot say `if`/`then`/`else`, `not`, `minProperties` or `uniqueItems` in the schema it advertises (a `.refine` validates but is not in `tools/list`), so Appendix B would not survive. Rejected. |
| `@modelcontextprotocol/server` (v2) | 2.3.1 | Chosen. `fromJsonSchema(schema)` returns a Standard Schema with JSON; `registerTool(name, {inputSchema, outputSchema, annotations, description}, cb)` advertises the schema as given and validates with Ajv 8.18 (bundled; `ajv` is not a dependency we add). Depends on `zod` ^4.2 and `@modelcontextprotocol/core`, which we do not use directly. |
| `@modelcontextprotocol/client` (v2) | 2.3.1 | The test client, over `InMemoryTransport.createLinkedPair()` (exported by the server package); and `StdioClientTransport` for the binary's smoke test. |
| `json-schema-to-ts` | 3.1.1 | `FromSchema<typeof schema>` over an `as const` schema with `$defs`/`$ref`, `oneOf` with `null`, `["integer", "null"]` and `enum`: correct types under TypeScript 7.0.2 `--strict` (two deliberate mistakes in the probe were the only two errors). Proposed for handler argument and result types, so the schema is the one source. Last release 2024-08. |

Probes (scratch, not kept): `probes/mcp-v2.ts` (validation cases),
`probes/mcp-none.ts` (decision 7), `probes/mcp-v1.ts`, `probes/appendix-b.ts`
(every schema of Appendix B, read from `docs/design.md` and compiled),
`probes/stdio-server.ts` with `probes/stdio-client.ts` and
`probes/stdio-client-v1.ts` (the server compiled with `bun build --compile`
and driven over stdio), `probes/types.ts` (`json-schema-to-ts`).

### What happened

Every case below is a `client.callTool` through the in-process transport
unless it says stdio.

| Case | Result |
| --- | --- |
| Valid arguments | the handler gets the validated object, unchanged (`brd-1` stays lower case; upper-casing is board's) |
| Pattern refused (`key: "BRD"`) | `{"content":[{"type":"text","text":"Input validation error: Invalid arguments for tool task_comment: data/key must match pattern \"^[A-Za-z]…$\""}],"isError":true}` |
| `additionalProperties` | `… data must NOT have additional properties` (does not name the extra property) |
| `if`/`then` (handover missing `to`, `changed`, `ran`, `unchecked`) | refused; each missing property named |
| `else`/`not` (a note with `to`) | refused: `data must NOT be valid, data must match "else" schema`; the field is not named |
| `anyOf` (`question_answer` with neither `choice` nor `text`; `milestone_update` with nothing to change) | refused, each alternative named |
| `not: {required: [before, after]}` | refused: `data must NOT be valid` |
| `minProperties: 3` (`task_update`) | refused: `data must NOT have fewer than 3 properties` |
| `uniqueItems` (`status: ["ready","ready"]`) | refused, items named |
| `oneOf [ProjectKeyIn, const "*"]` | `"brd"` and `"*"` both accepted |
| `parent: null` against `oneOf [KeyIn, null]` | accepted |
| Output that does not fit its schema | **not a protocol error**: `{"content":[{"type":"text","text":"Output validation error: Invalid structured content for tool task_list: data/project must match pattern …"}],"isError":true}` |
| A board refusal (`isError: true` with `structuredContent.error`) | passed through as returned; the output schema is not applied |
| The handler throws | `{"content":[{"type":"text","text":"boom"}],"isError":true}`: the exception's message, text only |
| `annotations` | advertised as given in `tools/list` |
| `tools/list` | the input schema as registered: `$defs`, `if`/`then`/`else` kept |
| Dialect | a schema without `$schema` is 2020-12 (`dialects.ts`: "No `$schema` … means 2020-12"); 2019-09, draft-07 and draft-06 are accepted when declared, anything else throws at registration |
| Compiled with `bun build --compile`, over stdio | works (Ajv's generated code runs in the binary); 71.6 MB for the probe, which is runtime's to judge |
| Older clients over stdio | v1 SDK client: works. Raw `initialize` with `2025-06-18` and `2024-11-05`: the server answers that version |
| stdin closed | the transport's `onclose` fires and the probe process exits (runtime owns the exit rule) |
| Appendix B, all 17 tools' input and output, the `project ls` shape, the error shape | every one compiles with `fromJsonSchema`, no edit |

### Decision 7: `milestone: "none"`

The same probe as with `mcp_dart`: `oneOf [the name pattern, const "none"]`
refuses `"none"` (`data/milestone must match exactly one schema in oneOf`),
because `none` matches both branches. That is JSON Schema's own `oneOf`, not
a package's quirk, so the reason holds for any validator. Appendix B already
uses the pattern alone (`MilestoneRef`), with `none` meaning no milestone and
the store refusing it as a name; that stays. `"NONE"` with `project: "*"`
reaches the handler, as the design expects (`none`, any case).

### Decision 13: does the shape hold

Yes, with three details to write down.

1. **The SDK's input refusal is text only**, `isError: true`, text beginning
   `Input validation error: Invalid arguments for tool <name>:` followed by
   Ajv's messages. That is the shape decision 13 accepted from `mcp_dart`.
   The field is named for `required`, `pattern`, `enum`, `type`, `minLength`
   and the like; it is **not** named for `not`, `else` or
   `additionalProperties` (Ajv says `data must NOT be valid` / `must NOT have
   additional properties`). The tools where that bites are `task_comment` (a
   note with handover fields), `milestone_add` / `milestone_update` (both
   `before` and `after`) and any extra property; their descriptions already
   say what they accept, and the proposed description sentence below says
   what an unnamed refusal means.
2. **An output that misses its schema is an `isError` text-only result**
   (`Output validation error: …`), where `mcp_dart` raised a protocol error.
   Either way it is a bug in board. To the agent it now looks like a schema
   refusal, so the tool description says how to tell them apart.
3. **A thrown handler is an `isError` text-only result** carrying the
   exception's message. The design already wants every exception in board's
   code caught, rolled back and answered as `internal`; with this SDK that
   catch is what keeps the error shape, so every handler goes through one
   wrapper (`src/mcp/` registers tools through it; runtime's layout). A test
   makes a rule throw and checks `structuredContent.error.code ==
   "internal"`.

The description sentence of Appendix B ("A refusal without
`structuredContent` means the arguments do not fit this tool's schema; the
text names the field.") becomes:

> A refusal without `structuredContent` comes from the MCP library, not from
> board: text starting `Input validation error` means the arguments do not
> fit this tool's schema, and names the field where it can; text starting
> `Output validation error` is a bug in board, to report.

### Do Appendix B's schemas survive

As they are. They are written as `as const` TypeScript objects in one module,
used three ways: registered through `fromJsonSchema`, turned into handler
types by `json-schema-to-ts`, and used by the tests to validate the CLI's
`--json` output (the same `fromJsonSchema(…)["~standard"].validate`, so no
second validator). Each registered schema carries the `$defs` it refers to,
as the design says now. No `$schema` keyword is written: 2020-12 is the
default.

### In-process tests

`InMemoryTransport.createLinkedPair()` from `@modelcontextprotocol/server`,
with `Client` from `@modelcontextprotocol/client`, replaces `mcp_dart`'s
`IOStreamTransport`. The server is built by the same function `board mcp`
uses, given the store and the injected clock, and connected to one end.

### Notes for runtime

- The SDK dispatches each `tools/call` to its async handler as it arrives;
  two calls from one agent can run interleaved unless board serialises them
  (brief, runtime question 3).
- Ajv compiles validators with `new Function`. It ran in the compiled,
  unsigned binary; under the hardened runtime it needs whatever Bun's JIT
  already needs (runtime question 2), nothing more was observed.

## 2. The CLI

The owner named cliffy. It was tried under Bun against the same list
commander was; commander's results stay below as the option compared.

### What was tried

cliffy is published on JSR. `bunx jsr add @cliffy/command@1.3.1
@cliffy/table@1.3.1` installed it through JSR's npm-compatible registry
(`npm.jsr.io`): `package.json` gets `"@cliffy/command":
"npm:@jsr/cliffy__command@1.3.1"`, and `.npmrc` gets
`@jsr:registry=https://npm.jsr.io`. That `.npmrc` line is the one thing the
build needs (runtime, release); the user installs nothing, since the CLI is
bundled into the binary. `@cliffy/command` pulls `@cliffy/flags`,
`@cliffy/internal`, `@cliffy/table`, `@cliffy/upgrade` and five `@std`
packages, all 1.x. 1.3.1 was published 2026-09-18.

| Candidate | Version | Nested commands | Repeatable + comma-split | Allowed values | Conflicts / required / depends | Unknown option or command | `help [COMMAND]` | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `@cliffy/command` | 1.3.1 | yes: a `Command` mounted with `.command("project", project)`; `project add`, `milestone edit` | **native**: a list type `<S:status[]>` splits on commas; `collect: true` makes it repeatable, giving one array per occurrence, which the documented `value` hook flattens | `EnumType`, checked per list item | `conflicts`, `required`, and `depends` (`--exec` needs `--follow`) natively | usage error, with a suggestion ("Did you mean option `--status`?") | `HelpCommand`, one level, and `.global()` puts it under each group (`board project help add`) | **chosen (owner)** |
| `commander` | 15.0.0 | yes (`project add`, `milestone` with `ls` as `isDefault`) | repeatable through `argParser`; comma-split in that parser | `.choices()`; with comma-split, checked in the same parser, refused with `InvalidArgumentError` | `.conflicts()`, `.requiredOption()` checked at parse; no "depends" | usage error | built in, one level | compared |
| `yargs` | 18.2.0 | yes | `type: "array"` + `coerce` for the split | `choices`, checked after `coerce` | `conflicts`; `demandOption` | usage error with `.strict()` | none: `board help ls` is `Unknown argument: help`; adds camel and kebab aliases to every option (`KEY` arrives also as `K-e-y`) | rejected |
| `citty` | 0.2.2 | yes | no: the last `--status` wins | `enum`, one value | none | unknown options accepted | no `help` command | rejected |
| `cac` | 7.1.0 | no: `project add` registered as a name never matches, and nothing runs | repeatable, no split | none | none | an unknown option ends in an uncaught exception, exit 1 | `--help` only | rejected |
| `node:util` `parseArgs` (Bun built-in) | Bun 1.4.3 | none | `multiple: true`, no split | none | none | throws `ERR_PARSE_ARGS_UNKNOWN_OPTION` | none | rejected: the dispatcher, help and checks would be ours |

Probes (scratch): `/tmp/bun-cliffy/probes/cli.ts` (the command tree),
`inproc.test.ts` (`bun test`, in process), `types.ts` (TypeScript),
`table.ts`; `/tmp/bun-ifc/probes/cli-commander.ts`, `cli-yargs.ts`,
`cli-citty.ts`, `cli-cac.ts`.

### Deno APIs under Bun

cliffy reaches the runtime only through `@cliffy/internal/runtime/*`, one
small function per call, each of which branches on `globalThis.Deno` and
otherwise uses `process` / `node:*` (and `Bun.isStandaloneExecutable` for
"is this a compiled binary"). Under Bun every path the CLI uses takes the
Node branch: `exit` → `process.exit`, `getNoColor` → `NO_COLOR` /
`NODE_DISABLE_COLORS`, `getColumns` → `process.stdout.columns`, `getEnv` →
`process.env`. `hasPermission` answers `true` without `Deno`. No shim or
polyfill was needed, and nothing threw `unsupported runtime`. The Deno-only
helpers (`chmod`, `rename`, `writeFile`, …) serve `@cliffy/command/upgrade`,
which board does not import.

### What cliffy did

The probe's root is `new Command().name("board").throwErrors()`, with one
`try`/`catch` around `parse` that prints `board: ` + the message to stderr
and exits 64 on a `ValidationError`, and rethrows anything else.

```
$ board ls -p BRD --status ready,blocked --status done --limit 5
  → {project: "BRD", status: [["ready","blocked"],["done"]], limit: 5}   (flattened by `value`)
$ board ls --status ready,bogus          exit 64
board: Option "--status" must be of type "status", but got "bogus". Expected values: "backlog", "ready", "active", "blocked", "done", "cancelled"
$ board ls -p BRD --all                  exit 64
board: Option "--project" conflicts with option "--all".
$ board ls --limit x                     exit 64
board: Option "--limit" must be of type "integer", but got "x".
$ board ls --limit 0                     exit 64   (range in `value`, throwing ValidationError)
$ board milestone add v2 --before v1 --after v3 --delivers x    exit 64
board: Option "--before" conflicts with option "--after".
$ board milestone add v2                 exit 64
board: Missing required option "--delivers".
$ board milestone / board milestone -p BRD / board milestone ls -p BRD
  → milestone ls, {} / {project: "BRD"} / {project: "BRD"}
$ board milestone edit v2 --name v3 -p BRD   → ["v2"], {name: "v3", project: "BRD"}
$ board answer Q7 2 / board answer Q7    → ["Q7", 2] (`[N:integer]`) / ["Q7"]
$ board watch -f -p BRD,APP -p X --kind claimed,claim_expiring
  → {follow: true, project: [["BRD","APP"],["X"]], kind: [["claimed","claim_expiring"]]}
$ board watch --kind nope                exit 64, the kinds listed
$ board watch --exec echo                exit 64
board: Option "--exec" depends on option "--follow".
$ board sql "SELECT a,b FROM t"          → ["SELECT a,b FROM t"]   (a string argument is not split)
$ board bogus                            exit 64
board: Unknown command "bogus". Did you mean command "ls"?
$ board ls --bogus                       exit 64
board: Unknown option "--bogus". Did you mean option "--status"?
$ board help ls                          ls's help on stdout, exit 0
$ board help project                     project's commands, exit 0
$ board help project add                 exit 64: Too many arguments: add
$ board project help add / board project add --help    add's help, exit 0
$ board project                          project's help on stdout, exit 0
```

The same tree compiled with `bun build --compile` (71.0 MB for the probe)
gave the same answers, run directly, as a copy and through a symlink.

### Mapping onto the design

- **Nested commands**: each group (`project`, `milestone`) is its own
  `Command`, mounted on the root. `board milestone` with no subcommand runs
  the group's own action, which is `milestone ls`'s; `-p` is declared on both.
- **Comma-split and repeatable** (`ls --status`, `watch -p`, `--kind`,
  `--task`): a list type with `collect: true` and `value: (v, prev = []) =>
  [...prev, ...v]`. The split and the per-item check are cliffy's; `value` is
  its documented hook for an option's value. This also settles the lead's
  earlier comma-split call (commander's `argParser`) without any parsing of
  ours.
- **Allowed values**: `EnumType` per list (`status`, `kind`, `state`); the
  error lists the values, as the design wants for `--kind`.
- **Per-command `-p`**: options belong to the command that declares them, as
  with `args` and commander. A `globalOption` exists but is not used, so `-p`
  is not offered where no project applies.
- **Conflicts, required, depends**: `conflicts: ["all"]`, `conflicts:
  ["after"]`, `required: true`, `depends: ["follow"]`, all checked at parse.
  commander needed a check of ours for `--exec` without `--follow`; cliffy
  does not.
- **Numbers**: `<N:integer>` refuses a non-integer; ranges (`--limit` 1–200,
  `--exec-timeout`) are checked in `value`, throwing cliffy's
  `ValidationError` so they leave as usage errors.
- **Exit 64**: cliffy's default for a `ValidationError` is to print the help
  to **stdout**, the error in red to stderr, and exit 2. board uses
  `.throwErrors()` (documented: "throw validation errors instead of calling
  `exit()`") and one `catch` at the entry point: `board: <message>` on
  stderr, exit 64; any other error is board's own and is handled as now. So
  usage errors never put the help on stdout.
- **Output**: actions write data to stdout and notes to stderr through the
  sinks board gives them, as now. cliffy's own output is the help and version
  text, printed with `console.log` (stdout); errors are thrown, not printed,
  under `throwErrors`. There is no sink option for the help.
- **Colour**: the help uses ANSI colour whenever `NO_COLOR` is unset, also
  when stdout is a file (14 escape sequences in a redirected `board help
  ls`). `.help({colors: process.stdout.isTTY === true})` on the root turns it
  off when piped (0 escapes) and keeps it in a terminal (14 under `script`).
- **Help**: `board help [COMMAND]` is `HelpCommand`, mounted `.global()` so
  each group has its own `help`. As with commander it reaches one level:
  `board help project add` is a usage error, and the leaf's help is `board
  project help add` or `board project add --help`. `board help sql` carries
  the "narrows, does not wall off" text in the command's long description.
- **A bare group** (`board`, `board project`) prints its help and exits 0,
  cliffy's auto-help. That drops my earlier proposal of 64 for it, which no
  owner decision asked for.
- **Types**: option and argument types are inferred from the flag strings
  (`<N:integer>` → `number | undefined`, `<S:status[]>` with `value` →
  the enum's array); TypeScript 7.0.2 `--strict` caught the probe's one
  deliberate mistake and nothing else.

### In-process tests

`bun test` against a `Command` built by the same function the entry point
uses, given the sinks: `.noExit()` (which also throws errors) keeps the
test process alive through help and errors; `await cmd.parse(argv)` runs the
action, which writes into the injected sinks; a usage error rejects with
`ValidationError` and prints nothing; the help text is read from
`console.log` with `spyOn` (or from `cmd.getHelp()`). Three probe tests
passed (`inproc.test.ts`: parse into a sink, a usage error thrown with
nothing printed, help read through `console.log`).

### commander, compared

commander 15.0.0 met the same list with three differences: comma-split took
an `argParser` of ours (five lines, the package's documented hook), `--exec`
needing `--follow` took a check of ours, and its error output needed
`configureOutput` for the `board: ` prefix. It writes help to stderr on a bare
group and has no colour. Its results, for the record:

```
$ board ls -p BRD --status ready,blocked --status done --limit 5
  → {project: "BRD", status: ["ready","blocked","done"], limit: 5}
$ board ls --status ready,bogus          exit 64
error: option '--status <S,...>' argument 'ready,bogus' is invalid. Allowed: backlog, ready, active, blocked, done, cancelled.
$ board ls -p BRD --all                  exit 64
error: option '-p, --project <KEY>' cannot be used with option '--all'
$ board milestone add v2 --before v1 --after v3 --delivers x    exit 64
error: option '--before <NAME>' cannot be used with option '--after <NAME>'
$ board milestone add v2                 exit 64
error: required option '--delivers <TEXT>' not specified
$ board help project add                 project's help (its subcommands), exit 0
$ board project add --help               add's help, exit 0
```

with this parser for the lists:

```ts
const list = (allowed?: readonly string[]) => (v: string, prev: string[] = []) => {
  const items = v.split(",").filter(Boolean);
  for (const i of items)
    if (allowed && !allowed.includes(i)) throw new InvalidArgumentError(`Allowed: ${allowed.join(", ")}.`);
  return [...prev, ...items];
};
```

## 3. Tables

Both `@cliffy/table` 1.3.1 and `cli-table3` 0.6.5 were tried on the same
rows; their output is the same, byte for byte apart from the configuration:

```
KEY    TITLE             STATUS
BRD-1  plain             ready
BRD-2  日本語のタイトル  active
BRD-3  emoji 🚀 here     done
BRD-4  two               ready
       lines
```

- `@cliffy/table`: `new Table().header([...]).body(rows).border(false)
  .padding(2).indent(0)`. Every line is 31 cells by `Bun.stringWidth`: it
  counts terminal cells (its own `unicodeWidth`, a copy of `@std/cli`'s). A
  newline in a cell continues in its column. No escape sequences. It pads
  the last column with spaces, as `cli-table3` does.
- `cli-table3`: the same, through `string-width` 4, with every border
  character set to `""`.

**Proposal: `@cliffy/table` replaces `cli-table3`.** `@cliffy/command`
already depends on it (it draws the help with it), so it costs no dependency,
while `cli-table3` is one more package whose last release was 2024-05.

Values are formatted before they reach the table (`NULL`, blobs as hex for
`board sql`); that is board's, as now.

## 4. Changes to the surface

None is forced by a package. Named, in order of weight:

1. **Help for a subcommand**: `board help project` lists `project`'s
   commands; the help of `project add` is `board project help add` or
   `board project add --help`. The usage block gains `board COMMAND
   [SUBCOMMAND] --help`. Same under cliffy and commander.
2. **The tool description's sentence** on text-only refusals, above.

A bare `board` or `board project` prints its help and exits 0 (cliffy's
behaviour; no change asked).

## 5. Proposed text for `docs/design.md`

- **"The MCP server", first paragraph:** "through `package:mcp_dart`" →
  "through `@modelcontextprotocol/server` (the TypeScript SDK's v2), with
  every tool's schemas registered as JSON Schema through `fromJsonSchema`".
- **Conventions, "Every result":** "because `mcp_dart` validates every
  successful result against them" → "because the SDK validates every
  successful result against them; a mismatch reaches the agent as a
  text-only `isError` result starting `Output validation error`, and is a
  bug in board".
- **Errors, the last paragraph:** "`mcp_dart` refuses them before board's
  code runs, in its own shape (text only, no `structuredContent`)" → "the SDK
  refuses them before board's code runs, in its own shape (`isError: true`,
  text only, starting `Input validation error`)". Add: "Every handler runs
  inside one wrapper that turns any exception into `internal`, because the SDK
  answers a thrown exception with its message as text only."
- **"The CLI":** "Built on `package:args` (`CommandRunner<int>`)" → "Built on
  `@cliffy/command`: one root `Command` with `throwErrors()`, the groups
  `project` and `milestone` as `Command`s mounted on it, and one `catch` at
  the entry point that prints a usage error as `board: <message>` on stderr
  and exits 64. Lists (`--status`, `--kind`, `watch -p`, `--task`) are
  cliffy list types, split on commas and checked per item by an
  `EnumType`." "`-p` is declared per command: on the runner's own parser it
  would be accepted only before the command name" → "`-p` is declared per
  command, not as a global option, so it is offered only where a project
  applies." The tables bullet → "Tables are `@cliffy/table`'s, without
  borders; they count terminal cells." Add the `--help` line to the usage
  block, and: "The help is coloured only when stdout is a terminal."
- **Appendix B, first paragraph:** "`mcp_dart` validates every successful
  result" → "the SDK validates every successful result (Ajv, 2020-12, the
  default when no `$schema` is given)". The `MilestoneRef` note: "(see "What
  was checked")" stays; the probe is repeated under the new SDK with the same
  result.
- **Appendix B, Errors:** the description sentence above.
- **Tests:** "`mcp_dart`'s client over an in-process transport" →
  "`@modelcontextprotocol/client` over `InMemoryTransport.createLinkedPair()`".
  Schemas, handler types and the `--json` checks share one module of `as
  const` schemas (`json-schema-to-ts` for the types).

## 6. Proposed library lines for `docs/decisions.md`

**7.** `@modelcontextprotocol/server` 2.3.1, probed in process: a
`oneOf [name pattern, const "none"]` input refused the literal `"none"`,
because it matches both, as `package:mcp_dart` 2.4.2 did before; it is JSON
Schema's `oneOf`, not a package's quirk. The input is the name pattern
alone, with `none` meaning "no milestone"; the store refuses `none` as a
name.

**13.** `@modelcontextprotocol/server` and `@modelcontextprotocol/client`
2.3.1, tried in process and over stdio from a `bun build --compile` binary:
tool schemas registered as JSON Schema through `fromJsonSchema` (bundled Ajv
8.18, 2020-12 by default); input validated before the callback (`required`,
`pattern`, `enum`, `if`/`then`/`else`, `not`, `anyOf`, `minProperties`,
`uniqueItems`); a refusal is `isError: true`, text only, starting `Input
validation error` (the field is not named for `not`, `else` and
`additionalProperties`); an output that does not match its schema is a
text-only `isError` result starting `Output validation error`; `isError`
results skip output validation; a thrown handler is a text-only `isError`
result, so board catches every exception as `internal`;
`InMemoryTransport.createLinkedPair()` is the in-process transport for
tests. `@modelcontextprotocol/sdk` 1.32.1 (v1) was tried and refused: it
registers Zod schemas only, which cannot advertise Appendix B's schemas.

**17.** `@cliffy/command` 1.3.1: the `project` command group as the
`milestone` one is, each a `Command` mounted on the root.

**18.** Title: "The CLI is `@cliffy/command`; tables through
`@cliffy/table`" (owner: cliffy). Choice: one root `Command` with
`throwErrors()` and one `catch` that maps a `ValidationError` to `board:
<message>` on stderr and exit 64; groups as mounted `Command`s; list types
split on commas, `collect: true` with a `value` that flattens, `EnumType`
for allowed values; `conflicts`, `required` and `depends` checked at parse;
`-p` declared per command; `HelpCommand` mounted `.global()`; help coloured
only on a terminal (`help({colors})`). Consequences: `board help` reaches one
level, so a subcommand's help is `board GROUP help SUB` or `--help`;
`@cliffy/table` counts terminal cells, so wide characters align, and a
newline in a cell continues in its column; `--json` stays the exact form;
`board sql` takes its query as one quoted argument; the build's `.npmrc`
maps `@jsr` to `npm.jsr.io`. Libraries: `@cliffy/command` and
`@cliffy/table` 1.3.1, tried under Bun 1.4.3, from source, in a `bun build
--compile` binary and under `bun test`, with no shim (its runtime layer uses
`process` when `Deno` is absent). Compared: `commander` 15.0.0 (fits, with a
comma-split `argParser` and a `--exec` check of ours), `yargs` 18.2.0 (no
`help` command, aliases added to every option), `citty` 0.2.2 (no
repeatable options, unknown options accepted), `cac` 7.1.0 (no nested
commands), `node:util` `parseArgs` (no commands); `cli-table3` 0.6.5 (same
table output, one more dependency).

## 7. Questions settled by the lead

1. **Comma-split: (a), `argParser`**, under commander: its documented hook
   used as designed, not a patch; the surface stays. Superseded by the
   owner's choice of cliffy, whose list types split on commas themselves.
   **CLI: cliffy** (owner), section 2.
2. **`details.path` twice in Appendix B's error shape: renamed.** `cycle`
   gave `path` as an array of keys, `no_board` as a string; in JSON the
   second wins (`JSON.parse` kept `{"type": "string"}`), and a real `cycle`
   refusal failed the shape (`data/error/details/path must be string`,
   `probes/errpath.ts`). It was not caught at run time only because `isError`
   results skip output validation. Not a package finding.
3. **`json-schema-to-ts` 3.1.1: taken**, a type-only dependency (last
   release 2024-08), erased at build time.

### Proposed Appendix B change (from 2)

In the error shape's `details`, the string `path` becomes `file`:

```json
"file": { "type": "string" },
```

and the `no_board` row of the error table reads `details`: `file`, `reason`
(`missing`, `board_dir_relative`, `no_home`). `path` is left with one
meaning, the loop's keys for `cycle`. A store or MCP test validates one
refusal of each code against the error shape, so a second meaning cannot
come back unnoticed. The `no_board` row is the only place in
`docs/design.md` that names the string `path`.
