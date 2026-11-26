const crypto = require('node:crypto');

function payload(route, body, time, nonce) {
    return `${route}\n${time}\n${nonce}\n${crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex')}`;
}

function signWorkerRequest(privateKey, route, body, now = Date.now()) {
    const time = String(now), nonce = crypto.randomBytes(16).toString('hex');
    return { 'Content-Type': 'application/json', 'X-Gas-Worker-Time': time, 'X-Gas-Worker-Nonce': nonce,
        'X-Gas-Worker-Signature': crypto.sign(null, Buffer.from(payload(route, body, time, nonce)), privateKey).toString('base64') };
}

function createWorkerAuthenticator(publicKeyText, now = Date.now) {
    let publicKey;
    try {
        publicKey = crypto.createPublicKey({ key: Buffer.from(publicKeyText || '', 'base64'), type: 'spki', format: 'der' });
        if (publicKey.asymmetricKeyType !== 'ed25519') publicKey = null;
    } catch { publicKey = null; }
    const used = new Map();
    return { configured: Boolean(publicKey), verify(route, body, headers) {
        if (!publicKey) return false;
        const time = headers['x-gas-worker-time'], nonce = headers['x-gas-worker-nonce'], signature = headers['x-gas-worker-signature'];
        if (typeof time !== 'string' || !/^\d{13}$/.test(time) || Math.abs(now() - Number(time)) > 30000
            || typeof nonce !== 'string' || !/^[a-f0-9]{32}$/.test(nonce)
            || typeof signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(signature)) return false;
        for (const [id, expires] of used) if (expires < now()) used.delete(id);
        if (used.has(nonce)) return false;
        try {
            if (!crypto.verify(null, Buffer.from(payload(route, body, time, nonce)), publicKey, Buffer.from(signature, 'base64'))) return false;
            used.set(nonce, now() + 60000); return true;
        } catch { return false; }
    } };
}

module.exports = { signWorkerRequest, createWorkerAuthenticator };
