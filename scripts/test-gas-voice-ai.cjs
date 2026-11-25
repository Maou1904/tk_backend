// Pure provider tests: fake credentials, mocked fetch, no external calls or database.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createGasVoiceAI, validateExtraction } = require('../gas-voice-ai');
const env = { GAS_VOICE_AI_ENABLED: 'true', GAS_VOICE_AI_FREE_PLAN_CONFIRMED: 'true', CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: 'test-only-token' };
const text = 'ส่งปตทถังใหญ่ 2 ถัง ถังเล็ก 1 ถังให้คุณเจเจที่ดอนภูตา';
const raw = { brand: 'ปตท', items: [{ sizeKg: 15, quantity: 2 }, { sizeKg: 4, quantity: 1 }], customerName: 'คุณเจเจ', address: 'ดอนภูตา', phone: null, needsClarification: [] };
const reply = (value = raw) => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(value) } }] }) });

test('disabled or unconfirmed setup cannot send customer text to any provider', async () => {
    for (const config of [{}, { ...env, GAS_VOICE_AI_ENABLED: 'false' }, { ...env, GAS_VOICE_AI_FREE_PLAN_CONFIRMED: 'false' }, { ...env, CLOUDFLARE_API_TOKEN: '' }]) {
        let called = false;
        const service = createGasVoiceAI({ env: config, fetchImpl: async () => { called = true; return reply(); } });
        assert.deepEqual(service.status(), { enabled: false, provider: 'rules' });
        await assert.rejects(service.parse(text, 1), error => error.code === 'VOICE_AI_NOT_CONFIGURED');
        assert.equal(called, false);
    }
});

test('configured extraction has bounded structured output and sends only the stated text', async () => {
    const service = createGasVoiceAI({ env, fetchImpl: async (url, options) => {
        assert.equal(url, `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/v1/chat/completions`);
        const body = JSON.parse(options.body);
        assert.equal(body.model, '@cf/qwen/qwen3.8-27b');
        assert.equal(body.max_completion_tokens, 1024);
        assert.equal(body.response_format.type, 'json_schema');
        assert.equal(body.messages[1].content, text);
        assert.equal(body.messages.length, 2);
        assert.equal(JSON.stringify(body).includes('test-only-token'), false);
        return reply();
    } });
    const draft = await service.parse(text, 1);
    assert.deepEqual(draft.items, raw.items);
    assert.equal(draft.customerName, 'คุณเจเจ');
    assert.equal(draft.address, 'ดอนภูตา');
    assert.equal(JSON.stringify(service.status()).includes('test-only-token'), false);
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

test('quota, invalid JSON and network errors expose no provider content or token', async () => {
    for (const fetchImpl of [
        async () => ({ ok: false, status: 429 }),
        async () => ({ ok: false, status: 403 }),
        async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'not JSON' } }] }) }),
        async () => { throw new Error('secret-provider-payload test-only-token'); },
    ]) {
        const service = createGasVoiceAI({ env, fetchImpl });
        await assert.rejects(service.parse(text, 1), error => {
            assert.equal(error.message.includes('test-only-token'), false);
            assert.equal(error.message.includes('secret-provider-payload'), false);
            return error.code === 'VOICE_AI_UNAVAILABLE';
        });
    }
});

test('invalid user text does not consume an inference request', async () => {
    let calls = 0;
    const service = createGasVoiceAI({ env, fetchImpl: async () => { calls++; return reply(); } });
    for (const value of ['', ' ', null, {}, 'a'.repeat(1001)]) await assert.rejects(service.parse(value, 1), error => error.status === 400);
    assert.equal(calls, 0);
});

test('failure diagnostics contain only safe status, numeric codes and timing', async () => {
    const entries = [];
    const service = createGasVoiceAI({ env, reportFailure: entry => entries.push(entry), fetchImpl: async () => ({
        ok: false, status: 400, json: async () => ({ errors: [
            { code: 5004, message: `${text} test-only-token` }, { code: 'test-only-token' },
        ] }),
    }) });
    await assert.rejects(service.parse(text, 1));
    assert.equal(entries[0].providerStatus, 400);
    assert.deepEqual(entries[0].providerCodes, [5004]);
    assert.equal(JSON.stringify(entries).includes('test-only-token'), false);
    assert.equal(JSON.stringify(entries).includes('คุณเจเจ'), false);
});

test('rate and daily limits block requests before sending them, then reset on the next UTC day', async () => {
    let time = Date.UTC(2026, 10, 25);
    let calls = 0;
    const service = createGasVoiceAI({ env, now: () => time, fetchImpl: async () => { calls++; return reply(); } });
    for (let i = 0; i < 10; i++) await service.parse(text, 1);
    await assert.rejects(service.parse(text, 1), error => error.status === 429);
    assert.equal(calls, 10);
    for (let i = 10; i < 100; i++) {
        time += 60000;
        await service.parse(text, 1);
    }
    await assert.rejects(service.parse(text, 2), error => error.status === 429);
    assert.equal(calls, 100);
    time += 86400000;
    await service.parse(text, 1);
    assert.equal(calls, 101);
});

test('concurrency is bounded and released after completion', async () => {
    const resolve = [];
    const service = createGasVoiceAI({ env, fetchImpl: () => new Promise(done => resolve.push(done)) });
    const first = service.parse(text, 1);
    const second = service.parse(text, 2);
    await assert.rejects(service.parse(text, 3), error => error.status === 429);
    resolve[0](reply());
    resolve[1](reply());
    await Promise.all([first, second]);
    const third = service.parse(text, 3);
    resolve[2](reply());
    await third;
});
