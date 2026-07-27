# Seth Content Engine

This project finds promising Instagram Reels from a fixed real-estate watchlist, adapts the strongest ideas into Seth Caslin's voice, and emails a ready-to-record report to `ben@gochrz.com`.

It runs in GitHub Actions every Monday, Wednesday, and Friday at approximately 7:17 a.m. New York time. The off-peak minute reduces the risk of GitHub delaying or dropping the scheduled event.

## What happens on each run

1. The engine asks Apify for up to 8 recent Reels from each of the 17 configured profiles: a maximum of 136 lightweight records.
2. It stores views, likes, comments, age, and growth history without buying transcripts for every Reel.
3. It ranks the strongest videos by momentum and engagement, with a strict maximum of 2 selections per creator.
4. It asks Apify for transcripts only for the selected Reels, up to 10 per run.
5. Reels with no usable spoken transcript are rejected, so music-only videos do not become scripts.
6. OpenAI writes a new script and two-part caption using Seth's real voice guide. The source idea can be reused, but its wording cannot.
7. The email includes the adapted script, caption, source link, performance numbers, and source transcript, plus a formatted Word document that opens in Google Docs.
8. After a successful live email, those Reels are marked complete so they are not scripted again.

The current source list is in `config.yml`. TikTok is intentionally not active yet because no TikTok watchlist was supplied.

## Cost controls

The expensive transcript option is disabled during the 136-Reel discovery pass. It is enabled only for the shortlist.

The project stops before an Apify call when reported month-to-date usage reaches `$55`. Set a separate hard custom usage limit of `$60` in Apify Billing. The Apify plan and the custom usage limit are separate settings; the project cannot enforce the account-level limit for you.

The first preview uses real Apify and OpenAI calls, so it can incur a small cost even though no email is sent.

## Create the GitHub repository

Create a new private repository in Ben's GitHub account, then upload this project's contents to the root of that repository. Do not upload a parent folder containing unrelated files.

The repository must allow GitHub Actions to write repository contents:

1. Open **Settings -> Actions -> General**.
2. Under **Workflow permissions**, select **Read and write permissions**.
3. Save the change.

The workflow writes its small state database back to the repository after successful stages. That state provides deduplication and lets a restarted run reuse completed discovery instead of paying for the same scrape again.

## Add the required GitHub secrets

Open **Settings -> Secrets and variables -> Actions** and add these repository secrets:

| Secret | Purpose |
|---|---|
| `APIFY_TOKEN` | Runs the Instagram Reel actor and reads Apify usage |
| `OPENAI_API_KEY` | Writes the adapted scripts and captions |
| `GMAIL_USER` | Gmail or Google Workspace account used to send the report |
| `GMAIL_APP_PASSWORD` | App password for that Google account |

Optional repository variable:

| Variable | Purpose |
|---|---|
| `GMAIL_FROM` | Sender address shown in the email; it must already be an allowed "Send mail as" address for `GMAIL_USER` |

If `GMAIL_FROM` is blank, the sender defaults to `GMAIL_USER`.

## First controlled run

Use a preview before enabling normal delivery:

1. Open **Actions -> Seth Content Engine -> Run workflow**.
2. Check **Generate a preview without sending email**.
3. Start the workflow.
4. Download the `preview` artifact from the completed run.
5. Open `preview.html` and the generated `.docx` report to review every script, caption, source link, performance summary, and transcript.
6. If the report is good, run the workflow again with preview unchecked.
7. Confirm the message arrives at `ben@gochrz.com`.

A preview does not mark selected Reels complete. A later live run can still deliver them.

## Schedule

The workflow uses GitHub's timezone-aware scheduling to start at 7:17 a.m. in `America/New_York` every Monday, Wednesday, and Friday, including daylight-saving changes.

To change the schedule, update both:

- the `cron` and `timezone` entry in `.github/workflows/content-engine.yml`
- `delivery.hour` and `delivery.timezone` in `config.yml`

## Configuration

The main controls are in `config.yml`:

- `sources.instagram`: Instagram profiles to watch
- `discovery.reelsPerProfile`: maximum recent Reels per profile
- `qualification`: minimum views, likes, duration, freshness, and momentum
- `generation.scriptsPerRun`: maximum scripts per report
- `generation.maxPerCreatorPerRun`: creator diversity cap
- `spend`: warning and stop thresholds
- `delivery`: time zone, hour, recipient, sender name, and subject

The complete Seth guide used by OpenAI is in `voice/seth-voice-guide.md`.

## Local verification

Install Node.js 22 or newer, then run:

```bash
npm ci
npm run typecheck
npm test
```

The automated tests use representative fixtures and do not need API keys.

For a no-network local preview:

```bash
mkdir -p out
DB_PATH=/tmp/seth-engine.db FIXTURE_FILE=fixtures/sample.json GITHUB_RUN_ID=local-preview npm run discover
DB_PATH=/tmp/seth-engine.db FIXTURE_FILE=fixtures/sample.json GITHUB_RUN_ID=local-preview DRY_RUN=1 MOCK_OPENAI=1 npm run publish
open out/preview.html
```

`MOCK_OPENAI=1` is for local testing only. A GitHub preview deliberately uses the real OpenAI key so the output can be judged before email delivery.

## Operating and recovery

Useful local commands:

```bash
npm run status
npm run prune
```

If discovery was already committed before a later step failed, start a new manual run with both **Generate a preview without sending email** and **Reuse previously saved discovery state** checked. This skips another profile scrape and resumes from the qualified Reels already stored in the repository.

For other temporary failures, open the failed run and use **Re-run failed jobs**. A run already recorded as previewed, empty, or delivered is not generated again.

Failure alerts are sent through the same Gmail account when those credentials are available.

## Current boundary

The implementation and representative end-to-end flow can be tested locally without secrets. The first real Apify scrape, real OpenAI generation, and Gmail delivery still need to be confirmed from Ben's repository after the four secrets and Apify custom usage limit are configured.
