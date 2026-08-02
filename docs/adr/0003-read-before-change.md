# Read-Before-Change governs what the Orchestrator may apply

The Orchestrator may alter the user's working tree only from content it has itself read and
checked against the code. This one rule replaces the two obvious policies — "never apply a
Worker's output without asking" and "apply whatever passed its tests" — and it is what keeps the
autonomy granted in ADR-0002 from turning into unreviewed code.

The rule is not about trusting Codex less than Claude. It is about where the reasoning happened.
When the Orchestrator edits from its own analysis, the user watched that analysis arrive. When it
acts on a Result, the reasoning happened in another process and the user saw only a rendered
summary — so the Orchestrator has to reconstruct enough of it to stand behind the change.

In practice: an Advisory finding is actionable once its `evidence` snippet has been checked
against the file it names, which is why that field is mandatory in the Advisory schema. A
Verifiable diff is Landable once read — fully when small, by sampling when it is a broad
mechanical change whose correctness is uniformity plus a green build. When reading the diff would
cost more than the Delegation saved, authority returns to the user; the branch is left in place
and `/delegate:apply` remains available.

## Consequences

A passing Verification Signal is evidence, never authority. A Worker asked to make tests pass can
satisfy that instruction by changing the tests, so the signal only counts once the diff has been
read.

A Stale Workspace is unlandable autonomously. The Runner records the `HEAD` and the hash of the
uncommitted state it seeded from; if either has moved by Landing time, the diff can no longer be
checked against present reality and the decision goes back to the user. Because a Delegation that
outlives its session is nearly always stale on return, this is the common path rather than the
exceptional one.
