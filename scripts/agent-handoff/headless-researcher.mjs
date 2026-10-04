import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";

await mkdir("work/agent-verification/screenshots", { recursive: true });
await rm("work/agent-verification/headless-researcher.json", { force: true });
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
const cases = [
  { q: "EvoMUSART", kind: "abstract" },
  { q: "EvoMUSART 2027" },
  { q: "SIGMOD", kind: "paper" },
  { q: "SIGMOD 2026年の締切" },
  { q: "情報処理学会", kind: "paper" },
  { q: "IPSJ", kind: "paper" },
  { q: "ISCAS", kind: "paper" },
  { q: "ICML 2027" },
  { q: "ICML 2027", est: "true" },
  { q: "NeurIPS 2026" },
  { q: "NIPS 2026" },
  { q: "NeurIPS 2026", past: "true" },
  { q: "NIPS 2026", past: "true" },
  { q: "SecureComm", kind: "paper" },
  { q: "11月1日 要旨" },
  { q: "日本時間 10月14日" },
];
async function query(c) {
  await cmd("Page.navigate", { url: "http://127.0.0.1:8771/?" + new URLSearchParams(c) });
  await waitFor(
    "document.readyState==='complete' && document.querySelector('#q')?.value===" +
      JSON.stringify(c.q) +
      " && Boolean(document.querySelector('#count')?.textContent.trim())",
  );
  await new Promise((r) => setTimeout(r, 750));
}
const results = [];
for (const c of cases) {
  await query(c);
  const value = await evaluate(
    `({query:${JSON.stringify(c)},stats:document.querySelector('#count').textContent,rows:[...document.querySelectorAll('.row-detail')].map(x=>({text:x.closest('tr').innerText,key:x.getAttribute('aria-label')})),notes:[...document.querySelectorAll('#countLive,#emptyText,#emptyMeeting')].filter(x=>!x.closest('[hidden]')).map(x=>x.textContent).filter(Boolean)})`,
  );
  if (await evaluate("Boolean(document.querySelector('.row-detail'))")) {
    await evaluate("document.querySelector('.row-detail').click()");
    await waitFor("document.querySelector('#drawerBackdrop.active')");
    await new Promise((r) => setTimeout(r, 350));
    value.drawer = await evaluate("document.querySelector('#drawerBody').textContent");
    await evaluate("document.querySelector('#drawerClose').click()");
  }
  results.push(value);
  console.log(c.q, c.past || "", value.rows.length);
}
function find(q, flag) {
  return results.find(
    (c) => c.query.q === q && (flag ? c.query[flag] === "true" : !c.query.past && !c.query.est),
  );
}
const rowKeys = (c) => c.rows.map((r) => r.text).sort();
assert.deepEqual(rowKeys(find("情報処理学会")), rowKeys(find("IPSJ")));
assert.equal(find("情報処理学会").rows.length, 3);
assert(find("情報処理学会").rows.every((r) => r.text.includes("時刻未確認")));
assert(find("情報処理学会").rows.some((r) => r.text.includes("2026-11-27")));
assert(!find("情報処理学会").rows.some((r) => r.text.includes("2026-11-28")));
assert.deepEqual(rowKeys(find("NIPS 2026", "past")), rowKeys(find("NeurIPS 2026", "past")));
assert(find("NIPS 2026", "past").rows.length > 0);
assert.equal(find("ICML 2027").rows.length, 0);
assert(find("ICML 2027", "est").rows.length > 0);
assert(find("ICML 2027").notes.join(" ").includes("推定締切を含める"));
assert(!find("ICML 2027").notes.join(" ").includes("語をすべて含む行はありません"));
assert(!find("NeurIPS 2026").notes.join(" ").includes("会期だけ確定している次回"));
assert(find("EvoMUSART").rows[0].text.includes("時刻未確認"));
assert(find("EvoMUSART 2027").rows.length > 0);
assert(find("SIGMOD 2026年の締切").rows.some((r) => r.text.includes("SIGMOD 2027")));
assert(find("SIGMOD").rows[0].text.includes("2026-10-18(日) 20:59 JST"));
assert(find("SIGMOD").drawer.includes("2026-10-17 23:59 AoE"));
assert(find("ISCAS").rows[0].text.includes("2026-10-14(水) 13:59 JST"));
assert(find("SecureComm").rows[0].text.includes("2027-02-01"));
assert(find("SecureComm").drawer.includes("2027-04-15"));
assert(find("SecureComm").drawer.includes("時刻未確認"));
assert(!find("SecureComm").rows[0].text.includes("2027-03-01"));
await query({ q: "SecureComm", kind: "paper" });
await evaluate("document.querySelector('.row-detail').click()");
await waitFor("document.querySelectorAll('.edition-schedule button').length===2");
for (let n = 0; n < 3; n++)
  for (const date of ["2027-04-15", "2027-02-01"]) {
    await evaluate(
      `[...document.querySelectorAll('.edition-schedule button')].find(x=>x.textContent.includes('${date}')).click()`,
    );
    await waitFor(
      `document.querySelector('.edition-schedule [aria-current=true]')?.textContent.includes('${date}')`,
    );
    assert(
      !(await evaluate("document.querySelector('#drawerBody').children[0].textContent")).includes(
        "JST",
      ),
    );
  }
await evaluate("[...document.querySelectorAll('.edition-schedule button')].at(-1).click()");
await cmd("Page.reload", { ignoreCache: true });
await waitFor(
  "document.querySelector('.edition-schedule [aria-current=true]')?.textContent.includes('2027-04-15')",
);
const detailUrl = await evaluate("location.href");
await evaluate("history.back()");
await waitFor("!document.querySelector('#drawerBackdrop.active')");
assert(await evaluate("document.activeElement.classList.contains('row-detail')"));
assert.equal(await evaluate("document.querySelector('.wrap').inert"), false);
await evaluate("history.forward()");
await waitFor("document.querySelector('#drawerBackdrop.active')");
await evaluate(
  "document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))",
);
await waitFor("!document.querySelector('#drawerBackdrop.active')");
assert(await evaluate("document.activeElement.classList.contains('row-detail')"));
await cmd("Emulation.setDeviceMetricsOverride", {
  width: 390,
  height: 844,
  deviceScaleFactor: 1,
  mobile: true,
});
await query({ q: "SecureComm", kind: "paper" });
await evaluate("document.querySelector('.row-detail').click()");
await waitFor("document.querySelector('#drawerBackdrop.active')");
await new Promise((r) => setTimeout(r, 450));
const mobile = await evaluate(
  `({width:innerWidth,body:document.documentElement.scrollWidth,drawer:document.querySelector('#drawer').getBoundingClientRect().toJSON(),controls:[...document.querySelectorAll('.edition-schedule button')].filter(x=>x.checkVisibility()).map(x=>({height:x.getBoundingClientRect().height,width:x.getBoundingClientRect().width,scroll:x.scrollWidth}))})`,
);
await evaluate(
  "document.querySelector('#drawerClose').focus();document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true,cancelable:true}))",
);
assert(
  await evaluate(
    "document.activeElement===[...document.querySelectorAll('#drawer button:not(:disabled), #drawer a[href], #drawer summary')].at(-1)",
  ),
);
await evaluate(
  "document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}))",
);
assert.equal(await evaluate("document.activeElement.id"), "drawerClose");
assert.equal(mobile.width, 390);
assert(mobile.body <= 390);
assert(mobile.drawer.right <= 390 && mobile.drawer.left >= 0);
assert(mobile.controls.every((x) => x.height >= 44 && x.scroll <= x.width + 2));
await mkdir("work/agent-verification/screenshots", { recursive: true });
const shot = await cmd("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
await writeFile(
  "work/agent-verification/screenshots/compsac-regression-securecomm-date-only-mobile.png",
  Buffer.from(shot.data, "base64"),
);
await cmd("Emulation.setDeviceMetricsOverride", {
  width: 1280,
  height: 1000,
  deviceScaleFactor: 1,
  mobile: false,
});
await query({ q: "情報処理学会", kind: "paper" });
const shot2 = await cmd("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
await writeFile(
  "work/agent-verification/screenshots/compsac-regression-ipsj-japanese-search.png",
  Buffer.from(shot2.data, "base64"),
);
assert.deepEqual(errors, []);
await writeFile(
  "work/agent-verification/headless-researcher.json",
  JSON.stringify(
    {
      headless: true,
      no_native_input: true,
      reduced_motion: reducedMotion,
      fixed_now: "2026-10-03T06:00:00Z",
      cases: results,
      mobile,
      detailUrl,
      errors,
      blocked_external_requests: blockedRequests,
      passed: true,
    },
    null,
    2,
  ) + "\n",
);
await cmd("Fetch.disable");
await cmd("Target.closeTarget", { targetId: target.id });
ws.close();
console.log(
  "PASS researcher search, corrected date-only, year and alias parity, reload/back/forward, six schedule switches, Escape focus, mobile",
);
