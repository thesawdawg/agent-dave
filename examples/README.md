# Examples

Finished pieces to learn from, borrow, or use as a backup during the workshop. Nothing here loads when you start pi at the top of the repo: pi reads `.pi/` only from the folder you start it in.

## personas/: same brain, different co-worker (slide 17)

Three finished ID badges: **GRACE** (grant-writing helper), **LENNY** (lab-notebook keeper) and **CORA** (course-site editor). Each has a short *What you know right now* section, so asking *"What should I work on first today?"* gets an answer that fits the role.

To try one, open it next to the repo's `AGENTS.md` in VS Code, copy its text in, save, and start a new session. Copy DAVE's text back when you're done (or use `checkpoints/`).

## demo/: from the live demos

| File | Slide | What it is |
|---|---|---|
| `demo/doc-sync/SKILL.md` | 21, DAVE writes his own skill | The skill DAVE wrote in the demo. Copy the `doc-sync` folder to `.pi/skills/`, start a new session and ask *"sync my docs"*. |
| `demo/standup.ts` | 32, DAVE upgrades himself | The extension DAVE wrote in the demo. Copy it to `.pi/extensions/`, run `/reload`, then `/standup`. |

Both are good models for writing your own skill or extension.

To see the safety interlock from slide 29b, run `/guard test rm events.ics` in pi: it should say ASK, decided by the delete-files rule in `.pi/guard.jsonc`.

## classroom/: a teacher's rules

A sample classroom file for the guard: base rules for every lesson, plus three lessons (read-only exploring, note-taking, research) that students switch between with `/guard lesson`. Turn it on with `"classroom"` in `.pi/guard.jsonc`. See [classroom/README.md](classroom/README.md).

## kits/: more skills to practice on

Three ready-made skills with fictional sample data: **webpage-briefing**, **spreadsheet-check** and **scan-renamer**. Unlike the folders above, each kit is a project of its own: start pi inside the kit folder and its skill loads from `.agents/skills/`. See [kits/README.md](kits/README.md).

## More

- `samples/`: practice inputs (messy meeting notes, research topics, skill ideas, prompts).
- `checkpoints/`: the finished files for each loop, if you fall behind.
