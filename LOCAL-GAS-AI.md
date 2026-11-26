# Local gas-order AI for the live shop

The Render API relays short-lived extraction jobs to this PC over outbound HTTPS.
Ollama listens on `127.0.0.1:11434`; no tunnel, router port or public PC listener is
needed. The live app keeps browser speech recognition and stock/form validation.
The provider integration no longer calls Cloudflare.

## Identity and configuration

Run `node scripts/setup-gas-voice-worker.cjs` once on the PC. It creates an Ed25519
identity in the gitignored `pids/gas-ai` directory, protects the private key with
the current Windows user's ACL and SYSTEM access, and prints only the public key.
The private key stays on this PC; it is never entered in Render or frontend config.

Render API environment:

```text
GAS_VOICE_AI_ENABLED=true
GAS_VOICE_WORKER_PUBLIC_KEY=<public key from setup>
```

PC `.env.gas-voice.local` (gitignored):

```text
GAS_VOICE_API_URL=https://tingkum-api-trial.onrender.com
```

Signed worker requests are limited to heartbeat, next-job and result endpoints.
Signatures include route, body hash, timestamp and a one-use nonce. The worker
identity cannot authenticate to sales, stock, users or any regular shop API.
Order text/results are held only for the in-flight request; no order content,
keys or response payloads are logged or saved in a database.

## Start and stop on Windows

From the backend directory:

```powershell
.\scripts\start-gas-voice-worker.ps1
.\scripts\stop-gas-voice-worker.ps1
```

`install-gas-voice-autostart.ps1` installs the current user's `Tingkum Gas AI.vbs`
in the Windows Startup folder. It launches Node hidden after sign-in. The worker
starts the existing Ollama daemon if necessary, warms `qwen3:4b`, and prevents
duplicate instances. No administrator account or saved owner password is used.
The Node/Ollama installation and workspace paths must remain available.

The signed heartbeat runs every 2.5 seconds. The server expires readiness after
7.5 seconds without a healthy heartbeat. An in-flight order waits at most 4.5
seconds before falling back to rules. The gas page checks availability every 3
seconds while visible, reconnecting without a page refresh or clearing typed text.
Cold model loading uses rules until the warm-up extraction succeeds. The loaded
model uses a ten-minute keep-alive, refreshed while the worker is running.

The PC must be signed into Windows, awake and online for local AI. The shop and
its rule parser remain usable when the PC is off. Local `status.json` reports
model readiness/connection, and `worker.log` contains timings/status only.

## Validation

- `node --test scripts/test-gas-voice-ai.cjs`: signature/replay/scope isolation,
  readiness expiry, failure, cancellation, stale results, bounded queues, local
  inference validation and authenticated HTTP flow.
- `node scripts/test-gas-voice-worker-local.cjs`: real Ollama/worker processes
  against a loopback relay with disposable keys. Tested process loss, reconnection,
  graceful stop and order-free logs. Sample round trips were 651 ms and 534 ms on
  this RTX 5070 PC, excluding speech recognition and production network latency.
- Frontend mocked browser checks cover speech, stock guards, fallback, late-result
  cancellation and online/offline switching without reload. Build/lint and
  existing lottery/password isolated database checks passed.
