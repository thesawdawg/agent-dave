# agent-dave

**DAVE** (Digital Assistant for Various Endeavors) is an AI co-worker built on the [pi coding agent](https://pi.dev). It comes from the workshop *Beyond the Prompt: Build Your Own Co-Worker* at the K-State AI Studio.

Every part of DAVE is a plain file in this repo. Open the folder in VS Code and you can read, and change, all of him.

## Coding DAVE

The coding iteration adds `/dave` task tracking, a coding-task skill, and stricter
Guard defaults, using built-in Pi MCP. See [implementation and remaining checks](docs/dave-implementation.md).

## The parts

| Robot part | What it is | File |
|---|---|---|
| Power supply | The model endpoint | `~/.pi/agent/models.json`, written by `setup.sh` from the studio's model list |
| Brain | Which model, and how hard it thinks | `.pi/settings.json` |
| ID badge | Who DAVE is and how he works | `AGENTS.md` |
| Hands | Built-in tools: read, write, edit, bash | built into pi |
| Instruction manuals | Skills DAVE opens only when a task needs one | `.pi/skills/*/SKILL.md` |
| Drone | MCP servers that live outside DAVE | `.pi/mcp.json`, `mcp/campus-events/` |
| Upgrade module | Extensions that add tools and commands | `.pi/extensions/hello.ts` |
| Safety interlock | Checks every tool call against your rules before it runs | `.pi/extensions/guard.ts`, rules in `.pi/guard.jsonc` |
| Black box | Every session, step by step | `/tree`, `/export` in pi |
| Fleet antenna | Worker DAVEs for a crew | `.pi/agents/*.md` (needs pi-subagents) |

### Skills
- **meeting-notes:** turns rough notes into minutes with decisions and action items.
- **research-brief:** reads 3 to 5 web sources and writes a one-page brief.
- **campus-lookup:** finds K-State events and puts one on your calendar.

To write your own, copy [templates/my-skill](templates/my-skill/SKILL.md) into `.pi/skills/` and fill in its description.

### MCP servers
- **fetch** reads any web page ([mcp-server-fetch](https://pypi.org/project/mcp-server-fetch/)).
- **campus-events** searches the K-State calendar and saves events as `.ics` files. See [its README](mcp/campus-events/README.md).

### Safety interlock
`AGENTS.md` *asks* DAVE to check with you before deleting, sending or publishing. [guard.ts](.pi/extensions/guard.ts) *enforces* it, whatever the model decides. Its rules live in [.pi/guard.jsonc](.pi/guard.jsonc), a short file you edit in VS Code. It's read before every tool call, so a change works as soon as you save.

Each rule picks a **mode**: `allow` runs it, `ask` asks you first, `never` blocks it. A `never` rule always wins; otherwise rules are checked top to bottom and the first match decides. An `allow` command rule covers a command line only if every command in it is allowed, so `pip install x && rm -rf ~` isn't waved through by a rule for `pip install`. Out of the box:

- **Never:** `git push`, `sudo`, `chmod 777`, reading or changing `.env`, and writing to `.git/`, `.ssh/` or pi's saved keys in `~/.pi/agent/`.
- **Ask first:** dependency installs, commits, deleting files, sending data to a website, `scp`/`ssh`/mail, changing files outside this folder, and MCP tools their server marks as destructive.

A rule matches a shell **command** by its words (`"rm"`, `"git push"`), a **file** by name or path (`".env"`, `"notes/private"`), or a **tool** by name (`"export_ics"`):

```jsonc
{ "command": ["npm install", "pip install"], "mode": "ask", "why": "install packages" },
```

The `"dial"` at the top of the file decides everything no rule matches, using the settings from slide 29: `ask-before-everything`, `ask-before-changes`, `ask-before-anything-leaves` (the default) or `just-do-it`. VS Code suggests the allowed values as you type.

When the guard asks about a shell command, you can answer **Yes, once**, **Yes, for the rest of this session**, **No**, or save your answer: **Always allow** or **Always block** adds a rule at the top of `.pi/guard.jsonc`, for that exact command or for any command starting the same way (such as `pip install`). Each saved rule gets a dated comment, so you can find and delete it in VS Code.

In pi, `/guard` lists the rules as the guard understands them, `/guard test rm notes.md` shows which rule decides a command, `/guard test-file .env` does the same for a file, `/guard off` pauses the rules and the judge for the rest of the session, and `/guard on` turns your existing rules back on (a new session also starts with the guard on). The catastrophic-command last look below keeps running even while the guard is off. If the file has a mistake, the guard says which line and asks before every change until it's fixed.

#### Super-advanced: a model as the judge
Rules catch what you expected. For everything else, the guard can ask a **decision model**: [Clef](https://ollama.com/library/clef:27b), Cloudflare's open (Apache 2.0) model, or any endpoint that speaks the System One API. It reads a command against your policy (a few plain sentences in `.pi/guard.jsonc`) and returns a probability for `allow`, `ask` and `never`.

The judge has **its own connection**, separate from the model DAVE chats with. Connect it either way:

- **In pi:** `/guard judge setup` asks for the address (default `http://localhost:11434`), an optional API key (none, an environment variable, or typed), and the model; it lists the decision models it finds there. It tests the judge, saves the connection to `~/.pi/agent/guard-judge.json` (outside the repo, readable only by you), and offers to send commands no rule matches to it (`"otherCommands": "check"`).
- **From a terminal:** `./setup.sh --judge` (Windows: `setup.ps1 -Judge`) asks the same questions and hides the key as you type.

Then `/guard judge` checks that it answers, `/guard test python3 -c "import os; os.remove('events.ics')"` shows its verdict and probabilities, and `/guard judge off` (or `./setup.sh --forget-judge`) disconnects it.

- **Needs** a System One endpoint, such as Ollama 0.35.1 or newer with `ollama pull clef:27b` (or the smaller `clef-flash`). The guard calls `POST <address>/v1/systemone`; Open WebUI and plain chat endpoints don't serve it. Give the model 16384 tokens of context (Ollama's default is 4096, and the call can't change it); [TROUBLESHOOTING.md](TROUBLESHOOTING.md#the-judges-context-is-too-small) shows the two-line Modelfile.
- **Fails safe:** an `allow` under `allowAt` (80% by default) becomes ask, and if the judge is down or slow, `ifUnavailable` (ask by default) decides. A loaded judge gets `timeoutMs` (8 s) to answer; when its model has to load first (the first call, or the first after 30 idle minutes), it gets `coldStartMs` (30 s). The guard also starts loading it in the background when a session starts, and lets that load run up to 5 minutes, since Ollama throws away a load that's cut short. With no judge connected, `check` just asks you.
- **The judge flags, you decide:** `"maxVerdict": "ask"` (as shipped) turns the judge's `never` into a question, marked *the judge flagged it as dangerous*, without an *Always allow* option. The guard applies this after the answer, so it doesn't depend on the model following instructions. Set it to `"never"` to let the judge block. Your own `never` rules always block either way.
- **One project, one judge:** a `"url"` (plus `"model"`, `"apiKey"`) written into the `"judge"` block of `.pi/guard.jsonc` wins over the saved connection.

#### The last look: catastrophic commands
Rules, the judge and your own "yes" can all be wrong, especially about a command you don't recognize. So right before any command runs, however it was allowed (a rule, **Yes**, **Always allow**, the `just-do-it` dial, even a permissive dial), the guard checks it against a short, fixed list of commands that can wreck a computer: `rm -rf` on `/`, `~` or a system folder, deleting `C:\Windows` or all of `C:`, formatting or overwriting a disk (`format`, `diskpart`, `mkfs`, `dd of=/dev/…`), a fork bomb, `chmod -R` on `/`, deleting Windows restore points or system registry keys, `git push --force` to `main`, and writes into the operating system's own folders. A match stops with a plain explanation of what it would do and runs only if you type `RUN`. With nobody there to type it, it's blocked.

The list is at the top of the "last look" section in [guard.ts](.pi/extensions/guard.ts). It's a seat belt, not a complete list, and it errs on the side of stopping (even `echo rm -rf /` gets a second look). `/guard test rm -rf ~` shows it.

Want it tighter? Each of these is enforced by pi, not by the model:

| Control | Where | Example |
|---|---|---|
| Fewer hands | `.pi/settings.json` | `"defaultTools": ["read", "grep", "find", "ls"]` makes a read-only DAVE. For one run: `pi --tools read,grep,find,ls` |
| Fewer drone tools | `.pi/mcp.json` | `"toolExposure": { "export_ics": "hidden" }` on a server hides one tool; `"exposure": "hidden"` hides them all. `pi --no-mcp` turns MCP off for one run. |
| Scoped workers | `.pi/agents/*.md` | `tools: read, write` gives a worker only what its job needs. |
| The cage | outside pi | A container or VM, a separate account, short-lived keys, and git as the undo button. pi's own security guide calls this the only real boundary. |

### Crew workers
`events-scout`, `repo-reporter` and `writer`. Each worker lists only the tools it needs. They run when [pi-subagents](https://pi.dev/packages/pi-subagents) is installed: `pi install npm:pi-subagents`.

### When you need a hand
- **[ACTIVITIES.md](ACTIVITIES.md):** six timed activities totaling 55 minutes, including a final test of your own co-worker.
- **[templates/my-workshop.md](templates/my-workshop.md):** copy to `my-workshop.md` to record your task, skill design, checks and result. Take your edited identity and skill home along with this file; the starter download does not include your changes.
- **[.vscode/settings.json](.vscode/settings.json):** keeps VS Code's built-in AI chat and its sidebar off in this folder. Delete its two chat lines to bring them back.
- **[TROUBLESHOOTING.md](TROUBLESHOOTING.md):** quick fixes for setup, keys and errors.
- **[checkpoints/](checkpoints/README.md):** the finished files for each loop, if you fall behind.
- **[samples/](samples/):** practice inputs: messy meeting notes, prompts to try, skill ideas.
- **[examples/](examples/README.md):** finished personas and the skill and extension from the live demos.
- **[examples/kits/](examples/kits/README.md):** three more ready-made skills with sample data and a known right answer: webpage briefing, spreadsheet check and scan renamer.

No internet? campus-events falls back to a saved snapshot of the calendar on its own, and the offline copy handed out in the room carries everything else a machine needs.

## You'll need

- **Linux or macOS:** `git` and `curl` (and `xz` on Linux). Most machines have them.
- **VS Code.** On macOS and Windows, setup installs it for you if it's missing, with no admin password. On Linux it needs an administrator (`sudo snap install code --classic` on Ubuntu), so setup tells you if it's missing.
- **Windows:** PowerShell (built in). `git` helps for cloning; without it, download the repo as a ZIP from GitHub.
- An API key for [Library GPT](https://gpt.lib.k-state.edu/), from your handout. Setup already knows the address.

Setup installs everything else in your home folder, with no sudo or administrator password: [pi](https://pi.dev) (with its own Node.js), [uv](https://docs.astral.sh/uv/) for the fetch server, and, on Windows, a private copy of Git Bash for pi.

## Quick start

Linux or macOS:

```bash
git clone https://github.com/thesawdawg/agent-dave && cd agent-dave && ./setup.sh
```

Windows (PowerShell):

```powershell
git clone https://github.com/thesawdawg/agent-dave
cd agent-dave
powershell -ExecutionPolicy Bypass -File setup.ps1
```

Setup asks for the studio address (press Enter for Library GPT, `https://gpt.lib.k-state.edu`) and your key, checks them, reads the list of models the studio offers, and saves the connection in `~/.pi/agent/models.json` (readable only by you; other providers in that file are kept). It never starts pi. As its last step, it opens this folder in VS Code, in its own profile called DAVE: no extensions, and VS Code's built-in AI chat turned off, so DAVE is the only AI in the window. It shows [READY.md](READY.md), a short *you're all set* page. Your usual VS Code setup isn't touched; switch profiles from the gear icon at the bottom left. Then run this in VS Code's terminal (Ctrl + `):

```bash
pi
```

Say yes when pi asks to trust the folder; that lets it load `.pi/`. If VS Code didn't open, open it yourself with `code ~/agent-dave` (or File > Open Folder).

Setup is safe to run again. On a shared machine, remove your key when you're done: `./setup.sh --forget-key` (Windows: `powershell -ExecutionPolicy Bypass -File setup.ps1 -ForgetKey`).

## After the workshop

**[docs/build-your-own.md](docs/build-your-own.md)** takes you from a fresh computer to your own DAVE: with your own Library GPT key, with a model on your own computer through Ollama, or with any OpenAI-compatible endpoint. Then it walks through making each part yours.

Also in `docs/`:

- **[master-dave-candidates.md](docs/master-dave-candidates.md):** proposed coding-agent extensions, MCP servers, skills, and custom builds for review; includes [intent questions](docs/master-dave-questions.md). No additions have been installed.
- **[master-dave-update.md](docs/master-dave-update.md):** proposed `/dave-update` review, verification, and source-PR workflow.
- **[skill-designer.md](docs/skill-designer.md):** a 20-minute fill-in guide for writing your first skill.
- **[resources.md](docs/resources.md):** pi's docs, the Agent Skills spec, and K-State Library guides.
- **[pi-cli-reference.md](docs/pi-cli-reference.md):** every `pi` command and option.

And in `presentation-resources/`:

- **beyond-the-prompt.pptx** and **beyond-the-prompt.html:** the workshop slides. Open the HTML file in a browser for the interactive version.
- **pi-cheat-sheet.pdf:** a one-page `pi` reference to print.
- **ai-workshop-resources.pdf:** the resources page as a printable handout.

## Thanks

A special shoutout to **Raymond Deiser** ([@rdeiser](https://github.com/rdeiser)), who created the [Heartland AI Symposium pi workshop wiki](https://github.com/sawyerb-ksu/heartland-ai-symposium-pi/wiki) and organized its resources. The example kits, skill designer, cheat sheet and resources page in this repo all come from that work.

---

Workshop by Sawyer Borror · sawyerb@ksu.edu

Configure coding integrations with `./setup.sh --integrations` (also included in
normal setup). It asks for GitHub and Redmine settings and writes personal native
Pi MCP configuration without saving tokens. See the
[setup variables and current limitations](docs/dave-implementation.md#personal-integration-setup).

DAVE also provides `dave_review`, `dave_implement` (isolated Git worktrees), and
`dave_publish_update` (approved draft PRs via GitHub API). Hub installation is
opt-in with `DAVE_HUB_VERSION=<reviewed-version> ./setup.sh --hub`. See the
[completion notes](docs/dave-implementation.md#completion-pass--user-testing-deferred)
for scope and user-testing requirements. These latest additions are untested.

### Guard pattern approvals

When Guard asks, choose **Allow a pattern…** or **Deny a pattern…** for Bash,
read, edit, or write. Guard suggests patterns based on the pending file:
for `cat docs/guide.md`, choose `cat docs/*.md` (recommended), `cat docs/*`,
or the broader `cat docs/**/*`. The selected suggestion opens in an editor,
so you can change any part of the path before saving. You can also start with
the exact current command/path. Shell suggestions preserve the program and
other arguments, and only infer file operands for familiar file-reading commands;
ambiguous commands and directory operands use the custom editor instead.
Choose **This session** (first choice) or **This project**, then confirm the
preview. Each pattern applies only to its selected tool and working folder.
Read, edit, write, and Bash permissions are independent.

`*` matches within one directory; `**` includes subdirectories; `?` matches one
character within a directory. Shell patterns require the same program, flags,
and argument count. Compound commands, shell expansions, and symlink paths
retain normal approval handling. Existing explicit deny rules take precedence.
Patterns must match the pending call before they can be saved; canceling blocks
that call. Every approval step explains that Esc closes the entire approval flow
and blocks the pending call; it does not return to the previous question, and
no new rule is saved. Judge-flagged dangerous calls retain the existing restriction against
saving reusable allow rules.

Use `/guard` to view patterns and `/guard clear-patterns` to clear session
patterns. Session patterns also clear on session start and `/guard on`.
Project patterns live in `.pi/guard.jsonc`, where they can be edited or removed.
PowerShell and other tools retain their existing approval flow.

Pattern approval changes have not been tested; user testing is deferred as requested.
