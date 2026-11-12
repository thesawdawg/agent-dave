/** Verify DAVE offline; optionally load extensions with an installed Pi package. */
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const result = spawnSync(process.execPath, ['--test', '--test-isolation=none', 'tests/redmine.test.mjs', 'tests/reviewer.test.mjs', 'tests/configure-dave.test.mjs', 'tests/board.test.mjs', 'tests/dave.test.mjs', 'tests/guard.test.mjs'], {
  stdio: 'inherit',
  env: {...process.env, PI_CODING_AGENT_DIR: mkdtempSync(path.join(tmpdir(), 'dave-verify-'))},
});
if (result.status !== 0) process.exit(result.status ?? 1);
const packagePath = process.env.DAVE_PI_PACKAGE;
if (packagePath) {
  const {loadExtensions} = await import(pathToFileURL(path.join(packagePath, 'dist/core/extensions/loader.js')).href);
  const loaded = await loadExtensions(['guard.ts', 'dave.ts'].map(name => path.resolve('.pi/extensions', name)), process.cwd());
  console.log(`Pi loaded ${loaded.extensions.length} DAVE extensions.`);
  if (loaded.errors.length) {
    console.error(loaded.errors);
    process.exitCode = 1;
  }
} else {
  console.log('Pi runtime loading skipped: set DAVE_PI_PACKAGE to the installed package directory.');
}
