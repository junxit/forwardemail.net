/**
 * Copyright (c) Forward Email LLC
 * SPDX-License-Identifier: BUSL-1.1
 */

const { Buffer } = require('node:buffer');

const pWaitFor = require('p-wait-for');

const config = require('#config');
const { decrypt } = require('#helpers/encrypt-decrypt');

// dynamically import file-type
let sqliteRegex;

import('sqlite-regex').then((obj) => {
  sqliteRegex = obj;
});

//
// NOTE: on all invocations of db.close() we run the pragma command "optimize"
// <https://phiresky.github.io/blog/2020/sqlite-performance-tuning/#more-things-that-must-be-run-manually>
// <https://www.sqlite.org/pragma.html#pragma_optimize>
//
async function setupPragma(db, session, cipher = 'chacha20') {
  // safeguards
  if (!db.open) throw new TypeError('Database is not open');
  if (db.memory) throw new TypeError('Memory database');
  // NOTE: if you change anything in here change backup in sqlite-server
  db.pragma(`cipher='${cipher}'`);
  if (typeof db.key === 'function')
    db.key(Buffer.from(decrypt(session.user.password)));
  else db.pragma(`key="${decrypt(session.user.password)}"`);
  try {
    db.pragma('journal_mode=WAL');
  } catch (err) {
    // legacy fallback
    if (
      cipher === 'chacha20' &&
      (err.code === 'SQLITE_NOTADB' || err.code === 'SQLITE_ERROR')
    )
      return setupPragma(db, session, 'aes256cbc');
    throw err;
  }

  // overwrite deleted content with zeros
  // <https://www.sqlite.org/pragma.html#pragma_secure_delete>
  db.pragma('secure_delete=ON');

  //
  // NOTE: we still run a manual vacuum every 24 hours
  //
  // turn on auto vacuum (for large amounts of deleted content)
  // <https://www.sqlite.org/pragma.html#pragma_auto_vacuum>
  //
  db.pragma('auto_vacuum=FULL');

  // <https://litestream.io/tips/#busy-timeout>
  db.pragma(`busy_timeout=${config.busyTimeout}`);

  // <https://litestream.io/tips/#synchronous-pragma>
  db.pragma('synchronous=NORMAL');

  //
  // NOTE: only if we're using Litestream
  // <https://litestream.io/tips/#disable-autocheckpoints-for-high-write-load-servers>
  //
  // db.pragma('wal_autocheckpoint=0');

  // db.pragma(`user_version="1"`);

  // may want to set locking mode to exclusive down the road (more involved with locking though)
  // <https://www.sqlite.org/pragma.html#pragma_locking_mode>

  // <https://s3.amazonaws.com/bizzabo.file.upload/XTUmoCXSCfit8PqUs2AT_B%20Johnson%20-%20Building%20Production%20Applications%20Using%20Go%20%26%20SQLite.pdf>
  db.pragma('foreign_keys=ON');

  // <https://www.sqlite.org/pragma.html#pragma_case_sensitive_like>
  // db.pragma('case_sensitive_like=true');

  // <https://www.sqlite.org/pragma.html#pragma_encoding>
  db.pragma(`encoding='UTF-8'`);

  if (db.readonly) db.pragma('query_only=true');

  // load regex extension for REGEX support
  if (!sqliteRegex) await pWaitFor(() => Boolean(sqliteRegex));
  db.loadExtension(sqliteRegex.getLoadablePath());

  //
  // <https://utelle.github.io/SQLite3MultipleCiphers/>
  //
  // > Additionally, the SQL command ATTACH supports the KEY keyword to allow
  //   to attach an encrypted database file to the current database connection:
  //
  // `ATTACH [DATABASE] <db-file-expression> AS <schema-name> [KEY <passphrase>]`
  //

  // TODO: compression, e.g. https://github.com/phiresky/sqlite-zstd
  // <https://github.com/m4heshd/better-sqlite3-multiple-ciphers/blob/master/docs/api.md#loadextensionpath-entrypoint---this>
  // db.loadExtension(...);
}

module.exports = setupPragma;
