# Autonomous delegation, bounded by budget rather than by asking

The Orchestrator delegates on its own judgement — the Forwarder subagents are described for
proactive use, and no Delegation requires the user to ask for it first. This is a deliberate
departure from the prior art, which ships its comparable feature disabled by default and warns
that it "may drain usage limits quickly." We accept that risk because a plugin whose every
Delegation needs a human trigger is a command palette, not an orchestrator, and the capability
worth having here — the Orchestrator noticing that its own claim deserves refutation — only
exists if it can act unprompted.

What makes that safe is not restraint at the point of triggering but a bound on the aggregate.
Every Delegation draws on a Delegation Budget counted against the same rolling window the Worker's
provider enforces, and identical Delegations are served from cache rather than re-run. Both
guards live in the Runner, below the Orchestrator, so no amount of enthusiasm upstream can spend
past them.

## Consequences

The Budget is counted at Delegation start, not completion, so work that outlives its session
still counts. When the Budget is exhausted the Runner refuses and says why — it cannot ask the
user, because `AskUserQuestion` is unavailable to every subagent.

The plugin ships `defaultEnabled: false`. Autonomy is a real commitment and installing should not
be the same act as consenting to it.

Two things stay outside this grant. The Orchestrator may not substitute its own answer for a
Delegation that failed, and it may not change the user's tree from content it has not read —
see ADR-0003. Autonomy here means deciding *to ask Codex*, not deciding *to trust the answer*.
