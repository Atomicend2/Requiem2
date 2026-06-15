/**
 * cards-loader.ts
 * Reads cards.json (written by GitHub Actions scraper) and syncs
 * any new or updated cards into the bot's SQLite database.
 *
 * Images are NOT stored in the DB — they are fetched on demand
 * from Shoob's CDN via media_url when a card is displayed.
 *
 * Called once at bot startup. Fast — only processes new cards.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getDb } from "./db/database.js";
import { logger } from "../lib/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CARDS_JSON = path.resolve(__dirname, "../../../../cards.json");

export async function loadCardsFromRepo(): Promise<{ imported: number; updated: number; skipped: number }> {
  const stats = { imported: 0, updated: 0, skipped: 0 };

  if (!fs.existsSync(CARDS_JSON)) {
    logger.info("cards.json not found — skipping card loader");
    return stats;
  }

  let data: any;
  try {
    data = JSON.parse(fs.readFileSync(CARDS_JSON, "utf8"));
  } catch (e) {
    logger.warn({ e }, "Failed to parse cards.json");
    return stats;
  }

  const cards: any[] = data.cards || [];
  if (cards.length === 0) {
    logger.info("cards.json is empty");
    return stats;
  }

  logger.info({ total: cards.length }, "Loading cards from cards.json...");
  const db = getDb();

  for (const card of cards) {
    const shoobId = String(card.shoob_id || "").trim();
    if (!shoobId) { stats.skipped++; continue; }

    const existing = db.prepare(
      "SELECT id FROM cards WHERE shoob_id = ?"
    ).get(shoobId) as any;

    if (existing) {
      db.prepare(`
        UPDATE cards SET
          name=?, tier=?, series=?, is_animated=?,
          raw_data=?, file_hash=?, has_webm=?, has_webp=?, slug=?,
          source='shoob'
        WHERE id=?
      `).run(
        card.name, card.tier, card.series, card.is_animated ? 1 : 0,
        JSON.stringify({ media_url: card.media_url || '', has_webm: card.has_webm || false, _id: card.shoob_id }),
        card.file_hash || "",
        card.has_webm ? 1 : 0,
        card.has_webp ? 1 : 0,
        card.slug || "",
        existing.id,
      );
      db.prepare(
        "INSERT OR IGNORE INTO shoob_imported_ids (shoob_id, local_card_id) VALUES (?, ?)"
      ).run(shoobId, existing.id);
      stats.updated++;
      continue;
    }

    const localId = genId(db);
    try {
      db.prepare(`
        INSERT INTO cards
          (id, name, series, tier, image_data, is_animated,
           uploaded_by, source, shoob_id,
           raw_data, file_hash, has_webm, has_webp, slug)
        VALUES (?, ?, ?, ?, NULL, ?, 'github-actions', 'shoob', ?, ?, ?, ?, ?, ?)
      `).run(
        localId,
        card.name, card.series, card.tier,
        card.is_animated ? 1 : 0,
        shoobId,
        JSON.stringify({ media_url: card.media_url || '', has_webm: card.has_webm || false, _id: card.shoob_id }),
        card.file_hash || "",
        card.has_webm ? 1 : 0,
        card.has_webp ? 1 : 0,
        card.slug || "",
      );
      db.prepare(
        "INSERT OR IGNORE INTO shoob_imported_ids (shoob_id, local_card_id) VALUES (?, ?)"
      ).run(shoobId, localId);
      stats.imported++;
    } catch (e: any) {
      logger.warn({ e, shoobId }, "Failed to insert card");
      stats.skipped++;
    }
  }

  logger.info(stats, "cards.json load complete");
  return stats;
}

const ID_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
function genId(db: any): string {
  const { randomBytes } = require("crypto");
  for (let i = 0; i < 50; i++) {
    const c = Array.from(randomBytes(8) as Uint8Array)
      .map((b: number) => ID_CHARS[b % ID_CHARS.length]).join("");
    if (!db.prepare("SELECT 1 FROM cards WHERE id=?").get(c)) return c;
  }
  return "C" + Date.now().toString(36).toUpperCase();
}
