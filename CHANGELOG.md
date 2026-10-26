# Changelog

## 1.1.2

### Settings page navigation

Three tabs now: **配置**（模型选择器的外观）、**设置**（路由行为和日志保留）、**调用日志**。之前「模型选择器的显示」和「高级」在一个页签里，用户找 behavioural settings 很别扭；三个 tab 把问题拆成「我的 picker 长什么样？」「怎么跑？」「刚刚发生了啥？」，更符合用户的直觉。

### Compact disclosures

折叠块默认关闭时只保留一个箭头：宽度约 27px、高度约 24px，一条紧凑行。标签和当前值在 DOM 中仍存在，被 CSS 隐藏，并用 `aria-label` 提供给读屏软件——因此无障碍名称还在，只是不占用空间。展开后摘要出现，文字才真正可见。

### Dark mode and contrast

依然坚持测量而非肉眼判断：两套调色板的 computed styles 都正确，表面用宿主层级色而不是字面色。

## 1.1.1

### Settings page

- **Fixed a grey block on the settings page.** The stylesheet referenced
  `--dsw-alias-bg-page-primary`, which DSH does not define; an unknown custom
  property invalidates the whole declaration, so the surface fell back to
  transparent and the page showed through it. Surfaces now use the host's own
  elevation ramp (`bg-layer-1..3`), which also fixes nesting depth in both
  schemes.
- **Fixed the code font.** `--dsw-font-mono` does not exist either; the correct
  name is `--dsw-font-markdown-code-font-family`, so provider/model ids now
  render monospaced as intended.
- **Dark mode.** Every colour resolves through a theme variable, and the
  surface hierarchy is now light-on-light and dark-on-dark instead of relying on
  one platform background. Verified by measuring computed styles under both
  palettes in a real browser, not by eye.
- **Detail blocks collapse by default.** Per-member settings (retries, timeout,
  reasoning effort, context window, output cap) and the tier-level defaults are
  now behind a disclosure, using native `<details>` so the state costs no
  JavaScript and stays keyboard-accessible. The collapsed summary still shows
  the current values, so "what is this member set to" needs no click.

### Tests

- A guard asserts every CSS custom property the page uses exists in the host
  theme, so the transparent-surface bug cannot come back silently.
- A guard asserts surfaces never use a literal colour, which would survive one
  scheme and be wrong in the other.

## 1.1.0

### Context-size routing

A tier may mix models with different windows (a 1M model beside a 300K one).
Previously the tier advertised the *smallest* window, which capped every
request at the weakest member and threw away the big model's capacity.

- A tier now advertises the **largest** window in its chain; the picker shows
  what the tier can really take.
- At dispatch the request's input size is estimated and members that cannot
  hold it are skipped, so the first *fitting* member wins while the user's
  chain order is preserved.
- Skipped members are logged with code `CONTEXT_TOO_SMALL` and the numbers
  behind the decision, and shown as a distinct badge in the log tab.
- When nothing fits, the roomiest member is attempted so the failure is the
  provider's real one rather than a local guess.
- A member reporting no window is never skipped: an unknown size is not
  evidence of a small one.
- Sizes come from DSH's own `tokenMeter` when mounted, falling back to the
  documented 4-characters-per-token heuristic. Both reserve the member's output
  budget plus a small safety margin.

Settings stay backward compatible: existing documents load unchanged and the
new behaviour needs no configuration.

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
