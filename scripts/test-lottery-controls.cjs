// Integration test: creates and removes only its own random LOCAL database.
// Run from the backend repository: node scripts/test-user-passwords.cjs
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
const database = `tingkum_lottery_test_${crypto.randomBytes(6).toString('hex')}`;
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
        DEFAULT_OWNER_USERNAME: 'password_qa', DEFAULT_OWNER_PASSWORD: password, TZ: 'Asia/Bangkok', GAS_VOICE_AI_ENABLED: 'false' };
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
    await admin.connect(); await admin.query(`CREATE DATABASE ${database}`); created = true;
    client = new Client({ ...connection, database }); await client.connect(); await start();
    const owner = await api('/api/auth/login', { username: 'password_qa', password }); token = owner.token;
    const employeePassword = crypto.randomBytes(16).toString('hex');
    await api('/api/users', { username: 'lottery_staff', displayName: 'Lottery Staff QA', password: employeePassword, role: 'user' }, 'POST', 201);
    const employee = await api('/api/auth/login', { username: 'lottery_staff', password: employeePassword });
    const session = 'TK-20261126';
    const cart = `/api/lottery-sessions/${session}/cart`;
    const sales = `/api/app-sessions/${session}/sales`;
    const checkout = `/api/app-sessions/${session}/lottery/checkout`;
    const confirm = id => `/api/app-sessions/${session}/lottery/${id}/confirm`;
    const tickets = () => api('/api/lottery/tickets');
    const byNumber = async number => (await tickets()).find(item => item.number === number);
    await api(`/api/app-sessions/${session}/open`, {});
    await api('/api/lottery/books', { quantity: 2, price: 80 }, 'POST', 201);
    await api('/api/lottery/tickets', { number: '123456', quantity: 3, price: 90 }, 'POST', 201);
    token = employee.token;
    await api('/api/lottery/stock/reset-preview', undefined, 'GET', 403);
    await api('/api/lottery/stock/reset', {}, 'POST', 403);
    await api(`/api/app-sessions/${session}/transfers`, undefined, 'GET', 403);
    await api('/api/analytics/sales', undefined, 'GET', 403);
    await api(`/api/app-sessions/${session}/transfers`, {}, 'POST', 403);
    await api(cart + '/items', { number: '00' }, 'POST', 201);
    const first = (await api(checkout, { cashReceived: 80, status: 'completed', confirmedBy: owner.user.id }, 'POST', 201)).sale;
    assert.equal(first.status, 'รอเจ้าของร้านยืนยัน'); assert.equal(first.cashReceived, 0);
    assert.equal((await api('/api/lottery/pending')).length, 1);
    assert.equal(first.confirmedBy, null); assert.equal(first.submittedBy, employee.user.id);
    await api(checkout, { cashReceived: 80 }, 'POST', 400);
    await api(confirm(first.id), { cashReceived: 80 }, 'POST', 403);
    await api(`${sales}/${first.id}`, { status: 'completed' }, 'PATCH', 403);
    await api(cart + '/items', { number: '01' }, 'POST', 201);
    const second = (await api(checkout, { cashReceived: 80 }, 'POST', 201)).sale;
    await api(cart + '/items', { number: '02' }, 'POST', 201);
    token = owner.token;
    await api(`${sales}/${first.id}`, { status: 'completed' }, 'PATCH', 409);
    await api(confirm(first.id), {}, 'POST', 400);
    await api(confirm(first.id), { cashReceived: 79 }, 'POST', 400);
    const closing = await api(`/api/app-sessions/${session}/closing-summary`);
    assert.equal(closing.sections.lottery.total, 0);
    await api(`/api/app-sessions/${session}/close`, {}, 'POST', 409);
    console.log('PASS: staff submit pending orders but cannot approve cash, reset stock or access transfers; pending orders block close and are excluded from totals');
    const oldPreview = await api('/api/lottery/stock/reset-preview');
    assert.equal(oldPreview.total, 198); assert.equal(oldPreview.pendingCount, 2);
    await api('/api/lottery/books', { quantity: 1, price: 80 }, 'POST', 201);
    const resetBody = preview => ({ confirm: 'RESET_LOTTERY_STOCK', expectedVersion: preview.version, reason: 'QA change draw' });
    await api('/api/lottery/stock/reset', resetBody(oldPreview), 'POST', 409);
    assert.equal((await byNumber('00')).remaining, 2);
    const preview = await api('/api/lottery/stock/reset-preview');
    await api('/api/lottery/stock/reset', { ...resetBody(preview), confirm: '' }, 'POST', 400);
    const reset = await api('/api/lottery/stock/reset', resetBody(preview));
    assert.equal(reset.cleared, 298); assert.equal(reset.pendingCount, 2);
    assert((await tickets()).filter(t => t.number.length === 2).every(t => t.remaining === 0 && t.stockReference === 0));
    assert.equal((await byNumber('123456')).remaining, 3);
    assert.equal((await api(cart)).items.length, 0);
    await api('/api/app-sessions/TK-20261127/open', {});
    const queue = await api('/api/lottery/pending'); assert.equal(queue.length, 2); assert.equal(queue[0].sessionId, session);
    const history = await api(sales); assert(history.find(s => s.id === first.id)); assert(history.find(s => s.id === second.id));
    console.log('PASS: manual draw reset rejects stale review, clears 00-99 and unsubmitted cart only, preserves six-digit stock, history and pending approvals');
    const approved = await api(confirm(first.id), { cashReceived: 100 });
    assert.equal(approved.confirmedBy, owner.user.id); assert.equal(approved.cashReceived, 100); assert.equal(approved.change, 20);
    assert.equal(approved.submittedBy, employee.user.id); assert(approved.confirmedAt);
    await api(confirm(first.id), { cashReceived: 100 }, 'POST', 409);
    assert.equal((await api(`/api/app-sessions/${session}/closing-summary`)).sections.lottery.total, 80);
    await api('/api/lottery/books', { quantity: 1, price: 80 }, 'POST', 201);
    await api(`${sales}/${second.id}/cancel`, { reason: 'QA cancel previous draw' });
    assert.equal((await byNumber('01')).remaining, 1);
    // Simulate a legacy sale with no movement ledger: fallback must respect generations.
    await client.query("DELETE FROM inventory_movements WHERE source_type = 'LOTTERY_SALE' AND source_id = $1", [first.id]);
    await api(`${sales}/${first.id}/cancel`, { reason: 'QA legacy previous draw cancellation' });
    assert.equal((await byNumber('00')).remaining, 1);
    token = employee.token;
    await api(cart + '/items', { number: '00' }, 'POST', 201);
    const current = (await api(checkout, { cashReceived: 80 }, 'POST', 201)).sale;
    token = owner.token;
    await api(`${sales}/${current.id}/cancel`, { reason: 'QA cancel current draw' });
    assert.equal((await byNumber('00')).remaining, 1);
    console.log('PASS: owner records actual cash and approval once; old-draw cancellations never contaminate new stock, current-draw cancellations restore stock');
    const latest = await api('/api/lottery/stock/reset-preview');
    await api('/api/lottery/stock/reset', resetBody(latest));
    await stop(); await start();
    assert((await tickets()).filter(t => t.number.length === 2).every(t => t.remaining === 0 && t.stockReference === 0));
    await api('/api/lottery/books', { quantity: 1, price: 80 }, 'POST', 201);
    token = employee.token; await api(cart + '/items', { number: '00' }, 'POST', 201);
    const submit = () => fetch(base + checkout, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ cashReceived: 80 }) }).then(r => r.status);
    assert.deepEqual((await Promise.all([submit(), submit()])).sort(), [201, 400]);
    assert.equal((await byNumber('00')).remaining, 0);
    const { rows: [count] } = await client.query("SELECT COUNT(*)::int AS n FROM sales_records WHERE status = 'รอเจ้าของร้านยืนยัน'");
    assert.equal(count.n, 1);
    const { rows: audit } = await client.query("SELECT action, entity_type FROM audit_logs WHERE action = 'RESET_STOCK'");
    assert.equal(audit.length, 2);
    console.log('PASS: restart preserves cleared stock references, concurrent checkout reserves stock once, and draw resets retain audit evidence');
})().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(async () => {
    await stop(); if (client) await client.end();
    if (created && /^tingkum_lottery_test_[0-9a-f]{12}$/.test(database)) await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
    await admin.end();
});

