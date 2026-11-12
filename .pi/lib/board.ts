/** Serializable task state; permissions and running processes are never restored. */
export type BoardState = {
  task: string; queue: string[]; evidence: string[]; decisions: string[];
  plan: string[]; questions: string[]; needsReview: boolean;
};

export class TaskBoard {
  state: BoardState = this.empty();

  /** Return a new empty board without sharing mutable arrays. */
  empty(): BoardState {
    return {task: '', queue: [], evidence: [], decisions: [], plan: [], questions: [], needsReview: false};
  }

  /** Restore only valid records; require fresh verification after every resume. */
  restore(records: unknown[]): void {
    this.state = this.empty();
    for (const record of records) {
      if (!record || typeof record !== 'object') continue;
      const data = record as Partial<BoardState>;
      if (typeof data.task !== 'string' || !['queue', 'evidence', 'decisions'].every(key =>
        Array.isArray(data[key as keyof BoardState]) && (data[key as keyof BoardState] as unknown[]).every(v => typeof v === 'string'))) continue;
      this.state = {...this.empty(), task: data.task, queue: [...data.queue!], evidence: [...data.evidence!], decisions: [...data.decisions!]};
      for (const key of ['plan', 'questions'] as const) {
        if (Array.isArray(data[key]) && data[key]!.every(v => typeof v === 'string')) this.state[key] = [...data[key]!];
      }
      this.state.needsReview = Boolean(data.task);
    }
  }

  /** Apply a bounded task transition, throwing before mutation on invalid input. */
  apply(action: string, value = ''): string {
    value = value.trim();
    if (value.length > 16000) throw new Error('Record exceeds 16000 characters.');
    const s = this.state;
    if (action === 'status') return JSON.stringify(s, null, 2);
    if (action === 'start' && value && !s.task) this.state = {...this.empty(), queue: s.queue, task: value};
    else if (action === 'next' && !s.task && s.queue.length) this.state = {...this.empty(), task: s.queue[0], queue: s.queue.slice(1)};
    else if (action === 'queue' && value) s.queue.push(value);
    else if (['evidence', 'decision', 'plan', 'question'].includes(action) && value && s.task) {
      const key = ({decision: 'decisions', question: 'questions', plan: 'plan', evidence: 'evidence'} as const)[action as 'decision' | 'question' | 'plan' | 'evidence'];
      s[key].push(value);
      if (action === 'evidence') s.needsReview = false;
    } else if (action === 'done' && s.task && s.evidence.length && !s.needsReview) this.state = {...this.empty(), queue: s.queue};
    else throw new Error('Invalid transition: one active task; record fresh evidence before completion.');
    return JSON.stringify(this.state, null, 2);
  }
}
