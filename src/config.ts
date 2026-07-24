import { readFileSync } from "node:fs";
import { parse } from "yaml";
import type { Config } from "./types.js";

export function loadConfig(path = "config.yml"): Config {
  const cfg = parse(readFileSync(path, "utf8")) as Config;

  const problems: string[] = [];
  const igCount = cfg.sources?.instagram?.length ?? 0;
  const ttCount = cfg.sources?.tiktok?.length ?? 0;
  if (igCount + ttCount === 0) problems.push("sources: no profiles configured");
  if (!cfg.discovery?.reelsPerProfile) problems.push("discovery.reelsPerProfile is required");
  if (!cfg.generation?.scriptsPerRun) problems.push("generation.scriptsPerRun is required");
  if (!cfg.delivery?.to?.length) problems.push("delivery.to is required");
  if (!cfg.spend?.abortIfMonthToDateExceedsUsd)
    problems.push("spend.abortIfMonthToDateExceedsUsd is required");

  if (problems.length) {
    throw new Error(`Invalid config.yml:\n  - ${problems.join("\n  - ")}`);
  }

  return cfg;
}
