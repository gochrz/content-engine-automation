import type { RawVideo } from "../types.js";

export const INSTAGRAM_ACTOR = "apify/instagram-reel-scraper";

export function buildInstagramInput(
  usernames: string[],
  opts: { reelsPerProfile: number; onlyPostsNewerThan: string; skipPinnedPosts: boolean },
) {
  return {
    username: usernames,
    resultsLimit: opts.reelsPerProfile,
    onlyPostsNewerThan: opts.onlyPostsNewerThan,
    skipPinnedPosts: opts.skipPinnedPosts,
    includeTranscript: false,
  };
}

export function buildInstagramTranscriptInput(urls: string[]) {
  return {
    username: urls,
    resultsLimit: 1,
    includeTranscript: true,
    includeDownloadedVideo: false,
  };
}

function pickNumber(...values: unknown[]): number {
  for (const v of values) {
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
  }
  return 0;
}

function pickString(...values: unknown[]): string {
  for (const v of values) {
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  return "";
}

function extractTranscript(item: Record<string, any>): string | null {
  const direct = pickString(
    item.transcript,
    item.videoTranscript,
    item.transcription,
    item.captions,
  );
  if (direct) return direct;

  const nested = item.transcript ?? item.transcripts;
  if (Array.isArray(nested)) {
    const joined = nested
      .map((seg: any) => (typeof seg === "string" ? seg : pickString(seg?.text)))
      .filter(Boolean)
      .join(" ")
      .trim();
    if (joined) return joined;
  }
  return null;
}

export function normalizeInstagram(
  items: unknown[],
  opts: { transcriptRequested?: boolean } = {},
): RawVideo[] {
  const out: RawVideo[] = [];

  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, any>;

    if (item.error) continue;

    const platformId = pickString(item.id, item.shortCode);
    if (!platformId) continue;

    const productType = pickString(item.productType, item.type);
    if (productType && !["clips", "Video", "video"].includes(productType)) continue;

    const shortCode = pickString(item.shortCode);
    const url = pickString(item.url, item.inputUrl) ||
      (shortCode ? `https://www.instagram.com/reel/${shortCode}/` : "");
    if (!url) continue;

    const postedAt = pickString(item.timestamp, item.takenAt);
    if (!postedAt || Number.isNaN(Date.parse(postedAt))) continue;

    const transcriptChecked =
      opts.transcriptRequested === true ||
      [item.transcript, item.videoTranscript, item.transcription, item.captions].some(
        (value) => typeof value === "string" || Array.isArray(value),
      );

    out.push({
      platform: "instagram",
      platformId,
      url,
      creator: pickString(item.ownerUsername, item.username, "unknown"),
      caption: pickString(item.caption),
      transcript: extractTranscript(item),
      transcriptChecked,
      plays: pickNumber(item.videoPlayCount, item.videoViewCount, item.playCount),
      likes: pickNumber(item.likesCount, item.likeCount),
      comments: pickNumber(item.commentsCount, item.commentCount),
      durationSeconds: pickNumber(item.videoDuration, item.duration),
      postedAt: new Date(postedAt).toISOString(),
      isPinned: item.isPinned === true,
    });
  }

  return out;
}
