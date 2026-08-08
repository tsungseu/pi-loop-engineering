# Security and Safety Boundaries

PAI Loop Engineering is an orchestration and evidence control plane. Hard isolation remains with the Codex host sandbox, tool approvals, filesystem permissions, and external-system controls.

## Orchestration Limits

- Plugin invocation is not authorization for push, PR/MR, tag, publish, deployment, HIL, real-robot execution, or actuation.
- Exactly four public Skills exist. There is no Router Skill and no Init/alias surface that can widen authority.
- Exact `$loop-engineering` is required before persistent `.ai-loop/` mutation. Implicit complex-implementation selection stays session-only.
- `$status` and session-only Review paths are read-only. `$knowledge-evolution` writes proposals only and never applies them.
- Sub-agents cannot recursively dispatch, write the ledger, or claim Release/physical authority except through the Release Action Envelope path.

## Host Enforcement

- Path containment, symlink escape rejection, worktree isolation, and lease fencing are enforced in the Node runtime.
- Runtime Gate and the Dispatch Broker reject controller-mediated writes without a current H1, and reject sealed results that drift from WaveInput/lease identity.
- Without host hooks, out-of-band raw tool writes are detected and blocked from evidence admission and Finalize; the plugin does not claim OS-level interception.

## Evidence and Hash-Chain Limits

- `.ai-loop/**` is locally tamper-evident engineering evidence, not a cryptographic trust root. Export or sign evidence when independent trust is required.
- Never record secrets or a complete process environment in command evidence.
- Hash chains, digests, and manifests detect local drift; they do not attest model identity against a same-user process that can replace local state.

## Secret Handles

- Secrets enter manifests only as provider/handle/version references.
- Secret material must not be copied into LOOP Markdown, Handoff prose, proposal bodies, or command transcripts.

## Physical-Action JIT Authorization

- Physical and external actions require a scoped Action Envelope, current authorization, and immediate revalidation before execution.
- Release readiness is not execution permission. Envelope target, branch, grantor, and expiry are rebound at action time.
- A verification environment’s evidence does not automatically prove another environment.

## Rollback

- Final Handoff records residual risk and rollback intent, but Release owns action-time rollback proof for external/hardware steps.
- Failed or interrupted Release actions must reconcile before retry; blind replay of lost responses is rejected.
- Crash recovery prefers fail-closed reconcile over speculative continuation.

## Reporting

Report a symbolic-link, path traversal, transaction rollback, authorization, or gate-bypass issue before using the affected command in a production workflow.
