// Real Ollama + real worker process, loopback relay and ephemeral keys only.
// No production request, database, sales write or customer record is involved.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const express = require('express');
const { createGasVoiceAI, registerGasVoiceAI, registerGasVoiceWorker } = require('../gas-voice-ai');
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'tingkum-gas-worker-qa-'));
fs.writeFileSync(path.join(runtime, 'worker-private.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }));
const service = createGasVoiceAI({ env: { GAS_VOICE_AI_ENABLED: 'true', GAS_VOICE_WORKER_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') } });
const app = express(); app.use(express.json()); registerGasVoiceWorker(app, service);
app.use('/api', (req, res, next) => { if (req.headers.authorization !== 'Bearer local-qa') return res.status(401).end(); req.user = { id: 1 }; next(); });
registerGasVoiceAI(app, service);
let server, child;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitReady(expected) {
    for (let i = 0; i < 200; i++) { if (service.status().enabled === expected) return; if (child && child.exitCode !== null && expected) throw new Error('Worker exited'); await wait(100); }
    throw new Error(`Worker readiness did not reach ${expected}`);
}
function start(config) {
    fs.rmSync(path.join(runtime, 'stop'), { force: true });
    child = spawn(process.execPath, [path.join(__dirname, 'gas-voice-worker.cjs')], { windowsHide: true,
        env: { ...process.env, GAS_VOICE_WORKER_RUNTIME_DIR: runtime, GAS_VOICE_WORKER_CONFIG: config }, stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', () => {});
}
(async () => {
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const config = path.join(runtime, 'config.env'); fs.writeFileSync(config, `GAS_VOICE_API_URL=${base}\n`);
    const parse = async text => {
        const start = Date.now(); const res = await fetch(base + '/api/gas/voice/parse', { method: 'POST', headers: { Authorization: 'Bearer local-qa', 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
        return { status: res.status, body: await res.json(), durationMs: Date.now() - start };
    };
    const offline = await parse('ปตท ถังใหญ่ 1 ถัง'); assert.equal(offline.status, 503); assert(offline.durationMs < 500);
    start(config); await waitReady(true);
    const result = await parse('ส่งปตทถังใหญ่ 1 ถังให้คุณเจเจที่ดอนภูตา');
    assert.equal(result.status, 200); assert.equal(result.body.source, 'local');
    assert.equal(result.body.draft.customerName, 'คุณเจเจ'); assert.equal(result.body.draft.address, 'ดอนภูตา');
    console.log(JSON.stringify({ scenario: 'real_worker_round_trip', durationMs: result.durationMs, passed: true }));
    // Unexpected loss of the process must expire readiness, without a shutdown message.
    const killed = once(child, 'exit'); child.kill(); await killed; await waitReady(false);
    assert.equal((await parse('ปตท ถังใหญ่ 1 ถัง')).status, 503);
    start(config); await waitReady(true);
    const again = await parse('ปตท ถังใหญ่ 2 ถัง ส่งที่หลังวัด');
    assert.equal(again.status, 200); assert.equal(again.body.draft.customerName, 'หลังวัด'); assert.equal(again.body.draft.address, 'หลังวัด');
    console.log(JSON.stringify({ scenario: 'restart_reconnect', durationMs: again.durationMs, passed: true }));
    const stopped = once(child, 'exit'); fs.writeFileSync(path.join(runtime, 'stop'), 'stop'); await stopped;
    await waitReady(false);
    const logs = fs.readFileSync(path.join(runtime, 'worker.log'), 'utf8');
    assert(!logs.includes('คุณเจเจ') && !logs.includes('หลังวัด') && !logs.includes('PRIVATE KEY'));
    console.log('PASS: real local worker reconnects after process loss, graceful stop switches to rules, and local logs contain no order content');
})().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(async () => {
    if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    if (server) await new Promise(resolve => server.close(resolve));
    // Only this random, explicitly disposable loopback QA directory is removed.
    if (path.resolve(runtime).startsWith(path.join(os.tmpdir(), 'tingkum-gas-worker-qa-'))) fs.rmSync(runtime, { recursive: true, force: true });
});
