import type { Database, SqlJsStatic } from 'sql.js';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);

let sqlPromise: Promise<SqlJsStatic> | undefined;

const WASM_PAGE_BYTES = 64 * 1024;
const DEFAULT_SQL_WASM_INITIAL_MB = 512;
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
  const SQL = await getSql();
  if (fs.existsSync(filePath)) {
    const buf = fs.readFileSync(filePath);
    return new SQL.Database(buf);
  }
  return new SQL.Database();
}

export async function createDb(): Promise<Database> {
  const SQL = await getSql();
  return new SQL.Database();
}

export function saveDb(db: Database, filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const data = db.export();
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, Buffer.from(data));
  fs.renameSync(tmp, filePath);
}
