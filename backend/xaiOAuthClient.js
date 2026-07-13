const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const XAI_ISSUER = 'https://auth.x.ai';
const XAI_DISCOVERY_URL = `${XAI_ISSUER}/.well-known/openid-configuration`;
const XAI_DEVICE_CODE_URL = `${XAI_ISSUER}/oauth2/device/code`;
const XAI_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
const XAI_SCOPE = 'openid profile email offline_access grok-cli:access api:access';
const XAI_API_BASE_URL = 'https://api.x.ai/v1';
const DEFAULT_X_SEARCH_MODEL = 'grok-4.20-reasoning';
const DEFAULT_TIMEOUT_MS = 180_000;
const REFRESH_SKEW_MS = 120_000;
const MAX_HANDLES = 10;

class XaiOAuthError extends Error {
  constructor(message, { status = null, code = '', reloginRequired = false } = {}) {
    super(message);
    this.name = 'XaiOAuthError';
    this.status = status;
    this.code = code;
    this.reloginRequired = reloginRequired;
  }
}

function defaultAuthFile() {
  return process.env.EASYCC_XAI_AUTH_FILE || path.join(os.homedir(), '.easycc', 'xai-auth.json');
}

function isXaiHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'x.ai' || host.endsWith('.x.ai');
}

function validateXaiUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new XaiOAuthError(`xAI returned an invalid ${label} URL`);
  }
  if (url.protocol !== 'https:' || !isXaiHost(url.hostname)) {
    throw new XaiOAuthError(`Refusing non-xAI ${label} URL: ${url.origin}`);
  }
  return url.toString();
}

function decodeJwtExpiry(accessToken) {
  try {
    const parts = String(accessToken || '').split('.');
    if (parts.length < 2) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return Number.isFinite(payload.exp) ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

function normalizeHandles(handles, fieldName) {
  const normalized = (handles || [])
    .map(handle => String(handle || '').trim().replace(/^@/, ''))
    .filter(Boolean);
  if (normalized.length > MAX_HANDLES) {
    throw new XaiOAuthError(`${fieldName} supports at most ${MAX_HANDLES} handles`);
  }
  return normalized;
}

function parseIsoDate(value, fieldName) {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new XaiOAuthError(`${fieldName} must use YYYY-MM-DD format`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new XaiOAuthError(`${fieldName} must be a valid date`);
  }
  return parsed;
}

function extractResponseText(payload) {
  if (typeof payload.output_text === 'string' && payload.output_text.trim()) {
    return payload.output_text.trim();
  }
  const parts = [];
  for (const item of payload.output || []) {
    if (item?.type !== 'message') continue;
    for (const content of item.content || []) {
      if (['output_text', 'text'].includes(content?.type) && content.text) {
        parts.push(String(content.text).trim());
      }
    }
  }
  return parts.filter(Boolean).join('\n\n');
}

function extractInlineCitations(payload) {
  const citations = [];
  for (const item of payload.output || []) {
    if (item?.type !== 'message') continue;
    for (const content of item.content || []) {
      for (const annotation of content?.annotations || []) {
        if (annotation?.type !== 'url_citation') continue;
        citations.push({
          url: annotation.url || '',
          title: annotation.title || '',
          startIndex: annotation.start_index ?? null,
          endIndex: annotation.end_index ?? null
        });
      }
    }
  }
  return citations;
}

async function responsePayload(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: text.slice(0, 500) };
  }
}

function errorFromResponse(response, payload, fallback) {
  const nested = payload?.error;
  const message = typeof nested === 'string'
    ? nested
    : nested?.message || payload?.message || payload?.detail || fallback;
  const code = payload?.code || nested?.code || '';
  return new XaiOAuthError(code ? `${code}: ${message}` : message, {
    status: response.status,
    code,
    reloginRequired: [400, 401].includes(response.status)
  });
}

class XaiOAuthClient {
  constructor({
    fetchImpl = globalThis.fetch,
    authFile = defaultAuthFile(),
    sleepImpl = ms => new Promise(resolve => setTimeout(resolve, ms)),
    now = () => Date.now()
  } = {}) {
    if (typeof fetchImpl !== 'function') {
      throw new Error('X search requires Node.js 18 or newer');
    }
    this.fetch = fetchImpl;
    this.authFile = authFile;
    this.lockFile = `${authFile}.lock`;
    this.sleep = sleepImpl;
    this.now = now;
  }

  async request(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.fetch(url, { ...options, signal: controller.signal });
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new XaiOAuthError(`xAI request timed out after ${Math.round(timeoutMs / 1000)} seconds`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async discover() {
    const response = await this.request(XAI_DISCOVERY_URL, {
      headers: { Accept: 'application/json' }
    }, 20_000);
    const payload = await responsePayload(response);
    if (!response.ok) throw errorFromResponse(response, payload, 'xAI discovery failed');

    return {
      authorizationEndpoint: validateXaiUrl(payload.authorization_endpoint, 'authorization endpoint'),
      tokenEndpoint: validateXaiUrl(payload.token_endpoint, 'token endpoint'),
      deviceAuthorizationEndpoint: validateXaiUrl(
        payload.device_authorization_endpoint || XAI_DEVICE_CODE_URL,
        'device authorization endpoint'
      )
    };
  }

  async beginDeviceLogin() {
    const discovery = await this.discover();
    const body = new URLSearchParams({ client_id: XAI_CLIENT_ID, scope: XAI_SCOPE });
    const response = await this.request(discovery.deviceAuthorizationEndpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body
    }, 20_000);
    const payload = await responsePayload(response);
    if (!response.ok) throw errorFromResponse(response, payload, 'Could not start xAI login');

    const required = ['device_code', 'user_code', 'verification_uri', 'expires_in', 'interval'];
    const missing = required.filter(field => payload[field] === undefined || payload[field] === '');
    if (missing.length) {
      throw new XaiOAuthError(`xAI login response was missing: ${missing.join(', ')}`);
    }

    return {
      deviceCode: String(payload.device_code),
      userCode: String(payload.user_code),
      verificationUri: validateXaiUrl(payload.verification_uri, 'verification'),
      verificationUriComplete: payload.verification_uri_complete
        ? validateXaiUrl(payload.verification_uri_complete, 'verification')
        : '',
      expiresIn: Number(payload.expires_in),
      interval: Math.max(1, Number(payload.interval) || 5),
      tokenEndpoint: discovery.tokenEndpoint
    };
  }

  async pollDeviceLogin(login, { onPending } = {}) {
    const deadline = this.now() + Math.max(1, login.expiresIn) * 1000;
    let intervalSeconds = Math.max(1, login.interval || 5);

    while (this.now() < deadline) {
      const body = new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: XAI_CLIENT_ID,
        device_code: login.deviceCode
      });
      const response = await this.request(login.tokenEndpoint, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body
      }, 20_000);
      const payload = await responsePayload(response);

      if (response.ok) {
        if (!payload.access_token || !payload.refresh_token) {
          throw new XaiOAuthError('xAI login did not return access and refresh tokens');
        }
        const state = this.stateFromTokens(payload, login.tokenEndpoint);
        await this.writeAuthState(state);
        return this.publicStatus(state);
      }

      const code = payload.error?.code || payload.error || payload.code;
      if (code === 'authorization_pending') {
        onPending?.();
        await this.sleep(intervalSeconds * 1000);
        continue;
      }
      if (code === 'slow_down') {
        intervalSeconds = Math.min(intervalSeconds + 1, 30);
        onPending?.();
        await this.sleep(intervalSeconds * 1000);
        continue;
      }
      throw errorFromResponse(response, payload, 'xAI device authorization failed');
    }

    throw new XaiOAuthError('Timed out waiting for xAI authorization', { code: 'device_code_timeout' });
  }

  stateFromTokens(payload, tokenEndpoint, previous = {}) {
    const expiresIn = Number(payload.expires_in);
    return {
      version: 1,
      provider: 'xai-oauth',
      tokenEndpoint: validateXaiUrl(tokenEndpoint, 'token endpoint'),
      scope: payload.scope || previous.scope || XAI_SCOPE,
      tokenType: payload.token_type || previous.tokenType || 'Bearer',
      accessToken: String(payload.access_token || ''),
      refreshToken: String(payload.refresh_token || previous.refreshToken || ''),
      idToken: String(payload.id_token || previous.idToken || ''),
      obtainedAt: new Date(this.now()).toISOString(),
      expiresAt: Number.isFinite(expiresIn)
        ? new Date(this.now() + expiresIn * 1000).toISOString()
        : previous.expiresAt || null
    };
  }

  async readAuthState() {
    try {
      const raw = await fs.readFile(this.authFile, 'utf8');
      const state = JSON.parse(raw);
      if (!state.accessToken || !state.refreshToken) return null;
      return state;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      if (error instanceof SyntaxError) {
        throw new XaiOAuthError(`OAuth state is invalid: ${this.authFile}`);
      }
      throw error;
    }
  }

  async writeAuthState(state) {
    const directory = path.dirname(this.authFile);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.authFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      await fs.rename(temporary, this.authFile);
      await fs.chmod(this.authFile, 0o600).catch(() => {});
    } finally {
      await fs.unlink(temporary).catch(() => {});
    }
  }

  tokenExpiry(state) {
    return decodeJwtExpiry(state.accessToken) || Date.parse(state.expiresAt || '') || null;
  }

  tokenIsExpiring(state, skewMs = REFRESH_SKEW_MS) {
    const expiry = this.tokenExpiry(state);
    return expiry !== null && expiry <= this.now() + skewMs;
  }

  publicStatus(state) {
    const expiry = state ? this.tokenExpiry(state) : null;
    return {
      connected: Boolean(state?.accessToken && state?.refreshToken),
      provider: state?.provider || 'xai-oauth',
      expiresAt: expiry ? new Date(expiry).toISOString() : null,
      scope: state?.scope || ''
    };
  }

  async status() {
    return this.publicStatus(await this.readAuthState());
  }

  async logout() {
    await fs.unlink(this.authFile).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }

  async withAuthLock(callback) {
    await fs.mkdir(path.dirname(this.authFile), { recursive: true, mode: 0o700 });
    const deadline = this.now() + 15_000;
    let handle;
    while (!handle) {
      try {
        handle = await fs.open(this.lockFile, 'wx', 0o600);
        await handle.writeFile(`${process.pid} ${this.now()}\n`);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const stat = await fs.stat(this.lockFile).catch(() => null);
        if (stat && this.now() - stat.mtimeMs > 30_000) {
          await fs.unlink(this.lockFile).catch(() => {});
          continue;
        }
        if (this.now() >= deadline) throw new XaiOAuthError('Timed out waiting for OAuth token refresh');
        await this.sleep(100);
      }
    }

    try {
      return await callback();
    } finally {
      await handle.close().catch(() => {});
      await fs.unlink(this.lockFile).catch(() => {});
    }
  }

  async refreshState(state) {
    const tokenEndpoint = validateXaiUrl(state.tokenEndpoint, 'token endpoint');
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: XAI_CLIENT_ID,
      refresh_token: state.refreshToken
    });
    const response = await this.request(tokenEndpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body
    }, 20_000);
    const payload = await responsePayload(response);
    if (!response.ok) {
      if (response.status === 403) {
        throw new XaiOAuthError(
          'This xAI account is not entitled to OAuth API access. SuperGrok or X Premium+ may be required.',
          { status: 403, code: 'xai_oauth_tier_denied' }
        );
      }
      throw errorFromResponse(response, payload, 'Could not refresh xAI login');
    }
    if (!payload.access_token) throw new XaiOAuthError('xAI refresh response omitted access_token');
    const refreshed = this.stateFromTokens(payload, tokenEndpoint, state);
    await this.writeAuthState(refreshed);
    return refreshed;
  }

  async getAccessToken({ forceRefresh = false } = {}) {
    const observed = await this.readAuthState();
    if (!observed) {
      throw new XaiOAuthError('Not signed in. Run `x_search auth login` first.', {
        code: 'not_authenticated',
        reloginRequired: true
      });
    }
    if (!forceRefresh && !this.tokenIsExpiring(observed)) return observed.accessToken;

    return this.withAuthLock(async () => {
      const current = await this.readAuthState();
      if (!current) throw new XaiOAuthError('xAI login was removed during refresh');
      const anotherProcessRefreshed = current.accessToken !== observed.accessToken;
      if ((anotherProcessRefreshed || !forceRefresh) && !this.tokenIsExpiring(current)) {
        return current.accessToken;
      }
      return (await this.refreshState(current)).accessToken;
    });
  }

  validateSearchOptions(options) {
    const query = String(options.query || '').trim();
    if (!query) throw new XaiOAuthError('A search query is required');
    const allowed = normalizeHandles(options.allowedXHandles, 'allowedXHandles');
    const excluded = normalizeHandles(options.excludedXHandles, 'excludedXHandles');
    if (allowed.length && excluded.length) {
      throw new XaiOAuthError('Allowed and excluded handles cannot be combined');
    }

    const fromDate = String(options.fromDate || '').trim();
    const toDate = String(options.toDate || '').trim();
    const parsedFrom = parseIsoDate(fromDate, 'fromDate');
    const parsedTo = parseIsoDate(toDate, 'toDate');
    if (parsedFrom && parsedTo && parsedFrom > parsedTo) {
      throw new XaiOAuthError('fromDate must be on or before toDate');
    }
    const today = new Date(this.now()).toISOString().slice(0, 10);
    if (fromDate && fromDate > today) throw new XaiOAuthError('fromDate cannot be in the future');

    return { query, allowed, excluded, fromDate, toDate };
  }

  async search(options) {
    const validated = this.validateSearchOptions(options);
    const tool = { type: 'x_search' };
    if (validated.allowed.length) tool.allowed_x_handles = validated.allowed;
    if (validated.excluded.length) tool.excluded_x_handles = validated.excluded;
    if (validated.fromDate) tool.from_date = validated.fromDate;
    if (validated.toDate) tool.to_date = validated.toDate;
    if (options.enableImageUnderstanding) tool.enable_image_understanding = true;
    if (options.enableVideoUnderstanding) tool.enable_video_understanding = true;

    const requestBody = {
      model: String(options.model || DEFAULT_X_SEARCH_MODEL),
      input: [{ role: 'user', content: validated.query }],
      tools: [tool],
      store: false
    };

    let accessToken = await this.getAccessToken();
    let response;
    let payload;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      response = await this.request(`${XAI_API_BASE_URL}/responses`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'User-Agent': 'easycc-x-search/1.0'
        },
        body: JSON.stringify(requestBody)
      }, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
      payload = await responsePayload(response);
      if (response.status !== 401 || attempt === 1) break;
      accessToken = await this.getAccessToken({ forceRefresh: true });
    }

    if (!response.ok) throw errorFromResponse(response, payload, 'xAI X search failed');
    const citations = Array.isArray(payload.citations) ? payload.citations : [];
    const inlineCitations = extractInlineCitations(payload);
    const activeFilters = [
      validated.allowed.length && 'allowedXHandles',
      validated.excluded.length && 'excludedXHandles',
      validated.fromDate && 'fromDate',
      validated.toDate && 'toDate'
    ].filter(Boolean);

    return {
      success: true,
      provider: 'xai-oauth',
      tool: 'x_search',
      model: requestBody.model,
      query: validated.query,
      answer: extractResponseText(payload),
      citations,
      inlineCitations,
      degraded: activeFilters.length > 0 && citations.length === 0 && inlineCitations.length === 0,
      responseId: payload.id || null,
      usage: payload.usage || null
    };
  }
}

module.exports = {
  DEFAULT_X_SEARCH_MODEL,
  XAI_API_BASE_URL,
  XAI_CLIENT_ID,
  XAI_DISCOVERY_URL,
  XAI_SCOPE,
  XaiOAuthClient,
  XaiOAuthError,
  extractInlineCitations,
  extractResponseText,
  validateXaiUrl
};
