# Changelog

## 1.6.1 — 界面收拾干净

全是可用性问题，逐条对应反馈。

### 挡位

- **新增挡位插到最前面**。以前追加在末尾，列表一长，点完按钮屏幕没变化，看着像失败。
- **挡位可折叠**，收起后只剩一行名称。三五个挡位、每个六个成员的表单页，默认摊开没法看。
- **删掉成员数量徽标**。它只是重复了展开后一眼就能看到的东西。

### 页面头部

- **删掉标题下面那段说明**。它在解释这个页面本来就一目了然的事。
- **保存按钮移到右上角**，一个按钮两用：有改动时是「保存并重新加载」，没改动时是「重新加载」。**「放弃修改」和「重新载入」两个按钮删除** —— 它们的价值不足以让人多理解两个状态。

### 删掉没意义的东西

- **选人策略**：不让用户改了。这个选项在两条链里都只有一种合理选择，暴露出来只是让人怀疑自己选错。
- **视觉能力的说明**、**上下文长度的「支持 128k / 1m」**、**「0 = 不重试」和「0 = 不限制」** —— 全部删除。`0` 的含义不需要解释，需要解释的东西不该用 `0` 表达。

### 数值

- **修掉 `undefined` / `NaN`**：挡位默认值摘要以前直接拼 `member.attempts` 和 `toSeconds(undefined)`，没设置时就会显示成 `重试次数 undefined · 超时 NaN秒`。现在未设置显示「跟随挡位」。
- **上下文长度按 `m` / `k` 显示**：`1000000` 显示成 `1m`，`262144` 显示成 `262k`，不再让人数零。
- **输入接受 `m` / `k` / `M` / `K` / 纯数字 / 小数**：`1.5m`、`256K`、`131072` 都行；`k` 和 `m` 改成**十进制**（`1m` = 1000000，`1k` = 1000），因为这样「看到什么就输入什么」不会改动数值 —— 以前按 1024 算，把 `1m` 存成 1048576，再显示回 `1m`，来回一趟数字就变了。

215 项测试。


## 1.6.0 — 档位不再把思考关掉，超时按秒调，提示只留特殊值

### 1. `档位 high → off`：把思考强度映射成了「关闭思考」

**这是这一版最严重的 bug。** 有个 provider 只上报 `off` / `on` 两个值（二值开关）。`on` 不在别名表里，于是请求 `high` 时，唯一能排序的邻居只剩 `off`（rank 0），映射结果就是 `off` —— **要求高强度思考，实际把思考关了**。

根因是把 `off` 当成了"最低档"。它不是很低，它是**另一个维度**：`off` 是开关，`low…xhigh` 是强度。两者不能互相翻译。

现在：

- `on` / `enabled` / `true` 归到强度侧（`on` = rank 3，等同 `high`）；
- 要**强度**的请求绝不落到 `off`；只有 `off` 可选的成员会**丢弃**档位，用模型默认；
- 要**关闭**的请求绝不落到强度档；不能关的成员同样丢弃档位，而不是偷偷继续思考。

### 2. 超时范围：2–60 秒，全新安装默认 6 秒

DSH 自己会重试一整轮，而重试比等待划算得多：6 秒没有任何进展的线路基本已经掉了，而只是慢的线路下一次重试还能答上来。等两分钟得出同一个结论，代价是用户两分钟。

- 下限 2 秒，上限 60 秒（面板可选范围同）；
- 全新安装默认 6 秒（原 180 秒）。

### 3. 挡位默认值换成「超时 + 重试」

原来那一栏是「思考强度 + 上下文长度」：思考强度在挡位层没有意义（选择器已经统一五档），所以删掉。现在挡位默认值是：

| 字段 | 作用 |
|---|---|
| 超时 | 成员没单独设置时用这个 |
| 重试次数 | 成员没单独设置时用这个 |
| 上下文长度 | 保留 |
| 选人策略 | 保留（只有挡位层才有意义） |

**`0` 的含义分层了**：挡位层的 `0` 表示"清掉挡位默认，采用全局默认"；成员层的 `0` 才是真的"不限制 / 不重试"。两者不再混为一谈。

为此，成员本身不再预填默认值 —— 以前 `normalizeMember` 会把 1 次重试和 90 秒写进每个成员，导致**挡位默认永远没有空隙可填**。现在未设置就是 `undefined`，优先级在 `tierChain` 里解析。

### 4. 提示只保留特殊值

按"用户不是傻子"的原则重写：能自解释的字段一律不加说明。

- 重试次数：`0 = 不重试`
- 超时：`0 = 不限制`
- 上下文长度：`支持 128k / 1m`
- 思考强度、选人策略：**不写**

空的提示不再渲染成空行（那会让表单看起来忽高忽低）。

215 项测试。


## 1.5.1 — 超时真的会停，输入框不再抢键盘

三个问题，其中两个是 1.5.0 自己引入或没修干净的。

### 1. 超时：空包还能骗过去，超时后还在跑

- **空 delta 算成了进展。** 1.5.0 把判定从"收到任何 chunk"改成"按类型判定"，但只看了类型、没看内容，于是网关每 20 毫秒发一个**空字符串 delta** 就能永久重置计时器。实测：150 毫秒的预算下，63 个空包让这次尝试跑了 1863 毫秒还"成功"了。现在只有**携带非空白内容**的 chunk 才算进展。
- **超时之后卡在清理上。** `iterator.return()` 不是"发个信号"，在 async generator 上它会**等**那个 generator 当前挂起的操作——而挂起的正是卡住的网络读。所以 8 秒的预算，实际跑了 277 秒：**8 秒时已经判定超时，然后卡在清理里**。现在超时会先**主动取消**该成员的请求（每轮一个 `AbortController`），并且清理本身有 1 秒上限。

### 2. 输入框在打字过程中纠正你

不是"防小于 5"，是**每次按键都 clamp**：输入 `90` 会经过 `9`，而 `9` 立刻被改写成下限，所以删到个位数时它跳成一个很大的数。

现在：打字过程中**只管收数字、不校验**；**失焦或回车**时才规范化（低于下限填下限，高于上限填上限），并把规范化后的值显示出来。

### 3. 说明文字太长，把面板撑散了

设置页里那些段落级提示全部压成一行。判定规则、误伤边界、取消与清理的细节搬到 README 的「超时是怎么判定的」和「输入框的行为」两节。

211 项测试。


## 1.5.0 — 超时、日志、输入框、热加载

四件事，都是实际用起来会卡住人的地方。

### 1. 超时真的会拦了

原因有三个，叠在一起：

- **看门狗只看"有没有数据"，不看"有没有进展"。** 网关每隔几百毫秒发一个空包/心跳/计量行，单次等待都没超时，于是这次尝试可以无限挂着——屏幕上什么都没有。现在只有**携带内容**的 chunk 才算进展：文字、思考、工具调用、块边界、结束。
- **`prepareCall` 完全在计时之外。** 空闲计时是从 `stream()` 进入才开始跑的，而 `prepareCall`（解析能力、刷新令牌、探测目录）在那之前，没有任何期限。卡在那里就是整轮静默、连日志都没有一条。
- **`resolveModelInfo` 也一样**，而且它在写日志之前，所以卡住时日志是空的。

现在三处共用一个预算，超时照样降级到下一个成员。

**不会误伤长任务**，两条理由写在代码里：模型思考时在持续产出 reasoning delta，算进展；而模型等待本地命令时，这次模型调用早已以 tool-call 块结束，看门狗根本不在等待。

默认超时从 90 秒放宽到 180 秒，上限从 10 分钟放到 15 分钟——因为现在真的会拦，才敢给足正常排队的时间。

### 2. 日志写清"挡位 → 真实模型"

每次请求两行：第一行是挡位名与耗时，第二行是 `挡位 → provider/model` 加档位去向：

    DeepSeek → trae/deepseek-v4.1-flash   档位 xhigh → max

三种情况分别显示：`xhigh → max`（翻译过）、`档位 high`（原样）、`未发送档位（模型未声明）`（丢弃，模型用自己的默认）。最后这一种以前是失败的根源，现在至少一眼能看出来。

### 3. 输入框不再自作主张

- **去掉所有数字输入框的上下箭头**。那个箭头会改写你打到一半的值：方向键算一次，滚轮划过算一次。现在全部改成文本输入 + 数字键盘提示，另外加 CSS 兜底。
- **上下文长度/最大输出支持 `128k`、`1m` 写法**，显示也是这个短形式，不用数零。`k`=1024、`m`=1048576 —— 模型说"1M 上下文"指的就是 1,048,576，按十进制算会少 4.8%。后端同样接受短形式，所以手改 `settings.json` 写 `"128k"` 也行。
- 数字类字段**失焦或回车才提交**，打字过程中不再反复重写。

### 4. 改配置不再需要重启

`store.write()` 写完之后刷新了缓存，于是下一次 `read()` 看到 mtime 一致就直接返回，**永远不会走到通知订阅者的那条分支**。也就是说你自己在设置页保存，插件自己从来不知道——选择器一直是旧列表，直到重启进程。现在写入本身就会通知。

另外把通知的指纹从"挡位 id + 成员数"扩成"挡位名 + 顺序 + 成员路由"，所以改名、换成员也能立刻反映到选择器。

209 项测试。


## 1.4.1 — 开关恢复成有意义的开关

1.4.0 修 API 报错修过头了：为了"只发模型声明过的档位"，把**选择器一侧**的词汇表也改成了上游原样，于是开启映射和关闭映射几乎没有区别 —— 开关形同失效。

这一版把两件事重新分开：

| 位置 | 应该用什么档位 | 理由 |
|---|---|---|
| **模型选择器 / 会话**（「思考强度自动映射」管的地方） | 开启：统一 `off/low/middle/high/xhigh`；关闭：上游原样 | 开启时每一档都会被翻译，所以五档是安全的；统一词汇正是这个开关的作用 |
| **成员编辑器的「思考强度」**（图一） | 永远只用该模型上报的档位 | 那是给单个成员钉死档位，钉一个它不认识的值必然报错 |

### 真正该修的那一条（保留 1.4.0 的修复）

**派发时只发成员声明过的档位，否则不发。** 成员没有上报档位时，映射逻辑原来"原样转发"，理由是"别用猜的值覆盖供应商默认"；但 DSH 在发请求**之前**就校验显式档位，模型没声明的值一律抛 `UNSUPPORTED_REASONING_EFFORT`，不裁剪也不做别名。所以在这些成员上，转发不是"保持默认"，而是保证失败。

现在 `mapEffort` 的返回值永远是"成员声明过的 id"或 `undefined`：

- 精确匹配 → 原样；
- 刻度上能匹配 → 换成最近的（等距取更强的）；
- 未知支持 / 外来名字 / 刻度上匹配不到 → **丢弃**，成员用自己的默认。

因此 `xhigh` 落到只认 `max` 的模型上会变成 `max`，落到什么都不上报的中转站上会变成"不发"。

### 具体行为

| 映射 | 模型声明 | 选择器显示 | 派发给模型 |
|---|---|---|---|
| 开 | `none/low/high/max` | 五档 | `xhigh` → `max` |
| 开 | 什么都没声明 | 五档 | 不发，用模型默认 |
| 关 | `none/low/high/max` | `none/low/high/max` | 原样 |
| 关 | 什么都没声明 | 空（只有「跟随会话」） | 原样 |

### 其它

- 新对话默认强度：开启映射时它就是五档之一、原样生效；关闭映射时按 rank 对齐到该挡位真正支持的档位。
- 成员编辑器里，如果某个成员存的档位模型现在已经不报（例如换了模型），选项仍会显示但标注「模型没上报」，方便你改掉它。
- 关闭映射时若多个成员的词汇表没有交集，仍然不显示档位 —— 那种状态下任何值都会被某个成员拒绝。

197 项测试。


## 1.4.0 — 思考档位只发模型真正声明过的

### 症状

模型选择器与成员编辑器里出现了模型**根本没有上报**的档位：例如某个 DeepSeek 模型自己说的是 `none / low / high / max`，插件却显示 `off / low / middle / high / xhigh`。选中 `xhigh` 之后请求直接失败，日志里是成员报错、整轮没有答案。

### 根因（两个，缺一不可）

1. **菜单不是上游给的。** 开启「思考强度自动映射」时，挡位作为虚拟模型固定上报插件自己的五档，完全不看成员到底声明了什么。这个五档是**比较用的刻度**，不是可以拿去展示的词汇表。
2. **派发时把猜的值原样发了出去。** 成员没有上报档位（中转站、免费车道很常见）时，映射逻辑选择"原样转发"，理由是"不要用猜的值替换供应商默认"。但 DSH 在发请求**之前**就会校验显式档位：模型没声明的档位一律抛 `UNSUPPORTED_REASONING_EFFORT`，不裁剪也不做别名映射。所以在这些成员上，转发等于保证失败 —— 它替换掉的是"不发送档位"，而不是"供应商默认"。

### 修复

- **菜单只来自上游。** 开启映射：取链里第一个真正上报了档位的成员，原样展示它的档位（`none/low/high/max` 就是 `none/low/high/max`）。关闭映射：取所有成员的交集，因为关闭时不做翻译，交集之外的值会被不接受它的成员拒绝。没有任何成员上报时，挡位**不上报任何档位**，选择器里也就不会出现一行永远用不了的档位。
  > 1.4.1 更正：这一段是过度修正。选择器一侧应该恢复成五档（否则开关失效），只有成员编辑器该用上游原样；见 1.4.1。
- **派发侧只发成员声明过的档位，否则不发。** 未知支持、外来名字、无法在刻度上匹配 —— 三种情况都丢弃档位，让成员用它自己的默认。这样 `mapEffort` 的返回值永远是"成员声明过的 id"或 `undefined`，`UNSUPPORTED_REASONING_EFFORT` 从设计上就不可能再出现。
- **新对话默认强度仍然可选五档**，但它是一个偏好，不是词汇表：落到某个挡位时按 rank 就近对齐到该挡位真正支持的档位（`xhigh` → `max`，`middle` → `high`），无法对齐时回落到模型自己的默认值。因此上报的默认值一定在它上报的档位里。
- **成员编辑器的下拉同样按模型上报的档位渲染**（探测结果优先，其次目录），不再给每个成员注入五档。模型什么都没上报时，下拉里只有「跟随会话」。
- **文案改成实际行为**：映射开关现在只描述"派发时翻译 / 原样转发"，不再声称选择器会换成五档。

### 兼容性

`settings.json` 结构未变。已存的成员档位如果模型其实不支持，现在会在派发时被丢弃（成员用自己的默认），而不是让整轮请求失败。

196 项测试。


## 1.3.0 — 改名 Echelon

包名从 `@abnerluo123/dsh-model-router` 改为 **`dsh-echelon`**，插件对外名称改为 **Echelon**。

### 改了什么

- `package.json` 的 `name` 与 `keywords`（补了 model-cascading / sequential-fallback / failover / rate-limit 等检索词）
- 设置分区的导航与标题、模型选择器里的 provider 显示名、预览分组名、`displayName`
- 用户可见的报错文案（`Echelon：挡位 … 没有可用成员`）
- 浏览器半身的 `__ModuleLoader__` id
- bundle patch 行的 `name`

### 什么没改，以及为什么

**内部路由 id 仍然是 `model-router`**（`ROUTER_PROVIDER`、`/api/model-router`、bundle 行 id、设置文件路径）。会话里保存的是 `provider: 'model-router'`，改掉它会让已保存的对话认不到模型。改名比"品牌一致性"更重要的事是不弄坏现有数据。

`Symbol.for('dsh-model-router.*')` 也保持不变：它是防止重复包装的标记，换了名字会让第二个实例重复包装目录读取。

### README

重新精简：两张图（配置页、日志页），并把结构压到「解决什么问题 → 三个关键点 → 快速上手 → 高级功能」。

新增两节：

- **和其它方案的区别** —— 明确 Echelon 是 DSH 插件、不是独立网关，和 LiteLLM / One-API / New-API / OpenRouter 的适用场景分开写清。不谎称支持 Cursor / Cline / Cherry Studio 这类外部客户端，反而说明那种需求该用哪个工具。
- **关键词** —— 中英文同义说法，便于检索。

192 项测试。


## 1.2.2

### 包名改为作用域形式

`npm` 上 `dsh-model-router` 这个名字**已被他人占用**（`thedeveloper256`，0.7.1，同样是 DSH 的模型路由插件），直接发布会 403，插件市场里那个名字也指向他的包。

因此改用与 GitHub 账号一致的作用域名：

    @abnerluo123/dsh-model-router

同步修改：

- `package.json` 的 `name`，并加 `publishConfig.access = "public"`（作用域包默认私有，不加会发布失败）；
- `cordis.patch.yml` 里 bundle 行的 `name` —— 它必须等于包名，否则插件加载不到；
- `client.js` 里 `__ModuleLoader__` 注册的 `id` —— 同样必须等于包名；
- README 的安装命令，并区分「GitHub 源码」与「npm 包名」两种来源；
- `scripts/verify-profile.mjs` 改为从 `package.json` 读取名字，不再写死。

安装命令：

```sh
dsh plugin --profile desktop add github:Abnerluo123/dsh-model-router   # 现在可用
dsh plugin --profile desktop add @abnerluo123/dsh-model-router         # 发布到 npm 后
```

192 项测试。


## 1.2.1

### 去掉挡位名后面的 `auto` 角标

那个角标显示的是挡位 ID —— 由名字派生而来，只对 `settings.json` 有意义。编辑时它只是把「名字」重复了一遍，尤其是新建挡位时还会显示 `auto` 这种自动生成的占位，容易让人以为是个需要理解的设置。

现在挡位标题只留输入框。

192 项测试。


## 1.2.0

首个正式版本。这一版只改文档与配图，并修一个标签样式问题，功能与 1.1.16 相同。

### 文档重写

README 从「变更记录式」改为产品说明，结构：

1. **它解决什么问题** —— 一段话讲清用途
2. **核心亮点** —— 三个创新点：能力不同的模型互为备用（思考档位映射／上下文／视觉）、选择器简化、插件兼容
3. **快速上手** —— 安装 + 三步配置
4. **高级功能** —— 逐成员设置、默认强度、映射开关、选人策略、图片路由、调用日志、设置文件
5. 其它安装方式、已知限制、开发

中英双语同结构。

### 配图

`docs/images/` 新增三张截图：配置页、调用日志、设置页。用中性示例数据（Gateway A/B、Nova 2 Flash 等）重新截取，因此**不包含任何真实供应商或模型名**。

### 修复

成员行里的「支持图像」标签渲染成一条灰带 —— 它在纵向 flex 容器里被拉满整行，现在按内容宽度显示。

191 项测试。


## 1.1.16

### 默认不再隐藏模型

全新安装的默认显示模式从「只显示挡位」改成「全部显示」。

原因很实际：一个刚装上插件的人，挡位还是空的，但原有的模型列表**全部消失**了 —— 屏幕上没有任何东西解释它们去哪了。摸熟之前，这看起来像插件把用户的模型弄丢了。

现在：

- **全新安装**：显示模式是「全部显示」，原有模型一个不少；
- **用户主动**选「只显示挡位」时，隐藏照旧生效；
- 安全互锁保持不变 —— 万一挡位里没有能派发的成员，隐藏会自动放开，菜单不会变成空的。

安装引导里的措辞也改了：不再把「只显示挡位」写成第一步的推荐操作，而是建议先确认挡位能正常作答，再切换。

### 已安装的用户不受影响

显示模式存在各自的 `settings.json` 里，已经保存过设置的用户沿用自己选过的值，这次改动只影响**从未写过设置文件**的全新安装。

191 项测试。


## 1.1.15

### 修复：开关没决定「显示谁的档位」

我 1.1.13 把两件事合并了 —— 无论开关如何，都上报模型自己的档位。结果**「思考强度自动映射」开关等于失效**：开启后看到的仍是模型档位，而不是本插件那套可映射的档位。

正确的语义是开关决定显示哪套词汇：

| 开关 | 选择器显示 | 派发 |
|---|---|---|
| **开（默认）** | off / low / middle / high / xhigh | 逐成员翻译成模型自己的档位 |
| 关 | 模型自己上报的档位 | 原样转发，不翻译 |

开启时显示统一词汇，才有「选一个名字、各模型都能用」的意义；关闭时既然不翻译，菜单就必须只列模型真正接受的档位。

### 默认强度的推断

映射开启时，默认值取**模型自己的默认档位并换算成阶梯名字**（模型默认 `high` → 显示 `high`；模型默认 `max` → 显示 `xhigh`）。你在「新对话默认强度」里指定过就用你指定的。

实测：

    映射开（默认）              显示 off / low / middle / high / xhigh | 默认 high
    映射开 + 默认 middle        显示 off / low / middle / high / xhigh | 默认 middle
    映射关                     显示 off / low / high / max          | 默认 high

### 插件设置里的成员档位下拉

同样跟随开关：开启时列阶梯，关闭时列模型档位。

191 项测试。


## 1.1.14

### 修复：新对话的推理等级默认值还停在 `middle`

1.1.13 让挡位展示模型自己的档位，但默认值这一项没跟上：之前写死的 `middle` 仍被报给 DSH，于是新会话里显示「推理等级 middle」—— 而这个模型只认 off/low/high/max。

现在：

- **不设置**时，默认值就是**模型自己声明的默认档位**（DeepSeek-V4.1-Flash 是 `high`）；
- 上报前会校验默认值确实在档位列表里，不在就按映射规则对齐过去，杜绝「显示一个模型不认的档位」。

### 新增：新对话默认强度（可调）

**设置 → 高级 → 新对话默认强度**（就在「思考强度自动映射」下方）：

| 取值 | 效果 |
|---|---|
| 跟随模型（默认） | 用模型自己声明的默认档位 |
| off / low / middle / high / xhigh | 新会话预选该档；对没有这一档的挡位会自动对齐 |

「对齐」是必要的：你在一个只认 off/low/high/max 的挡位上选 `middle`，上报值会落到 `high`（距离相同取更强）。否则 picker 又会显示一个模型没有的档位。

**已存在的会话不受影响** —— 它们保存的是各自选过的档位。这个设置只决定新会话的起点。

190 项测试。


## 1.1.13

### 思考强度改成上报模型自己的档位

1.1.5 让挡位上报本插件那套五档（Off/Low/Middle/High/Xhigh），理由是各家命名不同、交集常常为空。但这在 picker 里是错的：

- 模型明明说 Off/Low/High/Max，界面却列出 Off/Low/**Middle**/High/**Xhigh** —— Middle 和 Xhigh 这个模型根本不认；
- 默认值写死成 `middle`，没有供应商用这个词。

现在挡位直接上报**第一个声明了档位的成员**的档位列表和默认值。所以 DeepSeek-V4.1-Flash 在 picker 里就是 Off/Low/High/Max，默认 High —— 和直接用这个模型时一致。

映射仍然保留且仍在**派发时**按成员翻译，所以选 `max` 落到只认 `high` 的备用成员上依旧正确。区别只是：菜单不再展示模型不认识的名字。

### 去掉挡位默认值里的「思考强度」

那个位置用不上：真正选档位是在会话的模型选择器里，而每个成员也各有自己的档位设置。挡位默认值现在只留**上下文长度**和**选人策略**。

### 成员行下拉

只列模型声明的档位。模型什么都没声明时，下拉只有「跟随会话」——这是诚实的，而不是拿五个用不上的名字凑数。

188 项测试。


## 1.1.12

### 修复：跳过原因被统一显示成「上下文装不下」

日志里所有「跳过」行，只要带说明文字，就一律渲染成「上下文装不下」。而 `NO_VISION`（无视觉）的行也带说明文字，于是**因为不支持图片被跳过的成员，被报成了上下文不足**。

这是显示层的错，判断本身是对的。现在按 `code` 分开：

| 代码 | 显示 |
|---|---|
| `NO_VISION` | 无视觉 |
| `CONTEXT_TOO_SMALL` | 上下文装不下 |
| `NO_VISION_MEMBER` | 挡位里没有能看图的成员 |

顺带把说明文字从 `title` 提示移到行内直接显示，所以上下文跳过会写出具体数字：需要多少、窗口多大、输出预留多少、还剩多少。

改动前，你只能看到一个标签，无从判断到底是窗口不够还是看不了图 —— 这正是这次误判的来源。

188 项测试。


## 1.1.11

### 修复：视觉模型反而看不到图片了

这是 1.1.8 引入的错误语义：我把「模型**没上报**模态」当成了「只能看文字」。

DSH 的实际判断条件里有 `!== void 0`：

    modelInfo.inputModalities !== void 0
      && !modelInfo.inputModalities.includes("image")
      && hasImage(messages)      // 只有这三条都成立，才把图片转成文字

关键是第一行：**模型什么都没声明时，DSH 不会转换，图片原样传给适配器**。

所以错判造成两级连锁：

1. 挡位把「没声明」当作不支持，上报 `['text']`；
2. DSH 因此在**更外层**就把图片压成文字占位符——轮不到插件选人，视觉模型收到的已经是一段文字。

现在把三态分清楚：

| 声明情况 | 含义 | 图像请求时 |
|---|---|---|
| 声明了 `image` | 确定能看 | 优先 |
| 声明了但不含 `image` | 确定不能看 | 跳过并记 `NO_VISION` |
| **什么都没声明** | 未知 | **仍作为候选**（DSH 会原样把图片传给它） |

挡位上报也改成：**除非所有成员都明确声明只支持文字，否则就声明支持图像**。宁可多声明——少声明的后果是图片被静默降级，那正是这次遇到的问题。

### 顺带修的两个问题

- `resolveModel` 用过滤后的数组下标去对齐未过滤的链，一个无法解析的成员会让后面所有成员的模态错位。
- 调用日志成功记录新增 `vision` 标记（界面显示「含图片」），可以看出这一轮是因为图片才选了某个成员。

187 项测试。


## 1.1.10

### 修复：图片已 offload 仍被当成有图

DSH 的 offload 流程会给图片块打上 `offloaded: true` 并在发送前替换成文字占位符。判断逻辑只看了 `type === 'image'`，没排除这个标记，于是**图已经不在请求里了，还在排除纯文本成员**。

现在 offloaded 的图片不算图片。

### 新增：只看本轮的图片（开关）

原来只要上下文里还有图，**后面每一轮都会排除无视觉成员**——贴一张图就把整段会话锁在视觉模型上。

新增 **设置 → 高级 → 只看本轮的图片**，默认开：

| 状态 | 范围 |
|---|---|
| 开（默认） | 只检查**本轮新增输入**（最后一条 assistant 消息之后的所有消息，含工具结果里的截图） |
| 关 | 整段会话里有图就算 |

打开后，旧图不再影响选人；那个成员会收到被降级成文字的旧图（不是失败）。想严格保证「有图就必须看得见」，关掉这个开关。

本轮内的图片、以及工具返回的截图（比如浏览器截图）始终会被识别——不是只认最后一条用户消息。

184 项测试。

## 1.1.9

### 修复：token 速率显示成天文数字（如 264160 tok/s）

根因是**整个回答被缓冲到最后一次性吐出**。`runMember` 把每条 chunk 都收进数组，`stream()` 之后才统一 yield。DSH 用「输出 token ÷ 观察到的时间跨度」算吞吐，而这个跨度是 0 —— 于是除以近零得到天文数字。

这不只是显示问题，它同时意味着：

- **首字延迟等于整段生成时间**：用户要等完整回答才开始看到内容；
- 流式输出失效，所有内容在最后一瞬间出现。

现在改成**提交前缓冲、提交后直通**：为了让「失败的通道不泄漏半截回答」这条保证成立，输出仍然保留到出现读者可见内容为止；一旦提交（已可见，不可能再降级），后续 chunk 立刻转发。

实测：上游用 200ms 分 5 次输出，修复前 5 条 text-delta 全部在 229ms 同一瞬间到达（跨度 0ms），修复后跨度 188ms。

### 新增：视觉能力手动覆盖

很多网关实际支持图像却**不上报** `inputModalities`，于是被当成纯文本，图片被降级。现在每个成员有「视觉能力」三态：

| 取值 | 含义 |
|---|---|
| 跟随模型上报（默认） | 按适配器声明，未声明视为不支持 |
| 强制支持图像 | 即使没上报也认为能看图 |
| 强制不支持 | 即使上报了也不给它发图片 |

选「强制支持图像」后，这个成员会进入图像请求的候选，挡位也会因此上报 `['text','image']`。

### 关于「有图片时无视觉模型都会被跳过吗」

是的，但**只在请求确实含图片、且开关打开时**：

- 所有不能看图的成员在这一轮被跳过，日志各记一条 `NO_VISION`；
- 能看图的成员之间**仍按你排的顺序**，不会乱序；
- 纯文本请求完全不受影响；
- 整个挡位都没视觉成员时不会失败，但日志记 `NO_VISION_MEMBER`，明确告诉你图片会被降级。

## 1.1.8

## 1.1.8

### 图片输入

之前挡位硬编码 `inputModalities: ['text']`。DSH 对声明不支持图像的模型会自动把图片**降级成文字占位**（`projectImagesForTextModel`），所以贴图过去模型根本没看到图——这就是「方案不太行」的原因。

现在：

- 挡位上报**并集**：只要链里有一个成员能看图，挡位就声明 `['text', 'image']`，与窗口规则一致——先声明链的能力上限，再按请求路由。
- 派发时若请求**确实含图片**，跳过不能看图的成员，把请求交给能看的那个。
- 文本请求不受影响，仍按原顺序。

### 开关

**设置 → 高级 → 有图片时自动选能看图的成员**（默认开）。

关掉则保持原顺序——图片会按 DSH 的默认行为降级成文字，只适合排查问题。

### 没有视觉成员时

不会直接失败：请求照常发出（DSH 会把图片转成文字），但调用日志会记一条 `NO_VISION_MEMBER`，明确告诉你这个挡位里没有能看图的成员，而不是让你以为模型理解了却没懂。

### 调用日志

因无视觉被跳过的成员记为 `NO_VISION`，与因上下文过大跳过的 `CONTEXT_TOO_SMALL` 区分开。

### 其他

成员列表会给能看图的模型加「支持图像」标记；成员元数据加了 30 秒缓存，目录刷新与每轮派发不再重复查询。

## 1.1.7

## 1.1.7

### 挡位选人策略：优先剩余空间

新增挡位级 `contextStrategy`：

- **按顺序**（默认）— 链上第一个装得下的成员，行为与之前一致。
- **优先剩余空间** — 在所有装得下的成员里选剩余空间最大的那个。

先澄清一个容易误解的点：**DSH 的压缩时机由挡位上报的窗口决定，而上报值从 1.1.0 起就是链里最大的那个**。所以「压缩被推迟到最大成员的上限」早就生效了——换成员本身不会让压缩更晚。

这个策略解决的是另一个真实问题：长对话里，第一个装得下的成员可能只剩很少余量，于是要么供应商侧截断，要么很快撞到上限被迫换人。选剩余空间最大的那个，能让整段对话待在一个有余量的模型上。

代价是它会让更贵/更慢的模型更早接管，所以默认不开。

### 调用日志更详细

成功记录现在带 `estimate`（本次请求的估算输入）与 `contextWindow`（作答成员的窗口），可以直接看出这个会话离压缩还有多远。

## 1.1.6

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
