import type { Candidate, RawVideo } from "./types.js";
import type { Store } from "./db.js";
import { wordCount } from "./rank.js";

export interface TranscriptPreparation {
  ready: Candidate[];
  rejected: string[];
  missing: string[];
}

export type TranscriptFetcher = (urls: string[]) => Promise<RawVideo[]>;

function videoKey(platform: string, platformId: string): string {
  return `${platform}:${platformId}`;
}

export function applyTranscriptResults(
  candidates: Candidate[],
  fetched: RawVideo[],
  store: Store,
  minWords: number,
): TranscriptPreparation {
  const fetchedByKey = new Map(
    fetched.map((video) => [videoKey(video.platform, video.platformId), video]),
  );
  const ready: Candidate[] = [];
  const rejected: string[] = [];
  const missing: string[] = [];

  for (const candidate of candidates) {
    let video = candidate.video;

    if (video.transcript_checked !== 1) {
      const result = fetchedByKey.get(videoKey(video.platform, video.platform_id));
      if (!result) {
        missing.push(video.platform_id);
        continue;
      }
      store.setTranscriptResult(video.platform, video.platform_id, result.transcript);
      video = store.getVideo(video.platform, video.platform_id)!;
    }

    if (wordCount(video.transcript) < minWords) {
      store.setState(video.platform, video.platform_id, "rejected", {
        rejectReason: "no usable spoken transcript",
      });
      rejected.push(video.platform_id);
      continue;
    }

    ready.push({ ...candidate, video });
  }

  return { ready, rejected, missing };
}

export async function prepareCandidatesForGeneration(
  candidates: Candidate[],
  store: Store,
  minWords: number,
  fetcher: TranscriptFetcher,
): Promise<TranscriptPreparation> {
  const unchecked = candidates.filter(
    (candidate) => candidate.video.transcript_checked !== 1,
  );
  const fetched =
    unchecked.length > 0
      ? await fetcher(unchecked.map((candidate) => candidate.video.url))
      : [];
  return applyTranscriptResults(candidates, fetched, store, minWords);
}
