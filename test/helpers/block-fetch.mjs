// Preload (node --import, passed down through NODE_OPTIONS) for test/smoke-live-guard.mjs: replaces
// fetch so a process under test can never reach a relay — every call is recorded to
// MYNA_TEST_FETCH_LOG and rejected. ask-human.mjs talks to the relay only through fetch, so if a live
// test's opt-in check ever regressed, its question would land here instead of on the phone.
import fs from "node:fs";

const log = process.env.MYNA_TEST_FETCH_LOG;
globalThis.fetch = async (input) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  if (log) fs.appendFileSync(log, url + "\n");
  throw new Error("network blocked by test/helpers/block-fetch.mjs");
};
