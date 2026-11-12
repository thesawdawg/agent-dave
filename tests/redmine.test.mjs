import test from 'node:test';
import assert from 'node:assert/strict';
import {RedmineClient} from '../mcp/redmine/client.mjs';

function client(responses, calls = []) {
  return new RedmineClient({url: 'https://example.com/redmine', project: 'demo', apiKey: 'test-key', fetcher: async (url, options) => {
    calls.push({url, options});
    return new Response(JSON.stringify(responses.shift()));
  }});
}
test('resolves project and scopes paginated issues without credential query parameters', async () => {
  const calls = [];
  const c = client([{project: {id: 7}}, {issues: [{id: 4, project: {id: 7}}]}], calls);
  assert.equal((await c.list({offset: 25})).issues[0].id, 4);
  assert.equal(calls[0].url.pathname, '/redmine/projects/demo.json');
  assert.equal(calls[1].url.searchParams.get('project_id'), '7');
  assert.equal(calls[1].url.searchParams.get('subproject_id'), '!*');
  assert.equal(calls[1].url.searchParams.get('offset'), '25');
  assert.equal(calls[1].options.redirect, 'error');
  assert.equal(calls[1].options.headers['X-Redmine-API-Key'], 'test-key');
  assert.ok(!calls[1].url.href.includes('test-key'));
});
test('rejects cross-project results and invalid issue IDs', async () => {
  await assert.rejects(client([{project: {id: 7}}, {issues: [{id: 4, project: {id: 8}}]}]).issue(4), /not found/);
  await assert.rejects(client([]).issue(-1), /Invalid/);
  await assert.rejects(client([{project: {id: 7}}, {issues: [{project: {id: 8}}]}]).list(), /outside/);
});
test('bounds response size and omits server body from error messages', async () => {
  const c = new RedmineClient({url: 'https://example.com', project: 'demo', apiKey: 'test-key', fetcher: async () => new Response('sensitive', {status: 401})});
  await assert.rejects(c.list(), error => error.message === 'Redmine request failed (HTTP 401).');
  c.fetcher = async () => new Response('x'.repeat(1024 * 1024 + 1));
  await assert.rejects(c.list(), /exceeds/);
});
