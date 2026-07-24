import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Platform, RawVideo, Snapshot, VideoRow, VideoState } from "./types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS videos (
  platform TEXT NOT NULL,
  platform_id TEXT NOT NULL,
  url TEXT NOT NULL,
  creator TEXT NOT NULL,
  caption TEXT NOT NULL DEFAULT '',
  transcript TEXT,
  transcript_checked INTEGER NOT NULL DEFAULT 0,
  duration_seconds REAL NOT NULL DEFAULT 0,
  posted_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'new',
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  observation_count INTEGER NOT NULL DEFAULT 0,
  reject_reason TEXT,
  processed_at TEXT,
  score REAL,
  PRIMARY KEY (platform, platform_id)
);

CREATE TABLE IF NOT EXISTS snapshots (
  platform TEXT NOT NULL,
  platform_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  plays INTEGER NOT NULL DEFAULT 0,
  likes INTEGER NOT NULL DEFAULT 0,
  comments INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (platform, platform_id, run_id)
);

CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  discovered INTEGER NOT NULL DEFAULT 0,
  qualified INTEGER NOT NULL DEFAULT 0,
  scripts INTEGER NOT NULL DEFAULT 0,
  apify_cost_usd REAL NOT NULL DEFAULT 0,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS scripts (
  run_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  platform_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  topic TEXT NOT NULL,
  hook TEXT NOT NULL,
  body TEXT NOT NULL,
  cta TEXT NOT NULL,
  caption_hook TEXT NOT NULL DEFAULT '',
  caption_body TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (run_id, platform, platform_id)
);

CREATE INDEX IF NOT EXISTS idx_videos_state ON videos(state);
CREATE INDEX IF NOT EXISTS idx_snapshots_video ON snapshots(platform, platform_id, captured_at);
`;

export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = DELETE");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(SCHEMA);
    const videoColumns = new Set(
      (
        this.db.prepare("PRAGMA table_info(videos)").all() as unknown as Array<{
          name: string;
        }>
      ).map((column) => column.name),
    );
    if (!videoColumns.has("transcript_checked")) {
      this.db.exec(
        "ALTER TABLE videos ADD COLUMN transcript_checked INTEGER NOT NULL DEFAULT 0",
      );
    }
    const scriptColumns = new Set(
      (
        this.db.prepare("PRAGMA table_info(scripts)").all() as unknown as Array<{
          name: string;
        }>
      ).map((column) => column.name),
    );
    if (!scriptColumns.has("caption_hook")) {
      this.db.exec(
        "ALTER TABLE scripts ADD COLUMN caption_hook TEXT NOT NULL DEFAULT ''",
      );
    }
    if (!scriptColumns.has("caption_body")) {
      this.db.exec(
        "ALTER TABLE scripts ADD COLUMN caption_body TEXT NOT NULL DEFAULT ''",
      );
    }
  }

  close() {
    this.db.close();
  }

  startRun(runId: string, startedAt: string) {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO runs (run_id, started_at, status) VALUES (?, ?, 'running')",
      )
      .run(runId, startedAt);
  }

  getRun(runId: string) {
    return this.db
      .prepare("SELECT * FROM runs WHERE run_id = ?")
      .get(runId) as
      | {
          run_id: string;
          started_at: string;
          finished_at: string | null;
          status: string;
          discovered: number;
          qualified: number;
          scripts: number;
        }
      | undefined;
  }

  finishRun(
    runId: string,
    finishedAt: string,
    status: string,
    counts: { discovered: number; qualified: number; scripts: number },
    notes?: string,
  ) {
    this.db
      .prepare(
        `UPDATE runs SET finished_at = ?, status = ?, discovered = ?, qualified = ?, scripts = ?, notes = ?
         WHERE run_id = ?`,
      )
      .run(
        finishedAt,
        status,
        counts.discovered,
        counts.qualified,
        counts.scripts,
        notes ?? null,
        runId,
      );
  }

  upsertVideo(v: RawVideo, now: string): { inserted: boolean } {
    const existing = this.getVideo(v.platform, v.platformId);
    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO videos
           (platform, platform_id, url, creator, caption, transcript, transcript_checked, duration_seconds,
            posted_at, state, first_seen_at, last_seen_at, observation_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, 1)`,
        )
        .run(
          v.platform,
          v.platformId,
          v.url,
          v.creator,
          v.caption,
          v.transcript,
          v.transcriptChecked ? 1 : 0,
          v.durationSeconds,
          v.postedAt,
          now,
          now,
        );
      return { inserted: true };
    }

    if (existing.state === "processed" || existing.state === "rejected") {
      this.db
        .prepare(
          "UPDATE videos SET last_seen_at = ? WHERE platform = ? AND platform_id = ?",
        )
        .run(now, v.platform, v.platformId);
      return { inserted: false };
    }

    this.db
      .prepare(
        `UPDATE videos
         SET last_seen_at = ?, observation_count = observation_count + 1,
             transcript = COALESCE(NULLIF(?, ''), transcript),
             transcript_checked = CASE WHEN ? = 1 THEN 1 ELSE transcript_checked END,
             caption = CASE WHEN ? <> '' THEN ? ELSE caption END
         WHERE platform = ? AND platform_id = ?`,
      )
      .run(
        now,
        v.transcript ?? "",
        v.transcriptChecked ? 1 : 0,
        v.caption,
        v.caption,
        v.platform,
        v.platformId,
      );
    return { inserted: false };
  }

  recordSnapshot(s: Snapshot) {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO snapshots
         (platform, platform_id, run_id, captured_at, plays, likes, comments)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        s.platform,
        s.platform_id,
        s.run_id,
        s.captured_at,
        s.plays,
        s.likes,
        s.comments,
      );
  }

  setTranscriptResult(
    platform: Platform,
    platformId: string,
    transcript: string | null,
  ) {
    this.db
      .prepare(
        `UPDATE videos
         SET transcript = ?, transcript_checked = 1
         WHERE platform = ? AND platform_id = ?`,
      )
      .run(transcript, platform, platformId);
  }

  getVideo(platform: Platform, platformId: string): VideoRow | undefined {
    return this.db
      .prepare("SELECT * FROM videos WHERE platform = ? AND platform_id = ?")
      .get(platform, platformId) as unknown as VideoRow | undefined;
  }

  latestSnapshot(platform: Platform, platformId: string): Snapshot | undefined {
    return this.db
      .prepare(
        `SELECT * FROM snapshots WHERE platform = ? AND platform_id = ?
         ORDER BY captured_at DESC LIMIT 1`,
      )
      .get(platform, platformId) as unknown as Snapshot | undefined;
  }

  earliestSnapshot(platform: Platform, platformId: string): Snapshot | undefined {
    return this.db
      .prepare(
        `SELECT * FROM snapshots WHERE platform = ? AND platform_id = ?
         ORDER BY captured_at ASC LIMIT 1`,
      )
      .get(platform, platformId) as unknown as Snapshot | undefined;
  }

  openVideos(): VideoRow[] {
    return this.db
      .prepare(
        "SELECT * FROM videos WHERE state IN ('new','observing','qualified')",
      )
      .all() as unknown as VideoRow[];
  }

  setState(
    platform: Platform,
    platformId: string,
    state: VideoState,
    opts: { rejectReason?: string; score?: number; processedAt?: string } = {},
  ) {
    this.db
      .prepare(
        `UPDATE videos SET state = ?,
           reject_reason = COALESCE(?, reject_reason),
           score = COALESCE(?, score),
           processed_at = COALESCE(?, processed_at)
         WHERE platform = ? AND platform_id = ?`,
      )
      .run(
        state,
        opts.rejectReason ?? null,
        opts.score ?? null,
        opts.processedAt ?? null,
        platform,
        platformId,
      );
  }

  saveScript(
    runId: string,
    platform: Platform,
    platformId: string,
    createdAt: string,
    topic: string,
    hook: string,
    body: string,
    cta: string,
    captionHook: string,
    captionBody: string,
  ) {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO scripts
         (run_id, platform, platform_id, created_at, topic, hook, body, cta, caption_hook, caption_body)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        platform,
        platformId,
        createdAt,
        topic,
        hook,
        body,
        cta,
        captionHook,
        captionBody,
      );
  }

  scriptsForRun(runId: string) {
    return this.db
      .prepare("SELECT * FROM scripts WHERE run_id = ? ORDER BY rowid")
      .all(runId) as unknown as Array<{
      platform: Platform;
      platform_id: string;
      topic: string;
      hook: string;
      body: string;
      cta: string;
      caption_hook: string;
      caption_body: string;
    }>;
  }

  prune(olderThanDays: number, now: Date) {
    const cutoff = new Date(now.getTime() - olderThanDays * 86400000).toISOString();

    const text = this.db
      .prepare(
        `UPDATE videos SET transcript = NULL, caption = ''
         WHERE state IN ('processed','expired','rejected')
           AND last_seen_at < ?
           AND (transcript IS NOT NULL OR caption <> '')`,
      )
      .run(cutoff);

    const snaps = this.db
      .prepare(
        `DELETE FROM snapshots WHERE captured_at < ?
         AND (platform, platform_id) IN (
           SELECT platform, platform_id FROM videos
           WHERE state IN ('processed','expired','rejected')
         )`,
      )
      .run(cutoff);

    this.db.exec("VACUUM");
    return { videosTrimmed: Number(text.changes), snapshotsDeleted: Number(snaps.changes) };
  }

  stats() {
    const byState = this.db
      .prepare("SELECT state, COUNT(*) AS n FROM videos GROUP BY state")
      .all() as unknown as Array<{ state: string; n: number }>;
    const totals = this.db
      .prepare(
        "SELECT (SELECT COUNT(*) FROM videos) AS videos, (SELECT COUNT(*) FROM snapshots) AS snapshots, (SELECT COUNT(*) FROM scripts) AS scripts",
      )
      .get() as unknown as { videos: number; snapshots: number; scripts: number };
    return { byState, totals };
  }
}
