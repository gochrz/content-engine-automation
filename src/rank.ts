import type { Candidate, Config, Snapshot, VideoRow } from "./types.js";
import type { Store } from "./db.js";

const DAY_MS = 86400000;

export function wordCount(text: string | null): number {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export function ageInDays(postedAt: string, now: Date): number {
  return Math.max((now.getTime() - Date.parse(postedAt)) / DAY_MS, 0.25);
}

export function velocity(
  first: Snapshot | undefined,
  last: Snapshot | undefined,
  postedAt: string,
  now: Date,
): number {
  if (!last) return 0;
  if (first && first.run_id !== last.run_id) {
    const spanDays =
      (Date.parse(last.captured_at) - Date.parse(first.captured_at)) / DAY_MS;
    if (spanDays >= 0.5) {
      const delta = last.plays - first.plays;
      return Math.max(delta / spanDays, 0);
    }
  }
  return last.plays / ageInDays(postedAt, now);
}

export function scoreOf(velocityPerDay: number, engagementRate: number): number {
  return velocityPerDay * (1 + engagementRate * 10);
}

export interface Evaluation {
  video: VideoRow;
  candidate: Candidate | null;
  nextState: "observing" | "qualified" | "rejected" | "expired";
  reason: string | null;
}

export function evaluate(store: Store, video: VideoRow, cfg: Config, now: Date): Evaluation {
  const q = cfg.qualification;
  const age = ageInDays(video.posted_at, now);

  if (video.duration_seconds > 0 && video.duration_seconds < q.minDurationSeconds) {
    return { video, candidate: null, nextState: "rejected", reason: "too short" };
  }

  if (age > q.maxAgeDaysToQualify) {
    return { video, candidate: null, nextState: "expired", reason: "older than the freshness window" };
  }

  const last = store.latestSnapshot(video.platform, video.platform_id);
  const first = store.earliestSnapshot(video.platform, video.platform_id);
  if (!last) {
    return { video, candidate: null, nextState: "observing", reason: "no metrics yet" };
  }

  const v = velocity(first, last, video.posted_at, now);
  const engagementRate = last.plays > 0 ? (last.likes + last.comments) / last.plays : 0;

  const meetsVolume = last.plays >= q.minPlays && last.likes >= q.minLikes;
  const meetsVelocity = v >= q.minVelocityPlaysPerDay;

  if (meetsVolume && meetsVelocity) {
    const candidate: Candidate = {
      video,
      plays: last.plays,
      likes: last.likes,
      comments: last.comments,
      velocityPlaysPerDay: v,
      engagementRate,
      score: scoreOf(v, engagementRate),
    };
    return { video, candidate, nextState: "qualified", reason: null };
  }

  if (age > q.maxAgeDaysToQualify) {
    return { video, candidate: null, nextState: "expired", reason: "aged out below threshold" };
  }
  if (video.observation_count >= q.observationRuns && !meetsVolume) {
    return {
      video,
      candidate: null,
      nextState: "expired",
      reason: "did not gain traction across observation window",
    };
  }
  return { video, candidate: null, nextState: "observing", reason: "below threshold" };
}

export function refreshCandidates(store: Store, cfg: Config, now: Date): Candidate[] {
  const allowed = new Set([
    ...cfg.sources.instagram.map((creator) => `instagram:${creator}`),
    ...cfg.sources.tiktok.map((creator) => `tiktok:${creator}`),
  ]);
  const candidates: Candidate[] = [];

  for (const video of store.openVideos()) {
    if (!allowed.has(`${video.platform}:${video.creator}`)) continue;
    const evaluation = evaluate(store, video, cfg, now);
    store.setState(video.platform, video.platform_id, evaluation.nextState, {
      rejectReason: evaluation.reason ?? undefined,
      score: evaluation.candidate?.score,
    });
    if (evaluation.candidate) candidates.push(evaluation.candidate);
  }

  return candidates;
}

export function selectTop(candidates: Candidate[], cfg: Config): Candidate[] {
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const perCreator = new Map<string, number>();
  const picked: Candidate[] = [];

  for (const c of sorted) {
    if (picked.length >= cfg.generation.scriptsPerRun) break;
    const used = perCreator.get(c.video.creator) ?? 0;
    if (used >= cfg.generation.maxPerCreatorPerRun) continue;
    perCreator.set(c.video.creator, used + 1);
    picked.push(c);
  }

  return picked;
}
