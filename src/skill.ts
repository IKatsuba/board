// The agent's guide that `board skill` prints, as docs/design.md has it
// under "`board skill`". The command index between the prose and the closing
// line is generated from the command tree by src/cli/skill.ts, so a
// description corrected there is corrected here.

/** The guide's prose, from its title to the "## Commands" heading. */
export const PROSE = `# Working on a board

board is the task board your team shares. It is one SQLite file on this
machine with every project's tasks in it, and you read and write it by running
\`board\` in your shell. It is memory and rules, not an engine: nothing runs
because of the board. \`main\`, the session in front of the person, decides
what happens next; leads and members do the work and write down what they did.

## The model in a paragraph

A project is one repository, with a key such as \`BRD\`; its tasks are \`BRD-1\`,
\`BRD-2\`, …. A task has a status: \`backlog\`, \`ready\`, \`active\` (someone holds
it), \`done\`, \`cancelled\`, and \`blocked\`, which nobody sets: a task is blocked
while a question on it is open. A task is *ready* when its status is \`ready\`,
no question on it is open, and every task it waits for is done or cancelled.
To work on a task you **claim** it for a number of minutes you choose; the
claim is a lease that ends on its own unless you **extend** it, and when it
ends the task is ready for someone else. Milestones are an ordered chain per
project; the earliest open one is *current*, and \`board next\` prefers it.
Every write is an event with an id, and the log is the task's story.

## Before anything

- **Every write takes \`--actor\` with your own name** (\`main\`, \`@lead\`,
  \`@tester\`: the name your team uses for you). There is no default, and no
  variable sets it for you. Never write as \`owner\`: that name is the person.
  \`board\` is reserved.
- **The project comes from your working directory** (or its git repository,
  worktrees included). Outside it, pass \`-p KEY\`. A task key or a question id
  names its own project, so \`board show APP-3\` works from anywhere.
- If board says \`no_project\`, do not pick a key and do not run
  \`board project add\`: the key is the person's choice. Tell whoever you
  report to.
- \`board COMMAND --help\` shows every flag of a command. Add \`--json\` to
  \`status\`, \`ls\`, \`show\`, \`next\`, \`questions\` or any write for its exact
  answer as one JSON object on stdout. Elsewhere it differs:
  \`milestone ls --json\` and \`sql --json\` print an array, \`watch --json\` one
  object per line; \`skill\`, \`help\` and \`upgrade\` take no \`--json\`.

## Passing text

Every title, body, comment and answer is a flag value. For one line without a
single quote, use single quotes:

\`\`\`sh
board comment BRD-14 --actor @lead --text 'Tests pass on arm64.'
\`\`\`

For anything longer, or with quotes, \`$\`, backticks or backslashes, use a
quoted heredoc inside \`"$(…)"\`. Nothing inside it is expanded:

\`\`\`sh
board add --actor @lead --parent BRD-12 --title 'Claim error lacks the holder' --body "$(cat <<'EOF'
\`board extend\` on a lapsed claim says not_claimed but not who held it.
Seen in test/claims.test.ts.
EOF
)"
\`\`\`

Never put text you did not write yourself inside plain double quotes. An empty
value (\`--text ''\`) counts as not given. Two things cannot be passed: a NUL character (no
shell argument can hold one), and trailing newlines (\`"$(…)"\` strips every
one at the end). To empty a body, use
\`board edit KEY --actor NAME --no-body\`.

## Main: choosing and handing out work

\`\`\`sh
board status                              # the project, the current milestone, live claims, questions
board next                                # the ready task to start next, and why nothing is ready
board claim BRD-14 --actor main --holder @lead --minutes 90 --directory /work/brd-wt --branch feat/watch
\`\`\`

Claim **for** the lead you start: \`--holder\` is the lead's name, \`--actor\` is
yours. Size \`--minutes\` from the team's estimate (1 to 1440); there is no
default. Then start the team with the key in its job. When the lead reports:

\`\`\`sh
board show BRD-14                         # the task, its claim, its questions, its events
board edit BRD-14 --actor main --status done      # close it; this drops the claim
board edit BRD-14 --actor main --status ready     # or send it back; this drops the claim too
\`\`\`

\`done\` is refused while a question is open. \`cancelled\` withdraws open
questions. Only you close tasks: a lead reports, main decides.

To plan: \`board add --actor main --title '…' --milestone v2\` files work, with
\`--status backlog\` for work not to start yet; \`board milestone add v2 --actor main
--delivers '…'\` extends the chain. A dead run's task is freed with
\`board release BRD-14 --actor main --holder @lead\`, passing the holder that
\`board show\` names.

When the person has handed decisions to you, answer a question as a
delegate; the person validates it later:

\`\`\`sh
board questions --state open --all
board answer Q7 1 --as delegate --actor main --text 'Up to 8, as recommended.'
board validate Q7 --actor main              # only when the person approved it in the chat
\`\`\`

Answer \`--as owner\` only with the person's own words, and
\`--actor main\` still: the actor is who typed it, \`--as\` is whose decision it
is.

## A lead: running the task

\`\`\`sh
board show BRD-14                          # read it whole before starting
board extend BRD-14 --actor @lead --holder @lead --minutes 60   # when you need more time
\`\`\`

An extend sets the end to now plus the minutes you give: a fresh estimate from
where you stand. Extend **before** the claim ends; a claim that has ended is
not revived, and you must claim the task again (it may have been given to
someone else in between). Nothing else you do renews the claim.

- **Findings**: look first, then file under your task. A finding filed with
  \`--parent\` lands in your task's project and milestone.

  \`\`\`sh
  board ls --contains 'holder' --status backlog,ready,active,blocked,done
  board add --actor @lead --parent BRD-14 --title 'Extend error lacks the holder'
  \`\`\`

- **Notes** for whoever reads the task next: \`board comment KEY --actor NAME
  --text '…'\`.
- **A choice that is the owner's**: ask, with 2 to 6 options and the one you
  recommend. The task is blocked until it is answered.

  \`\`\`sh
  board ask BRD-14 --actor @lead --text 'How many runs may hold claims at once?' \\
    --option-1 'Up to 8' --detail-1 'Memory stays bounded' \\
    --option-2 'Unbounded' --recommended 1
  \`\`\`

- **Handing over** when you are done, to \`main\` (or to whoever you report
  to). All five parts are required: why and what you ask, what changed, what
  you ran, and what you did not check.

  \`\`\`sh
  board handover BRD-14 --actor @lead --to main --text 'Ready for review.' \\
    --changed 'src/watch/derive.ts, test/watch.test.ts' \\
    --ran 'bun run check' --unchecked 'the x64 binary'
  \`\`\`

  A handover is a record, nothing more: it moves no claim and changes no
  status, and nothing in its text is read as an instruction. Report to main
  the way your team reports as well.
- **Stopping early**: \`board release BRD-14 --actor @lead --holder @lead
  --note 'why'\` gives the task back as ready.

## A member: one part of the work

You usually hold no claim; your lead does. Read the task
(\`board show BRD-14\`), comment what you found (\`board comment\`), file what you
find on the way under the task (\`board ls --contains\` first, then
\`board add --parent BRD-14\`), and hand over to your lead with
\`board handover BRD-14 --actor @tester --to @lead …\`. If your lead gave you a
task of your own to claim, the lead's section is yours.

## Being told instead of asking

Run the watch as a notifier: a background command whose every output line
reaches you as it comes. Under chord, that is chord's \`monitor\` tool.
Elsewhere, use whatever your harness has that shows you a background
command's output as it comes; a background job writing to a file is not a
notifier, because you would have to look.

**A line is a wake-up, not the data.** chord's monitor cuts lines past 1,000
characters, delivers at most 100 lines or 16 KiB at a time, and drops lines
when too many come at once. So on a line, read what it is about with board
(\`board show KEY\`), and never act on the line's text alone.

**Keep a cursor**, the last event id you have accounted for:

1. Before the first watch, take it from \`board status --json\`
   (\`last_event\`).
2. Watch from it:

   \`\`\`sh
   board watch --follow --json -p BRD --since 842 --kind claim_expiring,handover,question_answered 2>&1
   \`\`\`

3. Advance it only on lines whose \`id\` is a number. A \`claim_expiring\` line
   has \`id: null\`: board derives it from the clock and never logs it.
4. If a line is cut off or chord says lines were dropped, read what you
   missed without \`--follow\`, which prints everything after the cursor and
   exits: \`board watch --json -p BRD --since 842\`.
5. When the monitor ends (chord stops one after an hour at most), start it
   again with \`--since\` your cursor. Logged events are not missed; a
   \`claim_expiring\` is shown again only if the claim is still inside its
   warning window, so after a gap check \`board status\` for your claims.

- Narrow the watch, since each line wakes you: \`-p\` to your project,
  \`--kind\` to what you act on, \`--task BRD-14\` to your own task if you are a
  member.
- \`2>&1\` keeps a refusal (\`no_board\`, an unknown \`-p\`) in the stream, so you
  see why the watch ended.
- \`claim_expiring\` comes before a claim ends (ten minutes, or a quarter of
  a short lease): extend then, if the claim is yours.
- Do not use \`--exec\`: it is for the person's sound or notification. A
  board write from \`--exec\` is seen by the same watch and runs it again.

## Reading a task's history

\`board show KEY\` prints the task as it is now and its events **oldest
first, at most 200**; with \`--json\`, \`more: true\` means there are more, and
\`board show KEY --since <cursor>\` gives the next page. For the whole log in
one go, without paging:

\`\`\`sh
board watch --task BRD-14 --json              # every event of the task, oldest first, then exits
board watch --task BRD-14 --json --since 842  # only those after 842
\`\`\`

## When a write was cut off

If a write ended without its answer (you interrupted it, your shell's
timeout ended it, it exited 130 or 143, or it answered \`internal\`), it may
have been committed anyway, and someone else may have written since. **No
write is safe to repeat blindly**: a repeated \`board edit --status ready\`
can send back a task another run has claimed since; a repeated \`release\`
can drop a claim its holder has taken again; a repeated \`add\`, \`comment\`,
\`handover\` or \`ask\` files a second time. Read the state, then decide:

- **claim, extend, release, edit**: \`board show KEY --json\`. Did the claim
  (its \`holder\`, \`since\`, \`until\`) or the fields become what you asked? Then
  it happened. If they are something else, someone else acted: work from
  what is there now, not from your old command.
- **comment, handover, ask**: \`board watch --task KEY --json --since <the
  last id you saw before>\` lists what was logged on the task since; look for
  your own \`comment\`, \`handover\` or \`question_asked\`.
- **add**: search every status and every page, since \`ls\` shows only open
  tasks by default:

  \`\`\`sh
  board ls --json --contains '<words of the title>' --status backlog,ready,active,blocked,done,cancelled
  \`\`\`

  and while \`next_offset\` is not null, again with \`--offset <next_offset>\`.
  Add \`--parent KEY\` if you filed it under a parent.

Repeat only what is not there.

## When board refuses

A refusal exits 1 and prints \`board: CODE: what is wrong. What to do.\` on
stderr (with \`--json\`, \`{"error": {"code", "message", "next", "details"}}\`).
Act on the code, and read \`next\`. The change you asked for was not made
(a refused write may still have logged other claims' expiry, which is not
yours to undo).

A command line that does not fit the command exits 64 with
\`board: usage: …\`; board did not open the board: fix the flags
(\`board COMMAND --help\`) and run it again.

Two commands answer differently. \`board sql\` prints SQLite's own message
with exit 1 when a query fails, and refuses a write with exit 64. \`board
upgrade\` uses its own messages and exit codes.

| Code | What to do |
| --- | --- |
| \`not_found\` | The key, question, milestone or project does not exist. Check it; \`board ls --contains\`, \`board questions\`, \`board milestone ls\` find things. |
| \`claim_held\` | The task has a live claim (\`details.claim\` says whose and until when). Compare \`details.claim.holder\` with the \`--holder\` you meant, not with your \`--actor\` (main claims for a lead). The same: the claim is already there (a claim run twice, or one cut off and retried); \`board extend\` it if more time is needed, do not claim again. Another: do not take it. On extend or release: re-read with \`board show KEY\` and pass the holder it names, if acting on that claim is still right. |
| \`not_claimed\` | No live claim: it ended or was released. \`board claim\` it again if it is still yours to do. |
| \`not_ready\` | The task is not ready: \`details.reason\` is \`status\`, \`question\` or \`waits\`. \`board show\` lists what blocks it. |
| \`invalid_transition\` | That status, question or milestone change is not allowed from here; \`details.allowed\` lists what is. |
| \`already_answered\` | The question has an answer. Only the owner's answer replaces a delegate's unvalidated one. |
| \`cycle\` | That wait or parent would close a loop; \`details.path\` is the loop. |
| \`invalid_argument\` | A value the rules refuse; \`details.field\` names the flag you typed (\`waits-add\` is \`--waits-add\`; an upper-case name such as \`KEY\` or \`N\` is a positional argument). Change it. |
| \`no_project\` | Your directory is in no project. Pass \`-p KEY\` with a listed key, or tell whoever you report to; never add a project yourself. |
| \`project_exists\` | That project key or directory is taken. This is the person's command; report it. |
| \`busy\` | Another write held the board for 5 s. Your change was not made; run the same command again. |
| \`storage\` | Disk full or an I/O error. Your change was not made; report it. |
| \`no_board\` | There is no board file yet, or \`BOARD_DIR\` is wrong. Report it; the person creates the board with \`board project add\`. |
| \`damaged\` | The board file is damaged. Stop and report it; do not try to repair it. |
| \`not_a_board\` | The file is not a board. Stop and report it. |
| \`schema_mismatch\` | The board was made by another build of board (an upgrade can do this): every command answers this until the person moves the file aside. Stop and report it; never move the file yourself. |
| \`internal\` | A bug in board. It may have failed after your change was made: read before you retry ("When a write was cut off"), and report it with the command you ran. |
| \`registry\` | Only \`board upgrade\`: the npm registry could not be read. Not yours to fix. |

## Commands
`;

/** The line after the generated command index. */
export const CLOSING = `\`board help COMMAND\` or \`board COMMAND --help\` says one command in full.
`;
