#!/usr/bin/env bash
# L2 探针：真实 dsh web 启动 + 浏览器会话 + 首页 + boot 图 + RPC 通道 + 日志卫生。
# 认证流程与两个仓库 CI 的 boot job 一致：一次性 token 换会话 cookie（0.1.5 起强制）。
set -euo pipefail

PORT="${PORT:-3080}"
LOG="${LOG:-/work/dsh-web.log}"
COOKIE="${COOKIE:-/work/cookies.txt}"
BODY=/work/probe-body.txt
TAG="[testbed][${DSH_VERSION}][${GRID_LABEL}][l2]"

say() { printf '%s %s\n' "$TAG" "$1"; }
die() { printf '%s [fail] %s\n' "$TAG" "$1"; [ -f "$LOG" ] && tail -40 "$LOG"; exit 1; }

rm -f "$COOKIE"
dsh web > "$LOG" 2>&1 &
WEB_PID=$!
trap 'kill "$WEB_PID" 2>/dev/null || true' EXIT

# 1) 等 token → 会话 cookie
code=""
for _ in $(seq 1 90); do
	kill -0 "$WEB_PID" 2>/dev/null || die "dsh web 启动过程中退出"
	token="$(grep -o 'token=[A-Za-z0-9_-]*' "$LOG" 2>/dev/null | head -1 | cut -d= -f2 || true)"
	if [ -n "$token" ]; then
		curl -s -c "$COOKIE" -b "$COOKIE" -o /dev/null "http://127.0.0.1:${PORT}/?token=${token}" || true
		if [ -s "$COOKIE" ]; then
			code="$(curl -s -b "$COOKIE" -o /work/index.html -w '%{http_code}' "http://127.0.0.1:${PORT}/" || true)"
			[ "$code" = "200" ] && break
		fi
	fi
	sleep 1
done
[ "$code" = "200" ] || die "首页未就绪（最后 HTTP ${code:-none}）"
say "认证与会话建立完成，首页 200"

# 2) 浏览器半边进入 boot 图
grep -q 'dsh-llm-newapi/client.js' /work/index.html \
	|| die "boot 图中缺少 dsh-llm-newapi/client.js 引用"
say "boot 图包含客户端 bundle"

# 3) RPC 通道真实应答（unknown-endpoint 探针，避免依赖第三方目录下载）
rpc_code="$(curl -s -b "$COOKIE" -o "$BODY" -w '%{http_code}' -X POST \
	"http://127.0.0.1:${PORT}/llm-newapi/ci-probe" \
	-H 'content-type: application/json' \
	-d '{"type":"client-request","rpcId":"testbed-probe","method":"ci-probe","payload":{}}' || true)"
[ "$rpc_code" = "200" ] || die "RPC 通道 /llm-newapi 非 200（HTTP $rpc_code；405 = SPA 回退，说明通道未注册）"
node -e '
	const fs = require("node:fs")
	const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
	if (body.type !== "server-response" || body.rpcId !== "testbed-probe") throw new Error("响应形状不符：" + JSON.stringify(body))
	if (body.result?.ok !== false || !String(body.result?.error?.message ?? "").includes("unknown endpoint ci-probe")) throw new Error("unknown-endpoint 语义不符：" + JSON.stringify(body))
' "$BODY" || die "RPC 响应校验失败"
say "RPC 通道应答正确（HTTP 200 + unknown-endpoint 语义）"

# 4) 组合格：两个客户端 bundle 必须同时进入 boot 图，两个 RPC 通道都必须应答。
if [ -n "${COMPANION:-}" ]; then
	grep -q "dsh-llm-newapi/client.js" /work/index.html || die "组合格缺少 dsh-llm-newapi 客户端 bundle"
	grep -q "${COMPANION}/client.js" /work/index.html || die "组合格缺少 ${COMPANION} 客户端 bundle"
	say "组合格：两个客户端 bundle 均在 boot 图中"

	c1="$(curl -s -b "$COOKIE" -o /work/c1.json -w '%{http_code}' -X POST \
		"http://127.0.0.1:${PORT}/llm-newapi/ci-probe" -H 'content-type: application/json' \
		-d '{"type":"client-request","rpcId":"combo-self","method":"ci-probe","payload":{}}' || true)"
	[ "$c1" = "200" ] || die "组合格：/llm-newapi 通道非 200（HTTP $c1）"

	c2="$(curl -s -b "$COOKIE" -o /work/c2.json -w '%{http_code}' -X POST \
		"http://127.0.0.1:${PORT}/api/dsh-quota-panel/specs" -H 'content-type: application/json' \
		-d '{"type":"client-request","rpcId":"combo-peer","method":"dsh-quota-panel/specs","payload":{}}' || true)"
	[ "$c2" = "200" ] || die "组合格：/api/dsh-quota-panel 通道非 200（HTTP $c2；405 = SPA 回退，说明对端路由未注册）"
	node -e '
		const fs = require("node:fs")
		const self = JSON.parse(fs.readFileSync("/work/c1.json", "utf8"))
		const peer = JSON.parse(fs.readFileSync("/work/c2.json", "utf8"))
		if (self.rpcId !== "combo-self") throw new Error("自身通道返回了别的响应：" + JSON.stringify(self))
		if (peer.rpcId !== "combo-peer") throw new Error("对端通道返回了别的响应：" + JSON.stringify(peer))
	' || die "组合格：通道响应串扰"
	say "组合格：两个 RPC 通道各自应答，无覆盖"
fi

# 5) 日志卫生：两次真实事故的形态
if grep -qE 'plugin tree failed to load|without inject' "$LOG"; then
	die "日志出现插件加载失败特征"
fi
say "日志卫生通过"
say "L2 全部通过"
