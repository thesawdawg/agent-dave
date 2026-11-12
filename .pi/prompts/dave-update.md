---
description: Review package updates and publish a reviewed baseline PR with explicit approval
---
Read .pi/baseline.json and inspect existing changes. Keep native Pi MCP; never add
an MCP transport adapter. Fetch upstream release metadata and review source,
licenses, executable hooks and Pi/Hub compatibility. Select exact versions.
Prepare changed baseline/package files in an isolated worktree. Preserve unrelated
work and never modify running Guard code. Ask before installing dependencies.

The publish tool accepts only .pi/baseline.json, mcp/campus-events/package.json,
and its package-lock.json. Keep manifests and locks consistent. Review the full
diff and relevant checks. If the user deferred testing, request their verification
results before publication; do not invent evidence or call untested changes verified.

Call dave_publish_update only after explicit publication approval and recorded
verification. Supply complete changed file contents and the evidence. The tool
uses the configured GitHub repository/base and DAVE_GITHUB_TOKEN, reuses matching
PRs, and creates a draft via GitHub API without git push. Report the returned URL,
versions and restart requirement. No change means no empty PR. Never merge or
publish a release. Ordinary coding tasks do not authorize this workflow.
