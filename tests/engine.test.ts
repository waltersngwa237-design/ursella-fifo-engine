// Unit tests for the FIFO/COGS engine. Run with: node --test tests/engine.test.ts
// Uses only Node built-ins (node:test, node:assert) — no dependencies to install.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runLedger, round } from '../src/engine.ts';
import type {
  AdjustmentEvent,
  InventoryEvent,
  ReceiptEvent,
  ReturnEvent,
  SaleEvent,
} from '../src/types.ts';

// Terse, typed event builders. Timestamps are plain ascending numbers.
function receipt(id: string, productId: string, quantity: number, unitCost: number, occurredAt: number): ReceiptEvent {
  return { kind: 'receipt', id, productId, quantity, unitCost, occurredAt };
}
function sale(id: string, productId: string, quantity: number, unitPrice: number, occurredAt: number, saleId?: string): SaleEvent {
  return { kind: 'sale', id, productId, quantity, unitPrice, occurredAt, saleId };
}
function ret(id: string, productId: string, quantity: number, occurredAt: number): ReturnEvent {
  return { kind: 'return', id, productId, quantity, occurredAt };
}
function adjust(id: string, productId: string, quantity: number, occurredAt: number, unitCost?: number): AdjustmentEvent {
  return { kind: 'adjustment', id, productId, quantity, occurredAt, unitCost };
}

test('single lot: COGS, revenue, margin, and remaining valuation', () => {
  const events: InventoryEvent[] = [receipt('r1', 'A', 10, 2, 1), sale('s1', 'A', 4, 5, 2)];
  const r = runLedger(events);
  assert.equal(r.sales[0].cogs, 8);
  assert.equal(r.sales[0].revenue, 20);
  assert.equal(r.sales[0].grossMargin, 12);
  assert.equal(r.sales[0].grossMarginRate, 0.6);
  assert.equal(r.valuationByProduct['A'].quantityOnHand, 6);
  assert.equal(r.valuationByProduct['A'].inventoryValue, 12);
  assert.equal(r.valuationByProduct['A'].averageUnitCost, 2);
  assert.equal(r.totals.grossMargin, 12);
});

test('FIFO across two lots: oldest cost is consumed first', () => {
  const events: InventoryEvent[] = [
    receipt('r1', 'A', 10, 2, 1),
    receipt('r2', 'A', 10, 3, 2),
    sale('s1', 'A', 15, 10, 3),
  ];
  const r = runLedger(events);
  // 10 @ 2 + 5 @ 3 = 35
  assert.equal(r.sales[0].cogs, 35);
  assert.equal(r.valuationByProduct['A'].quantityOnHand, 5);
  assert.equal(r.valuationByProduct['A'].inventoryValue, 15);
});

test('insufficient stock (default): costs covered units, reports shortfall', () => {
  const events: InventoryEvent[] = [receipt('r1', 'A', 5, 2, 1), sale('s1', 'A', 8, 10, 2)];
  const r = runLedger(events);
  assert.equal(r.sales[0].cogs, 10); // only 5 covered @ 2
  assert.equal(r.sales[0].revenue, 80); // sale still happened
  assert.equal(r.sales[0].shortfallQuantity, 3);
  assert.equal(r.warnings.length, 1);
  assert.equal(r.warnings[0].code, 'insufficient_stock');
});

test('insufficient stock (backorder): uncovered units costed at last-known cost', () => {
  const events: InventoryEvent[] = [receipt('r1', 'A', 5, 2, 1), sale('s1', 'A', 8, 10, 2)];
  const r = runLedger(events, { insufficientStock: 'backorder', fallbackUnitCost: 'lastKnown' });
  // 5 @ 2 + 3 @ 2 (last known) = 16
  assert.equal(r.sales[0].cogs, 16);
  assert.equal(r.sales[0].shortfallQuantity, 0);
});

test('customer return restocks at last-consumed cost', () => {
  const events: InventoryEvent[] = [receipt('r1', 'A', 10, 2, 1), sale('s1', 'A', 4, 5, 2), ret('rt1', 'A', 1, 3)];
  const r = runLedger(events);
  // sold 4 (last consumed cost = 2), returned 1 back @ 2 -> 7 on hand @ 2
  assert.equal(r.valuationByProduct['A'].quantityOnHand, 7);
  assert.equal(r.valuationByProduct['A'].inventoryValue, 14);
  assert.equal(r.valuationByProduct['A'].averageUnitCost, 2);
});

test('event order is deterministic by occurredAt, not array order', () => {
  // sale listed BEFORE the receipt in the array, but occurs AFTER it in time.
  const events: InventoryEvent[] = [sale('s1', 'A', 4, 5, 3000), receipt('r1', 'A', 10, 2, 2000)];
  const r = runLedger(events);
  assert.equal(r.sales[0].cogs, 8);
  assert.equal(r.sales[0].shortfallQuantity, 0);
  assert.equal(r.warnings.length, 0);
});

test('negative adjustment writes stock off (shrinkage)', () => {
  const events: InventoryEvent[] = [receipt('r1', 'A', 10, 2, 1), adjust('a1', 'A', -3, 2)];
  const r = runLedger(events);
  assert.equal(r.valuationByProduct['A'].quantityOnHand, 7);
  assert.equal(r.valuationByProduct['A'].inventoryValue, 14);
});

test('products are isolated from one another', () => {
  const events: InventoryEvent[] = [
    receipt('r1', 'A', 10, 2, 1),
    receipt('r2', 'B', 5, 4, 1),
    sale('s1', 'A', 2, 5, 2),
    sale('s2', 'B', 1, 9, 2),
  ];
  const r = runLedger(events);
  assert.equal(r.valuationByProduct['A'].quantityOnHand, 8);
  assert.equal(r.valuationByProduct['B'].quantityOnHand, 4);
  assert.equal(r.totals.cogs, 8); // 2*2 + 1*4
  assert.equal(r.totals.revenue, 19); // 2*5 + 1*9
});

test('monetary rounding is half-up and stable', () => {
  assert.equal(round(1.005, 2), 1.01);
  const events: InventoryEvent[] = [receipt('r1', 'A', 3, 1.005, 1), sale('s1', 'A', 3, 2, 2)];
  const r = runLedger(events);
  assert.equal(r.sales[0].cogs, 3.02); // 3 * 1.005 = 3.015 -> 3.02
  assert.equal(r.sales[0].grossMargin, 2.98); // 6 - 3.02
});

test('empty input yields zeroed totals and no products', () => {
  const r = runLedger([]);
  assert.equal(r.sales.length, 0);
  assert.equal(r.totals.revenue, 0);
  assert.equal(r.totals.cogs, 0);
  assert.equal(Object.keys(r.valuationByProduct).length, 0);
  assert.equal(r.warnings.length, 0);
});
