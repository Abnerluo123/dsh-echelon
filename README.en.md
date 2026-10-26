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
| **Reasoning effort** | Empty follows the session's own choice; a chosen level is the only one that member uses. |
| **Exposure** | Tiers only / hide only what I check / show everything. |

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

**Context windows intersect.** A tier advertises the **smallest** context window among its members and the **shared** reasoning efforts. Put one 128K model in a chain and the whole tier reports 128K — otherwise a request would die on the fallback with "context exceeded" instead of being handled.

## Hiding models

**Tiers only** hides every other real model, leaving your tiers as the entire menu.

Worth knowing:

- **Hiding filters presentation and selection, never dispatch.** A hidden model is still callable by a tier, because a tier dispatches directly and never consults the catalog. That is what makes "only my tiers are visible" possible at all.
- **A hidden model also stops being manually selectable**, including from a session that saved it earlier. That is what hiding means.
- **Nothing is hidden while no tier can dispatch.** If every tier lacks a usable member (a fresh install, for instance), hiding is lifted automatically — otherwise the picker would be empty and you could not reach the settings page to fix it.
- Hiding takes effect on save; the menu refreshes within seconds.

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

**From the plugin market** (recommended): Plugins → Market, search `dsh-model-router`.

**From a local directory**: in DSH, Plugins → Installed → Add plugin, and give the absolute path; or

```sh
dsh plugin --profile <profile> add /absolute/path/to/dsh-model-router
```

Restart `dsh` and reload the page; **Model Router** appears in settings.

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
