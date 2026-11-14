# dsh-wb-credits

DeepSeek Harness 侧边栏底部的网关积分卡：总量、未来 7 天到期、首到期时间，点开看每个号
的剩余和按到期日的分布。数据从 api / panel / ssh 三种来源任选一种取。

## 功能

- **侧边栏卡片**（`sidebar.footer.action`，与 cost-meter 的「今日 / 余额」同座位）
  常显三行：总积分、7 天到期（分数 + 占比 + 进度条）、首到期日期。
- **点开明细**：按账号列的剩余与最早到期（Top 6）、按到期日汇总的 8 个桶、
  7 天之外还有多少到期、数据来源与快照时间。
- **宽度自适应**：侧边栏拖宽拖窄实时跟随，窄到 150 px 自动收成短标题、藏次要信息，
  颜色全走 `--dsw-alias-*` 主题变量，深浅色主题自动跟随。
- **三种取数方式**：只读令牌（可分发）＞ 面板登录 ＞ SSH；拿到哪种凭据就用哪种。
- **到期按日期窗口算**：现在 ~ 现在 +7 天，不是「前 7 个到期日」，某天没到期包不会把窗口悄悄拉长。

## 项目结构

```
lib/index.js          宿主半边：读配置、三种 provider、聚合计算、注册 GET /wb-credits/summary
lib/client.js         客户端半边：侧边栏卡片 + 自带样式表（<style data-plugin-css>）
server/credits.py     ssh 模式的远端取数脚本（只摘 credits，不做计算）
server/_test-*.mjs    五种自测：api / panel / ssh / inject / client
deploy/               api 模式的服务端三件套：快照服务、systemd unit、Nginx 片段
cordis.patch.yml      安装补丁（把插件行插进 profile）
```

三种 provider 共用 `lib/index.js` 里同一份聚合实现，不会算出三套数字。

## 安装

profile 的 `package.json`：

```json
"dependencies": { "dsh-wb-credits": "link:D:/Desktop/DSH插件/dsh-wb-credits" },
"dsh": { "profile": { "bundles": ["…", "dsh-wb-credits"] } }
```

`node_modules` 下建指向本目录的链接，然后重启 DSH。改 `lib/index.js` 要重启；
只改 `lib/client.js` 刷新页面（Ctrl+R）就够。卸载 = 删掉这两处引用后重启。

## 配置

```yaml
- id: wb-credits
  name: dsh-wb-credits
  config:
    provider: api            # api | panel | ssh，不写则按凭据自动挑
    api:
      baseUrl: https://fittestsys.top
      token: 只读令牌
    pollSeconds: 60          # 最小 15
```

| provider | 取数方式 | 需要什么 |
| --- | --- | --- |
| `api` | GET `<baseUrl>/wb-credits/summary`，头 `X-WB-Token` | 域名 + 只读令牌 |
| `panel` | `POST /panel/login` 换 token → `GET /accounts` | 域名 + 面板密码 |
| `ssh` | ssh 到网关主机读 `accounts/*.json` | 该主机 SSH 密钥 |

环境变量兜底（配置文件优先）：`WB_CREDITS_API_BASE_URL`、`WB_CREDITS_API_TOKEN`、
`WB_CREDITS_BASE_URL`（panel 地址）、`WB_CREDITS_PANEL_PASSWORD`、`WB_CREDITS_SSH_HOST`、
`WB_CREDITS_ACCOUNTS_DIR`。

## 数据接口

宿主半边注册同源路由 `GET /wb-credits/summary`（`?refresh=1` 跳过 55 秒缓存），
客户端只认这一个地址：

| 字段 | 含义 |
| --- | --- |
| `ok` / `error` | 成功与否；失败给中文原因（令牌被拒、接口没发布、密码错） |
| `provider` / `source` | `api` / `panel` / `ssh`，以及域名或 SSH 目标 |
| `accounts` / `enabled` | 账号数 / 其中启用的 |
| `total_remain` / `total_used` | 全部剩余 / 已用积分 |
| `expiring_7d` / `beyond_7d` | 7 天内到期 / 7 天之外到期 |
| `buckets` | 按到期日聚合的积分桶（最多 30 个） |
| `accounts_detail` | 每号昵称、剩余、最早到期，按剩余降序 |
| `poll_seconds` | 建议轮询间隔 |

### api 模式的服务端

`deploy/` 里有现成文件，三步：

1. `wb-credits-api.py` → `/opt/wb-credits-api/`，`wb-credits-api.service` → systemd，
   只监听 `127.0.0.1:8799`，只读 `/opt/wb-proxy/accounts/*.json`，5 秒缓存，不打上游。
2. `openssl rand -hex 24 > /opt/wb-credits-api/token && chmod 600`（没有令牌时服务拒绝启动）。
3. `nginx-credits-api.conf` → `/etc/nginx/snippets/`，在 443 的 `server {}` 里 `include`；
   对外只放 `= /wb-credits/summary`，其余 `/wb-credits/*` 返回 404。

轮换令牌：改令牌文件 → `systemctl restart wb-credits-api` → 改插件配置。
令牌走请求头，不会出现在 Nginx access.log 里。

## 自测

```bash
node server/_test-api.mjs     # api：假快照接口 + 令牌错 / 404 / 缺令牌 / 500 / 坏 JSON / ok:false 快照 / 空池 / 连不上 / 超时（33 项）
node server/_test-panel.mjs   # panel：假网关 + 登录 + 401 重登 + 错密码
node server/_test-host.mjs    # ssh：本地 http server 包一层，打真实 SSH
node server/_test-inject.mjs  # ctx.inject 等待服务路径
node server/_test-client.mjs  # 客户端能装上、注册到侧边栏座位
```
