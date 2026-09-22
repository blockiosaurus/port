export type PortErrorCode =
  | "NOT_A_PORT"
  | "NOT_AUTHORIZED"
  | "NOT_DELEGATED"
  | "PROGRAM_NOT_ALLOWED"
  | "UNEXPECTED_SIGNER"
  | "INVALID_STRATEGY"
  | "TX_FAILED";

export class PortError extends Error {
  constructor(
    readonly code: PortErrorCode,
    message: string,
    readonly logs?: string[],
  ) {
    super(message);
    this.name = "PortError";
  }
}

/** Map Core's "no plugin approved" (0x1a) and similar failures into typed errors. */
export function toPortError(e: unknown): PortError {
  if (e instanceof PortError) return e;
  const err = e as { message?: string; transactionLogs?: string[]; logs?: string[] };
  const message = err?.message ?? String(e);
  const logs = err?.transactionLogs ?? err?.logs;
  if (/Neither the asset or any plugins have approved|0x1a/.test(message))
    return new PortError("NOT_AUTHORIZED", "The signer is neither the PORT owner nor an active execution delegate.", logs);
  const lines = message.split("\n").map((l) => l.trim()).filter(Boolean);
  const detail = lines.find((l) => /^Message:|Error|failed/i.test(l) && !/^Simulation failed\.?$/.test(l)) ?? lines[0] ?? message;
  return new PortError("TX_FAILED", detail, logs);
}
