// Integration test: creates and removes only its own random LOCAL database.
// Run from the backend repository: node scripts/test-dashboard-transfers.cjs
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
const database = `tingkum_analytics_test_${crypto.randomBytes(6).toString('hex')}`;
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
        DEFAULT_OWNER_USERNAME: 'analytics_qa', DEFAULT_OWNER_PASSWORD: password, TZ: 'Asia/Bangkok' };
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

(async () => {
    await admin.connect();
    await admin.query(`CREATE DATABASE ${database}`);
    created = true;
    client = new Client({ ...connection, database });
    await client.connect();
    await start();
    token = (await api('/api/auth/login', { username: 'analytics_qa', password })).token;
    const { session_id: sessionId } = await api('/api/app-sessions/today');
    await api(`/api/app-sessions/${sessionId}/open`, {});
    const route = `/api/app-sessions/${sessionId}/transfers`;
    const fixtures = [
        ['previousDay', '2026-11-24T16:59:59Z'],
        ['dayStart', '2026-11-24T17:00:00Z'],
        ['cancelled', '2026-11-25T16:59:59Z'],
        ['nextDay', '2026-11-25T17:00:00Z'],
        ['monthStart', '2026-10-31T17:00:00Z'],
        ['previousMonth', '2026-10-31T16:59:59Z'],
        ['yearStart', '2025-12-31T17:00:00Z'],
        ['nextYear', '2026-12-31T17:00:00Z'],
    ];
    const ids = {};
    for (const [label, timestamp] of fixtures) {
        const id = crypto.randomUUID();
        ids[label] = id;
        const record = await api(route, {
            id, principal: 100000, fee: 1050, cashReceived: 120000,
            bank: 'KBANK', reference: '', note: 'local analytics test',
        }, 'POST', 201);
        assert.equal(record.change, 18950);
        if (label === 'cancelled') await api(`${route}/${id}/cancel`, { reason: 'test cancellation' });
        await client.query('UPDATE cash_transfers SET created_at = $1 WHERE id = $2', [timestamp, id]);
    }
    await client.query(`INSERT INTO sales_records
        (id,session_id,channel,created_at,customer_name,staff_name,payment_method,status,items,subtotal,total)
        VALUES ('POS-TEST',$1,'POS','2026-11-24T17:00:00Z','QA','Owner','เงินสด','สำเร็จ','[]',250,250)`, [sessionId]);
    const day = await api('/api/analytics/sales?period=day&date=2026-11-25');
    assert.deepEqual(new Set(day.transfers.map(row => row.id)), new Set([ids.dayStart, ids.cancelled]));
    assert.equal(day.sales.length, 1);
    assert.equal(day.sales[0].total, 250);
    assert.equal(day.transfers.find(row => row.id === ids.dayStart).staff, 'Owner');
    const valid = day.transfers.filter(row => !row.cancelledAt);
    assert.equal(valid.length, 1);
    assert.equal(valid[0].principal, 100000);
    assert.equal(valid[0].fee, 1050);
    assert.equal(valid[0].change, 18950);
    assert.equal(day.sales[0].total + valid[0].fee / 100, 260.5);
    console.log('PASS: Bangkok daily boundaries, separate satang amounts, staff, cancelled status, and no duplicate transfer sales');
    const month = await api('/api/analytics/sales?period=month&month=2026-11');
    assert.deepEqual(new Set(month.transfers.map(row => row.id)), new Set([
        ids.previousDay, ids.dayStart, ids.cancelled, ids.nextDay, ids.monthStart,
    ]));
    const year = await api('/api/analytics/sales?period=year&year=2026');
    assert.equal(year.transfers.length, 7);
    assert(!year.transfers.some(row => row.id === ids.nextYear));
    assert(year.transfers.some(row => row.id === ids.yearStart));
    const empty = await api('/api/analytics/sales?period=day&date=2000-01-01');
    assert.deepEqual(empty.transfers, []);
    assert.deepEqual(empty.sales, []);
    console.log('PASS: Bangkok month/year boundaries and empty ranges');
})().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(async () => {
    await stop();
    if (client) await client.end();
    if (created && /^tingkum_analytics_test_[0-9a-f]{12}$/.test(database)) {
        await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
    }
    await admin.end();
});
