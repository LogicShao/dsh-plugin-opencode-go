# dsh-plugin-opencode-go

[![test](https://github.com/LogicShao/dsh-plugin-opencode-go/actions/workflows/test.yml/badge.svg)](https://github.com/LogicShao/dsh-plugin-opencode-go/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

DSH 插件：给所有发往 OpenCode Go 的请求补 `x-opencode-session` 头，并提供 Go 的 `web_search` / `web_fetch`。

## 安装

DSH Desktop → 侧栏 **插件** → **添加插件** → **安装第三方插件**，粘贴：

```text
github:LogicShao/dsh-plugin-opencode-go
```

启用并重启 DSH。

```bash
# 或者用 CLI
dsh plugin --profile desktop add github:LogicShao/dsh-plugin-opencode-go
```

要求 DSH 44.7.0（runtime 0.2.1-rc.2）或兼容版本。

## 配置

插件不注册 LLM provider。在 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` 加：

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      opencode-go:
        apiKeyEnv: OPENCODE_GO_API_KEY

- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: opencode-go
    model: deepseek-v4.1-flash
    reasoningEffort: max
```

API key 二选一：DSH 设置 → 模型 → `opencode-go`，或环境变量 `OPENCODE_GO_API_KEY`。
`deepseek-v4.1-flash` 不在模型目录时换成实际可用的模型。

搜索/抓取已有默认值，一般不用改。要改就在 profile 覆盖 `opencode-go-adapter` 的 `search` / `fetch`，常用项：

- `search.model`：默认 `claude-haiku-5-5`，可写 `auto` 跟随聊天模型；
- `search.fallbackModels`：主模型不检索时的回退链；
- `search.officialFallback`：默认 `false`；
- `fetch.timeoutMs`：默认 `30000`；
- `fetch.allowIpLiterals`：默认 `false`，内网调试才开。

没有插件页表单，配置只走 YAML。关掉整个插件会恢复 DSH 默认搜索/抓取。

### 多 key

`keys` 按 `priority` 从高到低用；同一会话固定一个 key，失败才换；同优先级随机。

```yaml
- id: opencode-go-adapter
  name: 'dsh-plugin-opencode-go'
  config:
    keys:
      - ref: OPENCODE_GO_API_KEY
        priority: 10
      - ref: OPENCODE_GO_API_KEY_2
        priority: 5
      - ref: OPENCODE_GO_API_KEY_3
        priority: 5
    keyFailoverAfter: 2
```

- `ref` 是 `~/.dsh/.credentials.yaml` 的引用名或启动环境变量名；
- 401/402/403 立即换 key；408/429/5xx/网络错误连续 `keyFailoverAfter` 次后换；
- 同一对话的聊天和搜索共用一个 key；
- `llm-pi-ai` 的 `apiKeyEnv` 仍需指向一个存在的 key，实际请求的 key 由 `keys` 池覆盖。

不配置 `keys` 时保持原来的单 key 行为。

## 验证

聊天不再报 `400 Request is missing x-opencode-session`，`web_search` 能返回结果。升级 DSH 后跑：

```bash
node tools/compat-check.mjs
```

## 兼容性

已核对 DSH 0.2.1-rc.2 / cordis 4.0.5；不依赖 `@deepseek-ai/*` 包。

## 测试

```bash
node test/mechanism.test.mjs
node test/keys.test.mjs
node test/fetch.test.mjs
```

## License

MIT
