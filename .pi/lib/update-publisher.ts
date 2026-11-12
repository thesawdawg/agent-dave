import {createHash} from 'node:crypto';

const ALLOWED = new Set(['.pi/baseline.json', 'mcp/campus-events/package.json', 'mcp/campus-events/package-lock.json']);
export type UpdateFile = {path: string; content: string};

/** Publish only the declared package baseline through GitHub's API, never git push. */
export async function publishUpdate(repository: string, base: string, files: UpdateFile[], evidence: string, token: string, signal?: AbortSignal): Promise<string> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !base || !token) throw new Error('Configure GitHub repository/base and DAVE_GITHUB_TOKEN first.');
  if (!evidence.trim() || !files.length || files.length > 3 || new Set(files.map(file => file.path)).size !== files.length) throw new Error('Provide unique baseline files and user verification evidence.');
  for (const file of files) {
    if (!ALLOWED.has(file.path) || file.content.length > 1024 * 1024) throw new Error('Update path or size is outside the declared baseline.');
    JSON.parse(file.content);
  }
  const api = async (route: string, method = 'GET', body?: unknown): Promise<any> => {
    const response = await fetch(`https://api.github.com/repos/${repository}/${route}`, {
      method, headers: {Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json'},
      body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`GitHub ${method} request failed: HTTP ${response.status}. Retry does not authorize overwriting branches.`);
    return response.status === 204 ? {} : response.json();
  };
  const ordered = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const identity = createHash('sha256').update(JSON.stringify({base, files: ordered})).digest('hex').slice(0, 24);
  const branch = `dave/update-${identity}`;
  const matching = async (): Promise<string | undefined> => {
    const prs = await api(`pulls?state=open&base=${encodeURIComponent(base)}&head=${encodeURIComponent(repository.split('/')[0] + ':' + branch)}`);
    return prs.find((pr: any) => pr.head?.ref === branch && pr.base?.ref === base)?.html_url;
  };
  const existing = await matching();
  if (existing) return existing;
  const head = await api(`git/ref/heads/${encodeURIComponent(base)}`);
  const commit = await api(`git/commits/${head.object.sha}`);
  const tree = await api('git/trees', 'POST', {base_tree: commit.tree.sha, tree: ordered.map(file => ({path: file.path, mode: '100644', type: 'blob', content: file.content}))});
  if (tree.sha === commit.tree.sha) return 'No changes; no PR created.';
  const next = await api('git/commits', 'POST', {message: `chore(deps): update DAVE baseline (${identity})`, tree: tree.sha, parents: [head.object.sha]});
  // Creation is atomic. Never update an existing branch, even if its name matches.
  try { await api('git/refs', 'POST', {ref: `refs/heads/${branch}`, sha: next.sha}); }
  catch (error) {
    const ref = await api(`git/ref/heads/${encodeURIComponent(branch)}`);
    const prior = await api(`git/commits/${ref.object.sha}`);
    if (prior.tree.sha !== tree.sha) throw error;
  }
  const concurrent = await matching();
  if (concurrent) return concurrent;
  try {
    const pr = await api('pulls', 'POST', {title: 'chore(deps): update DAVE baseline', head: branch, base, draft: true,
      body: `Update identity: ${identity}\n\nVerification supplied by the requester:\n${evidence}\n\nActivation requires review and a fresh session. No merge or release is authorized.`});
    return pr.html_url;
  } catch (error) {
    const raced = await matching();
    if (raced) return raced;
    throw error;
  }
}
