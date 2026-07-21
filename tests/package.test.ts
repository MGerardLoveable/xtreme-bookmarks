import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('package exposes only the supported xb CLI identities', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8'));

  assert.deepEqual(pkg.bin, {
    xb: 'bin/xb.mjs',
    'xtreme-bookmarks': 'bin/xb.mjs',
  });
  assert.ok(pkg.files.includes('web/'));
});

const hasBuild = fs.existsSync(path.join(projectDir, 'dist/cli.js'));

test('xb launcher reports the canonical CLI name', { skip: !hasBuild && 'run npm run build to exercise the launcher' }, () => {
  const result = spawnSync(process.execPath, ['bin/xb.mjs', '--help'], {
    cwd: projectDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      NO_COLOR: '1',
      XTREME_BOOKMARKS_SKIP_UPDATE_CHECK: '1',
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: xb \[options\] \[command\]/);
  assert.doesNotMatch(result.stdout, /Usage: ft\b/);
});
