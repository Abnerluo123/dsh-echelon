# dsh-model-router

> Replace the model picker with a handful of **tiers** you name yourself. Each tier is an ordered chain of real models: call them in your order, retry on failure, move to the next one when it still won't answer.

[![version](https://img.shields.io/badge/version-1.2.2-blue)](https://github.com/Abnerluo123/dsh-model-router/releases)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

A DeepSeek Harness plugin · [中文](README.md)

---

## The problem

DeepSeek Harness lists **every** model you can reach. Add a couple of providers and that list becomes a dozen entries with different names and different capabilities — so every new conversation starts with "which one should I use this time?".

Model Router replaces that decision with naming. You define a few tiers (`daily`, `deep`, `free`…) under **Configure**, and the picker shows only those names. Pick one and the plugin walks your ordered chain of real models.

![Configure tab](docs/images/configure.png)

## Highlights

### 1. Models with different capabilities can back each other up

This is the least obvious part. Putting unequal models in one tier runs into three concrete obstacles — **each one turns "automatic failover" into silent degradation**:

| Obstacle | What the plugin does |
|---|---|
| **Reasoning levels named differently** (`medium` / `max` / nothing at all) | One vocabulary — `off / low / middle / high / xhigh` — translated per member at dispatch |
| **Different context windows** (1M beside 300K) | The tier advertises the **largest** window, then picks a member that fits this request |
| **Different vision support** (multimodal beside text-only) | An image request skips members that cannot see and goes to one that can |

So "the strong model" and "the cheap model" can share one chain: small requests go cheap, large ones land on the big window, image requests land on the one that can see. **You never have to know which happened.**

![Request log](docs/images/log.png)

> This log shows all three decisions at once: an image request skipped the vision-less member, a large-context request skipped the small-window member, and a rate-limited call succeeded on retry.

### 2. A cleaner system model picker

Hide the real models, leave your tiers. Three modes: tiers only, hide only what I check, show everything (**default**).

Safety net: **hiding lifts automatically when no tier can dispatch** — the menu can never become an empty list that locks you out of settings.

### 3. Compatible with existing plugins

A member can be **another plugin's route**, because they are all just `provider/model` strings:

- `dsh-our-free-model` lanes and combos
- `dsh-model-fusion`'s `auto`
- any plugin that registers its own provider

No DSH patching. The plugin registers its own provider route and wraps one public read-only method to implement hiding.

## Quick start

### Install

```sh
dsh plugin --profile desktop add github:Abnerluo123/dsh-model-router
```

Requires **DSH ≥ 0.2.0-rc.1** and **Node ≥ 22.14.0**. **Restart `dsh`** afterwards (a hot reload is not enough), reload the page, and **Model Router** appears in settings.

### Three steps

1. **Configure → New tier**, name it (e.g. `daily`).
2. **Add models** in the priority order you want — that order is the failover order.
3. Once a tier answers normally, switch **Settings → What the model picker shows** to "Tiers only".

> On a fresh install the mode is "Show everything", so **none of your models disappear**. Hiding is something you choose after confirming a tier works.

## Advanced

### Per-member controls

Expand the row under a member:

| Setting | Meaning |
|---|---|
| **Retries** | Extra tries on this member before failing over (`0` = never) |
| **Timeout** | Fail over after this long with no data (`0` = no limit) |
| **Reasoning effort** | Empty follows the session; a chosen level is fixed for this member |
| **Context window / max output** | Empty uses the model's own values; a value overrides them |
| **Vision** | Force "sees images" for a model that supports it but does not declare it |

![Settings tab](docs/images/settings.png)

### Default level for new chats

**Settings → Advanced → Default level for new chats**: empty follows the model's own default, or pin one of `off / low / middle / high / xhigh`.

Existing conversations are unaffected — they keep the level they already selected.

### Reasoning-level mapping

| State | Picker shows | Dispatch |
|---|---|---|
| **On (default)** | the five-level vocabulary `off / low / middle / high / xhigh` | translated per member into its own names |
| Off | whatever the model declares | forwarded as written |

With mapping on you pick one of five levels and every member understands it; with it off you see the model's real levels, which is useful for debugging.

### Selection strategy

Per tier, deciding who wins when several members fit:

| Strategy | Behaviour |
|---|---|
| **Chain order** (default) | the first that fits — most predictable |
| **Most free space** | the roomiest window, so a long session is never squeezed into a member that barely fits |

### Image routing

- **Route images to a model that can see** (on by default) — otherwise DSH silently flattens the image into text;
- **Only this turn's image counts** (on by default) — an older image stops affecting later turns.

If no member can see, the turn still goes out, but the log records it explicitly instead of letting you think the model misunderstood the picture.

### Request log

One row per request: who answered, every member tried, why each failed or was skipped, duration and token usage.

The log lives **in memory only**, clears on restart, and can be switched off. Skip reasons carry the numbers, e.g. "needs 688000 tokens, 293488 usable / window 300000".

### Settings file

`$DSH_HOME/model-router/settings.json` (on Windows, `C:\Users\<you>\.dsh\model-router\settings.json`). Hand edits take effect on the next request. Missing fields, wrong types and out-of-range numbers are normalized; writes go through a temp file and a rename, so a failure never leaves half a document.

## Other install methods

| Method | Command / location |
|---|---|
| **GitHub** (recommended) | `dsh plugin --profile desktop add github:Abnerluo123/dsh-model-router` |
| npm name (once published) | `dsh plugin --profile desktop add @abnerluo123/dsh-model-router` |
| Pin a version | append `#v1.2.2` to either source |
| Plugin market | Plugins → Market, search `dsh-model-router` (resolves the npm package) |
| Local source | `git clone`, then `dsh plugin --profile desktop add /absolute/path` |

Replace `desktop` with your profile name (`dsh profile list`).

**Verifying**: check that the profile manifest registered the plugin

```sh
cd "$DSH_HOME/profiles/desktop"
node -e "console.log(require('./package.json').dsh.profile.bundles.includes('dsh-model-router'))"
```

`true` means it is registered. Note that `dsh plugin list` only shows npm dependencies — a plugin added from a local path or a `file:` spec may not appear there; that is pnpm's behaviour, not a failed install.

**Uninstall**: `dsh plugin --profile desktop remove dsh-model-router`. Settings stay in `settings.json`; delete that file to remove them completely.

## Known limitations

- **Hiding wraps `llm.listModels`.** DSH has no catalog-filter hook, so the plugin wraps that one public read on the service instance. Code that bypasses it and reads an adapter directly is not filtered.
- **The request log is memory only.** A restart clears it; it is a debugging view, not an audit trail.
- **An undeclared vision capability is treated as unknown.** Such a member stays a candidate for image requests (DSH forwards the image untouched) but is never preferred. Use the member's **Vision** setting to point at a model that supports images without declaring it.
- **`ABORTED` and `CONTEXT_WINDOW_EXCEEDED` never fail over.** You cancelled the first; the second would not fit on another model either.

## Development

```sh
node --test test/               # all tests
node scripts/verify-profile.mjs # can the current profile load this plugin?
```

The tests need no network and no DSH runtime. `test/integration.test.js` uses the **real** `LlmRuntime` — when the DSH app packages are present locally — to exercise registration, dispatch, hiding and failover.

| File | Responsibility |
|---|---|
| `index.js` | Host entry: register the route, mount the catalog filter and settings API |
| `src/adapter.js` | The adapter: chain dispatch, streaming, retries, failover, log writes |
| `src/config.js` | Pure configuration: normalization, chain expansion, context and modality filters |
| `src/effort.js` | Effort vocabulary and per-member translation |
| `src/tokens.js` | Request size estimation and image detection |
| `src/catalog.js` | Catalog filter (hiding) and the unfiltered read |
| `src/http.js` | Settings and log API plus the same-origin check |
| `src/store.js` | Atomic writes plus an mtime-invalidated cache |
| `client.js` | Browser half: the settings page and the log view |

## License

MIT
