const { createHash, createHmac, timingSafeEqual } = require('node:crypto');
const { readBody, parseBody } = require('./http');

const MAX_AGE_MS = 60_000;
const nonces = new Map();
const fail = (statusCode, message) => { throw Object.assign(new Error(message), { statusCode }); };
const validId = (value) => typeof value === 'string' && /^[a-zA-Z0-9._-]{1,128}$/.test(value)
  && value !== '.' && value !== '..';
const requireGatewaySecret = () => {
  const secret = process.env.ASSISTANT_GATEWAY_SECRET || '';
  if (Buffer.byteLength(secret) < 32 || secret.startsWith('replace_with_'))
    fail(503, 'ASSISTANT_GATEWAY_SECRET must contain at least 32 bytes of private random material');
  return secret;
};

const authenticateRequest = async (req) => {
  const secret = requireGatewaySecret();
  const context = req.headers['x-runtessa-context'];
  const signature = req.headers['x-runtessa-signature'];
  if (typeof context !== 'string' || context.length > 2048 || !/^[a-zA-Z0-9_-]+$/.test(context)
    || typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature)) fail(401, 'Gateway authentication required');
  let identity;
  try { identity = JSON.parse(Buffer.from(context, 'base64url').toString('utf8')); }
  catch { fail(401, 'Invalid gateway credentials'); }
  const now = Date.now();
  if (!identity || identity.v !== 1 || !validId(identity.sub) || !Number.isSafeInteger(identity.iat)
    || Math.abs(now - identity.iat) > MAX_AGE_MS || typeof identity.nonce !== 'string'
    || !/^[a-f0-9]{32}$/.test(identity.nonce)
    || !['user', 'tenant', 'repo'].includes(identity.scope)
    || (identity.scope === 'tenant' ? !validId(identity.tenant) : identity.tenant !== undefined))
    fail(401, 'Invalid or expired gateway credentials');
  const raw = await readBody(req);
  const digest = createHash('sha256').update(raw).digest('hex');
  const expected = createHmac('sha256', secret)
    .update([req.method, req.url, context, digest].join('\n')).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) fail(401, 'Invalid gateway credentials');
  if (Math.abs(Date.now() - identity.iat) > MAX_AGE_MS) fail(401, 'Expired gateway credentials');
  for (const [nonce, expiry] of nonces) if (expiry < now) nonces.delete(nonce);
  if (nonces.has(identity.nonce)) fail(401, 'Gateway request has already been used');
  if (nonces.size >= 10_000) fail(503, 'Gateway request capacity exceeded');
  nonces.set(identity.nonce, identity.iat + MAX_AGE_MS);
  req.gatewayIdentity = Object.freeze(identity);
  const url = new URL(req.url, 'http://127.0.0.1');
  const body = await parseBody(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'Expected a JSON object');
  const users = [...url.searchParams.getAll('userId'), body?.userId].filter((v) => v !== undefined);
  if (users.some((v) => String(v) !== identity.sub)) fail(403, 'Gateway user scope mismatch');
  if (url.pathname === '/v1/exec' || url.pathname.startsWith('/v1/workspace/')) {
    const tenants = [body?.tenantId, body?.agentSession?.tenant?.id].filter((v) => v !== undefined);
    if (identity.scope === 'repo') {
      if (process.env.CODEX_GATEWAY_WORKSPACE_ACCESS_MODE !== 'repo' || url.pathname !== '/v1/exec'
        || tenants.length) fail(403, 'Repository execution is disabled for this request');
    } else if (identity.scope !== 'tenant' || !tenants.length
      || tenants.some((v) => String(v) !== identity.tenant)) fail(403, 'Gateway tenant scope mismatch');
    if (url.pathname === '/v1/exec' && identity.scope === 'tenant' && !body?.agentSession?.tenant?.id)
      fail(403, 'Tenant execution requires an authorized workspace session');
    for (const chat of [body?.chatId, body?.agentSession?.chatId].filter((v) => v !== undefined))
      if (!validId(chat)) fail(400, 'Invalid workspace chat identifier');
    if (body?.chatId && body?.agentSession?.chatId && body.chatId !== body.agentSession.chatId)
      fail(403, 'Gateway chat scope mismatch');
  }
};

module.exports = { authenticateRequest, requireGatewaySecret };
