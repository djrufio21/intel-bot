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
| `.github/workflows/` | Morning brief (7:03 AM), alerts (hourly), connect (manual) |
