import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { PortActivitySchema, type PortActivity } from "@port/shared";
import { z } from "zod";

/**
 * Append-only JSON activity log. Good enough for a single-node demo; every record is
 * schema-validated on read and write. Swap for a database without changing callers.
 */
export class ActivityStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly path: string) {}

  async list(portAsset?: string): Promise<PortActivity[]> {
    const all = await this.readAll();
    return (portAsset ? all.filter((a) => a.portAsset === portAsset) : all).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  async append(input: Omit<PortActivity, "id" | "timestamp"> & Partial<Pick<PortActivity, "id" | "timestamp">>): Promise<PortActivity> {
    const record = PortActivitySchema.parse({ id: randomUUID(), timestamp: new Date().toISOString(), ...input });
    await this.mutate((all) => [...all, record]);
    return record;
  }

  async update(id: string, patch: Partial<PortActivity>): Promise<void> {
    await this.mutate((all) => all.map((a) => (a.id === id ? PortActivitySchema.parse({ ...a, ...patch }) : a)));
  }

  /** Sum of confirmed trade notional (1e8 USD) over the trailing 24h, for the daily cap. */
  async dailyNotionalE8(portAsset: string, now = Date.now()): Promise<bigint> {
    const cutoff = new Date(now - 86_400_000).toISOString();
    return (await this.list(portAsset))
      .filter((a) => a.action === "trade" && a.status === "confirmed" && a.timestamp >= cutoff)
      .reduce((sum, a) => sum + BigInt(String(a.details?.notionalE8 ?? "0")), 0n);
  }

  private async readAll(): Promise<PortActivity[]> {
    try {
      return z.array(PortActivitySchema).parse(JSON.parse(await readFile(this.path, "utf8")));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
  }

  private mutate(fn: (all: PortActivity[]) => PortActivity[]): Promise<void> {
    const next = this.queue.then(async () => {
      const all = fn(await this.readAll());
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(this.path, JSON.stringify(all, null, 2));
    });
    this.queue = next.catch(() => {});
    return next;
  }
}
