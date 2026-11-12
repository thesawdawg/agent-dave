import test from 'node:test';
import assert from 'node:assert/strict';
import {TaskBoard} from '../.pi/lib/board.ts';

test('resume preserves plans but invalidates completion evidence', () => {
  const board = new TaskBoard();
  board.apply('start', 'Fix parser');
  board.apply('plan', 'Reproduce then fix');
  board.apply('evidence', 'Tests passed');
  const saved = structuredClone(board.state);
  board.restore([saved]);
  assert.throws(() => board.apply('done'), /fresh evidence/);
  board.apply('decision', 'Recheck current checkout');
  assert.deepEqual(saved.decisions, []);
  assert.deepEqual(board.state.plan, ['Reproduce then fix']);
  board.apply('evidence', 'Reran tests successfully');
  board.apply('done');
  assert.equal(board.state.task, '');
});
test('queue advances explicitly and corrupt records do not overwrite valid state', () => {
  const board = new TaskBoard();
  board.apply('queue', 'Review');
  board.apply('next');
  board.restore([structuredClone(board.state), {task: 12}]);
  assert.equal(board.state.task, 'Review');
  assert.throws(() => board.apply('next'));
});
