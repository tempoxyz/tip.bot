// Vendored from chat-state-cloudflare-do 0.2.0.
// MIT License, Copyright (c) 2026 Dan Carter.

import { DurableObject } from 'cloudflare:workers'
import type { Lock, QueueEntry, StateAdapter } from 'chat'

export class ChatStateDO<TEnv = unknown> extends DurableObject<TEnv> {
  private readonly sql: SqlStorage

  constructor(ctx: DurableObjectState, env: TEnv) {
    super(ctx, env)
    this.sql = ctx.storage.sql as SqlStorage
    void ctx.blockConcurrencyWhile(async () => {
      this.migrate()
    })
  }

  subscribe(threadId: string) {
    this.sql.exec('INSERT OR IGNORE INTO subscriptions (thread_id) VALUES (?)', threadId)
  }

  unsubscribe(threadId: string) {
    this.sql.exec('DELETE FROM subscriptions WHERE thread_id = ?', threadId)
  }

  isSubscribed(threadId: string) {
    return (
      this.sql.exec('SELECT 1 FROM subscriptions WHERE thread_id = ? LIMIT 1', threadId).toArray()
        .length > 0
    )
  }

  acquireLock(threadId: string, ttlMs: number) {
    const result = this.ctx.storage.transactionSync(() => {
      const now = Date.now()
      this.sql.exec('DELETE FROM locks WHERE thread_id = ? AND expires_at <= ?', threadId, now)
      const existing = this.sql
        .exec('SELECT 1 FROM locks WHERE thread_id = ? LIMIT 1', threadId)
        .toArray()
      if (existing.length > 0) return null

      const token = crypto.randomUUID()
      const expiresAt = now + ttlMs
      this.sql.exec(
        'INSERT INTO locks (thread_id, token, expires_at) VALUES (?, ?, ?)',
        threadId,
        token,
        expiresAt,
      )
      return { expiresAt, threadId, token }
    })
    if (result) this.scheduleCleanupIfNeeded()
    return result
  }

  releaseLock(threadId: string, token: string) {
    this.sql.exec('DELETE FROM locks WHERE thread_id = ? AND token = ?', threadId, token)
  }

  extendLock(threadId: string, token: string, ttlMs: number) {
    return this.ctx.storage.transactionSync(() => {
      const now = Date.now()
      return (
        this.sql
          .exec(
            `UPDATE locks SET expires_at = ?
             WHERE thread_id = ? AND token = ? AND expires_at > ?
             RETURNING thread_id`,
            now + ttlMs,
            threadId,
            token,
            now,
          )
          .toArray().length > 0
      )
    })
  }

  forceReleaseLock(threadId: string) {
    this.sql.exec('DELETE FROM locks WHERE thread_id = ?', threadId)
  }

  enqueue(threadId: string, value: string, maxSize: number) {
    const parsed = JSON.parse(value) as QueueEntry
    const result = this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        'INSERT INTO queue (thread_id, value, enqueued_at, expires_at) VALUES (?, ?, ?, ?)',
        threadId,
        value,
        parsed.enqueuedAt,
        parsed.expiresAt,
      )
      this.sql.exec(
        `DELETE FROM queue WHERE thread_id = ? AND id NOT IN (
          SELECT id FROM queue WHERE thread_id = ? ORDER BY id DESC LIMIT ?
        )`,
        threadId,
        threadId,
        maxSize,
      )
      return Number(
        this.sql.exec('SELECT COUNT(*) as cnt FROM queue WHERE thread_id = ?', threadId).one().cnt,
      )
    })
    this.scheduleCleanupIfNeeded()
    return result
  }

  dequeue(threadId: string) {
    return this.ctx.storage.transactionSync(() => {
      const now = Date.now()
      this.sql.exec('DELETE FROM queue WHERE thread_id = ? AND expires_at <= ?', threadId, now)
      const rows = this.sql
        .exec('SELECT id, value FROM queue WHERE thread_id = ? ORDER BY id ASC LIMIT 1', threadId)
        .toArray()
      if (rows.length === 0) return null

      this.sql.exec('DELETE FROM queue WHERE id = ?', rows[0]!.id)
      return String(rows[0]!.value)
    })
  }

  queueDepth(threadId: string) {
    return Number(
      this.sql
        .exec(
          'SELECT COUNT(*) as cnt FROM queue WHERE thread_id = ? AND expires_at > ?',
          threadId,
          Date.now(),
        )
        .one().cnt,
    )
  }

  listAppend(key: string, value: string, maxLength?: number, ttlMs?: number) {
    const expiresAt = ttlMs ? Date.now() + ttlMs : null
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        'INSERT INTO lists (key, value, expires_at) VALUES (?, ?, ?)',
        key,
        value,
        expiresAt,
      )
      if (expiresAt !== null)
        this.sql.exec('UPDATE lists SET expires_at = ? WHERE key = ?', expiresAt, key)
      if (maxLength !== undefined && maxLength > 0)
        this.sql.exec(
          `DELETE FROM lists WHERE key = ? AND id NOT IN (
            SELECT id FROM lists WHERE key = ? ORDER BY id DESC LIMIT ?
          )`,
          key,
          key,
          maxLength,
        )
    })
    if (expiresAt !== null) this.scheduleCleanupIfNeeded()
  }

  listGet(key: string) {
    this.sql.exec(
      'DELETE FROM lists WHERE key = ? AND expires_at IS NOT NULL AND expires_at <= ?',
      key,
      Date.now(),
    )
    return this.sql
      .exec('SELECT value FROM lists WHERE key = ? ORDER BY id ASC', key)
      .toArray()
      .map((row) => String(row.value))
  }

  cacheGet(key: string) {
    const rows = this.sql
      .exec(
        'SELECT value FROM cache WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)',
        key,
        Date.now(),
      )
      .toArray()
    return rows.length > 0 ? String(rows[0]!.value) : null
  }

  cacheSet(key: string, value: string, ttlMs?: number) {
    const expiresAt = ttlMs ? Date.now() + ttlMs : null
    this.sql.exec(
      'INSERT OR REPLACE INTO cache (key, value, expires_at) VALUES (?, ?, ?)',
      key,
      value,
      expiresAt,
    )
    if (expiresAt !== null) this.scheduleCleanupIfNeeded()
  }

  cacheSetIfNotExists(key: string, value: string, ttlMs?: number) {
    const now = Date.now()
    const result = this.ctx.storage.transactionSync(() => {
      const existing = this.sql
        .exec(
          'SELECT 1 FROM cache WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)',
          key,
          now,
        )
        .toArray()
      if (existing.length > 0) return { expiresAt: null, inserted: false }

      this.sql.exec(
        'DELETE FROM cache WHERE key = ? AND expires_at IS NOT NULL AND expires_at <= ?',
        key,
        now,
      )
      const expiresAt = ttlMs ? Date.now() + ttlMs : null
      this.sql.exec(
        'INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?)',
        key,
        value,
        expiresAt,
      )
      return { expiresAt, inserted: true }
    })
    if (result.inserted && result.expiresAt !== null) this.scheduleCleanupIfNeeded()
    return result.inserted
  }

  cacheDelete(key: string) {
    this.sql.exec('DELETE FROM cache WHERE key = ?', key)
  }

  async alarm() {
    try {
      const now = Date.now()
      this.sql.exec('DELETE FROM locks WHERE expires_at <= ?', now)
      this.sql.exec('DELETE FROM cache WHERE expires_at IS NOT NULL AND expires_at <= ?', now)
      this.sql.exec('DELETE FROM queue WHERE expires_at <= ?', now)
      this.sql.exec('DELETE FROM lists WHERE expires_at IS NOT NULL AND expires_at <= ?', now)
      const next = this.nextExpiry()
      if (next !== null) await this.ctx.storage.setAlarm(next)
    } catch (error) {
      console.error('ChatStateDO: alarm handler failed, rescheduling:', error)
      await this.ctx.storage.setAlarm(Date.now() + 30 * 1000) // 30 seconds
    }
  }

  private migrate() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS _schema_version (
        version INTEGER PRIMARY KEY
      );
    `)
    const row = this.sql
      .exec('SELECT COALESCE(MAX(version), 0) as version FROM _schema_version')
      .one()
    if (Number(row.version) < 1) {
      this.sql.exec(`
        CREATE TABLE subscriptions (
          thread_id TEXT PRIMARY KEY
        );

        CREATE TABLE locks (
          thread_id TEXT PRIMARY KEY,
          token TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        );

        CREATE TABLE cache (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          expires_at INTEGER
        );

        CREATE INDEX idx_locks_expires ON locks(expires_at);
        CREATE INDEX idx_cache_expires ON cache(expires_at)
          WHERE expires_at IS NOT NULL;

        INSERT INTO _schema_version (version) VALUES (1);
      `)
    }
    if (Number(row.version) < 2) {
      this.sql.exec(`
        CREATE TABLE queue (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          thread_id TEXT NOT NULL,
          value TEXT NOT NULL,
          enqueued_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );

        CREATE INDEX idx_queue_thread ON queue(thread_id, id);
        CREATE INDEX idx_queue_expires ON queue(expires_at);

        CREATE TABLE lists (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          expires_at INTEGER
        );

        CREATE INDEX idx_lists_key ON lists(key, id);
        CREATE INDEX idx_lists_expires ON lists(expires_at)
          WHERE expires_at IS NOT NULL;

        INSERT INTO _schema_version (version) VALUES (2);
      `)
    }
  }

  private nextExpiry() {
    const now = Date.now()
    const rows = this.sql
      .exec(
        `SELECT MIN(expires_at) as next_expiry FROM (
          SELECT expires_at FROM locks WHERE expires_at > ?
          UNION ALL
          SELECT expires_at FROM cache WHERE expires_at IS NOT NULL AND expires_at > ?
          UNION ALL
          SELECT expires_at FROM queue WHERE expires_at > ?
          UNION ALL
          SELECT expires_at FROM lists WHERE expires_at IS NOT NULL AND expires_at > ?
        )`,
        now,
        now,
        now,
        now,
      )
      .toArray()
    return rows.length > 0 && rows[0]!.next_expiry !== null ? Number(rows[0]!.next_expiry) : null
  }

  private scheduleCleanupIfNeeded() {
    const next = this.nextExpiry()
    if (next !== null)
      this.ctx.storage.setAlarm(next).catch((error) => {
        console.error('ChatStateDO: failed to schedule cleanup alarm:', error)
      })
  }
}

export class CloudflareDOStateAdapter implements StateAdapter {
  private connected = false
  private readonly defaultName: string
  private readonly locationHint: DurableObjectLocationHint | undefined
  private readonly namespace: DurableObjectNamespace<ChatStateDO>
  private readonly shardKey: ((threadId: string) => string) | undefined

  constructor(options: CloudflareStateOptions) {
    if (!options.namespace)
      throw new Error(
        'CloudflareDOStateAdapter: namespace binding is required. Ensure the DurableObjectNamespace is bound in your wrangler configuration.',
      )

    this.defaultName = options.name ?? 'default'
    this.locationHint = options.locationHint
    this.namespace = options.namespace
    this.shardKey = options.shardKey
  }

  async connect() {
    this.connected = true
  }

  async disconnect() {
    this.connected = false
  }

  async subscribe(threadId: string) {
    await this.stub(threadId).subscribe(threadId)
  }

  async unsubscribe(threadId: string) {
    await this.stub(threadId).unsubscribe(threadId)
  }

  async isSubscribed(threadId: string) {
    return await this.stub(threadId).isSubscribed(threadId)
  }

  async acquireLock(threadId: string, ttlMs: number) {
    return await this.stub(threadId).acquireLock(threadId, ttlMs)
  }

  async releaseLock(lock: Lock) {
    await this.stub(lock.threadId).releaseLock(lock.threadId, lock.token)
  }

  async extendLock(lock: Lock, ttlMs: number) {
    return await this.stub(lock.threadId).extendLock(lock.threadId, lock.token, ttlMs)
  }

  async forceReleaseLock(threadId: string) {
    await this.stub(threadId).forceReleaseLock(threadId)
  }

  async enqueue(threadId: string, entry: QueueEntry, maxSize: number) {
    return await this.stub(threadId).enqueue(threadId, JSON.stringify(entry), maxSize)
  }

  async dequeue(threadId: string) {
    const raw = await this.stub(threadId).dequeue(threadId)
    if (raw === null) return null
    return JSON.parse(raw) as QueueEntry
  }

  async queueDepth(threadId: string) {
    return await this.stub(threadId).queueDepth(threadId)
  }

  async appendToList(
    key: string,
    value: unknown,
    options?: { maxLength?: number; ttlMs?: number },
  ) {
    await this.stub().listAppend(key, JSON.stringify(value), options?.maxLength, options?.ttlMs)
  }

  async getList<T = unknown>(key: string) {
    return (await this.stub().listGet(key)).map((value) => JSON.parse(value) as T)
  }

  async get<T = unknown>(key: string) {
    const raw = await this.stub().cacheGet(key)
    if (raw === null) return null

    try {
      return JSON.parse(raw) as T
    } catch {
      return raw as T
    }
  }

  async set<T = unknown>(key: string, value: T, ttlMs?: number) {
    await this.stub().cacheSet(key, JSON.stringify(value), ttlMs)
  }

  async setIfNotExists(key: string, value: unknown, ttlMs?: number) {
    return await this.stub().cacheSetIfNotExists(key, JSON.stringify(value), ttlMs)
  }

  async delete(key: string) {
    await this.stub().cacheDelete(key)
  }

  private ensureConnected() {
    if (!this.connected)
      throw new Error('CloudflareDOStateAdapter is not connected. Call connect() first.')
  }

  private stub(threadId?: string) {
    this.ensureConnected()
    const name = threadId && this.shardKey ? this.shardKey(threadId) : this.defaultName
    const id = this.namespace.idFromName(name)
    return this.locationHint
      ? this.namespace.get(id, { locationHint: this.locationHint })
      : this.namespace.get(id)
  }
}

export function createCloudflareState(options: CloudflareStateOptions) {
  return new CloudflareDOStateAdapter(options)
}

export function createChatState(env: { CHAT_STATE: DurableObjectNamespace<ChatStateDO> }) {
  return createCloudflareState({
    namespace: env.CHAT_STATE,
    name: 'tipbot',
    shardKey: getChatStateShardKey,
  })
}

export type CloudflareStateOptions = {
  locationHint?: DurableObjectLocationHint
  name?: string
  namespace: DurableObjectNamespace<ChatStateDO>
  shardKey?: (threadId: string) => string
}

type SqlCursor = {
  one: () => Record<string, unknown>
  toArray: () => Array<Record<string, unknown>>
}

type SqlStorage = {
  exec: (sql: string, ...bindings: unknown[]) => SqlCursor
}

function getChatStateShardKey(threadId: string) {
  return threadId.split(':', 1)[0] || 'default'
}
