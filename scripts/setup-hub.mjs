#!/usr/bin/env node
/** Explicit opt-in installer; strict peer checks reject incompatible Hub/Pi pins. */
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
const baseline = JSON.parse(readFileSync('.pi/baseline.json', 'utf8'));
const hub = process.env.DAVE_HUB_VERSION || baseline.hub;
if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(hub || '') || !/^\d+\.\d+\.\d+$/.test(baseline.pi)) {
  console.error('Set an exact DAVE_HUB_VERSION or baseline.hub after reviewing compatibility with baseline.pi.');
  process.exit(1);
}
const tmux = spawnSync('tmux', ['-V'], {encoding: 'utf8'});
if (tmux.status !== 0) { console.error('Install tmux before enabling Hub.'); process.exit(1); }
const directory = path.resolve('.dave/tools');
const install = spawnSync('npm', ['install', '--prefix', directory, '--save-exact', '--strict-peer-deps', '--ignore-scripts', `@earendil-works/pi-coding-agent@${baseline.pi}`, `pi-agent-hub@${hub}`], {stdio: 'inherit'});
if (install.status !== 0) process.exit(install.status || 1);
console.log(`Hub and Pi installed at ${directory}. Use the launchers in ${directory}/node_modules/.bin. Restart sessions; no running Guard was replaced.`);
