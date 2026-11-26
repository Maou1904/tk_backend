// No inbound server, account password, database credential, or order log.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { createLocalInterpreter } = require('../gas-voice-local');
const { signWorkerRequest } = require('../gas-voice-worker-auth');
const root = path.join(__dirname, '..');
const runtime = process.env.GAS_VOICE_WORKER_RUNTIME_DIR || path.join(root, 'pids', 'gas-ai');
const config = require('dotenv').parse(fs.readFileSync(process.env.GAS_VOICE_WORKER_CONFIG || path.join(root, '.env.gas-voice.local')));
const api = (config.GAS_VOICE_API_URL || '').replace(/\/$/, '');
const url = new URL(api);
if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('Shop API requires HTTPS');
if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Use a shop API origin');
const privateKey = crypto.createPrivateKey(fs.readFileSync(path.join(runtime, 'worker-private.pem')));
const lock = path.join(runtime, 'worker.pid');
const stopFile = path.join(runtime, 'stop');
const statusFile = path.join(runtime, 'status.json');
const logFile = path.join(runtime, 'worker.log');
function running(pid) {
    if (!Number.isSafeInteger(pid) || pid < 1) return false;
    try {
        if (process.platform === 'win32') {
            const command = execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { encoding: 'utf8', windowsHide: true });
            return command.toLowerCase().includes(__filename.toLowerCase());
        }
        process.kill(pid, 0); return true;
    } catch { return false; }
}
function acquire() {
    if (fs.existsSync(lock)) {
        if (running(Number(fs.readFileSync(lock, 'utf8')))) return false;
        fs.unlinkSync(lock);
    }
    try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); return true; }
    catch (error) { if (error.code === 'EEXIST') return false; throw error; }
}
function log(event, detail = {}) { fs.appendFileSync(logFile, JSON.stringify({ at: new Date().toISOString(), event, ...detail }) + '\n'); }
async function main() {
    if (!acquire()) return;
    fs.rmSync(stopFile, { force: true });
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 2 * 1024 * 1024) {
        fs.rmSync(logFile + '.old', { force: true }); fs.renameSync(logFile, logFile + '.old');
    }
    const workerId = crypto.randomBytes(16).toString('hex');
    const controller = new AbortController();
    const interpreter = createLocalInterpreter();
    let heartbeatBusy = false, connected = false, stopping = false, lastDaemonStart = 0, lastWarm = 0;
    const saveStatus = () => fs.writeFileSync(statusFile, JSON.stringify({ pid: process.pid, model: interpreter.model,
        ready: !stopping && interpreter.ready(), connected, updatedAt: new Date().toISOString() }));
    const delay = ms => new Promise(resolve => {
        if (controller.signal.aborted) return resolve();
        const done = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, ms); controller.signal.addEventListener('abort', done, { once: true });
    });
    async function relay(route, body, timeout = 20000, signal = controller.signal) {
        const response = await fetch(`${api}/api/gas/voice/worker/${route}`, { method: 'POST',
            headers: signWorkerRequest(privateKey, route, body), body: JSON.stringify(body),
            signal: AbortSignal.any([AbortSignal.timeout(timeout), signal]) });
        if (!response.ok) throw Object.assign(new Error('Relay unavailable'), { status: response.status });
        return response.json();
    }
    async function stop() {
        if (stopping) return;
        stopping = true; controller.abort(); clearInterval(timer);
        try { await relay('heartbeat', { workerId, ready: false }, 2000, new AbortController().signal); } catch { /* Server TTL handles a disconnected PC. */ }
        connected = false; saveStatus(); log('stopped');
        if (fs.existsSync(lock) && Number(fs.readFileSync(lock, 'utf8')) === process.pid) fs.unlinkSync(lock);
    }
    async function heartbeat() {
        if (heartbeatBusy || stopping) return;
        if (fs.existsSync(stopFile)) { void stop(); return; }
        heartbeatBusy = true;
        try {
            await interpreter.check(controller.signal);
            const result = await relay('heartbeat', { workerId, ready: interpreter.ready() }, 5000);
            connected = result.ready === true;
        } catch { connected = false; }
        finally { heartbeatBusy = false; saveStatus(); }
    }
    const timer = setInterval(() => void heartbeat(), 2500);
    process.once('SIGINT', () => void stop()); process.once('SIGTERM', () => void stop());
    log('started', { model: interpreter.model });
    try {
        while (!controller.signal.aborted) {
            try {
                if (!interpreter.ready()) {
                    // Ollama is an existing official installation. Start its local daemon if needed.
                    try { await fetch('http://127.0.0.1:11434/api/version', { signal: AbortSignal.timeout(1000) }); }
                    catch {
                        if (Date.now() - lastDaemonStart > 60000) {
                            lastDaemonStart = Date.now();
                            const daemon = spawn(config.OLLAMA_EXECUTABLE || 'ollama', ['serve'], { windowsHide: true, stdio: 'ignore' });
                            daemon.on('error', () => {}); daemon.unref();
                        }
                    }
                    await interpreter.warm(controller.signal); lastWarm = Date.now();
                    await heartbeat();
                }
                if (Date.now() - lastWarm > 120000) { await interpreter.keepWarm(controller.signal); lastWarm = Date.now(); }
                const { job } = await relay('next', { workerId });
                if (!job) continue;
                const started = Date.now();
                try {
                    const extraction = await interpreter.extract(job.text, controller.signal);
                    await relay('result', { workerId, id: job.id, extraction }, 3000);
                    log('completed', { durationMs: Date.now() - started });
                } catch {
                    try { await relay('result', { workerId, id: job.id, failed: true }, 2000); } catch { /* Expired/cancelled requests are never reapplied. */ }
                    log('extraction_failed', { durationMs: Date.now() - started });
                    await heartbeat();
                }
            } catch (error) {
                connected = false; saveStatus();
                if (!controller.signal.aborted) { log('reconnecting', { status: error.status || null }); await delay(3000); }
            }
        }
    } finally { await stop(); }
}
main().catch(() => { log('worker_failed'); process.exitCode = 1; });
