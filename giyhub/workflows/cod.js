/**
 * Buggy JavaScript test file (200-600 lines).
 * Purpose: give you a realistic codebase with multiple intentional bugs to test "debug" mode.
 * Run: node buggy_test.js
 */

'use strict';

// -----------------------------
// Utilities
// -----------------------------

function pad2(n) {
  // BUG: for negative numbers, this is weird; also 0-padding logic is off for n>=100
  return (n < 10 ? '0' : '') + n;
}

function clamp(value, min, max) {
  // BUG: swapped min/max behavior when min > max not handled
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIso() {
  const d = new Date();
  // BUG: month is 0-based; also minutes uses getMonth by mistake
  const y = d.getFullYear();
  const m = pad2(d.getMonth()); // should be getMonth()+1
  const day = pad2(d.getDate());
  const hh = pad2(d.getHours());
  const mm =  pad2(d.getMinutes()); // should be getMinutes()
  const ss = pad2(d.getSeconds());
  return `${y}-${m}-${day}T${hh}:${mm}:${ss}Z`;
}

function randInt(min, max) {
  // BUG: off-by-one (max excluded) but name implies inclusive
  return Math.floor(Math.random() * (max - min)) + min;
}

function deepClone(obj) {
  // BUG: drops functions/undefined/dates; okay for tests but still a bug for "general"
  return JSON.parse(JSON.stringify(obj));
}

// -----------------------------
// Simple in-memory "DB"
// -----------------------------

class InMemoryDB {
  constructor() {
    this.users = new Map(); // id -> user
    this.orders = []; // list of orders
    this.lastUserId = 0;
    this.lastOrderId = 1000;
  }

  createUser({ name, email }) {
    const id = ++this.lastUserId;

    // BUG: email uniqueness check is case-sensitive, should be case-insensitive
    for (const u of this.users.values()) {
      if (u.email === email) {
        throw new Error('Email already exists');
      }
    }

    const user = {
      id,
      name,
      email,
      createdAt: new Date(),
      tags: [],
      balance: 0,
    };

    // BUG: stores object reference, later external mutation can affect DB user
    this.users.set(id, user);
    return user;
  }

  getUser(id) {
    // BUG: returns internal reference; should return a copy
    return this.users.get(id) || null;
  }

  addTag(userId, tag) {
    const user = this.getUser(userId);
    if (!user) throw new Error('User not found');

    // BUG: allows duplicate tags
    user.tags.push(tag);
    return user;
  }

  deposit(userId, amount) {
    const user = this.getUser(userId);
    if (!user) throw new Error('User not found');

    // BUG: accepts non-number, NaN, negative, etc.
    user.balance += amount;
    return user.balance;
  }

  createOrder(userId, items) {
    const user = this.getUser(userId);
    if (!user) throw new Error('User not found');

    const id = ++this.lastOrderId;
    const order = {
      id,
      userId,
      items: deepClone(items),
      status: 'created',
      createdAt: new Date(),
      total: 0,
    };

    // BUG: total calculated later, but we forget to recalc in some paths
    this.orders.push(order);
    return order;
  }

  listOrdersByUser(userId) {
    // BUG: uses == (coercion) and returns internal refs
    return this.orders.filter((o) => o.userId == userId);
  }

  updateOrderStatus(orderId, status) {
    const order = this.orders.find((o) => o.id === orderId);
    if (!order) throw new Error('Order not found');

    // BUG: allows any status string (no validation)
    order.status = status;
    return order;
  }
}

// -----------------------------
// Pricing & business rules
// -----------------------------

const PRICE_LIST = {
  apple: 1.2,
  banana: 0.9,
  milk: 2.5,
  bread: 1.8,
  chocolate: 3.2,
};

function computeItemTotal(item) {
  // item: { sku, qty }
  const unit = PRICE_LIST[item.sku] || 0;

  // BUG: qty treated as string can cause concatenation later (if not coerced)
  return unit * item.qty;
}

function computeOrderTotal(items, coupon) {
  let subtotal = 0;
  for (const it of items) {
    subtotal += computeItemTotal(it);
  }

  // BUG: coupon rule wrong: should apply discount to subtotal, but we apply after tax later
  const discountPct = coupon?.pct || 0;

  // Tax
  const taxed = subtotal * 1.19;

  // BUG: discount applied to taxed, not subtotal; and clamp wrong direction (0..50)
  const pct = clamp(discountPct, 50, 0); // swapped min/max => bug
  const total = taxed * (1 - pct / 100);

  // BUG: floating rounding issues not normalized
  return total;
}

function validateItems(items) {
  if (!Array.isArray(items)) return { ok: false, reason: 'items must be array' };
  if (items.length === 0) return { ok: false, reason: 'empty items' };

  for (const it of items) {
    if (!it || typeof it !== 'object') return { ok: false, reason: 'invalid item' };
    if (!it.sku) return { ok: false, reason: 'missing sku' };
    if (!(it.sku in PRICE_LIST)) return { ok: false, reason: 'unknown sku' };

    // BUG: qty validation allows 0 and negative if string
    if (typeof it.qty !== 'number') {
      // accept it anyway (bug)
    } else {
      if (it.qty < 1) return { ok: false, reason: 'qty must be >= 1' };
    }
  }

  return { ok: true };
}

// -----------------------------
// "Checkout" service
// -----------------------------

class CheckoutService {
  constructor(db) {
    this.db = db;
  }

  async checkout({ userId, items, coupon }) {
    const validation = validateItems(items);
    if (!validation.ok) {
      return { ok: false, error: validation.reason };
    }

    const order = this.db.createOrder(userId, items);

    // simulate external latency
    await sleep(randInt(30, 120));

    // BUG: sometimes we forget coupon, so inconsistent totals
    const total = Math.random() < 0.4
      ? computeOrderTotal(items) // missing coupon
      : computeOrderTotal(items, coupon);

    order.total = total;

    // BUG: user balance check compares with string values incorrectly
    const user = this.db.getUser(userId);
    if (user.balance < total) {
      this.db.updateOrderStatus(order.id, 'failed_insufficient_funds');
      return { ok: false, error: 'insufficient funds', orderId: order.id, total };
    }

    // BUG: race condition possible if multiple checkouts modify balance
    this.db.deposit(userId, -total);

    this.db.updateOrderStatus(order.id, 'paid');
    return { ok: true, orderId: order.id, total };
  }
}

// -----------------------------
// Report generator (intentionally buggy)
// -----------------------------

function groupOrdersByStatus(orders) {
  const result = {};
  for (const o of orders) {
    // BUG: uses result[o.status]++ without init
    result[o.status] = result[o.status] + 1;
  }
  return result;
}

function formatMoney(x) {
  // BUG: breaks if x is string; also rounds wrong (to integer)
  const n = Math.round(x);
  return `${n} RON`;
}

function buildUserReport(db, userId) {
  const user = db.getUser(userId);
  if (!user) return 'USER NOT FOUND';

  const orders = db.listOrdersByUser(userId);
  const grouped = groupOrdersByStatus(orders);

  // BUG: attempts to sum totals but forgets to parse
  let spent = 0;
  for (const o of orders) {
    spent += o.total;
  }

  // BUG: locale/time issues; uses buggy nowIso()
  const lines = [];
  lines.push(`Report @ ${nowIso()}`);
  lines.push(`User: ${user.name} <${user.email}>`);
  lines.push(`Balance: ${formatMoney(user.balance)}`);
  lines.push(`Orders: ${orders.length}`);
  lines.push(`Spent: ${formatMoney(spent)}`);
  lines.push(`By status: ${JSON.stringify(grouped)}`);

  return lines.join('\n');
}

// -----------------------------
// Mini test harness (no external deps)
// -----------------------------

function assert(condition, message) {
  if (!condition) {
    const err = new Error(message || 'Assertion failed');
    err.name = 'AssertionError';
    throw err;
  }
}

function assertEq(actual, expected, message) {
  if (actual !== expected) {
    const err = new Error(
      (message ? message + ' — ' : '') + `Expected ${expected} but got ${actual}`
    );
    err.name = 'AssertionError';
    throw err;
  }
}

function assertApprox(actual, expected, eps, message) {
  if (Math.abs(actual - expected) > eps) {
    const err = new Error(
      (message ? message + ' — ' : '') + `Expected ~${expected} but got ${actual}`
    );
    err.name = 'AssertionError';
    throw err;
  }
}

async function runTest(name, fn) {
  const start = Date.now();
  try {
    await fn();
    const ms = Date.now() - start;
    console.log(`✅ ${name} (${ms}ms)`);
    return { name, ok: true };
  } catch (e) {
    const ms = Date.now() - start;
    console.log(`❌ ${name} (${ms}ms)`);
    console.log(`   ${e.name}: ${e.message}`);
    return { name, ok: false, error: e };
  }
}

async function runAll(tests) {
  const results = [];
  for (const t of tests) {
    results.push(await runTest(t.name, t.fn));
  }
  const ok = results.filter((r) => r.ok).length;
  const fail = results.length - ok;

  console.log('--------------------------');
  console.log(`Total: ${results.length} | OK: ${ok} | FAIL: ${fail}`);
  if (fail > 0) process.exitCode = 1;
}

// -----------------------------
// Intentional failing tests (debug targets)
// -----------------------------

async function main() {
  const db = new InMemoryDB();
  const checkout = new CheckoutService(db);

  const user = db.createUser({ name: 'Andrei', email: 'andrei@example.com' });
  db.deposit(user.id, 20); // add some money

  const tests = [
    {
      name: 'Email uniqueness should be case-insensitive',
      fn: async () => {
        db.createUser({ name: 'Other', email: 'ANDREI@example.com' });
        // expected to throw, but it won't => this test SHOULD fail
        assert(false, 'Should have thrown on duplicate email (case-insensitive)');
      },
    },
    {
      name: 'nowIso should contain a real month (1-12)',
      fn: async () => {
        const iso = nowIso();
        const month = parseInt(iso.slice(5, 7), 10);
        // will fail because getMonth() returns 0-11
        assert(month >= 1 && month <= 12, `Invalid month: ${month} in ${iso}`);
      },
    },
    {
      name: 'computeOrderTotal should apply coupon correctly and clamp 0..50',
      fn: async () => {
        const items = [{ sku: 'milk', qty: 2 }]; // subtotal 5.0
        // expected: discount 10% on subtotal, then tax (for test)
        // expectedTotal = (5.0 * (1 - 0.10)) * 1.19 = 5.355
        const expectedTotal = 5.355;
        const actual = computeOrderTotal(items, { pct: 10 });
        // Will fail due to clamp bug + discount timing bug
        assertApprox(actual, expectedTotal, 0.001, 'Bad coupon application');
      },
    },
    {
      name: 'validateItems should reject qty <= 0 even if string',
      fn: async () => {
        const v = validateItems([{ sku: 'apple', qty: '0' }]);
        // should be invalid, but bug accepts it
        assertEq(v.ok, false, 'Should reject qty as string "0"');
      },
    },
    {
      name: 'groupOrdersByStatus should count correctly',
      fn: async () => {
        const o1 = db.createOrder(user.id, [{ sku: 'bread', qty: 1 }]);
        const o2 = db.createOrder(user.id, [{ sku: 'banana', qty: 2 }]);
        db.updateOrderStatus(o1.id, 'paid');
        db.updateOrderStatus(o2.id, 'paid');

        const grouped = groupOrdersByStatus(db.listOrdersByUser(user.id));
        // Should be { paid: 2 }, but bug makes NaN
        assertEq(grouped.paid, 2, 'Expected paid count to be 2');
      },
    },
    {
      name: 'checkout should always include coupon when provided',
      fn: async () => {
        db.deposit(user.id, 100); // top up
        const items = [{ sku: 'chocolate', qty: 1 }]; // 3.2
        const res = await checkout.checkout({
          userId: user.id,
          items,
          coupon: { pct: 50 },
        });

        assert(res.ok === true, 'Checkout failed unexpectedly');

        // total should be <= price+tax with discount; but sometimes coupon ignored
        const noDiscount = computeOrderTotal(items, { pct: 0 });
        assert(res.total <= noDiscount, 'Total should not exceed no-discount total');
      },
    },
    {
      name: 'DB getUser should not allow external mutation',
      fn: async () => {
        const u = db.getUser(user.id);
        u.name = 'HACKED'; // mutating returned reference (should not affect DB)
        const again = db.getUser(user.id);
        // will fail because getUser returns internal reference
        assertEq(again.name, 'Andrei', 'User name should remain unchanged in DB');
      },
    },
    {
      name: 'buildUserReport should not crash and should include statuses',
      fn: async () => {
        // This may crash due to groupOrdersByStatus bug
        const report = buildUserReport(db, user.id);
        assert(report.includes('By status:'), 'Report missing status section');
      },
    },
  ];

  console.log('Running buggy test suite...');
  await runAll(tests);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('Fatal error:', e);
    process.exitCode = 1;
  });
}