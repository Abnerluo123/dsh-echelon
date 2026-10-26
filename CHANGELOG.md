# Changelog

## 1.1.6

### 修复：每一轮都被 "cannot get property tokenMeter without inject" 打断

自 1.1.0 引入按上下文路由起，适配器用属性访问读可选服务：

```js
this.ctx?.tokenMeter
```

Cordis 会按插件的 `inject` 列表守卫服务属性访问，而未声明的读取会**抛错**，不是返回 undefined。插件的 `inject` 只有 `llm`，所以这一行在**每次派发**时抛出，把整轮变成失败。

修法是改用显式访问器，与 DSH 官方插件一致：

```js
this.ctx?.get?.('tokenMeter')
```

`get` 不做依赖守卫，服务缺失时返回 undefined —— 正是这里要的语义：计量器只是估算优化，没有它退回本地启发式，绝不该让一轮对话失败。

回归测试用一个 Proxy 复刻 Cordis 的守卫（`llm` 与 `get` 放行，其余属性抛同样的错误）。把修复还原后该测试复现出一模一样的报错，确认它真的能抓住这个问题。

## 1.1.5

## 1.1.5

### 思考强度：完整阶梯 + 自动映射

之前挡位的思考强度下拉只有「跟随会话」，因为可选值取的是成员共同声明的交集——各家叫法不同，交集常常是空集。

现在插件自带一套词汇，并把它翻译成每个模型自己的挡位名：

```
off  <  low  <  middle  <  high  <  xhigh
```

- 下拉**始终**提供这五档，外加模型自己声明的额外名字（例如 `max`）。
- 派发时按成员翻译：优先精确匹配，否则取排名最近的一档；**距离相同时取更强的一档**，不会把 `high` 悄悄降级成便宜的。
- 各家别名都认得：`medium`/`mid`/`balanced` → middle，`max`/`highest`/`x-high` → xhigh，`none`/`disabled` → off。
- 模型**没有**声明挡位时原样转发，不用猜的值替换供应商默认。
- 阶梯外的自定义名字（如 `turbo`）也原样转发，模型有就用。

挡位上报给选择器的挡位也变成完整阶梯（映射开启时），所以会话里可以自由选五档。

**设置 → 高级 → 思考强度自动映射** 可以关掉，关掉后原样转发。

### 修复：隐藏模型后无法再添加

之前的成员编辑器读的是**被隐藏过滤后**的目录，于是开启「只显示挡位」后，那些被隐藏的模型在添加菜单里也消失了——用户必须关掉隐藏才能建挡位，而隐藏又依赖挡位，形成死锁。

现在插件自己的编辑器走未过滤的读取（`listUnfiltered`），选择器仍然只显示挡位，但添加成员时能看到全部真实模型。

## 1.1.4

## 1.1.4

### Tab order

页签顺序改为 **配置 → 预览 → 设置 → 调用日志**，按工作流而不是分类排：先建挡位，再确认选择器变成什么样，之后才是行为开关和日志。「预览」紧跟「配置」，因为「我建的是不是我要的」是改默认值之前的问题。

### Installation guide

README 补齐了完整的安装指引（中英双语）：

- **前置条件**（DSH 与 Node 版本）
- **三种安装方式**：GitHub（含指定版本 `#v1.1.3` / pnpm 的 `allowBuilds` 提示)、插件市场、本地源码
- **安装后步骤**：必须重启、首次安装为何不隐藏任何模型
- **验证方法**：用 manifest 的 `bundle` 字段确认，并说明 `dsh plugin list` 为何可能不显示本地安装的插件
- **卸载**与配置文件的去留

## 1.1.3

### Four tabs

| 分区 | 内容 |
|---|---|
| **配置** | 挡位编辑器 |
| **设置** | 模型选择器的显示、高级 |
| **预览** | 模型选择器将会显示成什么样 |
| **调用日志** | 每次请求的记录 |

「模型选择器的显示」从配置移入设置（它是个行为开关，不是挡位内容），预览则独立成「预览」分区——它是你**查看的结果**，不是要填的表单，埋在设置页底部只会让人滚过去。

### 折叠行恢复描述

只留箭头的空白条信息量太低。折叠时仍然显示描述和当前值，例如 `重试次数 1 · 超时 90秒 · 跟随会话 · 上下文长度 300000`，只有输入控件藏在后面。行高保持 26px，过长用省略号截断，不会把行撑开。

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
