import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";

await mkdir("work/agent-verification/screenshots", { recursive: true });
await rm("work/agent-verification/headless-updater.json", { force: true });
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

const oldInputs = JSON.parse(
  await readFile(
    process.env.KAMIYOBI_OLD_LINK_INPUTS ||
      "work/agent-verification/integration/ui-old-link-inputs.json",
    "utf8",
  ),
);
const currentCases = [];
for (const q of ["EvoMUSART", "ECIR", "WSDM"]) {
  await query(q);
  const visible = await evaluate(
    "[...document.querySelectorAll('.row-detail')].map(b=>b.closest('tr').innerText)",
  );
  assert(visible.length > 0, q + " must be searchable");
  await evaluate("document.querySelector('.row-detail').click()");
  await waitFor("document.querySelector('#drawerBackdrop.active')");
  const share = await evaluate("new URLSearchParams(location.search).get('row')");
  const text = await evaluate("document.querySelector('#drawerBody').textContent");
  await cmd("Page.reload", { ignoreCache: true });
  await waitFor("document.querySelector('#drawerBackdrop.active')");
  assert.equal(await evaluate("new URLSearchParams(location.search).get('row')"), share);
  await evaluate("document.querySelector('#drawerClose').click()");
  await waitFor("!document.querySelector('#drawerBackdrop.active')");
  currentCases.push({ q, visible, share, detail: text, reload: true });
}
const compatibility = [];
for (const input of oldInputs) {
  const oldKey = `${input.key}|${input.year}|${input.kind}|${Math.trunc(Date.parse(input.utc || input.earliest_utc))}`;
  await query(input.key.startsWith("evomusart") ? "EvoMUSART" : input.key.toUpperCase(), {
    row: oldKey,
    kind: input.kind,
  });
  await new Promise((resolve) => setTimeout(resolve, 350));
  compatibility.push({
    input,
    oldKey,
    ...(await evaluate(
      `({opened:Boolean(document.querySelector('#drawerBackdrop.active')), choices:[...document.querySelectorAll('.shared-row-choice')].map(b=>b.textContent), notice:document.querySelector('#countLive')?.textContent || document.querySelector('#count')?.textContent, detail:document.querySelector('#drawerBody')?.textContent})`,
    )),
  });
}
const evoOldLinks = compatibility.filter(({ input }) => input.key === "evomusart");
assert.equal(evoOldLinks.length, 2, "both pre-integration EvoMUSART links must be tested");
for (const result of evoOldLinks) {
  if (result.input.kind === "abstract") {
    assert(result.opened, `${result.oldKey}: alias must open the unchanged date-only deadline`);
    assert.equal(result.choices.length, 0);
  } else {
    assert(!result.opened, "a corrected old instant must not silently open a different date");
    assert.equal(result.choices.length, 1);
    assert(result.notice.includes("日時に一致"));
    assert(result.choices[0].includes("2026-11-01") && result.choices[0].includes("時刻未確認"));
    await query("EvoMUSART", { row: result.oldKey, kind: "paper" });
    await waitFor("document.querySelector('.shared-row-choice')");
    await cmd("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await evaluate("document.querySelector('#sharedRowChoices').scrollIntoView({block:'center'})");
    const choiceSize = await evaluate(
      "({width:document.documentElement.scrollWidth, viewport:innerWidth, height:document.querySelector('.shared-row-choice').getBoundingClientRect().height})",
    );
    assert(choiceSize.width <= choiceSize.viewport + 1 && choiceSize.height >= 44);
    const correctionShot = await cmd("Page.captureScreenshot", { format: "png" });
    await writeFile(
      "work/agent-verification/screenshots/integration-corrected-link-mobile.png",
      Buffer.from(correctionShot.data, "base64"),
    );
    await evaluate("document.querySelector('.shared-row-choice').click()");
    await waitFor("document.querySelector('#drawerBackdrop.active')");
    const detail = await evaluate("document.querySelector('#drawerBody').textContent");
    assert(
      (await evaluate("document.querySelector('#drawerTitle').textContent")).includes("EvoMUSART"),
    );
    assert(detail.includes("2026-11-01") && detail.includes("時刻未確認"));
    const correctedShare = await evaluate("new URLSearchParams(location.search).get('row')");
    assert(correctedShare.startsWith("evomusart-2027|2027|paper|"));
    await cmd("Page.reload", { ignoreCache: true });
    await waitFor("document.querySelector('#drawerBackdrop.active')");
    assert.equal(await evaluate("new URLSearchParams(location.search).get('row')"), correctedShare);
    result.selectedCurrentDate = true;
    result.correctedShare = correctedShare;
    result.reload = true;
  }
}
await query("EvoMUSART", { kind: "abstract" });
await cmd("Emulation.setDeviceMetricsOverride", {
  width: 390,
  height: 844,
  deviceScaleFactor: 1,
  mobile: true,
});
await evaluate("document.querySelector('.row-detail').click()");
await waitFor("document.querySelector('#drawerBackdrop.active')");
await new Promise((resolve) => setTimeout(resolve, 400));
const mobile = await evaluate(
  "({overflow:document.documentElement.scrollWidth>innerWidth, detail:document.querySelector('#drawerBody').textContent})",
);
assert(!mobile.overflow);
assert(mobile.detail.includes("2026-11-01"));
assert(mobile.detail.includes("時刻未確認"));
await cmd("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }).then(
  (result) =>
    writeFile(
      "work/agent-verification/screenshots/integration-evomusart-mobile.png",
      Buffer.from(result.data, "base64"),
    ),
);
assert.equal(errors.length, 0, JSON.stringify(errors));
await writeFile(
  "work/agent-verification/headless-updater.json",
  JSON.stringify(
    { currentCases, compatibility, mobile, reducedMotion, errors, blockedRequests },
    null,
    2,
  ) + "\n",
);
await cmd("Fetch.disable");
await cmd("Target.closeTarget", { targetId: target.id });
ws.close();
console.log(
  "PASS: current updater calls searchable, precise URL reload, date-only abstract and mobile; old-link compatibility recorded separately",
);
