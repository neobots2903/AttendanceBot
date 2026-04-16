import {
  Client,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  type CacheType,
} from "discord.js";
import { GoogleSpreadsheet, type GoogleSpreadsheetRow } from "google-spreadsheet";
import { JWT } from "google-auth-library";

// ──────────────────────────────────────────────
// Environment
// ──────────────────────────────────────────────
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN!;
const SHEET_ID = process.env.SHEET_ID!;
const MENTOR_ROLE_ID = process.env.MENTOR_ROLE_ID!;
const GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON!;

for (const [k, v] of Object.entries({
  DISCORD_BOT_TOKEN,
  SHEET_ID,
  MENTOR_ROLE_ID,
  GOOGLE_SERVICE_ACCOUNT_JSON,
})) {
  if (!v) {
    console.error(`Missing required env var: ${k}`);
    process.exit(1);
  }
}

// ──────────────────────────────────────────────
// Google Sheets setup
// ──────────────────────────────────────────────
let creds: { client_email: string; private_key: string };
try {
  creds = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
} catch {
  console.error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON");
  process.exit(1);
}
const serviceAccountAuth = new JWT({
  email: creds.client_email,
  key: creds.private_key,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const doc = new GoogleSpreadsheet(SHEET_ID, serviceAccountAuth);

let lastLoadInfo = 0;
const LOAD_INFO_TTL = 30_000; // 30 seconds

async function ensureLoaded() {
  const now = Date.now();
  if (now - lastLoadInfo > LOAD_INFO_TTL) {
    await doc.loadInfo();
    lastLoadInfo = now;
  }
}

async function getSheet(title: string) {
  await ensureLoaded();
  const sheet = doc.sheetsByTitle[title];
  if (!sheet) throw new Error(`Sheet tab "${title}" not found`);
  return sheet;
}

// ──────────────────────────────────────────────
// Async lock – prevents race conditions on
// concurrent row appends / updates
// ──────────────────────────────────────────────
class AsyncLock {
  private queue: (() => void)[] = [];
  private locked = false;

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }
}

const sheetLock = new AsyncLock();

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────
function nowISO(): string {
  // YYYY-MM-DD HH:mm:ss in local time
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const FORMULA_PREFIX = /^[=+\-@]/;

const clockInGreetings = [
  "Good luck today!",
  "Let's get to work!",
  "Time to make things happen!",
  "You've got this!",
  "Make it a great day!",
  "Ready, set, go!",
  "Let's do this!",
  "Another day, another opportunity!",
  "Glad you're here!",
  "Let's make some progress!",
  "Bolden Bichael \"Befense\" Baverfield wishes you a productive day!",
  "Bertha sends her regards and hopes you have a fantastic day!",
];

function sanitizeName(name: string): string {
  if (FORMULA_PREFIX.test(name)) {
    return `'${name}`;
  }
  return name;
}

/** Find the most recent Log row for a given real_name. */
async function findMostRecentLogRow(
  realName: string,
  rows?: GoogleSpreadsheetRow[]
): Promise<GoogleSpreadsheetRow | null> {
  if (!rows) {
    const logSheet = await getSheet("Log");
    rows = await logSheet.getRows();
  }
  // Walk backwards – most recent row is last
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i]!.get("real_name") === realName) {
      return rows[i]!;
    }
  }
  return null;
}

/** Look up a Discord ID → real_name from the Roster tab. */
const rosterCache = new Map<string, string>();

async function lookupRoster(
  discordId: string
): Promise<{ realName: string } | null> {
  const cached = rosterCache.get(discordId);
  if (cached) return { realName: cached };

  const roster = await getSheet("Roster");
  const rows = await roster.getRows();
  rosterCache.clear();
  for (const row of rows) {
    const id = row.get("discord_id") as string;
    const name = row.get("real_name") as string;
    if (id && name) rosterCache.set(id, name);
  }

  const result = rosterCache.get(discordId);
  return result ? { realName: result } : null;
}

// ──────────────────────────────────────────────
// Slash command definitions
// ──────────────────────────────────────────────
const registerCmd = new SlashCommandBuilder()
  .setName("register")
  .setDescription("Register your real name for attendance tracking.")
  .addStringOption((o) =>
    o.setName("name").setDescription("Your full real name").setRequired(true)
  );

const inCmd = new SlashCommandBuilder()
  .setName("in")
  .setDescription("Clock in – start your attendance session.");

const outCmd = new SlashCommandBuilder()
  .setName("out")
  .setDescription("Clock out a student (Mentor only).")
  .addUserOption((o) =>
    o.setName("student").setDescription("The student to clock out").setRequired(true)
  );

const commands = [registerCmd, inCmd, outCmd];

// ──────────────────────────────────────────────
// Command handlers
// ──────────────────────────────────────────────
async function handleRegister(interaction: ChatInputCommandInteraction<CacheType>) {
  await interaction.deferReply({ ephemeral: true });
  const fullName = sanitizeName(interaction.options.getString("name", true).trim());
  if (fullName.length > 100) {
    await interaction.editReply("Name must be 100 characters or fewer.");
    return;
  }
  const discordId = interaction.user.id;

  await sheetLock.acquire();
  try {
    // Check for existing registration
    const existing = await lookupRoster(discordId);
    if (existing) {
      await interaction.editReply(
        `You are already registered as **${existing.realName}**.`
      );
      return;
    }

    const roster = await getSheet("Roster");
    await roster.addRow({
      discord_id: discordId,
      real_name: fullName,
    });
    rosterCache.set(discordId, fullName);

    await interaction.editReply(
      `Registered **${fullName}**. You can now use \`/in\`.`
    );
  } finally {
    sheetLock.release();
  }
}

async function handleIn(interaction: ChatInputCommandInteraction<CacheType>) {
  await interaction.deferReply({ ephemeral: true });
  const discordId = interaction.user.id;

  await sheetLock.acquire();
  try {
    const profile = await lookupRoster(discordId);
    if (!profile) {
      await interaction.editReply(
        "You are not registered. Use `/register [Full Name]` first."
      );
      return;
    }

    const logSheet = await getSheet("Log");
    const logRows = await logSheet.getRows();

    const lastRow = await findMostRecentLogRow(profile.realName, logRows);
    if (lastRow && lastRow.get("status") === "ACTIVE") {
      await interaction.editReply(
        "You already have an **ACTIVE** session. Ask a mentor to `/out` you first."
      );
      return;
    }
    const now = nowISO();
    await logSheet.addRow({
      real_name: profile.realName,
      date: now.split(" ")[0]!, // YYYY-MM-DD
      check_in_datetime: now,
      check_out_datetime: "",
      status: "ACTIVE",
    });

    const greeting = clockInGreetings[Math.floor(Math.random() * clockInGreetings.length)]!;
    await interaction.editReply(`Clocked in at **${now}**. ${greeting}`);
  } finally {
    sheetLock.release();
  }
}

async function handleOut(interaction: ChatInputCommandInteraction<CacheType>) {
  await interaction.deferReply({ ephemeral: true });

  // Role gate – mentor only
  const member = interaction.member;
  const roles =
    member && "cache" in member.roles ? member.roles.cache : null;
  if (!roles?.has(MENTOR_ROLE_ID)) {
    await interaction.editReply("Only mentors can clock students out.");
    return;
  }

  const targetUser = interaction.options.getUser("student", true);

  await sheetLock.acquire();
  try {
    const profile = await lookupRoster(targetUser.id);
    if (!profile) {
      await interaction.editReply(
        `**${targetUser.displayName}** is not registered.`
      );
      return;
    }

    const logSheet = await getSheet("Log");
    const logRows = await logSheet.getRows();

    const lastRow = await findMostRecentLogRow(profile.realName, logRows);
    if (!lastRow || lastRow.get("status") !== "ACTIVE") {
      await interaction.editReply(
        `No active session found for **${profile.realName}**. Use the spreadsheet for a manual entry.`
      );
      return;
    }

    const now = nowISO();
    lastRow.set("check_out_datetime", now);
    lastRow.set("status", "COMPLETED");
    await lastRow.save();

    await interaction.editReply(
      `Clocked out **${profile.realName}** at **${now}**.`
    );
  } finally {
    sheetLock.release();
  }
}

// ──────────────────────────────────────────────
// Nightly reset cron – force-close stale sessions
// Runs at 02:00 daily
// ──────────────────────────────────────────────
async function nightlyReset() {
  console.log("[cron] Running nightly reset (02:00)…");

  // Collect names of active sessions, then process one at a time
  // releasing the lock between each so /out commands can interleave.
  await sheetLock.acquire();
  let activeNames: string[];
  try {
    const logSheet = await getSheet("Log");
    const rows = await logSheet.getRows();
    activeNames = rows
      .filter((r) => r.get("status") === "ACTIVE")
      .map((r) => r.get("real_name") as string);
  } finally {
    sheetLock.release();
  }

  for (const name of activeNames) {
    await sheetLock.acquire();
    try {
      // Re-fetch rows — a /out may have resolved it since we last checked
      const logSheet = await getSheet("Log");
      const rows = await logSheet.getRows();
      const row = await findMostRecentLogRow(name, rows);
      if (!row || row.get("status") !== "ACTIVE") continue;

      row.set("check_out_datetime", "");
      row.set("status", "NEEDS REVIEW");
      await row.save();
      console.log(
        `[cron] Flagged session for ${name} – needs manual review`
      );
    } finally {
      sheetLock.release();
    }
  }
}

let lastResetDate = "";

function startNightlyResetCron() {
  setInterval(async () => {
    const now = new Date();
    if (now.getHours() !== 2) return;
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    if (today === lastResetDate) return;
    lastResetDate = today;
    try {
      await nightlyReset();
    } catch (err) {
      console.error("[cron] Nightly reset failed:", err);
    }
  }, 60_000);
  console.log("[cron] Nightly reset cron started (02:00 daily)");
}

// ──────────────────────────────────────────────
// Discord client
// ──────────────────────────────────────────────
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`);

  // Register slash commands globally
  const rest = new REST().setToken(DISCORD_BOT_TOKEN);
  await rest.put(Routes.applicationCommands(c.user.id), {
    body: commands.map((cmd) => cmd.toJSON()),
  });
  console.log("Slash commands registered.");

  // Start nightly reset cron (02:00)
  startNightlyResetCron();
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    switch (interaction.commandName) {
      case "register":
        await handleRegister(interaction);
        break;
      case "in":
        await handleIn(interaction);
        break;
      case "out":
        await handleOut(interaction);
        break;
    }
  } catch (err) {
    console.error(`Error handling /${interaction.commandName}:`, err);
    try {
      const msg = "Something went wrong. Please try again or contact an admin.";
      if (interaction.deferred) {
        await interaction.editReply({ content: msg });
      } else {
        await interaction.reply({ content: msg, ephemeral: true });
      }
    } catch { /* interaction expired or webhook gone */ }
  }
});

process.on("unhandledRejection", (err) => {
  console.error("[fatal] Unhandled rejection:", err);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    client.destroy();
    process.exit(0);
  });
}

client.login(DISCORD_BOT_TOKEN);