# dsh-plugin-conversation-toolkit（对话工具箱）

[English](README.md) | 中文

一个原生 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件，补上应用本身没有的对话操作：
把**整段对话全文**导出成 Markdown、存成 .md 文件、复制可重新打开的对话链接、编辑用户消息并重发、以及分叉删掉某一轮。

## 功能

| 功能 | 出现位置 |
|---|---|
| **复制整段对话全文为 Markdown** | 侧边栏会话 `…` 菜单，以及每个会话行 hover 时的按钮 |
| **只复制对话正文**（不含思考与工具调用） | 侧边栏会话 `…` 菜单 |
| **下载为 `.md` 文件** | 侧边栏会话 `…` 菜单 |
| **复制对话深链接** | 侧边栏会话 `…` 菜单与行 hover 区 |
| **编辑用户消息并重新发送** | 每个已完成回合下方的操作行 |
| **重新生成某一轮** | 同一行 —— 丢弃该轮回答**及其思考过程**后重新提问 |
| **删除某一轮及其之后** | 同一行 |
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
| `conversation.input.dock` | `resend`(−10) —— 不渲染任何东西；它存在只是因为输入框 dock 是唯一同时拿得到会话身份与输入框 `input`/`inputActions` 的位置，"编辑并重发"需要这两样 |
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
npm test        # 38 个测试：转录折叠、回合索引、Host 路由、客户端 bundle 契约
```

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
- **删除某一轮会连同该轮回答一起删除。** 思考过程无法单独去掉：它属于产生它的那一步助手输出，而改写已存事件在设计上
  就不可能。"重新生成"是"删除思考过程"的诚实版本，整步丢弃后重新提问。
- **会话运行中相关操作会被禁用**，因为对进行中的对话分叉会得到一个前缀停在半途的子会话。
- **回合操作要等索引加载完才出现**（每个会话一次请求，页面生命周期内缓存）。
- **深链接只对已经认证过的浏览器有效** —— 它是"打开你本机应用"的链接，不是分享链接。
- **复制依赖安全上下文。** 用普通 HTTP 的局域网地址（非 `127.0.0.1`/`localhost`）打开时会回退到 `execCommand('copy')`；
  如果连它也被拒，提示条会写明原因 —— 那就改用「下载为 .md 文件」。

## 许可证

MIT
