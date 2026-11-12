/** Project-scoped, read-only Redmine client. */
export class RedmineClient {
  /** Configure an endpoint and injectable transport; never log API keys. */
  constructor({url, project, apiKey, fetcher = fetch}) {
    const base = new URL(url);
    if (base.username || base.password || base.search || base.hash || (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)))) throw new Error('Invalid Redmine endpoint.');
    if (!/^[a-zA-Z0-9_-]+$/.test(project)) throw new Error('Invalid Redmine project identifier.');
    if (!apiKey) throw new Error('Set DAVE_REDMINE_API_KEY in the Pi environment.');
    this.base = base.href.replace(/\/$/, '') + '/';
    this.project = project;
    this.apiKey = apiKey;
    this.fetcher = fetcher;
  }

  /** Fetch bounded JSON without forwarding credentials through redirects. */
  async get(resource, params = {}) {
    const url = new URL(resource, this.base);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    const response = await this.fetcher(url, {headers: {'X-Redmine-API-Key': this.apiKey, Accept: 'application/json'}, redirect: 'error', signal: AbortSignal.timeout(15000)});
    if (!response.ok) throw new Error(`Redmine request failed (HTTP ${response.status}).`);
    let text = '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    try {
      for (;;) {
        const {value, done} = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1024 * 1024) throw new Error('Redmine response exceeds 1 MiB.');
        text += decoder.decode(value, {stream: true});
      }
      return JSON.parse(text + decoder.decode());
    } finally { await reader.cancel(); }
  }

  /** Resolve the configured identifier to the numeric ID required by issue filters. */
  async projectId() {
    const data = await this.get(`projects/${encodeURIComponent(this.project)}.json`);
    if (!Number.isSafeInteger(data.project?.id)) throw new Error('Invalid Redmine project response.');
    return data.project.id;
  }

  /** List a bounded page from exactly the configured project, excluding subprojects. */
  async list({offset = 0, limit = 25, status = 'open'} = {}) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100 || !['open', 'closed', '*'].includes(status)) throw new Error('Invalid issue query.');
    const project = await this.projectId();
    const data = await this.get('issues.json', {project_id: project, subproject_id: '!*', offset, limit, status_id: status});
    if (!Array.isArray(data.issues) || data.issues.some(issue => issue.project?.id !== project)) throw new Error('Redmine returned issues outside the configured project.');
    return data;
  }

  /** Read an issue through a project-filtered query to prevent cross-project access. */
  async issue(id) {
    if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid issue ID.');
    const project = await this.projectId();
    const data = await this.get('issues.json', {project_id: project, subproject_id: '!*', issue_id: id, status_id: '*', limit: 1});
    const issue = data.issues?.find(item => item.id === id && item.project?.id === project);
    if (!issue) throw new Error('Issue not found in the configured project.');
    return issue;
  }
}
