/**
 * LLM engine detection, selection, and invocation.
 *
 * Knows how to call `claude` and `codex` out of the box.
 * Remembers the user's choice in ~/.xtreme-bookmarks/.preferences.
 */

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadEnv } from './config.js';
import { loadPreferences, savePreferences } from './preferences.js';
import { PromptCancelledError, promptText } from './prompt.js';

// ── Engine registry ────────────────────────────────────────────────────

export interface EngineConfig {
  bin?: string;
  args?: (prompt: string) => string[];
  input?: (prompt: string) => string;
  available?: () => boolean;
  invokeSync?: (prompt: string, opts?: InvokeOptions) => string;
  invoke?: (prompt: string, opts?: InvokeOptions) => Promise<string>;
}

const KNOWN_ENGINES: Record<string, EngineConfig> = {
  grok:   { available: () => {
    const status = getGrokOauthStatus();
    return status.cliInstalled && status.loggedIn;
  }, invokeSync: invokeGrokCliSync, invoke: invokeGrokCli },
  'grok-api': { available: () => Boolean(process.env.XAI_API_KEY), invokeSync: invokeGrokApiSync, invoke: invokeGrokApi },
  claude: { bin: 'claude', args: (p) => ['-p', '--output-format', 'text', p] },
  codex:  { bin: 'codex',  args: () => ['exec', '--skip-git-repo-check', '-'], input: (p) => p },
  ollama: { bin: 'ollama', args: (p) => ['run', 'llama3.2', p] },
};

/** Order used when auto-detecting. */
const PREFERENCE_ORDER = ['grok', 'grok-api', 'claude', 'codex', 'ollama'];

// ── Detection ──────────────────────────────────────────────────────────

export function hasCommandOnPath(
  bin: string,
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): boolean {
  const searchPath = env.PATH ?? '';
  const pathDirs = searchPath.split(path.delimiter).filter(Boolean);
  const pathext = (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM')
    .split(';')
    .map((ext) => ext.trim())
    .filter(Boolean);

  const hasPathSeparator = /[\\/]/.test(bin);
  const baseCandidates = hasPathSeparator
    ? [bin]
    : pathDirs.map((dir) => path.join(dir, bin));
  const candidates = platform === 'win32'
    ? baseCandidates.flatMap((candidate) => {
        if (path.extname(candidate)) return [candidate];
        return pathext.map((ext) => `${candidate}${ext}`);
      })
    : baseCandidates;

  return candidates.some((candidate) => {
    try {
      if (platform === 'win32') return fs.statSync(candidate).isFile();
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

export function detectAvailableEngines(): string[] {
  loadEnv();
  return PREFERENCE_ORDER.filter((name) => {
    const engine = KNOWN_ENGINES[name];
    if (engine.available) return engine.available();
    return Boolean(engine.bin && hasCommandOnPath(engine.bin));
  });
}

// ── Grok OAuth CLI detection ───────────────────────────────────────────

export interface GrokOauthStatus {
  cliInstalled: boolean;
  loggedIn: boolean;
  via: 'native' | 'wsl' | null;
}

function tryExec(command: string, args: string[]): boolean {
  try {
    execFileSync(command, args, { stdio: 'ignore', timeout: 5000, shell: process.platform === 'win32' && command !== 'wsl' });
    return true;
  } catch {
    return false;
  }
}

function wslHasGrok(): boolean {
  if (!hasCommandOnPath('wsl')) return false;
  return tryExec('wsl', ['bash', '-lc', 'command -v grok >/dev/null 2>&1']);
}

function wslGrokLoggedIn(): boolean {
  if (process.env.XB_TEST_WSL_GROK_LOGGED_IN === '1') return true;
  if (!hasCommandOnPath('wsl')) return false;
  return tryExec('wsl', ['bash', '-lc', 'test -s "$HOME/.grok/auth.json"']);
}

function nativeGrokAuthPath(): string {
  return process.env.XB_GROK_AUTH_FILE || path.join(os.homedir(), '.grok', 'auth.json');
}

export function getGrokOauthStatus(): GrokOauthStatus {
  const nativeInstalled = hasCommandOnPath('grok');
  if (nativeInstalled) {
    return {
      cliInstalled: true,
      loggedIn: fs.existsSync(nativeGrokAuthPath()),
      via: 'native',
    };
  }

  const wslInstalled = wslHasGrok();
  if (wslInstalled) {
    return {
      cliInstalled: true,
      loggedIn: wslGrokLoggedIn(),
      via: 'wsl',
    };
  }

  return { cliInstalled: false, loggedIn: false, via: null };
}

// ── Interactive prompt ─────────────────────────────────────────────────

async function askYesNo(question: string): Promise<boolean> {
  const result = await promptText(question);
  if (result.kind === 'interrupt') {
    throw new PromptCancelledError('Cancelled before selecting a model.', 130);
  }
  if (result.kind === 'close') {
    throw new PromptCancelledError('No model selected.', 0);
  }
  return result.value.toLowerCase().startsWith('y');
}

// ── Resolution ─────────────────────────────────────────────────────────

export interface ResolvedEngine {
  name: string;
  config: EngineConfig;
}

function resolve(name: string): ResolvedEngine {
  return { name, config: KNOWN_ENGINES[name] };
}

export interface ResolveEngineOptions {
  /** Never prompt the user. Use saved default or first available engine. */
  nonInteractive?: boolean;
}

/**
 * Resolve which engine to use for classification.
 *
 * 1. If a saved default exists and is available, use it silently.
 * 2. If only one engine is available, use it silently.
 * 3. If multiple are available, stdin is a TTY, and nonInteractive is not set,
 *    prompt y/n through the preference order and persist the choice.
 * 4. Otherwise (CI/scripts/server), use the first available without prompting.
 *
 * Throws if no engine is found.
 */
export async function resolveEngine(options: ResolveEngineOptions = {}): Promise<ResolvedEngine> {
  const available = detectAvailableEngines();

  if (available.length === 0) {
    throw new Error(
      'No supported LLM CLI found.\n' +
      'Set up one of the following:\n' +
      '  - SuperGrok OAuth: install the xAI Grok CLI, then run: grok\n' +
      '  - Grok API:         set XAI_API_KEY in .env.local or your shell\n' +
      '  - Claude Code: https://docs.anthropic.com/en/docs/claude-code\n' +
      '  - Codex CLI:   https://github.com/openai/codex\n' +
      '  - Ollama:      https://ollama.com/'
    );
  }

  // Check saved preference
  const prefs = loadPreferences();
  if (prefs.defaultEngine && available.includes(prefs.defaultEngine)) {
    return resolve(prefs.defaultEngine);
  }

  // Single engine — just use it
  if (available.length === 1) {
    return resolve(available[0]);
  }

  // Multiple engines — prompt if TTY and allowed, else use first
  if (options.nonInteractive || !process.stdin.isTTY) {
    return resolve(available[0]);
  }

  for (const name of available) {
    const yes = await askYesNo(`  Use ${name} for classification? (y/n): `);
    if (yes) {
      savePreferences({ ...prefs, defaultEngine: name });
      process.stderr.write(`  \u2713 ${name} set as default (change anytime: ft model)\n`);
      return resolve(name);
    }
  }

  // Said no to everything — use first anyway but don't persist
  process.stderr.write(`  Using ${available[0]} (no default saved)\n`);
  return resolve(available[0]);
}

// ── Invocation ─────────────────────────────────────────────────────────

export interface InvokeOptions {
  timeout?: number;
  maxBuffer?: number;
}

function grokWslPromptScript(): string {
  return [
    'tmp=$(mktemp)',
    'cat > "$tmp"',
    'grok --prompt-file "$tmp"',
    'code=$?',
    'rm -f "$tmp"',
    'exit $code',
  ].join('; ');
}

function invokeGrokCliSync(prompt: string, opts: InvokeOptions = {}): string {
  const status = getGrokOauthStatus();
  if (!status.cliInstalled) throw new Error('SuperGrok is not installed. Install the xAI Grok CLI first.');
  if (!status.loggedIn) throw new Error('SuperGrok is installed but not signed in. Run: grok login --device-auth');

  if (status.via === 'wsl') {
    return execFileSync('wsl', ['bash', '-lc', grokWslPromptScript()], {
      encoding: 'utf-8',
      timeout: opts.timeout ?? 120_000,
      maxBuffer: opts.maxBuffer ?? 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
      input: prompt,
      shell: false,
    }).trim();
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xb-grok-'));
  const promptPath = path.join(tmpDir, 'prompt.txt');
  try {
    fs.writeFileSync(promptPath, prompt, 'utf-8');
    return execFileSync('grok', ['--prompt-file', promptPath], {
      encoding: 'utf-8',
      timeout: opts.timeout ?? 120_000,
      maxBuffer: opts.maxBuffer ?? 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    }).trim();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function invokeGrokCli(prompt: string, opts: InvokeOptions = {}): Promise<string> {
  const status = getGrokOauthStatus();
  if (!status.cliInstalled) return Promise.reject(new Error('SuperGrok is not installed. Install the xAI Grok CLI first.'));
  if (!status.loggedIn) return Promise.reject(new Error('SuperGrok is installed but not signed in. Run: grok login --device-auth'));

  if (status.via === 'wsl') {
    return spawnToString('wsl', ['bash', '-lc', grokWslPromptScript()], prompt, opts);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xb-grok-'));
  const promptPath = path.join(tmpDir, 'prompt.txt');
  fs.writeFileSync(promptPath, prompt, 'utf-8');
  return spawnToString('grok', ['--prompt-file', promptPath], undefined, opts)
    .finally(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
}

async function invokeGrokApi(prompt: string, opts: InvokeOptions = {}): Promise<string> {
  loadEnv();
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) throw new Error('Grok API is not configured. Set XAI_API_KEY in .env.local or your shell.');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeout ?? 120_000);
  try {
    const res = await fetch('https://api.x.ai/v1/responses', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.XAI_MODEL || 'grok-4.3',
        input: [
          {
            role: 'system',
            content: 'You are helping maintain Xtreme Bookmarks, a local-first second brain for X/Twitter bookmarks. Be concise, grounded, and preserve cited URLs.',
          },
          { role: 'user', content: prompt },
        ],
      }),
    });

    const text = await res.text();
    if (!res.ok) throw new Error(`Grok API ${res.status}: ${text.slice(0, 1000)}`);
    const data = JSON.parse(text) as {
      output_text?: string;
      output?: Array<{ content?: Array<{ text?: string; type?: string }> }>;
    };
    const outputText = data.output_text
      ?? data.output?.flatMap((item) => item.content ?? []).map((content) => content.text ?? '').join('\n').trim()
      ?? '';
    if (!outputText) throw new Error('Grok returned an empty response.');
    const maxBuffer = opts.maxBuffer ?? 1024 * 1024;
    if (outputText.length > maxBuffer) throw new Error(`grok exceeded ${maxBuffer} bytes of output`);
    return outputText.trim();
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw new Error(`grok timed out after ${opts.timeout ?? 120_000}ms`);
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function invokeGrokApiSync(prompt: string, opts: InvokeOptions = {}): string {
  loadEnv();
  const script = [
    "import fs from 'node:fs';",
    "const prompt = fs.readFileSync(0, 'utf8');",
    "if (!process.env.XAI_API_KEY) { console.error('XAI_API_KEY is not set.'); process.exit(1); }",
    "const res = await fetch('https://api.x.ai/v1/responses', {",
    "method: 'POST',",
    "headers: { 'Authorization': `Bearer ${process.env.XAI_API_KEY}`, 'Content-Type': 'application/json' },",
    "body: JSON.stringify({ model: process.env.XAI_MODEL || 'grok-4.3', input: [{ role: 'system', content: 'You are helping maintain Xtreme Bookmarks, a local-first second brain for X/Twitter bookmarks. Be concise, grounded, and preserve cited URLs.' }, { role: 'user', content: prompt }] })",
    "});",
    "const text = await res.text();",
    "if (!res.ok) { console.error(text); process.exit(1); }",
    "const data = JSON.parse(text);",
    "const output = data.output_text || (data.output || []).flatMap((item) => item.content || []).map((content) => content.text || '').join('\\n').trim();",
    "process.stdout.write(output);",
  ].join('\n');
  return execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf-8',
    timeout: opts.timeout ?? 120_000,
    maxBuffer: opts.maxBuffer ?? 1024 * 1024,
    stdio: ['pipe', 'pipe', 'ignore'],
    input: prompt,
    env: process.env,
  }).trim();
}

export function invokeEngine(engine: ResolvedEngine, prompt: string, opts: InvokeOptions = {}): string {
  const { bin, args, input } = engine.config;
  if (engine.config.invokeSync) return engine.config.invokeSync(prompt, opts);
  if (!bin || !args) throw new Error(`Engine "${engine.name}" cannot be invoked.`);
  return execFileSync(bin, args(prompt), {
    encoding: 'utf-8',
    timeout: opts.timeout ?? 120_000,
    maxBuffer: opts.maxBuffer ?? 1024 * 1024,
    stdio: input ? ['pipe', 'pipe', 'ignore'] : ['ignore', 'pipe', 'ignore'],
    shell: process.platform === 'win32',
    input: input ? input(prompt) : undefined,
  }).trim();
}

function spawnToString(bin: string, args: string[], stdinText: string | undefined, opts: InvokeOptions = {}): Promise<string> {
  const timeout = opts.timeout ?? 120_000;
  const maxBuffer = opts.maxBuffer ?? 1024 * 1024;

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32' && bin !== 'wsl',
    });

    let stdout = '';
    let stderr = '';
    let killedForSize = false;
    let killedForTimeout = false;

    const timer = setTimeout(() => {
      killedForTimeout = true;
      child.kill('SIGTERM');
    }, timeout);

    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');

    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.length > maxBuffer) {
        killedForSize = true;
        child.kill('SIGTERM');
      }
    });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (killedForTimeout) return reject(new Error(`${bin} timed out after ${timeout}ms`));
      if (killedForSize) return reject(new Error(`${bin} exceeded ${maxBuffer} bytes of stdout`));
      if (code !== 0) {
        const tail = stderr.trim().split('\n').slice(-5).join('\n');
        return reject(new Error(`${bin} exited with code ${code}${tail ? `:\n${tail}` : ''}`));
      }
      resolve(stdout.trim());
    });

    if (child.stdin) child.stdin.end(stdinText ?? '');
  });
}

/**
 * Async variant — does not block the event loop, so spinners and
 * setInterval callbacks continue to fire while the LLM runs.
 *
 * If the engine declares an `input` function, its return value is piped to the
 * child's stdin (e.g. `codex exec -` reads the prompt from stdin). Otherwise
 * the prompt must already be baked into `args(prompt)`.
 */
export function invokeEngineAsync(engine: ResolvedEngine, prompt: string, opts: InvokeOptions = {}): Promise<string> {
  const { bin, args, input } = engine.config;
  if (engine.config.invoke) return engine.config.invoke(prompt, opts);
  if (!bin || !args) return Promise.reject(new Error(`Engine "${engine.name}" cannot be invoked.`));
  return spawnToString(bin, args(prompt), input ? input(prompt) : undefined, opts);
}
