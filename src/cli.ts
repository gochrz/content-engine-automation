import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { loadConfig } from "./config.js";
import { Store } from "./db.js";
import { assertSpendUnderLimit, runActorSync, SpendGuardError } from "./apify.js";
import {
  INSTAGRAM_ACTOR,
  buildInstagramInput,
  buildInstagramTranscriptInput,
  normalizeInstagram,
} from "./adapters/instagram.js";
import { evaluate, selectTop } from "./rank.js";
import { generateScripts } from "./generate.js";
import { renderEmail, renderText, sendEmail, formatDate } from "./deliver.js";
import { prepareCandidatesForGeneration } from "./transcribe.js";
import type { Candidate, Config, RawVideo, Script } from "./types.js";

const DB_PATH = process.env.DB_PATH ?? "state/engine.db";
const VOICE_GUIDE = process.env.VOICE_GUIDE ?? "voice/seth-voice-guide.md";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function runIdFor(now: Date): string {
  return process.env.GITHUB_RUN_ID ?? now.toISOString().slice(0, 19).replace(/[:T]/g, "");
}

async function discoverInstagram(cfg: Config): Promise<RawVideo[]> {
  const usernames = cfg.sources.instagram;
  if (usernames.length === 0) return [];

  if (process.env.FIXTURE_FILE) {
    const items = JSON.parse(readFileSync(process.env.FIXTURE_FILE, "utf8"));
    console.log(`[discover] fixture mode: ${items.length} raw items`);
    return normalizeInstagram(items);
  }

  const token = requireEnv("APIFY_TOKEN");
  const maxItems = usernames.length * cfg.discovery.reelsPerProfile;
  const input = buildInstagramInput(usernames, cfg.discovery);

  console.log(
    `[discover] instagram: ${usernames.length} profiles, hard cap ${maxItems} items`,
  );
  const items = await runActorSync(token, INSTAGRAM_ACTOR, input, maxItems);
  console.log(`[discover] instagram returned ${items.length} items`);
  return normalizeInstagram(items);
}

async function fetchInstagramTranscripts(
  urls: string[],
  cfg: Config,
): Promise<RawVideo[]> {
  if (urls.length === 0) return [];

  if (process.env.TRANSCRIPT_FIXTURE_FILE) {
    const items = JSON.parse(
      readFileSync(process.env.TRANSCRIPT_FIXTURE_FILE, "utf8"),
    );
    console.log(`[transcribe] fixture mode: ${items.length} raw items`);
    return normalizeInstagram(items, { transcriptRequested: true });
  }

  const token = requireEnv("APIFY_TOKEN");
  await assertSpendUnderLimit(
    token,
    cfg.spend.abortIfMonthToDateExceedsUsd,
  );
  console.log(`[transcribe] requesting ${urls.length} selected Reel transcripts`);
  const items = await runActorSync(
    token,
    INSTAGRAM_ACTOR,
    buildInstagramTranscriptInput(urls),
    urls.length,
  );
  return normalizeInstagram(items, { transcriptRequested: true });
}

async function cmdDiscover() {
  const cfg = loadConfig();
  const now = new Date();
  const runId = runIdFor(now);
  const store = new Store(DB_PATH);

  try {
    const existingRun = store.getRun(runId);
    if (
      existingRun &&
      ["discovered", "preview", "delivered", "empty"].includes(existingRun.status)
    ) {
      writeFileSync(".run-id", runId);
      console.log(
        `[discover] discovery already saved for run ${runId}; skipping actor call`,
      );
      return;
    }

    if (!process.env.FIXTURE_FILE) {
      await assertSpendUnderLimit(
        requireEnv("APIFY_TOKEN"),
        cfg.spend.abortIfMonthToDateExceedsUsd,
      );
    }

    store.startRun(runId, now.toISOString());

    const videos = await discoverInstagram(cfg);
    let inserted = 0;

    for (const v of videos) {
      const existing = store.getVideo(v.platform, v.platformId);
      if (existing?.state === "processed") continue;

      const result = store.upsertVideo(v, now.toISOString());
      if (result.inserted) inserted++;

      store.recordSnapshot({
        platform: v.platform,
        platform_id: v.platformId,
        run_id: runId,
        captured_at: now.toISOString(),
        plays: v.plays,
        likes: v.likes,
        comments: v.comments,
      });
    }

    console.log(`[discover] ${videos.length} seen, ${inserted} new`);

    let qualified = 0;
    for (const video of store.openVideos()) {
      const ev = evaluate(store, video, cfg, now);
      store.setState(video.platform, video.platform_id, ev.nextState, {
        rejectReason: ev.reason ?? undefined,
        score: ev.candidate?.score,
      });
      if (ev.nextState === "qualified") qualified++;
    }

    console.log(`[discover] ${qualified} qualified for scripting`);
    store.finishRun(runId, new Date().toISOString(), "discovered", {
      discovered: videos.length,
      qualified,
      scripts: 0,
    });
    writeFileSync(".run-id", runId);
  } finally {
    store.close();
  }
}

async function cmdPublish() {
  const cfg = loadConfig();
  const now = new Date();
  const runId = existsSync(".run-id")
    ? readFileSync(".run-id", "utf8").trim()
    : runIdFor(now);
  const store = new Store(DB_PATH);
  const dryRun = process.env.DRY_RUN === "1";
  const mockOpenAI = process.env.MOCK_OPENAI === "1";

  try {
    const existingRun = store.getRun(runId);
    if (
      existingRun &&
      ["preview", "delivered", "empty"].includes(existingRun.status)
    ) {
      console.log(
        `[publish] publish already completed for run ${runId} with status ${existingRun.status}`,
      );
      return;
    }

    const candidates: Candidate[] = [];
    for (const video of store.openVideos()) {
      if (video.state !== "qualified") continue;
      const ev = evaluate(store, video, cfg, now);
      if (ev.candidate) candidates.push(ev.candidate);
    }

    if (candidates.length === 0) {
      console.log("[publish] nothing qualified; no email sent");
      store.finishRun(runId, now.toISOString(), "empty", {
        discovered: 0,
        qualified: 0,
        scripts: 0,
      });
      return;
    }

    const picked = selectTop(candidates, cfg);
    console.log(`[publish] ${candidates.length} qualified, ${picked.length} selected`);

    const prepared = await prepareCandidatesForGeneration(
      picked,
      store,
      cfg.qualification.minTranscriptWords,
      (urls) => fetchInstagramTranscripts(urls, cfg),
    );

    if (prepared.rejected.length > 0) {
      console.log(
        `[publish] rejected ${prepared.rejected.length} selected Reels with no usable speech`,
      );
    }
    if (prepared.missing.length > 0) {
      console.warn(
        `[publish] ${prepared.missing.length} transcript results were missing and remain queued`,
      );
    }
    if (prepared.ready.length === 0) {
      console.log("[publish] no selected Reels had usable speech; no email sent");
      store.finishRun(runId, now.toISOString(), "empty", {
        discovered: 0,
        qualified: candidates.length,
        scripts: 0,
      });
      return;
    }

    const { scripts, failures } = await generateScripts(prepared.ready, cfg, {
      apiKey: mockOpenAI ? "mock-openai" : requireEnv("OPENAI_API_KEY"),
      model: cfg.generation.model,
      voiceGuidePath: VOICE_GUIDE,
    }, mockOpenAI ? fakeCompletion : undefined);

    if (failures.length) {
      console.warn(`[publish] ${failures.length} scripts failed to generate`);
      for (const f of failures) console.warn(`  ${f.id}: ${f.error}`);
    }

    if (scripts.length === 0) {
      throw new Error("all script generations failed; state preserved for retry");
    }

    for (const s of scripts) {
      store.saveScript(
        runId,
        s.platform,
        s.platformId,
        now.toISOString(),
        s.topic,
        s.hook,
        s.body,
        s.cta,
        s.captionHook,
        s.captionBody,
      );
    }

    const html = renderEmail(scripts, cfg, now);
    const text = renderText(scripts);
    const subject = `${cfg.delivery.subjectPrefix} — ${formatDate(now, cfg.delivery.timezone)}`;

    if (dryRun) {
      writeFileSync("out/preview.html", html);
      writeFileSync("out/preview.txt", text);
      console.log(`[publish] dry run: wrote out/preview.html (${scripts.length} scripts)`);
    } else {
      const user = requireEnv("GMAIL_USER");
      const messageId = await sendEmail(html, text, subject, cfg, {
        user,
        pass: requireEnv("GMAIL_APP_PASSWORD"),
        from: process.env.GMAIL_FROM ?? user,
      });
      console.log(`[publish] sent ${scripts.length} scripts (${messageId})`);
    }

    if (!dryRun) {
      for (const s of scripts) {
        store.setState(s.platform, s.platformId, "processed", {
          processedAt: now.toISOString(),
        });
      }
    }

    store.finishRun(runId, new Date().toISOString(), dryRun ? "preview" : "delivered", {
      discovered: 0,
      qualified: candidates.length,
      scripts: scripts.length,
    });
  } finally {
    store.close();
  }
}

const fakeCompletion = async (prompt: string) => {
  const creator = /Creator: (.+)/.exec(prompt)?.[1] ?? "unknown";
  return {
    topic: `Deal breakdown inspired by ${creator}`,
    hook: "Everybody told me this house was a teardown.",
    body: "So I walked it anyway. Foundation was solid, roof had maybe four years left, and the only real problem was thirty years of somebody else's stuff.\n\nThat is not a teardown. That is a dumpster and two weekends.",
    cta: "Comment DEAL and I will send you the walkthrough checklist.",
    captionHook: "Tag the person who calls every ugly house a teardown.",
    captionBody: "The deal usually gets clearer when you separate cleanup from structural work.",
  };
};

function cmdPrune() {
  const days = Number(process.env.PRUNE_AFTER_DAYS ?? 90);
  const store = new Store(DB_PATH);
  try {
    const result = store.prune(days, new Date());
    console.log(
      `[prune] cleared text from ${result.videosTrimmed} closed videos and removed ${result.snapshotsDeleted} old snapshots (dedup keys kept)`,
    );
  } finally {
    store.close();
  }
}

function cmdGuard() {
  const cfg = loadConfig();
  const now = new Date();
  const localHour = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: cfg.delivery.timezone,
      hour: "numeric",
      hour12: false,
    }).format(now),
  );
  const target = cfg.delivery.hour;

  if (localHour === target) {
    console.log(`[guard] ${localHour}:00 in ${cfg.delivery.timezone} matches target — proceeding`);
    return;
  }
  console.log(
    `[guard] ${localHour}:00 in ${cfg.delivery.timezone} is not the target hour (${target}) — skipping this trigger`,
  );
  process.exit(4);
}

async function cmdNotifyFailure() {
  const cfg = loadConfig();
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) {
    console.error("[notify] Gmail credentials missing; cannot send failure alert");
    return;
  }
  const { sendFailureAlert } = await import("./deliver.js");
  await sendFailureAlert(
    cfg,
    { user, pass, from: process.env.GMAIL_FROM ?? user },
    process.env.GITHUB_RUN_ID ?? "local",
    process.env.FAILURE_REASON ?? "see workflow logs",
    process.env.RUN_URL ?? "",
  );
  console.log("[notify] failure alert sent");
}

function cmdStatus() {
  const store = new Store(DB_PATH);
  try {
    const { byState, totals } = store.stats();
    console.log(`videos: ${totals.videos}  snapshots: ${totals.snapshots}  scripts: ${totals.scripts}`);
    for (const row of byState) console.log(`  ${row.state.padEnd(10)} ${row.n}`);
  } finally {
    store.close();
  }
}

async function main() {
  const cmd = process.argv[2];
  try {
    if (cmd === "discover") await cmdDiscover();
    else if (cmd === "publish") await cmdPublish();
    else if (cmd === "status") cmdStatus();
    else if (cmd === "guard") cmdGuard();
    else if (cmd === "prune") cmdPrune();
    else if (cmd === "notify-failure") await cmdNotifyFailure();
    else {
      console.error("usage: cli.ts <guard|discover|publish|status|prune|notify-failure>");
      process.exit(2);
    }
  } catch (err) {
    if (err instanceof SpendGuardError) {
      console.error(`[abort] ${err.message}`);
      process.exit(3);
    }
    throw err;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
