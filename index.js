const fs = require("fs");
const path = require("path");
const express = require("express");
require("dotenv").config();

const { Telegraf, Markup } = require("telegraf");

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = String(process.env.ADMIN_ID || "");
const GAME_LINK = process.env.GAME_LINK || "https://example.com/register";
const BOT_NAME = process.env.BOT_NAME || "Safe Alert Bot";
const PORT = Number(process.env.PORT || 8080);
const BASE_URL = process.env.BASE_URL;
const WEBHOOK_PATH = process.env.WEBHOOK_PATH || "/telegram-webhook";

if (!BOT_TOKEN) throw new Error("BOT_TOKEN missing in .env / Railway Variables");
if (!ADMIN_ID) throw new Error("ADMIN_ID missing in .env / Railway Variables");
if (!BASE_URL) throw new Error("BASE_URL missing in .env / Railway Variables");

const bot = new Telegraf(BOT_TOKEN);
const app = express();

const DATA_FILE = path.join(__dirname, "data.json");

function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      return { users: {} };
    }
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    return JSON.parse(raw || '{"users":{}}');
  } catch (err) {
    console.error("Failed to load data.json:", err.message);
    return { users: {} };
  }
}

function saveData(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("Failed to save data.json:", err.message);
  }
}

let db = loadData();

function getUser(userId) {
  const id = String(userId);
  if (!db.users[id]) {
db.users[id] = {
  id,
  approved: false,
  requested: false,
  alertsOn: false,
  waitingForGameId: false,
  gameId: "",
  first_name: "",
  username: "",
  joinedAt: new Date().toISOString()
};
    saveData(db);
  }
  return db.users[id];
}

function updateUser(userId, patch) {
  const user = getUser(userId);
  db.users[String(userId)] = { ...user, ...patch };
  saveData(db);
  return db.users[String(userId)];
}

function isApproved(userId) {
  return getUser(userId).approved === true;
}

function mainMenu(userId) {
  const approved = isApproved(userId);

  if (!approved) {
    return Markup.inlineKeyboard([
      [Markup.button.url("Register Here", GAME_LINK)],
      [Markup.button.callback("I Have Registered", "register_request")],
      [Markup.button.callback("Refresh Status", "refresh_status")]
    ]);
  }

  const user = getUser(userId);

  return Markup.inlineKeyboard([
    [
      Markup.button.callback(
        user.alertsOn ? "Alerts OFF" : "Alerts ON",
        user.alertsOn ? "alerts_off" : "alerts_on"
      )
    ],
    [Markup.button.callback("My Status", "my_status")]
  ]);
}

function buildWelcomeText(userId) {
  const user = getUser(userId);

  if (!user.approved) {
    return (
      `*${BOT_NAME}*\n\n` +
      `Use this bot only after registration and admin approval.\n\n` +
      `1. Click *Register Here*\n` +
      `2. Complete registration\n` +
      `3. Click *I Have Registered*\n` +
      `4. Wait for admin approval\n\n` +
      `Link:\n${GAME_LINK}`
    );
  }

  return (
    `*${BOT_NAME}*\n\n` +
    `Your account is approved.\n` +
    `You can now turn minute alerts ON or OFF using the button below.`
  );
}

function adminDecisionKeyboard(targetUserId) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("Approve", `admin_approve_${targetUserId}`),
      Markup.button.callback("Reject", `admin_reject_${targetUserId}`)
    ]
  ]);
}

function formatUserLabel(from) {
  const first = from.first_name || "Unknown";
  const username = from.username ? `@${from.username}` : "No username";
  return `${first} (${username}) [${from.id}]`;
}

function generateNeutralUpdate() {
  const choices = ["Update A", "Update B"];
  const minute = new Date().getUTCMinutes();
  return choices[minute % 2];
}

async function sendMinuteAlerts() {
  const users = Object.values(db.users).filter(
    (u) => u.approved && u.alertsOn
  );

  if (users.length === 0) return;

  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");

  const message =
    `⏰ Minute Update\n\n` +
    `Time: ${hh}:${mm}\n` +
    `Result: ${generateNeutralUpdate()}`;

  for (const user of users) {
    try {
      await bot.telegram.sendMessage(user.id, message);
    } catch (err) {
      console.error(`Failed to send to ${user.id}:`, err.message);
    }
  }
}

function scheduleNextMinuteTick() {
  const now = new Date();
  const delay = (60 - now.getSeconds()) * 1000 - now.getMilliseconds();

  setTimeout(async () => {
    try {
      await sendMinuteAlerts();
    } catch (err) {
      console.error("sendMinuteAlerts error:", err.message);
    } finally {
      scheduleNextMinuteTick();
    }
  }, delay);
}

bot.start(async (ctx) => {
  const from = ctx.from;
  updateUser(from.id, {
    first_name: from.first_name || "",
    username: from.username || ""
  });

  await ctx.replyWithMarkdown(buildWelcomeText(from.id), mainMenu(from.id));
});

bot.command("menu", async (ctx) => {
  await ctx.replyWithMarkdown(buildWelcomeText(ctx.from.id), mainMenu(ctx.from.id));
});

bot.command("status", async (ctx) => {
  const user = getUser(ctx.from.id);
  const text =
    `*Your Status*\n\n` +
    `Approved: ${user.approved ? "Yes" : "No"}\n` +
    `Request Sent: ${user.requested ? "Yes" : "No"}\n` +
    `Alerts: ${user.alertsOn ? "ON" : "OFF"}`;

  await ctx.replyWithMarkdown(text, mainMenu(ctx.from.id));
});

bot.action("register_request", async (ctx) => {
  const from = ctx.from;

  updateUser(from.id, {
    requested: true,
    waitingForGameId: true,
    first_name: from.first_name || "",
    username: from.username || ""
  });

  await ctx.answerCbQuery();
  await ctx.reply("📩 Please send your GAME ID (only text).");
});

bot.on("text", async (ctx) => {
  const user = getUser(ctx.from.id);

  if (!user.waitingForGameId) return;

  const gameId = ctx.message.text;

  updateUser(ctx.from.id, {
    gameId: gameId,
    waitingForGameId: false
  });

  await ctx.reply("✅ Your Game ID has been sent to admin. Wait for approval.");

  try {
    await bot.telegram.sendMessage(
  ADMIN_ID,
  `📩 New Verification Request\n\nUser: ${ctx.from.first_name}\nUsername: @${ctx.from.username || "N/A"}\nID: ${ctx.from.id}\nGame ID: ${gameId}`,
  Markup.inlineKeyboard([
    [
      Markup.button.callback("Approve", `admin_approve_${ctx.from.id}`),
      Markup.button.callback("Reject", `admin_reject_${ctx.from.id}`)
    ]
  ])
);
  } catch (err) {
    console.error("Admin send error:", err.message);
  }
});

bot.action("refresh_status", async (ctx) => {
  await ctx.answerCbQuery("Status refreshed");
  await ctx.editMessageText(buildWelcomeText(ctx.from.id), {
    parse_mode: "Markdown",
    ...mainMenu(ctx.from.id)
  }).catch(async () => {
    await ctx.replyWithMarkdown(buildWelcomeText(ctx.from.id), mainMenu(ctx.from.id));
  });
});

bot.action("my_status", async (ctx) => {
  const user = getUser(ctx.from.id);
  await ctx.answerCbQuery("Status loaded");
  await ctx.replyWithMarkdown(
    `*Your Status*\n\nApproved: ${user.approved ? "Yes" : "No"}\nAlerts: ${user.alertsOn ? "ON" : "OFF"}`,
    mainMenu(ctx.from.id)
  );
});

bot.action("alerts_on", async (ctx) => {
  if (!isApproved(ctx.from.id)) {
    await ctx.answerCbQuery("You are not approved yet");
    return;
  }

  updateUser(ctx.from.id, { alertsOn: true });
  await ctx.answerCbQuery("Alerts turned ON");
  await ctx.editMessageReplyMarkup(mainMenu(ctx.from.id).reply_markup).catch(() => {});
  await ctx.reply("✅ Alerts are now ON.");
});

bot.action("alerts_off", async (ctx) => {
  if (!isApproved(ctx.from.id)) {
    await ctx.answerCbQuery("You are not approved yet");
    return;
  }

  updateUser(ctx.from.id, { alertsOn: false });
  await ctx.answerCbQuery("Alerts turned OFF");
  await ctx.editMessageReplyMarkup(mainMenu(ctx.from.id).reply_markup).catch(() => {});
  await ctx.reply("🛑 Alerts are now OFF.");
});

bot.action(/^admin_approve_(.+)$/, async (ctx) => {
  if (String(ctx.from.id) !== ADMIN_ID) {
    await ctx.answerCbQuery("Not allowed");
    return;
  }

  const targetUserId = ctx.match[1];
  updateUser(targetUserId, {
    approved: true,
    requested: true,
    alertsOn: false
  });

  await ctx.answerCbQuery("User approved");
  await ctx.editMessageText(`✅ Approved user ${targetUserId}`);

  try {
    await bot.telegram.sendMessage(
      targetUserId,
      `✅ You have been approved by admin.\n\nUse /start or /menu to open controls.`,
      mainMenu(targetUserId)
    );
  } catch (err) {
    console.error("Failed to send approval message:", err.message);
  }
});

bot.action(/^admin_reject_(.+)$/, async (ctx) => {
  if (String(ctx.from.id) !== ADMIN_ID) {
    await ctx.answerCbQuery("Not allowed");
    return;
  }

  const targetUserId = ctx.match[1];
  updateUser(targetUserId, {
    approved: false,
    requested: true,
    alertsOn: false
  });

  await ctx.answerCbQuery("User rejected");
  await ctx.editMessageText(`❌ Rejected user ${targetUserId}`);

  try {
    await bot.telegram.sendMessage(
      targetUserId,
      `❌ Your registration request was rejected by admin.`
    );
  } catch (err) {
    console.error("Failed to send rejection message:", err.message);
  }
});

bot.catch((err) => {
  console.error("Bot error:", err);
});

app.get("/", (req, res) => {
  res.status(200).send("Bot is running");
});

app.use(bot.webhookCallback(WEBHOOK_PATH));

async function startBot() {
  await bot.telegram.setWebhook(`${BASE_URL}${WEBHOOK_PATH}`);
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Webhook: ${BASE_URL}${WEBHOOK_PATH}`);
  });
  scheduleNextMinuteTick();
}

startBot().catch((err) => {
  console.error("Startup error:", err);
  process.exit(1);
});
