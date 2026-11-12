# DAVE Redmine connector

Run `./setup.sh --integrations`, supply the Redmine HTTPS URL and project
identifier, and leave the optional external bridge URL empty. Export
`DAVE_REDMINE_API_KEY` when starting Pi. Enable REST access in Redmine and use a
key restricted to the intended project.

Pi connects through its native stdio MCP transport. The entry point is
`mcp/campus-events/redmine-server.mjs` so it reuses the SDK and Zod already
installed by setup; the independent REST client lives here. No MCP adapter or
additional package install is needed.

Tools: `list_issues` (offset, limit up to 100, open/closed/all status) and
`get_issue` (positive numeric ID). Both are read-only and project-filtered.
The project identifier is resolved to a numeric ID before issue requests;
subprojects are excluded and returned project IDs are checked. Redirects are
rejected, requests time out after 15 seconds, and responses are limited to 1 MiB.
No create, update, delete or comment tools are exposed.

Verification: `node scripts/verify-dave.mjs` exercises REST behavior with an
injected transport. Live Redmine credentials and stdio end-to-end operation
remain unverified in the restricted execution environment.

REST reference: https://www.redmine.org/projects/redmine/wiki/Rest_Issues
