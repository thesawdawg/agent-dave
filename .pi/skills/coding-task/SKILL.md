---
name: coding-task
description: Plan, implement, verify, and hand off a bounded coding task with DAVE.
---
Read trusted project instructions and inspect existing code before choosing conventions.
State the acceptance criteria and a short plan. Ask only about material uncertainty.
Use /dave start to track one task; queue unrelated discoveries instead of expanding scope.
For a defect, reproduce it before changing code. Prefer minimal behavioral tests for risky changes.
Implement small reversible changes using the existing stack. Preserve unrelated modifications.
Run relevant checks, inspect the diff, and exercise UI changes in a browser when available.
Record verification commands, outcomes, unavailable checks, decisions and next steps in the task board.
On resume, inspect actual files and rerun stale checks; recorded evidence is not proof of current state.
Report changes, evidence and limitations. Ask before installs, migrations, commits, deletion or publication.
Never git push. Do not bypass Guard or a denied action through another tool.
Use dave_review for bounded read-only second opinions; its Guard approval is required.
Use dave_implement for isolated writing worktrees. It shares the reviewer capacity and time limits.
Workers cannot run shell commands; the parent reviews tracked and untracked changes and runs checks.
Never integrate automatically. Retain worktrees until the user approves cleanup.
After restart, treat running worker records as interrupted until actual state is inspected.
For memory additions, use readable project Markdown under .dave/memory/ and display each addition
with its project level. Global preferences require explicit permission and an approved location.
Log unrelated improvements in .dave/intake.md with type (bug, security, performance,
maintainability, docs, feature), impact and urgency. Logging does not authorize execution.
