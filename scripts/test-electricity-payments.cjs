// Integration test: creates and removes only its own random LOCAL database.
// Run from the backend repository: node scripts/test-electricity-payments.cjs
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
const database = `tingkum_electricity_test_${crypto.randomBytes(6).toString('hex')}`;
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
    // Simulate the schema and a transfer recorded before electricity existed.
    const legacy = { id: crypto.randomUUID(), principal: 10000, fee: 1000, cashReceived: 11000, bank: 'KBANK', reference: 'legacy' };
    await api(route, legacy, 'POST', 201);
    await stop();
    await client.query(`ALTER TABLE cash_transfers DROP COLUMN service_type;
        ALTER TABLE transfer_settings DROP COLUMN electricity_fee;
        CREATE UNIQUE INDEX cash_transfers_reference_idx ON cash_transfers (lower(bank), lower(reference))
            WHERE reference <> '' AND cancelled_at IS NULL`);
    await start();
    token = (await api('/api/auth/login', { username: 'analytics_qa', password })).token;
    assert.equal((await api(route)).records[0].serviceType, 'TRANSFER');
    assert.equal((await api(route)).records[0].principal, 10000);
    await api(route, { ...legacy, id: crypto.randomUUID() }, 'POST', 409);
    await api(`${route}/${legacy.id}/cancel`, { reason: 'legacy QA cleanup' });
    const electricityRoute = `/api/app-sessions/${sessionId}/electricity`;
    const defaults = await api('/api/store-settings');
    assert.equal(defaults.electricityFee, 0);
    const settings = { ...defaults, electricityFee: 1550 };
    await api('/api/store-settings', settings, 'PUT');
    assert.equal((await api(electricityRoute)).defaultFee, 1550);
    assert.equal((await api(route)).defaultFee, defaults.defaultFee);
    await api('/api/store-settings', { ...settings, electricityFee: -1 }, 'PUT', 400);
    const ownerToken = token;
    await api('/api/users', { username: 'electricity_staff', displayName: 'Staff QA', password, role: 'user' }, 'POST', 201);
    token = (await api('/api/auth/login', { username: 'electricity_staff', password })).token;
    await api(electricityRoute, undefined, 'GET', 403);
    await api(electricityRoute, { id: crypto.randomUUID(), principal: 100, fee: 0, cashReceived: 100 }, 'POST', 403);
    await api('/api/store-settings', settings, 'PUT', 403);
    token = ownerToken;
    const payment = { id: crypto.randomUUID(), principal: 123456, fee: 1550, cashReceived: 130000, reference: 'same-meter', note: 'electricity QA' };
    await api(electricityRoute, { ...payment, cashReceived: 125005 }, 'POST', 400);
    await api(electricityRoute, { ...payment, principal: 123.45 }, 'POST', 400);
    const record = await api(electricityRoute, payment, 'POST', 201);
    assert.equal(record.serviceType, 'ELECTRICITY');
    assert.equal(record.change, 4994);
    await api(electricityRoute, payment, 'POST', 201);
    assert.equal((await api(electricityRoute)).records.length, 1);
    await api(electricityRoute, { ...payment, fee: 0 }, 'POST', 409);
    await api(route, payment, 'POST', 400);
    await api(route, { ...payment, bank: 'KBANK' }, 'POST', 409);
    await api(`${route}/${payment.id}/cancel`, { reason: 'wrong service' }, 'POST', 404);
    const second = { ...payment, id: crypto.randomUUID() };
    await api(electricityRoute, second, 'POST', 201);
    await api(route, { ...payment, id: crypto.randomUUID(), bank: 'KBANK' }, 'POST', 201);
    assert.equal((await api(route)).totals.count, 1);
    assert.equal((await api(electricityRoute)).totals.count, 2);
    let closing = await api(`/api/app-sessions/${sessionId}/closing-summary`);
    assert.equal(closing.sections.electricity.principal, 246912);
    assert.equal(closing.sections.transfers.principal, 123456);
    assert(closing.checks.some(check => check.section === 'ELECTRICITY' && !check.confirmed));
    await api(`/api/app-sessions/${sessionId}/closing-checks/ELECTRICITY`, { confirmed: true }, 'PATCH');
    await api(`${electricityRoute}/${payment.id}/cancel`, { reason: 'QA cancellation' });
    closing = await api(`/api/app-sessions/${sessionId}/closing-summary`);
    assert.equal(closing.sections.electricity.count, 1);
    assert.equal(closing.sections.electricity.fee, 1550);
    assert(closing.checks.some(check => check.section === 'ELECTRICITY' && !check.confirmed));
    const { rows: [stamp] } = await client.query("SELECT to_char(created_at AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD') AS day FROM cash_transfers WHERE id = $1", [second.id]);
    const analytics = await api(`/api/analytics/sales?period=day&date=${stamp.day}`);
    assert.equal(analytics.transfers.filter(row => row.serviceType === 'ELECTRICITY').length, 2);
    assert.equal(analytics.sales.length, 0);
    const tax = await api(`/api/tax-report?month=${stamp.day.slice(0, 7)}`);
    assert.equal(tax.transfers.filter(row => row.serviceType === 'ELECTRICITY').length, 2);
    await stop(); await start();
    token = (await api('/api/auth/login', { username: 'analytics_qa', password })).token;
    assert.equal((await api(electricityRoute)).totals.count, 1);
    assert.equal((await api('/api/store-settings')).electricityFee, 1550);
    assert.equal((await api(route)).totals.count, 1);
    assert.equal((await client.query("SELECT COUNT(*)::int AS count FROM audit_logs WHERE entity_type = 'ELECTRICITY_PAYMENT'")).rows[0].count, 3);
    console.log('PASS: legacy schema migration and transfer preservation, electricity settings, owner permissions, money validation, idempotency, route isolation, repeat meter IDs, cancellation, closing, reporting and restart persistence');
})().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(async () => {
    await stop();
    if (client) await client.end();
    if (created && /^tingkum_electricity_test_[0-9a-f]{12}$/.test(database)) {
        await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
    }
    await admin.end();
});
