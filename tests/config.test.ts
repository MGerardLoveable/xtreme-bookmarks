import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadChromeSessionConfig } from '../src/config.js';
import { browserUserDataDir } from '../src/browsers.js';

function writeEnv(dir: string, contents: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.env.local'), contents);
}

test('loadChromeSessionConfig reads chrome user data dir and profile directory from env', () => {
  const savedBrowser = process.env.FT_BROWSER;
  process.env.FT_CHROME_USER_DATA_DIR = '/tmp/chrome-user-data';
  process.env.FT_CHROME_PROFILE_DIRECTORY = 'Profile 1';
  process.env.FT_BROWSER = 'chrome';
  try {
    const config = loadChromeSessionConfig();
    assert.equal(config.chromeUserDataDir, '/tmp/chrome-user-data');
    assert.equal(config.chromeProfileDirectory, 'Profile 1');
    assert.equal(config.browser.id, 'chrome');
  } finally {
    delete process.env.FT_CHROME_USER_DATA_DIR;
    delete process.env.FT_CHROME_PROFILE_DIRECTORY;
    if (savedBrowser !== undefined) process.env.FT_BROWSER = savedBrowser;
    else delete process.env.FT_BROWSER;
  }
});

test('loadChromeSessionConfig defaults profile to Default', () => {
  process.env.FT_CHROME_USER_DATA_DIR = '/tmp/chrome-user-data';
  delete process.env.FT_CHROME_PROFILE_DIRECTORY;
  const config = loadChromeSessionConfig();
  assert.equal(config.chromeProfileDirectory, 'Default');
  delete process.env.FT_CHROME_USER_DATA_DIR;
});

test('loadChromeSessionConfig: --browser brave resolves to Brave', () => {
  delete process.env.FT_CHROME_USER_DATA_DIR;
  delete process.env.FT_BROWSER;
  const config = loadChromeSessionConfig({ browserId: 'brave' });
  assert.equal(config.browser.id, 'brave');
  assert.match(config.chromeUserDataDir, /Brave/i);
});

test('loadChromeSessionConfig: FT_BROWSER env is honored', () => {
  delete process.env.FT_CHROME_USER_DATA_DIR;
  process.env.FT_BROWSER = 'brave';
  const config = loadChromeSessionConfig();
  assert.equal(config.browser.id, 'brave');
  delete process.env.FT_BROWSER;
});

test('loadChromeSessionConfig: unknown browser throws', () => {
  delete process.env.FT_CHROME_USER_DATA_DIR;
  assert.throws(
    () => loadChromeSessionConfig({ browserId: 'bogus' }),
    /Unknown browser: "bogus"/,
  );
});

test('loadChromeSessionConfig: --browser firefox resolves correctly', () => {
  delete process.env.FT_CHROME_USER_DATA_DIR;
  delete process.env.FT_BROWSER;
  const config = loadChromeSessionConfig({ browserId: 'firefox' });
  assert.equal(config.browser.id, 'firefox');
  assert.equal(config.browser.cookieBackend, 'firefox');
  assert.equal(config.chromeUserDataDir, browserUserDataDir(config.browser));
});

test('loadEnv prefers persistent data-dir values and uses project values as fallbacks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xb-config-precedence-'));
  const projectDir = path.join(root, 'project');
  const persistentDir = path.join(root, 'data');
  const originalCwd = process.cwd();
  const savedDataDir = process.env.XTREME_BOOKMARKS_DATA_DIR;
  fs.mkdirSync(projectDir);
  writeEnv(persistentDir, 'FT_BROWSER=brave\nFT_CHROME_USER_DATA_DIR=/persistent/browser\n');
  writeEnv(projectDir, 'FT_BROWSER=chrome\nFT_CHROME_USER_DATA_DIR=/project/browser\nFT_CHROME_PROFILE_DIRECTORY=Profile 7\n');

  try {
    delete process.env.FT_BROWSER;
    delete process.env.FT_CHROME_USER_DATA_DIR;
    delete process.env.FT_CHROME_PROFILE_DIRECTORY;
    process.env.XTREME_BOOKMARKS_DATA_DIR = persistentDir;
    process.chdir(projectDir);

    const config = loadChromeSessionConfig();
    assert.equal(config.browser.id, 'brave');
    assert.equal(config.chromeUserDataDir, '/persistent/browser');
    assert.equal(config.chromeProfileDirectory, 'Profile 7');
  } finally {
    process.chdir(originalCwd);
    delete process.env.FT_BROWSER;
    delete process.env.FT_CHROME_USER_DATA_DIR;
    delete process.env.FT_CHROME_PROFILE_DIRECTORY;
    if (savedDataDir === undefined) delete process.env.XTREME_BOOKMARKS_DATA_DIR;
    else process.env.XTREME_BOOKMARKS_DATA_DIR = savedDataDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('loadEnv does not retain file values after the data directory changes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xb-config-reload-'));
  const firstDir = path.join(root, 'first');
  const secondDir = path.join(root, 'second');
  const savedDataDir = process.env.XTREME_BOOKMARKS_DATA_DIR;
  writeEnv(firstDir, 'FT_BROWSER=brave\nFT_CHROME_USER_DATA_DIR=/first/browser\n');
  writeEnv(secondDir, 'FT_BROWSER=chrome\nFT_CHROME_USER_DATA_DIR=/second/browser\n');

  try {
    delete process.env.FT_BROWSER;
    delete process.env.FT_CHROME_USER_DATA_DIR;
    process.env.XTREME_BOOKMARKS_DATA_DIR = firstDir;
    assert.equal(loadChromeSessionConfig().browser.id, 'brave');

    process.env.XTREME_BOOKMARKS_DATA_DIR = secondDir;
    const reloaded = loadChromeSessionConfig();
    assert.equal(reloaded.browser.id, 'chrome');
    assert.equal(reloaded.chromeUserDataDir, '/second/browser');
  } finally {
    delete process.env.FT_BROWSER;
    delete process.env.FT_CHROME_USER_DATA_DIR;
    if (savedDataDir === undefined) delete process.env.XTREME_BOOKMARKS_DATA_DIR;
    else process.env.XTREME_BOOKMARKS_DATA_DIR = savedDataDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
