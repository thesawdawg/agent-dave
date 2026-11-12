import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {configure, serviceUrl} from '../scripts/configure-dave.mjs';

test('configuration merges native MCP and does not persist secrets', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'dave-config-'));
  await writeFile(path.join(directory, 'mcp.json'), JSON.stringify({mcpServers: {existing: {command: 'local-server'}}}));
  const env = {PI_CODING_AGENT_DIR: directory, DAVE_GITHUB_REPOSITORY: 'owner/repo', DAVE_GITHUB_BASE: 'main', DAVE_GITHUB_TOKEN: 'secret-test-value', DAVE_REDMINE_URL: 'https://redmine.example', DAVE_REDMINE_PROJECT: 'demo'};
  await configure(env);
  const text = await readFile(path.join(directory, 'mcp.json'), 'utf8');
  const mcp = JSON.parse(text);
  assert.ok(mcp.mcpServers.existing);
  assert.ok(mcp.mcpServers['dave-redmine'].args[0].endsWith('redmine-server.mjs'));
  assert.equal(mcp.mcpServers['dave-redmine'].env.DAVE_REDMINE_API_KEY, '${DAVE_REDMINE_API_KEY}');
  assert.equal(mcp.mcpServers['dave-github'].headers['X-MCP-Readonly'], 'true');
  assert.ok(!text.includes('secret-test-value'));
  assert.equal((await stat(path.join(directory, 'dave.json'))).mode & 0o777, 0o600);
  await configure({...env, DAVE_GITHUB_REPOSITORY: ''});
  assert.equal(JSON.parse(await readFile(path.join(directory, 'mcp.json'))).mcpServers['dave-github'].enabled, false);
});
test('unsafe URLs and invalid limits fail before writing', async () => {
  for (const url of ['http://remote.example', 'https://user:secret@example.com', 'https://example.com?key=secret']) assert.throws(() => serviceUrl(url));
  const directory = await mkdtemp(path.join(tmpdir(), 'dave-invalid-'));
  await assert.rejects(configure({PI_CODING_AGENT_DIR: directory, DAVE_MAX_WORKERS: '3'}), /limits/);
  await assert.rejects(readFile(path.join(directory, 'dave.json')), {code: 'ENOENT'});
});
