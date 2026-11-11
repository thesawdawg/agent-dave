# Master DAVE: intent and decision questions

Status: all 35 interview questions answered. The selections below inform the [candidate catalog](master-dave-candidates.md); detailed implementation parameters remain open where noted. The interview was presented in chat in multiple-choice batches, with a free-text option for every question. Answers express design intent and do not authorize installation or publication during this documentation task.

## Recorded answers

| Question | Selection | Confirmed direction |
|---|---|---|
| 1 — Relationship to dave-harness | A | An independent Pi-based agent; reuse selected ideas from the earlier Python harness. No replacement or shared implementation has been selected. |
| 2 — Initial coding tasks | A + B | Bug fixes, incremental features, code reviews, new projects, architecture, and initial implementation. Acceptance scenario types are selected in 32; concrete target repositories remain open. |
| 3 — Language/framework scope | A; mainly Python | Follow existing project stacks, starting with one representative repository; Python is the main language. Specific frameworks, repository, and scale remain open. |
| 4 — Audience | C, with clarification | Sawyer's personal agent, open-sourced for others to use. Public availability does not by itself imply team features or a hosted service. |
| 5 — Responsibilities | B | Coding plus issue tracking and project status. Initial services are selected in 14; tracker write permissions remain open. |
| 6 — Task ownership | A | Plan, implement, debug, and review an assigned task; switch roles as needed. |
| 7 — Delegation | A | Delegate within an assigned task using scoped permissions and budgets. Answer 28 sets the initial maximum to two workers; exact time/token/spending caps remain open. |
| 8 — Automatic actions | A | File edits, checks, and feature branches are authorized within an assigned task. Ask before dependency installs, migrations, and commits. Never push; retain approval before deleting, sending, or publishing. This is a future DAVE design choice, not permission to install candidates during this research. |
| 9 — Writing-worker isolation | A | Separate Git worktrees for writing workers; the main agent reviews integration and preserves existing changes. |
| 10 — Completion evidence | A | Meet acceptance criteria, pass relevant tests/checks, and review the diff; verify UI changes in a browser. Explicitly report skipped or unavailable checks. |
| 11 — Memory | A, with visibility requirement | Per-project memory plus a small global preference store, both readable and editable. Explicitly display every memory addition and its level (project or global). Retention and update/removal notification details remain open. |
| 12 — Initial environment | A | Linux terminal and VS Code first; keep the design portable. |
| 13 — Models | A | Configurable providers and models per role, with explicit hosted/local profiles. Exact providers, models, and spending limits remain open. |
| 14 — Initial integrations | A | GitHub, Redmine, and GitHub Actions. Account details and permitted write operations remain open. |
| 15 — Private information | A, approaching B wherever practical; user override allowed | Prefer local processing, storage, tools, inference, and embeddings wherever practical. Approved model providers may receive task-relevant code when needed; search and other external services receive public/general queries only by default. Aim to minimize external disclosure without claiming guaranteed offline operation. User overrides follow the task/session scope selected in 30; persistence requires explicit selection. |
| 16 — Costs and hosting | A | Open-source core; paid or hosted services are optional and explicitly configured. |
| 17 — Browser access | A | Local apps by default; signed-in sites when authorized, using separate browser profiles. |
| 18 — Custom extensions and core architecture | A, with Guard/Judge requirement | Maintain a few focused DAVE-specific extensions and reuse existing tools elsewhere. Always maintain Guard and Judge with DAVE as core architecture; invocation and outage policies are recorded in 33–34. |
| 19 — Coding conventions | A | Follow each repository's conventions, supplemented by shared DAVE defaults. |
| 20 — Clarification | A | Ask about material uncertainties, use reasonable defaults for routine choices, and write plans for substantial work. |
| 21 — Test-first development | A, with minimal-test requirement | Prefer test-first work for fixes and risky behavior changes. Keep tests minimal and meaningful; avoid excessive test generation, redundant coverage, and tests that merely mirror implementation. |
| 22 — Nearby improvements | A, with categorized intake | Make changes needed for the assigned task; categorize unrelated improvements and log them as tasks instead of expanding the current scope. Use the taxonomy selected in 35 and evaluate Clef/System One to assist uncertain labels. |
| 23 — Task handoff | A | Concise change summary, verification evidence, reviewable diff, limitations, and relevant documentation updates. Commits and external updates retain their approval rules. |
| 24 — Project instructions | A, with inferred-standards fallback | Read trusted project instructions, follow them alongside the user's request, and ask about unresolved conflicts. If instructions are absent, inspect the repository to establish perceived standards. Distinguish inferred conventions from explicit instructions; whether to write a project instruction file remains open. |
| 25 — Task/session coordination | A, with pi-agent-hub | One active task per session with a visible follow-up queue. Use pi-agent-hub to manage individual DAVE instances and their subtasks. Hub integration and the child-agent/task-state producer still need compatibility review; no installation is authorized by this selection. |
| 26 — Restart and background work | A | Persist task, plan, decisions, pending questions, and worker records; verify actual state on resume. Workers continue only when explicitly left running. |
| 27 — Failure recovery | A | Allow two retries for transient tool failures. Change approach for persistent failures, then ask if still unresolved. Do not treat permission denials as transient tool failures. |
| 28 — Resource controls | A | Start with at most two workers; support configurable time, token, and spending limits. Exact caps and target hardware remain open. |
| 29 — Guard/Judge hardening and isolation | B, with first-hook requirement | Use Guard and Judge initially; add OS/container isolation for selected projects later. Refine the architecture so Guard–Judge is the first hook whenever any tool or command is invoked. Harden enforcement and improve the user experience for configuring/modifying rules. Hook ordering and coverage must be verified across actual execution paths; this is a design requirement, not a claim about current enforcement. |
| 30 — Permission scope | A | Task/session grants by default; workers receive narrower grants. Persistent project rules require an explicit user choice. Exact operations requiring fresh approval retain the earlier rules. |
| 31 — Updates | A, with /dave-update workflow | Pin a reviewed baseline and review upgrades before adoption. Add a command such as `/dave-update` to fetch updates, review them, implement and verify package changes, then automatically open a PR against `thesawdawg/agent-dave` if a matching PR does not already exist. Reuse/report an existing matching PR. This is a requested future command, not authorization to update or publish now; see the [workflow proposal](master-dave-update.md). |
| 32 — v1 acceptance | A plus Guard/Judge enforcement | Demonstrate a Python bug fix, small feature, and delegated task with restart/resume, plus Guard/Judge enforcement. Each coding scenario must demonstrate permissions and relevant verification without excessive test generation. |
| 33 — Judge invocation and v2 pattern review | A, with v2 addition | Run deterministic Guard rules first on every invocation; call Judge for unknown or ambiguous actions. For v2, add periodic Judge review of the previous configurable `n` tool events to detect suspicious patterns missed by individual decisions. Cadence, event scope, retention, and response to a finding remain implementation decisions. |
| 34 — Judge outage/uncertainty | A | Keep deterministic rules enforced; unresolved actions require user approval and remain blocked when no interactive user can approve. Unavailability or uncertainty never becomes implicit permission. |
| 35 — Improvement taxonomy | A | Classify type as bug, security, performance, maintainability, docs, or feature, with separate impact/urgency. Clef assists uncertain labels. Classification does not authorize execution or external task creation. |

## Purpose and daily work

1. Is this Pi-based DAVE independent of the earlier Python dave-harness, a replacement, or a prototype for it? Which ideas or existing specifications should carry over?
2. What are the three most common coding tasks DAVE should finish? Give one concrete input and expected result for each, such as a bug report becoming a tested local patch.
3. Which languages/frameworks and repository sizes must it support first? Include monorepos, multiple repositories, legacy systems, or generated code if relevant.
4. Is DAVE for you alone, the K-State AI Studio team, or distribution to other users? How technical will its users be?
5. What remains outside its job: project management, research, email/calendar, design, deployment, data analysis, or anything else?

## Autonomy and collaboration

6. Rank implementation, planning, code review, debugging, and end-to-end task ownership. Should DAVE switch roles automatically or only when requested?
7. When may DAVE use worker agents: only on request, after an approved plan, or independently within an assigned task? Should reviewers and writers have different rules?
8. Which local actions are preauthorized within an assigned task: file edits, dependency installs, migrations, branch creation, commits, or opening a PR? The existing never-push preference remains the default. Deleting/sending/publishing still requires approval under the current AGENTS.md.
9. Should writing workers use isolated Git worktrees? Who reviews and integrates their results, and what should happen if the target checkout already has uncommitted changes?
10. What evidence counts as done: targeted tests, the full suite, lint/type checks, a browser walkthrough, a reviewed diff, acceptance criteria, or a combination? How should DAVE report unavailable checks?
11. Should memory persist per repository, across projects, or only when explicitly saved? Who may edit or retire remembered decisions?

## Environment and integrations

12. Which operating systems and interfaces are required: Linux, macOS, Windows/WSL, terminal, VS Code, web, or headless jobs? Is one the initial supported environment?
13. Which model providers should it use, and what are the monthly/per-task limits? Must local models or offline operation be supported, and should different roles use different models?
14. Which services belong in v1: GitHub/GitLab, Redmine/Linear/Jira, databases, Docker, CI, Sentry, or others? Rank the top three; name the real systems so research can narrow.
15. May external services receive private repository code or project-specific search terms? Distinguish model inference from documentation/search APIs, embeddings, telemetry, and error-monitoring data.
16. Are paid hosted services acceptable, or should candidates be open source and self-hostable? Is “no additional subscription” a requirement?
17. Should browser tools inspect local apps, signed-in websites, or both? Should they use isolated test accounts/profiles, and must they generate reusable regression tests?
18. Are you willing to maintain custom Pi extensions? What is the acceptable custom-code budget, and who will maintain compatibility when Pi changes?

## Coding standards and how work starts

19. Should DAVE discover each repository's conventions or enforce a shared baseline? Which of your existing skills/rules should become portable defaults, and which should remain personal?
20. How much clarification should DAVE do before coding? Should it ask about every material uncertainty, propose defaults, or use a dedicated planning session for larger tasks?
21. Is test-first development required for behavior changes, preferred for risky code, or optional? How should prototypes, documentation, configuration, and existing untested code be handled?
22. Should DAVE proactively improve nearby code, or keep changes within the assigned task unless you approve a scope expansion? How should discovered unrelated defects be recorded?
23. What should the final handoff contain: concise change summary, diff, test evidence, known limitations, commit, PR draft, documentation, or a runnable preview?
24. Should DAVE execute instructions found in a repository automatically, and how should it handle conflicting project rules, skill instructions, and your direct request?

## Continuity, controls, and rollout

25. Do you want one active task per session, a task queue, or a coordinator across projects? Should it notice drift from priorities or simply finish the current coding assignment?
26. What should survive restart or compaction: approved plan, decisions, next step, worker state, check results, unfinished questions, or all of these? Should background work survive the main session exiting?
27. When a worker stalls, a tool fails, or checks repeatedly fail, should DAVE retry, change approach, ask, or stop? Set rough retry/time limits if you have them.
28. What resource limits matter besides model spend: startup time, RAM, CPU/GPU use, context length, task duration, or worker count? What local hardware should the baseline assume?
29. Is the existing approval guard enough for the initial baseline, or do you want OS/container isolation too? Which repositories or operations need stricter restrictions?
30. Should permissions be per session, per project, or global? Should a worker inherit the parent's grant or receive a narrower task-specific grant? Which operations must always require a fresh decision?
31. For a shared installation, how should packages/skills be versioned and updated: a centrally reviewed release, project-pinned versions, or personal customization? Are license constraints relevant to redistribution?
32. What are three measurable acceptance scenarios for v1, and what failure would make you reject the design? For example: reproduce/fix a real bug, implement a small feature with relevant checks, and review a dependency update without changing files.

## Follow-ups from the selected architecture

33. When should the Judge model run within the mandatory first Guard–Judge hook?

    A. Evaluate deterministic rules on every invocation; call Judge for unknown or ambiguous actions **(Recommended)**.
    B. Evaluate both deterministic rules and Judge on every invocation.
    C. Evaluate rules on every invocation; call Judge for mutating/external actions and ambiguous reads.
    D. Free text: specify triggers, exceptions, or a different policy.

34. What should happen when Judge is unavailable or uncertain?

    A. Keep deterministic rules enforced; require user approval for unresolved actions and block those actions when no user can approve **(Recommended)**.
    B. Block all tools and commands until Judge is healthy.
    C. Allow only actions explicitly permitted by deterministic rules; block all others until Judge recovers.
    D. Free text: define outage behavior, thresholds, or recovery limits.

35. How should unrelated improvements be categorized?

    A. Type (bug, security, performance, maintainability, docs, feature) plus separate impact/urgency; use Clef to assist uncertain labels **(Recommended)**.
    B. Start with bug, improvement, or idea; refine later.
    C. Use the tracker's existing categories and priority scheme.
    D. Free text: specify the taxonomy, classifier role, or storage location.

## Decisions to record after the interview

| Decision | Current status | Candidates affected |
|---|---|---|
| Relationship to dave-harness and intended users | Independent Pi agent; personal use and open-source distribution | C2, C4, C6, distribution |
| Initial languages/frameworks and repository scale | Existing stacks, mainly Python; framework/repository/scale open | E1 versus M5, S7–S10 |
| Implementation/review/delegation authority | Own assigned tasks; scoped delegation; isolated writers; approval rules recorded in answers 8–9 | E3–E6, C2–C3 |
| Required verification and handoff | Acceptance criteria, minimal meaningful tests/checks, diff review, browser checks for UI; concise handoff with evidence, limitations, and relevant docs | S1–S7, C1 |
| Privacy, providers, and spending limits | Local-first privacy, approved inference providers, public/general external searches, user overrides; provider/model/budget details open | E2, E7–E9, M1–M8, C7 |
| Initial forge/tracker/browser/database services | GitHub, Redmine, and GitHub Actions; local browser access by default and authorized signed-in sites in separate profiles; database details/write permissions open | M1, M3–M4, M7–M8, C6 |
| Memory ownership and project boundaries | Project memory plus global preferences; explicitly display additions and level; retention details open | E7, M12, C4 |
| Supported platforms and custom-code budget | Linux terminal/VS Code first; a few focused custom extensions, always including maintained Guard and Judge | All extension trials, C1–C7 |
| Core approval architecture | First hook for every tool/command; rules first, Judge for unknown/ambiguous actions; unresolved decisions require approval or block without an interactive user; improve hardening and rule UX | Existing Guard/Judge, C3, E3–E4, E9–E13 |
| Coding and clarification defaults | Repository conventions plus shared defaults; infer standards when project instructions are absent; clarify material uncertainties and plan substantial work | S1–S6, E5–E6, C2 |
| Unrelated improvement intake | Bug/security/performance/maintainability/docs/feature, separate impact/urgency, Clef assistance for uncertain labels | C8, Guard/Judge connection |
| Instance and task coordination | One active task per session and visible follow-up queue; pi-agent-hub selected for instance/subtask management | E12–E13, E3, C2 |
| Recovery, resources, and isolation | Persist task/worker records and revalidate on resume; two transient-failure retries; max two workers initially; Guard/Judge first, selected-project isolation later | C2–C3, C7, E9, E12–E13 |
| Grants and overrides | Task/session scope by default; narrower worker grants; explicit choice for persistent project rules | C3, E3–E4, E12–E13 |
| Package/skill maintenance | Reviewed pinned baseline; `/dave-update` fetch/review/implement/verify workflow and automatic matching-PR reuse or creation on source | C9, M1, C3, [update proposal](master-dave-update.md) |
| v1 acceptance scenarios | Python fix, small feature, delegated task/resume, plus Guard/Judge enforcement | Final shortlist and trial plan |
| v2 pattern detection | Periodic Judge review of the last configurable `n` tool events; cadence and response policy to specify | C3, event records, local Judge |

## Implementation details still to resolve

The interview is complete; these are configuration and integration details rather than unanswered selections: representative repositories/frameworks, exact provider/model profiles and limits, compatible Pi/Hub/runner versions, memory retention, integration credentials/write scopes, task storage and deduplication, and update activation/PR ownership behavior. V2 pattern review also needs event scope, cadence, redaction, retention, and finding-response settings. Review and select these in the implementation plan; do not treat unspecified values as approved defaults.

No answer or selection in this document authorizes installation by itself; implementation should follow an explicit request after review.
