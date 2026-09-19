import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cachedXSessionBrowserId, loadXGraphQLSession } from '../src/graphql-bookmarks.js';

test('an explicit private server session works without a desktop browser', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'xb-server-session-'));
  const previous = process.env.XB_X_SESSION_FILE;
  const file = path.join(directory, 'session.json');
  process.env.XB_X_SESSION_FILE = file;
  try {
    const session = { csrfToken: 'test-csrf', cookieHeader: 'ct0=test-csrf; auth_token=test-only' };
    await fs.writeFile(file, JSON.stringify(session), { mode: 0o600 });
    assert.equal(await cachedXSessionBrowserId(), 'chrome');
    assert.deepEqual(await loadXGraphQLSession(), session);
    await fs.writeFile(file, JSON.stringify({ ...session, cookieHeader: 'bad\r\nheader' }));
    await assert.rejects(loadXGraphQLSession(), /configured X session file is invalid/);
    await fs.writeFile(file, '{}');
    await assert.rejects(loadXGraphQLSession(), /configured X session file is invalid/);
    await fs.unlink(file);
    await assert.rejects(loadXGraphQLSession(), /ENOENT/);
  } finally {
    if (previous === undefined) delete process.env.XB_X_SESSION_FILE;
    else process.env.XB_X_SESSION_FILE = previous;
    await fs.rm(directory, { recursive: true, force: true });
  }
});
