import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import guard from '../.pi/extensions/guard.ts';

function harness(config, hasUI = false) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'dave-guard-'));
  mkdirSync(path.join(cwd, '.pi'));
  writeFileSync(path.join(cwd, '.pi/guard.jsonc'), JSON.stringify(config));
  const hooks = {}, commands = {};
  let prompts = 0;
  guard({on: (name, fn) => {hooks[name] = fn;}, registerCommand: (name, cmd) => {commands[name] = cmd;}, getAllTools: () => []});
  const ctx = {cwd, hasUI, ui: {notify() {}, select: async () => {prompts++; return 'Yes, for the rest of this session';}}};
  return {hooks, commands, ctx, prompts: () => prompts,
    call: (toolName, input) => hooks.tool_call({toolName, input}, ctx)};
}
const config = {rules: [{command: 'git push', mode: 'never'}, {command: 'rm', mode: 'ask'}], otherCommands: 'check', noOneToAsk: 'allow'};

test('explicit denies and unresolved headless actions remain blocked', async () => {
  const h = harness(config);
  assert.equal((await h.call('bash', {command: 'git push'})).block, true);
  assert.equal((await h.call('bash', {command: 'rm notes.md'})).block, true);
  assert.equal((await h.call('mcp__unknown__send', {text: 'hello'})).block, true);
});
test('session grant applies only to the approved action', async () => {
  const h = harness(config, true);
  await h.call('bash', {command: 'rm first.md'});
  await h.call('bash', {command: 'rm first.md'});
  assert.equal(h.prompts(), 1);
  await h.call('bash', {command: 'rm second.md'});
  assert.equal(h.prompts(), 2);
});
test('permissive dial cannot bypass explicit approval', async () => {
  const h = harness({...config, dial: 'just-do-it'});
  assert.equal((await h.call('bash', {command: 'rm notes.md'})).block, true);
});
test('off skips rules but keeps the last look; on restores the config', async () => {
  const h = harness(config);
  await h.commands.guard.handler('off', h.ctx);
  assert.equal(await h.call('bash', {command: 'rm notes.md'}), undefined);
  assert.equal(await h.call('bash', {command: 'git push'}), undefined);
  assert.equal((await h.call('bash', {command: 'rm -rf ~'})).block, true);
  await h.commands.guard.handler('on', h.ctx);
  assert.equal((await h.call('bash', {command: 'rm notes.md'})).block, true);
  assert.equal((await h.call('bash', {command: 'git push'})).block, true);
});
test('a new session turns guard back on', async () => {
  const h = harness(config);
  await h.commands.guard.handler('off', h.ctx);
  await h.hooks.session_start({}, h.ctx);
  assert.equal((await h.call('bash', {command: 'rm notes.md'})).block, true);
});
test('status shows on/off', async () => {
  const h = harness(config);
  const said = [];
  h.ctx.ui.notify = (s) => said.push(s);
  await h.commands.guard.handler('', h.ctx);
  await h.commands.guard.handler('off', h.ctx);
  await h.commands.guard.handler('', h.ctx);
  assert.match(said[0], /guard is ON/);
  assert.match(said[2], /guard is OFF/);
});
