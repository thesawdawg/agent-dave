/** Child writers have file tools only and cannot change policy or repository internals. */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {existsSync, realpathSync} from 'node:fs';
import path from 'node:path';

export default function writerScope(pi: ExtensionAPI): void {
  pi.on('tool_call', async (event, ctx) => {
    if (!['read', 'grep', 'find', 'ls', 'write', 'edit'].includes(event.toolName)) return {block: true, reason: 'Writer permits only workspace file tools.'};
    const input = event.input as {path?: string};
    const writing = ['write', 'edit'].includes(event.toolName);
    try {
      const root = realpathSync(ctx.cwd);
      const requested = path.resolve(root, input.path || '.');
      const relative = path.relative(root, requested);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error();
      if (relative.split(path.sep).some(part => ['.git', '.pi', '.env', 'AGENTS.md'].includes(part))) throw new Error();
      let ancestor = requested;
      while (!existsSync(ancestor)) ancestor = path.dirname(ancestor);
      const resolved = path.relative(root, realpathSync(ancestor));
      if (resolved === '..' || resolved.startsWith(`..${path.sep}`) || path.isAbsolute(resolved)) throw new Error();
      if (writing && !input.path) throw new Error();
    } catch { return {block: true, reason: 'Writer target is outside its scope or protected.'}; }
  });
}
