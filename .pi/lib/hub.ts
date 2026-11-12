import type { BoardState } from './board.ts';

/** Project DAVE state into Hub's documented producer-neutral context format. */
export function hubContext(state: BoardState): Record<string, unknown> {
  return {
    version: 1, updatedAt: Date.now(),
    ...(state.task ? {ticket: {id: 'dave-task', subtitle: state.task.slice(0, 64)}} : {}),
    ...(state.needsReview ? {attention: {kind: 'blocked', text: 'Resume requires fresh verification.'}} : {}),
  };
}
