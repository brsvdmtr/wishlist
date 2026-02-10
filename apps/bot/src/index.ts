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

bot.start(async (ctx) => {
  await ctx.reply("Wishlist bot is running");
});

bot.command("health", async (ctx) => {
  await ctx.reply(JSON.stringify({ ok: true }));
});

bot.on("text", async (ctx) => {
  await ctx.reply("OK");
});

await bot.launch();
console.log("Bot started (long polling)");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
