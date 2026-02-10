import path from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import { Telegraf } from "telegraf";

const thisFile = fileURLToPath(import.meta.url);
const srcDir = path.dirname(thisFile);
const botDir = path.resolve(srcDir, "..");
const repoDir = path.resolve(botDir, "..", "..");

// Load env from repo root (preferred) and current dir (fallback).
// Never commit secrets; keep TELEGRAM_BOT_TOKEN only in .env / GitHub Secrets.
dotenv.config({ path: path.join(repoDir, ".env") });
dotenv.config();

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("Missing TELEGRAM_BOT_TOKEN. Add it to .env (gitignored) or export it in the shell.");
  process.exit(1);
}

const bot = new Telegraf(token);

bot.catch((err) => {
  console.error("Bot error:", err);
});

const me = await bot.telegram.getMe();
console.log(`Bot identity: @${me.username} (${me.id})`);

process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});

bot.start(async (ctx) => {
  await ctx.reply("Wishlist bot is running");
});

bot.command("health", async (ctx) => {
  await ctx.reply(JSON.stringify({ ok: true }));
});

bot.on("text", async (ctx) => {
  await ctx.reply("OK");
});

console.log("Launching bot (long polling)...");
bot
  .launch()
  .then(() => {
    console.log("Bot launched");
  })
  .catch((err) => {
    console.error("Bot launch failed:", err);
    process.exitCode = 1;
  });

console.log("Bot process started");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
