// Process-local LRU with bounded memory and one render per key in flight.
export class PreviewCache {
  private entries = new Map<string, { buffer: Buffer; expires: number }>()
  private pending = new Map<string, Promise<Buffer>>()
  private bytes = 0

  constructor(
    private maxBytes = 32 * 1024 * 1024,
    private ttl = 3600_000,
  ) {}

  async get(key: string, render: () => Promise<Buffer>): Promise<Buffer> {
    const entry = this.entries.get(key)
    if (entry) {
      this.entries.delete(key)
      if (entry.expires > Date.now()) {
        this.entries.set(key, entry)
        return entry.buffer
      }
      this.bytes -= entry.buffer.length
    }
    const pending = this.pending.get(key)
    if (pending) return pending
    const job = Promise.resolve()
      .then(render)
      .then((buffer) => {
        if (buffer.length <= this.maxBytes) {
          while (this.bytes + buffer.length > this.maxBytes) {
            const oldest = this.entries.entries().next().value
            if (!oldest) break
            this.entries.delete(oldest[0])
            this.bytes -= oldest[1].buffer.length
          }
          this.entries.set(key, { buffer, expires: Date.now() + this.ttl })
          this.bytes += buffer.length
        }
        return buffer
      })
      .finally(() => {
        this.pending.delete(key)
      })
    this.pending.set(key, job)
    return job
  }
}
