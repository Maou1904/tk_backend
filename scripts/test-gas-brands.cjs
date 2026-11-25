// Integration test: creates and removes only its own random LOCAL database.
// Run from the backend repository: node scripts/test-gas-brands.cjs
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { Client } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const root = path.join(__dirname, '..');
const connection = process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL }
    : { host: process.env.DB_HOST || 'localhost', port: process.env.DB_PORT || 5432,
        user: process.env.DB_USER, password: process.env.DB_PASSWORD };
const host = connection.connectionString ? new URL(connection.connectionString).hostname : connection.host;
assert(['localhost', '127.0.0.1', '::1', '[::1]'].includes(host), 'This test only uses a local database');
const database = `tingkum_brand_test_${crypto.randomBytes(6).toString('hex')}`;
const password = crypto.randomBytes(24).toString('hex');
const admin = new Client({ ...connection, database: 'postgres' });
let client;
let child;
let created = false;
let token;
let base;
let childLog = '';

async function api(route, body, method = body ? 'POST' : 'GET', expected = 200) {
    const res = await fetch(base + route, { method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json();
    assert.equal(res.status, expected, `${route}: ${JSON.stringify(data)}`);
    return data;
}

async function stop() {
    if (child && child.exitCode === null) {
        const ended = once(child, 'exit');
        child.kill();
        await ended;
    }
    child = null;
}

async function start() {
    const server = net.createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    base = `http://127.0.0.1:${port}`;
    const env = { ...process.env, PORT: String(port), NODE_ENV: 'production',
        DEFAULT_OWNER_USERNAME: 'brand_qa', DEFAULT_OWNER_PASSWORD: password, TZ: 'Asia/Bangkok' };
    if (connection.connectionString) {
        const url = new URL(connection.connectionString);
        url.pathname = `/${database}`;
        env.DATABASE_URL = url.toString();
    } else { env.DATABASE_URL = ''; env.DB_NAME = database; }
    child = spawn(process.execPath, ['index.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', data => { childLog += data; });
    child.stderr.on('data', data => { childLog += data; });
    for (let i = 0; i < 100; i++) {
        if (child.exitCode !== null) throw new Error(`Backend failed: ${childLog}`);
        try { if ((await fetch(base + '/health')).ok) return; } catch { /* Starting */ }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Backend did not become ready');
}

async function checkStock(siamFull = 10, siamEmpty = 0) {
    const items = await api('/api/gas/items');
    const siam = items.find(item => item.id === 'SIAM-15');
    const ptt = items.find(item => item.id === 'PTT-15');
    assert.equal(siam.brand, 'สยาม');
    assert.equal(ptt.brand, 'ปตท');
    assert.equal(siam.fullStock, siamFull);
    assert.equal(siam.emptyStock, siamEmpty);
    assert.equal(ptt.fullStock, 10);
    assert.equal(ptt.emptyStock, 0);
}

(async () => {
    await admin.connect();
    await admin.query(`CREATE DATABASE ${database}`);
    created = true;
    client = new Client({ ...connection, database });
    await client.connect();
    await client.query(`
        CREATE TABLE gas_items (
            id VARCHAR(40) PRIMARY KEY, name TEXT NOT NULL, operation TEXT NOT NULL,
            price NUMERIC(12,2) NOT NULL DEFAULT 0, stock INTEGER NOT NULL DEFAULT 0,
            full_stock INTEGER NOT NULL DEFAULT 0, empty_stock INTEGER NOT NULL DEFAULT 0,
            image_url TEXT, active BOOLEAN NOT NULL DEFAULT TRUE,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        INSERT INTO gas_items (id,name,operation,price,stock,full_stock) VALUES
            ('PTT-15','ปตท 15 กก.','ปตท',500,10,10),
            ('SHARED','15 กก.','ขายแก๊ส',500,7,7),
            ('AMBIGUOUS','สยาม ปตท 15 กก.','ขายแก๊ส',500,8,8);
    `);
    await start();
    token = (await api('/api/auth/login', { username: 'brand_qa', password })).token;
    const initial = await api('/api/gas/items');
    assert.equal(initial.find(item => item.id === 'PTT-15').brand, 'ปตท');
    for (const id of ['SHARED', 'AMBIGUOUS']) assert.equal(initial.find(item => item.id === id).brand, '');
    assert.equal(initial.find(item => item.id === 'SHARED').fullStock, 7);
    console.log('PASS: legacy migration preserves stock and leaves ambiguous/shared stock unassigned');

    const draft = { id: 'SIAM-15', name: 'สยาม 15 กก.', operation: '15 กก.', price: 500,
        fullStock: 10, emptyStock: 0 };
    await api('/api/gas/items', draft, 'POST', 400);
    await api('/api/gas/items', { ...draft, brand: 'สยาม' }, 'POST', 201);
    await api('/api/gas/items/SHARED', { brand: 'สยาม' }, 'PATCH');
    await api('/api/gas/items/SHARED', { brand: 'invalid' }, 'PATCH', 400);
    await checkStock();

    const session = await api('/api/app-sessions/today');
    await api(`/api/app-sessions/${session.session_id}/open`, {});
    const jobs = `/api/app-sessions/${session.session_id}/gas/jobs`;
    const order = { brand: 'สยาม', customerName: 'ทดสอบยี่ห้อ', address: 'ฐานทดสอบในเครื่อง',
        driver: 'QA', deliveryFee: 0, paid: true, emptyTankReturnQuantity: 1,
        items: [{ id: 'SIAM-15', quantity: 1 }] };
    await api(jobs, { ...order, brand: 'invalid' }, 'POST', 400);
    await api(jobs, { ...order, items: [{ id: 'PTT-15', quantity: 1 }] }, 'POST', 400);
    await api(jobs, { ...order, items: [...order.items, { id: 'PTT-15', quantity: 1 }] }, 'POST', 400);
    await checkStock();
    await api(jobs, { ...order, items: [{ id: 'SIAM-15', quantity: 11 }] }, 'POST', 409);
    await checkStock();
    console.log('PASS: mismatched/mixed brands and overselling cannot change either brand stock');

    const sold = await api(jobs, order, 'POST', 201);
    await checkStock(9, 1);
    assert.equal(sold.sale.items[0].name.split('สยาม').length - 1, 1);
    await api(`${jobs}/${sold.sale.id}/cancel`, { reason: 'ทดสอบคืนสต็อกแยกยี่ห้อ' });
    await checkStock();
    await api(`${jobs}/${sold.sale.id}/cancel`, { reason: 'ต้องไม่คืนสต็อกซ้ำ' }, 'POST', 409);
    await checkStock();
    const pttSale = await api(jobs, { ...order, brand: 'ปตท', items: [{ id: 'PTT-15', quantity: 1 }] }, 'POST', 201);
    const pttStock = (await api('/api/gas/items')).find(item => item.id === 'PTT-15');
    assert.equal(pttStock.fullStock, 9);
    assert.equal(pttStock.emptyStock, 1);
    assert.equal((await api('/api/gas/items')).find(item => item.id === 'SIAM-15').fullStock, 10);
    await api(`${jobs}/${pttSale.sale.id}/cancel`, { reason: 'ทดสอบคืนสต็อก ปตท.' });
    await checkStock();
    console.log('PASS: sale deducts only Siam, returned empty belongs to Siam, cancellation restores exact stock once');
    await stop();
    await start();
    await checkStock();
    console.log('PASS: brand/stock persist and migration remains idempotent after restart');
})().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(async () => {
    await stop();
    if (client) await client.end();
    if (created && /^tingkum_brand_test_[0-9a-f]{12}$/.test(database)) {
        await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
    }
    await admin.end();
});
