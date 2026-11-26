const { schema, instructions, validateExtraction } = require('./gas-voice-schema');
const MODEL = 'qwen3:4b';
function createLocalInterpreter({ fetchImpl = fetch } = {}) {
    let healthy = false;
    async function call(route, body, signal, timeout) {
        const response = await fetchImpl(`http://127.0.0.1:11434/api/${route}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
            signal: AbortSignal.any([AbortSignal.timeout(timeout), ...(signal ? [signal] : [])]),
        });
        if (!response.ok) throw new Error('Local model unavailable');
        return response.json();
    }
    async function extract(text, signal, timeout = 3500) {
        if (typeof text !== 'string' || !text.trim() || text.length > 1000) throw new Error('Invalid voice text');
        const result = await call('chat', { model: MODEL, stream: false, think: false, format: schema, keep_alive: '10m',
            options: { temperature: 0, num_predict: 384, num_ctx: 4096 },
            messages: [{ role: 'system', content: instructions }, { role: 'user', content: text.trim() }] }, signal, timeout);
        if (result.done_reason !== 'stop') throw new Error('Incomplete local extraction');
        const extraction = JSON.parse(result.message.content);
        validateExtraction(extraction, text.trim());
        return extraction;
    }
    return { model: MODEL, ready: () => healthy,
        async warm(signal) {
            healthy = false;
            await call('generate', { model: MODEL, prompt: '', stream: false, keep_alive: '10m', options: { num_ctx: 4096 } }, signal, 60000);
            await extract('ปตท ถังใหญ่ 1 ถัง', signal, 60000);
            healthy = true;
        },
        async check(signal) {
            try {
                const response = await fetchImpl('http://127.0.0.1:11434/api/ps', { signal: AbortSignal.any([AbortSignal.timeout(1500), signal]) });
                const data = await response.json();
                if (!response.ok || !data.models?.some(item => item.name === MODEL || item.model === MODEL)) healthy = false;
            } catch { healthy = false; }
            return healthy;
        },
        async keepWarm(signal) { await call('generate', { model: MODEL, prompt: '', stream: false, keep_alive: '10m', options: { num_ctx: 4096 } }, signal, 5000); },
        async extract(text, signal) {
            try { return await extract(text, signal); }
            catch (error) { if (error.code !== 'VOICE_AI_INVALID') healthy = false; throw error; }
        },
    };
}
module.exports = { createLocalInterpreter };
