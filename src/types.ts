export type Platform = "instagram" | "tiktok";

export type VideoState =
  | "new"
  | "observing"
  | "qualified"
  | "processed"
  | "rejected"
  | "expired";

export interface RawVideo {
  platform: Platform;
  platformId: string;
  url: string;
  creator: string;
  caption: string;
  transcript: string | null;
  transcriptChecked: boolean;
  plays: number;
  likes: number;
  comments: number;
  durationSeconds: number;
  postedAt: string;
  isPinned: boolean;
}

export interface VideoRow {
  platform: Platform;
  platform_id: string;
  url: string;
  creator: string;
  caption: string;
  transcript: string | null;
  transcript_checked: number;
  duration_seconds: number;
  posted_at: string;
  state: VideoState;
  first_seen_at: string;
  last_seen_at: string;
  observation_count: number;
  reject_reason: string | null;
  processed_at: string | null;
  score: number | null;
}

export interface Snapshot {
  platform: Platform;
  platform_id: string;
  run_id: string;
  captured_at: string;
  plays: number;
  likes: number;
  comments: number;
}

export interface Candidate {
  video: VideoRow;
  plays: number;
  likes: number;
  comments: number;
  velocityPlaysPerDay: number;
  engagementRate: number;
  score: number;
}

export interface Script {
  platformId: string;
  platform: Platform;
  sourceUrl: string;
  sourceCreator: string;
  hook: string;
  body: string;
  cta: string;
  topic: string;
  captionHook: string;
  captionBody: string;
  transcript: string;
  plays: number;
  likes: number;
  comments: number;
  velocityPlaysPerDay: number;
  engagementRate: number;
}

export interface Config {
  sources: { instagram: string[]; tiktok: string[] };
  discovery: {
    reelsPerProfile: number;
    onlyPostsNewerThan: string;
    skipPinnedPosts: boolean;
  };
  qualification: {
    minPlays: number;
    minLikes: number;
    minDurationSeconds: number;
    minTranscriptWords: number;
    observationRuns: number;
    minVelocityPlaysPerDay: number;
    maxAgeDaysToQualify: number;
  };
  generation: {
    scriptsPerRun: number;
    provider: string;
    model: string;
    maxPerCreatorPerRun: number;
  };
  spend: { monthlyLimitUsd: number; abortIfMonthToDateExceedsUsd: number };
  delivery: {
    timezone: string;
    hour: number;
    to: string[];
    fromName: string;
    subjectPrefix: string;
  };
}
