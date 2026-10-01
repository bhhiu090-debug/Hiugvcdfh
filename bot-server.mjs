const TOKEN = (process.env.BOT_TOKEN || "").trim();
if (!TOKEN) throw new Error("Set env BOT_TOKEN");
const API = "https://api.telegram.org/bot" + TOKEN + "/";
import fs from "node:fs";
import http from "node:http";
const OFFSET_FILE = process.env.OFFSET_FILE || "./offset.txt";
const DATA_FILE = process.env.DATA_FILE || "./bot-data.json";
let S = { chats: {}, msgs: {}, pins: {}, tnames: {} };
try { S = Object.assign(S, JSON.parse(fs.readFileSync(DATA_FILE, "utf8"))); } catch (e) {}
let saveT = null;
function saveData() { clearTimeout(saveT); saveT = setTimeout(() => { try { fs.writeFileSync(DATA_FILE, JSON.stringify(S)); } catch (e) {} }, 500); }
function sChat(cid, nm, t) {
  const k = String(cid);
  if (!S.chats[k]) S.chats[k] = { n: nm || k, t: t || "", last: 0, un: 0 };
  if (nm) S.chats[k].n = nm;
  if (t) S.chats[k].t = t;
  S.chats[k].last = Date.now();
}
function sMsg(cid, d, f, x, mid, tid) {
  const k = String(cid);
  if (!S.msgs[k]) S.msgs[k] = [];
  S.msgs[k].push({ d, f, x: String(x || "").slice(0, 2000), ts: Date.now(), mid: mid || 0, tid: (tid === undefined || tid === null) ? null : tid });
  while (S.msgs[k].length > 200) S.msgs[k].shift();
  saveData();
}
const SYSTEM = process.env.AI_SYSTEM || "Ты Cube ai, тебя создали ребята из республики Конго. Отвечай дружелюбно и коротко на русском. На вопрос кто ты отвечай только Cube ai от ребят из республики Конго.";
const ADMINS = String(process.env.ADMINS || "pinkoski,kit_cat5").toLowerCase().split(",").map(s => s.trim().replace(/^@/, "")).filter(Boolean);
const MODEL = process.env.AI_MODEL || "openai";
const BRIDGE_WAIT = Number(process.env.BRIDGE_WAIT || 3000);
const ALLOW_NSFW = String(process.env.ALLOW_NSFW || "0") === "1";
const SD_API = (process.env.SD_API || "").replace(/\/+$/, "");
const aiJobs = new Map();
let aiJobSeq = 1;
function bridgeAsk(type, prompt) {
  const id = "j" + (aiJobSeq++) + Date.now().toString(36);
  const job = { id, type, prompt: String(prompt).slice(0, 8000), created: Date.now(), done: false, ok: false, text: "" };
  aiJobs.set(id, job);
  for (const [k, v] of aiJobs) if (Date.now() - v.created > 180000) aiJobs.delete(k);
  return job;
}
let botId = 0;
let offset = 0;
try { offset = Number(fs.readFileSync(OFFSET_FILE, "utf8").trim()) || 0; } catch (e) {}
function saveOffset() { try { fs.writeFileSync(OFFSET_FILE, String(offset)); } catch (e) {} }
http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") { res.writeHead(200); res.end(); return; }
  let u = null;
  try { u = new URL(req.url, "http://x"); } catch (e) {}
  if (u && u.pathname === "/api/state") {
    if (u.searchParams.get("key") !== TOKEN) { res.writeHead(403); res.end("forbidden"); return; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ chats: S.chats, msgs: S.msgs, pins: S.pins, tnames: S.tnames, at: Date.now() }));
    return;
  }
  if (u && (u.pathname === "/api/send" || u.pathname === "/api/prefs") && req.method === "POST") {
    let b = "";
    req.on("data", (c) => { b += c; if (b.length > 200000) req.destroy(); });
    req.on("end", async () => {
      try {
        const j = JSON.parse(b || "{}");
        if (j.key !== TOKEN) { res.writeHead(403); res.end("forbidden"); return; }
        if (u.pathname === "/api/prefs") {
          Object.assign(S.pins, j.pins || {});
          Object.assign(S.tnames, j.tnames || {});
          saveData();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        const m = await sendText(j.chat_id, String(j.text || "").slice(0, 4000), j.reply_to || null, j.thread_id || null);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, id: m.message_id }));
      } catch (e) { res.writeHead(500); res.end("err:" + e.message); }
    });
    return;
  }
  if (u && u.pathname === "/api/ai-jobs") {
    if (u.searchParams.get("key") !== TOKEN) { res.writeHead(403); res.end("forbidden"); return; }
    const out = [];
    for (const j of aiJobs.values()) if (!j.done && Date.now() - j.created < 120000) out.push({ id: j.id, type: j.type, prompt: j.prompt });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jobs: out }));
    return;
  }
  if (u && u.pathname === "/api/ai-result" && req.method === "POST") {
    let b = "";
    req.on("data", (c) => { b += c; if (b.length > 3000000) req.destroy(); });
    req.on("end", () => {
      try {
        const j = JSON.parse(b || "{}");
        if (j.key !== TOKEN) { res.writeHead(403); res.end("forbidden"); return; }
        const job = aiJobs.get(j.id);
        if (!job) { res.writeHead(404); res.end("no job"); return; }
        job.done = true; job.ok = !!j.ok; job.text = String(j.text || "").slice(0, 2000000);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) { res.writeHead(500); res.end("err:" + e.message); }
    });
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("ok");
}).listen(process.env.PORT || 3000);
const lastBotMsg = new Map();
const stopFlags = new Map();
const MAX_PAR = 20;
let activeCount = 0;
const waiters = [];
const chatCtls = new Map();
function trackCtl(chatId, ctl) {
  const k = String(chatId);
  if (!chatCtls.has(k)) chatCtls.set(k, new Set());
  chatCtls.get(k).add(ctl);
}
function untrackCtl(chatId, ctl) {
  const st = chatCtls.get(String(chatId));
  if (st) { st.delete(ctl); if (!st.size) chatCtls.delete(String(chatId)); }
}
let jobTimes = [];
const DEF_SEC = 45;
function avgSec() { if (!jobTimes.length) return DEF_SEC; return Math.max(5, Math.round(jobTimes.reduce((a, b) => a + b, 0) / jobTimes.length)); }
function fmtWait(s) { s = Math.max(1, Math.round(s)); if (s < 60) return "≈" + s + " сек"; const m = Math.floor(s / 60); const r = s % 60; return "≈" + m + " мин" + (r ? " " + r + " сек" : ""); }
async function sendQueueNotice(e, ahead) {
  const pos = ahead + 1;
  const txt = "⏳ ИИ занят, вы в очереди №" + pos + "\n👥 Перед вами ещё: " + ahead + "\n⏱ Примерное ожидание: " + fmtWait(Math.ceil(pos / MAX_PAR) * avgSec()) + (e.admin ? "\n⭐ Админ-приоритет: вы первые." : "");
  try {
    const body = { chat_id: e.chatId, text: txt };
    if (e.tid) body.message_thread_id = e.tid;
    const m = await tg("sendMessage", body);
    e.notice = m.message_id;
  } catch (err) {}
}
function runLimited(job, m) {
  const chatId = m ? m.chat.id : 0;
  const tid = m && m.message_thread_id && Number(m.message_thread_id) > 0 ? Number(m.message_thread_id) : null;
  const e = { run: null, admin: !!(m && isAdmin(m.from)), chatId, tid, notice: 0 };
  e.run = () => {
    activeCount++;
    if (e.notice) { try { tg("deleteMessage", { chat_id: e.chatId, message_id: e.notice }).catch(() => {}); } catch (err) {} }
    const t0 = Date.now();
    Promise.resolve().then(job).catch((err) => console.error(err.message)).finally(() => { try { jobTimes.push((Date.now() - t0) / 1000); while (jobTimes.length > 20) jobTimes.shift(); } catch (err2) {} activeCount--; const w = waiters.shift(); if (w) w.run(); });
  };
  if (e.admin) { const i = waiters.findIndex((x) => !x.admin); if (i < 0) waiters.unshift(e); else waiters.splice(i, 0, e); }
  else waiters.push(e);
  const ahead = activeCount + waiters.indexOf(e);
  if (activeCount >= MAX_PAR) sendQueueNotice(e, ahead);
  if (activeCount < MAX_PAR) { const w = waiters.shift(); if (w) w.run(); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function isAdmin(from) {
  const u = String((from && from.username) || "").toLowerCase().replace(/^@/, "");
  return u && ADMINS.includes(u);
}
function userTag(from) {
  if (!from) return "anon";
  return from.username ? "@" + from.username : (from.first_name || "user");
}
function cmdName(t) {
  const s = String(t || "").trim();
  const m = s.match(/^\/(ask|code|img|voice|stop)(@\S+)?\s*/i);
  if (!m) return null;
  return { name: m[1].toLowerCase(), arg: s.slice(m[0].length).trim() };
}
function isReplyToBot(m) {
  const r = m && m.reply_to_message && m.reply_to_message.from;
  if (!r) return false;
  if (botId && r.id === botId) return true;
  return !!r.is_bot;
}
const BAD = ["porn", "porno", "hentai", "xxx", "sex ", "ahegao", "onlyfans", "порно", "порн", "хентай", "эротик", "голые", "голый", "сиськи", "интим", "расчлен", "кишки", "каннибал", "трупы", "жесть", "gore", "cheat", "чит", "аим", "aimbot", "wallhack", "вх ", "esp cheat", "exploit", "эксплоит", "обход античит", "обход бана", "взлом", "стилер", "кейлоггер", "ботнет", "ddos"];
function hardBlocked(q) {
  if (ALLOW_NSFW) return false;
  const s = " " + String(q || "").toLowerCase() + " ";
  for (const b of BAD) if (b.length > 2 && s.includes(b)) return true;
  return false;
}
async function tg(method, body, form) {
  const r = await fetch(API + method, form ? { method: "POST", body: form } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  const j = await r.json();
  if (!j.ok) throw new Error(j.description || ("Telegram " + method));
  return j.result;
}
async function fileUrl(fileId) {
  const f = await tg("getFile", { file_id: fileId });
  return "https://api.telegram.org/file/bot" + TOKEN + "/" + f.file_path;
}
function rememberBot(chatId, msgId) {
  const k = String(chatId);
  if (!lastBotMsg.has(k)) lastBotMsg.set(k, []);
  const a = lastBotMsg.get(k);
  a.push(msgId);
  while (a.length > 20) a.shift();
}
async function sendText(chatId, text, replyTo, tid) {
  const body = { chat_id: chatId, text: String(text).slice(0, 4000) };
  if (replyTo) body.reply_to_message_id = replyTo;
  if (tid) body.message_thread_id = tid;
  const m = await tg("sendMessage", body);
  sMsg(chatId, "out", "я", body.text, m.message_id, tid);
  rememberBot(chatId, m.message_id);
  return m;
}
async function sendPhotoBuf(chatId, buf, cap, replyTo, tid) {
  const fd = new FormData();
  fd.append("chat_id", String(chatId));
  if (tid) fd.append("message_thread_id", String(tid));
  if (replyTo) fd.append("reply_to_message_id", String(replyTo));
  fd.append("photo", new Blob([buf], { type: "image/jpeg" }), "img.jpg");
  if (cap) fd.append("caption", String(cap).slice(0, 900));
  const m = await tg("sendPhoto", null, fd);
  try { sMsg(chatId, "out", "я", (fd.get("caption") || "[фото]"), m.message_id, tid); } catch (e) {}
  rememberBot(chatId, m.message_id);
  return m;
}
async function sendDocText(chatId, filename, text, cap, replyTo, tid) {
  const fd = new FormData();
  fd.append("chat_id", String(chatId));
  if (tid) fd.append("message_thread_id", String(tid));
  if (replyTo) fd.append("reply_to_message_id", String(replyTo));
  fd.append("document", new Blob([text], { type: "text/plain" }), filename);
  if (cap) fd.append("caption", String(cap).slice(0, 900));
  const m = await tg("sendDocument", null, fd);
  try { sMsg(chatId, "out", "я", (fd.get("caption") || "[файл]"), m.message_id, tid); } catch (e) {}
  rememberBot(chatId, m.message_id);
  return m;
}
async function sendVoiceBuf(chatId, buf, cap, replyTo, tid) {
  const fd = new FormData();
  fd.append("chat_id", String(chatId));
  if (tid) fd.append("message_thread_id", String(tid));
  if (replyTo) fd.append("reply_to_message_id", String(replyTo));
  fd.append("voice", new Blob([buf], { type: "audio/mpeg" }), "voice.mp3");
  if (cap) fd.append("caption", String(cap).slice(0, 200));
  const m = await tg("sendVoice", null, fd);
  try { sMsg(chatId, "out", "я", (fd.get("caption") || "[голос]"), m.message_id, tid); } catch (e) {}
  rememberBot(chatId, m.message_id);
  return m;
}
function withTimeout(p, ms, what) {
  let t = null;
  const to = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(what + " timeout")), ms); });
  return Promise.race([p, to]).finally(() => clearTimeout(t));
}
async function bridgeWait(job, signal) {
  const t0 = Date.now();
  while (Date.now() - t0 < BRIDGE_WAIT) {
    if (job.done && job.ok && job.text) return job.text;
    if (signal && signal.aborted) throw new Error("stopped");
    await sleep(1000);
  }
  return null;
}
async function aiFetch(messages, signal) {
  try {
    const lastM = messages[messages.length - 1];
    const flat = typeof lastM.content === "string" ? lastM.content : ((lastM.content || []).map((p) => p.text || "").join("\n"));
    const full = messages[0].content + "\n" + flat;
    const job = bridgeAsk("text", full);
    const r = await bridgeWait(job, signal);
    if (r) { aiJobs.delete(job.id); return String(r).slice(0, 4000); }
    aiJobs.delete(job.id);
  } catch (e) { if (signal && signal.aborted) throw e; }
  const chain = [...new Set([MODEL, "openai-fast", "llama", "openai"])];
  let last = null;
  for (const m of chain) {
    for (let a = 0; a < 2; a++) {
      try {
        const r = await withTimeout(fetch("https://text.pollinations.ai/openai", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: m, messages }),
          signal
        }), 60000, "AI");
        if (r.ok) {
          const j = await r.json();
          const t = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
          if (t) return String(t);
          last = new Error("AI empty (" + m + ")");
        } else last = new Error("AI " + r.status + " (" + m + ")");
      } catch (e) { last = e; if (signal && signal.aborted) throw e; }
      await sleep(1500);
    }
  }
  throw last || new Error("AI fail");
}
async function aiText(prompt, signal) {
  return aiFetch([{ role: "system", content: SYSTEM }, { role: "user", content: prompt }], signal);
}
async function aiVision(prompt, imageUrl, signal) {
  return aiFetch([{ role: "system", content: SYSTEM }, { role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: imageUrl } }] }], signal);
}
async function aiImage(prompt, signal) {
  if (SD_API) {
    const r = await withTimeout(fetch(SD_API + "/sdapi/v1/txt2img", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: prompt.slice(0, 1000), negative_prompt: ALLOW_NSFW ? "" : "nsfw, nude", steps: 28, width: 768, height: 768 }),
      signal
    }), 300000, "IMG");
    if (!r.ok) throw new Error("IMG " + r.status);
    const j = await r.json();
    const b64 = j.images && j.images[0];
    if (!b64) throw new Error("IMG empty");
    return Buffer.from(b64, "base64");
  }
  try {
    const job = bridgeAsk("image", prompt);
    const r = await bridgeWait(job, signal);
    if (r && r.startsWith("data:")) {
      aiJobs.delete(job.id);
      const b64 = r.split(",")[1] || "";
      const buf = Buffer.from(b64, "base64");
      if (buf.length > 1000) return buf;
    } else aiJobs.delete(job.id);
  } catch (e) { if (signal && signal.aborted) throw e; }
  const url = "https://image.pollinations.ai/prompt/" + encodeURIComponent("highly detailed, sharp, " + prompt) + "?width=768&height=768&nologo=true&model=flux&enhance=true";
  const r = await withTimeout(fetch(url, { signal }), 120000, "IMG");
  if (!r.ok) throw new Error("IMG " + r.status);
  const b = await r.arrayBuffer();
  if (!b.byteLength) throw new Error("IMG empty");
  return Buffer.from(b);
}
function splitVoice(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim().slice(0, 1000);
  const parts = [];
  let cur = "";
  for (const w of clean.split(" ")) {
    if ((cur + " " + w).trim().length > 180) { if (cur) parts.push(cur.trim()); cur = w; }
    else cur = (cur + " " + w).trim();
  }
  if (cur) parts.push(cur.trim());
  return parts.slice(0, 6);
}
async function ttsChunk(chunk) {
  const url = "https://translate.google.com/translate_tts?ie=UTF-8&tl=ru&client=tw-ob&q=" + encodeURIComponent(chunk);
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!r.ok) throw new Error("tts " + r.status);
  const b = await r.arrayBuffer();
  if (!b.byteLength) throw new Error("tts empty");
  return Buffer.from(b);
}
function keepAction(chatId, action, tid, signal) {
  let stop = false;
  (async () => {
    while (!stop && !(signal && signal.aborted)) {
      try { await tg("sendChatAction", { chat_id: chatId, action, message_thread_id: tid || undefined }); } catch (e) {}
      await sleep(4000);
    }
  })();
  return () => { stop = true; };
}
async function doStop(chatId, tid, replyTo) {
  const k = String(chatId);
  if (stopFlags.get(k)) return;
  stopFlags.set(k, true);
  const st = chatCtls.get(k);
  const wasActive = !!(st && st.size);
  if (st) for (const c of [...st]) { try { c.abort(); } catch (e) {} }
  for (let i = waiters.length - 1; i >= 0; i--) { if (String(waiters[i].chatId) === k) waiters.splice(i, 1); }
  if (!wasActive) await sendText(chatId, "⏹ Остановлено.", replyTo, tid);
  setTimeout(() => stopFlags.delete(k), 5000);
}
function stopped(chatId) { return stopFlags.get(String(chatId)); }
async function doAsk(chatId, q, tid, msg) {
  const ut = userTag(msg && msg.from);
  const mid = msg && msg.message_id;
  if (!q) { await sendText(chatId, ut + ", напиши так: /ask твой вопрос", mid, tid); return; }
  if (!isAdmin(msg && msg.from) && hardBlocked(q)) { await sendText(chatId, ut + ", такое нельзя.", mid, tid); return; }
  const ctl = new AbortController();
  trackCtl(chatId, ctl);
  const stopAct = keepAction(chatId, "typing", tid, ctl.signal);
  try {
    const ans = await aiText(ut + " спрашивает: " + q, ctl.signal);
    if (stopped(chatId)) return;
    await sendText(chatId, ut + ", " + String(ans).slice(0, 3800), mid, tid);
  } catch (e) {
    if (stopped(chatId) || (ctl.signal && ctl.signal.aborted)) { try { await sendText(chatId, "⏹ Остановлено.", mid, tid); } catch (e2) {} }
    else try { await sendText(chatId, "Ошибка: " + e.message, mid, tid); } catch (e2) {}
  }
  stopAct();
  untrackCtl(chatId, ctl);
}
async function doCode(chatId, q, tid, msg) {
  const ut = userTag(msg && msg.from);
  const mid = msg && msg.message_id;
  if (!q) { await sendText(chatId, ut + ", напиши так: /code задача", mid, tid); return; }
  if (!isAdmin(msg && msg.from) && hardBlocked(q)) { await sendText(chatId, ut + ", такое нельзя.", mid, tid); return; }
  const ctl = new AbortController();
  trackCtl(chatId, ctl);
  const stopAct = keepAction(chatId, "upload_document", tid, ctl.signal);
  try {
    const ans = String(await aiText("Ты программист. " + ut + " просит: " + q + ". Верни код полностью и короткое пояснение.", ctl.signal));
    if (stopped(chatId)) return;
    if (ans.length <= 3500) await sendText(chatId, ut + ":\n" + ans, mid, tid);
    else await sendText(chatId, ut + ", код большой — кидаю файлом ниже.", mid, tid);
    await sendDocText(chatId, "code.txt", ut + "\n" + q + "\n\n" + ans, (ut + " " + q).slice(0, 900), mid, tid);
  } catch (e) {
    if (stopped(chatId) || ctl.signal.aborted) { try { await sendText(chatId, "⏹ Остановлено.", mid, tid); } catch (e2) {} }
    else try { await sendText(chatId, "Ошибка: " + e.message, mid, tid); } catch (e2) {}
  }
  stopAct();
  untrackCtl(chatId, ctl);
}
async function doImg(chatId, q, tid, msg) {
  const ut = userTag(msg && msg.from);
  const mid = msg && msg.message_id;
  if (!q) { await sendText(chatId, ut + ", напиши так: /img рыжий кот в космосе", mid, tid); return; }
  if (!isAdmin(msg && msg.from) && hardBlocked(q)) { await sendText(chatId, ut + ", такое нельзя.", mid, tid); return; }
  const ctl = new AbortController();
  trackCtl(chatId, ctl);
  const stopAct = keepAction(chatId, "upload_photo", tid, ctl.signal);
  try {
    const buf = await aiImage(q, ctl.signal);
    if (stopped(chatId)) return;
    await sendPhotoBuf(chatId, buf, (ut + " " + q).slice(0, 900), mid, tid);
  } catch (e) {
    if (stopped(chatId) || ctl.signal.aborted) { try { await sendText(chatId, "⏹ Остановлено.", mid, tid); } catch (e2) {} }
    else try { await sendText(chatId, "Ошибка: " + e.message, mid, tid); } catch (e2) {}
  }
  stopAct();
  untrackCtl(chatId, ctl);
}
async function doVoice(chatId, q, tid, msg) {
  const ut = userTag(msg && msg.from);
  const mid = msg && msg.message_id;
  if (!q) { await sendText(chatId, ut + ", напиши так: /voice твой текст", mid, tid); return; }
  if (!isAdmin(msg && msg.from) && hardBlocked(q)) { await sendText(chatId, ut + ", такое нельзя.", mid, tid); return; }
  const ctl = new AbortController();
  trackCtl(chatId, ctl);
  const stopAct = keepAction(chatId, "record_voice", tid, ctl.signal);
  try {
    for (const p of splitVoice(q)) {
      if (stopped(chatId) || ctl.signal.aborted) { await sendText(chatId, "⏹ Остановлено.", mid, tid); break; }
      const audio = await ttsChunk(p);
      await sendVoiceBuf(chatId, audio, ut + " " + p, mid, tid);
    }
  } catch (e) {
    if (stopped(chatId) || ctl.signal.aborted) { try { await sendText(chatId, "⏹ Остановлено.", mid, tid); } catch (e2) {} }
    else try { await sendText(chatId, "Не вышло озвучить: " + e.message, mid, tid); } catch (e2) {}
  }
  stopAct();
  untrackCtl(chatId, ctl);
}
async function doMediaAsk(chatId, q, tid, msg) {
  const ut = userTag(msg && msg.from);
  const mid = msg && msg.message_id;
  const query = String(q || "").trim() || "Опиши это и ответь.";
  if (!isAdmin(msg && msg.from) && hardBlocked(query)) { await sendText(chatId, ut + ", такое нельзя.", mid, tid); return; }
  let fid = "";
  if (msg.photo && msg.photo.length) fid = msg.photo[msg.photo.length - 1].file_id;
  else if (msg.document) fid = msg.document.file_id;
  if (!fid) { await sendText(chatId, ut + ", не вижу файл.", mid, tid); return; }
  const ctl = new AbortController();
  trackCtl(chatId, ctl);
  const stopAct = keepAction(chatId, "typing", tid, ctl.signal);
  try {
    const url = await fileUrl(fid);
    let ans = "";
    if (msg.photo) ans = await aiVision(ut + " прислал фото и спрашивает: " + query, url, ctl.signal);
    else {
      const r = await fetch(url);
      let txt = "";
      try { txt = (await r.text()).slice(0, 8000); } catch (e) {}
      ans = await aiText(ut + " прислал файл и спрашивает: " + query + "\nСодержимое файла:\n" + (txt || "[нетекстовый файл]"), ctl.signal);
    }
    if (stopped(chatId)) return;
    await sendText(chatId, ut + ", " + String(ans).slice(0, 3800), mid, tid);
  } catch (e) {
    if (stopped(chatId) || ctl.signal.aborted) { try { await sendText(chatId, "⏹ Остановлено.", mid, tid); } catch (e2) {} }
    else try { await sendText(chatId, "Не смог прочитать файл: " + e.message, mid, tid); } catch (e2) {}
  }
  stopAct();
  untrackCtl(chatId, ctl);
}
async function handleMessage(m) {
  const chatId = m.chat.id;
  const tid = m.message_thread_id && Number(m.message_thread_id) > 0 ? Number(m.message_thread_id) : null;
  const nm0 = (m.chat.title || ((m.chat.first_name || "") + " " + (m.chat.last_name || "")).trim() || String(chatId));
  const txt0 = m.text || m.caption || (m.photo ? "[фото]" : (m.document ? "[документ]" : "[сообщение]"));
  sChat(chatId, nm0, m.chat && m.chat.type);
  if (m.from && (m.from.is_bot || (botId && m.from.id === botId))) sMsg(chatId, "out", "bot", txt0, m.message_id, tid);
  else sMsg(chatId, "in", userTag(m.from), txt0, m.message_id, tid);
  if (m.from && m.from.is_bot) return;
  if (m.text) {
    const c = cmdName(m.text);
    if (c) {
      if (c.name === "stop") return doStop(chatId, tid, m.message_id);
      if (c.name === "ask") return doAsk(chatId, c.arg, tid, m);
      if (c.name === "code") return doCode(chatId, c.arg, tid, m);
      if (c.name === "img") return doImg(chatId, c.arg, tid, m);
      if (c.name === "voice") return doVoice(chatId, c.arg, tid, m);
      return;
    }
    if (isReplyToBot(m)) return doAsk(chatId, m.text.trim(), tid, m);
    return;
  }
  if (m.photo || m.document) {
    const cap = m.caption || "";
    const c = cmdName(cap);
    if (c) {
      if (c.name === "stop") return doStop(chatId, tid, m.message_id);
      if (c.name === "ask") return doMediaAsk(chatId, c.arg, tid, m);
      if (c.name === "code") return doMediaAsk(chatId, c.arg, tid, m);
      if (c.name === "img") return doImg(chatId, c.arg, tid, m);
      return;
    }
    if (isReplyToBot(m)) return doMediaAsk(chatId, cap.trim() || "Опиши файл и ответь.", tid, m);
  }
}
async function boot() {
  const me = await tg("getMe", {});
  botId = me.id || 0;
  console.log("online as @" + (me.username || me.first_name) + " id=" + me.id);
  try { await tg("setMyCommands", { commands: [{ command: "ask", description: "Вопрос текстом" }, { command: "code", description: "Код файлом" }, { command: "img", description: "Сгенерировать фото" }, { command: "voice", description: "Озвучить текст" }, { command: "stop", description: "Остановить генерацию" }] }); } catch (e) {}
  while (true) {
    try {
      const updates = await tg("getUpdates", { offset: offset + 1, timeout: 30, limit: 20 });
      for (const u of updates) {
        offset = Math.max(offset, u.update_id);
        const m = u.message || u.channel_post || u.edited_message;
        if (!m) continue;
        runLimited(() => handleMessage(m), m);
      }
      saveOffset();
    } catch (e) {
      console.error("poll: " + e.message);
      await sleep(3000);
    }
  }
}
boot().catch((e) => { console.error("fatal: " + (e && e.message)); process.exit(1); });
