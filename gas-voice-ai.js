// Outbound-only local inference relay. No hosted-model calls or order persistence.
const crypto = require('node:crypto');
const { validateExtraction } = require('./gas-voice-schema');
const { createWorkerAuthenticator } = require('./gas-voice-worker-auth');
const fault = (status, code) => Object.assign(new Error('AI ในคอมยังไม่พร้อม ใช้การแยกคำพื้นฐานได้'), { status, code });
function createGasVoiceAI({ env = process.env, now = Date.now, requestTimeoutMs = 4500,
    heartbeatTtlMs = 7500, pollTimeoutMs = 15000 } = {}) {
    const auth = createWorkerAuthenticator(env.GAS_VOICE_WORKER_PUBLIC_KEY, now);
    const configured = env.GAS_VOICE_AI_ENABLED === 'true' && auth.configured;
    const jobs = new Map(), minutes = new Map();
    let workerId = null, onlineUntil = 0, waiting = null;
    const ready = () => configured && workerId !== null && now() < onlineUntil;
    const offline = () => fault(503, 'VOICE_AI_OFFLINE');
    function settle(job, error, value) {
        if (!jobs.delete(job.id)) return;
        clearTimeout(job.timer); job.signal?.removeEventListener('abort', job.cancel);
        if (error) job.reject(error); else job.resolve(value);
    }
    function dispatch() {
        if (!waiting || !ready()) return;
        const job = [...jobs.values()].find(item => !item.assigned);
        if (job) { job.assigned = workerId; waiting.finish({ id: job.id, text: job.text }); }
    }
    return {
        status: () => ({ enabled: ready(), provider: ready() ? 'local' : 'rules' }),
        authorize: (route, body, headers) => configured && auth.verify(route, body, headers),
        heartbeat(id, healthy) {
            if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id) || typeof healthy !== 'boolean') throw fault(400, 'VOICE_WORKER_INVALID');
            if (id !== workerId || !healthy) {
                for (const job of [...jobs.values()]) settle(job, offline());
                waiting?.finish(null);
            }
            workerId = id; onlineUntil = healthy ? now() + heartbeatTtlMs : 0;
            dispatch(); return { ready: ready() };
        },
        poll(id, signal) {
            if (!ready() || id !== workerId) throw offline();
            if (waiting) throw fault(409, 'VOICE_WORKER_BUSY');
            if (signal?.aborted) return Promise.resolve(null);
            return new Promise(resolve => {
                const finish = value => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); waiting = null; resolve(value); };
                const cancel = () => finish(null);
                const timer = setTimeout(cancel, pollTimeoutMs);
                waiting = { finish }; signal?.addEventListener('abort', cancel, { once: true }); dispatch();
            });
        },
        complete(id, sender, extraction, failed) {
            const job = jobs.get(id);
            if (!job || !job.assigned || job.assigned !== sender || sender !== workerId) throw fault(410, 'VOICE_JOB_EXPIRED');
            if (failed) { settle(job, fault(502, 'VOICE_AI_UNAVAILABLE')); return; }
            try { settle(job, null, validateExtraction(extraction, job.text)); }
            catch (error) { settle(job, error); }
        },
        async parse(text, userId, signal) {
            if (typeof text !== 'string' || !text.trim() || text.length > 1000) throw fault(400, 'VOICE_TEXT_INVALID');
            if (!ready()) throw offline();
            if (signal?.aborted) throw fault(499, 'VOICE_AI_CANCELLED');
            const minute = Math.floor(now() / 60000);
            for (const [id, entry] of minutes) if (entry.minute !== minute) minutes.delete(id);
            const user = minutes.get(userId) || { minute, count: 0 };
            if (user.count >= 20 || jobs.size >= 2) throw fault(429, 'VOICE_AI_LIMIT');
            user.count++; minutes.set(userId, user);
            return new Promise((resolve, reject) => {
                const job = { id: crypto.randomUUID(), text: text.trim(), resolve, reject, signal, assigned: null };
                job.cancel = () => settle(job, fault(499, 'VOICE_AI_CANCELLED'));
                job.timer = setTimeout(() => { onlineUntil = 0; settle(job, fault(504, 'VOICE_AI_TIMEOUT')); }, requestTimeoutMs);
                jobs.set(job.id, job); signal?.addEventListener('abort', job.cancel, { once: true }); dispatch();
            });
        },
    };
}

// These signed endpoints are registered before ordinary app authentication. The
// PC's identity grants inference-job access only, never access to sales or users.
function registerGasVoiceWorker(app, service) {
    const route = (name, action) => app.post(`/api/gas/voice/worker/${name}`, async (req, res) => {
        if (!service.authorize(name, req.body, req.headers)) return res.status(401).json({ error: 'Worker authentication required' });
        const controller = new AbortController();
        const cancel = () => { if (!res.writableEnded) controller.abort(); };
        res.once('close', cancel);
        try { const result = await action(req.body, controller.signal); if (!controller.signal.aborted) res.json(result); }
        catch (error) { if (!controller.signal.aborted) res.status(error.status || 502).json({ code: error.code || 'VOICE_AI_UNAVAILABLE' }); }
        finally { res.off('close', cancel); }
    });
    route('heartbeat', body => service.heartbeat(body.workerId, body.ready));
    route('next', async (body, signal) => ({ job: await service.poll(body.workerId, signal) }));
    route('result', body => { service.complete(body.id, body.workerId, body.extraction, body.failed); return { accepted: true }; });
}
function registerGasVoiceAI(app, service = createGasVoiceAI()) {
    app.get('/api/gas/voice/status', (_req, res) => { res.set('Cache-Control', 'no-store'); res.json(service.status()); });
    app.post('/api/gas/voice/parse', async (req, res) => {
        const controller = new AbortController();
        const cancel = () => { if (!res.writableEnded) controller.abort(); };
        res.once('close', cancel);
        try { const draft = await service.parse(req.body?.text, req.user.id, controller.signal); if (!controller.signal.aborted) res.json({ source: 'local', draft }); }
        catch (error) { if (!controller.signal.aborted) res.status(error.status || 502).json({ code: error.code || 'VOICE_AI_UNAVAILABLE', error: error.message }); }
        finally { res.off('close', cancel); }
    });
}
module.exports = { createGasVoiceAI, registerGasVoiceAI, registerGasVoiceWorker, validateExtraction };
