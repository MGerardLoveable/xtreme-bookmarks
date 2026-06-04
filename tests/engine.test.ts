import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ── Preferences round-trip ─────────────────────────────────────────────

test('preferences: round-trip save and load', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-engine-test-'));
  const origEnv = process.env.FT_DATA_DIR;
  process.env.FT_DATA_DIR = tmpDir;

  try {
    const { loadPreferences, savePreferences } = await import('../src/preferences.js');
    // Empty at first
    assert.deepEqual(loadPreferences(), {});

    // Save and reload
    savePreferences({ defaultEngine: 'claude' });
    assert.equal(loadPreferences().defaultEngine, 'claude');

    // Overwrite
    savePreferences({ defaultEngine: 'codex' });
    assert.equal(loadPreferences().defaultEngine, 'codex');
  } finally {
    process.env.FT_DATA_DIR = origEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('preferences: savePreferences creates missing data dir', async () => {
  const tmpDir = path.join(os.tmpdir(), `ft-engine-missing-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const origEnv = process.env.FT_DATA_DIR;
  process.env.FT_DATA_DIR = tmpDir;

  try {
    const { loadPreferences, savePreferences } = await import('../src/preferences.js');
    savePreferences({ defaultEngine: 'claude' });
    assert.equal(loadPreferences().defaultEngine, 'claude');
    assert.ok(fs.existsSync(path.join(tmpDir, '.preferences')));
  } finally {
    process.env.FT_DATA_DIR = origEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('preferences: savePreferences writes private file on posix', async () => {
  if (process.platform === 'win32') return;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-engine-private-'));
  const origEnv = process.env.FT_DATA_DIR;
  process.env.FT_DATA_DIR = tmpDir;

  try {
    const { savePreferences } = await import('../src/preferences.js');
    savePreferences({ defaultEngine: 'claude' });
    const mode = fs.statSync(path.join(tmpDir, '.preferences')).mode & 0o777;
    assert.equal(mode, 0o600);
  } finally {
    process.env.FT_DATA_DIR = origEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── Engine detection ───────────────────────────────────────────────────

test('detectAvailableEngines: returns array of available engines', async () => {
  const { detectAvailableEngines } = await import('../src/engine.js');
  const available = detectAvailableEngines();

  // Should be an array
  assert.ok(Array.isArray(available));

  // Each entry should be a known engine name
  for (const name of available) {
    assert.ok(['grok', 'grok-api', 'claude', 'codex', 'ollama'].includes(name), `unexpected engine: ${name}`);
  }
});

test('detectAvailableEngines: grok-api is available when XAI_API_KEY is set', async () => {
  const origKey = process.env.XAI_API_KEY;
  process.env.XAI_API_KEY = 'test-key';

  try {
    const { detectAvailableEngines } = await import('../src/engine.js');
    const available = detectAvailableEngines();
    assert.ok(available.includes('grok-api'));
  } finally {
    if (origKey === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = origKey;
  }
});

test('detectAvailableEngines: grok uses the SuperGrok OAuth CLI', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-engine-grok-cli-'));
  const origPath = process.env.PATH;
  const origKey = process.env.XAI_API_KEY;
  const origAuth = process.env.XB_GROK_AUTH_FILE;
  const binName = process.platform === 'win32' ? 'grok.CMD' : 'grok';
  const fakeBin = path.join(tmpDir, binName);
  const fakeAuth = path.join(tmpDir, 'auth.json');
  process.env.PATH = tmpDir;
  process.env.XB_GROK_AUTH_FILE = fakeAuth;
  delete process.env.XAI_API_KEY;

  try {
    fs.writeFileSync(fakeBin, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\nexit 0\n');
    fs.writeFileSync(fakeAuth, '{"test":true}');
    if (process.platform !== 'win32') fs.chmodSync(fakeBin, 0o755);

    const { detectAvailableEngines } = await import('../src/engine.js');
    const available = detectAvailableEngines();
    assert.equal(available[0], 'grok');
    assert.ok(!available.includes('grok-api'));
  } finally {
    process.env.PATH = origPath;
    if (origKey === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = origKey;
    if (origAuth === undefined) delete process.env.XB_GROK_AUTH_FILE;
    else process.env.XB_GROK_AUTH_FILE = origAuth;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('hasCommandOnPath: finds executable in PATH', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-engine-path-'));
  const fakeBin = path.join(tmpDir, 'claude');

  try {
    fs.writeFileSync(fakeBin, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(fakeBin, 0o755);

    const { hasCommandOnPath } = await import('../src/engine.js');
    assert.equal(hasCommandOnPath('claude', { PATH: tmpDir }, 'linux'), true);
    assert.equal(hasCommandOnPath('codex', { PATH: tmpDir }, 'linux'), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('hasCommandOnPath: honors PATHEXT on win32', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-engine-path-win-'));
  const fakeBin = path.join(tmpDir, 'codex.CMD');

  try {
    fs.writeFileSync(fakeBin, '@echo off\r\n');

    const { hasCommandOnPath } = await import('../src/engine.js');
    assert.equal(
      hasCommandOnPath('codex', { PATH: tmpDir, PATHEXT: '.EXE;.CMD' }, 'win32'),
      true,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});



// ── resolveEngine with saved preference ────────────────────────────────

test('resolveEngine: uses saved preference when available', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-engine-test-'));
  const origEnv = process.env.FT_DATA_DIR;
  process.env.FT_DATA_DIR = tmpDir;

  try {
    const { detectAvailableEngines, resolveEngine } = await import('../src/engine.js');
    const { savePreferences } = await import('../src/preferences.js');

    const available = detectAvailableEngines();
    if (available.length === 0) {
      // Skip test if no engines available in this environment
      return;
    }

    // Save the first available engine as default
    savePreferences({ defaultEngine: available[0] });
    const resolved = await resolveEngine();
    assert.equal(resolved.name, available[0]);
  } finally {
    process.env.FT_DATA_DIR = origEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── resolveEngine with single engine ───────────────────────────────────

test('resolveEngine: single available engine is used without prompting', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-engine-test-'));
  const origEnv = process.env.FT_DATA_DIR;
  process.env.FT_DATA_DIR = tmpDir;

  try {
    const { detectAvailableEngines, resolveEngine } = await import('../src/engine.js');
    const available = detectAvailableEngines();

    if (available.length !== 1) {
      // This test is only meaningful with exactly one engine
      return;
    }

    const resolved = await resolveEngine();
    assert.equal(resolved.name, available[0]);
    assert.ok(resolved.config);
    assert.ok(
      typeof resolved.config.invoke === 'function' ||
      (typeof resolved.config.bin === 'string' && typeof resolved.config.args === 'function'),
    );
  } finally {
    process.env.FT_DATA_DIR = origEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('invokeEngineAsync: calls Grok through xAI responses API', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-engine-grok-'));
  const origDataDir = process.env.FT_DATA_DIR;
  const origKey = process.env.XAI_API_KEY;
  const origModel = process.env.XAI_MODEL;
  const origPath = process.env.PATH;
  const origFetch = globalThis.fetch;
  process.env.FT_DATA_DIR = tmpDir;
  process.env.XAI_API_KEY = 'test-key';
  process.env.XAI_MODEL = 'grok-test';
  process.env.PATH = '';

  try {
    let requestBody: any = null;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body ?? '{}'));
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ output_text: 'Grok says hello' }),
      } as Response;
    }) as typeof fetch;

    const { resolveEngine, invokeEngineAsync } = await import('../src/engine.js');
    const resolved = await resolveEngine({ nonInteractive: true });
    assert.equal(resolved.name, 'grok-api');
    assert.equal(await invokeEngineAsync(resolved, 'hello'), 'Grok says hello');
    assert.equal(requestBody.model, 'grok-test');
    assert.equal(requestBody.input.at(-1).content, 'hello');
  } finally {
    process.env.FT_DATA_DIR = origDataDir;
    if (origKey === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = origKey;
    if (origModel === undefined) delete process.env.XAI_MODEL;
    else process.env.XAI_MODEL = origModel;
    process.env.PATH = origPath;
    globalThis.fetch = origFetch;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── ft model CLI parsing ───────────────────────────────────────────────

test('ft model: command is registered and shows help', async () => {
  const { buildCli } = await import('../src/cli.js');
  const program = buildCli();
  const modelCmd = program.commands.find((c: any) => c.name() === 'model');
  assert.ok(modelCmd, 'model command should be registered');
  assert.ok(modelCmd.description().includes('LLM engine'));
});

test('ft model: direct set persists preference', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-engine-test-'));
  const origEnv = process.env.FT_DATA_DIR;
  process.env.FT_DATA_DIR = tmpDir;

  try {
    const { detectAvailableEngines } = await import('../src/engine.js');
    const { loadPreferences, savePreferences } = await import('../src/preferences.js');

    const available = detectAvailableEngines();
    if (available.length === 0) return;

    // Simulate what `ft model <name>` does
    const name = available[0];
    savePreferences({ ...loadPreferences(), defaultEngine: name });
    assert.equal(loadPreferences().defaultEngine, name);
  } finally {
    process.env.FT_DATA_DIR = origEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
