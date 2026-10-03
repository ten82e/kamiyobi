import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";

await mkdir("work/agent-verification/screenshots", { recursive: true });
await rm("work/agent-verification/headless-identity.json", { force: true });
const cdpOrigin = process.env.KAMIYOBI_CDP_ORIGIN || "http://127.0.0.1:9240";
const version = await fetch(`${cdpOrigin}/json/version`).then((r) => r.json());
assert.match(version["User-Agent"], /HeadlessChrome/, "Use an isolated headless Chrome only");
const target = await fetch(`${cdpOrigin}/json/new?about:blank`, { method: "PUT" }).then((r) => {
  if (!r.ok) throw new Error(`Headless target creation failed: ${r.status}`);
  return r.json();
});
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
let seq = 0;
const pending = new Map();
const errors = [];
ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id) {
    const pair = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) pair.reject(new Error(JSON.stringify(msg.error)));
    else pair.resolve(msg.result);
  }
  if (msg.method === "Runtime.exceptionThrown") errors.push(msg.params.exceptionDetails.text);
  if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error")
    errors.push(msg.params.entry.text);
});
function cmd(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const out = await cmd("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (out.exceptionDetails) throw new Error(JSON.stringify(out.exceptionDetails));
  return out.result.value;
}
async function waitFor(expression) {
  for (let n = 0; n < 150; n++) {
    if (await evaluate(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timeout: ${expression}`);
}
const blockedRequests = [];
ws.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.method === "Fetch.requestPaused") {
    const p = message.params;
    const allowed =
      p.request.url.startsWith("http://127.0.0.1:8771/") ||
      p.request.url.startsWith("data:") ||
      p.request.url.startsWith("about:");
    if (!allowed) blockedRequests.push(p.request.url);
    cmd(
      allowed ? "Fetch.continueRequest" : "Fetch.failRequest",
      allowed
        ? { requestId: p.requestId }
        : { requestId: p.requestId, errorReason: "BlockedByClient" },
    ).catch(() => {});
  }
});
await cmd("Fetch.disable");
await cmd("Page.enable");
await cmd("Network.enable");
await cmd("Network.setCacheDisabled", { cacheDisabled: true });
const reducedMotion = process.env.KAMIYOBI_REDUCED_MOTION || "reduce";
assert(["reduce", "no-preference"].includes(reducedMotion));
await cmd("Emulation.setEmulatedMedia", {
  features: [{ name: "prefers-reduced-motion", value: reducedMotion }],
});
await cmd("Runtime.enable");
await cmd("Log.enable");
await cmd("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
await cmd("Page.addScriptToEvaluateOnNewDocument", {
  source: `Date.now=()=>Date.parse('2026-10-03T06:00:00Z')`,
});
await cmd("Emulation.setDeviceMetricsOverride", {
  width: 1280,
  height: 1000,
  deviceScaleFactor: 1,
  mobile: false,
});

async function query(q, extra = {}) {
  await cmd("Page.navigate", {
    url: "http://127.0.0.1:8771/?" + new URLSearchParams({ q, ...extra }),
  });
  await waitFor(
    "document.readyState==='complete' && document.querySelector('#q')?.value===" +
      JSON.stringify(q) +
      " && Boolean(document.querySelector('#count')?.textContent.trim())",
  );
  await new Promise((r) => setTimeout(r, 700));
}
await query("WACV");
const oldKey = await evaluate(
  `fetch('data.json').then(r=>r.json()).then(d=>{const c=d.conferences.find(c=>c.key==='wacv');const e=c.editions.find(e=>e.year===2027);const dl=e.deadlines.find(dl=>dl.kind==='notification'&&dl.round===1&&dl.utc.startsWith('2026-10-10'));return c.key+'|'+e.year+'|notification|'+Date.parse(dl.utc)})`,
);
await query("WACV", { row: oldKey });
await waitFor("document.querySelectorAll('.shared-row-choice').length===2");
assert(!(await evaluate("Boolean(document.querySelector('#drawerBackdrop.active'))")));
const choices = await evaluate(
  "[...document.querySelectorAll('.shared-row-choice')].map(b=>b.textContent)",
);
assert(choices[0].includes("第 1 ラウンド"));
assert(choices[1].includes("第 2 ラウンド"));
await evaluate("document.querySelectorAll('.shared-row-choice')[1].click()");
await waitFor("document.querySelector('#drawerBackdrop.active')");
assert(
  (
    await evaluate("document.querySelector('.edition-schedule [aria-current=true]').textContent")
  ).includes("Round 2 Reviews"),
);
const preciseUrl = await evaluate("location.href");
assert(new URL(preciseUrl).searchParams.get("row").includes("|slot="));
await cmd("Page.reload", { ignoreCache: true });
await waitFor(
  "document.querySelector('.edition-schedule [aria-current=true]')?.textContent.includes('Round 2 Reviews')",
);
for (let n = 0; n < 3; n++)
  for (const label of ["Round 1 Final Decisions", "Round 2 Reviews"]) {
    await evaluate(
      `[...document.querySelectorAll('.edition-schedule button')].find(b=>b.textContent.includes(${JSON.stringify(label)})).click()`,
    );
    await waitFor(
      `document.querySelector('.edition-schedule [aria-current=true]')?.textContent.includes(${JSON.stringify(label)})`,
    );
    assert(new URL(await evaluate("location.href")).searchParams.get("row").includes("|slot="));
  }
await cmd("Page.reload", { ignoreCache: true });
await waitFor(
  "document.querySelector('.edition-schedule [aria-current=true]')?.textContent.includes('Round 2 Reviews')",
);
await evaluate("document.querySelector('#drawerClose').click()");
await waitFor("!document.querySelector('#drawerBackdrop.active')");
assert.equal(await evaluate("document.querySelector('#q').value"), "WACV");
await cmd("Emulation.setDeviceMetricsOverride", {
  width: 390,
  height: 844,
  deviceScaleFactor: 1,
  mobile: true,
});
await query("WACV", { row: oldKey });
await waitFor("document.querySelectorAll('.shared-row-choice').length===2");
await evaluate(
  "document.querySelectorAll('details[open]').forEach(d=>d.open=false);document.querySelector('#sharedRowChoices').scrollIntoView({block:'center',behavior:'instant'})",
);
await new Promise((r) => setTimeout(r, 250));
const mobile = await evaluate(
  "({width:innerWidth,scroll:document.documentElement.scrollWidth,choices:[...document.querySelectorAll('.shared-row-choice')].map(b=>b.getBoundingClientRect().toJSON())})",
);
assert(mobile.scroll <= 390);
assert(
  await evaluate(
    "[...document.querySelectorAll('.shared-row-choice')].every(b=>{const r=b.getBoundingClientRect();return b.checkVisibility() && !b.closest('.sr-label') && b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})",
  ),
);
assert(
  mobile.choices.every(
    (b) => b.height >= 44 && b.width >= 300 && b.right <= 390 && b.top >= 0 && b.bottom <= 844,
  ),
);
await writeFile(
  "work/agent-verification/screenshots/shared-link-choices-mobile.png",
  Buffer.from(
    (await cmd("Page.captureScreenshot", { format: "png", captureBeyondViewport: false })).data,
    "base64",
  ),
);
assert.deepEqual(errors, []);
await writeFile(
  "work/agent-verification/headless-identity.json",
  JSON.stringify(
    {
      passed: true,
      headless: true,
      no_native_input: true,
      reduced_motion: reducedMotion,
      oldKey,
      choices,
      preciseUrl,
      six_switches_preserve_identity: true,
      reload_preserves_round_2: true,
      mobile,
      errors,
      blockedRequests,
    },
    null,
    2,
  ) + "\n",
);
await cmd("Fetch.disable");
await cmd("Target.closeTarget", { targetId: target.id });
ws.close();
console.log(
  "PASS: ambiguous old link, explicit Round 2, precise reload, six switches, mobile choices",
);
