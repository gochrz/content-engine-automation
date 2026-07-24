const BASE = "https://api.apify.com/v2";

export class SpendGuardError extends Error {}

function actorPath(actorId: string) {
  return actorId.replace("/", "~");
}

async function apiFetch(url: string, init: RequestInit = {}, timeoutMs = 900000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function authorized(token: string, init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return { ...init, headers };
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function monthToDateUsd(token: string): Promise<number | null> {
  try {
    const res = await apiFetch(
      `${BASE}/users/me/limits`,
      authorized(token),
      30000,
    );
    if (!res.ok) return null;
    const json = (await res.json()) as any;
    const value =
      json?.data?.current?.monthlyUsageUsd ??
      json?.data?.monthlyUsageUsd ??
      json?.data?.current?.monthlyUsageCycleUsd;
    return typeof value === "number" ? value : null;
  } catch {
    return null;
  }
}

export async function assertSpendUnderLimit(token: string, limitUsd: number) {
  const spent = await monthToDateUsd(token);
  if (spent === null) {
    console.warn(
      "[spend] could not read Apify usage; relying on the platform limit configured in the Apify console",
    );
    return;
  }
  console.log(`[spend] month to date: $${spent.toFixed(2)} / $${limitUsd.toFixed(2)}`);
  if (spent >= limitUsd) {
    throw new SpendGuardError(
      `Apify month-to-date spend $${spent.toFixed(2)} reached the configured limit of $${limitUsd.toFixed(2)}. Aborting before any actor call.`,
    );
  }
}

export async function runActorSync<T = unknown>(
  token: string,
  actorId: string,
  input: Record<string, unknown>,
  maxItems: number,
): Promise<T[]> {
  const url = `${BASE}/acts/${actorPath(actorId)}/run-sync-get-dataset-items?maxItems=${encodeURIComponent(String(maxItems))}`;
  const init = authorized(token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Response;
    try {
      res = await apiFetch(url, init);
    } catch (error) {
      if (attempt === 0) {
        await wait(1000);
        continue;
      }
      throw new Error(
        `Apify actor ${actorId} request failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt === 0) {
        await wait(1000);
        continue;
      }
      throw new Error(
        `Apify actor ${actorId} failed with HTTP ${res.status}: ${text.slice(0, 500)}`,
      );
    }

    const items = (await res.json()) as T[];
    if (!Array.isArray(items)) {
      throw new Error(`Apify actor ${actorId} returned a non-array payload`);
    }
    return items;
  }

  throw new Error(`Apify actor ${actorId} failed after retry`);
}
