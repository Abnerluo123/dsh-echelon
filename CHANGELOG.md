# Changelog

## 1.0.0

First release.

### Tiers as the only menu

- One provider route (`model-router`) whose models are the tiers you name.
- Ordered chains: the first member that produces visible output wins the turn;
  later members are never dialled.
- Hiding: `tiers` mode keeps every stock model out of the picker, with an
  interlock that lifts hiding whenever no tier can dispatch, so the menu can
  never become empty and unrecoverable.

### Failure handling

- Per-member retry budget and idle timeout, with a bounded exponential backoff.
- Retry only transient codes (`RATE_LIMIT`, `SERVER`, `TIMEOUT`, `TRANSPORT`,
  `EMPTY_RESPONSE`); a deterministic failure (`AUTH`, `QUOTA`, …) fails over
  immediately instead of burning the turn.
- `ABORTED` and `CONTEXT_WINDOW_EXCEEDED` end the turn rather than failing over.
- Member output is buffered until it contains reader-visible content, so a lane
  that streams reasoning and then dies is dropped silently — no half answers.
- A tier reports the smallest context window and the shared reasoning efforts
  across its members, so a request can never be accepted by the tier and then
  rejected by a fallback.

### Model controls

- Tier-level and member-level reasoning effort and context window / output cap,
  with member values winning over tier defaults.
- Overrides narrow what a tier advertises rather than widening it: an effort a
  model does not publish is never offered.

### Request log

- One in-memory row per request: which model answered, every member tried, the
  failure code for each, durations, and token usage.
- Bounded retention (20–2000 entries, default 200), never written to disk, and
  switchable off.
- Rejected turns are logged too, including a tier with no usable member — the
  case a user most wants to inspect.

### Compatibility

- Works beside any other provider plugin: members may be another plugin's route
  (`dsh-our-free-model` lanes and combos, `dsh-model-fusion/auto`).
- No DSH patching. The adapter registers through the public registry, and hiding
  wraps one public read (`llm.listModels`) on the service instance with a
  disposer that restores it.
