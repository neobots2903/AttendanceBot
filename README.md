# AttendanceBot

A Discord bot for tracking FRC team meeting attendance using Google Sheets as the backend. Students clock themselves in; mentors clock them out — ensuring physical presence is verified by a real person.

## How It Works

| Command | Who | What it does |
|---------|-----|--------------|
| `/register <name>` | Anyone | Links your Discord account to your real name |
| `/in` | Students | Starts an attendance session (new row, status `ACTIVE`) |
| `/out @student` | Mentors only | Ends the student's session (same row, status `COMPLETED`) |
| `/who` | Anyone | Lists the present members |

Check-in and check-out timestamps share a single row so duration calculation is trivial in the spreadsheet.

A nightly job runs at 02:00 and flags any unclosed `ACTIVE` sessions as `NEEDS REVIEW` for mentors to resolve manually.

## Prerequisites

- [Bun](https://bun.sh) v1.1+
- A Discord bot application ([guide](https://discord.com/developers/docs/getting-started))
- A Google Cloud service account with the Sheets API enabled ([guide](https://cloud.google.com/iam/docs/service-accounts-create))
- A Google Sheet shared with the service account's email

## Google Sheet Setup

Create a spreadsheet with two tabs:

**Roster**

| discord_id | real_name |
|------------|-----------|

**Log**

| real_name | date | check_in_datetime | check_out_datetime | status |
|-----------|------|-------------------|--------------------|--------|

Optionally add a **Summary** tab with a formula like:

```
=QUERY(Log!A:E, "SELECT A, SUM(D-C) WHERE E='COMPLETED' GROUP BY A LABEL SUM(D-C) 'Total Hours'")
```

Set the duration column format to **Custom Duration** `[HH]:mm:ss` to prevent hour-wrap at 24h.

## Installation

```bash
git clone https://github.com/neobots2903/AttendanceBot.git
cd AttendanceBot
bun install
```

## Configuration

Set these environment variables (e.g. in a `.env` file):

```env
DISCORD_BOT_TOKEN=your-bot-token
SHEET_ID=your-google-sheet-id
MENTOR_ROLE_ID=discord-role-id-for-mentors
GOOGLE_SERVICE_ACCOUNT_JSON={"type":"service_account","project_id":"..."}
```

`GOOGLE_SERVICE_ACCOUNT_JSON` is the full JSON key file content as a single string.

## Running

```bash
bun run index.ts
```

### Docker

```bash
docker compose up -d
```

This builds the image from the included [Dockerfile](Dockerfile) and reads secrets from your `.env` file.

### Bare metal

For a persistent deployment (Raspberry Pi, VPS, etc.), use a process manager:

```bash
# systemd, pm2, or simply:
nohup bun run index.ts &
```

The bot registers its slash commands globally on first startup (may take up to an hour to propagate to all guilds).

## Design Decisions

- **Single-row state**: Check-in creates the row; check-out updates it. No cross-row joins needed.
- **ISO datetimes**: `YYYY-MM-DD HH:mm:ss` handles sessions that cross midnight (e.g. 6 PM → 1 AM).
- **Mentor-gated `/out`**: Students cannot clock out remotely — they must be physically present with a mentor.
- **Async lock**: All sheet mutations are serialized to prevent race conditions on concurrent commands.
- **Nightly review flag**: Stale sessions are flagged `NEEDS REVIEW`, not auto-closed with fake data. Mentors fill in the real checkout time.

## License

[MIT](LICENSE)
