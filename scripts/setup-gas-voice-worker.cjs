// Writes a PC-only Ed25519 identity. Prints ONLY the public verification key.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.join(__dirname, '..'), runtime = path.join(root, 'pids', 'gas-ai');
fs.mkdirSync(runtime, { recursive: true });
const privateFile = path.join(runtime, 'worker-private.pem');
if (!fs.existsSync(privateFile)) {
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    fs.writeFileSync(privateFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
}
if (process.platform === 'win32') {
    const sid = execFileSync('powershell.exe', ['-NoProfile', '-Command', '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value'], { encoding: 'utf8', windowsHide: true }).trim();
    execFileSync('icacls.exe', [runtime, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { windowsHide: true, stdio: 'pipe' });
    execFileSync('icacls.exe', [privateFile, '/inheritance:r', '/grant:r', `*${sid}:F`, '*S-1-5-18:F'], { windowsHide: true, stdio: 'pipe' });
}
const publicKey = crypto.createPublicKey(crypto.createPrivateKey(fs.readFileSync(privateFile))).export({ type: 'spki', format: 'der' }).toString('base64');
fs.writeFileSync(path.join(runtime, 'worker-public.txt'), publicKey);
const configFile = path.join(root, '.env.gas-voice.local');
if (!fs.existsSync(configFile)) fs.writeFileSync(configFile, 'GAS_VOICE_API_URL=https://tingkum-api-trial.onrender.com\n', { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ publicKey, fingerprint: crypto.createHash('sha256').update(publicKey).digest('hex').slice(0, 16) }));
