import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";

await mkdir("work/agent-verification/screenshots", { recursive: true });
await rm("work/agent-verification/headless-compsac.json", { force: true });
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

const results = [];
async function query(q, extra = {}) {
  await cmd("Page.navigate", {
    url: "http://127.0.0.1:8771/?" + new URLSearchParams({ q, kind: "paper", ...extra }),
  });
  await waitFor(
    "document.readyState==='complete' && document.querySelector('#q')?.value===" +
      JSON.stringify(q) +
      " && Boolean(document.querySelector('#count')?.textContent.trim())",
  );
  await new Promise((r) => setTimeout(r, 750));
}
for (const q of [
  "Applications and the Internet",
  "ipsj-27-r-compsac",
  "JIP 2027",
  "COMPSAC 2026 特集号",
  "英語論文",
]) {
  await query(q);
  const value = await evaluate(
    `({q:${JSON.stringify(q)},count:document.querySelector('#count').textContent,rows:[...document.querySelectorAll('.row-detail')].map(x=>x.closest('tr').innerText)})`,
  );
  assert.equal(value.rows.length, 1, q);
  assert(value.rows[0].includes("2026-12-01"));
  assert(value.rows[0].includes("2027年9月号（掲載予定）"));
  assert(!value.rows[0].includes("2027-09-01"));
  results.push(value);
}
const oldKeys = await evaluate(
  `fetch('data.json').then(r=>r.json()).then(data=>data.conferences.filter(c=>['jip','ipsj-27-r-compsac'].includes(c.key)).flatMap(c=>c.editions.filter(e=>['jip-compsac2027-si','ipsj-27-r26'].includes(e.id)).map(e=>c.key+'|'+e.year+'|paper|'+Math.trunc(Date.parse(e.deadlines.find(d=>d.kind==='paper'&&d.local_date==='2026-12-01').earliest_utc)))))`,
);
for (const oldKey of oldKeys) {
  await query("Applications and the Internet", { row: oldKey });
  await waitFor("document.querySelector('#drawerBackdrop.active')");
  await new Promise((r) => setTimeout(r, 400));
  const detail = await evaluate("document.querySelector('#drawerBody').textContent");
  assert(detail.includes("掲載予定: 2027年9月号"));
  assert(detail.includes("英語論文のみ"));
  assert(detail.includes("投稿先: Journal of Information Processing"));
  assert(!detail.includes("今後の会期:"));
  assert(detail.includes("同じ募集を1件"));
  assert(detail.includes("時刻未確認"));
  assert(!detail.includes("2027-09-01"));
  assert.equal(await evaluate("document.querySelectorAll('.edition-schedule button').length"), 1);
  await cmd("Page.reload", { ignoreCache: true });
  await waitFor("document.querySelector('#drawerBackdrop.active')");
  await evaluate("document.querySelector('#drawerClose').click()");
  await waitFor("!document.querySelector('#drawerBackdrop.active')");
  await query("Applications and the Internet");
  await evaluate("document.querySelector('.row-detail').click()");
  await waitFor("document.querySelector('#drawerBackdrop.active')");
  await evaluate("history.back()");
  await waitFor(
    "!document.querySelector('#drawerBackdrop.active') && !new URLSearchParams(location.search).has('row')",
  );
  assert(await evaluate("document.activeElement.classList.contains('row-detail')"));
  await evaluate("history.forward()");
  await waitFor("document.querySelector('#drawerBackdrop.active')");
  await evaluate("document.querySelector('#drawerClose').click()");
  await waitFor(
    "!document.querySelector('#drawerBackdrop.active') && !new URLSearchParams(location.search).has('row')",
  );
  for (let n = 0; n < 3; n++) {
    await evaluate("document.querySelector('.row-detail').click()");
    await waitFor("document.querySelector('#drawerBackdrop.active')");
    await evaluate("document.querySelector('.edition-schedule button').click()");
    assert(
      (await evaluate("document.querySelector('#drawerBody').textContent")).includes("掲載予定"),
    );
    await waitFor("Boolean(document.activeElement.closest('#drawer'))");
    await evaluate(
      "document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))",
    );
    await waitFor(
      "!document.querySelector('#drawerBackdrop.active') && !new URLSearchParams(location.search).has('row')",
    );
  }
  results.push({ oldKey, detail, reload_back_forward_repeated: true });
}
await query("Applications and the Internet");
const csv = await evaluate(
  `(async()=>{const original=URL.createObjectURL;let captured;URL.createObjectURL=blob=>{captured=blob;return 'blob:local-test'};const click=HTMLAnchorElement.prototype.click;HTMLAnchorElement.prototype.click=function(){};try{document.querySelector('#exportCsv').click();return await captured.text()}finally{URL.createObjectURL=original;HTMLAnchorElement.prototype.click=click}})()`,
);
assert.equal(csv.trim().split("\n").length, 2);
assert(csv.includes("2026-12-01"));
assert(csv.includes("2027年9月号（掲載予定）"));
assert(!csv.includes("2027-09-01"));
const ics = await evaluate("fetch('deadlines.ics').then(r=>r.text())");
const events = ics
  .replace(/\r?\n[ \t]/g, "")
  .split("BEGIN:VEVENT")
  .filter((e) => e.includes("https://www.ipsj.or.jp/journal/cfp/27-R.html"));
assert.equal(events.length, 1);
assert(events[0].includes("UID:kamiyobi-jip-compsac2027-si-"));
assert(events[0].includes("DTSTART;VALUE=DATE:20261201"));
assert(events[0].includes("掲載予定: 2027年9月号"));
assert(!events[0].includes("2027-09-01"));
await mkdir("work/agent-verification/screenshots", { recursive: true });
await evaluate(
  "document.querySelector('.advanced-panel')?.removeAttribute('open');document.querySelectorAll('details[open]').forEach(d=>d.open=false);scrollTo(0,240)",
);
await new Promise((r) => setTimeout(r, 250));
await writeFile(
  "work/agent-verification/screenshots/compsac-single-call-desktop.png",
  Buffer.from(
    (await cmd("Page.captureScreenshot", { format: "png", captureBeyondViewport: false })).data,
    "base64",
  ),
);
await cmd("Emulation.setDeviceMetricsOverride", {
  width: 390,
  height: 844,
  deviceScaleFactor: 1,
  mobile: true,
});
await query("Applications and the Internet");
await evaluate("document.querySelector('.row-detail').click()");
await waitFor("document.querySelector('#drawerBackdrop.active')");
await new Promise((r) => setTimeout(r, 500));
const mobile = await evaluate(
  "({width:innerWidth,scroll:document.documentElement.scrollWidth,drawer:document.querySelector('#drawer').getBoundingClientRect().toJSON(),button:document.querySelector('.edition-schedule button').getBoundingClientRect().toJSON()})",
);
assert(mobile.scroll <= mobile.width);
assert(mobile.drawer.left >= 0 && mobile.drawer.right <= 390);
assert(mobile.button.height >= 44);
await writeFile(
  "work/agent-verification/screenshots/compsac-publication-mobile.png",
  Buffer.from(
    (await cmd("Page.captureScreenshot", { format: "png", captureBeyondViewport: false })).data,
    "base64",
  ),
);
assert.deepEqual(errors, []);
await writeFile(
  "work/agent-verification/headless-compsac.json",
  JSON.stringify(
    {
      passed: true,
      headless: true,
      no_native_input: true,
      reduced_motion: reducedMotion,
      results,
      csv,
      calendar: events,
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
  "PASS: 5 searches, two archival shared URLs, reload/back/forward, repeated operations, selected CSV, subscribed ICS, mobile",
);
