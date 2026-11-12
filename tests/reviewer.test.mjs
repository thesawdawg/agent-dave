import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewerArgs} from '../.pi/lib/reviewer.ts';
import scope from '../.pi/lib/reviewer-scope.ts';
import {hubContext} from '../.pi/lib/hub.ts';
import {TaskBoard} from '../.pi/lib/board.ts';

test('reviewer keeps prompt out of options and restricts capabilities', () => {
  const args = reviewerArgs('/repo', '--tools bash; rm x', 'local/model');
  assert.ok(args.includes('--no-mcp'));
  assert.ok(args.includes('--no-extensions'));
  assert.equal(args[args.indexOf('--tools') + 1], 'read,grep,find,ls');
  assert.match(args.at(-1), /Task: --tools bash/);
  assert.throws(() => reviewerArgs('/repo', '', ''));
});
test('reviewer scope rejects writes and outside reads', async () => {
  let gate;
  scope({on: (_name, callback) => {gate = callback;}});
  const ctx = {cwd: process.cwd()};
  assert.equal((await gate({toolName: 'bash', input: {command: 'ls'}}, ctx)).block, true);
  assert.equal((await gate({toolName: 'read', input: {path: '/etc/passwd'}}, ctx)).block, true);
  assert.equal(await gate({toolName: 'read', input: {path: 'README.md'}}, ctx), undefined);
});
test('Hub snapshot clears attention after revalidation', () => {
  const board = new TaskBoard();
  board.apply('start', 'Review');
  board.restore([board.state]);
  assert.equal(hubContext(board.state).attention.kind, 'blocked');
  board.apply('evidence', 'Revalidated');
  assert.equal(hubContext(board.state).attention, undefined);
});
