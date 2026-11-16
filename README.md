# Intel Bot

A personal Telegram bot that pushes the important things from your three projects to your phone:

1. **7 AM morning brief:** the top Malaysia stories, the most urgent exploited vulnerability, the leading threat story, an APAC incident and the key policy development, each with a link. Add an optional AI paragraph on why it matters.
2. **Alerts, checked hourly:** a ping only when something big happens (see `rules.yml`):
   * an exploited flaw in a major vendor, or one used by ransomware (CISA KEV)
   * a zero-day in a major vendor
   * a cyberattack on an APAC telco or bank
   * a new cyber law or consultation in Malaysia or Singapore
3. **Quiet hours:** nothing between 11 PM and 7 AM. Overnight alerts are folded into the morning brief.

It reads `docs/latest.json` from [malaysia-daily-brief](https://github.com/djrufio21/malaysia-daily-brief), [cyber-threat-brief](https://github.com/djrufio21/cyber-threat-brief) and [apac-cyber-policy-tracker](https://github.com/djrufio21/apac-cyber-policy-tracker).

## Setup

### 1. Create the bot (done)
Talk to **@BotFather** in Telegram, send `/newbot`, and keep the token.

### 2. Add the token as a secret
Repo **Settings → Secrets and variables → Actions → New repository secret**
* Name: `TELEGRAM_BOT_TOKEN`
* Secret: the token from BotFather

Secrets are encrypted. They never appear in the code, the logs or this page.

### 3. Get your chat ID
1. In Telegram, open your bot and press **Start** (or send it any message).
2. Within an hour, go to **Actions → Connect Telegram → Run workflow**.
3. The bot sends you your chat ID in Telegram.
4. Add it as a second secret named `TELEGRAM_CHAT_ID`.
5. Run **Connect Telegram** again. You should get "Connected."

### 4. Optional: AI summary
Add a secret `ANTHROPIC_API_KEY` with a key from https://console.anthropic.com. The morning brief then includes a short "Why it matters" paragraph. It costs a few cents a day. Without the key, everything else still works.

### 5. Optional: share with friends through a channel
1. In Telegram, create a **New Channel** (for example "Cyber Intel Brief"). Private is fine.
2. Open the channel's settings → **Administrators → Add Admin**, choose your bot, and allow **Post Messages**.
3. Post anything in the channel (so the bot sees it), then run **Actions → Connect Telegram**.
4. The bot sends you the channel's ID privately. Add it as the secret `TELEGRAM_CHANNEL_ID`.
5. Run **Connect Telegram** once more. The channel gets a "connected" message.
6. Share the channel's invite link with friends.

You keep your personal messages. The channel gets the same brief and alerts, with the greeting set by `channel_greeting` in `rules.yml`. Friends never need GitHub, and you never handle their numbers.

## Jarvis

Jarvis is an assistant you talk to. Open the app, tap the circle, speak, and he answers out loud. Turn on **Hands-free** and he listens again after each answer, so it runs like a call.

### Get the app on your phone
1. In Telegram, send `/app` to the bot and tap **Open Jarvis**.
2. If the page opens inside Telegram, tap ⋮ and choose **Open in Chrome**. Listening needs Chrome.
3. In Chrome, tap ⋮ and choose **Add to Home screen**.
4. Open Jarvis from the home screen, tap the circle and allow the microphone.

The link from `/app` carries a private key that unlocks the app on that phone. Keep it to yourself. `/app new` makes a new key and locks out the old one.

### What he does today
* Answers questions and thinks things through with you.
* Reads your briefing whenever you ask: "my briefing", "headlines", or `/brief` in Telegram. It uses the same picks as the 7 AM message, read fresh from your three projects.
* Prepares Grab rides and food (below). The app shows the **Open in Grab** button.
* He cannot yet read email or your calendar or look up live information, and says so when asked.

Telegram still works too: type to the bot, or send a voice note and get a voice note back.

### What runs it, all on free allowances
| Job | Service |
|---|---|
| Hearing you in the app | Your phone (Chrome's speech recognition) |
| Hearing a Telegram voice note | Cloudflare Workers AI (Whisper) |
| Thinking | A free Workers AI model. Claude is used only if you set `BRAIN = "claude"` in `grab/wrangler.toml` and add `ANTHROPIC_API_KEY`, which is paid |
| Speaking | A Workers AI voice, or Google Cloud Text-to-Speech if `GOOGLE_TTS_KEY` is set. When neither can be spared, your phone's own voice |
| The briefing | Read straight from your three projects. No AI involved |

### It cannot charge you
* Cloudflare's free plan has no overage: when the daily Workers AI allowance runs out, requests fail until it resets. Check **Workers & Pages → Plans** shows **Free**.
* Jarvis also keeps his own estimate of what he uses and stops at `DAILY_NEURON_BUDGET`, below Cloudflare's 10,000 a day. It resets at 8 AM Malaysia time.
* The Workers AI voice is the costly part. Once only `VOICE_RESERVE` is left, your phone's own voice takes over and the rest is kept for thinking. Expect roughly 30 spoken answers a day in the better voice, then the phone's voice.
* With the budget spent, the briefing and plain Grab requests such as `ride to KLCC` keep working.
* The paid Anthropic API is never called unless you switch `BRAIN` to `claude`.
* Google's voice is off until you add its key, and capped below its free allowance when on.

### Turn on the Google voice (optional)
1. In the [Google Cloud console](https://console.cloud.google.com), create a project and enable **Cloud Text-to-Speech API**. Google asks for a billing account even for free use.
2. **APIs & Services → Credentials → Create credentials → API key**. Restrict the key to the Cloud Text-to-Speech API.
3. Add it as a repository secret named `GOOGLE_TTS_KEY`, then run **Actions → Connect Grab helper**.
4. In Google Cloud **Billing → Budgets & alerts**, add a small budget alert as a second guard.

The Worker stops using Google for the month at `TTS_MONTHLY_CHAR_CAP` characters (set in `grab/wrangler.toml`, below Google's free allowance). Change the voice with `TTS_VOICE`.

### Good to know
* The app listens only while it is open on screen. Android does not let a web app listen with the phone locked.
* Hands-free stops listening after two silences and keeps the screen awake while it is on.
* Jarvis remembers the last few exchanges for follow-up questions and forgets them after three quiet hours.
* Telegram voice notes are limited to two minutes.
* To handle Telegram voice notes the Worker has to download your note and upload its reply, and both need the bot token. The **Connect Grab helper** workflow therefore stores the token in the Worker's private KV storage on Cloudflare.
* The briefing's story rules live in two places: `rules.yml` for the 7 AM message and the top of the briefing section in `grab/worker.js` for Jarvis. Change both together.

## Grab helper

Tell Jarvis what you want, typed or spoken, and it prepares the trip in Grab. You confirm and pay in the Grab app; the bot can never book or pay on its own.

* `ride to KLCC`
* `from office to home, 6 seater, 7pm`
* `food: nasi lemak`
* send a location pin to get a ride there
* `/places` lists your saved places, `/id` shows a chat ID

The reply has an **Open in Grab** button with pickup and drop-off filled in. With no pickup named, Grab uses your phone's location.

The morning brief and alerts run on GitHub Actions, which can't answer messages instantly. Jarvis and the Grab helper therefore run as a small Cloudflare Worker (free plan) at `intel-bot-grab.raj-intel.workers.dev`, with its code in the `grab/` folder.

### Setup
Already done: the Worker is deployed and the **Connect Grab helper** workflow runs on merge, sending it the bot token, your chat ID, the optional `ANTHROPIC_API_KEY` and `GOOGLE_TTS_KEY` and your saved places, then pointing Telegram at it.

To add saved places, create a repository secret named `GRAB_PLACES` (a secret, because this repo is public):
```json
{
  "home":    {"label": "Home", "lat": 3.1390, "lng": 101.6869},
  "office":  {"label": "Office", "lat": 3.1100, "lng": 101.6650},
  "airport": {"label": "KLIA Terminal 1", "lat": 2.7456, "lng": 101.7072}
}
```
Get coordinates by long-pressing a spot in Google Maps. Then run **Actions → Connect Grab helper → Run workflow**. Do the same after changing `ANTHROPIC_API_KEY` or `GOOGLE_TTS_KEY`.

### Good to know
* Only your chat (`TELEGRAM_CHAT_ID`) gets answers. Telegram signs every request to the Worker with a value derived from the bot token, and anything unsigned is refused. The Worker locks itself to your bot on first connect.
* After the helper is deployed, the bot's incoming messages go to the Worker, so **Connect Telegram** can no longer discover chat IDs by itself. Send `/id` to the bot instead. If you want the shared channel (setup step 5), set it up before deploying the helper.
* Places you type are looked up on OpenStreetMap, limited to Malaysia and Singapore. Always check the pins in Grab before confirming.
* Grab does not publish its app links for personal use. If **Open in Grab** stops filling in the trip after a Grab update, the page still has **Copy destination**, and the link format can be adjusted in `grab/wrangler.toml` (changes to `grab/` need a redeploy to Cloudflare).
* Advance bookings and ride types are shown in the reply; choose them in Grab.

## Using it
* **Get the brief now:** Actions → Morning brief → Run workflow
* **Check for alerts now:** Actions → Alerts → Run workflow
* **Change what alerts you:** edit `rules.yml`
* **Change the time:** edit the `cron` line in `.github/workflows/morning.yml` (times are UTC; Malaysia is UTC+8)

The first alert check only records what's already out there, so you aren't flooded with old news. Real alerts start from the second check.

## Files
| File | What it does |
|---|---|
| `bot.py` | Builds and sends the messages |
| `rules.yml` | Sources, alert rules, quiet hours, vendor list |
| `data/state.json` | What has already been alerted (kept 30 days) |
| `grab/` | Jarvis, his app page and the Grab helper (Cloudflare Worker) and its settings |
| `.github/workflows/` | Morning brief (7:03 AM), alerts (hourly), connect (manual), Grab helper connect |
