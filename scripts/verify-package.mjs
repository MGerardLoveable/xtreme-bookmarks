#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xtreme-bookmarks-npm-cache-'));

try {
  const output = execFileSync(
    'npm',
    ['pack', '--dry-run', '--json', '--ignore-scripts', '--cache', cacheDir],
    { cwd: projectDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const [manifest] = JSON.parse(output);
  const files = new Set(manifest.files.map((entry) => entry.path));

  const requiredFiles = [
    'bin/xb.mjs',
    'dist/cli.js',
    'dist/web-server.js',
    'web/index.html',
    'web/js/app.js',
    'web/css/base.css',
    'README.md',
    'LICENSE',
    'package.json',
  ];

  for (const required of requiredFiles) {
    assert.ok(files.has(required), `npm package is missing ${required}`);
  }
  assert.ok(!files.has('bin/ft.mjs'), 'legacy ft launcher must not ship');

  const packageJson = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8'));
  assert.equal(packageJson.bin.xb, 'bin/xb.mjs');
  assert.equal(packageJson.bin['xtreme-bookmarks'], 'bin/xb.mjs');
  assert.equal(packageJson.bin.ft, undefined);
  assert.equal(packageJson.bin.ftb, undefined);

  process.stdout.write(`Package verified: ${manifest.files.length} files, ${manifest.size} bytes packed.\n`);
} finally {
  fs.rmSync(cacheDir, { recursive: true, force: true });
}
