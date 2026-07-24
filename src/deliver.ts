import nodemailer from "nodemailer";
import type { Config, Script } from "./types.js";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function formatDate(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function transcriptExcerpt(transcript: string): string {
  const clean = transcript.trim();
  if (clean.length <= 1800) return clean;
  return `${clean.slice(0, 1797).trimEnd()}...`;
}

export function renderEmail(scripts: Script[], cfg: Config, date: Date): string {
  const heading = formatDate(date, cfg.delivery.timezone);

  const blocks = scripts
    .map(
      (s, i) => `
      <div style="margin:0 0 32px;padding:20px;border:1px solid #e5e5e5;border-radius:8px;">
        <div style="font:600 13px/1.4 -apple-system,Segoe UI,sans-serif;color:#888;text-transform:uppercase;letter-spacing:.05em;">
          Script ${i + 1} &middot; ${escapeHtml(s.topic)}
        </div>
        <p style="font:600 17px/1.45 -apple-system,Segoe UI,sans-serif;color:#111;margin:12px 0 8px;">
          ${escapeHtml(s.hook)}
        </p>
        <p style="font:400 15px/1.6 -apple-system,Segoe UI,sans-serif;color:#333;margin:0 0 12px;white-space:pre-wrap;">
${escapeHtml(s.body)}
        </p>
        ${
          s.cta
            ? `<p style="font:500 15px/1.5 -apple-system,Segoe UI,sans-serif;color:#111;margin:0 0 12px;">${escapeHtml(s.cta)}</p>`
            : ""
        }
        <div style="margin:20px 0 0;padding:16px;background:#f6f7f8;border-radius:6px;">
          <div style="font:600 12px/1.4 -apple-system,Segoe UI,sans-serif;color:#666;text-transform:uppercase;letter-spacing:.05em;margin:0 0 8px;">Caption</div>
          <p style="font:600 14px/1.5 -apple-system,Segoe UI,sans-serif;color:#222;margin:0 0 8px;white-space:pre-wrap;">${escapeHtml(s.captionHook)}</p>
          ${
            s.captionBody
              ? `<p style="font:400 14px/1.5 -apple-system,Segoe UI,sans-serif;color:#444;margin:0;white-space:pre-wrap;">- - - -<br>${escapeHtml(s.captionBody)}</p>`
              : ""
          }
        </div>
        <div style="margin:20px 0 0;padding-top:16px;border-top:1px solid #e5e5e5;">
          <div style="font:600 12px/1.4 -apple-system,Segoe UI,sans-serif;color:#666;text-transform:uppercase;letter-spacing:.05em;margin:0 0 8px;">Source evidence</div>
          <div style="font:400 12px/1.5 -apple-system,Segoe UI,sans-serif;color:#777;margin:0 0 10px;">
            ${formatNumber(s.plays)} plays &middot; ${formatNumber(s.likes)} likes &middot; ${formatNumber(s.comments)} comments<br>
            ${formatNumber(s.velocityPlaysPerDay)} plays/day &middot; ${(s.engagementRate * 100).toFixed(2)}% engagement
          </div>
          <div style="font:600 12px/1.4 -apple-system,Segoe UI,sans-serif;color:#666;margin:0 0 4px;">Source transcript</div>
          <div style="font:400 12px/1.55 -apple-system,Segoe UI,sans-serif;color:#777;white-space:pre-wrap;margin:0 0 10px;">${escapeHtml(transcriptExcerpt(s.transcript))}</div>
          <div style="font:400 12px/1.4 -apple-system,Segoe UI,sans-serif;color:#999;">
            Source: <a href="${escapeHtml(s.sourceUrl)}" style="color:#777;">@${escapeHtml(s.sourceCreator)}</a>
          </div>
        </div>
      </div>`,
    )
    .join("\n");

  return `<!doctype html><html><body style="margin:0;padding:24px;background:#fafafa;">
  <div style="max-width:640px;margin:0 auto;">
    <h1 style="font:600 22px/1.3 -apple-system,Segoe UI,sans-serif;color:#111;margin:0 0 4px;">
      ${scripts.length} ready-to-record scripts
    </h1>
    <p style="font:400 14px/1.4 -apple-system,Segoe UI,sans-serif;color:#888;margin:0 0 28px;">${heading}</p>
    ${blocks}
  </div>
</body></html>`;
}

export function renderText(scripts: Script[]): string {
  return scripts
    .map(
      (s, i) =>
        `SCRIPT ${i + 1} - ${s.topic}\n\nHOOK: ${s.hook}\n\n${s.body}\n\n${s.cta}\n\nCAPTION\n${s.captionHook}${s.captionBody ? `\n\n- - - -\n${s.captionBody}` : ""}\n\nSOURCE EVIDENCE\n${formatNumber(s.plays)} plays | ${formatNumber(s.likes)} likes | ${formatNumber(s.comments)} comments\n${formatNumber(s.velocityPlaysPerDay)} plays/day | ${(s.engagementRate * 100).toFixed(2)}% engagement\n\nSOURCE TRANSCRIPT\n${transcriptExcerpt(s.transcript)}\n\nSource: @${s.sourceCreator}: ${s.sourceUrl}\n${"-".repeat(60)}`,
    )
    .join("\n\n");
}

export async function sendEmail(
  html: string,
  text: string,
  subject: string,
  cfg: Config,
  creds: { user: string; pass: string; from: string },
) {
  const transport = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: creds.user, pass: creds.pass },
  });

  await transport.verify();

  const info = await transport.sendMail({
    from: `"${cfg.delivery.fromName}" <${creds.from}>`,
    to: cfg.delivery.to.join(", "),
    subject,
    text,
    html,
  });

  return info.messageId;
}

export async function sendFailureAlert(
  cfg: Config,
  creds: { user: string; pass: string; from: string },
  runId: string,
  error: string,
  runUrl: string,
) {
  const transport = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: creds.user, pass: creds.pass },
  });

  await transport.sendMail({
    from: `"${cfg.delivery.fromName}" <${creds.from}>`,
    to: cfg.delivery.to.join(", "),
    subject: `[Content Engine] Run ${runId} failed`,
    text: `The content engine run failed.\n\nError:\n${error}\n\nLogs: ${runUrl}\n\nNo scripts were sent. State was preserved; the next scheduled run will pick up where this one stopped.`,
  });
}
