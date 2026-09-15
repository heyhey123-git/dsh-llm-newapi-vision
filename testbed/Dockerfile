# 刻意不写 `# syntax=docker/dockerfile:1`：本文件只用标准 Dockerfile 语法，而该行会让
# 每次 --build 都去 registry 解析一次 frontend 镜像（docker-image://docker/dockerfile:1）。
# 在本机（registry mirror 不可用）实测该解析每次固定 60.4s 超时才回落到内建 frontend，
# 是纯浪费。删掉后构建语义完全不变；若将来真的需要 BuildKit 新语法，再按需加回这一行。
# testbed 镜像：node 24（与 CI 一致）+ pnpm（dsh plugin 转发 pnpm）+ 指定版本的 dsh。
# NPM_REGISTRY 可覆盖：若 @deepseek-ai/* 命中 registry 的 stale-packument（EINTEGRITY），
# 按 CI 的经验改用镜像源，例如 https://registry.npmmirror.com。
FROM node:24-bookworm-slim

ARG DSH_VERSION=0.1.5-rc.2
ARG NPM_REGISTRY=https://registry.npmjs.org

ENV DSH_VERSION=${DSH_VERSION} \
    DSH_HOME=/work/dsh-home \
    DEBIAN_FRONTEND=noninteractive

# curl 供探针使用；ca-certificates 供 HTTPS；git 供 pnpm 解析 git 依赖。
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g --no-audit --no-fund --registry="${NPM_REGISTRY}" \
      pnpm "@deepseek-ai/dsh@${DSH_VERSION}" \
 && dsh --version \
 && pnpm --version

WORKDIR /work
COPY entrypoint.sh /usr/local/bin/testbed-entrypoint
RUN chmod +x /usr/local/bin/testbed-entrypoint

# 探针脚本：preserve 模式据此还原宿主 profile 的 bundle 行（见 entrypoint.sh）。
COPY probes /usr/local/bin/probes

ENTRYPOINT ["/usr/local/bin/testbed-entrypoint"]
