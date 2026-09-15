#!/usr/bin/env bash
# L2 探针：真实 dsh web 启动 + 浏览器会话 + 首页 + boot 图 + RPC 通道 + 日志卫生。
# 认证流程与两个仓库 CI 的 boot job 一致：一次性 token 换会话 cookie（0.1.5 起强制）。
set -euo pipefail

PORT="${PORT:-3080}"
LOG="${LOG:-/work/dsh-web.log}"
COOKIE="${COOKIE:-/work/cookies.txt}"
BODY=/work/probe-body.txt
# 组合契约的唯一真源（同一份也供人阅读）：插件名、客户端 bundle 名、RPC 路径与期望结果。
# 组合格的断言全部从这里读，脚本里不再保留第二份硬编码副本——对端改名时会先红在
# "契约不一致"，而不是含糊地红在"路由未注册"。
EXPECT="${EXPECT:-/usr/local/bin/probes/expectations.companion.json}"
export EXPECT
TAG="[testbed][${DSH_VERSION}][${GRID_LABEL}][l2]"

say() { printf '%s %s\n' "$TAG" "$1"; }
die() { printf '%s [fail] %s\n' "$TAG" "$1"; [ -f "$LOG" ] && tail -40 "$LOG"; exit 1; }

# expect <node 表达式> <出错说明>：直查契约 JSON，不落中间变量。
# 表达式里用 E 指代已解析的契约，例如 `E.companion`、`E.rpcProbes[1].method`。
expect() {
	node -e '
		const fs = require("node:fs")
		const E = JSON.parse(fs.readFileSync(process.env.EXPECT, "utf8"))
		const v = eval(process.argv[1])
		process.stdout.write(v === undefined || v === null ? "" : String(v))
	' "$1" || die "读取组合契约失败（$EXPECT）：$2"
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
	# 先做契约一致性自检：环境里的 COMPANION 与契约 JSON 对不上时立刻报出来，
	# 而不是等到后面以"路由未注册"的形式间接暴露。
	companion_contract="$(expect 'E.companion' '缺少 companion 字段')"
	self_contract="$(expect 'E.self' '缺少 self 字段')"
	[ -n "$companion_contract" ] || die "组合契约缺少 companion 字段：$EXPECT"
	[ "$companion_contract" = "$COMPANION" ] \
		|| die "契约不一致：COMPANION=$COMPANION 但 $EXPECT 的 companion=$companion_contract"

	for bundle in $(expect 'E.clientBundles.join(" ")' 'clientBundles 不是非空数组'); do
		grep -q "$bundle" /work/index.html \
			|| die "组合格缺少客户端 bundle 引用：$bundle（未出现在 /work/index.html；契约 $EXPECT，self=${self_contract:-?} companion=${companion_contract:-?}）"
	done
	say "组合格：两个客户端 bundle 均在 boot 图中（契约驱动：${self_contract} + ${companion_contract}）"

	# 两个 RPC 通道：路径、方法、rpcId 与期望语义全部来自契约；分别记录 HTTP 码与响应体。
	rpc_codes=()
	rpc_bodies=()
	for i in 0 1; do
		path="$(expect "E.rpcProbes[$i].path" "rpcProbes[$i].path 缺失")"
		method="$(expect "E.rpcProbes[$i].method" "rpcProbes[$i].method 缺失")"
		rpc_id="$(expect "E.rpcProbes[$i].rpcId" "rpcProbes[$i].rpcId 缺失")"
		code="$(curl -s -b "$COOKIE" -o "/work/rpc-$i.json" -w '%{http_code}' -X POST \
			"http://127.0.0.1:${PORT}${path}" -H 'content-type: application/json' \
			-d "{\"type\":\"client-request\",\"rpcId\":\"$rpc_id\",\"method\":\"$method\",\"payload\":{}}" || true)"
		[ "$code" = "200" ] \
			|| die "组合格：${path} 非 200（HTTP $code；405 = SPA 回退，说明该通道路由未注册，检查契约 $EXPECT）"
		rpc_codes+=("$code")
		rpc_bodies+=("/work/rpc-$i.json")
	done

	node -e '
		const fs = require("node:fs")
		const E = JSON.parse(fs.readFileSync(process.env.EXPECT, "utf8"))
		const bodies = process.argv.slice(1).map((p) => JSON.parse(fs.readFileSync(p, "utf8")))
		if (bodies.length !== E.rpcProbes.length) throw new Error(`契约声明 ${E.rpcProbes.length} 条通道，实际收到 ${bodies.length} 条响应`)
		bodies.forEach((body, i) => {
			const p = E.rpcProbes[i]
			if (body.rpcId !== p.rpcId) throw new Error(`${p.path} 返回了别的响应（串扰）：期望 rpcId=${p.rpcId}，实际 ${JSON.stringify(body)}`)
			const ok = body.result?.ok
			if (ok !== p.expectOk) throw new Error(`${p.path} 业务语义不符：期望 result.ok=${p.expectOk}，实际 ${JSON.stringify(body)}`)
			const needle = p.expectErrorIncludes
			if (needle) {
				const message = String(body.result?.error?.message ?? "")
				if (!message.includes(needle)) throw new Error(`${p.path} 错误语义不符：期望 message 含 ${JSON.stringify(needle)}，实际 ${JSON.stringify(message)}`)
			}
		})
		console.log("通道校验通过：" + bodies.map((b, i) => `${E.rpcProbes[i].path} ok=${b.result?.ok}`).join("；"))
	' "${rpc_bodies[@]}" || die "组合格：通道响应不符合契约（串扰或业务语义）"
	say "组合格：两个 RPC 通道各自应答，无覆盖（HTTP ${rpc_codes[0]}/${rpc_codes[1]}，语义与 $EXPECT 一致）"
fi

# 5) 日志卫生：两次真实事故的形态
if grep -qE 'plugin tree failed to load|without inject' "$LOG"; then
	die "日志出现插件加载失败特征"
fi
say "日志卫生通过"
say "L2 全部通过"
