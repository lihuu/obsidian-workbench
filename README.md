# Workbench

Local-first kanban boards for Obsidian. Board data lives in
`Workbench/boards/<id>.json`; device-local runner settings and checkout paths
live in the plugin's `data.json`.

## Where to configure in Obsidian

Each board owns its workspace and execution configuration. Open the board and
click the **Agent** button in the board header (the bot icon next to the save
status). The Runner URL/token are global; board source, workspace, column
mapping, and worktree mode apply to the current board. The **Help** button in
that modal opens `Workbench/README.md` in the vault.

## Agent Runner

The plugin talks to a local Node Runner over HTTP. An agent backend (Pi, OMP,
or OpenCode) runs outside Obsidian's renderer. The Runner owns the queue,
concurrency, worktrees, and history; backend-specific CLI/protocol details live
in adapters. GitHub sources, persistent sessions, run history, image
attachments, and optional success/failure column mapping are included.

### Backends

The Runner registers Pi, OMP, and OpenCode. Select the backend per board in the
Agent settings; the Runner default is used when the board has no selection.

```text
Pi       --mode rpc --no-approve   --session-dir ...  resume: --session <file>
OMP      --mode rpc --auto-approve --session-dir ...  resume: --resume <file>
OpenCode run --format json --standalone --auto        resume: --session <id>
```

Each backend declares capabilities (`steer`, `followUp`, `clearQueue`,
`resume`, `images`, `abort`, `toolEvents`). The plugin only shows controls the
selected backend supports.

- Pi: full live controls and images.
- OMP: live steer/follow-up; no `clear_queue` command.
- OpenCode: one-shot JSON run; no steer/follow-up/clear-queue/images, but
  terminal runs can Continue with the same OpenCode session id.

### Start

```bash
npm install
npm run runner
```

The default endpoint is `http://127.0.0.1:4319`. The Runner checks every
registered backend with `<binary> --version` on startup and exposes the results
at `GET /health`.

Optional environment:

```bash
WORKBENCH_RUNNER_PORT=4319
WORKBENCH_RUNNER_HOST=127.0.0.1
WORKBENCH_PI_BIN=pi
WORKBENCH_PI_MODEL=provider/model
WORKBENCH_OMP_BIN=omp
WORKBENCH_OMP_MODEL=provider/model
WORKBENCH_OPENCODE_BIN=opencode
WORKBENCH_OPENCODE_MODEL=opencode-go/deepseek-v4.1-flash
WORKBENCH_DEFAULT_BACKEND=pi
WORKBENCH_RUNNER_TOKEN=change-me
WORKBENCH_ALLOWED_ORIGINS=app://obsidian.md,capacitor://localhost
WORKBENCH_ALLOWED_ROOTS=~/Obsidian,~/Workbench
WORKBENCH_WORKSPACES_DIR=~/Workbench/workspaces
WORKBENCH_WORKTREES_DIR=~/Workbench/worktrees
WORKBENCH_MAX_CONCURRENT_RUNS=2
WORKBENCH_MAX_QUEUED_RUNS=20
WORKBENCH_SESSIONS_DIR=~/.workbench/sessions
WORKBENCH_RUNS_DIR=~/.workbench/runs
WORKBENCH_RUN_TIMEOUT_MS=1800000
WORKBENCH_GIT_TIMEOUT_MS=120000
```

If `WORKBENCH_RUNNER_TOKEN` is set, the plugin's **Runner token** field must
match it. Browser origins other than `app://obsidian.md` and
`capacitor://localhost` are rejected. Set `WORKBENCH_ALLOWED_ROOTS` to a
comma-separated allowlist if the Runner should only accept workspaces below
specific directories. Symlinked roots such as `/tmp` on macOS are normalized.

### Configure a board

1. Open the board.
2. Click **Agent** in the header.
3. Choose **Local folder** or **GitHub repository**.
4. Choose the **Execution backend** (Pi, OMP, OpenCode, or another registered
   backend).
5. For local, enter a folder. For GitHub, enter an HTTPS/SSH GitHub URL and an
   optional branch.
6. Set optional **Queue** / **Running** execution columns.
7. Set optional **On success** / **On failure** columns.
8. Optionally enable **Use a git worktree for each run**.
9. **Test connection**, then **Save**.

GitHub clones go to:

```text
~/Workbench/workspaces/<boardId>/<repoName>
```

The default branch is used when branch is empty. Existing checkouts are fetched
and checked out to the requested branch rather than blindly reset. System git
credentials and SSH agents are used; tokens are never written into the board.

The repository URL and branch sync with the board. The checkout path and Runner
connection stay on this device. Local folder paths also stay on this device.

### Worktree mode

When enabled, each run gets a separate Git worktree and branch:

```text
~/Workbench/worktrees/<boardId>/<runId>
branch: wb/<runId>
```

The base workspace must be clean before a run starts. The worktree is created
from `HEAD`, so commit or stash changes first. A `node_modules` symlink is added
when the base workspace already has one, letting tests run without reinstalling
dependencies; other dependency management remains the task's responsibility.

Worktree mode allows multiple active runs per board, up to
`WORKBENCH_MAX_CONCURRENT_RUNS` (default 2). Direct mode keeps the old
one-run-per-board limit. Worktrees isolate files and branches, not credentials,
network access, or OS permissions.

### Queue

`POST /runs` always enqueues. The Runner starts the oldest eligible queued run
while fewer than `WORKBENCH_MAX_CONCURRENT_RUNS` agent processes are active. A
third request returns `queued` instead of 429. The queue is FIFO among eligible
jobs and is capped at `WORKBENCH_MAX_QUEUED_RUNS` (default 20).

Direct mode still waits for the previous run on the same board. Worktree mode
can start the next worktree run on the same board while the previous one is
running. Aborting a queued run removes it from the queue. Queued jobs are
in-memory: a Runner restart marks them failed rather than resuming them.

The task detail shows the branch and worktree path. **Remove worktree** deletes
a clean, finished worktree; the branch is left for review/merge. If the worktree
has uncommitted changes, removal is refused.

### Run a task

Open a task and click **Run with <backend>** (for example, **Run with OMP**).
Workbench sends:

- board and task IDs
- task title and description
- Markdown snapshots of `[[linked notes]]` (bounded to 60k characters)
- embedded images (`![[...]]` or `![...](...)`), up to 4 images, 5 MB each,
  15 MB total
- the workspace path

Use **Preview context** to inspect the exact prompt before starting. The task
is saved before a run starts. The modal shows Runner events, stderr, a final
assistant summary, the agent session path, and an **Abort** button. Closing the
modal does not stop the run; the task card keeps a status badge.

The modal also lists up to five recent runs for the task, newest first, with
status, time, and the first line of each summary. Selecting an older run loads
its summary, session, and logs; live polling of the latest run continues and
does not replace the selected history entry. Use **Back to latest** to return
to the live panel.

While the latest run is active, the modal exposes a message composer:

- **Follow up** queues the message for after the current work
- **Steer** redirects the agent after the current tool calls, before the next
  model call
- user messages appear in the run log as `you:follow_up` / `you:steer`
- **Clear queue** sends the backend's `clear_queue` command; queued
  steering/follow-up messages are discarded and the log reports the count

Messages are accepted while the backend process is running. After it settles and
the run has a saved session reference, the composer switches to **Continue**: a
new run is started with the backend's resume command (`pi --session <file>`,
`omp --resume <file>`, or `opencode run --session <id>`), reusing the same
workspace/worktree. The new run records `parentRunId` and the same
`sessionId`. If the worktree was removed, Continue is refused and a new run is
required. For OpenCode, the saved session reference is its opaque `ses_...` id,
not a file path.

Backends are started with persistent sessions:

```text
pi       --mode rpc --no-approve   --session-dir ~/.workbench/sessions
omp      --mode rpc --auto-approve --session-dir ~/.workbench/sessions
opencode run --format json --standalone --auto
```

Successful and failed runs are written to
`~/.workbench/runs/<runId>/run.json` plus raw events in `events.jsonl`. The
plugin reloads recent runs for the active board, so badges, summaries, session
paths, and logs survive an Obsidian or plugin restart. A run interrupted by a
Runner restart is marked failed on the next start.

### Agent-created tasks

Each run receives a scoped proposal token and Runner URL in its environment:

```text
WORKBENCH_RUNNER_URL
WORKBENCH_RUN_ID
WORKBENCH_RUN_TOKEN
WORKBENCH_BOARD_ID
WORKBENCH_TASK_ID
```

The task prompt tells the agent how to create follow-up tasks:

```bash
curl -sS -X POST "$WORKBENCH_RUNNER_URL/runs/$WORKBENCH_RUN_ID/task-proposals" \
  -H "Authorization: Bearer $WORKBENCH_RUN_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"title":"...","description":"...","key":"stable-id"}'
```

The Runner stores proposals; the plugin polls them and creates tasks in an
**Inbox** column if present, otherwise **Backlog**, otherwise the first column.
Created tasks carry `source: "agent"`, `sourceProposalId`, `sourceRunId`, and
`sourceTaskId`, and show an **Agent** badge. They are not started automatically.

The token is scoped to proposal creation for that run only; it cannot abort
runs or change the board. The token is invalidated when the run exits. A run may
create at most 20 pending proposals; the global pending queue is capped at 200.
A proposal `key` makes retries idempotent within the run.

Agents still must not edit `Workbench/boards/` directly.

### Obsidian CLI entry

Any external agent or script can create a task through the official Obsidian
CLI, without the Runner:

```bash
obsidian workbench:create-task \
  board="Agent Integration" \
  column="Backlog" \
  title="Review generated tests" \
  description="Created by an external agent."
```

- `title` is required.
- `board` defaults to the active board; accepts a board name or ID.
- `column` defaults to Inbox, then Backlog, then the first column; accepts a
  column name or ID.
- The task is created through the plugin store, marked `source: "agent"`, and
  shows the Agent badge.
- Obsidian must be running, and the Obsidian CLI must be enabled in
  **Settings → General → Command line interface**.
- After updating the plugin, run `obsidian plugin:reload id=workbench` (or
  restart Obsidian); wait a few seconds, then verify with
  `obsidian help workbench:create-task` so the CLI handler is registered.
- This path requires Obsidian 1.12.2+ for `registerCliHandler`; the rest of the
  plugin keeps its lower minimum version.

Python example:

```python
import subprocess

subprocess.run(
    [
        "obsidian",
        "workbench:create-task",
        "board=Agent Integration",
        "title=Review generated tests",
        "description=Created by an external agent.",
    ],
    check=True,
)
```

The CLI is a local same-user entry point; it is not authenticated separately
from Obsidian. Use the Runner proposal API when an agent is already running
inside a Workbench run.

### Column projection

Execution columns are optional projections; the Runner queue remains the
source of truth.

- Dropping a task into the **Queue** column enqueues it
- `queued` moves to the Queue column
- `running` moves to the Running column
- `succeeded` moves to the success column
- `failed` moves to the failure column
- `cancelled` never moves

Column names are arbitrary; the board stores column IDs. The Running column is
system-managed: dragging into it does not start a run, and dragging out does not
stop a running one. Reordering tasks inside Queue updates the Runner's pending
order for that board; other boards keep their positions. The Runner remains
FIFO by effective pending order. Moving a queued task out of Queue cancels its
queued run. Deleting a task aborts its queued or running run first.

Automatic moves are off when no mapping is configured. The UI applies mappings
on live state transitions, not when loading old history.

### Data and security

- Runner binds to loopback by default.
- Agent backends run with the current user's permissions and no sandbox.
- Agents receive a per-run proposal token, not the global Runner token. The
  global `WORKBENCH_RUNNER_TOKEN` is removed from the agent environment.
- Provider API keys inherited from the Runner environment are visible to the
  agent process; use dedicated profiles/credentials if that matters.
- Only point a board at a repository you trust. Git checkout can execute
  repository-controlled hooks/configuration.
- Raw RPC events and sessions are local and may contain prompt/note content.
- Extension dialogs are auto-cancelled so a headless run cannot block.
- Direct mode allows one active run per board. Worktree mode allows up to
  `WORKBENCH_MAX_CONCURRENT_RUNS` active runs, each in its own checkout.
- Pi uses `--no-approve`; OMP uses `--auto-approve`; OpenCode uses `--auto`.
  All prevent interactive approval prompts from blocking the Runner.
- Worktrees isolate files, not host credentials or network access.

### API

```text
GET  /health
POST /workspace          { path }
POST /workspace/github   { boardId, repoUrl, branch }
POST /runs               { boardId, taskId, title, prompt, cwd, backend?, images?, worktree? }  -> queued/running
GET  /runs?boardId=...&taskId=...&limit=...
GET  /runs/:id?after=N
POST /runs/:id/message     { message, mode: "follow_up" | "steer" }
POST /runs/:id/clear-queue
POST /runs/:id/continue    { message }
POST /runs/:id/abort
POST /runs/:id/cleanup
POST /queue/reorder        { boardId, runIds }
POST /runs/:id/task-proposals  { title, description?, key? }  (run-scoped bearer token)
GET  /task-proposals?boardId=...
POST /task-proposals/:id/ack
```

### Verification

```bash
npm test
npm run check
npm run build
OBSIDIAN_VAULT=~/Obsidian/YourVault npm run deploy
```

`npm run deploy` requires `OBSIDIAN_VAULT`; it copies `main.js`, `manifest.json`,
`styles.css`, and `README.md` into `<vault>/.obsidian/plugins/workbench`.

## License

MIT. See [LICENSE](LICENSE).
