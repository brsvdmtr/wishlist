/**
 * marketplace/strategies/index.ts — Strategy registration
 *
 * Imports all marketplace strategy modules and registers them
 * with the orchestrator. Must be imported once at startup.
 */

import { registerStrategies } from '../orchestrator.js';
import { wildberriesStrategies } from './wildberries.js';
import { ozonStrategies } from './ozon.js';
import { yandexMarketStrategies } from './yandex-market.js';
import { goldappleStrategies } from './goldapple.js';

// ─── Register All Marketplace Strategies ─────────────────────────────────────

export function initStrategies(): void {
  registerStrategies('wildberries',   wildberriesStrategies);
  registerStrategies('ozon',          ozonStrategies);
  registerStrategies('yandex_market', yandexMarketStrategies);
  registerStrategies('goldapple',     goldappleStrategies);
}

// Auto-register on import
initStrategies();

// Re-export for testing
export { wildberriesStrategies } from './wildberries.js';
export { ozonStrategies } from './ozon.js';
export { yandexMarketStrategies } from './yandex-market.js';
export { goldappleStrategies } from './goldapple.js';
