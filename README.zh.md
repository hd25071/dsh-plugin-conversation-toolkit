# dsh-plugin-conversation-toolkit（对话工具箱）

[English](README.md) | 中文

一个原生 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件，补上应用本身没有的对话操作：
把**整段对话全文**导出成 Markdown、存成 .md 文件、复制可重新打开的对话链接、以及搜索所有对话的内容。

## 范围

这个插件是**只读**的：它不写会话、不分叉会话、不提交任何内容。

- **导出** —— 三档 Markdown 复制、下载、单轮复制、复制失败恢复弹窗、带 singleflight 的短时缓存。
- **导航** —— 复制会话深链接，以及用深链接打开对应会话。
- **检索** —— 侧边栏内容搜索，走 DSH 自己的全文索引。

「编辑历史消息」「重新生成」「删除对话回合」已在 0.6.0 移除。DSH 的会话日志是只追加的，
这三件事只能通过分叉子会话实现；既然做不到原地改写，就不值得为它付出分叉的代价。
最后带这些功能的版本在 `backup/full-toolkit` 分支。

## 功能

| 功能 | 出现位置 |
|---|---|
| **复制为 Markdown（标准版）**：对话 + 工具名 | 侧边栏会话 `…` 菜单，以及每个会话行 hover 时的按钮 |
| **复制完整版**（思考、工具参数、工具结果） | 侧边栏会话 `…` 菜单 —— 会先提示，因为它可能带出敏感信息 |
| **复制简洁版**（仅对话） | 侧边栏会话 `…` 菜单 |
| **下载为 `.md` 文件** | 侧边栏会话 `…` 菜单 |
| **复制对话深链接** | 侧边栏会话 `…` 菜单与行 hover 区 |
| **复制本轮对话** | 同一行 —— 用户消息 + 思考 + 回答，输出 Markdown |

所有文案都做了中英双语，跟随应用当前语言。

长对话导出会超过 1 MB，所以「下载为 .md 文件」是**永远可用**的那条路：它完全不碰剪贴板、不受安全上下文限制、也不受
粘贴目标的大小限制。

## 安装

```sh
# 在 DSH 会话里，或用 dsh CLI：
dsh plugin --profile <profile> add /绝对路径/dsh-plugin-conversation-toolkit
```

或在 agent 会话里把目录作为 bundle 安装：

```
plugin_manager action=install_bundle target=/绝对路径/dsh-plugin-conversation-toolkit
```

bundle patch 只插入一行 Host row；浏览器半边会由本包的 `dsh.client` 声明与 `exports["./client"]` 自动发现。

要求：DSH `0.2.0-rc.2` 或兼容版本，并且挂载了 `sessionQuery` 服务（`@deepseek-ai/dsh-base` 随
`dsh-session-query-sqlite` 自带）。

## 侧边栏正文搜索：为什么默认只能搜到标题

自带的侧边栏搜索框看着像只搜名称，**默认它确实只搜名称**。`dsh-base` 把 session-query 索引整个关掉了，它自己的 patch 里
写得很清楚：

```yaml
# Full-text session search is opt-in. `openAt: never` keeps ctx.sessionQuery mounted — exact reads, titles, and
# lineage traces ... stay available — while search calls fail with SESSION_QUERY_SEARCH_DISABLED and SQLite is never
# opened; the Web sidebar search matches titles and workspace names only. Deployments enabling content search
# override `openAt` to `first-search` or `startup` in a later patch layer (profile cordis.patch.yml ...),
# typically with a durable `path`.
- id: session-query-sqlite
  config:
    path: ':memory:'
    openAt: never
```

要打开真正的正文搜索，往 profile 的 `cordis.patch.yml` 加这段（Loader patch 是**整键替换**，所以 `path` 必须一起重述）：

```yaml
- id: session-query-sqlite
  name: '@deepseek-ai/dsh-session-query-sqlite'
  config:
    path: 'C:/Users/<你>/.dsh/cache/session-query.sqlite'
    openAt: first-search
    # 首次建索引要先把所有会话读完才会写库，期间只要有任何写入就整轮作废；
    # 提高并发能缩短这个脆弱窗口。
    persistedReadConcurrency: 16
```

**第一次搜索是最脆弱的。** 引擎先读完整个语料，再重新列一次持久化快照，只要中间有任何变化就抛
`SESSION_QUERY_PERSISTENCE_FAILED`；而**在快照比对通过之前它一个字都不写**，所以失败的尝试不会留下任何进度。请在没有回合
运行、没有子 agent 的**空闲时刻**触发第一次搜索。一旦成功，索引就是持久的，之后的搜索都是增量且很快的。

之后侧边栏就能搜到消息正文了：它会把会话名匹配与全文命中合并，每条结果显示命中片段。`Ctrl/Cmd+K` 聚焦它。

## 三种导出模式：到底哪些内容会离开这台机器

一段对话里可能夹着不该顺手外传的东西：思考过程常常复述私有上下文，工具参数里有绝对路径甚至令牌，工具结果
经常就是文件内容或命令输出。**所以默认是最窄的那一档。**

| 模式 | 对话 | 思考 | 工具名 | 工具参数与结果 | 系统提示 | 压缩摘要 | 工作区路径 | 文件头警告 |
|---|---|---|---|---|---|---|---|---|
| `brief` 简洁版 | 有 | — | — | — | — | — | — | — |
| `standard` 标准版**（默认）** | 有 | — | 有 | — | — | — | — | — |
| `full` 完整版 | 有 | 有 | 有 | 有 | 有 | 有 | 有 | 有 |

两点要单独讲清：

- **压缩摘要属于内部材料**：它代替的是用户从没写过的历史，所以只出现在 `full` 里。
- **工作区路径与父会话 id 属于本地路径元数据**：它们暴露这台机器的目录结构和另一段对话，同样只在 `full` 里写。

但这两条都**不能**消除剩余风险：**你自己的消息在任何模式下都是原样写入的，同样可能含秘密。**
窄模式去掉的只是 agent 添加的东西 —— 所以每份导出都带这一行：

```markdown
- **Careful**: your own messages are included verbatim and may contain secrets.
```

旧的 `reasoning`/`tools` 参数仍然接受，但它们**只能收窄**，不能放宽：

| 请求 | 结果 |
|---|---|
| `mode=full` | 完整版 |
| `reasoning=false&tools=true` | 标准版 —— 不含思考，也不含工具载荷 |
| `reasoning=true&tools=false` | 标准版 —— 连工具名都没有，只剩对话 |
| `mode=乱写` | 标准版，**即使**带 `reasoning=true` —— 非法模式绝不会被旧参数升成完整版 |

`true` 只被理解为"允许"，不是"要求"，所以混合参数取的是交集而不是最宽那一档。

标准版 = 对话 + 跑过哪些工具的名字，读得懂但不带载荷。完整版是唯一可能带出秘密的一档，而且它**在文件里自己
声明**：

```markdown
> [!WARNING]
> This export contains **thinking, tool-call arguments and tool results**.
> Those routinely carry API tokens, credentials, absolute local paths, file
> contents and command output. Read it before sharing it.
```

**无法识别的模式一律退回 `standard`，绝不会退到 `full`。** 文件头会写明是哪一档导出的，日后捡到一个文件不必
打开就能判断风险。

### 转义

文档是 Markdown，但 `<details>`/`<summary>`/`<code>` 是裸 HTML，所以放进去的动态文本一律转义 —— 工具名由模型和
工具决定，未转义的 `<` 会把标记注入到用户即将分享的文件里。而 Markdown **代码段**里的文本要反过来处理：代码段
是字面量，转义会原样显示成 `&lt;`，那里真正要中和的是会提前闭合代码段的反引号。

## 导出的 Markdown 长什么样

"全文"版本按日志顺序输出整段记录：

```
# <会话标题>

- **Session**: `…`       - **Workspace**: `…`
- **Created**: …          - **Last model**: `…`
- **Turns**: 12           - **Events**: 431
- **Exported**: …

## Turn 1

### User
<用户消息原文>

#### Thinking
<助手思考过程>

### Assistant
<助手回答>

<details><summary>Tool call · <code>read</code></summary>
{ "file_path": "…" }
</details>

<details><summary>Tool result</summary>
…
</details>

---

## Turn 2
…
```

"精简"版本保留 `## Turn N`、`### User`、`### Assistant` 三段，去掉思考、工具调用、工具结果与系统提示。

## 实现要点

插件由两半组成，共享同一个前提：**会话日志是唯一事实源，且只读。**

### Host 半边 —— `lib/index.js`

在 `connection` 服务上注册两条精确 Fetch 路由。它不 import 任何 Harness 包（第三方 bundle 由 Node 按自身真实路径解析，
`import '@deepseek-ai/…'` 会直接 `ERR_MODULE_NOT_FOUND`），不新增会话事件类型，也不注册 Remote 命名空间。

| 路由 | 返回 |
|---|---|
| `GET /api/conversation-toolkit/transcript?sessionId=…&reasoning=0\|1&tools=0\|1&meta=0\|1&format=md\|json` | 该对话的 Markdown（或 JSON 信封） |
| `GET /api/conversation-toolkit/turns?sessionId=…` | 每回合一条记录，含重写所需的分叉序号 |

两者都只是对 `ctx.sessionQuery.readSession(id)` 的读取 —— 应用恢复会话走的是同一条会做重放校验的路径。失败返回
`{ ok: false, error: { code, message } }` 并带真实 HTTP 状态码。

**两个 Cordis 陷阱值得记住。**

1. `sessionQuery` 由**兄弟 fiber** 提供，而 Cordis 解析服务时只沿插件自己的祖先链上溯，于是直接属性访问会抛
   `cannot get property "sessionQuery" without inject`；必须用 `ctx.get(name)`（文档里那条 "without the inject
   requirement" 的读法）。本插件所有服务读取都走一个受保护的 helper，绝不抛异常；`test/host-routes.test.mjs`
   用 Proxy 复刻了这个行为，所以一旦改回属性访问，测试会失败，而不是在浏览器里静默出错。
2. Host 半边是**每个进程代只加载一次的 ES 模块**。改它**不会**影响正在运行的应用（见下方开发笔记）。

### Client 半边 —— `client/client.js`

一个手写的浏览器 bundle，采用加载器要求的 lazy-CJS 形式（`window.__ModuleLoader__.load({ id, factory })`）。
只 require 平台种子表里的 `react` 一个模块；按官方插件编写指引，所有控件自己写、只用 `--dsw-alias-*` 主题令牌着色。

| Slot | 条目 |
|---|---|
| `sidebar.workspaces.session.menu.item` | `copy-markdown`(500)、`copy-markdown-brief`(505)、`download-markdown`(508)、`copy-link`(510) |
| `sidebar.workspaces.session.row.action` | `copy-markdown`(150)、`copy-link`(160) |
| `conversation.chat.turnTail` | `turn-actions`(300) |
| `shell.overlay` | `dialogs`(20) —— 编辑弹窗、确认弹窗、提示条 |

### 为什么"编辑"是分叉而不是改写

DSH 的会话是**只追加**日志：已提交事件永不改写，平台唯一暴露的裁剪原语是

```js
session.fork({ sessionId, atSeq })   // atSeq 是【闭区间】截断点
```

整个发行版里没有 edit / delete / truncate / rewind / resend 任何 API —— 对全部客户端 bundle 做全量扫描，
`rollback`、`rewind`、`resend`、`editMessage`、`deleteMessage`、`removeMessage`、`hideThinking`、`truncateMessages`
命中数均为 0。

所以本插件的每个操作都是"一次裁剪 + 可选的一次重发"：

| 操作 | 截断点 | 之后 |
|---|---|---|
| 编辑并重发 | 该轮 `turn/start` 之前一个事件 | 打开子会话，把改好的文本填进输入框并提交 |
| 重新生成 | 该轮 `user/message` 的序号 | 打开子会话，用原文重新提问 |
| 删除本轮及之后 | 该轮 `turn/start` 之前一个事件 | 打开子会话 |

**原会话永远不被修改。** 每个操作都新建一个会话并打开它，与应用自带"分叉"按钮走的是同一套机制。操作失误的代价只是
侧边栏多出一个会话，绝不会丢历史。

### 没有路由也能做深链接

DSH 的 Web 外壳里完全没有路由代码 —— 它不调用 `pushState`/`replaceState`，也不读 `location.search`；当前打开的会话存在
`localStorage["dsh.sessions.current"]`。于是查询串是空着的：

```
http://127.0.0.1:19387/?dsh-session=<sessionId>
```

插件写这个链接，并在启动时读同一个参数调用 `uiWorkspace.openSession(id)`（会重试几次，因为外壳自己的
`restoreSelection` 在列表就绪后才落定）。服务端对"带额外参数的、且已通过 Cookie 认证的根路径请求"照常返回首页，
因此同一浏览器里链接直接可用。

## 开发笔记

- **浏览器半边会热替换，Host 半边不会。** `dsh-client-hmr` 对每个包的 bundle 做 stat-poll（mtime/ctime/size，约 500ms）
  并就地换进打开的页面，所以客户端改动是即时的。Host 模块只有在 `hmr.root` 指名其目录时才被监视，而 base 层是
  `hmr.root: []`。要让 Host 改动也热替换，往 profile 的 `cordis.patch.yml` 加：

  ```yaml
  - id: hmr
    name: "@deepseek-ai/dsh-hmr"
    config:
      root:
        - "/绝对路径/dsh-plugin-conversation-toolkit"
  ```

  没有它时，用 `plugin_manager action=set_bundle enabled=false` 再 `enabled=true` 可以重新导入一代新模块
  （这条有效，单纯 touch 文件无效），或者重启 DSH。
- **slot 条目会自报崩溃。** `cordis_inspect_query` → client `Slots.listSubTree`，带 `root=<slot>`，列出的 occupant
  有个 `active` 标志；**`active: false` 就说明组件渲染时抛异常、该格已让给下一个存活条目**。这是发现注册出问题最快的办法；
  把临时条目的 `id` 当作取值通道，也是在没有可读浏览器 console 的情况下诊断 Host 半边可达性与搜索后端的办法。

## 验证

```sh
npm run check   # 先对所有源文件做语法检查，再跑测试
npm test        # 71 个测试
```

CI 在 **ubuntu-latest** 与 **windows-latest** 上跑 `npm run check`，并把通过数/跳过数以一行明确输出到运行摘要里。

**要看跳过数，不能只看通过数。** 有两个测试标了 `integration:`，需要本机 DSH home 里真实的
`session.v4.jsonl.zstd`。开发机上有，跑出来是 `tests=71 pass=71 fail=0 skipped=0`；
GitHub 托管运行器没有，同一套测试会报 `skipped=2`。两者都对 —— 它们本来就不是同一次运行。

- `test/transcript.test.mjs` —— 用合成两回合日志**以及**本机 Harness home 里最大的真实 `session.v4.jsonl.zstd` 做折叠。
  真实日志那一例会断言：每个算出来的截断点都指向真实存在的事件（`session.fork` 的要求）、默认导出为每个折叠出的回合
  都产生一个 `## Turn N` 标题、且精简导出严格更小。
- `test/host-routes.test.mjs` —— 接口契约：路由路径、方法、默认值、状态码、错误信封，以及"经 Proxy 抛错的兄弟服务读取"。
- `test/client-bundle.test.mjs` —— bundle 能解析、注册了加载器要求的 factory id、只 require `react`、两份语言字典键集
  一致、恰好注册声明的 9 个条目，并用各自文档化的 props 渲染每个组件。

## 已知限制

- **侧边栏正文搜索需要上面那段部署 patch，且首次建索引需要 DSH 空闲。** 回合运行期间建索引会以
  `SESSION_QUERY_PERSISTENCE_FAILED` 失败；空闲时重试即可。
- **不能删除整个会话。** DSH 没有会话删除 RPC，只有 `workspace/archiveSession`。请用自带的"归档"。手工删
  `session.v4.jsonl.zstd` 还会让 SQLite 搜索索引失配，因此刻意不做。
  就不可能。"重新生成"是"删除思考过程"的诚实版本，整步丢弃后重新提问。
- **会话运行中相关操作会被禁用**，因为对进行中的对话分叉会得到一个前缀停在半途的子会话。
- **回合操作要等索引加载完才出现**（每个会话一次请求，页面生命周期内缓存）。
- **深链接只对已经认证过的浏览器有效** —— 它是"打开你本机应用"的链接，不是分享链接。
- **自动重发绝不自己重试。** `inputActions.submit()` 没有幂等保证：被拒绝的那次调用可能其实已经发出去了，
  再自动调一次就可能重复发送。所以失败时把载荷停在 `failed`，在输入框上方显示一条小条，带**重试发送**和
  **忽略**两个按钮；文本同时也留在输入框里，自己按 Enter 也能发。**不点就不重试。**
- **预取只是"手势桥"。** hover 会话行或打开菜单时，只预取**默认模式** —— 绝不预取 `full`，也不会一次导出三种模式 ——
  目的是让剪贴板写入落在点击自己的焦点手势里。同一会话+模式的并发请求共用一次 HTTP 调用，缓存 5 秒过期，
  并且一旦插件知道对话已经变化就立即作废。
- **复制需要窗口处于焦点。** 应用在后台时 `navigator.clipboard.writeText` 会抛 `Document is not focused`，
  `execCommand` 回退同样需要焦点。插件从三个方向缓解：**在行 hover 和菜单打开时就预取**，让点击后立刻写入；
  **写完后读回校验**；万一仍被拒，就**把导出内容原样放进一个弹窗**，里面有「重新复制」和「下载为 .md」——
  复制失败永远不会让你丢掉这次导出。

## 许可证

MIT
