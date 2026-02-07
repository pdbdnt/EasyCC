const EventEmitter = require('events');
const https = require('https');
const http = require('http');

/**
 * WebhooksManager - Send HTTP webhooks for task/workflow events
 *
 * Features:
 * - Configure webhook URLs for different event types
 * - Retry failed webhooks with exponential backoff
 * - Event filtering (only send specific events)
 * - Webhook signatures for security
 */
class WebhooksManager extends EventEmitter {
  constructor(taskManager, sessionManager) {
    super();
    this.taskManager = taskManager;
    this.sessionManager = sessionManager;

    // Webhook configurations: { id: { url, events, secret, enabled } }
    this.webhooks = new Map();

    // Retry queue for failed webhooks
    this.retryQueue = [];

    this.setupEventListeners();
  }

  /**
   * Register a webhook
   * @param {object} config - Webhook configuration
   * @returns {string} Webhook ID
   */
  registerWebhook(config) {
    const { url, events = [], secret = null, enabled = true } = config;

    if (!url) {
      throw new Error('Webhook URL is required');
    }

    const id = `webhook-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    this.webhooks.set(id, {
      id,
      url,
      events,
      secret,
      enabled,
      createdAt: new Date().toISOString()
    });

    console.log(`[WebhooksManager] Registered webhook ${id} for events: ${events.join(', ')}`);

    return id;
  }

  /**
   * Unregister a webhook
   * @param {string} id - Webhook ID
   */
  unregisterWebhook(id) {
    if (this.webhooks.delete(id)) {
      console.log(`[WebhooksManager] Unregistered webhook ${id}`);
      return true;
    }
    return false;
  }

  /**
   * Update a webhook configuration
   * @param {string} id - Webhook ID
   * @param {object} updates - Configuration updates
   */
  updateWebhook(id, updates) {
    const webhook = this.webhooks.get(id);
    if (!webhook) {
      throw new Error(`Webhook ${id} not found`);
    }

    Object.assign(webhook, updates);
    this.webhooks.set(id, webhook);

    console.log(`[WebhooksManager] Updated webhook ${id}`);
  }

  /**
   * Get all webhooks
   * @returns {Array} Webhook configurations
   */
  getAllWebhooks() {
    return Array.from(this.webhooks.values());
  }

  /**
   * Get a webhook by ID
   * @param {string} id - Webhook ID
   * @returns {object|null} Webhook configuration
   */
  getWebhook(id) {
    return this.webhooks.get(id) || null;
  }

  /**
   * Setup event listeners for task/session events
   */
  setupEventListeners() {
    // Task events
    this.taskManager.on('taskCreated', (task) => {
      this.triggerWebhooks('task.created', { task });
    });

    this.taskManager.on('taskUpdated', (task) => {
      this.triggerWebhooks('task.updated', { task });
    });

    this.taskManager.on('taskMoved', ({ task, fromStage, toStage, reason }) => {
      this.triggerWebhooks('task.moved', { task, fromStage, toStage, reason });
    });

    this.taskManager.on('taskDeleted', ({ id }) => {
      this.triggerWebhooks('task.deleted', { taskId: id });
    });

    // Session events
    this.sessionManager.on('statusChange', ({ sessionId, status }) => {
      this.triggerWebhooks('session.status_change', { sessionId, status });
    });
  }

  /**
   * Trigger webhooks for an event
   * @param {string} eventType - The event type
   * @param {object} payload - The event payload
   */
  triggerWebhooks(eventType, payload) {
    for (const webhook of this.webhooks.values()) {
      if (!webhook.enabled) {
        continue;
      }

      // Check if webhook is subscribed to this event (empty = all events)
      if (webhook.events.length > 0 && !webhook.events.includes(eventType)) {
        continue;
      }

      this.sendWebhook(webhook, eventType, payload);
    }
  }

  /**
   * Send a webhook HTTP request
   * @param {object} webhook - Webhook configuration
   * @param {string} eventType - Event type
   * @param {object} payload - Event payload
   */
  async sendWebhook(webhook, eventType, payload) {
    const fullPayload = {
      event: eventType,
      timestamp: new Date().toISOString(),
      data: payload
    };

    const body = JSON.stringify(fullPayload);

    const url = new URL(webhook.url);
    const isHttps = url.protocol === 'https:';
    const client = isHttps ? https : http;

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'CLIOverlord-Webhooks/1.0'
      }
    };

    // Add signature header if secret is configured
    if (webhook.secret) {
      const crypto = require('crypto');
      const signature = crypto
        .createHmac('sha256', webhook.secret)
        .update(body)
        .digest('hex');
      options.headers['X-Webhook-Signature'] = signature;
    }

    return new Promise((resolve, reject) => {
      const req = client.request(options, (res) => {
        let responseBody = '';

        res.on('data', (chunk) => {
          responseBody += chunk;
        });

        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            console.log(`[WebhooksManager] Webhook ${webhook.id} sent successfully (${eventType})`);
            resolve({ statusCode: res.statusCode, body: responseBody });
          } else {
            console.error(`[WebhooksManager] Webhook ${webhook.id} failed: ${res.statusCode}`);
            this.handleWebhookFailure(webhook, eventType, payload, res.statusCode);
            reject(new Error(`Webhook failed with status ${res.statusCode}`));
          }
        });
      });

      req.on('error', (error) => {
        console.error(`[WebhooksManager] Webhook ${webhook.id} error:`, error.message);
        this.handleWebhookFailure(webhook, eventType, payload, null, error);
        reject(error);
      });

      req.write(body);
      req.end();
    });
  }

  /**
   * Handle webhook failure (retry logic)
   * @param {object} webhook - Webhook configuration
   * @param {string} eventType - Event type
   * @param {object} payload - Event payload
   * @param {number|null} statusCode - HTTP status code
   * @param {Error|null} error - Error object
   */
  handleWebhookFailure(webhook, eventType, payload, statusCode = null, error = null) {
    this.retryQueue.push({
      webhook,
      eventType,
      payload,
      statusCode,
      error: error ? error.message : null,
      attempts: 0,
      nextRetry: Date.now() + 5000 // Retry after 5 seconds
    });

    // Process retry queue (could be done in a background worker)
    setTimeout(() => this.processRetryQueue(), 5000);
  }

  /**
   * Process the retry queue
   */
  async processRetryQueue() {
    const now = Date.now();
    const toRetry = this.retryQueue.filter(item => item.nextRetry <= now && item.attempts < 3);

    for (const item of toRetry) {
      try {
        await this.sendWebhook(item.webhook, item.eventType, item.payload);

        // Remove from queue on success
        const index = this.retryQueue.indexOf(item);
        if (index > -1) {
          this.retryQueue.splice(index, 1);
        }
      } catch (error) {
        // Increment attempts and exponential backoff
        item.attempts++;
        item.nextRetry = now + (5000 * Math.pow(2, item.attempts)); // 5s, 10s, 20s

        if (item.attempts >= 3) {
          console.error(`[WebhooksManager] Webhook ${item.webhook.id} failed after 3 attempts, giving up`);
          this.retryQueue = this.retryQueue.filter(i => i !== item);
        }
      }
    }
  }

  /**
   * Test a webhook by sending a test event
   * @param {string} id - Webhook ID
   * @returns {Promise} Test result
   */
  async testWebhook(id) {
    const webhook = this.webhooks.get(id);
    if (!webhook) {
      throw new Error(`Webhook ${id} not found`);
    }

    return this.sendWebhook(webhook, 'webhook.test', {
      message: 'This is a test webhook from CLIOverlord'
    });
  }
}

module.exports = WebhooksManager;
