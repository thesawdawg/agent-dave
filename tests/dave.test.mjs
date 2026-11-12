import test from 'node:test';
import assert from 'node:assert/strict';
import dave from '../.pi/extensions/dave.ts';

test('one active task, evidence gate, and restart recovery', async () => {
  const entries = [];
  let commands, start;
  const pi = {
    on: (name, fn) => { if (name === "session_start") start = fn; },
    registerTool() {},
    registerCommand: (_name, command) => { commands = command; },
    appendEntry: (customType, data) => { if (customType === 'dave-board') entries.push({type: 'custom', customType, data}); },
  };
  const messages = [];
  const ctx = {ui: {notify: text => messages.push(text)}, sessionManager: {getBranch: () => entries}};
  dave(pi);
  await commands.handler('start Fix parser', ctx);
  await commands.handler('start Replace task', ctx);
  assert.equal(entries.length, 1);
  await commands.handler('done', ctx);
  assert.equal(entries.length, 1);
  await commands.handler('queue Review docs', ctx);
  dave(pi);
  await start({}, ctx);
  assert.match(messages.at(-1), /Fix parser/);
  await commands.handler('evidence node --test passed', ctx);
  await commands.handler('done', ctx);
  assert.equal(entries.at(-1).data.task, '');
  assert.deepEqual(entries.at(-1).data.queue, ['Review docs']);
});
