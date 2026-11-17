import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { log } from '../log.js';
import { migrations } from './schema.js';

export type DB = Database.Database;

let db: DB | null = null;
/** False if the sqlite-vec extension failed to load; recall then ranks vectors in JS. */
export let vectorExtension = false;

export function openDb(path = join(config.dataDir, 'agent.db')): DB {
  if (path !== ':memory:') mkdirSync(config.dataDir, { recursive: true });
  const d = new Database(path);
  d.pragma('journal_mode = WAL');     // the job worker reads while the server writes
  d.pragma('synchronous = NORMAL');
  d.pragma('foreign_keys = ON');
  d.pragma('busy_timeout = 5000');
  try {
    sqliteVec.load(d);
    vectorExtension = true;
  } catch (err) {
    vectorExtension = false;
    log.warn({ err: String(err) }, 'sqlite-vec unavailable; falling back to JS cosine similarity');
  }
  migrate(d);
  return d;
}

function migrate(d: DB) {
  const current = d.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < migrations.length; v++) {
    d.transaction(() => {
      d.exec(migrations[v]);
      d.pragma(`user_version = ${v + 1}`);
    })();
    log.info({ version: v + 1 }, 'database migrated');
  }
}

export function getDb(): DB {
  if (!db) db = openDb();
  return db;
}

/** For tests: use an isolated database. */
export function setDb(d: DB) {
  db = d;
}
