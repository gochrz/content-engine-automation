import { Actor, log } from "apify";
import { runDispatcher } from "./dispatcher.js";

await Actor.main(async () => {
  const input = (await Actor.getInput()) ?? {};
  const result = await runDispatcher({
    token: process.env.GITHUB_TOKEN,
    input,
    logger: log,
  });
  await Actor.setValue("OUTPUT", result);
  log.info("The GitHub workflow completed successfully", result);
});
