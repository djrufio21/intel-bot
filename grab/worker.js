// Jarvis and the Grab helper for Intel Bot.
//
// Telegram sends every message you type or speak to this Worker (a webhook).
// The Worker works out what you want. For a ride or food it replies with a
// button that opens the Grab app with the trip filled in; you confirm and pay
// inside Grab, and nothing here can book or pay on its own. For anything else
// it answers as Jarvis. A voice note gets a spoken answer back.
//
// Typed messages are answered inside Telegram's own webhook request. Voice needs
// more: the Worker has to download your voice note and upload its spoken reply,
// and both need the bot token. So the token is stored here once voice is set up.
//
// The "Connect Grab helper" workflow sends your settings to /setup along with the
// bot token. The Worker checks the token with Telegram, locks itself to that bot
// on first use, and stores in the CONFIG KV namespace:
//   TELEGRAM_BOT_TOKEN the bot token, used only to fetch and send voice notes
//   TELEGRAM_CHAT_ID   the only chat that gets answers
//   ANTHROPIC_API_KEY  optional and paid; only used when BRAIN is set to "claude"
//   GOOGLE_TTS_KEY     optional; the British voice. Without it a free Workers AI voice is used
//   GRAB_PLACES        optional JSON of saved places (kept out of the public repo)
// Telegram then calls /telegram with a fingerprint of the token as its secret.

const UA = "intel-bot-grab/1.0 (personal use)";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/go") return goPage(url, env);
    if (request.method === "POST" && url.pathname === "/setup") return setup(request, env);
    if (request.method === "POST" && url.pathname === "/telegram") {
      const config = (await env.CONFIG.get("config", "json")) || {};
      const given = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
      if (!config.webhook_secret || !(await sameText(given, config.webhook_secret))) {
        return new Response("forbidden", { status: 403 });
      }
      const update = await request.json();
      const cfg = { ...env, ...config };
      const msg = update.message || update.edited_message;
      if (msg && (msg.voice || msg.audio) && isOwner(msg, cfg)) {
        if (!cfg.TELEGRAM_BOT_TOKEN || !env.AI) {
          return Response.json(reply(cfg, msg.chat.id, "Voice isn't switched on yet. Run <b>Connect Grab helper</b> in GitHub Actions once, then try again."));
        }
        // Listening, thinking and speaking take a few seconds, so answer Telegram
        // now and finish in the background.
        ctx.waitUntil(handleVoice(msg, cfg, url.origin));
        return new Response("ok");
      }
      let answer = null;
      try {
        answer = await handleUpdate(update, cfg, url.origin);
      } catch (err) {
        console.error(err);
      }
      // A typed reply travels back in this response, so it needs no bot token.
      return answer ? Response.json(answer) : new Response("ok");
    }
    return new Response("Intel Bot Grab helper is running.");
  },
};

// ---------- Setup ----------

async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sameText(a, b) {
  // Compare fingerprints of both values so timing reveals nothing about the secret.
  return (await sha256("cmp:" + a)) === (await sha256("cmp:" + b));
}

// The webhook secret Telegram sends with every message. The workflow derives the
// same value from the bot token.
const webhookSecret = (token) => sha256(token + "-grab-webhook").then((h) => h.slice(0, 48));

async function setup(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "Expected JSON" }, { status: 400 });
  }
  const token = String(body.TELEGRAM_BOT_TOKEN || "").trim();
  const me = token
    ? await fetch(`https://api.telegram.org/bot${token}/getMe`).then((r) => r.json()).catch(() => null)
    : null;
  if (!me?.ok) return Response.json({ ok: false, error: "Telegram did not accept the bot token" }, { status: 403 });

  const old = (await env.CONFIG.get("config", "json")) || {};
  if (old.bot_id && old.bot_id !== me.result.id) {
    return Response.json({ ok: false, error: "This helper is locked to a different bot" }, { status: 403 });
  }
  const config = { bot_id: me.result.id, webhook_secret: await webhookSecret(token) };
  config.TELEGRAM_BOT_TOKEN = token;
  for (const k of ["TELEGRAM_CHAT_ID", "ANTHROPIC_API_KEY", "GOOGLE_TTS_KEY", "GRAB_PLACES"]) {
    if (body[k]) config[k] = String(body[k]).trim();
  }
  if (config.GRAB_PLACES) {
    try {
      JSON.parse(config.GRAB_PLACES);
    } catch {
      return Response.json({ ok: false, error: "GRAB_PLACES is not valid JSON" }, { status: 400 });
    }
  }
  await env.CONFIG.put("config", JSON.stringify(config));
  const stored = Object.keys(config).filter((k) => k === k.toUpperCase());
  return Response.json({ ok: true, bot: me.result.username, stored });
}

// ---------- Telegram ----------

function reply(env, chatId, text, buttons) {
  return {
    method: "sendMessage",
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
  };
}

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const HELP = [
  "<b>Jarvis</b>",
  "Type or send a voice note. A voice note gets a spoken answer.",
  "",
  "<b>Grab</b>",
  "• <i>ride to KLCC</i>",
  "• <i>grab from office to home, 6 seater</i>",
  "• <i>food: nasi lemak</i>",
  "• or send a location pin to get a ride there",
  "I prepare the trip and you confirm it in the Grab app.",
  "",
  "/places shows your saved places. /id shows this chat's ID.",
].join("\n");

const isOwner = (msg, env) => String(msg.chat.id) === String(env.TELEGRAM_CHAT_ID ?? "").trim();

async function handleUpdate(update, env, origin) {
  const msg = update.message || update.edited_message;
  if (!msg) return null;
  const chatId = msg.chat.id;
  // Only answer you. Anyone else who finds the bot gets nothing.
  if (!isOwner(msg, env)) {
    if ((msg.text || "").trim() === "/id") return reply(env, chatId, `Chat ID: <code>${chatId}</code>`);
    return null;
  }

  if (msg.location || msg.venue) {
    const loc = msg.venue?.location || msg.location;
    const label = msg.venue ? `${msg.venue.title}, ${msg.venue.address}` : "Pinned location";
    const plan = { intent: "ride", dropoff: { label, lat: loc.latitude, lng: loc.longitude } };
    return sendPlan(env, chatId, origin, plan);
  }

  const text = (msg.text || "").trim();
  if (!text) return null;
  if (text === "/start" || text === "/help") return reply(env, chatId, HELP);
  if (text === "/id") return reply(env, chatId, `Chat ID: <code>${chatId}</code>`);
  if (text === "/places") {
    const places = savedPlaces(env);
    const names = Object.keys(places);
    return reply(env, chatId, names.length
      ? "<b>Saved places</b>\n" + names.map((n) => `• ${esc(n)}: ${esc(places[n].label)}`).join("\n")
      : "No saved places yet. Add the GRAB_PLACES secret in GitHub, then run Connect Grab helper.");
  }
  return (await respond(env, chatId, text, origin)).answer;
}

// Works out what a typed or spoken request needs. Returns the Telegram message
// to send (answer) and the line Jarvis says aloud for a voice note (say).
async function respond(env, chatId, text, origin) {
  const places = savedPlaces(env);
  const history = await loadHistory(env);
  const canThink = usesClaude(env) || Boolean(env.AI);
  const spent = canThink && !(await spendAllowance(env));
  let request;
  try {
    request = canThink && !spent ? await think(env, text, places, history) : understandSimply(text);
  } catch (err) {
    console.error(err);
    request = understandSimply(text);
  }
  if (spent && request.intent === "unknown") {
    return { answer: reply(env, chatId, esc(SPENT) + " Plain Grab requests still work: <i>ride to KLCC</i>, <i>food: nasi lemak</i>."), say: SPENT };
  }
  const done = async (answer, say) => {
    await saveHistory(env, history, text, say);
    return { answer: await answer, say };
  };

  if (request?.intent === "chat" && request.say) {
    return done(reply(env, chatId, esc(request.say)), request.say);
  }
  if (!request || request.intent === "unknown") {
    const say = request?.question || "I didn't catch that.";
    return done(reply(env, chatId, esc(say) + "\n\n" + HELP), say);
  }

  if (request.intent === "food") {
    const query = request.food_query || text;
    return done(
      sendPlan(env, chatId, origin, { intent: "food", query, note: request.note }),
      `GrabFood is ready with ${query}, sir. Pick a restaurant and check out in the app.`,
    );
  }

  const dropoff = await resolvePlace(request.dropoff, places);
  if (!dropoff) {
    const what = request.dropoff || "the destination";
    return done(
      reply(env, chatId, `I couldn't find <b>${esc(what)}</b> on the map. Try a fuller name, or send a location pin.`),
      `I couldn't find ${what} on the map, sir. Try a fuller name, or send me a location pin.`,
    );
  }
  // No pickup means Grab uses your phone's current location, which is usually what you want.
  const pickup = request.pickup ? await resolvePlace(request.pickup, places) : null;
  if (request.pickup && !pickup) {
    return done(
      reply(env, chatId, `I couldn't find the pickup <b>${esc(request.pickup)}</b>. Try a fuller name.`),
      `I couldn't find the pickup point, ${request.pickup}, sir. Try a fuller name.`,
    );
  }
  const plan = { intent: "ride", pickup, dropoff, ride_type: request.ride_type, when: request.when, note: request.note };
  const short = (p) => p.label.split(",")[0];
  return done(
    sendPlan(env, chatId, origin, plan),
    `Your ride to ${short(dropoff)}${pickup ? ` from ${short(pickup)}` : ""} is ready, sir. Check the pins and confirm in Grab.`,
  );
}

// ---------- Staying free ----------
// Everything here runs on free allowances. Cloudflare's free plan stops by itself
// when its daily allowance runs out, and this daily limit keeps Jarvis under it
// in any case, so a busy day ends with a polite refusal and never with a bill.

const SPENT = "That is today's free allowance used up, sir. I'll be back at eight tomorrow morning.";
const usesClaude = (env) => env.BRAIN === "claude" && Boolean(env.ANTHROPIC_API_KEY);
const todayKey = () => "ai:" + new Date().toISOString().slice(0, 10); // resets at 00:00 UTC, 8 AM in Malaysia

async function allowanceLeft(env) {
  const limit = Number(env.DAILY_AI_LIMIT) || 0;
  return limit - (Number(await env.CONFIG.get(todayKey())) || 0);
}

async function spendAllowance(env) {
  const key = todayKey();
  const used = Number(await env.CONFIG.get(key)) || 0;
  if (used >= (Number(env.DAILY_AI_LIMIT) || 0)) return false;
  await env.CONFIG.put(key, String(used + 1), { expirationTtl: 3 * 86400 });
  return true;
}

// A short memory of the last few exchanges, so follow-up questions make sense.
// It clears itself after three quiet hours.
async function loadHistory(env) {
  try {
    return (await env.CONFIG.get("history", "json")) || [];
  } catch {
    return [];
  }
}

async function saveHistory(env, history, heard, said) {
  const next = [...history, { you: heard.slice(0, 500), jarvis: String(said || "").slice(0, 500) }].slice(-6);
  try {
    await env.CONFIG.put("history", JSON.stringify(next), { expirationTtl: 3 * 3600 });
  } catch (err) {
    console.error(err);
  }
}

async function sendPlan(env, chatId, origin, plan) {
  const go = new URL("/go", origin);
  if (plan.intent === "food") {
    go.searchParams.set("k", "food");
    go.searchParams.set("q", plan.query);
    const lines = [`🍜 <b>GrabFood:</b> ${esc(plan.query)}`];
    if (plan.note) lines.push(esc(plan.note));
    lines.push("", "Tap below, then pick a restaurant and check out in Grab.");
    return reply(env, chatId, lines.join("\n"), [[{ text: "Open GrabFood", url: go.toString() }]]);
  }

  go.searchParams.set("k", "ride");
  const put = (prefix, p) => {
    go.searchParams.set(prefix, p.label);
    go.searchParams.set(prefix + "lat", String(p.lat));
    go.searchParams.set(prefix + "lng", String(p.lng));
  };
  put("d", plan.dropoff);
  if (plan.pickup) put("p", plan.pickup);

  const lines = [
    `🚗 <b>To:</b> ${esc(plan.dropoff.label)}`,
    `<b>From:</b> ${plan.pickup ? esc(plan.pickup.label) : "your current location"}`,
  ];
  if (plan.ride_type) lines.push(`<b>Type:</b> ${esc(plan.ride_type)} (choose it in Grab)`);
  if (plan.when) lines.push(`<b>When:</b> ${esc(plan.when)} (use Advance Booking in Grab)`);
  if (plan.note) lines.push(esc(plan.note));
  lines.push("", "Check the pins in Grab before you confirm.");
  const maps = `https://www.google.com/maps/search/?api=1&query=${plan.dropoff.lat},${plan.dropoff.lng}`;
  return reply(env, chatId, lines.join("\n"), [
    [{ text: "Open in Grab", url: go.toString() }],
    [{ text: "Check on map", url: maps }],
  ]);
}

// ---------- Understanding the request ----------

function savedPlaces(env) {
  try {
    const raw = JSON.parse(env.GRAB_PLACES || "{}");
    const out = {};
    for (const [name, p] of Object.entries(raw)) {
      if (p && typeof p.lat === "number" && typeof p.lng === "number") {
        out[name.toLowerCase()] = { label: p.label || name, lat: p.lat, lng: p.lng };
      }
    }
    return out;
  } catch {
    console.error("GRAB_PLACES is not valid JSON");
    return {};
  }
}

// Works without an API key for the common phrasings.
function understandSimply(text) {
  const t = text.replace(/\s+/g, " ").trim();
  const food = t.match(/^(?:\/food|food|order|eat|hungry for)[:\s]+(.+)$/i);
  if (food) return { intent: "food", food_query: food[1] };
  const fromTo = t.match(/(?:ride|grab|car|taxi|go|take me)?\s*from (.+?) to (.+)$/i);
  if (fromTo) return { intent: "ride", pickup: fromTo[1], dropoff: fromTo[2] };
  const to = t.match(/^(?:\/ride\s+)?(?:ride|grab|car|taxi|go|take me|book)?\s*(?:a ride )?to (.+)$/i);
  if (to) return { intent: "ride", dropoff: to[1] };
  return { intent: "unknown" };
}

async function think(env, text, places, history) {
  const now = new Date().toLocaleString("en-GB", { timeZone: "Asia/Kuala_Lumpur", dateStyle: "full", timeStyle: "short" });
  const earlier = history.map((h) => `Him: ${h.you}\nYou: ${h.jarvis}`).join("\n");
  const system = `You are Jarvis, a personal assistant on Telegram for one man in Kuala Lumpur, Malaysia. He types or sends voice notes, and your "say" line is read aloud to him.
Manner: a calm, capable English butler with dry wit. Brief and plain. Call him "sir" now and then, not in every line.
Current time in Malaysia: ${now}.

What you can do today: answer questions from general knowledge, think things through with him, and prepare Grab rides and GrabFood searches that he confirms in the Grab app.
What you cannot do yet: read his email or calendar, search the web, or see live information such as weather, traffic, news or prices. You never book or pay for anything. If he asks for one of these, say so plainly in one line. Never make up such information.

Saved place names (use them exactly when he means one): ${Object.keys(places).join(", ") || "none"}.
Reply with one JSON object only, no other text:
{"intent":"ride"|"food"|"chat"|"unknown",
 "pickup": for rides, a saved place name, or a searchable place like "Mid Valley Megamall, Kuala Lumpur", or null for his current location,
 "dropoff": same rules, required for rides,
 "ride_type": e.g. "GrabCar", "GrabCar 6-seater", "JustGrab", "GrabCar Premium", or null,
 "when": a plain time like "today 7:00 PM" if he wants a later ride, else null,
 "food_query": for food, the dish or restaurant to search, e.g. "nasi lemak",
 "note": for rides and food, one short helpful line or null,
 "say": for chat, your spoken answer: one to three short sentences, plain words, no lists, no markdown, no emoji,
 "question": if intent is unknown, one short clarifying question}
Use "ride" or "food" only when he wants one now. Everything else is "chat".
Add ", Malaysia" or ", Singapore" to non-saved places so a map search finds them. Never invent addresses.${earlier ? `\n\nThe conversation so far:\n${earlier}` : ""}`;

  let out;
  if (usesClaude(env)) {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: env.AI_MODEL || "claude-haiku-5-5",
        max_tokens: 500,
        system,
        messages: [{ role: "user", content: text }],
      }),
    });
    if (!resp.ok) throw new Error(`Anthropic ${resp.status}: ${await resp.text()}`);
    const data = await resp.json();
    out = (data.content || []).map((b) => b.text || "").join("");
  } else {
    // The free Workers AI model does the thinking.
    const data = await env.AI.run(env.FREE_CHAT_MODEL, {
      messages: [{ role: "system", content: system }, { role: "user", content: text }],
      max_tokens: 500,
    });
    out = typeof data.response === "string" ? data.response : JSON.stringify(data.response ?? "");
  }
  const from = out.indexOf("{"), to = out.lastIndexOf("}");
  if (from === -1 || to <= from) return out.trim() ? { intent: "chat", say: out.trim() } : { intent: "unknown" };
  try {
    return JSON.parse(out.slice(from, to + 1));
  } catch {
    return { intent: "unknown" };
  }
}

// ---------- Voice ----------

const MAX_VOICE_SECONDS = 120;

function telegram(env, method, body) {
  const isForm = body instanceof FormData;
  return fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    ...(isForm ? { body } : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  }).then((r) => r.json());
}

async function handleVoice(msg, env, origin) {
  const chatId = msg.chat.id;
  const text = (t) => telegram(env, "sendMessage", reply(env, chatId, t));
  try {
    const note = msg.voice || msg.audio;
    if (note.duration > MAX_VOICE_SECONDS) return await text("That one runs over two minutes, sir. A shorter note, please.");
    if ((await allowanceLeft(env)) <= 0) return await text(SPENT);
    await telegram(env, "sendChatAction", { chat_id: chatId, action: "record_voice" });

    const file = await telegram(env, "getFile", { file_id: note.file_id });
    if (!file.ok) throw new Error("getFile failed: " + JSON.stringify(file));
    const audio = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.result.file_path}`);
    if (!audio.ok) throw new Error("voice download failed: " + audio.status);
    const heard = await transcribe(env, new Uint8Array(await audio.arrayBuffer()));
    if (!heard) return await text("I couldn't make that out, sir. Could you say it again?");

    const { answer, say } = await respond(env, chatId, heard, origin);
    const heardLine = `🎙 <i>${esc(heard)}</i>`;
    const hasButtons = Boolean(answer.reply_markup);
    // A ride or food plan keeps its buttons in a text message; the voice follows it.
    if (hasButtons) await telegram(env, "sendMessage", { ...answer, text: `${heardLine}\n\n${answer.text}` });

    const spoken = await speak(env, say);
    if (!spoken) {
      if (!hasButtons) await text(`${heardLine}\n\n${esc(say)}`);
      return;
    }
    const form = new FormData();
    form.set("chat_id", String(chatId));
    form.set("voice", new Blob([spoken], { type: "audio/ogg" }), "jarvis.ogg");
    if (!hasButtons) {
      form.set("caption", `${heardLine}\n\n${esc(say)}`.slice(0, 1000));
      form.set("parse_mode", "HTML");
    }
    const sent = await telegram(env, "sendVoice", form);
    if (!sent.ok) {
      console.error("sendVoice failed", JSON.stringify(sent));
      if (!hasButtons) await text(`${heardLine}\n\n${esc(say)}`);
    }
  } catch (err) {
    console.error(err);
    await text("Something went wrong on my side, sir. Try again in a moment.").catch(() => {});
  }
}

// Speech to text on Workers AI (free daily allowance).
async function transcribe(env, bytes) {
  const out = await env.AI.run(env.STT_MODEL, { audio: [...bytes] });
  return String(out?.text || "").trim();
}

// Text to speech. Google's British voice when its key is set and the monthly cap
// has room; otherwise the free Workers AI voice. Returns OGG Opus bytes, which
// is what Telegram plays as a voice note, or null if neither voice is available.
async function speak(env, say) {
  const text = String(say || "").slice(0, 700);
  if (!text) return null;
  if (env.GOOGLE_TTS_KEY) {
    try {
      const audio = await googleVoice(env, text);
      if (audio) return audio;
    } catch (err) {
      console.error(err);
    }
  }
  try {
    const resp = await env.AI.run(
      env.FREE_TTS_MODEL,
      { text, speaker: env.FREE_TTS_SPEAKER, encoding: "opus", container: "ogg" },
      { returnRawResponse: true },
    );
    if (!resp.ok) throw new Error(`Workers AI voice ${resp.status}: ${await resp.text()}`);
    return new Uint8Array(await resp.arrayBuffer());
  } catch (err) {
    console.error(err);
    return null;
  }
}

async function googleVoice(env, text) {
  // Hard stop below Google's free monthly allowance, so the voice can never run up a bill.
  const cap = Number(env.TTS_MONTHLY_CHAR_CAP) || 0;
  const month = "tts:" + new Date().toISOString().slice(0, 7);
  const used = Number(await env.CONFIG.get(month)) || 0;
  if (used + text.length > cap) {
    console.warn(`Google voice paused: ${used} of ${cap} characters used this month`);
    return null;
  }
  // Count before calling, so a failed or repeated call can only overcount.
  await env.CONFIG.put(month, String(used + text.length), { expirationTtl: 70 * 86400 });

  const resp = await fetch("https://texttospeech.googleapis.com/v1/text:synthesize", {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": env.GOOGLE_TTS_KEY },
    body: JSON.stringify({
      input: { text },
      voice: { languageCode: env.TTS_VOICE.split("-").slice(0, 2).join("-"), name: env.TTS_VOICE },
      audioConfig: { audioEncoding: "OGG_OPUS" },
    }),
  });
  if (!resp.ok) throw new Error(`Google voice ${resp.status}: ${await resp.text()}`);
  const { audioContent } = await resp.json();
  return Uint8Array.from(atob(audioContent), (c) => c.charCodeAt(0));
}

async function resolvePlace(name, places) {
  if (!name) return null;
  const key = String(name).toLowerCase().trim();
  if (places[key]) return places[key];
  // OpenStreetMap search, limited to Malaysia and Singapore. Free, fine for personal use.
  const url = "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=my,sg&q=" + encodeURIComponent(name);
  const resp = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "en" } });
  if (!resp.ok) return null;
  const [hit] = await resp.json();
  if (!hit) return null;
  const label = hit.display_name.split(", ").slice(0, 3).join(", ");
  return { label, lat: Number(hit.lat), lng: Number(hit.lon) };
}

// ---------- The page that hands the trip to Grab ----------
// Telegram buttons only open web links, not grab:// app links, so the button
// lands on this small page and the page opens the Grab app.

function fillTemplate(template, values) {
  const filled = template.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(values[k] ?? ""));
  // Drop parameters left empty (for example no pickup), so Grab falls back to GPS.
  const [base, query = ""] = filled.split("?");
  const kept = query.split("&").filter((pair) => pair && !pair.endsWith("="));
  return kept.length ? `${base}?${kept.join("&")}` : base;
}

function goPage(url, env) {
  const p = Object.fromEntries(url.searchParams);
  let title, main, copyText, details;
  if (p.k === "food") {
    title = "GrabFood";
    main = fillTemplate(env.GRAB_FOOD_LINK, { q: p.q });
    copyText = p.q;
    details = `<p class="big">${esc(p.q)}</p>`;
  } else {
    title = "Grab ride";
    main = fillTemplate(env.GRAB_RIDE_LINK, {
      plat: p.plat, plng: p.plng, paddr: p.p,
      dlat: p.dlat, dlng: p.dlng, daddr: p.d,
    });
    copyText = p.d;
    details = `<p class="label">To</p><p class="big">${esc(p.d)}</p>
      <p class="label">From</p><p>${p.p ? esc(p.p) : "Your current location"}</p>`;
  }
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  :root{--bg:#f6f7f5;--card:#fff;--ink:#16211b;--muted:#5d6b62;--grab:#00a651;--line:#dfe5e0}
  @media (prefers-color-scheme:dark){:root{--bg:#0f1512;--card:#18201b;--ink:#e8efe9;--muted:#9aa9a0;--line:#2a352e}}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  main{max-width:420px;margin:0 auto;padding:24px 16px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px}
  .label{margin:12px 0 2px;font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
  .label:first-child{margin-top:0}.big{font-size:20px;font-weight:600;margin:0}p{margin:0}
  a.btn,button{display:block;width:100%;margin-top:12px;padding:14px;border-radius:12px;font:inherit;font-weight:600;text-align:center;text-decoration:none;border:1px solid var(--line);background:var(--card);color:var(--ink)}
  a.primary{background:var(--grab);border-color:var(--grab);color:#fff;margin-top:20px}
  .hint{margin-top:16px;font-size:14px;color:var(--muted)}
</style></head><body><main>
<div class="card">${details}
<a class="btn primary" href="${esc(main)}">Open in Grab</a>
<a class="btn" href="grab://open">Open Grab without details</a>
<button id="copy">Copy ${p.k === "food" ? "dish" : "destination"}</button>
<p class="hint">If Grab opens without the details filled in, use "Copy" and paste into Grab's search. You always confirm and pay in Grab.</p>
</div></main>
<script>
document.getElementById("copy").onclick = async function () {
  try { await navigator.clipboard.writeText(${JSON.stringify(copyText || "").replace(/</g, "\\u003c")}); this.textContent = "Copied"; }
  catch (e) { this.textContent = "Copy failed, long-press the text above"; }
};
</script></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
