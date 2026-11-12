/** Explicitly loaded child-worker policy; no commands or additional tools. */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {realpathSync} from 'node:fs';
import path from 'node:path';

export default function reviewerScope(pi: ExtensionAPI): void {
  pi.on('tool_call', async (event, ctx) => {
    if (!['read', 'grep', 'find', 'ls'].includes(event.toolName)) return {block: true, reason: 'Reviewer permits only local read tools.'};
    const input = event.input as {path?: string};
    try {
      const root = realpathSync(ctx.cwd);
      const target = realpathSync(path.resolve(root, input.path || '.'));
      const relative = path.relative(root, target);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return {block: true, reason: 'Reviewer path is outside its workspace.'};
    } catch { return {block: true, reason: 'Reviewer cannot validate this path.'}; }
  });
}
