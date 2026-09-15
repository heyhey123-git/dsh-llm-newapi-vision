# testbed：容器化插件测试环境

在不影响宿主 DSH 环境的前提下，跑源码层（L1）与真实宿主启动层（L2）校验；
支持多宿主版本与插件共存组合。

- 宿主 `$DSH_HOME` 与仓库源码都以 `:ro` **只读**挂载，容器内写入只落在容器可写层与命名卷。
- 每次运行前会自检两个挂载点确实不可写，可写即拒绝运行。
- 默认宿主端口 13080（宿主 3080 是 GUI，本环境永不占用）。

测试内容概览：

| 层 | 位置 | 内容 |
| --- | --- | --- |
| L1（源码层） | `entrypoint.sh` 的 `run_l1` | `npm ci`、`npm run typecheck`（host + client）、`npm run build` 后比对 `lib/` 内容哈希（产物新鲜度）、`npm run test:client`（vitest）、`npm run test:host`（host-compat，对齐容器内实际安装的 dsh-llm）、`node test/smoke.mjs`（真实 Cordis 组合） |
| L2（真实宿主层） | `probes/boot-probe.sh` | 在容器内真实启动 `dsh web`，再用 curl 探针走一遍：一次性 token 换会话 cookie → 首页 200 → boot 图包含本插件客户端 bundle → 本插件 RPC 通道应答语义 → 日志卫生；组合格另加对端 bundle 与"两通道互不覆盖"断言 |

断言与组合契约的唯一真源是仓库里的两个文件：`probes/boot-probe.sh` 与
`probes/expectations.companion.json`。本 README 只描述用法与边界，判定细节以它们为准。

## 前置条件

- Docker Engine + Compose v2（`docker compose version` 能打印版本）。
- Node.js：只有 `node matrix.mjs` 需要（本机实测 v24.19.0 可用；脚本只用 Node 内建模块）。
- 能访问 npm registry（或在 `.env` 里设 `NPM_REGISTRY` 指向镜像）。镜像构建期需要安装
  `pnpm` 与 `@deepseek-ai/dsh`；`preserve` 模式与对端打包期还需要联网解析第三方包。
- 宿主 `$DSH_HOME`（默认 `/root/.dsh`）：只读挂载，容器内不会修改。
- 磁盘：镜像 + 两个命名卷（npm / pnpm store）。首次构建要拉取基础镜像。

## 首次构建

```sh
cd testbed
cp .env.example .env   # 按需修改 DSH_HOME_HOST / HOST_PORT / NPM_REGISTRY
docker compose build
```

`.env` 与 `.out/`、`.docker-config/` 都已被 `testbed/.gitignore` 忽略，不会入库。

## 常用命令

以下命令都在 `testbed/` 目录内执行。

```sh
# 1) 单格：默认宿主版本（与 CI 开发 pin 一致，0.1.5-rc.2）跑完整 L1 + L2
docker compose run --rm --build testbed

# 2) 指定宿主版本
DSH_VERSION=0.1.5-rc.1 docker compose run --rm --build testbed

# 3) 叠加对端插件（共存验证）
COMPANION=dsh-quota-panel COMPANION_HOST_DIR=../../dsh-quota-panel \
  GRID_LABEL=self+quota docker compose run --rm --build testbed

# 4) 全矩阵（默认 latest + next 去重 × self）
node matrix.mjs

# 5) preserve：先还原宿主 profile 的 bundle 行，再安装本仓库 tarball
PROFILE_MODE=preserve DSH_VERSION=0.1.5-rc.1 docker compose run --rm --build testbed

# 6) 分步调试（`STEPS=all` 是默认值）
STEPS=assert,seed,stage,l1,pack,profile,l2 docker compose run --rm --build testbed
```

`matrix.mjs` 的参数：

| 参数 | 含义 |
| --- | --- |
| `--versions v1,v2` | 显式给出宿主版本；缺省读 registry 的 `latest` + `next` 去重 |
| `--combos self,pair` | 组合集合，缺省 `self` |
| `--check-host` / `--no-check-host` | 宿主零改动快照，默认开启；两者同给即报错 |
| `--jobs 1` | 目前仅为保留参数，矩阵仍是串行；非 1 会直接报错 |

版本集合或组合集合解析后为空时脚本会**拒绝运行**（`0` 格全绿是假绿），而不是退化成
"0/0 格通过"。

每格的原始日志写到 `testbed/.out/<版本>-<组合>.log`，汇总表写到 `testbed/.out/summary.md`
（整个 `.out/` 已 gitignore）。

### 三个对应关系（照抄时最容易写错的地方）

- `DSH_VERSION` / `PROFILE_MODE` / `COMPANION` / `GRID_LABEL` / `STEPS` 是 **compose 环境变量**，
  要写在 `docker compose run` **前面**；只有 `docker compose run` 之后、service 名之后的参数
  才会被当成 entrypoint 参数（如 `--source-hash`）。
- `COMPANION_HOST_DIR` 是**宿主路径**，相对 `testbed/` 目录解析：对端仓库与本仓库同级时写
  `../../<对端目录名>`。对端目录需要已有 `node_modules`（对端的 `prepack` 就是构建，
  缺 devDependencies 会在 `npm pack` 阶段 fail-fast）。
- `COMPANION` 必须与对端 tarball 内 `package.json` 的 `name` 严格一致，否则直接报错。

## 宿主侧准备

本机下 `/root/.docker` 可能是只读的，docker CLI 需要一个**可写**状态目录：

```sh
export DOCKER_CONFIG="$PWD/.docker-config"   # 在 testbed/ 目录内执行
```

该目录由本仓库提供且已被忽略，**不要**把 `~/.docker/config.json` 复制进来（它可能含凭据）。
`matrix.mjs` 会自动设置该变量。

## 基础镜像获取

`Dockerfile` 的 `FROM` 始终是官方的 `node:24-bookworm-slim`。若 daemon 的 registry mirror
不可用、`docker.io` 直连超时，可先预取再按原名打本地标签：

```sh
docker pull docker.m.daocloud.io/library/node:24-bookworm-slim
docker tag  docker.m.daocloud.io/library/node:24-bookworm-slim node:24-bookworm-slim
```

**不要把第三方镜像站写进 `FROM`**；预取时请记录 registry 下发的 digest 以便日后核对。

## 宿主零改动如何验证

1. **运行前只读断言**：每次 `docker compose run` 会断言 `/host-dsh-home` 与 `/plugin-src`
   只读，可写即拒绝运行（`assert` 步）。
2. **运行前后白名单快照**：`matrix.mjs` 对宿主配置做前后快照 —— `settings.yaml`、
   `.credentials.yaml`、`pet.json`、`skills/`、`profiles/`（`profiles/node_modules` 除外）——
   任何变化即判红，末行会打印 `宿主零改动：否`。会持续变化的会话/浏览器目录不在白名单内。
3. **手工复核**：

   ```sh
   find "$DSH_HOME" -maxdepth 1 -newermt '-5 minutes'
   ```

   正常应无输出（刚跑完测试时宿主 `$DSH_HOME` 顶层不应有改动）。

留意快照只覆盖**配置类文件**：它证明的是"测试没有改写宿主配置"，不是"测试没碰过宿主任何字节"。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| `@deepseek-ai/*` 报 `EINTEGRITY` | 在 `.env` 设 `NPM_REGISTRY=https://registry.npmmirror.com` 后 `--build` 重跑（该变量在镜像构建期生效） |
| 端口被占用 | 设 `HOST_PORT=13081`（宿主 3080 是 GUI，永不用）；矩阵会自己从 13080 起逐格 +1，与手工运行冲突时先确认没有残留容器 |
| `can only be read by its owner` 类加载失败 | 容器内凭据权限：确认 `chmod 600` 生效（entrypoint 已处理），Windows 挂载下可能无法设权限 |
| 构建产物新鲜度判红 | 在宿主执行 `npm run build` 并提交重建的 `lib/`（等价于 CI 的 committed artifacts are current） |
| 首次构建很慢 | 要拉取 `node:24-bookworm-slim`；后续构建命中层缓存 |
| 某个包下载异常 / 依赖 registry 缓存 | 命名卷 `dsh-testbed-llm-newapi_npm-cache`、`dsh-testbed-llm-newapi_pnpm-store` 是包缓存，怀疑缓存损坏时可 `docker volume rm` 后重跑（代价是重新下载） |
| 单格 FAIL | 先看 `testbed/.out/<版本>-<组合>.log` 的尾部；`[freshness]` 或"镜像陈旧"字样说明镜像没跟上源码，按下一节处理 |

## 已知限制与注意事项

1. **`preserve` 不还原版本约束（版本漂移）**：`preserve` 只按**行名**还原宿主 profile 的
   bundle 行。宿主里 `dsh-quota-panel@0.9.2-rc.3` 在容器内解析到的是 registry 的 `latest`
   稳定 dist-tag（该包 `latest=0.9.1`，装出来是 `^0.9.1`），**不是**宿主 pin 的 `next`
   预发布。这**不是"降级"**（`^0.9.1` 本来就允许 0.9.2）；准确含义是：`preserve` 复现的是
   "装了哪些 bundle 行"，而不是"装了哪些确切版本"。需要逐版本一致必须另做（本环境未做）。
2. **`preserve` 只从行名出发，且依赖宿主 profile 存在**：缺
   `/host-dsh-home/profiles/web/package.json` 会直接 `die`；`minimal` 无此前提。
3. **`preserve` 的退出码语义**：还原第三方行失败只**警告**、不中断流程，因此
   **"退出码 0"并不等于"完整复现了宿主组合"**。判读要看两点：`bundles:` 行（列出了实际注册
   的 bundle 层）与日志里有没有 `警告：还原 <行名> 失败`。`preserve` 也会带出 pnpm 的
   peer dependency 警告，属正常噪声，不影响装配断言。
4. **镜像新鲜度陷阱（曾造成假绿）**：`docker compose run --build` 在 `COPY probes` 层判定为
   缓存命中时会**静默复用陈旧镜像**（实测过：镜像内探针 137 行 vs 宿主 191 行，整格假绿）。
   因此 `matrix.mjs` 每格开跑前都做两件事：① 运行 `--source-hash`，把镜像内
   `entrypoint.sh` + `probes/` 每个文件的 sha256 与宿主源码逐项比对，并比对构建配方指纹
   （`Dockerfile` + `entrypoint.sh` 的摘要）；② 不一致先 `docker compose build --no-cache`
   重建，仍不一致就判**该格 FAIL**（宁可真红，不要假绿）。
   手工跑单格时，若改过 `entrypoint.sh`、`probes/` 或 `Dockerfile`，请带 `--build`，
   必要时 `--no-cache`。
5. **`--volume` 必须写在 service 名之前**：`docker compose run --rm testbed --volume … testbed`
   这类写法里，service 名之后的 `--volume` 会被**静默忽略**，注入的 fixture 不生效。
6. **日志卫生断言从未变红（已知限制）**：`plugin tree failed to load` 与 `without inject`
   两个关键词在全部历史日志中 **0 命中**。该断言排在 L2 最后，插件树加载失败通常会先被
   boot 图断言捕获；但"它自己能否判红"未经实测，属未覆盖项，**不是缺陷**。
7. **`die()` 会把日志尾部（含一次性 token）打到 stdout**：探针失败时会 `tail -40`
   容器内 `dsh web` 日志，其中含一次性登录 token；这些内容会落在宿主侧
   `testbed/.out/logs/`（已 gitignore）。**分享日志前请先脱敏**，例如
   `sed -E 's/([?&]token=)[^ &]+/\1[REDACTED]/g'`。
8. **基础镜像来源**：`Dockerfile` 的 `FROM` 始终是官方 `node:24-bookworm-slim`。在
   `docker.io` 直连超时、daemon mirror 不可用的环境里，镜像是从可信镜像站预取后**在本地按
   原名打标签**的（见"基础镜像获取"）。这是环境侧的取巧，不是文件内容；若要求严格来自
   `docker.io` 官方，需要先修好网络/镜像源。
9. **这不是安全沙箱**：容器会执行本仓库与对端插件源码，且能读到只读挂载进来的**真实凭据**
   （整份 `$DSH_HOME` 以只读方式挂进来）。它解决的是"环境污染与版本矩阵"，**不是**
   "不可信代码隔离"——请只在你愿意在容器里运行这些代码的机器上跑。
10. **`DOCKER_CONFIG`**：宿主侧 `docker compose` 调用需要用仓库内可写目录
    `export DOCKER_CONFIG="$PWD/.docker-config"`（某些沙箱下 `/root/.docker` 只读）；
    `matrix.mjs` 会自动设置。
11. **范围限制**：不做浏览器 E2E（真实 GUI 渲染），也不做真实上游（NewAPI 等）调用；
    L2 用 curl 探针模拟浏览器会话。本环境不改 CI、不占用宿主 3080 端口。
