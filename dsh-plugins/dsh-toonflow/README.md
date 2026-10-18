# dsh-toonflow

把 **Toonflow**（`Toonflow-app`：Bun + Vue3 + Express）以整页 iframe 嵌入 DSH Desktop 工作台。

## 结构

```
Toonflow-app/
  build/server/index.js   ← bun apps/server/scripts/buildStandalone.ts 产物
  build/web/              ← 上面脚本同时构建的 Vue 前端
  dsh-plugins/dsh-toonflow/
    src/index.js          ← host：/api/toonflow/status、/api/toonflow/launch
    lib/client.js         ← client：注册工作台面板（customFrame iframe → 127.0.0.1:3000）
    cordis.patch.yml
```

## 运行前提

1. 仓库根执行过一次生产构建（只需在代码变化后重跑）：
   ```bash
   bun apps/server/scripts/buildStandalone.ts
   ```
   产物：`build/web`、`build/server/index.js`、`build/tools|nodes|ext`。
2. 本机可用 `bun`（默认找 `~/.bun/bin/bun.exe`，可用 `TOONFLOW_BUN` 覆盖）。

## 行为

- **不点不启动**：只有用户在面板里点「启动 Toonflow」才会 spawn `bun build/server/index.js`。
- `/api/toonflow/launch` 20 秒去抖，避免重复拉起。
- 启动日志：`<DSH_HOME>/logs/toonflow-launch-*.log`（默认 `~/.dsh/logs`）。
- 面板会轮询 `/api/toonflow/status`（就绪 5s / 离线 3s / 隐藏 15s）。

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `TOONFLOW_ROOT` | Toonflow 仓库根（默认由插件路径推导） |
| `TOONFLOW_BUN` | bun 可执行文件路径 |
| `TOONFLOW_DATA_DIR` | 传给服务端的数据目录（服务端自身读取） |
| `DSH_HOME` | 启动日志目录根（默认 `~/.dsh`） |

## 安装

在 DSH 插件管理里安装本目录（link），或把它作为 `link:` 依赖加进 profile：

```json
"dsh-toonflow": "link:D:/Github/Vibe Coding/dsh-desktop/源码/Toonflow-app/dsh-plugins/dsh-toonflow"
```

并在 `dsh.profile.bundles` 里追加 `dsh-toonflow`，重启 DSH 后工作台出现 **Toonflow** 面板。

## 契约

- host 路由统一挂在 `/api/toonflow/` 前缀下，只做「探活 + 拉起」，不代理业务请求。
- 前端所有业务请求由 iframe 内的 Toonflow 应用直接发往 `127.0.0.1:3000`，不经过宿主。
- 面板样式使用宿主主题令牌（`--dsw-alias-*`），与 Nuomi Terminal 面板一致的接缝（上/左 1px 亮边 + 内侧投影）。
