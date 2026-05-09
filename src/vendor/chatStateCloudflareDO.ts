// Vendored from chat-state-cloudflare-do 0.2.0.
// MIT License, Copyright (c) 2026 Dan Carter.
import type { TipbotChatStateDO } from '#/objects/chatState.ts'
import type { Lock, QueueEntry, StateAdapter } from 'chat'

export function createCloudflareState(options: CloudflareStateOptions) {
  return new CloudflareDOStateAdapter(options)
}

export type CloudflareStateOptions = {
  locationHint?: DurableObjectLocationHint
  name?: string
  namespace: DurableObjectNamespace<TipbotChatStateDO>
  shardKey?: (threadId: string) => string
}

export class CloudflareDOStateAdapter implements StateAdapter {
  private connected = false
  private readonly defaultName: string
  private readonly locationHint: DurableObjectLocationHint | undefined
  private readonly namespace: DurableObjectNamespace<TipbotChatStateDO>
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
