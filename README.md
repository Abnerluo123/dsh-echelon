# Echelon

> 给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 用的**挡位式模型路由**。把十几个模型收成几个你自己命名的名字，选中一个，背后是一条有序的真实模型链：按序调用、失败重试、自动降级。

[![version](https://img.shields.io/badge/version-1.3.0-blue)](https://github.com/Abnerluo123/dsh-echelon/releases)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

[English](README.en.md)

```sh
dsh plugin --profile desktop add dsh-echelon
```

![配置页](docs/images/configure.png)

## 解决什么问题

DSH 的模型选择器会列出**每一个**能用的模型。接了几个供应商之后，这个列表变成十几个名字各异、能力不同的条目，每次开新对话都要重新判断该用哪个。

Echelon 把这一步换成命名：定义几个挡位（`日常`、`深度`、`免费`…），选择器里就只剩这几个名字。

## 三个关键点

### 能力不同的模型可以互相当备用

这是最不显然的部分。链里混放能力不同的模型会遇到三个障碍，**每一个都会让"自动换模型"变成"悄悄降级"**：

| 障碍 | Echelon 怎么做 |
|---|---|
| **思考档位命名不同**（`medium` / `max` / 不声明） | 统一 `off / low / middle / high / xhigh`，派发时按成员翻译；翻译不到就用成员自己的默认 |
| **上下文窗口不同**（1M 与 300K 混放） | 上报**最大**窗口，再按本次请求大小挑装得下的成员 |
| **视觉能力不同**（多模态与纯文本混放） | 请求带图时跳过看不了图的成员 |

于是"强的"和"便宜的"可以共处一条链：小请求走便宜的，大请求落到大窗口，带图请求落到能看图的。**你不用知道背后选的是谁。**

![调用日志](docs/images/log.png)

> 这张日志里的一次请求同时触发了三种判断：带图 → 跳过无视觉成员；上下文过大 → 跳过小窗口成员；随后限流重试成功。

### 选择器变干净

隐藏真实模型，只留挡位。默认「全部显示」，隐藏是你确认挡位可用后主动做的选择。**挡位里没有可派发的成员时隐藏会自动放开** —— 菜单永远不会变成进不去设置页的空列表。

### 兼容现有插件

成员可以是其它插件的路由（它们都只是 `供应商/模型` 字符串）：`dsh-our-free-model` 的免费车道、`dsh-model-fusion` 的 `auto`、任何注册了 provider 的插件。

不修改 DSH 本体，不 patch 任何东西 —— 只注册一个 provider 路由，并包装一个公开只读方法来实现隐藏。

## 快速上手

```sh
dsh plugin --profile desktop add dsh-echelon
```

需要 **DSH ≥ 0.2.0-rc.1**、**Node ≥ 22.14.0**。装完**重启 `dsh`**，刷新页面。

1. **配置 → 新增挡位**，起个名字。
2. **添加模型**，按优先级排列 —— 顺序就是降级顺序。
3. 确认能正常对话后，再把 **设置 → 模型选择器的显示** 切成「只显示挡位」。

> 首次安装是「全部显示」，**你的模型一个都不会少**。

## 高级功能

- **逐成员设置**：重试次数、超时、思考强度、上下文长度、最大输出、视觉能力（模型能看图却没上报时手动指认）。
- **超时按"进展"算，不按"数据"算**：只发心跳、空包、计量行不算活着，超时照样换下一个；模型的思考过程算进展。默认 180 秒，可以关掉。
- **新对话默认强度**：跟随模型，或固定成五档之一。
- **思考强度映射开关**：开启时选择器统一五档，选中后按成员翻译（成员没有就换成最接近的，完全没有就交给模型默认）；关闭时显示模型自己上报的档位并原样转发。**成员编辑器里的那一栏永远只用该模型上报的档位** —— 那是给单个成员钉死档位的地方，不能钉一个它不认识的值。
- **选人策略**：按顺序（默认）或优先剩余空间最大。
- **图片路由**：有图时自动选能看图的成员；只看本轮图片（旧图不再影响选人）。
- **调用日志**：每次请求 **挡位 → 真实模型**、档位怎么翻译的（`xhigh → max` / 未发送）、试过谁、为什么被跳过、耗时与 token。只在内存，可关闭。
- **上下文写法**：`128k`、`1m` 都行，不用数零；`k`=1024、`m`=1048576。
- **保存即生效**：改设置不用重启，也不用刷新页面。
- **配置文件**：`$DSH_HOME/model-router/settings.json`，可手改（同样接受 `"128k"`）；写入走临时文件+重命名，不会留下半份配置。

## 和其它方案的区别

Echelon 是 **DSH 插件**，不是独立的模型网关 —— 这个区别决定了它适合什么、不适合什么：

| | Echelon | LiteLLM / One-API / New-API / OpenRouter |
|---|---|---|
| 形态 | DSH 内部插件 | 独立服务，对外提供 OpenAI 兼容端点 |
| 覆盖范围 | 只在 DSH 里生效 | 任何兼容 OpenAI 协议的客户端（Cursor、Cline、Cherry Studio、Chatbox 等） |
| 部署 | 装进 DSH 即用 | 需要单独起服务、配端口与密钥 |
| 路由依据 | 挡位 + 上下文大小 + 图片 + 思考档位 | 通常是模型名、权重、配额、限流 |
| 解决的是 | 「DSH 里该选哪个模型」 | 「所有客户端统一走一个入口」 |

所以：如果你要给 Cursor、Cline、Cherry Studio、Chatbox 这类客户端做一个统一的 OpenAI 兼容入口，**LiteLLM 或 One-API 更合适** —— Echelon 不提供外部端点，做不到这件事。

如果你要的是**在 DSH 里**不用再记十几个模型名、还要失败自动降级、还要考虑上下文和图片，Echelon 就是为此设计的。两者也可以并存：把 LiteLLM 之类注册成 DSH 的一个 provider，再让 Echelon 把它和免费车道放进同一条挡位。

## 关键词

方便检索用的同义说法：

**中文**：模型路由 / 模型聚合 / 挡位 / 按序降级 / 接口兜底 / 失败自动切换 / 渠道自动切换 / 防限流 / 429 处理 / 免费模型聚合 / 多供应商 LLM / 思考档位映射 / 上下文窗口路由 / 视觉能力路由

**English**: model router, model cascading, sequential fallback, automatic failover, multi-provider LLM, provider routing, rate-limit handling (HTTP 429), request retry, reasoning-effort mapping, context-window routing, vision / multimodal routing, DeepSeek Harness plugin

## 其它安装方式

| 方式 | 命令 |
|---|---|
| **npm**（推荐） | `dsh plugin --profile desktop add dsh-echelon` |
| 指定版本 | 加 `#v1.3.0` |
| GitHub 源码 | `dsh plugin --profile desktop add github:Abnerluo123/dsh-echelon` |
| 插件市场 | 插件 → 插件市场，搜索 `Echelon` |

`desktop` 换成你的 profile 名（`dsh profile list`）。

**验证**：`dsh plugin --profile desktop list` 应包含 `dsh-echelon`；设置里出现 **Echelon**。

**卸载**：`dsh plugin --profile desktop remove dsh-echelon`。配置保留在 `settings.json`，需要彻底清理时手动删除。

## 已知限制

- **隐藏依赖包装 `llm.listModels`**：DSH 没有目录过滤钩子，绕过它直接读适配器的代码不会被过滤。
- **调用日志只在内存**：重启清空，是排障视图不是审计记录。
- **未声明视觉能力的模型按"未知"处理**：仍是图像请求的候选，但不会优先选中。
- **`ABORTED` 与 `CONTEXT_WINDOW_EXCEEDED` 不降级**：前者是你取消的，后者换个模型也装不下。
- **内部路由 id 仍为 `model-router`**：改品牌时没有动它，已保存的会话和配置继续有效。

## 开发

```sh
node --test test/               # 209 项测试，无需网络
node scripts/verify-profile.mjs # 检查当前 profile 能否加载
```

`test/integration.test.js` 在本机有 DSH 应用包时，会用**真实的** `LlmRuntime` 跑注册、派发、隐藏与降级。

| 文件 | 职责 |
|---|---|
| `index.js` | Host 入口：注册路由、目录过滤、设置 API |
| `src/adapter.js` | 按链派发、流式转发、重试、降级、写日志 |
| `src/config.js` | 规范化、链展开、上下文与模态筛选 |
| `src/effort.js` | 思考档位词汇与逐成员翻译 |
| `src/tokens.js` | 请求大小估算与图片识别 |
| `src/catalog.js` | 目录过滤（隐藏）与未过滤读取 |
| `client.js` | 设置页与调用日志页 |

## License

MIT
