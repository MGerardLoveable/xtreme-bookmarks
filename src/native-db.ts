import { createRequire } from 'node:module';
import type { Database } from 'sql.js';

const require = createRequire(import.meta.url);

// Preserve the sql.js interface while letting SQLite persist individual pages.
export function openNativeDatabase(filePath: string): Database {
  const { DatabaseSync } = require('node:sqlite');
  const connection = new DatabaseSync(filePath, {
    enableForeignKeyConstraints: false,
    enableDoubleQuotedStringLiterals: true,
  });
  connection.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
  const values = (input?: any) => Array.isArray(input)
    ? input.map((value) => value === undefined ? null : typeof value === 'boolean' ? Number(value) : value)
    : input ?? [];
  const apply = (statement: any, method: string, input?: any) => {
    const params = values(input);
    return Array.isArray(params) ? statement[method](...params) : statement[method](params);
  };
  const adapter = {
    native: true,
    connection,
    run(sql: string, params?: any) {
      if (params !== undefined) apply(connection.prepare(sql), 'run', params);
      else connection.exec(sql);
      return adapter;
    },
    exec(sql: string, params?: any) {
      const statement = connection.prepare(sql);
      if (!statement.columns().length) { apply(statement, 'run', params); return []; }
      statement.setReturnArrays(true);
      const rows = apply(statement, 'all', params);
      return rows.length ? [{ columns: statement.columns().map((column: any) => column.name), values: rows }] : [];
    },
    prepare(sql: string, initial?: any) {
      const statement = connection.prepare(sql);
      statement.setReturnArrays(true);
      let params = initial;
      let iterator: Iterator<any> | undefined;
      let current: any[] = [];
      return {
        run(input?: any) { apply(statement, 'run', input ?? params); return true; },
        bind(input: any) { params = input; iterator = undefined; return true; },
        step() {
          if (!iterator) {
            const p = values(params);
            iterator = Array.isArray(p) ? statement.iterate(...p) : statement.iterate(p);
          }
          const next = iterator!.next();
          current = next.value ?? [];
          return !next.done;
        },
        get(input?: any) { if (input !== undefined) return apply(statement, 'get', input) ?? []; return current; },
        getAsObject() { return Object.fromEntries(statement.columns().map((column: any, index: number) => [column.name, current[index]])); },
        getColumnNames() { return statement.columns().map((column: any) => column.name); },
        reset() { iterator = undefined; current = []; return true; },
        free() { iterator?.return?.(); iterator = undefined; return true; },
      };
    },
    getRowsModified() { return Number(connection.prepare('SELECT changes() AS count').get().count); },
    close() { connection.close(); },
  };
  return adapter as unknown as Database;
}

export function nativeConnection(db: Database): any | undefined {
  return (db as unknown as { native?: boolean; connection?: unknown }).native
    ? (db as unknown as { connection: unknown }).connection : undefined;
}
