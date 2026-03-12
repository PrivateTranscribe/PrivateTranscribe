const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { app } = require("electron");

class DatabaseManager {
  constructor() {
    this.db = null;
    this.initDatabase();
  }

  initDatabase() {
    try {
      const dbFileName =
        process.env.NODE_ENV === "development" ? "transcriptions-dev.db" : "transcriptions.db";

      const dbPath = path.join(app.getPath("userData"), dbFileName);

      this.db = new Database(dbPath);

      // Restrict the database file to owner read/write only.
      // This prevents other OS users on shared systems from reading transcription history.
      // Skipped on Windows where NTFS ACLs on the userData directory provide equivalent isolation.
      if (process.platform !== "win32") {
        try {
          fs.chmodSync(dbPath, 0o600);
        } catch (_) {
          // Non-fatal: best-effort on exotic/networked filesystems.
        }
      }

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS transcriptions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          text TEXT NOT NULL,
          timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          include_in_stats INTEGER NOT NULL DEFAULT 1
        )
      `);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS custom_dictionary (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          word TEXT NOT NULL UNIQUE,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Correction memory: learns mappings from what the model output -> what the user actually wanted.
      // Stored locally for privacy. Used to snap future transcripts to preferred spellings / identifiers.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS correction_memory (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source TEXT NOT NULL,
          target TEXT NOT NULL,
          count INTEGER DEFAULT 1,
          last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(source, target)
        )
      `);

      // Aggregate stats table - stores running totals independent of transcription history
      // These are not sensitive (just counts/times) so they persist even when transcriptions are cleared
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS stats (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          total_words INTEGER DEFAULT 0,
          total_transcriptions INTEGER DEFAULT 0,
          total_seconds REAL DEFAULT 0,
          average_wpm REAL DEFAULT 0,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // User-defined voice actions for the Action Engine (Pro feature).
      // CRUD is handled by ActionEngineManager; this table is created here so
      // that all schema lives in one place and migrations can reference it.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS actions (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          trigger_phrase TEXT NOT NULL,
          trigger_mode TEXT NOT NULL DEFAULT 'contains',
          action_type TEXT NOT NULL,
          action_config TEXT NOT NULL DEFAULT '{}',
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Action run history — append-only log of every action execution.
      // action_id / action_name / action_type are snapshotted at execution time so
      // that records remain useful even after the source action is deleted.
      // trigger_text is NULL for manual (test) executions triggered from the UI.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS action_runs (
          id TEXT PRIMARY KEY,
          action_id TEXT NOT NULL,
          action_name TEXT NOT NULL,
          action_type TEXT NOT NULL,
          trigger_text TEXT,
          triggered_by TEXT NOT NULL DEFAULT 'manual',
          success INTEGER NOT NULL,
          output TEXT,
          error TEXT,
          duration_ms INTEGER NOT NULL DEFAULT 0,
          triggered_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Ensure stats row exists
      this.db.exec(`
        INSERT OR IGNORE INTO stats (id, total_words, total_transcriptions, total_seconds, average_wpm)
        VALUES (1, 0, 0, 0, 0)
      `);

      // Migration: Add include_in_stats column if it doesn't exist (for existing databases)
      try {
        const txnColumns = this.db.prepare("PRAGMA table_info(transcriptions)").all();
        const hasIncludeInStats = txnColumns.some((col) => col.name === "include_in_stats");
        if (!hasIncludeInStats) {
          console.log("Migrating transcriptions table: adding include_in_stats column");
          this.db.exec(
            `ALTER TABLE transcriptions ADD COLUMN include_in_stats INTEGER NOT NULL DEFAULT 1`
          );
        }
      } catch (migrationError) {
        console.error("Migration warning:", migrationError.message);
      }

      // Migration: Add average_wpm column if it doesn't exist (for existing databases)
      try {
        const columns = this.db.prepare("PRAGMA table_info(stats)").all();
        const hasAverageWpm = columns.some((col) => col.name === "average_wpm");
        if (!hasAverageWpm) {
          console.log("Migrating stats table: adding average_wpm column");
          this.db.exec(`ALTER TABLE stats ADD COLUMN average_wpm REAL DEFAULT 0`);
          // Calculate initial WPM from existing data
          const stats = this.db
            .prepare("SELECT total_words, total_seconds FROM stats WHERE id = 1")
            .get();
          if (stats && stats.total_seconds > 0) {
            const averageWpm = stats.total_words / (stats.total_seconds / 60);
            this.db.prepare("UPDATE stats SET average_wpm = ? WHERE id = 1").run(averageWpm);
          }
        }
      } catch (migrationError) {
        console.error("Migration warning:", migrationError.message);
      }

      return true;
    } catch (error) {
      console.error("Database initialization failed:", error.message);
      throw error;
    }
  }

  saveTranscription(text, durationSeconds = null, options = {}) {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      const includeInStats = options?.includeInStats !== false;

      const stmt = this.db.prepare(
        "INSERT INTO transcriptions (text, include_in_stats) VALUES (?, ?)"
      );
      const result = stmt.run(text, includeInStats ? 1 : 0);

      const fetchStmt = this.db.prepare("SELECT * FROM transcriptions WHERE id = ?");
      const transcription = fetchStmt.get(result.lastInsertRowid);

      if (includeInStats) {
        // Update aggregate stats
        const wordCount = text.split(/\s+/).filter(Boolean).length;

        // Use actual recording duration if available, otherwise estimate at 150 WPM
        const actualSeconds =
          durationSeconds && durationSeconds > 0 ? durationSeconds : (wordCount / 150) * 60;

        // Get current stats to calculate cumulative average WPM
        const currentStats = this.db.prepare("SELECT * FROM stats WHERE id = 1").get();
        const newTotalWords = (currentStats?.total_words || 0) + wordCount;
        const newTotalSeconds = (currentStats?.total_seconds || 0) + actualSeconds;

        // Calculate average WPM: (total words / total minutes)
        const averageWPM = newTotalSeconds > 0 ? newTotalWords / (newTotalSeconds / 60) : 0;

        const updateStats = this.db.prepare(`
          UPDATE stats 
          SET total_words = total_words + ?,
              total_transcriptions = total_transcriptions + 1,
              total_seconds = total_seconds + ?,
              average_wpm = ?,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = 1
        `);
        updateStats.run(wordCount, actualSeconds, averageWPM);
      }

      return { id: result.lastInsertRowid, success: true, transcription };
    } catch (error) {
      console.error("Error saving transcription:", error.message);
      throw error;
    }
  }

  getTranscriptions(limit = 50) {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      const stmt = this.db.prepare("SELECT * FROM transcriptions ORDER BY timestamp DESC LIMIT ?");
      const transcriptions = stmt.all(limit);
      return transcriptions;
    } catch (error) {
      console.error("Error getting transcriptions:", error.message);
      throw error;
    }
  }

  clearTranscriptions() {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      const stmt = this.db.prepare("DELETE FROM transcriptions");
      const result = stmt.run();
      return { cleared: result.changes, success: true };
    } catch (error) {
      console.error("Error clearing transcriptions:", error.message);
      throw error;
    }
  }

  deleteTranscription(id) {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      const stmt = this.db.prepare("DELETE FROM transcriptions WHERE id = ?");
      const result = stmt.run(id);
      console.log(`🗑️ Deleted transcription ${id}, affected rows: ${result.changes}`);
      return { success: result.changes > 0, id };
    } catch (error) {
      console.error("❌ Error deleting transcription:", error);
      throw error;
    }
  }

  // Deletes all records beyond the newest `limit` entries (oldest first).
  // If limit is 0, deletes everything (same as clearTranscriptions).
  trimTranscriptions(limit) {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      if (limit <= 0) {
        return this.clearTranscriptions();
      }
      const stmt = this.db.prepare(`
        DELETE FROM transcriptions
        WHERE id NOT IN (
          SELECT id FROM transcriptions
          ORDER BY timestamp DESC, id DESC
          LIMIT ?
        )
      `);
      const result = stmt.run(limit);
      return { trimmed: result.changes, success: true };
    } catch (error) {
      console.error("Error trimming transcriptions:", error.message);
      throw error;
    }
  }

  getDictionary() {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      const stmt = this.db.prepare("SELECT word FROM custom_dictionary ORDER BY id ASC");
      const rows = stmt.all();
      return rows.map((row) => row.word);
    } catch (error) {
      console.error("Error getting dictionary:", error.message);
      throw error;
    }
  }

  setDictionary(words) {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      const transaction = this.db.transaction((wordList) => {
        this.db.prepare("DELETE FROM custom_dictionary").run();
        const insert = this.db.prepare("INSERT OR IGNORE INTO custom_dictionary (word) VALUES (?)");
        for (const word of wordList) {
          const trimmed = typeof word === "string" ? word.trim() : "";
          if (trimmed) {
            insert.run(trimmed);
          }
        }
      });
      transaction(words);
      return { success: true };
    } catch (error) {
      console.error("Error setting dictionary:", error.message);
      throw error;
    }
  }

  getCorrectionMemory(limit = 500) {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      const safeLimit = Math.max(1, Math.min(parseInt(limit, 10) || 500, 5000));
      const stmt = this.db.prepare(
        "SELECT source, target, count, last_seen_at, created_at FROM correction_memory ORDER BY count DESC, last_seen_at DESC LIMIT ?"
      );
      return stmt.all(safeLimit);
    } catch (error) {
      console.error("Error getting correction memory:", error.message);
      throw error;
    }
  }

  deleteCorrection(source) {
    try {
      const stmt = this.db.prepare("DELETE FROM correction_memory WHERE source = ?");
      stmt.run(source);
      return { success: true };
    } catch (error) {
      console.error("Error deleting correction:", error.message);
      return { success: false, error: error.message };
    }
  }

  upsertCorrection(source, target) {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      const src = typeof source === "string" ? source.trim() : "";
      const tgt = typeof target === "string" ? target.trim() : "";
      if (!src || !tgt || src === tgt) {
        return { success: false, reason: "invalid" };
      }

      const stmt = this.db.prepare(`
        INSERT INTO correction_memory (source, target, count, last_seen_at)
        VALUES (?, ?, 1, CURRENT_TIMESTAMP)
        ON CONFLICT(source, target)
        DO UPDATE SET count = count + 1, last_seen_at = CURRENT_TIMESTAMP
      `);
      stmt.run(src, tgt);
      return { success: true };
    } catch (error) {
      console.error("Error upserting correction:", error.message);
      throw error;
    }
  }

  getStats() {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      const stmt = this.db.prepare("SELECT * FROM stats WHERE id = 1");
      const stats = stmt.get();
      return stats || { total_words: 0, total_transcriptions: 0, total_seconds: 0 };
    } catch (error) {
      console.error("Error getting stats:", error.message);
      return { total_words: 0, total_transcriptions: 0, total_seconds: 0 };
    }
  }

  getStreakDates() {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      // Return distinct "YYYY-MM-DD" date strings for ALL real dictation sessions — no lookback
      // cap so the streak can grow indefinitely with daily use. substr() extracts the date
      // portion from the stored UTC-formatted timestamp string, consistent with how the renderer
      // parses timestamps (treating them as wall-clock local time). Streak computation in the
      // renderer uses toLocalDateKey(new Date()) for today, so both sides apply the same
      // UTC-as-local approximation.
      const stmt = this.db.prepare(`
        SELECT DISTINCT substr(timestamp, 1, 10) AS date_key
        FROM transcriptions
        WHERE include_in_stats = 1
        ORDER BY date_key DESC
      `);
      return stmt.all().map((r) => r.date_key);
    } catch (error) {
      console.error("Error getting streak dates:", error.message);
      return [];
    }
  }

  resetStats() {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }

      const tx = this.db.transaction(() => {
        this.db
          .prepare(
            `
          UPDATE stats
          SET total_words = 0,
              total_transcriptions = 0,
              total_seconds = 0,
              average_wpm = 0,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = 1
        `
          )
          .run();

        // Reset the streak basis as well by marking all existing history entries as
        // excluded from aggregate/streak calculations. This preserves transcript history
        // while giving the user a true "fresh stats" reset.
        this.db
          .prepare(`UPDATE transcriptions SET include_in_stats = 0 WHERE include_in_stats != 0`)
          .run();
      });

      tx();
      return { success: true };
    } catch (error) {
      console.error("Error resetting stats:", error.message);
      throw error;
    }
  }

  cleanup() {
    console.log("Starting database cleanup...");
    try {
      const dbPath = path.join(
        app.getPath("userData"),
        process.env.NODE_ENV === "development" ? "transcriptions-dev.db" : "transcriptions.db"
      );
      if (fs.existsSync(dbPath)) {
        fs.unlinkSync(dbPath);
        console.log("✅ Database file deleted:", dbPath);
      }
    } catch (error) {
      console.error("❌ Error deleting database file:", error);
    }
  }
}

module.exports = DatabaseManager;
