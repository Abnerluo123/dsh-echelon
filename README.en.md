# dsh-model-router

Tier-based model routing for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

Leave only the tier names you define in the model picker — "Daily", "Heavy", "Cheap". Picking one walks an ordered chain of real models; a model that still fails after its retries hands the turn to the next one. Which models sit behind a tier, and how many backups there are, is a question you answer once, in settings.

## The problem

Once a few provider and channel plugins are installed, the model picker becomes a hundred entries: `deepseek-ai/deepseek-v4.1-flash`, `z-ai/glm-5.3-flash`, `Qwen3.8-Max · x0.5→x0.2`… Choosing a model turns into a lookup exercise. Meanwhile one channel's rate limit, quota wall, region block, or upstream 5xx kills the whole turn while five other lanes sit idle.

With this plugin:

- the menu holds only the tiers you named;
- each tier is an ordered chain, and every member has its own **retry budget** and **idle timeout**;
- failures fail over automatically — you never see the losing attempt or half an answer;
- the hundreds of raw models can be hidden entirely, and brought back whenever you want.

## Quick start

1. Settings → **Model Router** → **New tier**, name it (e.g. "Daily").
2. Inside the tier, **Add model** and pick real models; the first one is the primary.
3. Reorder them, and set each member's retries and timeout.
4. Under **What the model picker shows**, choose **Tiers only** (recommended).
5. Save. The picker refreshes within seconds and shows only your tiers.

From then on, changing what "Daily" runs on means reordering that tier's members — not hunting through a menu.

## Concepts

| Term | Meaning |
|---|---|
| **Tier** | One name exposed to the model picker, backed by an ordered chain. Its id derives from the name, so renaming case/punctuation keeps the same id. |
| **Member** | One `<route>/<model>` pair plus its own retry budget, idle timeout, context window, output cap, and reasoning effort. |
| **Retries** | Extra tries on the *same* member before failing over. `0` never retries; `1` (default) tries twice. |
| **Timeout** | Fail over after this long with no data at all. `0` means no limit. |
| **Context window / max output** | Empty means "use what the model reports"; a value overrides it. |
| **Reasoning effort** | Empty follows the session's own choice; a chosen level is the only one that member uses. The plugin offers `off/low/middle/high/xhigh` and translates them into each model's own names. |
| **Exposure** | Tiers only / hide only what I check / show everything. |

The per-member knobs are collapsed by default; the summary still shows their current values, so a collapsed block answers "what is this member set to" without opening it.

## Reasoning-effort mapping

Every model names its reasoning levels differently — `minimal/low/medium/high`, or
`off/low/high/max`, or only `default/high`, or (on a free lane) nothing at all. A
tier that could only offer the levels its members *share* often had nothing to
offer, which is why the effort menu used to contain just "follow session".

The picker shows **the model's own levels** (Off/Low/High/Max when that is what it declares). Only differing vocabularies between members need translation, and the plugin owns one internal vocabulary for that:

```
off  <  low  <  middle  <  high  <  xhigh
```

| You pick | Sent to a model declaring `low/high/max` | Why |
|---|---|---|
| `off` | `low` | the cheapest lane, when reasoning cannot be switched off |
| `low` | `low` | exact match |
| `middle` | `low` or `high` | equidistant, so the **stronger** one wins |
| `high` | `high` | exact match |
| `xhigh` | `max` | that model's own top level |

The rules:

- The menu **always** offers all five rungs, plus any extra names a model declares
  (`max`, `turbo`, …).
- A model that declares nothing gets the request forwarded unchanged — the
  provider's default is never replaced by a guess.
- A name outside the ladder is forwarded unchanged too, so provider-specific
  vocabulary still works.
- Turn off **Settings → Advanced → Map reasoning levels automatically** to forward
  the raw value.

Tiers and members both take a reasoning effort and a context window. **A member's own value wins**; otherwise the tier's default applies; otherwise the model and session decide. That way a whole chain can be retuned by editing one tier field instead of visiting every member.

## Behaviour

**Ordered, first success wins.** The first member to produce visible output wins the turn; the rest of the chain is never dialled, so it never costs anything.

**Failures keep walking the chain.** Whether a failure is worth retrying on the *same* model depends on its code:

| Code | Retry on same model |
|---|---|
| `RATE_LIMIT` `SERVER` `TIMEOUT` `TRANSPORT` `EMPTY_RESPONSE` `UNKNOWN` | yes |
| `AUTH` `QUOTA` `INVALID_REQUEST`, other deterministic failures | no — next member immediately |
| `ABORTED` `CONTEXT_WINDOW_EXCEEDED` | end the turn, no failover |

A deterministic failure (an expired key, say) would fail identically on a retry, so it costs a wasted wait — but **another member can still succeed**, so the chain keeps going.

**Half answers never leak.** A member's output is buffered until it contains something a reader would actually see (text or a tool call). A lane that streams its reasoning and then dies is therefore dropped silently: the transcript shows only the next model's complete answer. Reasoning alone is not success.

**One ending per turn.** Every path ends in exactly one terminal chunk — either a real answer, or one error that lists which members were tried and why each failed.

**Context windows route, they do not intersect.** A tier advertises the **largest** window in its chain, so adding a 1M model is not capped by a 300K companion. At dispatch the plugin estimates the request's input size, skips members that cannot hold it, and hands the request to the first member that can; skipped members are recorded in the request log as `CONTEXT_TOO_SMALL`.

The trade-offs:

- Sizes come from DSH's own `tokenMeter` (the same number compaction and occupancy use), falling back to the documented 4-characters-per-token heuristic. Both are *estimates*, and both reserve output room plus a 2% margin.
- If nothing in the chain fits, the roomiest member is tried anyway: a real upstream rejection is more useful than a local guess.
- A member that reports no window is **never** skipped — nothing proved it small.

## Hiding models

**Tiers only** hides every other real model, leaving your tiers as the entire menu.

Worth knowing:

- **Hiding filters presentation and selection, never dispatch.** A hidden model is still callable by a tier, because a tier dispatches directly and never consults the catalog. That is what makes "only my tiers are visible" possible at all.
- **A hidden model also stops being manually selectable**, including from a session that saved it earlier. That is what hiding means.
- **Nothing is hidden while no tier can dispatch.** If every tier lacks a usable member (a fresh install, for instance), hiding is lifted automatically — otherwise the picker would be empty and you could not reach the settings page to fix it.
- Hiding takes effect on save; the menu refreshes within seconds.

## Image input

A tier declares `['text', 'image']` as soon as **any** member can see images — the same rule as the window: claim what the chain can do, then route each request to a member that can do it.

When a request actually carries an image, the router skips members that cannot see it and hands the turn to one that can. Text-only requests are unaffected and keep the chain order.

**Settings → Advanced → Route images to a model that can see** controls this (on by default).

### Vision override

Several gateways serve images without disclosing `inputModalities`, so they get treated as text-only. Each member's vision setting can be forced:

| Value | Meaning |
|---|---|
| Follow the model (default) | use the adapter's declaration; **undeclared still counts as a candidate** (DSH forwards images to a model that declares nothing) |
| Force: sees images | treat it as vision-capable even without a declaration |
| Force: cannot see | never send it an image, even if it claims support |

### Only this turn's image counts (on by default)

The check used to look at the **whole conversation**, so one image attached early kept every later turn on a vision model. It now inspects only the **current turn's new inputs** (everything after the last assistant message, including tool results such as screenshots). Older images stop affecting selection, and the member that receives them gets a text placeholder instead.

Turn off "Only this turn's image counts" under **Settings → Advanced** to keep the stricter rule.

### Offloaded images do not count

DSH replaces an offloaded image with a text placeholder before sending, so the prompt no longer contains an image and text-only members are eligible again.

### Which members are skipped for an image

Only when the request actually carries an image **and** the switch is on:

- every member that cannot see is skipped for that turn, each logged as `NO_VISION`;
- the members that can see still follow your chain order;
- text-only requests are unaffected. Turning it off keeps chain order — the image is then flattened to text by DSH, which is only useful for debugging.

If no member in the tier can see, the turn still goes out (with the image converted to text), but the request log records `NO_VISION_MEMBER` so it is clear the tier could not read the image, rather than looking like the model simply misunderstood it.

## Selection strategy

A tier chooses among the members that *fit* the request in one of two ways:

| Strategy | Behaviour | Good for |
|---|---|---|
| **Chain order** (default) | the first member that fits | predictability; the chain already encodes "cheap first" |
| **Most free space** | the fitting member with the roomiest window | keeping a long session off a model that barely fits |

One thing worth stating plainly: **compaction timing is set by the window a tier advertises, and that is already the largest in the chain.** Deferring compaction to the biggest member has been in place since 1.1.0; switching members cannot push it later.

"Most free space" solves a different problem: the first member that fits may have very little room left, so it either truncates at the provider or hits its limit and forces a switch. Picking the roomiest keeps the session on a model with room to spare. It does let a pricier or slower model take over sooner, which is why it is off by default.

Every successful log row carries `estimate` (this request's estimated input) and `contextWindow` (the answering member's window), so you can see how close a session is to compaction.

## Request log

The second tab in settings is a **request log**: one row per request, answering the question a tier makes impossible to answer from the transcript — *which model actually served that turn*.

Each row carries:

- the model that **answered**, the tier name, and how long it took;
- every member tried, in order, at which attempt, and **why it was dropped** (failure code and reason);
- whether a failure was retried, and whether the retry or the failover won;
- token usage when the model reports it.

The log is **memory only** — cleared by a restart, never written to disk. It keeps the last 200 requests by default (20–2000, configurable under Advanced) and can be switched off entirely.

> Why not a file: this is a debugging view, not an audit trail. Persisting it would bring rotation, privacy, and disk-growth problems, while what you actually want while diagnosing is "what happened in those three turns just now".

## Living with other plugins

The plugin registers exactly one provider route of its own, `model-router`, and **never touches another plugin's routes**.

A tier's members may therefore be any model on any registered route, including other plugins' routes:

- `dsh-our-free-model`'s free lanes and combos (`our-free-model/...`);
- `dsh-model-fusion`'s `dsh-model-fusion/auto`;
- your own gateways declared through `dsh-llm-pi-ai`.

A common arrangement is putting Fusion's `auto` first in a tier and one or two cheap models behind it: Fusion needs a cheap Sidekick, and the chain covers the turn where it is unavailable.

## Settings file

Settings live at `$DSH_HOME/model-router/settings.json` (on Windows, `C:\Users\<you>\.dsh\model-router\settings.json`). Hand edits are picked up on the next request — no restart.

```json
{
  "version": 2,
  "exposure": "tiers",
  "defaultIdleTimeoutMs": 90000,
  "showTierDescriptions": true,
  "logRequests": true,
  "logLimit": 200,
  "tiers": [
    {
      "id": "daily",
      "name": "Daily",
      "enabled": true,
      "order": 0,
      "reasoningEffort": "high",
      "contextWindow": 200000,
      "members": [
        { "provider": "my-gateway", "model": "fast-model", "attempts": 1, "idleTimeoutMs": 90000, "enabled": true },
        { "provider": "my-gateway", "model": "solid-model", "attempts": 2, "idleTimeoutMs": 60000, "enabled": true,
          "reasoningEffort": "max", "contextWindow": 128000, "maxTokens": 32768 }
      ]
    }
  ],
  "hide": [{ "target": "other-gateway/some-model", "enabled": true }]
}
```

The file is forgiving: missing fields, wrong types, and out-of-range numbers are normalized, and a wholly corrupt file falls back to defaults with the reason shown in settings. Writes go to a temporary file and are renamed into place, so a failed save never leaves half a document.

## Installing

### Requirements

- **DeepSeek Harness** `>= 0.2.0-rc.1`
- **Node.js** `>= 22.14.0`

### Option 1: install from GitHub (available now)

```sh
dsh plugin --profile desktop add Abnerluo123/dsh-model-router
```

Replace `desktop` with your profile name (`dsh profile list` shows them). To pin a release:

```sh
dsh plugin --profile desktop add Abnerluo123/dsh-model-router#v1.1.4
```

> **If the install is blocked on `allowBuilds`**: pnpm does not run `prepare` scripts for
> packages installed from git by default. Add the package to the profile's
> `pnpm-workspace.yaml` as pnpm instructs, then re-run:
>
> ```yaml
> allowBuilds:
>   dsh-model-router: true
> ```
>
> This is usually unnecessary for this plugin (it has no build step); follow the
> prompt if you hit it.

### Option 2: install from the plugin market

Plugins → Market, search `dsh-model-router`.

> The market indexes by npm package name and needs the package published there. If it does not show up, use Option 1.

### Option 3: install from source

```sh
git clone https://github.com/Abnerluo123/dsh-model-router.git
dsh plugin --profile desktop add /absolute/path/to/dsh-model-router
```

Or use **Plugins → Installed → Add plugin** in DSH and give the absolute path.

### After installing

1. **Restart `dsh`** — the plugin recomposes the profile, so a hot reload is not enough.
2. Reload the page; **Model Router** appears in settings.
3. Open it and add members to a tier under **Configure**; **Preview** shows what the model picker will look like.

On a fresh install the **Auto** tier is empty, and the plugin therefore hides
*nothing*: your menu stays exactly as it was until at least one usable member
exists. That is deliberate — otherwise the menu would be empty and you could not
reach the settings page to fix it.

### Verifying

Check that the profile manifest registered the plugin (this works regardless of
where it was installed from):

```sh
cd "$DSH_HOME/profiles/desktop"
node -e "const j=require('./package.json');console.log('bundle:', j.dsh.profile.bundles.includes('dsh-model-router'))"
```

`bundle: true` means it will load. Note that `dsh plugin list` only shows
*registry* dependencies — a plugin added from a local path or a `file:` spec may
not appear there. That is pnpm's behaviour, not a failed install.

The clearest proof is the **Settings → Settings file** row in the settings page: if
it shows a real `settings.json` path, the plugin is loaded.

### Uninstalling

```sh
dsh plugin --profile desktop remove dsh-model-router
```

Settings stay in `$DSH_HOME/model-router/settings.json`; delete that file yourself
to remove them completely.

## Development

```sh
node --test test/               # all tests
node scripts/verify-profile.mjs # can the current profile load this plugin?
```

The tests need no network and no DSH runtime. `test/integration.test.js` uses the **real** `LlmRuntime` — when the DSH app packages are present locally — to exercise registration, dispatch, hiding, and failover, and skips itself otherwise.

Source layout:

| File | Responsibility |
|---|---|
| `index.js` | Host entry: register the route, mount the catalog filter and settings API |
| `src/config.js` | Pure configuration logic: normalization, chain expansion, retry rules |
| `src/adapter.js` | The adapter: chain dispatch, buffering, retries, failover, log writes |
| `src/catalog.js` | Catalog filter: hide models from the picker |
| `src/log.js` | In-memory request log: bounded, append-at-finish, never on disk |
| `src/tokens.js` | Request-size estimation (DSH token meter, documented fallback) and context-fit ordering |
| `src/http.js` | Settings and log API plus the same-origin trust check |
| `src/store.js` | Atomic writes plus an mtime-invalidated cache |
| `client.js` | Browser half: the settings page and the log view |

## Known limitations

- **Hiding wraps `llm.listModels`.** DSH exposes no catalog-filter hook, so the plugin wraps that one public read on the service instance. Code that bypasses it and reads an adapter directly would not be filtered.
- **The request log is memory only.** A restart clears it; it is a debugging view, not an audit trail.
- **Hot reload resets in-memory routing state.** Settings live on disk and survive; the log does not.
- **`ABORTED` and `CONTEXT_WINDOW_EXCEEDED` never fail over.** You cancelled the first; the second would not fit on another model either, so failing over would only hide the real problem.
- **64 member attempts per turn**, so a misconfiguration cannot spin forever.

## License

MIT
