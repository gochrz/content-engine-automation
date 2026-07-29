import assert from "node:assert/strict";
import test from "node:test";
import { runDispatcher } from "../src/dispatcher.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

test("dispatches and monitors a successful GitHub run", async () => {
  const requests = [];
  const statuses = ["queued", "completed"];
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url, init });
    if (url.includes("/runs?")) return jsonResponse({ workflow_runs: [] });
    if (url.endsWith("/dispatches")) {
      return jsonResponse({
        workflow_run_id: 123,
        html_url: "https://github.com/gochrz/content-engine-automation/actions/runs/123",
      });
    }
    return jsonResponse({
      id: 123,
      status: statuses.shift(),
      conclusion: statuses.length === 0 ? "success" : null,
      html_url: "https://github.com/gochrz/content-engine-automation/actions/runs/123",
    });
  };

  const result = await runDispatcher({
    token: "test-token",
    input: {
      mode: "test",
      dryRun: false,
      reuseSavedDiscovery: false,
      pollSeconds: 5,
    },
    fetchImpl,
    sleep: async () => {},
    now: () => new Date("2026-07-29T15:00:00Z"),
    logger: {
      info: () => {},
    },
  });

  assert.equal(result.runId, 123);
  assert.equal(result.conclusion, "success");
  assert.equal(result.dryRun, true);
  assert.equal(result.reuseSavedDiscovery, true);
  assert.equal(requests.filter(({ url }) => url.endsWith("/dispatches")).length, 1);
  const dispatchRequest = requests.find(({ url }) => url.endsWith("/dispatches"));
  assert.equal(JSON.parse(dispatchRequest.init.body).inputs.dispatcher_test, true);
});

test("reuses an existing scheduled run instead of dispatching twice", async () => {
  let dispatches = 0;
  const fetchImpl = async (url) => {
    if (url.includes("/runs?")) {
      return jsonResponse({
        workflow_runs: [{
          id: 456,
          display_title: "Seth Content Engine — apify-schedule-2026-07-29",
        }],
      });
    }
    if (url.endsWith("/dispatches")) {
      dispatches += 1;
      return jsonResponse({}, 200);
    }
    return jsonResponse({
      id: 456,
      status: "completed",
      conclusion: "success",
      html_url: "https://github.com/gochrz/content-engine-automation/actions/runs/456",
    });
  };

  const result = await runDispatcher({
    token: "test-token",
    fetchImpl,
    sleep: async () => {},
    now: () => new Date("2026-07-29T15:00:00Z"),
    logger: {
      info: () => {},
    },
  });

  assert.equal(result.runId, 456);
  assert.equal(dispatches, 0);
});

test("fails when the GitHub workflow fails", async () => {
  const fetchImpl = async (url) => {
    if (url.includes("/runs?")) return jsonResponse({ workflow_runs: [] });
    if (url.endsWith("/dispatches")) {
      return jsonResponse({
        workflow_run_id: 789,
        html_url: "https://github.com/gochrz/content-engine-automation/actions/runs/789",
      });
    }
    return jsonResponse({
      id: 789,
      status: "completed",
      conclusion: "failure",
      html_url: "https://github.com/gochrz/content-engine-automation/actions/runs/789",
    });
  };

  await assert.rejects(
    runDispatcher({
      token: "test-token",
      input: {
        mode: "test",
      },
      fetchImpl,
      sleep: async () => {},
      now: () => new Date("2026-07-29T15:00:00Z"),
      logger: {
        info: () => {},
      },
    }),
    /finished with failure/,
  );
});

test("recovers an accepted run after an uncertain dispatch response", async () => {
  let listCalls = 0;
  let dispatchCalls = 0;
  const fetchImpl = async (url) => {
    if (url.includes("/runs?")) {
      listCalls += 1;
      return jsonResponse({
        workflow_runs: listCalls > 1 ? [{
          id: 901,
          display_title: "Seth Content Engine — apify-test-20260729150000",
        }] : [],
      });
    }
    if (url.endsWith("/dispatches")) {
      dispatchCalls += 1;
      throw new Error("Connection closed");
    }
    return jsonResponse({
      id: 901,
      status: "completed",
      conclusion: "success",
      html_url: "https://github.com/gochrz/content-engine-automation/actions/runs/901",
    });
  };

  const result = await runDispatcher({
    token: "test-token",
    input: {
      mode: "test",
    },
    fetchImpl,
    sleep: async () => {},
    now: () => new Date("2026-07-29T15:00:00Z"),
    logger: {
      info: () => {},
      warning: () => {},
    },
  });

  assert.equal(result.runId, 901);
  assert.equal(dispatchCalls, 1);
});
