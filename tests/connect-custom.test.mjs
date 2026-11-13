import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';

const run = promisify(execFile);

test('connect.mjs --custom saves any OpenAI-compatible endpoint and reports the chosen model', async (t) => {
  const server = createServer((req, res) => {
    if (req.url !== '/v1/models') { res.statusCode = 404; return res.end(); }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({data: [{id: 'small-7b'}, {id: 'big-70b'}]}));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const agent = mkdtempSync(path.join(tmpdir(), 'dave-connect-'));
  writeFileSync(path.join(agent, 'models.json'), JSON.stringify({providers: {aistudio: {baseUrl: 'https://studio.example'}}}));
  const result = path.join(agent, 'endpoint.json');
  await run(process.execPath, ['scripts/connect.mjs', '--custom', '--result', result], {
    env: {...process.env, PI_CODING_AGENT_DIR: agent, ENDPOINT_NAME: 'Home Lab', ENDPOINT_URL: `http://127.0.0.1:${server.address().port}/v1`, ENDPOINT_MODEL: 'big-70b'},
  });

  assert.deepEqual(JSON.parse(readFileSync(result, 'utf8')), {provider: 'home-lab', model: 'big-70b', contextWindow: null, baseUrl: `http://127.0.0.1:${server.address().port}/v1`});
  const providers = JSON.parse(readFileSync(path.join(agent, 'models.json'), 'utf8')).providers;
  assert.equal(providers.aistudio.baseUrl, 'https://studio.example', 'other providers are kept');
  assert.equal(providers['home-lab'].apiKey, 'none', 'a keyless endpoint gets a placeholder key');
  assert.deepEqual(providers['home-lab'].models.map((m) => m.id), ['big-70b', 'small-7b']);
});

test('connect.mjs --custom --current offers the saved endpoint as the defaults', async (t) => {
  const server = createServer((req, res) => {
    if (req.url !== '/v1/models') { res.statusCode = 404; return res.end(); }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({data: [{id: 'small-7b'}, {id: 'big-70b'}]}));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const agent = mkdtempSync(path.join(tmpdir(), 'dave-connect-'));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  writeFileSync(path.join(agent, 'models.json'), JSON.stringify({providers: {
    'home-lab': {name: 'Home Lab', baseUrl, api: 'openai-completions', apiKey: 'sekret', models: [{id: 'small-7b'}]},
  }}));
  const result = path.join(agent, 'endpoint.json');
  const child = run(process.execPath,
    ['scripts/connect.mjs', '--custom', '--current', 'home-lab', '--current-model', 'big-70b', '--result', result],
    {env: {...process.env, PI_CODING_AGENT_DIR: agent}});
  child.child.stdin.end(); // Enter on every question: the saved values are the answers
  const {stdout} = await child;

  assert.match(stdout, /\[Home Lab\]/, 'the saved name is the default');
  assert.ok(stdout.includes(`[${baseUrl}]`), 'the saved address is the default');
  assert.match(stdout, /keep the saved one/, 'Enter keeps the saved key');
  assert.match(stdout, /\[big-70b\]/, 'the current model is the default');
  assert.deepEqual(JSON.parse(readFileSync(result, 'utf8')),
    {provider: 'home-lab', model: 'big-70b', contextWindow: null, baseUrl});
  const providers = JSON.parse(readFileSync(path.join(agent, 'models.json'), 'utf8')).providers;
  assert.equal(providers['home-lab'].apiKey, 'sekret', 'the saved key is kept');
});
