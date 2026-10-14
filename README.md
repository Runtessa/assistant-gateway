# Runtessa assistant-gateway

Optional Codex CLI gateway. Part of the [Runtessa organization](https://github.com/Runtessa).

## Connect the Studio assistant

Use Node.js 22.13 or newer in the 22.x line. Install the official CLI with
`npm install -g @openai/codex`, then start this gateway from the platform checkout:

```sh
node scripts/assistant/init-secret.mjs
PORT=4040 HOST=127.0.0.1 node --env-file=src/codex-gateway/.env src/codex-gateway/index.js
```

In `src/ideNew/.env`, configure the existing gateway:

```dotenv
AGENT_CODEX_GATEWAY_MODE=local
AGENT_CODEX_GATEWAY_URL=http://127.0.0.1:4040
ASSISTANT_GATEWAY_SECRET=<private random value shared with the gateway>
AGENT_CODEX_MODEL=
AI_MODEL=
```

The initializer writes a matching random secret to the two private native
environment files, preserves existing settings, and refuses conflicting secrets.
Restart Studio after initialization. Never put the secret in browser configuration.
Both services require at least 32 bytes of secret material; missing configuration
stops gateway startup and prevents Studio from sending an unsigned request.

## Request authentication

Every operational request carries an HMAC-SHA256 signature over its HTTP method,
path/query, encoded identity context and SHA-256 body digest. Contexts bind the
authorized Studio user and, for workspace requests, tenant. Requests expire after
60 seconds; a bounded in-memory nonce cache rejects replay within one gateway
process. Clocks must agree. Replicated gateways need shared replay storage before
being treated as one authentication boundary.

The gateway derives profile identity from the verified context, rejects conflicting
body/query identities, and checks ownership before reading or updating a login
session. Tenant execution requires tenant workspace metadata and cannot fall back
to repository execution. Repository mode requires both an explicit server setting
and a separately signed repository scope; Studio sends tenant scopes only.
Workspace directory keys hash the tenant/chat pair to prevent delimiter collisions.

Only minimal health/version probes are public. Native startup binds loopback by
default. Use TLS between hosts and keep the service on a private network. HMAC
authenticates requests; it does not encrypt login data or attachment bytes.
Codex subprocesses receive an allowlist of transport/locale settings and their own
profile path, excluding gateway secrets, platform credentials and inherited API
keys. Linux execution also adds a bubblewrap filesystem boundary and delegated
cgroup budgets. Tenant/chat profiles and native thread state are scoped separately.
Generated commands have network access disabled; the trusted CLI retains provider
transport access. Host service files and other profiles are not mounted. See the
platform native production runbook for delegation and capacity requirements.

Open **Assistant settings → Login in browser** in Studio and complete the
ChatGPT device authorization. Each Studio user has a separate Codex profile;
the gateway does not inherit your desktop login. No API key is required for
this sign-in flow. Account access and usage limits still apply.

An empty model setting selects the default from Codex's live `model/list`
catalog. Studio displays that model and uses it for execution. Set
`AGENT_CODEX_MODEL` to select a server-managed model explicitly. Optional
client overrides require `AI_ALLOW_CLIENT_CONFIG=true`.
An unreachable gateway or failed discovery is reported as an error instead of
inventing a list of available models. A listed model is not proof of account
entitlement; verify access by completing an actual assistant request.

For container deployments, keep `AGENT_CODEX_GATEWAY_MODE=container` and configure
the existing remote container-manager. Container lifecycle buttons are shown
only in that mode. Keep the gateway on a private network; its HTTP API is an
internal service, not a public endpoint.

Run gateway checks with `npm --prefix src/codex-gateway test` and the platform
HTTP/SSE contract checks with `node --test scripts/security/gateway-contracts.test.cjs`.

## Native workspace conversations

Tenant requests use Codex app-server's native `thread/start`, `thread/resume`
and `turn/start` protocol. Each user/tenant/chat combination has a separate,
persisted thread; gateway restarts do not discard the Codex conversation.
The legacy text-summary history is used only by the repository CLI endpoint.

Every turn refreshes the tenant workspace from Studio. Authorized unsaved editor
buffers replace their saved snapshots, and the current file, open files and
selection/cursor range are recorded in `.idp/task-state.json`. Codex can read
the workspace, run commands and edit files using its native tools. Diffs return
to Studio through the existing validation, authorization and rollback flow.
Disk files remain authoritative when an external edit occurs between turns.
Studio refreshes clean editor buffers from saved files. Applying or rolling back
assistant changes also refreshes the affected open buffers; unrelated unsaved
edits are retained.

Assistant replies stream as native message deltas. **Stop** aborts the Studio
request and interrupts the native Codex turn. Requests to the same workspace
allow only one active turn; concurrent requests receive an error. Users,
tenants and chats have separate thread identities.
Native turns have a 30-minute execution deadline, configurable with
`AGENT_CODEX_TIMEOUT_MS`. A deadline reports a timeout separately from a user Stop.
Read-only requests use a read-only sandbox. Write requests stay in the tenant
workspace, with network access disabled for model-generated commands.
Interactive app-server approval or input forms are not implemented in Studio;
requests requiring them report an error rather than granting approval silently.

## Development workspace

Use the integration checkout to preserve shared-package paths, locks and cross-service tests:

```sh
git clone --recurse-submodules https://github.com/Runtessa/platform.git
cd platform
```

This repository mounts at `src/codex-gateway`. Follow the [platform setup and checks](https://github.com/Runtessa/platform/blob/main/CONTRIBUTING.md).
The current light/dark IDE and syntax colors are preserved.

## History and license

History was extracted from `src/codex-gateway` at platform commit `c25521a53a10b9f255bbfa5c05607fbde1330d69` without squashing.
Author identities, dates and commit messages are preserved; extracted commit IDs differ because paths are rooted here.
The complete original commit graph, all historical paths, branches, issues and pull requests remain in `Runtessa/platform`.
Apache-2.0; retain LICENSE, NOTICE and third-party notices.

### Attachments

Tenant `/v1/exec` requests may include up to five validated `attachments` with
`id`, `name`, `kind`, `mime` and `base64`, plus optional preview region metadata.
Studio resolves these bytes from user/tenant-owned storage before calling the
gateway. The gateway checks encoding, format and size again. It accepts only
inline reference bytes; attachment URLs and caller-supplied filesystem paths
are never fetched or opened.

Text/source contents become native reference input; PNG/JPEG/WebP images become
actual `turn/start` image input items. Preview notes and normalized coordinates
accompany the flattened screenshot. Attachments are not workspace mutations and
do not appear in code diffs. Native threads can retain their input contents;
Studio's seven-day attachment-download expiry does not purge Codex history.
