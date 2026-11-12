#!/usr/bin/env node
/** Configure personal DAVE integrations without storing credentials in this repo. */
import {readFile, mkdir, writeFile, chmod, rename} from 'node:fs/promises';
import {createInterface} from 'node:readline/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

/** Validate a service URL without allowing embedded credentials. */
export function serviceUrl(value) {
  if (!value) return '';
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error('Use HTTPS (or local HTTP), without credentials, query or fragment.');
  }
  return url.href.replace(/\/$/, '');
}

/** Load a configuration, preserving unrelated keys; refuse corrupt existing files. */
async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}

/** Replace one private configuration atomically in its existing directory. */
async function saveJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', {mode: 0o600, flag: 'wx'});
  await rename(temporary, file);
  await chmod(file, 0o600);
}

/** Collect and validate settings, then merge native MCP entries without connecting. */
export async function configure(env = process.env) {
  const directory = path.resolve(env.PI_CODING_AGENT_DIR || path.join(homedir(), '.pi/agent'));
  const configFile = path.join(directory, 'dave.json');
  const mcpFile = path.join(directory, 'mcp.json');
  const old = await readJson(configFile);
  const mcp = await readJson(mcpFile);
  let reader;
  const ask = async (key, label, fallback = '') => {
    if (env[key] !== undefined) return env[key].trim();
    if (!process.stdin.isTTY) return String(fallback);
    reader ??= createInterface({input: process.stdin, output: process.stdout});
    return (await reader.question(`${label}${fallback ? ` [${fallback}]` : ''}: `)).trim() || String(fallback);
  };
  try {
    const repository = await ask('DAVE_GITHUB_REPOSITORY', 'GitHub owner/repository (blank disables)', old.github?.repository || '');
    if (repository && !/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('GitHub repository must be owner/repository.');
    const base = await ask('DAVE_GITHUB_BASE', 'GitHub base branch', old.github?.base || 'main');
    if (!base || /[\s~^:?*\[\\]/.test(base) || base.includes('..') || base.startsWith('-')) throw new Error('Invalid base branch.');
    const githubUrl = repository ? serviceUrl(await ask('DAVE_GITHUB_MCP_URL', 'GitHub native MCP URL', old.github?.mcpUrl || 'https://api.githubcopilot.com/mcp/')) : '';
    const redmineUrl = serviceUrl(await ask('DAVE_REDMINE_URL', 'Redmine website URL (blank disables)', old.redmine?.url || ''));
    const project = redmineUrl ? await ask('DAVE_REDMINE_PROJECT', 'Redmine project identifier', old.redmine?.project || '') : '';
    const redmineMcp = redmineUrl ? serviceUrl(await ask('DAVE_REDMINE_MCP_URL', 'Redmine MCP bridge URL (optional; not the website URL)', old.redmine?.mcpUrl || '')) : '';
    if (redmineUrl && !project) throw new Error('Redmine requires a project identifier.');
    const workers = Number(await ask('DAVE_MAX_WORKERS', 'Maximum combined reviewers and writers (0–2)', old.workers?.max ?? 2));
    const minutes = Number(await ask('DAVE_WORKER_MINUTES', 'Worker time limit in minutes', old.workers?.minutes ?? 15));
    if (!Number.isInteger(workers) || workers < 0 || workers > 2 || !Number.isInteger(minutes) || minutes < 1 || minutes > 120) throw new Error('Invalid worker limits.');
    const config = {...old, version: 1, github: {repository, base, mcpUrl: githubUrl}, redmine: {url: redmineUrl, project, mcpUrl: redmineMcp}, workers: {max: workers, minutes, enabled: workers > 0}};
    const servers = {...mcp.mcpServers};
    if (githubUrl) servers['dave-github'] = {url: githubUrl, headers: {Authorization: 'Bearer ${DAVE_GITHUB_TOKEN}', 'X-MCP-Readonly': 'true'}, description: 'DAVE GitHub issues, repositories and Actions; read-only by default.'};
    else if (servers['dave-github']) servers['dave-github'] = {...servers['dave-github'], enabled: false};
    if (redmineMcp) servers['dave-redmine'] = {url: redmineMcp, headers: {Authorization: 'Bearer ${DAVE_REDMINE_MCP_TOKEN}'}, description: 'User-configured Redmine MCP bridge; writes require Guard approval.'};
    else if (redmineUrl) servers['dave-redmine'] = {command: process.execPath, args: [fileURLToPath(new URL('../mcp/campus-events/redmine-server.mjs', import.meta.url))], env: {DAVE_REDMINE_URL: redmineUrl, DAVE_REDMINE_PROJECT: project, DAVE_REDMINE_API_KEY: '${DAVE_REDMINE_API_KEY}'}, description: 'Read-only issues in the configured Redmine project.'};
    else if (servers['dave-redmine']) servers['dave-redmine'] = {...servers['dave-redmine'], enabled: false};
    await mkdir(directory, {recursive: true, mode: 0o700});
    await saveJson(mcpFile, {...mcp, mcpServers: servers});
    await saveJson(configFile, config);
    console.log(`Saved DAVE settings to ${configFile}; native MCP settings to ${mcpFile}.`);
    console.log('Export DAVE_GITHUB_TOKEN / DAVE_REDMINE_API_KEY (or DAVE_REDMINE_MCP_TOKEN for an external bridge) in the Pi environment for enabled services. No tokens were saved.');
    if (redmineUrl && !redmineMcp) console.log('Built-in read-only Redmine bridge configured. Its SDK is installed by normal setup.');
    console.log('No connections, packages, workers, or publication were started. Reload Pi after changing settings.');
  } finally { reader?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  configure().catch(error => { console.error(`DAVE setup: ${error.message}`); process.exitCode = 1; });
}
