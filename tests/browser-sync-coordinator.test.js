import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import vm from "node:vm";
import { startCoordinator } from "./browser-sync-e2e/coordinator.mjs";
import { wrapFirefoxE2ERunner } from "./browser-sync-e2e/firefox-runner.mjs";

describe("browser sync E2E coordinator", () => {
  let coordinator = null;

  afterEach(async () => {
    if (coordinator) await coordinator.close();
    coordinator = null;
  });

  it("rejects web origins and never exposes a config endpoint", async () => {
    coordinator = await startCoordinator({ nonce: "session-test" });
    const webResponse = await fetch(`${coordinator.url}/event?name=ready:A`, {
      headers: { Origin: "https://attacker.invalid", "X-E2E-Session": "session-test" },
    });
    assert.equal(webResponse.status, 403);
    assert.equal(webResponse.headers.has("access-control-allow-origin"), false);

    const configResponse = await fetch(`${coordinator.url}/config`, {
      headers: { Origin: "chrome-extension://abcdefghijklmnop", "X-E2E-Session": "session-test" },
    });
    assert.equal(configResponse.status, 404);
    assert.doesNotMatch(await configResponse.text(), /token/i);
  });

  it("requires the session nonce before accepting browser events", async () => {
    coordinator = await startCoordinator({ nonce: "session-test" });
    const origin = "moz-extension://b3333333-3333-4333-8333-333333333333";
    const denied = await fetch(`${coordinator.url}/event?name=ready:A`, { headers: { Origin: origin } });
    assert.equal(denied.status, 401);

    const accepted = await fetch(`${coordinator.url}/event`, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        "X-E2E-Session": "session-test",
      },
      body: JSON.stringify({ role: "A", name: "ready", details: { ok: true } }),
    });
    assert.equal(accepted.status, 200);
    assert.deepEqual(await coordinator.waitFor("ready:A"), { ok: true });

    const browserGetWithoutOrigin = await fetch(`${coordinator.url}/event?name=ready:A`, {
      headers: { "X-E2E-Session": "session-test" },
    });
    assert.equal(browserGetWithoutOrigin.status, 200);
    assert.deepEqual((await browserGetWithoutOrigin.json()).value, { ok: true });
  });
});

describe("Firefox browser sync E2E runner", () => {
  it("isolates declarations from the classic application bundle", () => {
    const context = vm.createContext({});
    new vm.Script("const clone = 'application';").runInContext(context);
    const runner = wrapFirefoxE2ERunner("import { clone } from './module.js';\nconst clone = 'runner';");
    assert.doesNotMatch(runner, /^\s*import\b/m);
    assert.doesNotThrow(() => new vm.Script(runner).runInContext(context));
  });
});
