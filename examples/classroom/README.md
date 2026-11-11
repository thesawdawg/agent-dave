# Classroom files

A classroom file lets a teacher shape what DAVE may do in a class. It has base rules for every lesson, plus lessons that students switch between with `/guard lesson`. It uses the same rule language as `.pi/guard.jsonc`, so anything you can write there works here too.

[intro-to-computing.jsonc](intro-to-computing.jsonc) is a sample with three lessons: read-only exploring, note-taking, and research.

## Try it

1. In `.pi/guard.jsonc`, add `"classroom": "examples/classroom/intro-to-computing.jsonc",` (there's a commented line to switch on).
2. Start pi. `/guard` shows the classroom, and `/guard lesson` lists its lessons.
3. `/guard lesson 1-explore` switches lessons. DAVE now has only read, grep, find and ls.
4. `/guard test pip install requests` shows how both layers decide it, with the teacher's note.

## Sharing it with a class

Host the file at a public `https://` address (a GitHub repo's *Raw* link works) and have students set `"classroom": "https://…/your-class.jsonc"`. Then:

- **It's downloaded when a session starts**, not during tool calls, with a 5-second limit. Edit the file and students get the new version in their next session, or right away with `/guard refresh`.
- **A copy is saved** in `~/.pi/agent/guard-classroom/`. If the network is down, the server errors, or a new version has a mistake, the guard uses the saved copy and says so. With no saved copy yet, it asks before every change.
- **Only `https://`** is accepted, plus `http://localhost` so you can preview a file from your own computer (`python3 -m http.server` in its folder).
- Bump `"version"` when you change the file. The audit file records the version, its fingerprint, and whether the copy was fresh or saved, so you can see which rules a student had.

## How it decides

The student's own rules and the teacher's file each decide every tool call, and the **stricter** answer wins: allow < ask < never. A student can make a lesson stricter, but not looser:

- The student's `just-do-it` dial skips only the student's own questions, never the teacher's.
- **Always allow** isn't offered when the teacher's file is asking.
- A tool not in a lesson's `tools` list is hidden from DAVE, and refused if he calls it anyway.
- A missing or broken classroom file makes the guard ask before every change until it's fixed.

| In the file | What it does |
| --- | --- |
| `class`, `version` | Shown to students, and recorded in the audit file, so you can tell which copy they had |
| `base.rules`, `base.dial`, `base.policy` | Apply in every lesson |
| `lessons.<name>.title` | Shown by `/guard lesson` |
| `lessons.<name>.tools` | The only tools DAVE has in that lesson (`*` works, MCP tools too). Leave out to keep all of them |
| `lessons.<name>.rules`, `.dial`, `.policy` | Added to the base ones while that lesson is picked |
| `"note"` on any rule | Shown to the student, and passed to DAVE, when that rule asks or blocks |

## What it is and isn't

It's scaffolding for good-faith students, not a lock: a student who edits the files on their own computer can get around it. What it does give you is a record. The guard's audit file notes the classroom file and version in force, every lesson switch, `/guard off`, and both layers' verdicts on each call. Students can hand in a readable copy with `/guard audit export`. See the [Safety Guard](https://github.com/thesawdawg/agent-dave/wiki/Safety-Guard) wiki page.
