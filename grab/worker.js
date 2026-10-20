// Grab helper for Intel Bot.
//
// Telegram sends every message you type to this Worker (a webhook). The Worker
// works out where you want to go or what you want to eat, then replies with a
// button that opens the Grab app with the trip filled in. You confirm and pay
// inside Grab. Nothing here can book or pay on its own.
//
// The Worker never holds the bot token. It answers inside Telegram's webhook
// request, which Telegram allows, so the token stays in GitHub.
//
// The "Connect Grab helper" workflow sends your settings to /setup along with the
// bot token. The Worker checks the token with Telegram, locks itself to that bot
// on first use, keeps only a fingerprint of the token, and stores in the CONFIG
// KV namespace:
//   TELEGRAM_CHAT_ID   the only chat that gets answers
//   ANTHROPIC_API_KEY  optional; without it only simple phrasing works
//   GRAB_PLACES        optional JSON of saved places (kept out of the public repo)
// Telegram then calls /telegram with the same fingerprint as its secret token.

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
      let answer = null;
      try {
        answer = await handleUpdate(update, cfg, url.origin);
      } catch (err) {
        console.error(err);
      }
      // The reply travels back in this response, so no bot token is needed here.
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
// same value from the bot token, so the token itself is never stored here.
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
  for (const k of ["TELEGRAM_CHAT_ID", "ANTHROPIC_API_KEY", "GRAB_PLACES"]) {
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
  "<b>Grab helper</b>",
  "Tell me where to go or what to eat, in plain words:",
  "• <i>ride to KLCC</i>",
  "• <i>grab from office to home, 6 seater</i>",
  "• <i>food: nasi lemak</i>",
  "• or send a location pin to get a ride there",
  "",
  "I prepare the trip and you confirm it in the Grab app.",
  "/places shows your saved places. /id shows this chat's ID.",
].join("\n");

async function handleUpdate(update, env, origin) {
  const msg = update.message || update.edited_message;
  if (!msg) return null;
  const chatId = msg.chat.id;
  // Only answer you. Anyone else who finds the bot gets nothing.
  if (String(chatId) !== String(env.TELEGRAM_CHAT_ID).trim()) {
    if ((msg.text || "").trim() === "/id") return reply(env, chatId, `Chat ID: <code>${chatId}</code>`);
    return null;
  }

  const places = savedPlaces(env);

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
    const names = Object.keys(places);
    return reply(env, chatId, names.length
      ? "<b>Saved places</b>\n" + names.map((n) => `• ${esc(n)}: ${esc(places[n].label)}`).join("\n")
      : "No saved places yet. Add the GRAB_PLACES secret in GitHub, then run Connect Grab helper.");
  }

  let request;
  try {
    request = env.ANTHROPIC_API_KEY ? await understandWithAI(env, text, places) : understandSimply(text);
  } catch (err) {
    console.error(err);
    request = understandSimply(text);
  }
  if (!request || request.intent === "unknown") {
    return reply(env, chatId, esc(request?.question || "I didn't catch that.") + "\n\n" + HELP);
  }

  if (request.intent === "food") {
    return sendPlan(env, chatId, origin, { intent: "food", query: request.food_query || text, note: request.note });
  }

  const dropoff = await resolvePlace(request.dropoff, places);
  if (!dropoff) {
    return reply(env, chatId, `I couldn't find <b>${esc(request.dropoff || "the destination")}</b> on the map. Try a fuller name, or send a location pin.`);
  }
  // No pickup means Grab uses your phone's current location, which is usually what you want.
  const pickup = request.pickup ? await resolvePlace(request.pickup, places) : null;
  if (request.pickup && !pickup) {
    return reply(env, chatId, `I couldn't find the pickup <b>${esc(request.pickup)}</b>. Try a fuller name.`);
  }
  return sendPlan(env, chatId, origin, {
    intent: "ride", pickup, dropoff, ride_type: request.ride_type, when: request.when, note: request.note,
  });
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

async function understandWithAI(env, text, places) {
  const now = new Date().toLocaleString("en-GB", { timeZone: "Asia/Kuala_Lumpur", dateStyle: "full", timeStyle: "short" });
  const system = `You turn a short Telegram message into a Grab request for a user in Kuala Lumpur, Malaysia.
Current time in Malaysia: ${now}.
Saved place names (use them exactly when the user means one): ${Object.keys(places).join(", ") || "none"}.
Reply with one JSON object only, no other text:
{"intent":"ride"|"food"|"unknown",
 "pickup": saved place name, or a searchable place like "Mid Valley Megamall, Kuala Lumpur", or null for the user's current location,
 "dropoff": same rules, required for rides,
 "ride_type": e.g. "GrabCar", "GrabCar 6-seater", "JustGrab", "GrabCar Premium", or null,
 "when": a plain time like "today 7:00 PM" if the user wants a later ride, else null,
 "food_query": for food, the dish or restaurant to search, e.g. "nasi lemak",
 "note": one short helpful line or null,
 "question": if intent is unknown, one short clarifying question}
Add ", Malaysia" or ", Singapore" to non-saved places so a map search finds them. Never invent addresses.`;
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: env.AI_MODEL || "claude-haiku-5-5",
      max_tokens: 300,
      system,
      messages: [{ role: "user", content: text }],
    }),
  });
  if (!resp.ok) throw new Error(`Anthropic ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  const out = (data.content || []).map((b) => b.text || "").join("");
  const json = out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1);
  return JSON.parse(json);
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
