import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { iterateJsonLines, readJsonLines, writeJson, writeJsonLines } from '../src/fs.js';

test('writeJson supports secure file mode for sensitive writes', async () => {
  if (process.platform === 'win32') return;

  const dir = await mkdtemp(path.join(tmpdir(), 'xb-fs-'));
  const file = path.join(dir, 'secret.json');
  try {
    await writeJson(file, { token: 'abc' }, { mode: 0o600 });
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readJsonLines fails closed on a corrupt archive and reports the line', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'xb-fs-'));
  const file = path.join(dir, 'bookmarks.jsonl');
  await writeFile(file, '{"id":"1"}\nnot-json\n');

  await assert.rejects(readJsonLines(file), /Invalid JSONL.*line 2/);
});

test('iterateJsonLines fails closed on a corrupt archive and reports the line', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'xb-fs-'));
  const file = path.join(dir, 'bookmarks.jsonl');
  await writeFile(file, '{"id":"1"}\n{"id":\n');

  await assert.rejects(async () => {
    for await (const _row of iterateJsonLines(file)) { /* consume archive */ }
  }, /Invalid JSONL.*line 2/);
});

test('missing JSONL archives still represent an empty first run', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'xb-fs-'));
  assert.deepEqual(await readJsonLines(path.join(dir, 'missing.jsonl')), []);
});

test('atomic writers use collision-resistant temporary files', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'xb-fs-'));
  const jsonl = path.join(dir, 'bookmarks.jsonl');
  const json = path.join(dir, 'state.json');

  await Promise.all([
    writeJsonLines(jsonl, [{ id: 'first' }]),
    writeJsonLines(jsonl, [{ id: 'second' }]),
    writeJson(json, { run: 1 }),
    writeJson(json, { run: 2 }),
  ]);

  const rows = await readJsonLines<{ id: string }>(jsonl);
  assert.equal(rows.length, 1);
  assert.ok(rows[0].id === 'first' || rows[0].id === 'second');
  assert.equal((await readdir(dir)).some((name) => name.endsWith('.tmp')), false);
});
