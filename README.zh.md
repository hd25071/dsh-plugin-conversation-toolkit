# dsh-plugin-conversation-toolkit（对话工具箱）

[English](README.md) | 中文

一个原生 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件，补上应用本身没有的对话操作：
把对话导出成 Markdown、复制可重新打开的对话链接、编辑用户消息并重发、分叉删掉某一轮、以及在输入框上方全局搜索所有对话。

## 功能

| 功能 | 出现位置 |
|---|---|
| **复制对话为 Markdown** | 侧边栏会话 `…` 菜单，以及每个会话行 hover 时的按钮 |
| **复制对话深链接** | 同上两处 —— 链接可直接重新打开该对话 |
| **全局对话搜索** | 直接位于**输入框上方**的搜索栏，跨会话搜索消息正文 |
| **编辑用户消息并重新发送** | 每个已完成回合下方的操作行 |
| **重新生成某一轮** | 同一行 —— 丢弃该轮回答**及其思考过程**后重新提问 |
| **删除某一轮及其之后** | 同一行 |
| **复制本轮对话** | 同一行 —— 用户消息 + 思考 + 回答，输出 Markdown |

所有文案都做了中英双语，跟随应用当前语言。

## 安装

```sh
# 在 DSH 会话里，或用 dsh CLI：
dsh plugin --profile <profile> add /绝对路径/dsh-plugin-conversation-toolkit
```

或在 agent 会话里把目录作为 bundle 安装：

```
plugin_manager action=install_bundle target=/绝对路径/dsh-plugin-conversation-toolkit
```

bundle patch 只插入一行 Host row；浏览器半边会由本包的 `dsh.client` 声明与 `exports["./client"]` 自动发现，
不需要第二行。安装会通过 HMR 直接生效；只在启动时装载模块的 profile 需要重启一次。

要求：DSH `0.2.0-rc.2` 或兼容版本，并且挂载了 `sessionQuery` 服务（`@deepseek-ai/dsh-base` 随
`dsh-session-query-sqlite` 自带）。

## 实现要点

插件由两半组成，但共享同一个前提：**会话日志是唯一事实源，且只读。**

### Host 半边 —— `lib/index.js`

在 `connection` 服务上注册两条精确 Fetch 路由。它不 import 任何 Harness 包（第三方 bundle 由 Node 按自身真实路径解析，
`import '@deepseek-ai/…'` 会直接 `ERR_MODULE_NOT_FOUND`），服务一律用 `ctx.get(...)` 取；不新增会话事件类型，也不注册
Remote 命名空间。

| 路由 | 返回 |
|---|---|
| `GET /api/conversation-toolkit/transcript?sessionId=…&reasoning=0\|1&tools=0\|1&meta=0\|1&format=md\|json` | 该对话的 Markdown（或 JSON 信封） |
| `GET /api/conversation-toolkit/turns?sessionId=…` | 每回合一条记录，含重写所需的分叉序号 |

两者都只是对 `ctx.sessionQuery.readSession(id)` 的读取 —— 应用恢复会话走的是同一条会做重放校验的路径。失败返回
`{ ok: false, error: { code, message } }` 并带真实 HTTP 状态码：`session-not-found` 是 404，日志不可读是 500，
profile 未挂载 `sessionQuery` 是 503。

### Client 半边 —— `client/client.js`

一个手写的浏览器 bundle，采用 Harness 模块加载器要求的 lazy-CJS 形式
（`window.__ModuleLoader__.load({ id, factory })`）。它只 require 平台种子表里的 `react` 一个模块；按官方插件编写指引，
所有控件都自己写、只用 `--dsw-alias-*` 主题令牌着色 —— 令牌改名只会让外观降级，不会让整个 slot 白屏。

| Slot | 条目 |
|---|---|
| `sidebar.workspaces.session.menu.item` | `copy-markdown` (500)、`copy-link` (510) |
| `sidebar.workspaces.session.row.action` | `copy-markdown` (150)、`copy-link` (160) |
| `conversation.chat.turnTail` | `turn-actions` (300) |
| `conversation.input.dock` | `global-search`（−10，排在自带 todo/goal/queue 之前） |
| `shell.overlay` | `dialogs` (20) —— 编辑弹窗、确认弹窗、提示条 |

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
因此同一浏览器里链接直接可用，服务端无需任何改动。

## 验证

```sh
npm test        # 34 个测试：转录折叠、回合索引、Host 路由、客户端 bundle 契约
```

- `test/transcript.test.mjs` —— 用合成的两回合日志**以及**本机 Harness home 里最大的真实
  `session.v4.jsonl.zstd` 做折叠，并断言每个算出来的截断点都指向真实存在的事件（这正是 `session.fork` 的要求）。
- `test/host-routes.test.mjs` —— 接口契约：路由路径、方法、默认值、状态码、错误信封。
- `test/client-bundle.test.mjs` —— bundle 能解析、注册了加载器要求的 factory id、只 require `react`、两份语言字典键集
  一致、恰好注册声明的 7 个条目，并用各自文档化的 props 渲染每个组件。

已在运行中的应用里实测：7 个条目在客户端 slot 检查器里全部 `active: true`，顺序与上表一致。

## 已知限制

- **不能删除整个会话。** DSH 没有会话删除 RPC，只有 `workspace/archiveSession`。所以本插件不删除对话，请用自带的
  "归档"。手工删 `session.v4.jsonl.zstd` 还会让 SQLite 搜索索引失配，因此刻意不做。
- **删除某一轮会连同该轮回答一起删除。** 思考过程无法单独去掉：它属于产生它的那一步助手输出，而改写已存事件在设计上
  就不可能。"重新生成"是"删除思考过程"的诚实版本 —— 整步丢弃后重新提问。
- **会话运行中相关操作会被禁用**，因为对进行中的对话分叉会得到一个前缀停在半途的子会话。
- **回合操作要等索引加载完才出现**（每个会话一次请求，页面生命周期内缓存）。在拿到截断点之前它渲染为空，而不是猜一个。
- **深链接只对已经认证过的浏览器有效** —— 它是"打开你本机应用"的链接，不是分享链接。

## 许可证

MIT
