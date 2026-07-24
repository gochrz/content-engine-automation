import { readFileSync } from "node:fs";
import type { Candidate, Config, Script } from "./types.js";

const SYSTEM = `You write short-form video scripts for a real estate investor named Seth Caslin.

You will be given a VOICE GUIDE and a TRANSCRIPT of someone else's video.

Rules:
- Use the source only for the underlying topic and angle. Never reuse its sentences, phrasing, or distinctive wording. Same idea, completely new words.
- The script must sound like Seth per the voice guide. If it does not, rewrite before answering.
- Target 30 to 60 seconds of spoken content.
- Do not invent specific numbers, deal figures, or claims that are not in the source.
- Treat every example in the voice guide as style-only. Never borrow its facts, dollar amounts, people, or property details unless they also appear in the source transcript.
- Write a two-part Instagram caption: captionHook should earn attention or invite sharing, and captionBody should add concise context without repeating the script.

Respond with JSON only, no markdown fences, matching:
{"topic": string, "hook": string, "body": string, "cta": string, "captionHook": string, "captionBody": string}`;

export interface GeneratorOptions {
  apiKey: string;
  model: string;
  voiceGuidePath: string;
}

export function buildOpenAIRequest(model: string, userPrompt: string) {
  return {
    model,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "seth_content_script",
        strict: true,
        schema: {
          type: "object",
          properties: {
            topic: { type: "string" },
            hook: { type: "string" },
            body: { type: "string" },
            cta: { type: "string" },
            captionHook: { type: "string" },
            captionBody: { type: "string" },
          },
          required: [
            "topic",
            "hook",
            "body",
            "cta",
            "captionHook",
            "captionBody",
          ],
          additionalProperties: false,
        },
      },
    },
    temperature: 0.8,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: userPrompt },
    ],
  };
}

async function callOpenAI(
  opts: GeneratorOptions,
  userPrompt: string,
): Promise<Record<string, string>> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify(buildOpenAIRequest(opts.model, userPrompt)),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenAI HTTP ${res.status}: ${text.slice(0, 300)}`);
  }

  const json = (await res.json()) as any;
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("OpenAI returned no content");
  return JSON.parse(content);
}

export function buildPrompt(voiceGuide: string, c: Candidate): string {
  return [
    "VOICE GUIDE",
    "-----------",
    voiceGuide.trim(),
    "",
    "SOURCE VIDEO",
    "------------",
    `Creator: ${c.video.creator}`,
    `Caption: ${c.video.caption.slice(0, 500)}`,
    `Plays: ${c.plays}  Likes: ${c.likes}  Comments: ${c.comments}`,
    "",
    "TRANSCRIPT",
    "----------",
    (c.video.transcript ?? "").slice(0, 6000),
  ].join("\n");
}

export type CompletionFn = (prompt: string) => Promise<Record<string, string>>;

export async function generateScripts(
  candidates: Candidate[],
  cfg: Config,
  opts: GeneratorOptions,
  completion?: CompletionFn,
): Promise<{ scripts: Script[]; failures: Array<{ id: string; error: string }> }> {
  const voiceGuide = readFileSync(opts.voiceGuidePath, "utf8");
  const complete: CompletionFn = completion ?? ((p) => callOpenAI(opts, p));

  const scripts: Script[] = [];
  const failures: Array<{ id: string; error: string }> = [];

  for (const c of candidates) {
    const prompt = buildPrompt(voiceGuide, c);
    let parsed: Record<string, string> | null = null;
    let lastError = "";

    for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
      try {
        const result = await complete(prompt);
        if (!result.hook || !result.body) throw new Error("missing hook or body");
        if (!result.captionHook || !result.captionBody) {
          throw new Error("missing caption hook or body");
        }
        parsed = result;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (attempt === 0) await new Promise((r) => setTimeout(r, 1500));
      }
    }

    if (!parsed) {
      failures.push({ id: c.video.platform_id, error: lastError });
      continue;
    }

    scripts.push({
      platformId: c.video.platform_id,
      platform: c.video.platform,
      sourceUrl: c.video.url,
      sourceCreator: c.video.creator,
      topic: parsed.topic ?? "Untitled",
      hook: parsed.hook,
      body: parsed.body,
      cta: parsed.cta ?? "",
      captionHook: parsed.captionHook ?? "",
      captionBody: parsed.captionBody ?? "",
      transcript: c.video.transcript ?? "",
      plays: c.plays,
      likes: c.likes,
      comments: c.comments,
      velocityPlaysPerDay: c.velocityPlaysPerDay,
      engagementRate: c.engagementRate,
    });
  }

  return { scripts, failures };
}
