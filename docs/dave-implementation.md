# Coding DAVE implementation

This iteration adds a small coding workflow to the existing Pi agent. Native Pi
MCP remains the only transport; no MCP adapter is installed or required.

## Available now

- `/dave start TEXT`, `status`, `queue TEXT`, `decision TEXT`, `evidence TEXT`,
  `plan TEXT`, `question TEXT`, `next`, and `done`: one active task with a visible queue and session-persisted records.
  The model uses the same transitions through `dave_task`. Completion requires fresh recorded evidence after resume; this is a human record, not a test runner.
  Resume and session-tree navigation restore the current branch records and invalidate old completion evidence. The active board is included in model context.
- The `coding-task` skill supplies acceptance, implementation, verification,
  visible project memory and categorized improvement intake conventions.
- Guard stays enabled; unknown shell commands and unfamiliar tools go to Judge.
  With no Judge, approval is required. Noninteractive approvals block.
  Explicit push rules deny; dependency installation and commits ask first.

Use `/guard judge setup` to configure the separate local decision endpoint.
Use `/dave start Fix the parser` before a coding task, and record exact check
results with `/dave evidence ...`. Session records follow Pi session branching;
this board is not a repository-wide concurrent scheduler.

## Candidate decisions

Selected: existing Guard/Judge (C3), focused task state (C2), plain Markdown
memory (C4), intake conventions (C8), and coding verification workflow (C1).
Use built-in code tools first; no extra language intelligence or memory dependency.
Keep existing fetch and campus tools for workshop compatibility.

Selected for later integration: GitHub/Actions through native MCP, Redmine through
a narrowly scoped connector, and Hub as the session dashboard. No credentials or
service URLs were invented. Hub's documented Pi peer mismatch prevents enabling
it alongside a modern runner without compatibility testing. Worker execution is
disabled pending that test, isolation and Guard propagation. Do not install an
MCP adapter to solve this mismatch.

Deferred: overlapping search/browser clients, LSP, semantic memory, automatic
updater publication and retrospective Judge review. The updater proposal remains
unimplemented; it must not imply permission to publish during ordinary work.

## Verification and remaining acceptance

Run `node scripts/verify-dave.mjs` with Node 24. Set `DAVE_PI_PACKAGE` to an installed Pi package directory to additionally verify runtime loading. Tests cover task exclusivity,
completion gating, queue persistence and restart restoration using a mock Pi API. Guard regressions cover explicit denies, exact-action session grants, unknown MCP calls and noninteractive blocking.
Pi 1.5.1 was subsequently located outside PATH; both extensions load with its real loader. Native MCP
hooks, command bypass coverage, worker enforcement, Hub visibility and the three
coding acceptance scenarios remain unverified. Guard is a tool-call interlock,
not an OS sandbox: arbitrary extensions and shell invocation outside Pi are not
covered. No first-hook or complete security-boundary claim is made.

Native configuration reference: https://pi.dev/docs/latest/mcp

`/dave-update` now provides a local review prompt; it does not implement automatic PR publication. Session approvals are scoped to exact tool inputs and working directory, and cleared when a session starts. Judge outage configuration cannot permit unresolved actions.

## Personal integration setup

Run `./setup.sh --integrations` to configure coding services without rerunning
installers or studio setup. Normal `./setup.sh` also includes this step.
Settings go to `$PI_CODING_AGENT_DIR/dave.json` (default `~/.pi/agent/dave.json`),
with native MCP entries merged into the adjacent `mcp.json`. Files are private
(mode 0600); tokens are never collected or saved. DAVE loads the repository,
base branch and Redmine project at session start.

Environment variables also support unattended setup:

| Variable | Meaning |
| --- | --- |
| `DAVE_GITHUB_REPOSITORY` | `owner/repository`; empty disables the DAVE GitHub server |
| `DAVE_GITHUB_BASE` | Base branch; default `main` |
| `DAVE_GITHUB_MCP_URL` | GitHub MCP endpoint; defaults to GitHub's hosted service |
| `DAVE_GITHUB_TOKEN` | Token exported when running Pi, not persisted by setup |
| `DAVE_REDMINE_URL` | Redmine website URL; empty disables the DAVE bridge |
| `DAVE_REDMINE_PROJECT` | Project identifier |
| `DAVE_REDMINE_MCP_URL` | Existing HTTP MCP bridge endpoint, distinct from Redmine's REST API |
| `DAVE_REDMINE_MCP_TOKEN` | Bridge bearer token exported when running Pi |
| `DAVE_MAX_WORKERS` | Reserved maximum 0–2, default 2 |
| `DAVE_WORKER_MINUTES` | Reserved time limit 1–120, default 15 |

GitHub is configured read-only. The bridge's token controls Redmine access;
Guard still evaluates its tools. Use `/mcp` after reload to inspect connectivity.
Setup does not connect or verify credentials. Without a Redmine bridge URL,
only project metadata is configured. Worker limits are reserved configuration:
workers remain disabled because the runner and Hub integration are unfinished.
Automatic update publication is also still unimplemented.

GitHub endpoint and read-only header reference:
https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md


## Reviewer and Hub tools

`dave_review` is now a model-callable synchronous read-only reviewer. Guard asks
before launching it. It starts Pi with only read, grep, find and ls, explicitly
loads Guard and a workspace scope hook, and disables MCP, extension discovery,
skills and prompt templates. No writing-worker capability is enabled.
The configured maximum (0–2) and timeout (1–120 minutes) apply, with a 1 MiB
output cap and cancellation propagation. Pi must be on PATH and have a working
model connection. An optional model parameter selects a configured provider/model.
Worker start and terminal records are saved as `dave-worker` session entries.
A running record after a crash is historical, not evidence that a worker is live;
workers are not automatically resumed. Filesystem hooks are not an OS sandbox.

Task changes now publish `pi-agent-hub-context` snapshots using Hub's documented
version-1 contract, including blocked attention when resumed evidence is stale.
This completes the metadata producer, not Hub installation or dashboard runtime
verification. See https://github.com/masta-g3/pi-agent-hub/blob/main/docs/CONFIG.md.

Verification now includes reviewer capability arguments, scope rejection and
Hub attention clearing. Five test files pass and both parent extensions load in
Pi 1.5.1. A live model-backed reviewer run is still unverified. Writing worktrees,
full Hub compatibility, native Redmine bridge implementation and automatic update
publication remain outstanding; earlier disabled-worker statements refer to
writing workers, while the bounded read-only reviewer is now available.

## Built-in Redmine connector

The external-bridge requirement above is superseded: setup now defaults to the
bundled read-only stdio connector when a Redmine URL/project is configured.
Export `DAVE_REDMINE_API_KEY`; `DAVE_REDMINE_MCP_URL` remains an optional override
for an existing external bridge. See [connector details](../mcp/redmine/README.md).
The connector reuses setup's existing MCP SDK installation, exposes list/get
issue tools and limits queries to the configured project. No external writes
are implemented. Fourteen unit tests now pass with Node's in-process test mode;
live Redmine and stdio end-to-end verification remain outstanding.

## Completion pass — user testing deferred

This section supersedes earlier outstanding implementation statements. No tests,
installation, model runs or publication were performed for this pass.

- `dave_implement` creates a unique branch/worktree from committed HEAD, runs a
  bounded Pi child with file tools and Guard, and retains changes for parent
  review. Shell, MCP, policy edits and repository internals are unavailable to
  the child. Parent uncommitted changes are deliberately absent. A missing Guard
  configuration is supplied from DAVE and must be excluded from integration if
  it is only worker scaffolding. Review untracked as well as tracked files.
- Reviewers and writers share the configured maximum of two workers and timeout.
  Runs are synchronous and cancellable; records persist, processes do not resume
  automatically. Hooks are not an OS sandbox. No token or monetary hard cap is
  implemented; use provider-side limits when required.
- `dave_publish_update` creates a draft PR through GitHub's API after Guard
  approval. Only the three declared baseline/package files are accepted. Stable
  content identities allow duplicate-PR reuse; conflicting existing branch trees
  are never overwritten. It does not install or activate packages. Supplied
  verification is a user/model record, not independently executed proof.
- `.pi/baseline.json` declares the Pi pin and native transport. `./setup.sh --hub`
  installs exact Pi/Hub versions into `.dave/tools`, with strict npm peer checks
  and lifecycle scripts disabled. Set `DAVE_HUB_VERSION` or `baseline.hub` to a
  reviewed compatible version; no compatible Hub pin has been verified yet.
  The installer refuses a missing pin or peer conflict. Run Hub through its local
  launcher under `.dave/tools/node_modules/.bin`. DAVE publishes supported Hub
  context snapshots; dashboard behavior is for the user-testing pass.

Suggested user acceptance: setup integrations; inspect `/mcp`; list a Redmine
issue; run one review and one isolated implementation; inspect their records and
worktree after restarting; decline a publication request; then approve a small
verified baseline update and invoke it twice to confirm matching-PR reuse.
Do not activate an unreviewed Hub pin or treat this checklist as passed.
