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
const database = `tingkum_password_test_${crypto.randomBytes(6).toString('hex')}`;
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
        DEFAULT_OWNER_USERNAME: 'password_qa', DEFAULT_OWNER_PASSWORD: password, TZ: 'Asia/Bangkok' };
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
    const login = async (username, password, expected = 200) => api('/api/auth/login', { username, password }, 'POST', expected);
    const owner = await login('password_qa', password);
    const ownerOther = await login('password_qa', password);
    token = owner.token;
    const initial = crypto.randomBytes(24).toString('hex');
    const ownNew = crypto.randomBytes(24).toString('hex');
    const resetNew = crypto.randomBytes(24).toString('hex');
    const ownerNew = crypto.randomBytes(24).toString('hex');
    const user = await api('/api/users', { username: 'employee', displayName: 'Employee QA', password: initial, role: 'user' }, 'POST', 201);
    const employee = await login('employee', initial);
    const employeeOther = await login('employee', initial);
    const assertSession = async (sessionToken, expected) => { const previous = token; token = sessionToken; await api('/api/auth/me', undefined, 'GET', expected); token = previous; };
    token = employee.token;
    await api('/api/users', undefined, 'GET', 403);
    await api(`/api/users/${owner.user.id}`, { password: 'unauthorized' }, 'PATCH', 403);
    await api(`/api/users/${user.id}`, { password: 'unauthorized' }, 'PATCH', 403);
    await api('/api/auth/password', { currentPassword: 'wrong', newPassword: ownNew }, 'PATCH', 401);
    await assertSession(employee.token, 200);
    await api('/api/auth/password', { currentPassword: initial, newPassword: ownNew }, 'PATCH');
    await assertSession(employee.token, 200);
    await assertSession(employeeOther.token, 401);
    await login('employee', initial, 401);
    const afterOwnChange = await login('employee', ownNew);
    console.log('PASS: employees cannot administer passwords; own password requires the old password and revokes other sessions');

    token = owner.token;
    await api(`/api/users/${user.id}`, { password: 'short' }, 'PATCH', 400);
    await api(`/api/users/${user.id}`, { password: 'x'.repeat(257) }, 'PATCH', 400);
    await assertSession(afterOwnChange.token, 200);
    await api('/api/users/999999', { password: resetNew }, 'PATCH', 404);
    const result = await api(`/api/users/${user.id}`, { password: resetNew }, 'PATCH');
    assert.equal(result.role, 'user');
    assert.equal(result.active, true);
    assert(!('password' in result || 'password_hash' in result || 'password_salt' in result));
    await assertSession(employee.token, 401);
    await assertSession(afterOwnChange.token, 401);
    await assertSession(owner.token, 200);
    await login('employee', ownNew, 401);
    await login('employee', resetNew);
    console.log('PASS: owner reset works without old password; all target sessions are revoked; invalid input changes nothing');

    await api(`/api/users/${owner.user.id}`, { password: ownerNew }, 'PATCH');
    await assertSession(owner.token, 200);
    await assertSession(ownerOther.token, 401);
    await login('password_qa', password, 401);
    const ownerRelogin = await login('password_qa', ownerNew);
    token = ownerRelogin.token;
    const listing = await api('/api/users');
    assert(listing.every(row => !('password' in row || 'password_hash' in row || 'password_salt' in row)));
    const { rows } = await client.query('SELECT before_data, after_data, reason FROM audit_logs');
    const audit = JSON.stringify(rows);
    for (const secret of [password, initial, ownNew, resetNew, ownerNew]) assert(!audit.includes(secret));
    const { rows: hashes } = await client.query('SELECT password_hash, password_salt FROM app_users');
    assert(hashes.every(row => row.password_salt && row.password_hash.length === 128));
    console.log('PASS: owner self-reset retains only current session; new login works; API and audit never expose passwords');
})().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(async () => {
    await stop();
    if (client) await client.end();
    if (created && /^tingkum_password_test_[0-9a-f]{12}$/.test(database)) {
        await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
    }
    await admin.end();
});
