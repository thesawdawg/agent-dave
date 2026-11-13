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
