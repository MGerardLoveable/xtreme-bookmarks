import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import os from 'node:os';
import { dataDir } from './paths.js';
import { getBrowser, browserUserDataDir, detectBrowser, listBrowserIds } from './browsers.js';
import type { BrowserDef } from './browsers.js';

interface LoadedEnvironmentValue {
  previous: string | undefined;
  loaded: string;
}

const loadedEnvironment = new Map<string, LoadedEnvironmentValue>();

export interface ChromeSessionConfig {
  chromeUserDataDir: string;
  chromeProfileDirectory: string;
  browser: BrowserDef;
}

export function loadEnv(): void {
  restoreLoadedEnvironment();
  const dir = dataDir();
  const values: Record<string, string> = {};
  loadDotenv({
    path: [
      path.join(dir, '.env.local'),
      path.join(dir, '.env'),
      path.join(process.cwd(), '.env.local'),
      path.join(process.cwd(), '.env'),
    ],
    processEnv: values,
    quiet: true,
  });

  for (const [key, value] of Object.entries(values)) {
    if (process.env[key] !== undefined) continue;
    loadedEnvironment.set(key, { previous: process.env[key], loaded: value });
    process.env[key] = value;
  }
}

function restoreLoadedEnvironment(): void {
  for (const [key, { previous, loaded }] of loadedEnvironment) {
    if (process.env[key] !== loaded) continue;
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
  loadedEnvironment.clear();
}

export function loadChromeSessionConfig(overrides: { browserId?: string } = {}): ChromeSessionConfig {
  loadEnv();

  // Resolve browser: CLI flag > FT_BROWSER env > auto-detect
  const browserId = overrides.browserId ?? process.env.FT_BROWSER;
  const browser = browserId ? getBrowser(browserId) : detectBrowser();

  // Resolve user-data dir: env override > registry path for the browser
  const dir = process.env.FT_CHROME_USER_DATA_DIR ?? browserUserDataDir(browser);
  if (!dir) {
    const supported = listBrowserIds().join(', ');
    throw new Error(
      `Could not detect a browser data directory for ${browser.displayName} on ${os.platform()}.\n` +
      `Set FT_CHROME_USER_DATA_DIR in .env, pass --chrome-user-data-dir, or try --browser <name>.\n` +
      `Supported browsers: ${supported}`
    );
  }

  const profileDirectory = process.env.FT_CHROME_PROFILE_DIRECTORY ?? 'Default';

  return { chromeUserDataDir: dir, chromeProfileDirectory: profileDirectory, browser };
}

export function loadXApiConfig() {
  loadEnv();

  const apiKey = process.env.X_API_KEY ?? process.env.X_CONSUMER_KEY;
  const apiSecret = process.env.X_API_SECRET ?? process.env.X_SECRET_KEY;
  const clientId = process.env.X_CLIENT_ID;
  const clientSecret = process.env.X_CLIENT_SECRET;
  const bearerToken = process.env.X_BEARER_TOKEN;
  const callbackUrl = process.env.X_CALLBACK_URL ?? 'http://127.0.0.1:3000/callback';

  if (!apiKey || !apiSecret || !clientId || !clientSecret) {
    throw new Error(
      'Missing X API credentials for API sync.\n' +
      'Set X_API_KEY, X_API_SECRET, X_CLIENT_ID, and X_CLIENT_SECRET in .env.\n' +
      'These are only needed for --api mode. Default sync uses your browser session.'
    );
  }

  return { apiKey, apiSecret, clientId, clientSecret, bearerToken, callbackUrl };
}
