// Record the Unrush demo: headless Chrome at 1920x1080 driven over the DevTools protocol
// (Node's built-in WebSocket, no packages). Frames come from Page.startScreencast; narration
// and Unrush's real replies are voiced with macOS `say`. Writes out/timeline.json for assemble.mjs.
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIR = new URL(".", import.meta.url).pathname;
const OUT = join(DIR, "out");
const APP = process.env.APP_URL ?? "http://localhost:5173/";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const NARRATOR = { voice: "Daniel", rate: 194 };
const UNRUSH = { voice: "Samantha", rate: 202 };

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, "frames"), { recursive: true });
mkdirSync(join(OUT, "audio"), { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now() / 1000;
const timeline = { frames: [], audio: [], waits: [], start: 0, end: 0 };

// ---------- Chrome + CDP ----------
const profile = join(DIR, "chrome-profile");
rmSync(profile, { recursive: true, force: true });
const chrome = spawn(CHROME, [
  "--headless=new", "--remote-debugging-port=9333", `--user-data-dir=${profile}`, "--window-size=1920,1080",
  "--hide-scrollbars", "--mute-audio", "--no-first-run", "--no-default-browser-check", "--force-color-profile=srgb", "about:blank",
], { stdio: "ignore" });
process.on("exit", () => chrome.kill());

let targets;
for (let i = 0; i < 50; i++) {
  try { targets = await (await fetch("http://127.0.0.1:9333/json/list")).json(); if (targets.some((t) => t.type === "page")) break; } catch {}
  await sleep(200);
}
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let seq = 0;
const pending = new Map();
const listeners = new Map();
ws.addEventListener("message", (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  } else if (msg.method) for (const fn of listeners.get(msg.method) ?? []) fn(msg.params);
});
const cdp = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
const on = (method, fn) => listeners.set(method, [...(listeners.get(method) ?? []), fn]);
const evaluate = async (expression) => {
  const r = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};

let frameNo = 0;
on("Page.screencastFrame", (p) => {
  const file = join(OUT, "frames", `${String(frameNo++).padStart(6, "0")}.jpg`);
  writeFileSync(file, Buffer.from(p.data, "base64"));
  timeline.frames.push({ file, t: p.metadata.timestamp });
  void cdp("Page.screencastFrameAck", { sessionId: p.sessionId });
});

await cdp("Page.enable");
await cdp("Runtime.enable");
await cdp("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
// Chrome keeps a screencast running across navigations; (re)start it only when it isn't.
const screencast = () =>
  cdp("Page.startScreencast", { format: "jpeg", quality: 88, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 }).catch((e) => {
    if (!/already active/i.test(e.message)) throw e;
  });

async function go(url) {
  const loaded = new Promise((r) => on("Page.loadEventFired", r));
  await cdp("Page.navigate", { url });
  await loaded;
  await screencast();
  await inject();
}
async function waitFor(expr, timeoutMs = 90_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await evaluate(expr).catch(() => false)) return;
    await sleep(200);
  }
  throw new Error(`Timed out waiting for: ${expr}`);
}

// ---------- overlay: cursor, click ripple, spotlight, subtitles ----------
const OVERLAY = `(() => {
  if (window.__demo) return;
  const css = document.createElement('style');
  css.textContent = \`
    #demo-cursor { position: fixed; left: 1500px; top: 640px; width: 30px; height: 30px; z-index: 99999; pointer-events: none;
      transition: left .75s cubic-bezier(.3,.8,.3,1), top .75s cubic-bezier(.3,.8,.3,1); filter: drop-shadow(0 3px 6px rgba(0,0,0,.35)); }
    .demo-ripple { position: fixed; width: 18px; height: 18px; margin: -9px 0 0 -9px; border-radius: 50%; border: 3px solid #f59e0b; z-index: 99998;
      pointer-events: none; animation: demo-rip .6s ease-out forwards; }
    @keyframes demo-rip { from { transform: scale(.4); opacity: 1 } to { transform: scale(3.2); opacity: 0 } }
    .demo-spot { outline: 4px solid #f59e0b !important; outline-offset: 6px; border-radius: 16px; transition: outline-color .3s;
      box-shadow: 0 0 0 9999px rgba(10, 14, 26, .38), 0 0 40px rgba(245, 158, 11, .55) !important; position: relative; z-index: 50; }
    #demo-cap { position: fixed; left: 50%; bottom: 34px; transform: translateX(-50%) translateY(14px); max-width: 1380px; z-index: 99997;
      padding: 16px 28px; border-radius: 18px; background: rgba(12, 16, 30, .9); color: #fff; font: 600 27px/1.38 Inter, system-ui, sans-serif;
      text-align: center; opacity: 0; transition: opacity .35s, transform .35s; box-shadow: 0 16px 40px rgba(0,0,0,.35); pointer-events: none; }
    #demo-cap.on { opacity: 1; transform: translateX(-50%); }
    #demo-cap b { display: block; font-size: 16px; letter-spacing: .12em; text-transform: uppercase; margin-bottom: 4px; }
    #demo-cap.narrator b { color: #a5b4fc; } #demo-cap.unrush b { color: #5eead4; }
  \`;
  document.head.appendChild(css);
  const cur = document.createElement('div');
  cur.id = 'demo-cursor';
  cur.innerHTML = '<svg viewBox="0 0 24 24" width="30" height="30"><path d="M4 2l15 11-7 1.2L8.6 21z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  document.body.appendChild(cur);
  if (location.protocol === 'file:') cur.style.display = 'none'; // title and outro cards
  const cap = document.createElement('div');
  cap.id = 'demo-cap';
  document.body.appendChild(cap);
  const find = (q) => typeof q === 'string' && q.startsWith('text=')
    ? [...document.querySelectorAll('button, a')].find((b) => b.textContent.includes(q.slice(5)) && b.offsetParent)
    : document.querySelector(q);
  window.__demo = {
    move(q) { const el = find(q); if (!el) return false; const r = el.getBoundingClientRect();
      cur.style.left = (r.left + Math.min(r.width / 2, 60)) + 'px'; cur.style.top = (r.top + r.height / 2) + 'px'; return true; },
    click(q) { const el = find(q); if (!el) return false; const r = el.getBoundingClientRect();
      const d = document.createElement('div'); d.className = 'demo-ripple';
      d.style.left = (r.left + Math.min(r.width / 2, 60)) + 'px'; d.style.top = (r.top + r.height / 2) + 'px';
      document.body.appendChild(d); setTimeout(() => d.remove(), 700); el.click(); return true; },
    spot(q) { document.querySelectorAll('.demo-spot').forEach((e) => e.classList.remove('demo-spot')); const el = q && find(q); if (el) el.classList.add('demo-spot'); return !!el; },
    say(who, text) { cap.className = who; cap.innerHTML = '<b>' + (who === 'unrush' ? 'Unrush' : 'Narrator') + '</b>' + text; requestAnimationFrame(() => cap.classList.add('on')); },
    quiet() { cap.classList.remove('on'); },
  };
})()`;
const demo = (call) => evaluate(`window.__demo.${call}`);
const inject = () => evaluate(OVERLAY);

// ---------- voice ----------
let clip = 0;
function voice(text, { voice, rate }) {
  const file = join(OUT, "audio", `${String(clip++).padStart(2, "0")}-${voice}.aiff`);
  execFileSync("say", ["-v", voice, "-r", String(rate), "-o", file, text]);
  const dur = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString().trim());
  return { file, dur };
}
/** Speak a line (narrator or Unrush) with a subtitle; returns when it's done. */
async function speak(who, text, { caption = text, after = 350 } = {}) {
  const v = voice(text, who === "unrush" ? UNRUSH : NARRATOR);
  if (caption) await demo(`say(${JSON.stringify(who)}, ${JSON.stringify(caption)})`);
  timeline.audio.push({ file: v.file, t: now() });
  await sleep(v.dur * 1000 + after);
  await demo("quiet()");
  await sleep(250);
}
const narrate = (text, opts) => speak("narrator", text, opts);
async function click(q) {
  await demo(`move(${JSON.stringify(q)})`);
  await sleep(850);
  if (!(await demo(`click(${JSON.stringify(q)})`))) throw new Error(`Nothing to click: ${q}`);
  await sleep(250);
}
/** A model turn: everything until `done` becomes true is cut from the video except its first second. */
async function modelTurn(done) {
  const start = now();
  await waitFor(done);
  timeline.waits.push({ start, end: now() });
  await sleep(500);
}
const assistantCount = () => evaluate(`document.querySelectorAll('.voice .bubble.assistant:not(.intro)').length`);
const lastReply = () => evaluate(`[...document.querySelectorAll('.voice .bubble.assistant:not(.intro)')].at(-1)?.textContent ?? ''`);
const idle = `!document.querySelector('.bubble.typing') && !document.body.textContent.includes('Unrush is working')`;
/** Speak text the way Unrush reads it: drop "(8 oz)"-style asides and price lists in parentheses. */
const spoken = (t) => t.replace(/\s*\(\$[\d.]+\)/g, "").replace(/\s+/g, " ").trim();

// ---------- reset (not recorded) ----------
await go(APP);
await evaluate(`localStorage.setItem('unrush.theme', 'light'); true`);
await go(APP);
await waitFor(`!!document.querySelector('.guide')`);
await evaluate(`fetch('/api/demo/reset', { method: 'POST' }).then((r) => r.ok)`);
await go(APP);
await waitFor(`document.body.textContent.includes('Make the meeting run late')`);
await sleep(800);
await cdp("Page.stopScreencast");
timeline.frames.length = 0;
rmSync(join(OUT, "frames"), { recursive: true, force: true });
mkdirSync(join(OUT, "frames"), { recursive: true });

// ---------- the film ----------
timeline.start = now();
await go(`file://${join(DIR, "cards", "title.html")}`);
await sleep(1200);
await narrate("This is Unrush: a household assistant that speaks first, before your evening falls apart.", { caption: "" });
await sleep(400);

await go(APP);
await inject();
await waitFor(`document.body.textContent.includes('Make the meeting run late')`);
await sleep(700);
await demo(`spot('.timeline-card')`);
await narrate("It's three in the afternoon. Maya has a project call at five thirty, a study group across town at seven thirty, and a forty five minute curry planned for dinner.");
await demo(`spot(null)`);
let n = await assistantCount();
await click("text=Make the meeting run late");
await narrate("Then her call gets pushed. It now runs until seven.", { after: 100 });
await modelTurn(`document.querySelectorAll('.voice .bubble.assistant:not(.intro)').length > ${n} && !!document.querySelector('.banner') && ${idle}`);
await demo(`spot('.banner')`);
await speak("unrush", spoken(await lastReply()));
await demo(`spot('.activity')`);
await narrate("Nobody asked. Unrush noticed the conflict, worked out when to leave, and found a dinner that fits, using tools on its own M C P server.", {
  caption: "Nobody asked. Unrush noticed the conflict, worked out when to leave and found a dinner that fits, using tools on its own MCP server.",
});
await demo(`spot(null)`);

n = await assistantCount();
await click("text=Yes please");
await modelTurn(`document.querySelectorAll('.voice .bubble.assistant:not(.intro)').length > ${n} && ${idle}`);
await demo(`spot('.voice')`);
await speak("unrush", spoken(await lastReply()));
await demo(`spot('.cards')`);
await narrate("It saved the swap, then checked the kitchen. Eggs are out, and milk runs out tomorrow, predicted from six weeks of purchases. It picked Maya's usual products, and only asks about the one it doesn't know.", {
  caption: "It saved the swap and checked the kitchen: eggs are out, milk runs out tomorrow (predicted from 6 weeks of purchases). Usual products picked; it asks only about the new one.",
});
await demo(`spot(null)`);

n = await assistantCount();
await click("text=Amazon Grocery Basil Pesto");
await modelTurn(`document.querySelectorAll('.voice .bubble.assistant:not(.intro)').length > ${n} && ${idle}`);
await speak("unrush", spoken(await lastReply()));
await demo(`spot('.guide')`);
await narrate("Nothing is bought without an explicit yes. The tool refuses unless confirmed is true, and the backend checks that she really said yes.");
await demo(`spot(null)`);

n = await assistantCount();
await click("text=Yes, place the order");
await modelTurn(`document.querySelectorAll('.voice .bubble.assistant:not(.intro)').length > ${n} && ${idle} && !!document.querySelector('.cart-links')`);
await speak("unrush", spoken(await lastReply()));
await evaluate(`(() => { const c = document.querySelector('.cards'), el = document.querySelector('.cart-links');
  c.scrollBy({ top: el.getBoundingClientRect().top - c.getBoundingClientRect().top - 260, behavior: 'smooth' }); return true; })()`);
await sleep(900);
await demo(`spot('.cart-links')`);
await narrate("The checkout is simulated, but every product links to its real Amazon page, so she adds it to her cart herself. Unrush never sees card details.");
await demo(`spot('.activity')`);
await narrate("Every step you saw is a real Amazon Bedrock Converse call, driving tools on a self-hosted M C P server, spec twenty twenty five, eleven twenty five, over Streamable H T T P.", {
  caption: "Every step is a real Amazon Bedrock Converse call driving tools on a self-hosted MCP server: spec 2025-11-25 over Streamable HTTP.",
});
await demo(`spot(null)`);

await click("text=MCP Apps");
await sleep(2200);
await demo(`spot('.cards')`);
await narrate("The same cards also ship from the server as M C P Apps, so any M C P Apps host can render them.", { caption: "The same cards also ship from the server as MCP Apps, so any MCP Apps host can render them." });
await demo(`spot(null)`);

await cdp("Page.reload");
await sleep(400);
await screencast();
await waitFor(`!!document.querySelector('.guide') && document.body.textContent.includes('Welcome back')`);
await inject();
await sleep(600);
await demo(`spot('.voice .bubble.assistant:not(.intro)')`);
await narrate("Reload the page, or restart the server, and Unrush still remembers. Household state lives in the M C P server, and the conversation in Amazon Bedrock AgentCore Memory.", {
  caption: "Reload, or restart the server: Unrush still remembers. State lives in the MCP server; the conversation in Amazon Bedrock AgentCore Memory.",
});
await demo(`spot(null)`);

await go(`file://${join(DIR, "cards", "outro.html")}`);
await sleep(1500);
await narrate("Unrush. It speaks first, so your evening doesn't fall apart.", { caption: "" });
await sleep(2500);
timeline.end = now();
await cdp("Page.stopScreencast");

writeFileSync(join(OUT, "timeline.json"), JSON.stringify(timeline, null, 2));
console.log(`frames=${timeline.frames.length} audio=${timeline.audio.length} waits=${timeline.waits.length} raw=${(timeline.end - timeline.start).toFixed(1)}s`);
ws.close();
chrome.kill();
process.exit(0);
