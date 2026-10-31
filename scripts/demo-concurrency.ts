// One-command oversell demo against a running dev server (npm run dev).
// Fires 20 parallel checkouts at sku_print and prints what happened.
import 'dotenv/config';

const base = process.env.DEMO_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
const PRODUCT = 'sku_print';
const CARTS = 20;

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function stock(): Promise<number> {
  const { body } = await call('GET', '/products');
  return body.find((p: { id: string }) => p.id === PRODUCT).stock;
}

const initial = await stock().catch(() => {
  console.error(`Cannot reach ${base}. Start the server first: npm run dev`);
  process.exit(1);
});
if (initial === 0) {
  console.error(`${PRODUCT} is sold out. Reset the dev DB first: npm run db:reset`);
  process.exit(1);
}

console.log(`${PRODUCT} stock before: ${initial}. Preparing ${CARTS} carts with 1 unit each...`);
const carts: string[] = [];
for (let i = 0; i < CARTS; i++) {
  const cart = await call('POST', '/carts');
  await call('PUT', `/carts/${cart.body.id}/items/${PRODUCT}`, { quantity: 1 });
  carts.push(cart.body.id);
}

console.log(`Firing ${CARTS} checkouts in parallel...`);
const results = await Promise.all(carts.map((id) => call('POST', `/carts/${id}/checkout`, {})));

const tally = new Map<string, number>();
for (const r of results) {
  const key = r.status === 201 ? '201 order placed' : `${r.status} ${r.body.error?.code}`;
  tally.set(key, (tally.get(key) ?? 0) + 1);
}
for (const [key, count] of [...tally].sort()) console.log(`  ${String(count).padStart(3)} x ${key}`);

const placed = results.filter((r) => r.status === 201).length;
const final = await stock();
console.log(`${PRODUCT} stock after: ${final}`);
const ok = placed === Math.min(initial, CARTS) && final === initial - placed && final >= 0;
console.log(ok ? 'OK: no oversell, every unit sold exactly once.' : 'MISMATCH: investigate!');
process.exit(ok ? 0 : 1);
