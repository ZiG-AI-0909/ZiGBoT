/**
 * SQLite persistence (better-sqlite3), single schema home for ZiGBoT.
 * Migrations run in order; applied versions are tracked in schema_migrations.
 * The rest of the codebase must not write raw SQL outside this module.
 */
const fs = require('node:fs');
const path = require('node:path');

let Database;
try {
    Database = require('better-sqlite3');
} catch {
    Database = null;
}

const migrations = [
    {
        version: 1,
        up: (db) => {
            db.exec(`
                CREATE TABLE IF NOT EXISTS warnings (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    guild_id TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    reason TEXT NOT NULL DEFAULT 'No reason provided',
                    issued_by TEXT NOT NULL,
                    created_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_warnings_guild_user
                    ON warnings (guild_id, user_id);
            `);
        }
    }
];

function openDatabase(dbPath) {
    if (!Database) {
        throw new Error('better-sqlite3 is not installed. Run: npm install');
    }
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');

    db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
    const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map((row) => row.version));
    const insertMigration = db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)');

    for (const migration of migrations) {
        if (applied.has(migration.version)) continue;
        const run = db.transaction(() => {
            migration.up(db);
            insertMigration.run(migration.version, Date.now());
        });
        run();
    }

    return db;
}

class WarnStore {
    constructor(db) {
        this.db = db;
        this.insert = db.prepare(
            'INSERT INTO warnings (guild_id, user_id, reason, issued_by, created_at) VALUES (?, ?, ?, ?, ?)'
        );
        this.byUser = db.prepare(
            'SELECT id, reason, issued_by, created_at FROM warnings WHERE guild_id = ? AND user_id = ? ORDER BY created_at ASC'
        );
        this.countByUser = db.prepare(
            'SELECT COUNT(*) AS count FROM warnings WHERE guild_id = ? AND user_id = ?'
        );
    }

    addWarning(guildId, userId, reason, issuedBy) {
        const info = this.insert.run(guildId, userId, reason, issuedBy, Date.now());
        return { id: Number(info.lastInsertRowid), reason, issuedBy };
    }

    listWarnings(guildId, userId) {
        return this.byUser.all(guildId, userId);
    }

    countWarnings(guildId, userId) {
        return this.countByUser.get(guildId, userId).count;
    }
}

module.exports = { openDatabase, WarnStore, migrations };
