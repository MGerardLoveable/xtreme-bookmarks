import { access, appendFile, mkdir, readFile, readdir, writeFile, rename, unlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

interface WriteOptions {
  mode?: number;
}

export async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function listFiles(dirPath: string): Promise<string[]> {
  try {
    return await readdir(dirPath);
  } catch {
    return [];
  }
}

export async function writeJson(filePath: string, value: unknown, options: WriteOptions = {}): Promise<void> {
  await atomicWrite(filePath, JSON.stringify(value, null, 2), options);
}

export async function readJson<T>(filePath: string): Promise<T> {
  const raw = await readFile(filePath, 'utf8');
  return JSON.parse(raw) as T;
}

export async function writeJsonLines(filePath: string, rows: unknown[], options: WriteOptions = {}): Promise<void> {
  const content = rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '');
  await atomicWrite(filePath, content, options);
}

export async function readJsonLines<T>(filePath: string): Promise<T[]> {
  try {
    const raw = await readFile(filePath, 'utf8');
    const rows: T[] = [];
    for (const [index, source] of raw.split('\n').entries()) {
      const line = source.trim();
      if (!line) continue;
      try {
        rows.push(JSON.parse(line) as T);
      } catch (err) {
        throw new Error(`Invalid JSONL in ${filePath} at line ${index + 1}: ${errorMessage(err)}`);
      }
    }
    return rows;
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return [];
    throw err;
  }
}

export async function* iterateJsonLines<T>(filePath: string): AsyncGenerator<T> {
  const input = createReadStream(filePath, { encoding: 'utf8' });
  let buffered = '';
  let lineNumber = 0;
  try {
    for await (const chunk of input) {
      buffered += chunk;
      let newline = buffered.indexOf('\n');
      while (newline >= 0) {
        lineNumber += 1;
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (line) yield parseJsonLine<T>(line, filePath, lineNumber);
        newline = buffered.indexOf('\n');
      }
    }
    const finalLine = buffered.trim();
    if (finalLine) yield parseJsonLine<T>(finalLine, filePath, lineNumber + 1);
  } finally {
    input.destroy();
  }
}

async function atomicWrite(filePath: string, content: string, options: WriteOptions): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(tmp, content, { encoding: 'utf8', mode: options.mode });
    await rename(tmp, filePath);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

function parseJsonLine<T>(line: string, filePath: string, lineNumber: number): T {
  try {
    return JSON.parse(line) as T;
  } catch (err) {
    throw new Error(`Invalid JSONL in ${filePath} at line ${lineNumber}: ${errorMessage(err)}`);
  }
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Markdown helpers ─────────────────────────────────────────────────────

export async function writeMd(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
}

export async function readMd(filePath: string): Promise<string> {
  return readFile(filePath, 'utf8');
}

export async function appendLine(filePath: string, line: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const nl = line.endsWith('\n') ? line : line + '\n';
  await appendFile(filePath, nl, 'utf8');
}
