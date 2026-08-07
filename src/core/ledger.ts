import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LoopError,
  sha256Hex,
  type Digest,
  type EventRecord,
  type LoopId,
  type LoopPhase,
  type LoopStatus,
  type MarkdownLanguage,
} from "../contracts/domain.js";
import {
  appendJsonLine,
  assertEnglishMachineStrings,
  atomicWriteJson,
  canonicalJsonBytes,
} from "./atomic-json.js";
import { acquireLock, type LockClock, type LockLease } from "./lock.js";
import type { LoopLayout } from "./paths.js";
import { validateSchema, type SchemaName } from "./schema.js";

export const GENESIS_DIGEST = "0".repeat(64) as Digest;

const TRANSACTION_SCHEMAS = {
  BOOTSTRAP: "harness",
  HARNESS: "harness",
  WAVE_INPUT: "wave-input",
  EVIDENCE: "evidence",
  CHECKPOINT: "checkpoint",
  HANDOFF: "handoff",
  DISPATCH: "agent-request",
  AGENT_RESULT: "agent-result",
  AGENT_BUNDLE: "agent-bundle",
  INTEGRATION: "agent-bundle",
  RELEASE: "release",
  ACTION: "action-envelope",
} as const satisfies Readonly<Record<string, SchemaName>>;

export type TransactionKind = keyof typeof TRANSACTION_SCHEMAS;

export interface LedgerCursor {
  sequence: number;
  eventHash: Digest;
  snapshotDigest: Digest;
}

export interface LoopSnapshot {
  schema_version: 2;
  loop_id: LoopId;
  parent_loop_id: LoopId | null;
  phase: LoopPhase;
  status: LoopStatus;
  markdown_language: MarkdownLanguage;
  last_event_sequence: number;
  last_event_hash: Digest;
  current_harness_revision: number | null;
  current_harness_digest: Digest | null;
  handoff_digest: Digest | null;
}

export interface CommittedTransaction<T> {
  transactionId: string;
  kind: TransactionKind;
  artifact: T;
  artifactPath: string;
  cursor: LedgerCursor;
  snapshot: LoopSnapshot;
}

export type LedgerFaultPoint =
  | "after-intent"
  | "after-artifact-temp-write"
  | "after-artifact-sync"
  | "after-artifact-rename"
  | "after-commit"
  | "before-snapshot-replace"
  | "after-snapshot-replace";

export interface LedgerOptions {
  clock?: LockClock;
  lockTtlMs?: number;
  fault?: (point: LedgerFaultPoint) => void | Promise<void>;
}

export interface RecoveryReport {
  committedTransactions: readonly string[];
  abandonedTransactions: readonly string[];
  quarantinedArtifacts: readonly string[];
  snapshotRebuilt: boolean;
}

export interface LoopLedger {
  snapshot(): Promise<LoopSnapshot>;
  cursor(): Promise<LedgerCursor>;
  transact<T>(
    kind: TransactionKind,
    expected: LedgerCursor,
    writeArtifact: (transactionId: string) => Promise<T>,
  ): Promise<CommittedTransaction<T>>;
  transition(to: LoopPhase, status: LoopStatus, expected: LedgerCursor): Promise<LoopSnapshot>;
  recover(): Promise<RecoveryReport>;
}

interface WorkflowContract {
  schema_version: 2;
  transitions: Readonly<Record<LoopPhase, readonly LoopPhase[]>>;
}

interface SnapshotState {
  schema_version: 2;
  loop_id: LoopId;
  parent_loop_id: LoopId | null;
  phase: LoopPhase;
  status: LoopStatus;
  markdown_language: MarkdownLanguage;
  current_harness_revision: number | null;
  current_harness_digest: Digest | null;
  handoff_digest: Digest | null;
}

interface ArtifactEnvelope<T = unknown> {
  envelope_version: 1;
  transaction_id: string;
  kind: string;
  schema_name: SchemaName;
  base_snapshot_digest: Digest;
  state: SnapshotState;
  artifact: T;
}

interface ParsedTransaction {
  transactionId: string;
  kind: string;
  intent: EventRecord;
  commit?: EventRecord;
}

const systemClock: LockClock = { now: () => new Date() };
const OVERLAY_STATUSES = new Set<LoopStatus>(["PAUSED", "BLOCKED", "DEGRADED"]);

function ledgerRoot(layout: LoopLayout): string {
  return join(layout.loopRoot, ".ledger");
}

function pendingRoot(layout: LoopLayout): string {
  return join(ledgerRoot(layout), "pending");
}

function artifactRoot(layout: LoopLayout): string {
  return join(ledgerRoot(layout), "artifacts");
}

function quarantineRoot(layout: LoopLayout): string {
  return join(ledgerRoot(layout), "quarantine");
}

function artifactPath(layout: LoopLayout, transactionId: string): string {
  return join(artifactRoot(layout), `${transactionId}.json`);
}

function pendingPath(layout: LoopLayout, transactionId: string): string {
  return join(pendingRoot(layout), `${transactionId}.pending.json`);
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function stateOf(snapshot: LoopSnapshot): SnapshotState {
  return {
    schema_version: 2,
    loop_id: snapshot.loop_id,
    parent_loop_id: snapshot.parent_loop_id,
    phase: snapshot.phase,
    status: snapshot.status,
    markdown_language: snapshot.markdown_language,
    current_harness_revision: snapshot.current_harness_revision,
    current_harness_digest: snapshot.current_harness_digest,
    handoff_digest: snapshot.handoff_digest,
  };
}

function snapshotFromState(state: SnapshotState, sequence: number, eventHash: Digest): LoopSnapshot {
  return validateSchema<LoopSnapshot>("loop", {
    ...state,
    last_event_sequence: sequence,
    last_event_hash: eventHash,
  });
}

function initialSnapshot(loopId: LoopId): LoopSnapshot {
  return snapshotFromState({
    schema_version: 2,
    loop_id: loopId,
    parent_loop_id: null,
    phase: "NEW",
    status: "ACTIVE",
    markdown_language: "en-US",
    current_harness_revision: null,
    current_harness_digest: null,
    handoff_digest: null,
  }, 0, GENESIS_DIGEST);
}

function snapshotDigest(snapshot: LoopSnapshot): Digest {
  return sha256Hex(canonicalJsonBytes(snapshot));
}

function cursorFor(snapshot: LoopSnapshot): LedgerCursor {
  return {
    sequence: snapshot.last_event_sequence,
    eventHash: snapshot.last_event_hash,
    snapshotDigest: snapshotDigest(snapshot),
  };
}

function cursorsEqual(left: LedgerCursor, right: LedgerCursor): boolean {
  return left.sequence === right.sequence
    && left.eventHash === right.eventHash
    && left.snapshotDigest === right.snapshotDigest;
}

async function readSnapshot(path: string): Promise<LoopSnapshot> {
  try {
    return validateSchema<LoopSnapshot>("loop", JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new LoopError("RECONCILE_REQUIRED", "The Loop snapshot is missing.", { path });
    }
    throw error;
  }
}

function eventWithoutHash(event: Omit<EventRecord, "hash">): Omit<EventRecord, "hash"> {
  return event;
}

function createEvent(
  layout: LoopLayout,
  sequence: number,
  previousHash: Digest,
  type: string,
  transactionId: string,
  dataDigest: Digest,
  timestamp: string,
): EventRecord {
  const withoutHash = eventWithoutHash({
    schema_version: 1,
    sequence,
    event_id: `${transactionId}:${type.endsWith("_INTENT") ? "intent" : "commit"}`,
    loop_id: layout.loopId,
    type,
    actor_role: "ledger",
    timestamp,
    previous_hash: previousHash,
    payload: { kind: transactionId, data_digest: dataDigest },
  });
  const hash = sha256Hex(Buffer.concat([
    Buffer.from(previousHash, "utf8"),
    Buffer.from(canonicalJsonBytes(withoutHash)),
  ]));
  return validateSchema<EventRecord>("event", { ...withoutHash, hash });
}

async function readEvents(path: string): Promise<EventRecord[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
  if (text === "") return [];
  if (!text.endsWith("\n")) {
    throw new LoopError("RECONCILE_REQUIRED", "The event log has an incomplete final record.", { path });
  }

  const events: EventRecord[] = [];
  let previousHash = GENESIS_DIGEST;
  for (const [index, line] of text.slice(0, -1).split("\n").entries()) {
    if (line === "") {
      throw new LoopError("RECONCILE_REQUIRED", "The event log contains an empty record.", { sequence: index + 1 });
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new LoopError("RECONCILE_REQUIRED", "The event log contains malformed JSON.", { sequence: index + 1 });
    }
    const event = validateSchema<EventRecord>("event", value);
    const { hash, ...withoutHash } = event;
    const expectedHash = sha256Hex(Buffer.concat([
      Buffer.from(previousHash, "utf8"),
      Buffer.from(canonicalJsonBytes(withoutHash)),
    ]));
    if (event.sequence !== index + 1 || event.previous_hash !== previousHash || hash !== expectedHash) {
      throw new LoopError("RECONCILE_REQUIRED", "The event hash chain is invalid.", {
        sequence: event.sequence,
      });
    }
    events.push(event);
    previousHash = event.hash;
  }
  return events;
}

function eventHead(events: readonly EventRecord[]): { sequence: number; hash: Digest } {
  const last = events.at(-1);
  return last === undefined ? { sequence: 0, hash: GENESIS_DIGEST } : { sequence: last.sequence, hash: last.hash };
}

function assertEventLoop(events: readonly EventRecord[], loopId: LoopId): void {
  const mismatched = events.find((event) => event.loop_id !== loopId);
  if (mismatched !== undefined) {
    throw new LoopError("RECONCILE_REQUIRED", "The event log contains an event for another Loop.", {
      sequence: mismatched.sequence,
    });
  }
}

function parseTransactions(events: readonly EventRecord[]): ParsedTransaction[] {
  const transactions = new Map<string, ParsedTransaction>();
  for (const event of events) {
    const intentMatch = /^(?<kind>[A-Z][A-Z0-9_]*)_INTENT$/u.exec(event.type);
    const commitMatch = /^(?<kind>[A-Z][A-Z0-9_]*)_COMMIT$/u.exec(event.type);
    const kind = intentMatch?.groups?.kind ?? commitMatch?.groups?.kind;
    if (kind === undefined) {
      throw new LoopError("RECONCILE_REQUIRED", "The event log contains an unsupported ledger event.", {
        type: event.type,
      });
    }
    const transactionId = event.payload.kind;
    if (intentMatch !== null) {
      if (transactions.has(transactionId)) {
        throw new LoopError("RECONCILE_REQUIRED", "A transaction has duplicate Intent events.", { transaction_id: transactionId });
      }
      transactions.set(transactionId, { transactionId, kind, intent: event });
      continue;
    }
    const transaction = transactions.get(transactionId);
    if (transaction === undefined || transaction.kind !== kind || transaction.commit !== undefined) {
      throw new LoopError("RECONCILE_REQUIRED", "A Commit event has no unique matching Intent.", {
        transaction_id: transactionId,
      });
    }
    transaction.commit = event;
  }
  return [...transactions.values()];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function schemaForKind(kind: string): SchemaName {
  if (kind === "TRANSITION") return "loop";
  const schema = TRANSACTION_SCHEMAS[kind as TransactionKind];
  if (schema === undefined) {
    throw new LoopError("RECONCILE_REQUIRED", "The transaction kind is unsupported.", { kind });
  }
  return schema;
}

function parseEnvelope(value: unknown, transaction: ParsedTransaction): ArtifactEnvelope {
  if (!isRecord(value)) {
    throw new LoopError("RECONCILE_REQUIRED", "The committed transaction artifact is malformed.", {
      transaction_id: transaction.transactionId,
    });
  }
  const keys = Object.keys(value).sort();
  const expectedKeys = ["artifact", "base_snapshot_digest", "envelope_version", "kind", "schema_name", "state", "transaction_id"];
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
    throw new LoopError("RECONCILE_REQUIRED", "The committed transaction envelope has unexpected fields.", {
      transaction_id: transaction.transactionId,
    });
  }
  const schema = schemaForKind(transaction.kind);
  if (
    value.envelope_version !== 1
    || value.transaction_id !== transaction.transactionId
    || value.kind !== transaction.kind
    || value.schema_name !== schema
    || typeof value.base_snapshot_digest !== "string"
    || !/^[0-9a-f]{64}$/u.test(value.base_snapshot_digest)
  ) {
    throw new LoopError("RECONCILE_REQUIRED", "The committed transaction envelope identity is invalid.", {
      transaction_id: transaction.transactionId,
    });
  }
  validateSchema(schema, value.artifact);
  if (!isRecord(value.state)) {
    throw new LoopError("RECONCILE_REQUIRED", "The committed transaction state is malformed.", {
      transaction_id: transaction.transactionId,
    });
  }
  const state = value.state as unknown as SnapshotState;
  snapshotFromState(state, transaction.commit?.sequence ?? transaction.intent.sequence, transaction.commit?.hash ?? transaction.intent.hash);
  return value as unknown as ArtifactEnvelope;
}

async function readEnvelope(layout: LoopLayout, transaction: ParsedTransaction): Promise<ArtifactEnvelope> {
  const path = artifactPath(layout, transaction.transactionId);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new LoopError("RECONCILE_REQUIRED", "A committed event is missing its complete artifact.", {
      transaction_id: transaction.transactionId,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  const envelope = parseEnvelope(value, transaction);
  if (transaction.commit === undefined) return envelope;
  const digest = sha256Hex(canonicalJsonBytes(envelope));
  if (transaction.commit.payload.data_digest !== digest) {
    throw new LoopError("RECONCILE_REQUIRED", "The committed artifact digest does not match its event.", {
      transaction_id: transaction.transactionId,
    });
  }
  return envelope;
}

async function writeAll(handle: FileHandle, data: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < data.byteLength) {
    const { bytesWritten } = await handle.write(data, offset, data.byteLength - offset, null);
    if (bytesWritten === 0) throw new Error("Ledger artifact write made no progress.");
    offset += bytesWritten;
  }
}

async function writePendingEnvelope(
  layout: LoopLayout,
  transactionId: string,
  envelope: ArtifactEnvelope,
  fault: LedgerOptions["fault"],
): Promise<string> {
  const pending = pendingPath(layout, transactionId);
  const committed = artifactPath(layout, transactionId);
  await mkdir(dirname(pending), { recursive: true });
  await mkdir(dirname(committed), { recursive: true });
  const handle = await open(pending, "wx", 0o600);
  try {
    await writeAll(handle, canonicalJsonBytes(envelope));
    await fault?.("after-artifact-temp-write");
    await handle.sync();
    await fault?.("after-artifact-sync");
  } finally {
    await handle.close();
  }
  await rename(pending, committed);
  await fault?.("after-artifact-rename");
  let directoryHandle: FileHandle | undefined;
  try {
    directoryHandle = await open(dirname(committed), "r");
    await directoryHandle.sync();
  } catch (error) {
    const code = errorCode(error);
    const unsupported = code === "EINVAL" || code === "ENOTSUP" || code === "EOPNOTSUPP"
      || (process.platform === "win32" && ["EPERM", "EACCES", "EISDIR", "EBADF"].includes(code ?? ""));
    if (!unsupported) throw error;
  } finally {
    await directoryHandle?.close();
  }
  return committed;
}

function transitionError(message: string, snapshot: LoopSnapshot, to: LoopPhase, status: LoopStatus): LoopError {
  return new LoopError("INVALID_TRANSITION", message, {
    from_phase: snapshot.phase,
    from_status: snapshot.status,
    to_phase: to,
    to_status: status,
  });
}

function nextTransitionState(
  snapshot: LoopSnapshot,
  workflow: WorkflowContract,
  to: LoopPhase,
  status: LoopStatus,
): SnapshotState {
  if (snapshot.status === "NON_CONVERGENT") {
    throw new LoopError("NON_CONVERGENT", "A non-convergent Loop cannot resume; create a Child Loop.", {
      phase: snapshot.phase,
    });
  }
  if (snapshot.phase === "HANDOFF_READY" || snapshot.phase === "CANCELLED") {
    throw transitionError("The Loop is in a closed terminal phase.", snapshot, to, status);
  }

  if (to === "CANCELLED" || status === "CANCELLED") {
    if (to !== "CANCELLED" || status !== "CANCELLED" || !workflow.transitions[snapshot.phase].includes("CANCELLED")) {
      throw transitionError("Cancellation must set both phase and status to CANCELLED.", snapshot, to, status);
    }
  } else if (status === "NON_CONVERGENT") {
    if (to !== snapshot.phase) throw transitionError("NON_CONVERGENT must preserve the current phase.", snapshot, to, status);
  } else if (OVERLAY_STATUSES.has(status)) {
    if (to !== snapshot.phase) throw transitionError("Status overlays must preserve the current phase.", snapshot, to, status);
  } else if (status === "COMPLETE") {
    if (to !== "HANDOFF_READY" || snapshot.status !== "ACTIVE" || !workflow.transitions[snapshot.phase].includes(to)) {
      throw transitionError("COMPLETE is valid only on the HANDOFF_READY workflow edge.", snapshot, to, status);
    }
  } else if (status === "ACTIVE") {
    if (to === snapshot.phase) {
      if (!OVERLAY_STATUSES.has(snapshot.status)) {
        throw transitionError("An ACTIVE same-phase transition must resume an overlay status.", snapshot, to, status);
      }
    } else if (snapshot.status !== "ACTIVE" || to === "HANDOFF_READY" || !workflow.transitions[snapshot.phase].includes(to)) {
      throw transitionError("The requested workflow edge is not legal from the current state.", snapshot, to, status);
    }
  } else {
    throw transitionError("The requested phase/status combination is invalid.", snapshot, to, status);
  }

  return {
    ...stateOf(snapshot),
    phase: to,
    status,
  };
}

async function quarantineFile(layout: LoopLayout, path: string): Promise<string | undefined> {
  await mkdir(quarantineRoot(layout), { recursive: true });
  const destination = join(quarantineRoot(layout), `${path.split(/[\\/]/u).at(-1) ?? "artifact"}.quarantine-${randomUUID()}`);
  try {
    await rename(path, destination);
    return destination;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

async function filesIn(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => join(path, entry.name))
      .sort();
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
}

class FileLoopLedger implements LoopLedger {
  readonly #workflow: WorkflowContract;
  readonly #clock: LockClock;
  readonly #lockTtlMs: number;
  readonly #fault: LedgerOptions["fault"];

  constructor(
    readonly layout: LoopLayout,
    workflow: WorkflowContract,
    options: LedgerOptions,
  ) {
    this.#workflow = workflow;
    this.#clock = options.clock ?? systemClock;
    this.#lockTtlMs = options.lockTtlMs ?? 30_000;
    this.#fault = options.fault;
  }

  async #lease(): Promise<LockLease> {
    return acquireLock({
      target: this.layout.loopRoot,
      ownerId: `ledger-${process.pid}-${randomUUID()}`,
      ttlMs: this.#lockTtlMs,
      clock: this.#clock,
    });
  }

  async snapshot(): Promise<LoopSnapshot> {
    return readSnapshot(this.layout.loopJson);
  }

  async cursor(): Promise<LedgerCursor> {
    const snapshot = await this.snapshot();
    const head = eventHead(await readEvents(this.layout.eventsJsonl));
    if (snapshot.last_event_sequence !== head.sequence || snapshot.last_event_hash !== head.hash) {
      throw new LoopError("RECONCILE_REQUIRED", "The Loop snapshot does not match the event-log head.", {
        snapshot_sequence: snapshot.last_event_sequence,
        event_sequence: head.sequence,
      });
    }
    return cursorFor(snapshot);
  }

  async #transact<T>(
    kind: string,
    schema: SchemaName,
    expected: LedgerCursor,
    writeArtifact: (transactionId: string) => Promise<T>,
    nextState?: SnapshotState,
  ): Promise<CommittedTransaction<T>> {
    const lease = await this.#lease();
    try {
      const snapshot = await this.snapshot();
      const events = await readEvents(this.layout.eventsJsonl);
      assertEventLoop(events, this.layout.loopId);
      const head = eventHead(events);
      const current = cursorFor(snapshot);
      if (head.sequence !== current.sequence || head.hash !== current.eventHash || !cursorsEqual(current, expected)) {
        throw new LoopError("CAS_MISMATCH", "The ledger cursor changed before the transaction.", {
          expected_sequence: expected.sequence,
          actual_sequence: head.sequence,
        });
      }

      const transactionId = randomUUID();
      const intentDigest = sha256Hex(canonicalJsonBytes({
        transaction_id: transactionId,
        kind,
        expected_sequence: expected.sequence,
        expected_event_hash: expected.eventHash,
        expected_snapshot_digest: expected.snapshotDigest,
      }));
      const timestamp = this.#clock.now().toISOString();
      const intent = createEvent(
        this.layout,
        head.sequence + 1,
        head.hash,
        `${kind}_INTENT`,
        transactionId,
        intentDigest,
        timestamp,
      );
      await lease.assertCurrent();
      await appendJsonLine(this.layout.eventsJsonl, intent);
      await this.#fault?.("after-intent");

      const artifact = await writeArtifact(transactionId);
      validateSchema(schema, artifact);
      assertEnglishMachineStrings(artifact);
      const envelope: ArtifactEnvelope<T> = {
        envelope_version: 1,
        transaction_id: transactionId,
        kind,
        schema_name: schema,
        base_snapshot_digest: expected.snapshotDigest,
        state: nextState ?? stateOf(snapshot),
        artifact,
      };
      const envelopeDigest = sha256Hex(canonicalJsonBytes(envelope));
      const committedArtifactPath = await writePendingEnvelope(this.layout, transactionId, envelope, this.#fault);

      const commit = createEvent(
        this.layout,
        intent.sequence + 1,
        intent.hash,
        `${kind}_COMMIT`,
        transactionId,
        envelopeDigest,
        this.#clock.now().toISOString(),
      );
      await lease.assertCurrent();
      await appendJsonLine(this.layout.eventsJsonl, commit);
      await this.#fault?.("after-commit");

      const committedSnapshot = snapshotFromState(envelope.state, commit.sequence, commit.hash);
      await this.#fault?.("before-snapshot-replace");
      await atomicWriteJson(this.layout.loopJson, committedSnapshot);
      await this.#fault?.("after-snapshot-replace");
      return {
        transactionId,
        kind: kind as TransactionKind,
        artifact,
        artifactPath: committedArtifactPath,
        cursor: cursorFor(committedSnapshot),
        snapshot: committedSnapshot,
      };
    } finally {
      await lease.release();
    }
  }

  async transact<T>(
    kind: TransactionKind,
    expected: LedgerCursor,
    writeArtifact: (transactionId: string) => Promise<T>,
  ): Promise<CommittedTransaction<T>> {
    return this.#transact(kind, TRANSACTION_SCHEMAS[kind], expected, writeArtifact);
  }

  async transition(to: LoopPhase, status: LoopStatus, expected: LedgerCursor): Promise<LoopSnapshot> {
    const snapshot = await this.snapshot();
    if (!cursorsEqual(cursorFor(snapshot), expected)) {
      throw new LoopError("CAS_MISMATCH", "The snapshot changed before transition validation.");
    }
    const nextState = nextTransitionState(snapshot, this.#workflow, to, status);
    const artifact = snapshotFromState(nextState, snapshot.last_event_sequence, snapshot.last_event_hash);
    const committed = await this.#transact("TRANSITION", "loop", expected, async () => artifact, nextState);
    return committed.snapshot;
  }

  async recover(): Promise<RecoveryReport> {
    const lease = await this.#lease();
    try {
      const events = await readEvents(this.layout.eventsJsonl);
      assertEventLoop(events, this.layout.loopId);
      const transactions = parseTransactions(events);
      const committed = transactions.filter((transaction) => transaction.commit !== undefined);
      let rebuilt = initialSnapshot(this.layout.loopId);
      const transactionsById = new Map(transactions.map((transaction) => [transaction.transactionId, transaction]));
      const envelopes = new Map<string, ArtifactEnvelope>();

      for (const event of events) {
        const transaction = transactionsById.get(event.payload.kind);
        if (transaction === undefined) throw new Error("Parsed transaction invariant failed.");
        if (event.type.endsWith("_INTENT")) {
          const expectedIntentDigest = sha256Hex(canonicalJsonBytes({
            transaction_id: transaction.transactionId,
            kind: transaction.kind,
            expected_sequence: rebuilt.last_event_sequence,
            expected_event_hash: rebuilt.last_event_hash,
            expected_snapshot_digest: snapshotDigest(rebuilt),
          }));
          if (event.payload.data_digest !== expectedIntentDigest) {
            throw new LoopError("RECONCILE_REQUIRED", "An Intent does not match its expected ledger cursor.", {
              transaction_id: transaction.transactionId,
            });
          }
          if (transaction.commit !== undefined) {
            const envelope = await readEnvelope(this.layout, transaction);
            if (envelope.base_snapshot_digest !== snapshotDigest(rebuilt)) {
              throw new LoopError("RECONCILE_REQUIRED", "A committed transaction has a stale base snapshot.", {
                transaction_id: transaction.transactionId,
              });
            }
            envelopes.set(transaction.transactionId, envelope);
          }
          rebuilt = snapshotFromState(stateOf(rebuilt), event.sequence, event.hash);
          continue;
        }

        const envelope = envelopes.get(transaction.transactionId);
        if (envelope === undefined) throw new Error("Committed transaction envelope invariant failed.");
        rebuilt = snapshotFromState(envelope.state, event.sequence, event.hash);
      }

      let existing: LoopSnapshot | undefined;
      try {
        existing = await readSnapshot(this.layout.loopJson);
      } catch (error) {
        if (!(error instanceof LoopError) || error.code !== "RECONCILE_REQUIRED") throw error;
      }
      const snapshotRebuilt = existing === undefined || snapshotDigest(existing) !== snapshotDigest(rebuilt);
      if (snapshotRebuilt) await atomicWriteJson(this.layout.loopJson, rebuilt);

      const committedIds = new Set(committed.map((transaction) => transaction.transactionId));
      const quarantined: string[] = [];
      for (const path of await filesIn(pendingRoot(this.layout))) {
        const destination = await quarantineFile(this.layout, path);
        if (destination !== undefined) quarantined.push(destination);
      }
      for (const path of await filesIn(artifactRoot(this.layout))) {
        const transactionId = path.split(/[\\/]/u).at(-1)?.replace(/\.json$/u, "");
        if (transactionId !== undefined && !committedIds.has(transactionId)) {
          const destination = await quarantineFile(this.layout, path);
          if (destination !== undefined) quarantined.push(destination);
        }
      }

      return {
        committedTransactions: committed.map((transaction) => transaction.transactionId),
        abandonedTransactions: transactions
          .filter((transaction) => transaction.commit === undefined)
          .map((transaction) => transaction.transactionId),
        quarantinedArtifacts: quarantined,
        snapshotRebuilt,
      };
    } finally {
      await lease.release();
    }
  }
}

async function loadWorkflow(): Promise<WorkflowContract> {
  const moduleDirectory = fileURLToPath(new URL(".", import.meta.url));
  const candidates = [
    join(moduleDirectory, "..", "..", "assets", "loop-engineering", "workflow-spec.json"),
    join(moduleDirectory, "..", "..", "..", "assets", "loop-engineering", "workflow-spec.json"),
  ];
  for (const candidate of candidates) {
    try {
      return validateSchema<WorkflowContract>("workflow-spec", JSON.parse(await readFile(candidate, "utf8")));
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
  throw new LoopError("SCHEMA_INVALID", "Workflow specification was not found.");
}

export async function openLedger(layout: LoopLayout, options: LedgerOptions = {}): Promise<LoopLedger> {
  await mkdir(layout.loopRoot, { recursive: true });
  await mkdir(pendingRoot(layout), { recursive: true });
  await mkdir(artifactRoot(layout), { recursive: true });
  try {
    validateSchema<LoopSnapshot>("loop", JSON.parse(await readFile(layout.loopJson, "utf8")));
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    const events = await readEvents(layout.eventsJsonl);
    if (events.length > 0) {
      const ledger = new FileLoopLedger(layout, await loadWorkflow(), options);
      await ledger.recover();
      return ledger;
    }
    await atomicWriteJson(layout.loopJson, initialSnapshot(layout.loopId));
  }
  return new FileLoopLedger(layout, await loadWorkflow(), options);
}
