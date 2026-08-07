import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { LoopError, sha256Hex } from "../contracts/domain.js";
import { atomicWriteJson, canonicalJsonBytes } from "./atomic-json.js";
import { openRepositoryCoordinator } from "./coordinator.js";
import { evaluateGate } from "./harness.js";
import { openLedger } from "./ledger.js";
import { digestWorktreePaths, observeWorktreeWrites } from "./manifests.js";
import { resolveLayout } from "./paths.js";
import { validateSchema } from "./schema.js";
function rejected(message, details = {}) {
    return new LoopError("DISPATCH_REJECTED", message, details);
}
function errorCode(error) {
    return error.code;
}
function normalizePath(path) {
    return path.replace(/\\/gu, "/").replace(/^\.\//u, "").replace(/\/+$/u, "");
}
function setsIntersect(left, right) {
    const rightSet = new Set(right.map(normalizePath));
    return left.some((path) => rightSet.has(normalizePath(path)));
}
export function canShareWave(left, right) {
    if (left.reads === "UNKNOWN" || right.reads === "UNKNOWN")
        return false;
    const leftReads = left.reads.map(normalizePath);
    const rightReads = right.reads.map(normalizePath);
    const leftWrites = left.writes.map(normalizePath);
    const rightWrites = right.writes.map(normalizePath);
    if (setsIntersect(leftWrites, [...rightReads, ...rightWrites]))
        return false;
    if (setsIntersect(rightWrites, [...leftReads, ...leftWrites]))
        return false;
    return true;
}
function dispatchStatePath(layout) {
    return join(layout.harnessRoot, "dispatch-state.json");
}
function emptyState(loopId) {
    return {
        schema_version: 1,
        loop_id: loopId,
        next_fencing_token: 1,
        reservations: [],
        pending_bundles: [],
        integrated_write_sets: [],
        completed_work_item_ids: [],
        abandoned_transaction_ids: [],
    };
}
async function readDispatchState(layout) {
    try {
        const value = JSON.parse(await readFile(dispatchStatePath(layout), "utf8"));
        if (value.schema_version !== 1 || value.loop_id !== layout.loopId) {
            throw new LoopError("RECONCILE_REQUIRED", "Dispatch state identity is invalid.", { path: dispatchStatePath(layout) });
        }
        return value;
    }
    catch (error) {
        if (errorCode(error) === "ENOENT")
            return emptyState(layout.loopId);
        throw error;
    }
}
async function writeDispatchState(layout, state) {
    await mkdir(layout.harnessRoot, { recursive: true });
    await atomicWriteJson(dispatchStatePath(layout), state);
}
async function loadH1(layout, digest) {
    const snapshot = JSON.parse(await readFile(layout.loopJson, "utf8"));
    if (snapshot.current_harness_digest !== digest || snapshot.current_harness_revision === null) {
        throw rejected("The H1 digest does not match the current Loop Harness.", {
            expected: digest,
            actual: snapshot.current_harness_digest,
        });
    }
    const path = join(layout.harnessRoot, `h1-execution-r${String(snapshot.current_harness_revision).padStart(3, "0")}.json`);
    const h1 = validateSchema("harness", JSON.parse(await readFile(path, "utf8")));
    if (h1.kind !== "H1" || h1.digest !== digest) {
        throw rejected("The sealed H1 Harness could not be loaded for dispatch.", { path });
    }
    return h1;
}
async function loadWaveInput(layout, digest) {
    const directory = join(layout.harnessRoot, "wave-inputs");
    let entries;
    try {
        entries = await readdir(directory);
    }
    catch (error) {
        if (errorCode(error) === "ENOENT") {
            throw rejected("No WaveInput is available for dispatch.", { directory });
        }
        throw error;
    }
    for (const entry of entries) {
        if (!entry.endsWith(".json"))
            continue;
        const wave = validateSchema("wave-input", JSON.parse(await readFile(join(directory, entry), "utf8")));
        if (wave.digest === digest)
            return wave;
    }
    throw rejected("The WaveInput digest does not match a sealed WaveInput.", { digest });
}
function attemptDirectory(layout, workItemId, attempt) {
    return join(layout.harnessRoot, "attempts", workItemId, String(attempt));
}
function outputDirectory(layout, workItemId, attempt) {
    return join(attemptDirectory(layout, workItemId, attempt), "output");
}
function patchPath(layout, workItemId, attempt) {
    return join(attemptDirectory(layout, workItemId, attempt), "patch.json");
}
function appliedMarkerPath(layout, workItemId, attempt) {
    return join(attemptDirectory(layout, workItemId, attempt), "applied.json");
}
async function captureBaselineDigests(worktree, baseSha, writeSet) {
    const changed = await observeWorktreeWrites({ root: worktree, baseSha });
    const paths = [...new Set([...changed, ...writeSet.map(normalizePath)])].sort();
    return digestWorktreePaths(worktree, paths);
}
async function independentlyObserveAgentWrites(worktree, baseSha, baselineDigests) {
    const changed = await observeWorktreeWrites({ root: worktree, baseSha });
    const currentDigests = await digestWorktreePaths(worktree, changed);
    const writes = [];
    for (const path of changed) {
        const current = currentDigests[path] ?? sha256Hex("deleted");
        const baseline = baselineDigests[path];
        if (baseline === undefined || baseline !== current)
            writes.push(path);
    }
    return writes.sort();
}
async function sealOutputTree(layout, workItemId, attempt, worktree, writes, requestId, baseSha) {
    const outputRoot = outputDirectory(layout, workItemId, attempt);
    await rm(outputRoot, { recursive: true, force: true });
    await mkdir(outputRoot, { recursive: true });
    const digests = await digestWorktreePaths(worktree, writes);
    for (const path of writes) {
        const source = resolve(worktree, path);
        const target = join(outputRoot, path);
        const digest = digests[path];
        if (digest === sha256Hex("deleted")) {
            await mkdir(dirname(target), { recursive: true });
            await writeFile(`${target}.deleted`, "deleted\n", "utf8");
            continue;
        }
        await mkdir(dirname(target), { recursive: true });
        await copyFile(source, target);
    }
    const patch = {
        schema_version: 1,
        request_id: requestId,
        worktree,
        base_sha: baseSha,
        writes: [...writes],
        digests,
    };
    await atomicWriteJson(patchPath(layout, workItemId, attempt), patch);
    return { patch, patchDigest: sha256Hex(canonicalJsonBytes(patch)) };
}
async function applySealedPatch(layout, workItemId, attempt, targetWorkspace) {
    const marker = appliedMarkerPath(layout, workItemId, attempt);
    try {
        await readFile(marker, "utf8");
        throw rejected("The sealed bundle was already applied to a live tree.", { work_item_id: workItemId, attempt });
    }
    catch (error) {
        if (error instanceof LoopError)
            throw error;
        if (errorCode(error) !== "ENOENT")
            throw error;
    }
    const patch = JSON.parse(await readFile(patchPath(layout, workItemId, attempt), "utf8"));
    const outputRoot = outputDirectory(layout, workItemId, attempt);
    const targetRoot = resolve(targetWorkspace);
    for (const path of patch.writes) {
        const destination = join(targetRoot, path);
        if (patch.digests[path] === sha256Hex("deleted")) {
            await rm(destination, { force: true });
            continue;
        }
        await mkdir(dirname(destination), { recursive: true });
        await copyFile(join(outputRoot, path), destination);
    }
    await atomicWriteJson(marker, {
        applied_at: new Date().toISOString(),
        target: targetRoot,
        writes: patch.writes,
    });
}
function pendingRoot(layout) {
    return join(layout.harnessRoot, "dispatch-pending");
}
async function writePending(layout, id, value) {
    const path = join(pendingRoot(layout), `${id}.pending.json`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(value)}\n`, "utf8");
    return path;
}
async function commitPending(layout, id, finalPath, value) {
    const pending = join(pendingRoot(layout), `${id}.pending.json`);
    await mkdir(dirname(finalPath), { recursive: true });
    await atomicWriteJson(finalPath, value);
    await rm(pending, { force: true });
}
function digestRequest(content) {
    return validateSchema("agent-request", {
        ...content,
        digest: sha256Hex(canonicalJsonBytes(content)),
    });
}
function digestBundle(content) {
    return validateSchema("agent-bundle", {
        ...content,
        digest: sha256Hex(canonicalJsonBytes(content)),
    });
}
function gateFacts(h1, attemptsUsed, activeWriteWave) {
    return {
        harnessDigest: h1.digest,
        waveInputDigest: h1.wave_input_digest,
        projectPolicyDigest: h1.project_policy_digest,
        planDigest: h1.plan_digest,
        attemptsUsed,
        reviewsUsed: 0,
        transitionsUsed: 0,
        activeWriteWave,
        evidence: [],
    };
}
export async function reserveDispatch(request) {
    const layout = resolveLayout(request.workspace, request.loopId);
    const ledger = await openLedger(layout);
    const state = await readDispatchState(layout);
    const h1 = await loadH1(layout, request.h1Digest);
    const wave = await loadWaveInput(layout, request.waveInputDigest);
    if (wave.digest !== h1.wave_input_digest) {
        throw rejected("The WaveInput digest drifted from the sealed H1 Harness.", {
            wave_input_digest: wave.digest,
            h1_wave_input_digest: h1.wave_input_digest,
        });
    }
    if (resolve(request.worktree) !== resolve(request.workspace) && resolve(request.worktree) !== layout.workspaceRoot) {
        // Worktree may be an independent path; require a non-empty absolute/resolvable identity.
        if (request.worktree.trim() === "") {
            throw rejected("Dispatch requires a Worktree identity.");
        }
    }
    const completed = new Set([
        ...state.completed_work_item_ids,
        ...(request.completedWorkItemIds ?? []),
    ]);
    for (const dependency of request.dependencies) {
        if (!completed.has(dependency)) {
            throw rejected("Dispatch dependencies are not satisfied.", { dependency });
        }
    }
    const actor = h1.actors.find((grant) => grant.actor_role === request.actorRole);
    if (actor === undefined) {
        throw rejected("The actor role is not granted by the Harness.", { actor_role: request.actorRole });
    }
    if (actor.capabilities.includes("recursive-dispatch")) {
        throw rejected("Recursive delegation is prohibited for Sub-agent dispatch.", { actor_role: request.actorRole });
    }
    const mode = request.mode ?? "persistent";
    if (mode === "session-only" && request.writeSet.length > 0) {
        throw rejected("Session-only mode rejects write-capable Sub-agent dispatch.");
    }
    const openReservations = state.reservations.filter((entry) => entry.status === "OPEN");
    if (openReservations.some((entry) => entry.workItemId === request.workItemId)) {
        throw rejected("An open reservation already exists for this work item.", { work_item_id: request.workItemId });
    }
    const priorAttempts = state.reservations.filter((entry) => entry.workItemId === request.workItemId).length;
    const nextAttempt = priorAttempts + 1;
    if (nextAttempt > h1.budgets.attempts) {
        throw rejected("The attempt budget is exhausted.", {
            work_item_id: request.workItemId,
            attempts: h1.budgets.attempts,
        });
    }
    const decision = evaluateGate({
        harness: h1,
        operation: "DISPATCH",
        actorRole: request.actorRole,
        facts: gateFacts(h1, priorAttempts, openReservations.some((entry) => entry.writeSet.length > 0)),
    });
    if (!decision.allowed) {
        throw rejected(decision.reason, { gate_code: decision.code });
    }
    const candidate = { reads: request.readSet, writes: request.writeSet };
    for (const open of openReservations) {
        if (!canShareWave(candidate, { reads: open.readSet, writes: open.writeSet })) {
            throw rejected("The reservation conflicts with an active wave under the symmetric read-write rule.", {
                conflicting_request_id: open.requestId,
            });
        }
        if (open.waveInputDigest !== request.waveInputDigest) {
            throw rejected("Parallel dispatch requires an identical WaveInput digest.", {
                expected: open.waveInputDigest,
                actual: request.waveInputDigest,
            });
        }
    }
    const externalRoots = request.externalWriteRoots ?? [];
    if (externalRoots.length > 0) {
        const externalCapability = h1.capabilities.find((grant) => grant.capability === "external-write");
        if (!request.hostEnforcedExternalWrite || externalCapability?.enforcement !== "HOST_ENFORCED") {
            throw rejected("External writes require HOST_ENFORCED containment and an external-root lease.");
        }
    }
    const coordinator = await openRepositoryCoordinator(request.workspace);
    const leases = [];
    try {
        if (request.writeSet.length > 0) {
            leases.push(await coordinator.reserve({
                loopId: request.loopId,
                kind: "path",
                resources: request.writeSet,
                ttlMs: 60_000,
            }));
        }
        for (const root of externalRoots) {
            leases.push(await coordinator.reserve({
                loopId: request.loopId,
                kind: "external-root",
                resources: [root],
                ttlMs: 60_000,
            }));
        }
        const fencingToken = state.next_fencing_token;
        const requestId = randomUUID();
        const pendingId = randomUUID();
        await writePending(layout, pendingId, {
            kind: "DISPATCH_INTENT",
            request_id: requestId,
            work_item_id: request.workItemId,
            attempt: nextAttempt,
        });
        await request.fault?.("after-reservation-intent");
        const agentRequest = digestRequest({
            schema_version: 1,
            request_id: requestId,
            loop_id: request.loopId,
            work_item_id: request.workItemId,
            attempt: nextAttempt,
            actor_role: request.actorRole,
            objective: request.objective,
            acceptance: [...request.acceptance],
            dependencies: [...request.dependencies],
            read_set: request.readSet === "UNKNOWN" ? "UNKNOWN" : [...request.readSet],
            write_set: [...request.writeSet],
            worktree: request.worktree,
            wave_input_digest: request.waveInputDigest,
            h1_digest: request.h1Digest,
            fencing_token: fencingToken,
            required_evidence_ids: [],
            allowed_tools: h1.capabilities.map((grant) => grant.capability),
            stop_conditions: [...h1.stop_rules],
        });
        const attemptRoot = attemptDirectory(layout, request.workItemId, nextAttempt);
        await mkdir(attemptRoot, { recursive: true });
        await writeFile(join(attemptRoot, "request.pending.json"), `${JSON.stringify(agentRequest)}\n`, "utf8");
        await request.fault?.("after-reservation-artifact");
        await request.fault?.("before-reservation-commit");
        await ledger.transact("DISPATCH", await ledger.cursor(), async () => agentRequest);
        await atomicWriteJson(join(attemptRoot, "request.json"), agentRequest);
        await rm(join(attemptRoot, "request.pending.json"), { force: true });
        await rm(join(pendingRoot(layout), `${pendingId}.pending.json`), { force: true });
        const baselineDigests = await captureBaselineDigests(request.worktree, wave.base_sha, request.writeSet);
        await atomicWriteJson(join(attemptRoot, "baseline.json"), {
            base_sha: wave.base_sha,
            digests: baselineDigests,
        });
        const nextState = {
            ...state,
            next_fencing_token: fencingToken + 1,
            reservations: [
                ...state.reservations,
                {
                    requestId,
                    workItemId: request.workItemId,
                    attempt: nextAttempt,
                    actorRole: request.actorRole,
                    readSet: request.readSet === "UNKNOWN" ? "UNKNOWN" : [...request.readSet],
                    writeSet: [...request.writeSet],
                    worktree: request.worktree,
                    waveInputDigest: request.waveInputDigest,
                    h1Digest: request.h1Digest,
                    fencingToken,
                    leaseIds: leases.map((lease) => lease.leaseId),
                    status: "OPEN",
                    requestDigest: agentRequest.digest,
                    baseSha: wave.base_sha,
                    baselineDigests,
                },
            ],
        };
        await writeDispatchState(layout, nextState);
    }
    finally {
        // Release repository leases before Agent execution.
        for (const lease of leases) {
            try {
                await coordinator.release(lease.leaseId);
            }
            catch {
                // Lease may already be released during reconcile; ignore release races.
            }
        }
    }
    const refreshed = await readDispatchState(layout);
    const saved = refreshed.reservations.find((entry) => entry.status === "OPEN" && entry.workItemId === request.workItemId);
    if (saved === undefined) {
        throw new LoopError("RECONCILE_REQUIRED", "Dispatch reservation was not committed.", {
            work_item_id: request.workItemId,
        });
    }
    return validateSchema("agent-request", JSON.parse(await readFile(join(attemptDirectory(layout, saved.workItemId, saved.attempt), "request.json"), "utf8")));
}
export async function acceptAgentResult(input) {
    const raw = input.result;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        throw rejected("AgentResult must be an object.");
    }
    const record = raw;
    const layout = resolveLayout(input.workspace, record.loop_id);
    const ledger = await openLedger(layout);
    const state = await readDispatchState(layout);
    const { observed_write_set: _observed, digest: providedDigest, ...envelope } = record;
    const expectedDigest = sha256Hex(canonicalJsonBytes(envelope));
    if (providedDigest !== expectedDigest) {
        throw rejected("AgentResult envelope digest mismatch.", {
            expected: expectedDigest,
            actual: providedDigest,
        });
    }
    const result = validateSchema("agent-result", { ...envelope, digest: providedDigest });
    const reservation = state.reservations.find((entry) => entry.requestId === result.request_id
        && (entry.status === "OPEN" || entry.status === "ABANDONED")
        && entry.workItemId === result.work_item_id
        && entry.attempt === result.attempt
        && entry.fencingToken === result.fencing_token);
    if (reservation === undefined) {
        throw rejected("No open reservation matches the AgentResult envelope.");
    }
    if (reservation.waveInputDigest !== result.wave_input_digest || reservation.h1Digest !== result.h1_digest) {
        throw rejected("AgentResult WaveInput or H1 identity drifted from the reservation.");
    }
    if (reservation.actorRole !== result.actor_role) {
        throw rejected("AgentResult actor role does not match the reservation.");
    }
    const allowedWrites = new Set(reservation.writeSet.map(normalizePath));
    const baseSha = reservation.baseSha
        ?? (await loadWaveInput(layout, reservation.waveInputDigest)).base_sha;
    const baselineDigests = reservation.baselineDigests ?? {};
    const independentWrites = await independentlyObserveAgentWrites(reservation.worktree, baseSha, baselineDigests);
    const undeclared = independentWrites.filter((path) => !allowedWrites.has(normalizePath(path)));
    if (undeclared.length > 0) {
        throw rejected("Independently observed writes are outside the declared write set.", { undeclared });
    }
    const claimedExtra = result.actual_write_set.filter((path) => !allowedWrites.has(normalizePath(path)));
    if (claimedExtra.length > 0) {
        throw rejected("AgentResult declares writes outside the reservation write set.", { claimedExtra });
    }
    const independent = [...independentWrites].map(normalizePath).sort();
    const actual = [...result.actual_write_set].map(normalizePath).sort();
    if (JSON.stringify(independent) !== JSON.stringify(actual)) {
        throw rejected("AgentResult actual write set does not match the independently observed Worktree writes.", {
            independent,
            actual,
        });
    }
    if (input.observedWriteSet !== undefined) {
        const claimed = [...input.observedWriteSet].map(normalizePath).sort();
        if (JSON.stringify(claimed) !== JSON.stringify(independent)) {
            throw rejected("Caller-observed write set does not match the independently observed Worktree writes.", {
                claimed,
                independent,
            });
        }
    }
    const pendingId = randomUUID();
    await writePending(layout, pendingId, { kind: "AGENT_RESULT_INTENT", request_id: result.request_id });
    await input.fault?.("after-result-intent");
    const requestPath = join(attemptDirectory(layout, result.work_item_id, result.attempt), "request.json");
    const request = validateSchema("agent-request", JSON.parse(await readFile(requestPath, "utf8")));
    await ledger.transact("AGENT_RESULT", await ledger.cursor(), async () => result);
    await atomicWriteJson(join(attemptDirectory(layout, result.work_item_id, result.attempt), "result.json"), result);
    const sealed = result.status === "COMPLETED"
        ? await sealOutputTree(layout, result.work_item_id, result.attempt, reservation.worktree, independent, result.request_id, baseSha)
        : {
            patchDigest: sha256Hex(canonicalJsonBytes({
                request_id: result.request_id,
                actual_write_set: [],
                status: result.status,
            })),
        };
    const bundleContent = {
        schema_version: 1,
        bundle_id: randomUUID(),
        request_digest: request.digest,
        result_digest: result.digest,
        patch_digest: sealed.patchDigest,
        output_tree_digest: result.output_tree_digest,
        artifact_manifest_digest: result.artifact_manifest_digest,
        evidence_ids: [...result.evidence_ids],
    };
    const bundle = digestBundle(bundleContent);
    const bundlePending = join(attemptDirectory(layout, result.work_item_id, result.attempt), "bundle.pending.json");
    await writeFile(bundlePending, `${JSON.stringify(bundle)}\n`, "utf8");
    await input.fault?.("after-bundle-artifact");
    await ledger.transact("AGENT_BUNDLE", await ledger.cursor(), async () => bundle);
    await commitPending(layout, pendingId, join(attemptDirectory(layout, result.work_item_id, result.attempt), "bundle.json"), bundle);
    await rm(bundlePending, { force: true });
    const terminalStatus = result.status === "COMPLETED" ? "ACCEPTED" : "FAILED";
    const nextBundles = result.status === "COMPLETED"
        ? [
            ...state.pending_bundles,
            {
                bundleDigest: bundle.digest,
                requestId: result.request_id,
                workItemId: result.work_item_id,
                readSet: result.actual_read_set.length > 0
                    ? [...result.actual_read_set]
                    : (Array.isArray(reservation.readSet) ? [...reservation.readSet] : []),
                writeSet: [...independent],
                waveInputDigest: result.wave_input_digest,
                status: "PENDING",
            },
        ]
        : state.pending_bundles;
    const nextState = {
        ...state,
        reservations: state.reservations.map((entry) => (entry.requestId === result.request_id ? { ...entry, status: terminalStatus } : entry)),
        pending_bundles: nextBundles,
        completed_work_item_ids: result.status === "COMPLETED"
            ? state.completed_work_item_ids
            : state.completed_work_item_ids,
    };
    await writeDispatchState(layout, nextState);
    return { request, result, bundle };
}
export async function admitIntegration(request) {
    const layout = resolveLayout(request.workspace, request.loopId);
    const ledger = await openLedger(layout);
    const state = await readDispatchState(layout);
    const pending = state.pending_bundles.find((bundle) => bundle.bundleDigest === request.bundleDigest);
    if (pending === undefined) {
        return { admitted: false, code: "DISPATCH_REJECTED", reason: "No pending sealed bundle matches the digest." };
    }
    if (pending.status === "INTEGRATED") {
        return { admitted: false, code: "DISPATCH_REJECTED", reason: "The sealed bundle was already integrated." };
    }
    if (pending.status === "STALE") {
        return { admitted: false, code: "STALE_AGENT_RESULT", reason: "The sealed bundle is stale relative to integrated changes." };
    }
    const touched = [...pending.readSet, ...pending.writeSet].map(normalizePath);
    if (setsIntersect(state.integrated_write_sets, touched)) {
        const nextState = {
            ...state,
            pending_bundles: state.pending_bundles.map((bundle) => (bundle.bundleDigest === request.bundleDigest ? { ...bundle, status: "STALE" } : bundle)),
        };
        await writeDispatchState(layout, nextState);
        return {
            admitted: false,
            code: "STALE_AGENT_RESULT",
            reason: "Integrated changes intersect the bundle read or write set.",
        };
    }
    const coordinator = await openRepositoryCoordinator(request.workspace);
    const integrationLease = await coordinator.reserve({
        loopId: request.loopId,
        kind: "integration",
        resources: ["tree"],
        ttlMs: 60_000,
    });
    try {
        const pendingId = randomUUID();
        await writePending(layout, pendingId, {
            kind: "INTEGRATION_INTENT",
            bundle_digest: request.bundleDigest,
            fencing_token: integrationLease.fencingToken,
        });
        await request.fault?.("after-integration-intent");
        const reservation = state.reservations.find((entry) => entry.requestId === pending.requestId);
        const attempt = reservation?.attempt ?? 1;
        const bundle = validateSchema("agent-bundle", JSON.parse(await readFile(join(attemptDirectory(layout, pending.workItemId, attempt), "bundle.json"), "utf8")));
        // Apply the sealed output tree exactly once before Commit; never rebase.
        await applySealedPatch(layout, pending.workItemId, attempt, request.workspace);
        await ledger.transact("INTEGRATION", await ledger.cursor(), async () => bundle);
        await rm(join(pendingRoot(layout), `${pendingId}.pending.json`), { force: true });
        const nextState = {
            ...state,
            pending_bundles: state.pending_bundles.map((entry) => {
                if (entry.bundleDigest === request.bundleDigest) {
                    return { ...entry, status: "INTEGRATED" };
                }
                const dependencyPaths = [...entry.readSet, ...entry.writeSet].map(normalizePath);
                if (setsIntersect(pending.writeSet, dependencyPaths)) {
                    return { ...entry, status: "STALE" };
                }
                return entry;
            }),
            integrated_write_sets: [...new Set([
                    ...state.integrated_write_sets.map(normalizePath),
                    ...pending.writeSet.map(normalizePath),
                ])],
            completed_work_item_ids: [...new Set([...state.completed_work_item_ids, pending.workItemId])],
        };
        await writeDispatchState(layout, nextState);
        return {
            admitted: true,
            bundleDigest: request.bundleDigest,
            fencingToken: integrationLease.fencingToken,
        };
    }
    finally {
        try {
            await coordinator.release(integrationLease.leaseId);
        }
        catch {
            // Integration lease may already be reconciled.
        }
    }
}
export async function reconcileDispatch(workspace, loopId) {
    const layout = resolveLayout(workspace, loopId);
    const ledger = await openLedger(layout);
    await ledger.recover();
    const coordinator = await openRepositoryCoordinator(workspace);
    await coordinator.reconcile();
    const abandoned = [];
    try {
        const pendingFiles = await readdir(pendingRoot(layout));
        for (const file of pendingFiles) {
            if (!file.endsWith(".pending.json"))
                continue;
            const id = file.replace(/\.pending\.json$/u, "");
            const from = join(pendingRoot(layout), file);
            const quarantine = join(pendingRoot(layout), `${file}.quarantine-${randomUUID()}`);
            await rename(from, quarantine);
            abandoned.push(id);
        }
    }
    catch (error) {
        if (errorCode(error) !== "ENOENT")
            throw error;
    }
    const state = await readDispatchState(layout);
    const previouslyOpen = state.reservations.filter((entry) => entry.status === "OPEN");
    const next = {
        ...state,
        // Fence open attempts during recovery so callers cannot duplicate the same dispatch.
        reservations: state.reservations.map((entry) => (entry.status === "OPEN" ? { ...entry, status: "ABANDONED" } : entry)),
        abandoned_transaction_ids: [...new Set([
                ...state.abandoned_transaction_ids,
                ...abandoned,
                ...previouslyOpen.map((entry) => entry.requestId),
            ])],
    };
    await writeDispatchState(layout, next);
    return {
        openRequestIds: previouslyOpen.map((entry) => entry.requestId),
        integratedBundleDigests: next.pending_bundles
            .filter((bundle) => bundle.status === "INTEGRATED")
            .map((bundle) => bundle.bundleDigest),
        abandonedTransactionIds: next.abandoned_transaction_ids,
        completedWorkItemIds: next.completed_work_item_ids,
    };
}
//# sourceMappingURL=dispatch.js.map