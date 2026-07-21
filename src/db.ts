import type { Database, SqlJsStatic } from 'sql.js';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);

let sqlPromise: Promise<SqlJsStatic> | undefined;

interface SharedDatabaseEntry {
  database: Database;
  filePath: string;
  leases: number;
  mtimeMs: number;
}

export interface DatabaseBackup {
  path: string;
  name: string;
  createdAt: string;
  size: number;
}

const sharedDatabases = new Map<string, SharedDatabaseEntry>();
const databaseLeases = new WeakMap<object, SharedDatabaseEntry>();
const BACKUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_BACKUP_LIMIT = 12;

const WASM_PAGE_BYTES = 64 * 1024;
const DEFAULT_SQL_WASM_INITIAL_MB = 256;
const DEFAULT_SQL_WASM_MAX_MB = 2048;

function readMemoryMb(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function memoryPagesFromMb(mb: number): number {
  return Math.ceil((mb * 1024 * 1024) / WASM_PAGE_BYTES);
}

function getSql(): Promise<SqlJsStatic> {
  if (!sqlPromise) {
    const initSqlJs = require('sql.js-fts5') as (opts: any) => Promise<SqlJsStatic>;
    const wasmPath = require.resolve('sql.js-fts5/dist/sql-wasm.wasm');
    const wasmBinary = fs.readFileSync(wasmPath);
    const initialMb = readMemoryMb('XTREME_BOOKMARKS_SQL_WASM_INITIAL_MB', DEFAULT_SQL_WASM_INITIAL_MB);
    const maxMb = Math.max(
      initialMb,
      readMemoryMb('XTREME_BOOKMARKS_SQL_WASM_MAX_MB', DEFAULT_SQL_WASM_MAX_MB),
    );
    sqlPromise = initSqlJs({
      wasmBinary,
      wasmMemory: new WebAssembly.Memory({
        initial: memoryPagesFromMb(initialMb),
        maximum: memoryPagesFromMb(maxMb),
      }),
    });
  }
  return sqlPromise!;
}

export async function openDb(filePath: string): Promise<Database> {
  if (filePath === ':memory:') return createDb();

  const resolvedPath = path.resolve(filePath);
  const existing = sharedDatabases.get(resolvedPath);
  if (existing) return createDatabaseLease(existing);

  const SQL = await getSql();
  const database = fs.existsSync(resolvedPath)
    ? new SQL.Database(fs.readFileSync(resolvedPath))
    : new SQL.Database();
  const entry: SharedDatabaseEntry = {
    database,
    filePath: resolvedPath,
    leases: 0,
    mtimeMs: fileMtimeMs(resolvedPath),
  };
  sharedDatabases.set(resolvedPath, entry);
  return createDatabaseLease(entry);
}

export async function createDb(): Promise<Database> {
  const SQL = await getSql();
  return new SQL.Database();
}

export function saveDb(db: Database, filePath: string): void {
  if (filePath === ':memory:') return;

  const resolvedPath = path.resolve(filePath);
  const entry = databaseLeases.get(db as object);
  const source = entry?.database ?? db;
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (entry && entry.filePath === resolvedPath) {
    const diskMtime = fileMtimeMs(resolvedPath);
    if (diskMtime > 0 && entry.mtimeMs > 0 && Math.abs(diskMtime - entry.mtimeMs) > 0.5) {
      throw new Error(
        `Refusing to overwrite a newer bookmark database at ${resolvedPath}. ` +
        'Another Xtreme Bookmarks process changed it; restart this process and retry.',
      );
    }
  }

  maybeCreateScheduledBackup(resolvedPath);
  const data = source.export();
  const tmp = `${resolvedPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, Buffer.from(data));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, resolvedPath);
    fs.chmodSync(resolvedPath, 0o600);
    fsyncDirectory(dir);
    if (entry) entry.mtimeMs = fileMtimeMs(resolvedPath);
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    throw error;
  }
}

export function backupDb(filePath: string, reason = 'manual'): DatabaseBackup | undefined {
  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) return undefined;
  const backupDir = databaseBackupDir(resolvedPath);
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const safeReason = reason.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '') || 'backup';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destination = path.join(backupDir, `${path.basename(resolvedPath)}.${timestamp}.${safeReason}.bak`);
  fs.copyFileSync(resolvedPath, destination, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(destination, 0o600);
  pruneDbBackups(resolvedPath);
  return backupMetadata(destination);
}

export function listDbBackups(filePath: string): DatabaseBackup[] {
  const backupDir = databaseBackupDir(path.resolve(filePath));
  if (!fs.existsSync(backupDir)) return [];
  return fs.readdirSync(backupDir)
    .filter((name) => name.endsWith('.bak'))
    .map((name) => backupMetadata(path.join(backupDir, name)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function restoreDbBackup(filePath: string, backupName: string): void {
  const resolvedPath = path.resolve(filePath);
  if (sharedDatabases.has(resolvedPath)) {
    throw new Error('Stop the Xtreme Bookmarks server before restoring a database backup.');
  }
  const backupDir = databaseBackupDir(resolvedPath);
  const source = path.resolve(backupDir, path.basename(backupName));
  if (path.dirname(source) !== backupDir || !source.endsWith('.bak') || !fs.existsSync(source)) {
    throw new Error('Database backup not found.');
  }
  if (fs.existsSync(resolvedPath)) backupDb(resolvedPath, 'before-restore');
  const tmp = `${resolvedPath}.restore-${process.pid}-${crypto.randomUUID()}`;
  fs.copyFileSync(source, tmp, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, resolvedPath);
  fsyncDirectory(path.dirname(resolvedPath));
}

export function databaseIntegrity(db: Database): { ok: boolean; message: string } {
  try {
    const rows = db.exec('PRAGMA integrity_check');
    const message = String(rows[0]?.values[0]?.[0] ?? 'unknown');
    return { ok: message.toLowerCase() === 'ok', message };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

function createDatabaseLease(entry: SharedDatabaseEntry): Database {
  entry.leases += 1;
  let released = false;
  const lease = new Proxy(entry.database as Database & Record<PropertyKey, unknown>, {
    get(target, property) {
      if (property === 'close') {
        return () => {
          if (released) return;
          released = true;
          entry.leases -= 1;
          if (entry.leases === 0) {
            sharedDatabases.delete(entry.filePath);
            entry.database.close();
          }
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as Database;
  databaseLeases.set(lease as object, entry);
  return lease;
}

function fileMtimeMs(filePath: string): number {
  try { return fs.statSync(filePath).mtimeMs; } catch { return 0; }
}

function databaseBackupDir(filePath: string): string {
  return path.join(path.dirname(filePath), 'backups');
}

function backupMetadata(filePath: string): DatabaseBackup {
  const stat = fs.statSync(filePath);
  return {
    path: filePath,
    name: path.basename(filePath),
    createdAt: stat.mtime.toISOString(),
    size: stat.size,
  };
}

function maybeCreateScheduledBackup(filePath: string): void {
  if (!fs.existsSync(filePath) || process.env.XB_DISABLE_AUTOMATIC_BACKUPS === '1') return;
  const latest = listDbBackups(filePath)[0];
  if (!latest || Date.now() - Date.parse(latest.createdAt) >= BACKUP_INTERVAL_MS) {
    backupDb(filePath, 'automatic');
  }
}

function pruneDbBackups(filePath: string): void {
  const configured = Number(process.env.XB_BACKUP_LIMIT || DEFAULT_BACKUP_LIMIT);
  const limit = Number.isFinite(configured) && configured >= 2 ? Math.floor(configured) : DEFAULT_BACKUP_LIMIT;
  for (const backup of listDbBackups(filePath).slice(limit)) {
    try { fs.unlinkSync(backup.path); } catch { /* best effort */ }
  }
}

function fsyncDirectory(dir: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch {
    // Some platforms do not permit syncing directory descriptors.
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
