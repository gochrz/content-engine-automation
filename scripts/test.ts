import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import {
  buildInstagramInput,
  buildInstagramTranscriptInput,
  normalizeInstagram,
} from "../src/adapters/instagram.js";
import { Store } from "../src/db.js";
import {
  evaluate,
  refreshCandidates,
  selectTop,
  velocity,
  wordCount,
} from "../src/rank.js";
import {
  applyTranscriptResults,
  prepareCandidatesForGeneration,
} from "../src/transcribe.js";
import { buildOpenAIRequest, generateScripts } from "../src/generate.js";
import { renderEmail, renderText } from "../src/deliver.js";
import { loadConfig } from "../src/config.js";
import type { Candidate } from "../src/types.js";

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail = "") {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title: string) {
  console.log(`\n${title}`);
}

const TMP = "/tmp/ce-test";
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

const LONG_TRANSCRIPT =
  "So I get a call about a property everybody had already passed on and the seller " +
  "wanted way too much for it at first but after we walked the numbers together it " +
  "turned out the roof was the only real problem and that changed the whole deal " +
  "because now we are talking about a repair instead of a rebuild and that is a " +
  "completely different conversation with a completely different spread on the back end.";

const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString();

function reel(over: Record<string, unknown> = {}) {
  return {
    id: "3000000000000000001",
    shortCode: "ABC123",
    type: "Video",
    productType: "clips",
    url: "https://www.instagram.com/reel/ABC123/",
    caption: "How I saved this deal #realestate",
    hashtags: ["realestate"],
    transcript: LONG_TRANSCRIPT,
    commentsCount: 210,
    likesCount: 4200,
    videoViewCount: 90000,
    videoPlayCount: 180000,
    videoDuration: 48.2,
    timestamp: daysAgo(6),
    ownerUsername: "pacemorby",
    isPinned: false,
    ...over,
  };
}

section("1. Normalization of real Apify output shapes");
{
  const items = [
    reel(),
    reel({ id: "2", shortCode: "B2", likesCount: -1, ownerUsername: "flipwithzach" }),
    reel({ id: "3", shortCode: "B3", transcript: undefined, ownerUsername: "tyson_smith" }),
    reel({ id: "4", shortCode: "B4", productType: "igtv" }),
    reel({ id: undefined, shortCode: undefined }),
    reel({ id: "6", shortCode: "B6", timestamp: "not-a-date" }),
    reel({ id: "7", shortCode: "B7", url: undefined, inputUrl: undefined }),
    { error: "profile_not_found", errorDescription: "no such user" },
    null,
    "garbage",
  ];

  const out = normalizeInstagram(items as unknown[]);
  const ids = out.map((v) => v.platformId);

  check("keeps valid reels", ids.includes("3000000000000000001"));
  check("drops non-clip product types", !ids.includes("4"));
  check("drops items with no id", out.length === 4, `got ids ${ids.join(",")}`);
  check("drops unparseable timestamps", !ids.includes("6"));
  check("drops actor error rows", !ids.some((i) => i === undefined));
  check(
    "clamps likesCount of -1 to 0",
    out.find((v) => v.platformId === "2")?.likes === 0,
  );
  check(
    "rebuilds url from shortCode when url is missing",
    out.find((v) => v.platformId === "7")?.url === "https://www.instagram.com/reel/B7/",
  );
  check(
    "null transcript when absent",
    out.find((v) => v.platformId === "3")?.transcript === null,
  );
  check(
    "marks a returned transcript field as checked",
    out.find((v) => v.platformId === "3000000000000000001")?.transcriptChecked === true,
  );
  check(
    "keeps absent transcript fields unchecked",
    out.find((v) => v.platformId === "3")?.transcriptChecked === false,
  );
  check(
    "prefers playCount over viewCount",
    out[0].plays === 180000,
    `got ${out[0].plays}`,
  );
  check("normalizes timestamp to ISO", !Number.isNaN(Date.parse(out[0].postedAt)));
}

section("2. Transcript from segmented array shape");
{
  const out = normalizeInstagram([
    reel({
      id: "seg1",
      shortCode: "SEG1",
      transcript: [{ text: "first part here" }, { text: "second part here" }],
    }),
  ]);
  check(
    "joins segment arrays into one string",
    out[0].transcript === "first part here second part here",
    String(out[0].transcript),
  );
}

section("3. Cost-bounded Instagram discovery input");
{
  const input = buildInstagramInput(
    ["pacemorby"],
    {
      reelsPerProfile: 8,
      onlyPostsNewerThan: "45 days",
      skipPinnedPosts: true,
    },
  ) as Record<string, unknown>;

  check("discovery explicitly disables paid transcripts", input.includeTranscript === false);
  check("discovery keeps the per-profile cap", input.resultsLimit === 8);

  const transcriptInput = buildInstagramTranscriptInput([
    "https://www.instagram.com/reel/ABC123/",
    "https://www.instagram.com/reel/DEF456/",
  ]) as Record<string, unknown>;

  check("selected-reel input enables paid transcripts", transcriptInput.includeTranscript === true);
  check(
    "selected-reel input includes only the requested URLs",
    Array.isArray(transcriptInput.username) && transcriptInput.username.length === 2,
  );
  check("selected-reel input does not download videos", transcriptInput.includeDownloadedVideo === false);
}

section("4. Deduplication and idempotency");
{
  const store = new Store(`${TMP}/dedup.db`);
  const v = normalizeInstagram([reel()])[0];

  store.upsertVideo(v, new Date().toISOString());
  const second = store.upsertVideo(v, new Date().toISOString());
  const third = store.upsertVideo(v, new Date().toISOString());

  check("second sighting is not an insert", second.inserted === false);
  check("third sighting is not an insert", third.inserted === false);
  check(
    "observation count increments",
    store.getVideo("instagram", v.platformId)!.observation_count === 3,
  );

  store.setState("instagram", v.platformId, "processed", {
    processedAt: new Date().toISOString(),
  });
  store.upsertVideo(v, new Date().toISOString());
  check(
    "processed videos stay processed when reseen",
    store.getVideo("instagram", v.platformId)!.state === "processed",
  );
  check(
    "processed videos leave the open set",
    store.openVideos().length === 0,
  );
  store.close();
}

section("5. Selective transcript results");
{
  const store = new Store(`${TMP}/transcripts.db`);
  const baseItems = [
    reel({ id: "ready", shortCode: "READY" }),
    reel({ id: "fetched", shortCode: "FETCHED", transcript: undefined }),
    reel({ id: "silent", shortCode: "SILENT", transcript: undefined }),
    reel({ id: "missing", shortCode: "MISSING", transcript: undefined }),
  ];
  const normalized = normalizeInstagram(baseItems);
  const now = new Date();

  for (const video of normalized) {
    store.upsertVideo(video, now.toISOString());
    store.recordSnapshot({
      platform: video.platform,
      platform_id: video.platformId,
      run_id: "transcript-run",
      captured_at: now.toISOString(),
      plays: video.plays,
      likes: video.likes,
      comments: video.comments,
    });
    store.setState(video.platform, video.platformId, "qualified");
  }

  const candidates = store.openVideos().map((video) => ({
    video,
    plays: 180000,
    likes: 4200,
    comments: 210,
    velocityPlaysPerDay: 30000,
    engagementRate: 0.0245,
    score: 37350,
  }));

  const fetched = normalizeInstagram([
    reel({ id: "fetched", shortCode: "FETCHED" }),
    reel({ id: "silent", shortCode: "SILENT", transcript: "" }),
  ]);

  const result = applyTranscriptResults(candidates, fetched, store, 40);

  check("keeps candidates that already have a usable transcript", result.ready.some((c) => c.video.platform_id === "ready"));
  check("adds a newly fetched usable transcript", result.ready.some((c) => c.video.platform_id === "fetched"));
  check("rejects a checked music-only result", result.rejected.includes("silent"));
  check("preserves missing actor results for a later retry", result.missing.includes("missing"));
  check("stores fetched transcripts for future runs", wordCount(store.getVideo("instagram", "fetched")!.transcript) >= 40);
  check("records that the fetched transcript was checked", store.getVideo("instagram", "fetched")!.transcript_checked === 1);
  store.close();
}

section("6. Transcript fetching is limited to unchecked candidates");
{
  const store = new Store(`${TMP}/transcript-fetch.db`);
  const unchecked = normalizeInstagram([
    reel({
      id: "unchecked",
      shortCode: "UNCHECKED",
      url: "https://www.instagram.com/reel/UNCHECKED/",
      transcript: undefined,
    }),
  ])[0];
  const checked = normalizeInstagram([
    reel({
      id: "checked",
      shortCode: "CHECKED",
      url: "https://www.instagram.com/reel/CHECKED/",
    }),
  ])[0];
  const now = new Date();

  for (const video of [unchecked, checked]) {
    store.upsertVideo(video, now.toISOString());
    store.recordSnapshot({
      platform: video.platform,
      platform_id: video.platformId,
      run_id: "prepare-run",
      captured_at: now.toISOString(),
      plays: video.plays,
      likes: video.likes,
      comments: video.comments,
    });
    store.setState(video.platform, video.platformId, "qualified");
  }

  const candidates = store.openVideos().map((video) => ({
    video,
    plays: 180000,
    likes: 4200,
    comments: 210,
    velocityPlaysPerDay: 30000,
    engagementRate: 0.0245,
    score: 37350,
  }));
  let requestedUrls: string[] = [];
  const fetcher = async (urls: string[]) => {
    requestedUrls = urls;
    return normalizeInstagram(
      [reel({ id: "unchecked", shortCode: "UNCHECKED" })],
      { transcriptRequested: true },
    );
  };

  const prepared = await prepareCandidatesForGeneration(candidates, store, 40, fetcher);

  check("requests only unchecked Reel URLs", requestedUrls.length === 1 && requestedUrls[0].includes("UNCHECKED"));
  check("returns both the existing and fetched transcripts", prepared.ready.length === 2);
  store.close();
}

section("7. Engagement velocity across runs");
{
  const store = new Store(`${TMP}/velocity.db`);
  const v = normalizeInstagram([reel({ id: "vel1", shortCode: "VEL1" })])[0];
  store.upsertVideo(v, daysAgo(4));

  store.recordSnapshot({
    platform: "instagram",
    platform_id: "vel1",
    run_id: "run-a",
    captured_at: daysAgo(4),
    plays: 100000,
    likes: 2000,
    comments: 100,
  });
  store.recordSnapshot({
    platform: "instagram",
    platform_id: "vel1",
    run_id: "run-b",
    captured_at: daysAgo(2),
    plays: 160000,
    likes: 3400,
    comments: 180,
  });

  const first = store.earliestSnapshot("instagram", "vel1");
  const last = store.latestSnapshot("instagram", "vel1");
  const vel = velocity(first, last, v.postedAt, new Date());

  check(
    "velocity uses the delta between runs, not raw total",
    Math.abs(vel - 30000) < 500,
    `got ${vel.toFixed(0)}/day`,
  );

  const single = new Store(`${TMP}/velocity2.db`);
  single.upsertVideo(v, daysAgo(4));
  single.recordSnapshot({
    platform: "instagram",
    platform_id: "vel1",
    run_id: "only",
    captured_at: new Date().toISOString(),
    plays: 180000,
    likes: 4200,
    comments: 210,
  });
  const fallback = velocity(
    single.earliestSnapshot("instagram", "vel1"),
    single.latestSnapshot("instagram", "vel1"),
    v.postedAt,
    new Date(),
  );
  check(
    "falls back to plays-per-day-since-posted on first sighting",
    Math.abs(fallback - 30000) < 1500,
    `got ${fallback.toFixed(0)}/day`,
  );
  store.close();
  single.close();
}

section("8. Qualification rules");
{
  const cfg = loadConfig("config.yml");
  const now = new Date();
  const store = new Store(`${TMP}/qualify.db`);

  const cases = [
    { id: "q-good", over: {}, expect: "qualified" },
    { id: "q-short", over: { videoDuration: 6 }, expect: "rejected" },
    { id: "q-notranscript", over: { transcript: "hi there" }, expect: "qualified" },
    { id: "q-lowplays", over: { videoPlayCount: 900, videoViewCount: 900, likesCount: 20 }, expect: "observing" },
    { id: "q-old", over: { timestamp: daysAgo(120) }, expect: "expired" },
  ];

  for (const c of cases) {
    const v = normalizeInstagram([reel({ id: c.id, shortCode: c.id, ...c.over })])[0];
    store.upsertVideo(v, now.toISOString());
    store.recordSnapshot({
      platform: "instagram",
      platform_id: c.id,
      run_id: "r1",
      captured_at: now.toISOString(),
      plays: v.plays,
      likes: v.likes,
      comments: v.comments,
    });
  }

  for (const c of cases) {
    const row = store.getVideo("instagram", c.id)!;
    const ev = evaluate(store, row, cfg, now);
    check(`${c.id} -> ${c.expect}`, ev.nextState === c.expect, `got ${ev.nextState}`);
  }

  const oldLowTraction = normalizeInstagram([
    reel({ id: "q-stale", shortCode: "q-stale", videoPlayCount: 500, videoViewCount: 500, likesCount: 10, timestamp: daysAgo(10) }),
  ])[0];
  store.upsertVideo(oldLowTraction, now.toISOString());
  store.upsertVideo(oldLowTraction, now.toISOString());
  store.upsertVideo(oldLowTraction, now.toISOString());
  store.recordSnapshot({
    platform: "instagram",
    platform_id: "q-stale",
    run_id: "r1",
    captured_at: now.toISOString(),
    plays: 500,
    likes: 10,
    comments: 2,
  });
  const stale = evaluate(store, store.getVideo("instagram", "q-stale")!, cfg, now);
  check(
    "expires after the observation window without traction",
    stale.nextState === "expired",
    `got ${stale.nextState}`,
  );
  store.close();
}

section("9. Selection caps per creator");
{
  const cfg = loadConfig("config.yml");
  const make = (creator: string, score: number): Candidate => ({
    video: {
      platform: "instagram",
      platform_id: `${creator}-${score}`,
      url: "u",
      creator,
      caption: "",
      transcript: LONG_TRANSCRIPT,
      transcript_checked: 1,
      duration_seconds: 40,
      posted_at: daysAgo(3),
      state: "qualified",
      first_seen_at: "",
      last_seen_at: "",
      observation_count: 1,
      reject_reason: null,
      processed_at: null,
      score,
    },
    plays: 1,
    likes: 1,
    comments: 1,
    velocityPlaysPerDay: score,
    engagementRate: 0.05,
    score,
  });

  const many = [
    make("pacemorby", 100),
    make("pacemorby", 99),
    make("pacemorby", 98),
    make("pacemorby", 97),
    make("flipwithzach", 96),
    make("tyson_smith", 95),
  ];

  const picked = selectTop(many, {
    ...cfg,
    generation: { ...cfg.generation, scriptsPerRun: 4, maxPerCreatorPerRun: 2 },
  });

  const paceCount = picked.filter((p) => p.video.creator === "pacemorby").length;
  check("respects maxPerCreatorPerRun when supply allows", paceCount === 2, `got ${paceCount}`);
  check("still fills the quota", picked.length === 4, `got ${picked.length}`);
  check("highest score first", picked[0].score === 100);

  const scarce = selectTop(
    [make("pacemorby", 100), make("pacemorby", 99), make("pacemorby", 98)],
    { ...cfg, generation: { ...cfg.generation, scriptsPerRun: 3, maxPerCreatorPerRun: 2 } },
  );
  check(
    "ships a smaller batch instead of breaking the creator cap",
    scarce.length === 2,
    `got ${scarce.length}`,
  );
}

section("10. Saved discovery refresh");
{
  const cfg = loadConfig("config.yml");
  const now = new Date();
  const store = new Store(`${TMP}/refresh.db`);
  const watched = normalizeInstagram([
    reel({ id: "refresh-watched", shortCode: "refresh-watched" }),
  ])[0];
  const removed = normalizeInstagram([
    reel({
      id: "refresh-removed",
      shortCode: "refresh-removed",
      ownerUsername: "removedcreator",
    }),
  ])[0];

  for (const video of [watched, removed]) {
    store.upsertVideo(video, now.toISOString());
    store.recordSnapshot({
      platform: video.platform,
      platform_id: video.platformId,
      run_id: "refresh",
      captured_at: now.toISOString(),
      plays: video.plays,
      likes: video.likes,
      comments: video.comments,
    });
  }

  const refreshed = refreshCandidates(store, cfg, now);
  check("re-evaluates watched videos from saved discovery", refreshed.length === 1);
  check(
    "keeps removed creators out of future reports",
    refreshed[0]?.video.creator === "pacemorby",
  );
  store.close();
}

section("11. Generation retry and failure isolation");
{
  const cfg = loadConfig("config.yml");
  const candidate: Candidate = {
    video: {
      platform: "instagram",
      platform_id: "gen1",
      url: "https://www.instagram.com/reel/GEN1/",
      creator: "pacemorby",
      caption: "cap",
      transcript: LONG_TRANSCRIPT,
      transcript_checked: 1,
      duration_seconds: 40,
      posted_at: daysAgo(3),
      state: "qualified",
      first_seen_at: "",
      last_seen_at: "",
      observation_count: 1,
      reject_reason: null,
      processed_at: null,
      score: 10,
    },
    plays: 180000,
    likes: 4200,
    comments: 210,
    velocityPlaysPerDay: 30000,
    engagementRate: 0.024,
    score: 37200,
  };

  let calls = 0;
  const flaky = async () => {
    calls++;
    if (calls === 1) throw new Error("transient 500");
    return {
      topic: "t",
      hook: "h",
      body: "b",
      cta: "c",
      captionHook: "Tag a friend.",
      captionBody: "A clean deal recap.",
    };
  };

  const ok = await generateScripts([candidate], cfg, {
    apiKey: "x",
    model: "m",
    voiceGuidePath: "voice/seth-voice-guide.md",
  }, flaky);
  check("retries once on transient failure", ok.scripts.length === 1 && calls === 2);
  check(
    "keeps the generated two-part caption",
    (ok.scripts[0] as unknown as { captionHook?: string }).captionHook === "Tag a friend." &&
      (ok.scripts[0] as unknown as { captionBody?: string }).captionBody === "A clean deal recap.",
  );

  const alwaysBad = async () => {
    throw new Error("hard failure");
  };
  const bad = await generateScripts([candidate, candidate], cfg, {
    apiKey: "x",
    model: "m",
    voiceGuidePath: "voice/seth-voice-guide.md",
  }, alwaysBad);
  check("records failures without throwing", bad.scripts.length === 0 && bad.failures.length === 2);

  const malformed = async () => ({ topic: "t", cta: "c" });
  const mal = await generateScripts([candidate], cfg, {
    apiKey: "x",
    model: "m",
    voiceGuidePath: "voice/seth-voice-guide.md",
  }, malformed as never);
  check("rejects responses missing hook or body", mal.scripts.length === 0);

  const missingCaption = async () => ({
    topic: "t",
    hook: "h",
    body: "b",
    cta: "c",
  });
  const withoutCaption = await generateScripts([candidate], cfg, {
    apiKey: "x",
    model: "m",
    voiceGuidePath: "voice/seth-voice-guide.md",
  }, missingCaption);
  check(
    "rejects responses missing the two-part caption",
    withoutCaption.scripts.length === 0,
  );

  const request = buildOpenAIRequest("gpt-4o", "source prompt") as {
    response_format?: {
      type?: string;
      json_schema?: {
        strict?: boolean;
        schema?: { required?: string[]; additionalProperties?: boolean };
      };
    };
  };
  const required = request.response_format?.json_schema?.schema?.required ?? [];
  check(
    "uses a strict structured output schema",
    request.response_format?.type === "json_schema" &&
      request.response_format.json_schema?.strict === true &&
      request.response_format.json_schema.schema?.additionalProperties === false,
  );
  check(
    "requires the script and two-part caption fields",
    ["topic", "hook", "body", "cta", "captionHook", "captionBody"].every(
      (field) => required.includes(field),
    ),
  );
}

section("12. Email rendering");
{
  const cfg = loadConfig("config.yml");
  const scripts = [
    {
      platformId: "1",
      platform: "instagram" as const,
      sourceUrl: "https://www.instagram.com/reel/A/",
      sourceCreator: "pacemorby",
      topic: "Roof math",
      hook: "Everybody called it a teardown.",
      body: "Line one.\nLine two with <script>alert(1)</script> injected.",
      cta: "Comment DEAL.",
      captionHook: "Tag a friend who needs to see this. 🤝",
      captionBody: "A plain-English recap of the deal.",
      transcript: LONG_TRANSCRIPT,
      plays: 180000,
      likes: 4200,
      comments: 210,
      velocityPlaysPerDay: 30000,
      engagementRate: 0.0245,
    },
  ];
  const html = renderEmail(scripts, cfg, new Date("2026-07-27T12:00:00Z"));
  const text = renderText(scripts);

  check("escapes html in script bodies", !html.includes("<script>alert"));
  check("includes the escaped payload", html.includes("&lt;script&gt;"));
  check("renders the source link", html.includes("https://www.instagram.com/reel/A/"));
  check("renders source engagement evidence", html.includes("180,000 plays"));
  check("renders a source transcript excerpt", html.includes("Source transcript"));
  check("renders the two-part caption", html.includes("Tag a friend who needs to see this."));
  check("formats the date in the configured timezone", html.includes("July 27, 2026"));
  check("plain text alternative is non-empty", text.includes("Roof math"));
}

section("13. Script audit storage");
{
  const store = new Store(`${TMP}/script-audit.db`);
  store.startRun("audit-run", new Date().toISOString());
  store.saveScript(
    "audit-run",
    "instagram",
    "audit-video",
    new Date().toISOString(),
    "Roof math",
    "Everybody called it a teardown.",
    "It was cleanup, not structural damage.",
    "Comment DEAL.",
    "Tag the friend who needs this.",
    "The difference changes the deal.",
  );
  const saved = store.scriptsForRun("audit-run")[0];
  check("stores the caption hook with the generated script", saved.caption_hook === "Tag the friend who needs this.");
  check("stores the caption body with the generated script", saved.caption_body === "The difference changes the deal.");
  store.close();
}

section("14. End to end via the CLI in fixture + dry-run mode");
{
  rmSync(`${TMP}/e2e.db`, { force: true });
  rmSync("out", { recursive: true, force: true });
  mkdirSync("out", { recursive: true });

  const creators = [
    "section8karim",
    "camm.olivera_",
    "pacemorby",
    "enterpriseselite",
    "richardgrandintaylor",
    "tyson_smith",
    "flipwithzach",
  ];

  const runOne = creators.flatMap((c, i) =>
    [0, 1, 2].map((j) => {
      const id = `${1000 + i * 10 + j}`;
      const viral = j === 0;
      return reel({
        id,
        shortCode: `S${id}`,
        ownerUsername: c,
        timestamp: daysAgo(3 + j),
        videoPlayCount: viral ? 220000 + i * 1000 : 1200,
        videoViewCount: viral ? 120000 : 800,
        likesCount: viral ? 5000 + i * 50 : 20,
        commentsCount: viral ? 300 : 5,
        transcript: j === 2 ? "too short" : LONG_TRANSCRIPT,
      });
    }),
  );

  writeFileSync(`${TMP}/run1.json`, JSON.stringify(runOne));

  const env = {
    ...process.env,
    DB_PATH: `${TMP}/e2e.db`,
    FIXTURE_FILE: `${TMP}/run1.json`,
    DRY_RUN: "1",
    MOCK_OPENAI: "1",
    GITHUB_RUN_ID: "fixture-run-1",
  };
  const node = process.execPath;
  const args = ["--experimental-sqlite", "--no-warnings", "--import", "tsx", "src/cli.ts"];

  const d1 = execFileSync(node, [...args, "discover"], { env, encoding: "utf8" });
  check("discover reports new videos", /21 seen, 21 new/.test(d1), d1.trim());
  check("discover qualifies the viral subset", /7 qualified/.test(d1), d1.trim());

  const savedFixture = `${TMP}/run1-saved.json`;
  writeFileSync(savedFixture, readFileSync(`${TMP}/run1.json`));
  rmSync(`${TMP}/run1.json`);
  const repeatedDiscovery = execFileSync(node, [...args, "discover"], {
    env,
    encoding: "utf8",
  });
  check(
    "restarting the same run does not scrape again",
    /discovery already saved/.test(repeatedDiscovery),
    repeatedDiscovery.trim(),
  );
  writeFileSync(`${TMP}/run1.json`, readFileSync(savedFixture));

  const p1 = execFileSync(node, [...args, "publish"], { env, encoding: "utf8" });
  check("publish selects and writes a preview", existsSync("out/preview.html"), p1.trim());
  const preview = readFileSync("out/preview.html", "utf8");
  check("preview contains 7 scripts", (preview.match(/Script \d+ &middot;/g) ?? []).length === 7);

  const repeatedPublish = execFileSync(node, [...args, "publish"], {
    env,
    encoding: "utf8",
  });
  check(
    "restarting a completed preview does not generate it again",
    /publish already completed/.test(repeatedPublish),
    repeatedPublish.trim(),
  );

  const previewStatus = execFileSync(node, [...args, "status"], { env, encoding: "utf8" });
  check("dry run keeps videos qualified for live delivery", /qualified\s+7/.test(previewStatus));
  check("dry run does not mark videos processed", !/processed\s+7/.test(previewStatus));

  const d2 = execFileSync(node, [...args, "discover"], {
    env: { ...env, GITHUB_RUN_ID: "fixture-run-2" },
    encoding: "utf8",
  });
  check("re-running discover finds no new videos", /21 seen, 0 new/.test(d2), d2.trim());
  check("previewed videos remain qualified", /7 qualified/.test(d2), d2.trim());

  const runTwo = [
    ...runOne,
    reel({
      id: "9999",
      shortCode: "NEW1",
      ownerUsername: "flipwithzach",
      timestamp: daysAgo(1),
      videoPlayCount: 300000,
      likesCount: 9000,
      commentsCount: 700,
    }),
  ];
  writeFileSync(`${TMP}/run2.json`, JSON.stringify(runTwo));
  const d3 = execFileSync(node, [...args, "discover"], {
    env: {
      ...env,
      FIXTURE_FILE: `${TMP}/run2.json`,
      GITHUB_RUN_ID: "fixture-run-3",
    },
    encoding: "utf8",
  });
  check("a genuinely new video is picked up", /22 seen, 1 new/.test(d3), d3.trim());
  check("the new video joins the pending qualified set", /8 qualified/.test(d3), d3.trim());

  const status = execFileSync(node, [...args, "status"], { env, encoding: "utf8" });
  check("status reports all pending qualified videos", /qualified\s+8/.test(status), status.trim());
}

section("15. End to end selective transcription");
{
  rmSync(`${TMP}/selective.db`, { force: true });
  rmSync("out", { recursive: true, force: true });
  mkdirSync("out", { recursive: true });

  const metadata = [
    reel({
      id: "meta-good",
      shortCode: "META-GOOD",
      url: "https://www.instagram.com/reel/META-GOOD/",
      transcript: undefined,
    }),
    reel({
      id: "meta-silent",
      shortCode: "META-SILENT",
      url: "https://www.instagram.com/reel/META-SILENT/",
      transcript: undefined,
    }),
  ];
  const transcriptResults = [
    reel({
      id: "meta-good",
      shortCode: "META-GOOD",
      url: "https://www.instagram.com/reel/META-GOOD/",
    }),
    reel({
      id: "meta-silent",
      shortCode: "META-SILENT",
      url: "https://www.instagram.com/reel/META-SILENT/",
      transcript: "",
    }),
  ];

  writeFileSync(`${TMP}/metadata.json`, JSON.stringify(metadata));
  writeFileSync(`${TMP}/transcripts.json`, JSON.stringify(transcriptResults));

  const env = {
    ...process.env,
    DB_PATH: `${TMP}/selective.db`,
    FIXTURE_FILE: `${TMP}/metadata.json`,
    TRANSCRIPT_FIXTURE_FILE: `${TMP}/transcripts.json`,
    DRY_RUN: "1",
    MOCK_OPENAI: "1",
    GITHUB_RUN_ID: "selective-run",
  };
  const node = process.execPath;
  const args = ["--experimental-sqlite", "--no-warnings", "--import", "tsx", "src/cli.ts"];

  const discovery = execFileSync(node, [...args, "discover"], { env, encoding: "utf8" });
  check("metadata-only discovery qualifies both viral Reels", /2 qualified/.test(discovery), discovery.trim());

  rmSync(".run-id", { force: true });
  const publishEnv = { ...env, GITHUB_RUN_ID: "selective-resume-run" };
  const publish = execFileSync(node, [...args, "publish"], {
    env: publishEnv,
    encoding: "utf8",
  });
  const preview = readFileSync("out/preview.html", "utf8");
  check("only the spoken Reel becomes a script", /1 scripts/.test(publish) && /Script 1 &middot;/.test(preview), publish.trim());
  check("the fetched transcript is included in the report", preview.includes("So I get a call about a property"));

  const status = execFileSync(node, [...args, "status"], {
    env: publishEnv,
    encoding: "utf8",
  });
  check("music-only Reels are rejected", /rejected\s+1/.test(status), status.trim());
  check("the previewed spoken Reel remains qualified", /qualified\s+1/.test(status), status.trim());
  const selectiveStore = new Store(`${TMP}/selective.db`);
  check(
    "publish-only recovery records the new workflow run",
    selectiveStore.getRun("selective-resume-run")?.status === "preview",
  );
  selectiveStore.close();
}

section("16. Config validation");
{
  writeFileSync(`${TMP}/bad.yml`, "sources:\n  instagram: []\n  tiktok: []\n");
  let threw = false;
  try {
    loadConfig(`${TMP}/bad.yml`);
  } catch (e) {
    threw = /no profiles configured/.test(String(e));
  }
  check("rejects a config with no profiles", threw);

  const cfg = loadConfig("config.yml");
  check("production discovery is capped at 8 reels per profile", cfg.discovery.reelsPerProfile === 8);

  const workflow = readFileSync(".github/workflows/content-engine.yml", "utf8");
  const publishBlock = workflow.match(
    /- name: Generate and deliver scripts[\s\S]*?run: \|[\s\S]*?npm run publish/,
  )?.[0] ?? "";
  check(
    "the delivery step has Apify access for selected transcripts",
    publishBlock.includes("APIFY_TOKEN:"),
  );
  check(
    "state commits run only after successful pipeline steps",
    !workflow.includes("if: always() && steps.guard.outputs.proceed == 'true'"),
  );
  check(
    "state synchronization does not hide pull failures",
    !workflow.includes("git pull --rebase --autostash || true"),
  );
  check(
    "a manual recovery can reuse saved discovery",
    workflow.includes("reuse_saved_discovery:") &&
      workflow.includes("inputs.reuse_saved_discovery != true"),
  );

  const voiceGuide = readFileSync("voice/seth-voice-guide.md", "utf8");
  check(
    "the actual Seth voice guide is installed",
    voiceGuide.includes("Reverse-engineered from 14 Instagram reels") &&
      voiceGuide.includes("Sounds Like Seth") &&
      !voiceGuide.toLowerCase().includes("working placeholder"),
  );
}

section("17. Apify authentication, retry, and spend guard");
{
  const { assertSpendUnderLimit, runActorSync, SpendGuardError } = await import("../src/apify.js");
  const realFetch = globalThis.fetch;

  const seenRequests: Array<{ url: string; init: RequestInit }> = [];
  let actorAttempts = 0;
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    seenRequests.push({ url, init });
    actorAttempts++;
    if (actorAttempts === 1) {
      return {
        ok: false,
        status: 503,
        text: async () => "temporarily unavailable",
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => [{ id: "ok" }],
      text: async () => "",
    };
  }) as never;

  const actorItems = await runActorSync(
    "secret-token",
    "apify/instagram-reel-scraper",
    { username: ["pacemorby"] },
    8,
  );
  const authorization = new Headers(seenRequests[0]?.init.headers).get("Authorization");
  check(
    "keeps the Apify token out of request URLs",
    seenRequests.every((request) => !request.url.includes("secret-token")),
  );
  check("sends the Apify token in the authorization header", authorization === "Bearer secret-token");
  check("retries one temporary actor failure", actorAttempts === 2 && actorItems.length === 1);

  let uncappedUrl = "";
  globalThis.fetch = (async (url: string) => {
    uncappedUrl = url;
    return {
      ok: true,
      status: 200,
      json: async () => [],
      text: async () => "",
    };
  }) as never;
  await runActorSync(
    "secret-token",
    "apify/instagram-reel-scraper",
    { directUrls: ["https://www.instagram.com/reel/example/"] },
    undefined as never,
  );
  check(
    "small selected batches omit the invalid Apify dataset cap",
    !uncappedUrl.includes("maxItems="),
    uncappedUrl,
  );

  const stub = (payload: unknown, ok = true) => {
    globalThis.fetch = (async () =>
      ({ ok, json: async () => payload, text: async () => "" })) as never;
  };

  stub({ data: { current: { monthlyUsageUsd: 12.5 } } });
  let threw = false;
  try {
    await assertSpendUnderLimit("t", 45);
  } catch {
    threw = true;
  }
  check("allows a run when spend is under the limit", !threw);

  stub({ data: { current: { monthlyUsageUsd: 47.2 } } });
  let blocked = false;
  try {
    await assertSpendUnderLimit("t", 45);
  } catch (e) {
    blocked = e instanceof SpendGuardError;
  }
  check("blocks a run before any actor call when over the limit", blocked);

  stub({ data: { monthlyUsageUsd: 46 } });
  let blockedAlt = false;
  try {
    await assertSpendUnderLimit("t", 45);
  } catch (e) {
    blockedAlt = e instanceof SpendGuardError;
  }
  check("reads the alternate usage field shape", blockedAlt);

  stub({ nonsense: true });
  let softFailed = false;
  try {
    await assertSpendUnderLimit("t", 45);
  } catch {
    softFailed = true;
  }
  check("continues with a warning when usage is unreadable", !softFailed);

  globalThis.fetch = (async () => {
    throw new Error("network down");
  }) as never;
  let networkFailed = false;
  try {
    await assertSpendUnderLimit("t", 45);
  } catch {
    networkFailed = true;
  }
  check("does not crash when the usage endpoint is unreachable", !networkFailed);

  globalThis.fetch = realFetch;
}

section("18. DST-safe schedule guard");
{
  const hourIn = (iso: string) =>
    Number(
      new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        hour: "numeric",
        hour12: false,
      }).format(new Date(iso)),
    );

  const dates = ["2026-07-27", "2026-12-07", "2026-11-02", "2026-03-15", "2027-01-04"];
  const allSingle = dates.every(
    (d) => ["11", "12"].filter((h) => hourIn(`${d}T${h}:00:00Z`) === 7).length === 1,
  );
  check("exactly one cron trigger lands on 7am local, year round", allSingle);
  check("summer 11:00 UTC is 7am in New York", hourIn("2026-07-27T11:00:00Z") === 7);
  check("winter 12:00 UTC is 7am in New York", hourIn("2026-12-07T12:00:00Z") === 7);
}

section("19. Pruning keeps dedup keys forever");
{
  const store = new Store(`${TMP}/prune.db`);
  const v = normalizeInstagram([reel({ id: "pr1", shortCode: "PR1" })])[0];
  store.upsertVideo(v, daysAgo(200));
  store.recordSnapshot({
    platform: "instagram",
    platform_id: "pr1",
    run_id: "old",
    captured_at: daysAgo(200),
    plays: 1,
    likes: 1,
    comments: 1,
  });
  store.setState("instagram", "pr1", "processed", { processedAt: daysAgo(200) });

  const result = store.prune(90, new Date());
  check("clears transcript text from closed videos", result.videosTrimmed === 1);
  check("deletes stale snapshots", result.snapshotsDeleted === 1);

  const after = store.getVideo("instagram", "pr1")!;
  check("keeps the row so the video is never re-scripted", after.state === "processed");
  check("transcript text is gone", after.transcript === null);

  store.upsertVideo(v, new Date().toISOString());
  check(
    "a pruned processed video reseen later stays processed",
    store.getVideo("instagram", "pr1")!.state === "processed",
  );
  check("pruned videos never re-enter the open set", store.openVideos().length === 0);
  store.close();
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
