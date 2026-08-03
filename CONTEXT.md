# Codex Orchestration

A Claude Code plugin in which Claude Code is the orchestrator and OpenAI Codex is a delegated
worker. The plugin's product is the *policy* — what gets handed to Codex, what context travels
with it, where its output is allowed to land — not the transport that carries it.

## Language

### Roles

**Orchestrator**:
The Claude Code session that decides what to delegate and owns the final judgement on what
Codex produced.
_Avoid_: main agent, parent, host

**Worker**:
The Codex process carrying out one delegated unit of work. Has no access to the Orchestrator's
conversation, memory, or tools — everything it needs arrives in its prompt or on disk.
_Avoid_: subagent, expert agent, external tool

**Forwarder**:
The Claude Code subagent whose only job is to invoke the Runner and return its stdout verbatim.
Exists to keep Codex's output out of the Orchestrator's context window; does no work of its own.
_Avoid_: wrapper agent, proxy agent

**Runner**:
The bundled script that spawns Codex, owns the Workspace lifecycle, and decides what text is
allowed to reach the Orchestrator.
_Avoid_: companion, driver, bridge

### Delegation

**Delegation**:
One unit of work handed from the Orchestrator to a Worker. Has exactly one Task Kind and
produces exactly one Result.

**Task Kind**:
The category of a Delegation. Determines its prompt template and how much reasoning the Worker
is asked to spend. There are six, split across two Delegation Classes.

**Delegation Class**:
Whether a Delegation's Result can be checked mechanically. Two values: Advisory and Verifiable.

**Advisory**:
A Delegation whose Result is prose and judgement — correctness cannot be established by running
anything. Runs `read-only`. Covers the Review, Diagnosis, and Adversarial Task Kinds.
_Avoid_: read-only task, analysis task

**Verifiable**:
A Delegation whose Result is a diff accompanied by a mechanical pass/fail signal. Runs
`workspace-write` inside a Workspace. Covers the Implementation, Repro, and Migration Task Kinds.
_Avoid_: write task, mutating task

Both modes are what the Class asks for, and what it gets whenever Codex's own sandbox can run.
ADR-0004 governs the one case where it cannot.

**Delegation Budget**:
The shared allowance every Delegation draws from, counted against the same rolling window the
Worker's own provider enforces. Finite and unreplenishable within the window, so spending it on
repeated or worthless Delegations denies it to valuable ones later.
_Avoid_: quota, rate limit, credits

**Ledger**:
The append-only record of every Delegation started, served from cache, and finished. It is what
the Budget is counted from — so a Budget that cannot be written cannot be enforced — and it is
where the observations calibration needs are kept: counts per window, durations, diff sizes.
_Avoid_: log, history, audit trail

### Task Kinds

**Review**:
Advisory. A second opinion on a diff or branch, returned as structured findings.

**Diagnosis**:
Advisory. Root-cause investigation of a failure, returned as hypothesis plus evidence. Explicitly
does not fix anything.

**Adversarial**:
Advisory. An attempt to refute a claim, plan, or finding the Orchestrator has already produced.
Its value is disagreement, so a Result that merely agrees is a weak Result.
_Avoid_: verification, second review

**Implementation**:
Verifiable. A substantive code change described by intent rather than by mechanism.

**Repro**:
Verifiable. A minimal failing test that captures a reported bug. Its Verification Signal is
inverted: the test is correct precisely when it fails, so a passing test means the test is wrong,
never that the code needs changing.
_Avoid_: test generation, failing test task

**Migration**:
Verifiable. A broad, mechanical change across many files, where correctness is established by
the build or test suite rather than by reading the diff.

### Execution

**Workspace**:
The throwaway git worktree a Verifiable Delegation runs in, branched from the Orchestrator's
current `HEAD` and seeded with the working tree — uncommitted changes and untracked,
non-ignored files included. That seed is its own commit on the Workspace's branch, so the Worker's
change is readable as a diff against one named point. It lives outside `/tmp` and anything else
Codex's sandbox may be handed as writable, because a worktree there is mounted over and the
Worker's writes vanish while every layer reports success. The user's own working tree is never
written to by a Worker.
_Avoid_: worktree, sandbox, scratch dir

**Thread**:
The Codex-side conversation one or more Advisory Delegations happen in, named by the `thread_id`
Codex reports when it opens one. Persisting it is what lets a follow-up continue the same Worker's
reasoning through `codex exec resume` instead of buying a whole second Delegation of reading. Only
Advisory Delegations have one; Verifiable Delegations always start clean.
_Avoid_: session, conversation, continuation id

**Resume Unavailable**:
What a Delegation reports when the Thread it was asked to continue could not be opened, so the
Result came from a fresh Delegation that carries none of that conversation. Always stated in the
Result and in what reaches the Orchestrator — a follow-up silently answered without its context
reads as continuous when it is not.
_Avoid_: resume failed, expired session

**Verification Signal**:
The command, exit code, and pass/fail verdict a Worker reports for a Verifiable Delegation. The
Worker runs it itself and iterates against it; the Runner does not re-run it. Evidence, not
authority — a passing signal never on its own licenses a Landing.
_Avoid_: test result, check

**Stale Workspace**:
A Workspace whose seed no longer matches the working tree it was taken from, because the user
kept working while the Delegation ran. Its diff can no longer be checked against present
reality, so Read-Before-Change withholds autonomous Landing.
_Avoid_: outdated worktree, drifted branch

**Result**:
What a Delegation returns: a schema-conforming payload from the Worker, persisted whole, plus
the compact rendering the Runner allows into the Orchestrator's context.

**Landing**:
Moving a Verifiable Delegation's work from its Workspace into the user's working tree. Governed
by the Read-Before-Change rule; never an automatic consequence of a passing Verification Signal.
_Avoid_: apply, merge, accept

**Read-Before-Change**:
The rule that the Orchestrator may alter the user's working tree only from content it has itself
read and checked against the code. It authorises the Orchestrator to act on a verified Advisory
finding or to Land a diff it has read, and withholds that authority when reading the diff would
cost more than the Delegation saved — at which point the decision returns to the user.
