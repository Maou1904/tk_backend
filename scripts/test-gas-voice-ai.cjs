// Local inference relay tests: ephemeral signing keys, no provider or DB calls.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createGasVoiceAI, registerGasVoiceAI, registerGasVoiceWorker, validateExtraction } = require('../gas-voice-ai');
const { signWorkerRequest, createWorkerAuthenticator } = require('../gas-voice-worker-auth');
const { createLocalInterpreter } = require('../gas-voice-local');
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const publicText = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const env = { GAS_VOICE_AI_ENABLED: 'true', GAS_VOICE_WORKER_PUBLIC_KEY: publicText };
const worker = 'a'.repeat(32);
const text = 'ส่งปตทถังใหญ่ 2 ถัง ถังเล็ก 1 ถังให้คุณเจเจที่ดอนภูตา';
const raw = { brand: 'ปตท', items: [{ sizeKg: 15, quantity: 2 }, { sizeKg: 4, quantity: 1 }], customerName: 'คุณเจเจ', address: 'ดอนภูตา', phone: null, needsClarification: [] };
const headers = (route, body, time) => Object.fromEntries(Object.entries(signWorkerRequest(privateKey, route, body, time)).map(([key, value]) => [key.toLowerCase(), value]));
async function answer(service, value = raw) { const job = await service.poll(worker); service.complete(job.id, worker, value); return job; }

test('old Cloudflare credentials never enable inference and missing/invalid public keys fail closed', async () => {
    for (const config of [{}, { ...env, GAS_VOICE_AI_ENABLED: 'false' }, { ...env, GAS_VOICE_WORKER_PUBLIC_KEY: 'invalid' },
        { GAS_VOICE_AI_ENABLED: 'true', GAS_VOICE_AI_FREE_PLAN_CONFIRMED: 'true', CLOUDFLARE_API_TOKEN: 'unused', CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32) }]) {
        const service = createGasVoiceAI({ env: config });
        assert.deepEqual(service.status(), { enabled: false, provider: 'rules' });
        await assert.rejects(service.parse(text, 1), error => error.status === 503);
    }
});
test('signatures bind route, timestamp, nonce and exact body; invalid/stale/replayed requests cannot claim jobs', () => {
    let time = Date.now(); const auth = createWorkerAuthenticator(publicText, () => time);
    const body = { workerId: worker, ready: true }, signed = headers('heartbeat', body, time);
    assert.equal(auth.verify('result', body, signed), false);
    assert.equal(auth.verify('heartbeat', { ...body, ready: false }, signed), false);
    assert.equal(auth.verify('heartbeat', body, signed), true);
    assert.equal(auth.verify('heartbeat', body, signed), false);
    const stale = headers('heartbeat', body, time); time += 31000;
    assert.equal(auth.verify('heartbeat', body, stale), false);
    assert.equal(auth.verify('heartbeat', body, {}), false);
});
test('PC connects, receives one short-lived order, and validated local output returns to the requester', async () => {
    const service = createGasVoiceAI({ env });
    assert.equal(service.status().enabled, false); service.heartbeat(worker, true);
    const result = service.parse(text, 1); const job = await answer(service);
    assert.equal(job.text, text); assert.deepEqual(Object.keys(job).sort(), ['id', 'text']);
    assert.equal((await result).customerName, 'คุณเจเจ');
    assert.deepEqual(service.status(), { enabled: true, provider: 'local' });
    assert.throws(() => service.complete(job.id, worker, raw), error => error.status === 410);
});
test('heartbeat expiry, reported model failure and a fresh server switch to rules until reconnection', async () => {
    let time = Date.now(); const service = createGasVoiceAI({ env, now: () => time });
    service.heartbeat(worker, true); time += 8000; assert.equal(service.status().enabled, false);
    await assert.rejects(service.parse(text, 1), error => error.status === 503);
    service.heartbeat(worker, true); const result = service.parse(text, 1);
    const rejected = assert.rejects(result, error => error.status === 503);
    service.heartbeat(worker, false); await rejected;
    service.heartbeat(worker, true); assert.equal(service.status().enabled, true);
    assert.equal(createGasVoiceAI({ env }).status().enabled, false);
});
test('timeout/cancellation discard jobs, ignore late results and never apply a draft twice', async () => {
    const service = createGasVoiceAI({ env, requestTimeoutMs: 25 }); service.heartbeat(worker, true);
    const timed = service.parse(text, 1); const rejection = assert.rejects(timed, error => error.code === 'VOICE_AI_TIMEOUT');
    const job = await service.poll(worker); await rejection;
    assert.equal(service.status().enabled, false);
    assert.throws(() => service.complete(job.id, worker, raw), error => error.status === 410);
    service.heartbeat(worker, true); const controller = new AbortController();
    const cancelled = service.parse(text, 1, controller.signal); const cancelledCheck = assert.rejects(cancelled, error => error.code === 'VOICE_AI_CANCELLED');
    const next = await service.poll(worker); controller.abort(); await cancelledCheck;
    assert.throws(() => service.complete(next.id, worker, raw), error => error.status === 410);
    const pollAbort = new AbortController(); const poll = service.poll(worker, pollAbort.signal); pollAbort.abort(); assert.equal(await poll, null);
});
test('wrong worker and invented model output never update the draft', async () => {
    const service = createGasVoiceAI({ env }); service.heartbeat(worker, true);
    const result = service.parse(text, 1); const rejection = assert.rejects(result, error => error.code === 'VOICE_AI_INVALID');
    const job = await service.poll(worker);
    assert.throws(() => service.complete(job.id, 'b'.repeat(32), raw), error => error.status === 410);
    service.complete(job.id, worker, { ...raw, address: 'กรุงเทพ' }); await rejection;
});
test('short queues and per-user rate limits release after completion; there is no daily cloud quota', async () => {
    let time = Date.now(); const service = createGasVoiceAI({ env, now: () => time }); service.heartbeat(worker, true);
    const first = service.parse(text, 1), second = service.parse(text, 2);
    await assert.rejects(service.parse(text, 3), error => error.status === 429);
    await answer(service); await first; await answer(service); await second;
    for (let i = 0; i < 105; i++) {
        if (i % 15 === 0) { time += 60000; service.heartbeat(worker, true); }
        const result = service.parse(text, 1); await answer(service); await result;
    }
    time += 60000; service.heartbeat(worker, true);
    for (let i = 0; i < 20; i++) { const result = service.parse(text, 1); await answer(service); await result; }
    await assert.rejects(service.parse(text, 1), error => error.status === 429);
});
test('Ollama calls stay on loopback, have bounded JSON output and validate complete responses', async () => {
    const calls = []; const interpreter = createLocalInterpreter({ fetchImpl: async (url, options) => {
        calls.push(url); assert(url.startsWith('http://127.0.0.1:11434/api/'));
        if (url.endsWith('/ps')) return { ok: true, json: async () => ({ models: [{ name: 'qwen3:4b' }] }) };
        const body = JSON.parse(options.body); assert.equal(body.model, 'qwen3:4b');
        if (url.endsWith('/chat')) { assert.equal(body.think, false); assert.equal(body.options.num_predict, 384);
            const value = body.messages[1].content === text ? raw : { ...raw, items: [{ sizeKg: 15, quantity: 1 }], customerName: null, address: null };
            return { ok: true, json: async () => ({ done_reason: 'stop', message: { content: JSON.stringify(value) } }) }; }
        return { ok: true, json: async () => ({}) };
    } });
    await interpreter.warm(); assert.equal(interpreter.ready(), true);
    assert.equal(await interpreter.check(new AbortController().signal), true);
    assert.deepEqual(await interpreter.extract(text), raw); assert(calls.length >= 4);
});
test('worker endpoints enforce signatures and cannot use that identity for app or sales access', async () => {
    const app = require('express')(); app.use(require('express').json());
    const service = createGasVoiceAI({ env }); registerGasVoiceWorker(app, service);
    app.use('/api', (req, res, next) => { if (req.headers.authorization !== 'Bearer test-app-session') return res.status(401).json({ error: 'App login required' }); req.user = { id: 1 }; next(); });
    registerGasVoiceAI(app, service); app.post('/api/sales', (_req, res) => res.json({ accepted: true }));
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        const body = { workerId: worker, ready: true };
        const signed = signWorkerRequest(privateKey, 'heartbeat', body);
        const call = (route, data, extra) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(data) });
        assert.equal((await call('/api/gas/voice/worker/heartbeat', body, {})).status, 401);
        assert.equal((await call('/api/gas/voice/worker/heartbeat', body, signed)).status, 200);
        assert.equal((await call('/api/gas/voice/worker/heartbeat', body, signed)).status, 401);
        assert.equal((await call('/api/sales', body, signWorkerRequest(privateKey, 'sales', body))).status, 401);
        assert.equal((await fetch(base + '/api/gas/voice/status')).status, 401);
        const appHeaders = { Authorization: 'Bearer test-app-session' };
        const parsed = call('/api/gas/voice/parse', { text }, appHeaders);
        const jobBody = { workerId: worker };
        const polled = await call('/api/gas/voice/worker/next', jobBody, signWorkerRequest(privateKey, 'next', jobBody));
        const { job } = await polled.json(); const resultBody = { workerId: worker, id: job.id, extraction: raw };
        assert.equal((await call('/api/gas/voice/worker/result', resultBody, signWorkerRequest(privateKey, 'result', resultBody))).status, 200);
        const response = await parsed; assert.equal(response.status, 200); assert.equal((await response.json()).source, 'local');
    } finally { await new Promise(resolve => server.close(resolve)); }
});
test('location-only inputs label both fields, unspecified identity and counts stay absent', () => {
    const draft = validateExtraction({ ...raw, items: [{ sizeKg: 15, quantity: null }], customerName: null, address: 'หลังวัด' }, 'ปตท ถังใหญ่ส่งที่หลังวัด');
    assert.equal(draft.customerName, 'หลังวัด');
    assert.equal(draft.address, 'หลังวัด');
    assert.deepEqual(draft.items, [{ sizeKg: 15 }]);
    const missing = validateExtraction({ ...raw, customerName: null, address: null }, 'ปตท ถังใหญ่ 2 ถัง ถังเล็ก 1 ถัง');
    assert.equal(missing.customerName, undefined);
    assert.equal(missing.address, undefined);
});

test('invented places, invalid counts, duplicate sizes and extra action fields are rejected', () => {
    for (const changed of [
        { address: 'กรุงเทพมหานคร' }, { customerName: 'คุณสมชาย' },
        { price: 1 }, { paid: true }, { driver: 'someone' },
        { items: [{ sizeKg: 48, quantity: 1 }] },
        { items: [{ sizeKg: 15, quantity: 0 }] },
        { items: [{ sizeKg: 15, quantity: 1.5 }] },
        { items: [{ sizeKg: 15, quantity: 1001 }] },
        { items: [{ sizeKg: 15, quantity: 2 }, { sizeKg: 15, quantity: 1 }] },
        { items: [{ sizeKg: 15, quantity: 2, price: 1 }] },
        { phone: '0812345678' },
    ]) assert.throws(() => validateExtraction({ ...raw, ...changed }, text), error => error.code === 'VOICE_AI_INVALID');
});

test('clarification is returned as a form error instead of changing the meaning of the order', () => {
    const draft = validateExtraction({ ...raw, needsClarification: ['ต้องการยี่ห้อไหนครับ'] }, text);
    assert.deepEqual(draft.errors, ['ต้องการยี่ห้อไหนครับ']);
});
