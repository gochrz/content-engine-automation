const DEFAULTS = {
  owner: "gochrz",
  repo: "content-engine-automation",
  workflow: "content-engine.yml",
  ref: "main",
  apiUrl: "https://api.github.com",
  timezone: "America/New_York",
  maxWaitMinutes: 75,
  pollSeconds: 15,
};

function localDate(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function terminalFailure(conclusion) {
  return !["success", "neutral", "skipped"].includes(conclusion);
}

function runTitle(dispatchId) {
  return `Seth Content Engine — ${dispatchId}`;
}

function validateNumber(value, fallback, min, max) {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new Error(`Expected a number between ${min} and ${max}`);
  }
  return number;
}

async function responseBody(response) {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function runDispatcher(options) {
  const {
    token,
    input = {},
    fetchImpl = fetch,
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    now = () => new Date(),
    logger = console,
  } = options;

  if (!token) throw new Error("GITHUB_TOKEN is required");

  const owner = input.owner ?? DEFAULTS.owner;
  const repo = input.repo ?? DEFAULTS.repo;
  const workflow = input.workflow ?? DEFAULTS.workflow;
  const ref = input.ref ?? DEFAULTS.ref;
  const apiUrl = input.apiUrl ?? DEFAULTS.apiUrl;
  const timezone = input.timezone ?? DEFAULTS.timezone;
  const mode = input.mode ?? "schedule";
  const dryRun = mode === "test" ? true : input.dryRun ?? false;
  const reuseSavedDiscovery = mode === "test" ? true : input.reuseSavedDiscovery ?? false;
  const maxWaitMinutes = validateNumber(input.maxWaitMinutes, DEFAULTS.maxWaitMinutes, 1, 90);
  const pollSeconds = validateNumber(input.pollSeconds, DEFAULTS.pollSeconds, 5, 60);
  const date = localDate(now(), timezone);
  const dispatchId = input.dispatchId ?? (
    mode === "schedule"
      ? `apify-schedule-${date}`
      : `apify-test-${now().toISOString().replaceAll(/[^0-9]/g, "").slice(0, 14)}`
  );
  const expectedTitle = runTitle(dispatchId);
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2026-03-10",
    "User-Agent": "seth-content-engine-dispatcher",
  };

  const request = async (path, init = {}) => {
    const response = await fetchImpl(`${apiUrl}${path}`, {
      ...init,
      headers: {
        ...headers,
        ...init.headers,
      },
    });
    const body = await responseBody(response);
    if (!response.ok) {
      const detail = typeof body === "string" ? body : body?.message;
      throw new Error(`GitHub returned ${response.status}${detail ? `: ${detail}` : ""}`);
    }
    return { response, body };
  };

  const findRun = async () => {
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/${encodeURIComponent(workflow)}/runs?branch=${encodeURIComponent(ref)}&event=workflow_dispatch&per_page=30`;
    const { body } = await request(path);
    return body.workflow_runs?.find((run) => run.display_title === expectedTitle);
  };

  const waitForRunToAppear = async () => {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const run = await findRun();
      if (run) return run;
      await sleep(5000);
    }
    return undefined;
  };

  let run = await findRun();

  if (!run) {
    logger.info(`Starting ${expectedTitle}`);
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`;
    let dispatch;
    try {
      dispatch = await request(path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ref,
          inputs: {
            dry_run: dryRun,
            reuse_saved_discovery: reuseSavedDiscovery,
            dispatch_id: dispatchId,
          },
        }),
      });
    } catch (error) {
      logger.warning?.(`The dispatch response was uncertain: ${error.message}`);
      run = await waitForRunToAppear();
      if (!run) throw error;
    }

    if (!run && dispatch?.body?.workflow_run_id) {
      run = {
        id: dispatch.body.workflow_run_id,
        html_url: dispatch.body.html_url,
        status: "queued",
      };
    }

    if (!run) run = await waitForRunToAppear();
    if (!run) throw new Error("GitHub accepted the request but no workflow run appeared");
  } else {
    logger.info(`Found existing ${expectedTitle}`);
  }

  const deadline = Date.now() + maxWaitMinutes * 60_000;
  let lastStatus;

  while (Date.now() < deadline) {
    const { body: current } = await request(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${run.id}`,
    );

    if (current.status !== lastStatus) {
      logger.info(`GitHub run ${current.id} is ${current.status}`);
      lastStatus = current.status;
    }

    if (current.status === "completed") {
      const result = {
        dispatchId,
        runId: current.id,
        runUrl: current.html_url,
        conclusion: current.conclusion,
        dryRun,
        reuseSavedDiscovery,
      };

      if (terminalFailure(current.conclusion)) {
        throw new Error(`GitHub run ${current.id} finished with ${current.conclusion}: ${current.html_url}`);
      }

      return result;
    }

    await sleep(pollSeconds * 1000);
  }

  throw new Error(`GitHub run ${run.id} did not finish within ${maxWaitMinutes} minutes`);
}
