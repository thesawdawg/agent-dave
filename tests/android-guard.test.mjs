import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {blockedShellRef, DEFAULT_CONFIG, guard, loadConfig, reachNote, validateMount} from '../.pi/lib/android-guard.ts';

/** A fake phone: Termux home with termux-setup-storage's links, shared storage beside it, and DAVE's protected files. */
function phone() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'dave-android-')));
  const home = path.join(root, 'home'), shared = path.join(root, 'shared'), outside = path.join(root, 'outside');
  const state = path.join(home, '.dave', 'android'), agent = path.join(home, '.pi', 'agent');
  const rules = path.join(home, 'agent-dave', '.pi', 'guard.jsonc');
  for (const dir of [path.join(home, 'storage'), path.join(shared, 'Docs'), path.join(shared, 'Download'), outside, state, path.join(agent, 'skills'), path.dirname(rules)]) mkdirSync(dir, {recursive: true});
  symlinkSync(shared, path.join(home, 'storage', 'shared'));
  symlinkSync(path.join(shared, 'Download'), path.join(home, 'storage', 'downloads'));
  symlinkSync(outside, path.join(home, 'escape'));
  const places = {home, shared, state, writeProtected: [state, agent, rules], readProtected: [path.join(agent, 'auth.json')],
    protectedNames: {read: ['.env'], write: ['.git', '.ssh']}};
  return {places, home, shared, state};
}
const cfg = () => ({...DEFAULT_CONFIG});
const refused = (promise) => assert.rejects(promise);
const write = (places, input, config = cfg()) => guard(places, config, input, places.home, 'write');

test('no mount: Termux home only; .., symlinks and shared storage are refused', async () => {
  const {places, home} = phone();
  assert.equal(await guard(places, cfg(), '~/notes/new.md'), path.join(home, 'notes', 'new.md'));
  await refused(guard(places, cfg(), '~/../outside/x'));
  await refused(guard(places, cfg(), '~/escape/x'));
  await refused(guard(places, cfg(), '~/storage/shared/Docs/a.txt'));
  await refused(guard(places, cfg(), '/sdcard/Docs/a.txt'));
});

test('a relative path resolves against the working folder, not home', async () => {
  const {places, shared} = phone();
  await refused(guard(places, cfg(), 'Docs/a.txt', shared));
});

test('mount: one folder inside shared storage, never all of it', async () => {
  const {places, shared} = phone();
  await refused(validateMount(places, ''));
  await refused(validateMount(places, '~/storage/shared'));
  const mount = await validateMount(places, 'Docs');
  assert.equal(mount, path.join(shared, 'Docs'));
  const config = {...cfg(), mount};
  assert.equal(await guard(places, config, '~/storage/shared/Docs/a.txt'), path.join(shared, 'Docs', 'a.txt'));
  assert.equal(await guard(places, config, '~/storage/emulated/0/Docs/a.txt'), path.join(shared, 'Docs', 'a.txt'), 'common mix-up of the two forms');
  await refused(guard(places, config, '~/storage/downloads/b.txt'));
});

test('the model is told the exact mounted path, its other names, and that home searches miss it', async () => {
  const {places, shared} = phone();
  const mount = path.join(shared, 'Docs');
  const note = reachNote(places, {...cfg(), mount});
  for (const want of [mount, '~/storage/shared/Docs', '/sdcard/Docs', 'does not reach the mounted folder']) assert.ok(note.includes(want), want);
  assert.match(reachNote(places, cfg()), /No shared-storage folder is mounted/);
});

test('the model cannot change its own permissions, even by moving a folder that holds them', async () => {
  const {places} = phone();
  await refused(write(places, '~/.dave/android/config.json'));
  await refused(write(places, '~/.dave'));                       // move-out, edit, move-back
  await refused(write(places, '~/.pi'));
  await refused(write(places, '~/agent-dave/.pi/guard.jsonc'));
  await refused(write(places, '~/project/.git/config'));
  assert.ok(await guard(places, cfg(), '~/.pi/agent/skills/x/SKILL.md'), 'global skills stay readable');
  await refused(guard(places, cfg(), '~/.pi/agent/auth.json'));
  await refused(guard(places, cfg(), '~/project/.env'));
});

test('config: a tampered or malformed file never crashes or widens access', async () => {
  const {places, state} = phone();
  writeFileSync(path.join(state, 'config.json'), JSON.stringify({mount: '/', allowDelete: true}));
  const tampered = await loadConfig(places);
  assert.equal(tampered.config.mount, null);
  assert.match(tampered.problem, /saved mount \/ is closed/);
  writeFileSync(path.join(state, 'config.json'), 'null');
  assert.deepEqual((await loadConfig(places)).config, cfg());
});

test('bash: shared-storage paths and the config are caught; look-alike home paths are not', async () => {
  const {places} = phone();
  assert.equal(await blockedShellRef(places, cfg(), 'cat ~/storage/downloads/a.pdf'), '~/storage/downloads/a.pdf');
  assert.equal(await blockedShellRef(places, cfg(), 'ls /storage/1A2B-3C4D/DCIM'), '/storage/1A2B-3C4D/DCIM');
  assert.equal(await blockedShellRef(places, cfg(), 'cp x $EXTERNAL_STORAGE/x'), '$EXTERNAL_STORAGE/x');
  assert.equal(await blockedShellRef(places, cfg(), 'echo {} > ~/.dave/android/config.json'), '.dave/android');
  assert.equal(await blockedShellRef(places, cfg(), 'ls ~/projects/storage/x'), null);
});
