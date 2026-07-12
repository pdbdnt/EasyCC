const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const test = require('node:test');

const {
  XAI_CLIENT_ID,
  XAI_SCOPE,
  XaiOAuthClient,
  XaiOAuthError
} = require('../backend/xaiOAuthClient');

function mockResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return payload === undefined ? '' : JSON.stringify(payload);
    }
  };
}

async function temporaryAuthFile() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easycc-xai-test-'));
  return {
    authFile: path.join(directory, 'xai-auth.json'),
    cleanup: () => fs.rm(directory, { recursive: true, force: true })
  };
}

const discovery = {
  authorization_endpoint: 'https://auth.x.ai/oauth2/authorize',
  token_endpoint: 'https://auth.x.ai/oauth2/token',
  device_authorization_endpoint: 'https://auth.x.ai/oauth2/device/code'
};

test('device login returns the browser link and persists approved OAuth tokens', async t => {
  const { authFile, cleanup } = await temporaryAuthFile();
  t.after(cleanup);
  const calls = [];
  const responses = [
    mockResponse(200, discovery),
    mockResponse(200, {
      device_code: 'device-secret',
      user_code: 'ABCD-EFGH',
      verification_uri: 'https://auth.x.ai/activate',
      verification_uri_complete: 'https://auth.x.ai/activate?user_code=ABCD-EFGH',
      expires_in: 600,
      interval: 1
    }),
    mockResponse(400, { error: 'authorization_pending' }),
    mockResponse(200, {
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expires_in: 900,
      token_type: 'Bearer'
    })
  ];
  const client = new XaiOAuthClient({
    authFile,
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      return responses.shift();
    },
    sleepImpl: async () => {},
    now: () => Date.parse('2026-07-11T00:00:00.000Z')
  });

  const flow = await client.beginDeviceLogin();
  assert.equal(flow.verificationUriComplete, 'https://auth.x.ai/activate?user_code=ABCD-EFGH');
  assert.equal(flow.userCode, 'ABCD-EFGH');

  let pendingCount = 0;
  const status = await client.pollDeviceLogin(flow, { onPending: () => { pendingCount += 1; } });
  assert.equal(status.connected, true);
  assert.equal(pendingCount, 1);

  const deviceBody = new URLSearchParams(calls[1].options.body);
  assert.equal(deviceBody.get('client_id'), XAI_CLIENT_ID);
  assert.equal(deviceBody.get('scope'), XAI_SCOPE);
  const pollBody = new URLSearchParams(calls[2].options.body);
  assert.equal(pollBody.get('grant_type'), 'urn:ietf:params:oauth:grant-type:device_code');
  assert.equal(pollBody.get('device_code'), 'device-secret');

  const saved = JSON.parse(await fs.readFile(authFile, 'utf8'));
  assert.equal(saved.accessToken, 'access-token');
  assert.equal(saved.refreshToken, 'refresh-token');
  assert.equal(saved.tokenEndpoint, discovery.token_endpoint);
});

test('expired access token refreshes and persists a rotated refresh token', async t => {
  const { authFile, cleanup } = await temporaryAuthFile();
  t.after(cleanup);
  const now = Date.parse('2026-07-11T00:00:00.000Z');
  const calls = [];
  const client = new XaiOAuthClient({
    authFile,
    now: () => now,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return mockResponse(200, {
        access_token: 'new-access-token',
        refresh_token: 'rotated-refresh-token',
        expires_in: 900
      });
    }
  });
  await client.writeAuthState({
    version: 1,
    provider: 'xai-oauth',
    tokenEndpoint: discovery.token_endpoint,
    scope: XAI_SCOPE,
    tokenType: 'Bearer',
    accessToken: 'old-access-token',
    refreshToken: 'old-refresh-token',
    idToken: '',
    obtainedAt: '2026-07-10T23:00:00.000Z',
    expiresAt: '2026-07-10T23:30:00.000Z'
  });

  assert.equal(await client.getAccessToken(), 'new-access-token');
  const refreshBody = new URLSearchParams(calls[0].options.body);
  assert.equal(refreshBody.get('grant_type'), 'refresh_token');
  assert.equal(refreshBody.get('refresh_token'), 'old-refresh-token');
  const saved = JSON.parse(await fs.readFile(authFile, 'utf8'));
  assert.equal(saved.refreshToken, 'rotated-refresh-token');
});

test('search calls Responses API with x_search filters and extracts citations', async t => {
  const { authFile, cleanup } = await temporaryAuthFile();
  t.after(cleanup);
  const calls = [];
  const client = new XaiOAuthClient({
    authFile,
    now: () => Date.parse('2026-07-11T00:00:00.000Z'),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return mockResponse(200, {
        id: 'resp_123',
        output: [{
          type: 'message',
          content: [{
            type: 'output_text',
            text: 'Developers are discussing the new release.',
            annotations: [{
              type: 'url_citation',
              url: 'https://x.com/openai/status/123',
              title: 'Release post',
              start_index: 0,
              end_index: 10
            }]
          }]
        }],
        usage: { input_tokens: 10, output_tokens: 20 }
      });
    }
  });
  await client.writeAuthState({
    version: 1,
    provider: 'xai-oauth',
    tokenEndpoint: discovery.token_endpoint,
    scope: XAI_SCOPE,
    tokenType: 'Bearer',
    accessToken: 'valid-access-token',
    refreshToken: 'refresh-token',
    idToken: '',
    obtainedAt: '2026-07-11T00:00:00.000Z',
    expiresAt: '2026-07-11T01:00:00.000Z'
  });

  const result = await client.search({
    query: 'What is OpenAI saying?',
    allowedXHandles: ['@openai'],
    fromDate: '2026-07-01',
    enableImageUnderstanding: true
  });

  assert.equal(calls[0].url, 'https://api.x.ai/v1/responses');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer valid-access-token');
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(body.tools, [{
    type: 'x_search',
    allowed_x_handles: ['openai'],
    from_date: '2026-07-01',
    enable_image_understanding: true
  }]);
  assert.equal(body.store, false);
  assert.equal(result.answer, 'Developers are discussing the new release.');
  assert.equal(result.inlineCitations[0].url, 'https://x.com/openai/status/123');
  assert.equal(result.degraded, false);
});

test('search rejects conflicting handles and malformed date ranges before network access', async () => {
  let networkCalls = 0;
  const client = new XaiOAuthClient({
    fetchImpl: async () => {
      networkCalls += 1;
      throw new Error('unexpected network call');
    },
    now: () => Date.parse('2026-07-11T00:00:00.000Z')
  });

  await assert.rejects(
    client.search({ query: 'test', allowedXHandles: ['xai'], excludedXHandles: ['openai'] }),
    error => error instanceof XaiOAuthError && /cannot be combined/.test(error.message)
  );
  await assert.rejects(
    client.search({ query: 'test', fromDate: '2026-07-10', toDate: '2026-07-01' }),
    error => error instanceof XaiOAuthError && /on or before/.test(error.message)
  );
  assert.equal(networkCalls, 0);
});
