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

## Grab helper

Message the bot what you want and it prepares the trip in Grab. You confirm and pay in the Grab app; the bot can never book or pay on its own.

* `ride to KLCC`
* `from office to home, 6 seater, 7pm`
* `food: nasi lemak`
* send a location pin to get a ride there
* `/places` lists your saved places, `/id` shows a chat ID

The reply has an **Open in Grab** button with pickup and drop-off filled in. With no pickup named, Grab uses your phone's location.

The morning brief and alerts run on GitHub Actions, which can't answer messages instantly. The Grab helper therefore runs as a small Cloudflare Worker (free plan) at `intel-bot-grab.raj-intel.workers.dev`, with its code in the `grab/` folder. The Worker never holds the bot token: it answers inside Telegram's own request.

### Setup
Already done: the Worker is deployed and the **Connect Grab helper** workflow runs on merge, sending it your chat ID, the optional `ANTHROPIC_API_KEY` and your saved places, then pointing Telegram at it.

To add saved places, create a repository secret named `GRAB_PLACES` (a secret, because this repo is public):
```json
{
  "home":    {"label": "Home", "lat": 3.1390, "lng": 101.6869},
  "office":  {"label": "Office", "lat": 3.1100, "lng": 101.6650},
  "airport": {"label": "KLIA Terminal 1", "lat": 2.7456, "lng": 101.7072}
}
```
Get coordinates by long-pressing a spot in Google Maps. Then run **Actions → Connect Grab helper → Run workflow**. Do the same after changing `ANTHROPIC_API_KEY`.

Without `ANTHROPIC_API_KEY`, use the simple phrasings `ride to …`, `from … to …` and `food: …`.

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
| `grab/` | The Grab helper (Cloudflare Worker) and its settings |
| `.github/workflows/` | Morning brief (7:03 AM), alerts (hourly), connect (manual), Grab helper connect |
