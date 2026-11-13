import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {blockedShellRef, DEFAULT_CONFIG, guard, loadConfig, validateMount} from '../.pi/lib/android-guard.ts';

/** A fake phone: Termux home with termux-setup-storage's links, and shared storage beside it. */
function phone() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'dave-android-')));
  const home = path.join(root, 'home'), shared = path.join(root, 'shared'), outside = path.join(root, 'outside');
  for (const dir of [home, path.join(home, 'storage'), path.join(shared, 'Docs'), path.join(shared, 'Download'), outside]) mkdirSync(dir, {recursive: true});
  symlinkSync(shared, path.join(home, 'storage', 'shared'));
  symlinkSync(path.join(shared, 'Download'), path.join(home, 'storage', 'downloads'));
  symlinkSync(outside, path.join(home, 'escape'));
  const state = path.join(home, '.dave', 'android');
  mkdirSync(state, {recursive: true});
  const places = {home, shared, state, protectedPaths: [state, path.join(home, '.pi', 'agent')]};
  return {places, home, shared, state};
}
const refused = (promise) => assert.rejects(promise);

test('no mount: Termux home only; .., symlinks and shared storage are refused', async () => {
  const {places, home} = phone();
  const cfg = {...DEFAULT_CONFIG};
  assert.equal(await guard(places, cfg, '~/notes/new.md'), path.join(home, 'notes', 'new.md'));
  await refused(guard(places, cfg, '~/../outside/x'));
  await refused(guard(places, cfg, '~/escape/x'));
  await refused(guard(places, cfg, '~/storage/shared/Docs/a.txt'));
  await refused(guard(places, cfg, '/sdcard/Docs/a.txt'));
});

test('a relative path resolves against the working folder, not home', async () => {
  const {places, shared} = phone();
  await refused(guard(places, {...DEFAULT_CONFIG}, 'Docs/a.txt', shared));
});

test('mount: one folder inside shared storage, never all of it', async () => {
  const {places, shared} = phone();
  await refused(validateMount(places, ''));
  await refused(validateMount(places, '~/storage/shared'));
  const mount = await validateMount(places, 'Docs');
  assert.equal(mount, path.join(shared, 'Docs'));
  const cfg = {...DEFAULT_CONFIG, mount};
  assert.equal(await guard(places, cfg, '~/storage/shared/Docs/a.txt'), path.join(shared, 'Docs', 'a.txt'));
  await refused(guard(places, cfg, '~/storage/downloads/b.txt'));
});

test('the model cannot reach its own permissions', async () => {
  const {places, state} = phone();
  await refused(guard(places, {...DEFAULT_CONFIG}, '~/.dave/android/config.json'));
  writeFileSync(path.join(state, 'config.json'), JSON.stringify({mount: '/', allowDelete: true}));
  const cfg = await loadConfig(places);
  assert.equal(cfg.mount, null, 'a tampered mount is dropped');
});

test('bash: shared-storage paths and the config are caught by the text check', async () => {
  const {places} = phone();
  const cfg = {...DEFAULT_CONFIG};
  assert.equal(await blockedShellRef(places, cfg, 'cat ~/storage/downloads/a.pdf'), '~/storage/downloads/a.pdf');
  assert.equal(await blockedShellRef(places, cfg, 'echo {} > ~/.dave/android/config.json'), '.dave/android');
  assert.equal(await blockedShellRef(places, cfg, 'ls ~/notes'), null);
});
