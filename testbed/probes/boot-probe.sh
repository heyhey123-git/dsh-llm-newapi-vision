#!/usr/bin/env bash
# L2 探针：真实 dsh web 启动 + 浏览器会话 + 首页 + boot 图 + RPC 通道 + 日志卫生。
# 认证流程与两个仓库 CI 的 boot job 一致：一次性 token 换会话 cookie（0.1.5 起强制）。
set -euo pipefail

PORT="${PORT:-3080}"
LOG="${LOG:-/work/dsh-web.log}"
COOKIE="${COOKIE:-/work/cookies.txt}"
# 组合契约的唯一真源（同一份也供人阅读）：插件名、客户端 bundle 名、RPC 路径与期望结果。
# 组合格的断言全部从这里读，脚本里不再保留第二份硬编码副本——对端改名时会先红在
# "契约不一致"，而不是含糊地红在"路由未注册"。
EXPECT="${EXPECT:-/usr/local/bin/probes/expectations.companion.json}"
export EXPECT
TAG="[testbed][${DSH_VERSION}][${GRID_LABEL}][l2]"

say() { printf '%s %s\n' "$TAG" "$1"; }
die() { printf '%s [fail] %s\n' "$TAG" "$1"; [ -f "$LOG" ] && tail -40 "$LOG"; exit 1; }

# expect <node 表达式> <出错说明>：直查契约 JSON，不落中间变量。
# 表达式里用 E 指代已解析的契约，例如 `E.self`、`E.rpcProbes[1].method`。
expect() {
	node -e '
		const fs = require("node:fs")
		const E = JSON.parse(fs.readFileSync(process.env.EXPECT, "utf8"))
		const v = eval(process.argv[1])
		process.stdout.write(v === undefined || v === null ? "" : String(v))
	' "$1" || die "读取组合契约失败（$EXPECT）：$2"
}

# rpc_probe <契约里的通道下标>：按契约发一次 RPC，把 HTTP 码写进 RPC_CODE、响应体路径写进 RPC_BODY。
# 期望值一律回读契约（$EXPECT 已 export，子 node 进程可见），调用点不再各自硬编码路径与语义。
rpc_probe() {
	local i="$1"
	local path method rpc_id
	path="$(expect "E.rpcProbes[$i].path" "rpcProbes[$i].path 缺失")"
	method="$(expect "E.rpcProbes[$i].method" "rpcProbes[$i].method 缺失")"
	rpc_id="$(expect "E.rpcProbes[$i].rpcId" "rpcProbes[$i].rpcId 缺失")"
	RPC_BODY="/work/rpc-${i}.json"
	RPC_CODE="$(curl -s -b "$COOKIE" -o "$RPC_BODY" -w '%{http_code}' -X POST \
		"http://127.0.0.1:${PORT}${path}" -H 'content-type: application/json' \
		-d "{\"type\":\"client-request\",\"rpcId\":\"$rpc_id\",\"method\":\"$method\",\"payload\":{}}" || true)"
}

# rpc_assert <契约里的通道下标>：校验响应形状、rpcId 回显、业务成功语义与错误文案。
# expectOk / expectErrorIncludes 让 `expect:"ok"` 那类声明真正参与断言，而不是只写在 JSON 里。
rpc_assert() {
	local i="$1"
	node -e '
		const fs = require("node:fs")
		const E = JSON.parse(fs.readFileSync(process.env.EXPECT, "utf8"))
		const p = E.rpcProbes[Number(process.argv[1])]
		const body = JSON.parse(fs.readFileSync(process.argv[2], "utf8"))
		if (body.type !== "server-response") throw new Error(`${p.path} 响应形状不符：` + JSON.stringify(body))
		if (body.rpcId !== p.rpcId) throw new Error(`${p.path} 返回了别的响应（串扰）：期望 rpcId=${p.rpcId}，实际 ${JSON.stringify(body)}`)
		if (body.result?.ok !== p.expectOk) throw new Error(`${p.path} 业务语义不符：期望 result.ok=${p.expectOk}，实际 ${JSON.stringify(body.result)}`)
		const needle = p.expectErrorIncludes
		if (needle) {
			const message = String(body.result?.error?.message ?? "")
			if (!message.includes(needle)) throw new Error(`${p.path} 错误语义不符：期望 message 含 ${JSON.stringify(needle)}，实际 ${JSON.stringify(message)}`)
		}
	' "$i" "$RPC_BODY" || die "RPC 响应不符合契约（$EXPECT）"
}

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

# 2) 浏览器半边进入 boot 图（插件名与 bundle 名取自契约）
self_name="$(expect 'E.self' '缺少 self 字段')"
[ -n "$self_name" ] || die "组合契约缺少 self 字段：$EXPECT"
self_bundle="$(expect 'E.clientBundles[0]' '缺少 clientBundles[0]')"
[ -n "$self_bundle" ] || die "组合契约缺少 clientBundles[0]：$EXPECT"
grep -q "$self_bundle" /work/index.html \
	|| die "boot 图中缺少 ${self_bundle} 引用（契约 $EXPECT，self=${self_name}）"
say "boot 图包含客户端 bundle（${self_bundle}）"

# 3) RPC 通道真实应答（unknown-endpoint 探针，避免依赖第三方目录下载）。
#    路径、方法、rpcId 与 unknown-endpoint 语义全部来自契约的 rpcProbes[0]。
rpc_probe 0
[ "$RPC_CODE" = "200" ] \
	|| die "RPC 通道 /llm-newapi 非 200（HTTP $RPC_CODE；405 = SPA 回退，说明通道未注册）"
rpc_assert 0
say "RPC 通道应答正确（HTTP 200 + unknown-endpoint 语义）"

# 4) 组合格：两个客户端 bundle 必须同时进入 boot 图，两个 RPC 通道都必须应答。
if [ -n "${COMPANION:-}" ]; then
	# 先做契约一致性自检：环境里的 COMPANION 与契约 JSON 对不上时立刻报出来，
	# 而不是等到后面以"路由未注册"的形式间接暴露。
	companion_contract="$(expect 'E.companion' '缺少 companion 字段')"
	[ -n "$companion_contract" ] || die "组合契约缺少 companion 字段：$EXPECT"
	[ "$companion_contract" = "$COMPANION" ] \
		|| die "契约不一致：COMPANION=$COMPANION 但 $EXPECT 的 companion=$companion_contract"

	for bundle in $(expect 'E.clientBundles.join(" ")' 'clientBundles 不是非空数组'); do
		grep -q "$bundle" /work/index.html \
			|| die "组合格缺少客户端 bundle 引用：$bundle（未出现在 /work/index.html；契约 $EXPECT，self=${self_name} companion=${companion_contract}）"
	done
	say "组合格：两个客户端 bundle 均在 boot 图中（契约驱动：${self_name} + ${companion_contract}）"

	# 两条通道都按契约发一次；rpcId 与期望语义分别是 combo-self / combo-peer，
	# 任一条被另一条覆盖都会在 rpc_assert 的 rpcId 回显检查上红。
	rpc_probe 1
	[ "$RPC_CODE" = "200" ] \
		|| die "组合格：$(expect 'E.rpcProbes[1].path' 'rpcProbes[1].path 缺失') 非 200（HTTP $RPC_CODE；405 = SPA 回退，说明该通道路由未注册，检查契约 $EXPECT）"

	rpc_codes=()
	for i in 0 1; do
		rpc_codes+=("$(expect "E.rpcProbes[$i].expectOk" "rpcProbes[$i].expectOk 缺失")")
	done
	rpc_assert 1
	say "组合格：两个 RPC 通道各自应答，无覆盖（expectOk=${rpc_codes[0]}/${rpc_codes[1]}，语义与 $EXPECT 一致）"
fi

# 5) 日志卫生：两次真实事故的形态
if grep -qE 'plugin tree failed to load|without inject' "$LOG"; then
	die "日志出现插件加载失败特征"
fi
say "日志卫生通过"
say "L2 全部通过"
