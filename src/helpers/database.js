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
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS custom_dictionary (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          word TEXT NOT NULL UNIQUE,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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

      // Ensure stats row exists
      this.db.exec(`
        INSERT OR IGNORE INTO stats (id, total_words, total_transcriptions, total_seconds, average_wpm)
        VALUES (1, 0, 0, 0, 0)
      `);

      // Migration: Add average_wpm column if it doesn't exist (for existing databases)
      try {
        const columns = this.db.prepare("PRAGMA table_info(stats)").all();
        const hasAverageWpm = columns.some(col => col.name === 'average_wpm');
        if (!hasAverageWpm) {
          console.log("Migrating stats table: adding average_wpm column");
          this.db.exec(`ALTER TABLE stats ADD COLUMN average_wpm REAL DEFAULT 0`);
          // Calculate initial WPM from existing data
          const stats = this.db.prepare("SELECT total_words, total_seconds FROM stats WHERE id = 1").get();
          if (stats && stats.total_seconds > 0) {
            const averageWpm = (stats.total_words / (stats.total_seconds / 60));
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
      const stmt = this.db.prepare("INSERT INTO transcriptions (text) VALUES (?)");
      const result = stmt.run(text);

      const fetchStmt = this.db.prepare("SELECT * FROM transcriptions WHERE id = ?");
      const transcription = fetchStmt.get(result.lastInsertRowid);

      const includeInStats = options?.includeInStats !== false;

      if (includeInStats) {
        // Update aggregate stats
        const wordCount = text.split(/\s+/).filter(Boolean).length;

        // Use actual recording duration if available, otherwise estimate at 150 WPM
        const actualSeconds = durationSeconds && durationSeconds > 0
          ? durationSeconds
          : (wordCount / 150) * 60;

        // Get current stats to calculate cumulative average WPM
        const currentStats = this.db.prepare("SELECT * FROM stats WHERE id = 1").get();
        const newTotalWords = (currentStats?.total_words || 0) + wordCount;
        const newTotalSeconds = (currentStats?.total_seconds || 0) + actualSeconds;

        // Calculate average WPM: (total words / total minutes)
        const averageWPM = newTotalSeconds > 0 ? (newTotalWords / (newTotalSeconds / 60)) : 0;

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
