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
# die 走 stdout：boot-probe 里调用点都在顶层，stdout 就是终端。
die() { printf '%s [fail] %s\n' "$TAG" "$1"; [ -f "$LOG" ] && tail -40 "$LOG"; exit 1; }
# fail：只报错、不退出，留给调用点决定——**这是命令替换里的唯一安全写法**。
# `die` 写在 `$( )` 里只会退出子 shell，而且它打印到 stdout 的那行会被
# 捕获进变量（实测：`x="$(f)"` 时 f 里的 die 文案进了 $x，终端上什么都看不到），
# 于是"契约坏了"表现为 rc=1 但没有任何 [fail] 行。所以命令替换内一律写 stderr。
fail() { printf '%s [fail] %s\n' "$TAG" "$1" >&2; }

# expect <node 表达式>：直查契约 JSON 并打印取值。表达式里用 E 指代已解析的契约。
# 解析失败 / 字段缺失或为 null 时**报错到 stderr 并返回非零**（不打印任何 stdout），
# 保证任何 `x="$(expect …)"` 的失败都可见；取值是否存在由 expect_required 把关。
expect() {
	local v
	v="$(node -e '
		const fs = require("node:fs")
		const E = JSON.parse(fs.readFileSync(process.env.EXPECT, "utf8"))
		const v = eval(process.argv[1])
		process.stdout.write(v === undefined || v === null ? "" : String(v))
	' "$1")" || { fail "读取组合契约失败（$EXPECT）：$1"; return 1; }
	[ -n "$v" ] || { fail "组合契约缺少字段（值为 null/undefined）：$1（契约 $EXPECT）"; return 1; }
	printf '%s' "$v"
}

# expect_required <node 表达式> <出错说明>：**只能在函数体内、或在 `… || die` 保护下使用**，
# 因为它用 die 直报终端（这正是要修复的行为）。取值缺失即中止本函数（由调用点决定是否 die）。
expect_required() {
	local v
	v="$(expect "$1")" || return 1
	[ -n "$v" ] || { fail "$2"; return 1; }
	printf '%s' "$v"
}

# validate_contract：先校验契约文件本身完整，再跑断言。
# 放在最前面是**故意的**：脚本一旦 `dsh web` 起来就会把日志导进 $LOG，若此时才发现契约
# 有问题，die 会连带打印一堆无关的 web 启动日志，掩盖真正的原因。日志卫生断言因此在下面
# 显式注释为"只覆盖 web 启动后"。
validate_contract() {
	node -e '
		const fs = require("node:fs")
		const raw = fs.readFileSync(process.env.EXPECT, "utf8")
		let E
		try { E = JSON.parse(raw) } catch (error) { throw new Error("契约不是合法 JSON：" + error.message) }
		if (typeof E.self !== "string" || !E.self) throw new Error("契约缺少 self")
		if (typeof E.companion !== "string" || !E.companion) throw new Error("契约缺少 companion")
		if (!Array.isArray(E.clientBundles) || E.clientBundles.length < 1 || E.clientBundles.some((b) => typeof b !== "string" || !b)) throw new Error("契约的 clientBundles 必须是非空字符串数组")
		if (!Array.isArray(E.rpcProbes) || E.rpcProbes.length < 2) throw new Error("契约的 rpcProbes 至少要有自身与对端两条")
		E.rpcProbes.forEach((p, i) => {
			for (const key of ["path", "method", "rpcId"]) if (typeof p[key] !== "string" || !p[key]) throw new Error(`契约的 rpcProbes[${i}].${key} 缺失`)
			if (typeof p.expectOk !== "boolean") throw new Error(`契约的 rpcProbes[${i}].expectOk 必须是布尔`)
		})
		console.log(`契约完整：self=${E.self} companion=${E.companion} bundles=${E.clientBundles.length} 条 rpcProbes=${E.rpcProbes.length} 条`)
	' || die "组合契约不可用（$EXPECT）"
}

# rpc_probe <契约里的通道下标>：按契约发一次 RPC，把 HTTP 码写进 RPC_CODE、响应体路径写进 RPC_BODY。
# 期望值一律回读契约（$EXPECT 已 export，子 node 进程可见），调用点不再各自硬编码路径与语义。
rpc_probe() {
	local i="$1"
	local path method rpc_id
	path="$(expect_required "E.rpcProbes[$i].path" "契约的 rpcProbes[$i].path 缺失或为空（契约 $EXPECT）")" || return 1
	method="$(expect_required "E.rpcProbes[$i].method" "契约的 rpcProbes[$i].method 缺失或为空（契约 $EXPECT）")" || return 1
	rpc_id="$(expect_required "E.rpcProbes[$i].rpcId" "契约的 rpcProbes[$i].rpcId 缺失或为空（契约 $EXPECT）")" || return 1
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

validate_contract || exit 1

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
self_name="$(expect_required 'E.self' "组合契约缺少 self 字段：$EXPECT")" || exit 1
self_bundle="$(expect_required 'E.clientBundles[0]' "组合契约缺少 clientBundles[0]：$EXPECT")" || exit 1
grep -q "$self_bundle" /work/index.html \
	|| die "boot 图中缺少 ${self_bundle} 引用（契约 $EXPECT，self=${self_name}）"
say "boot 图包含客户端 bundle（${self_bundle}）"

# 3) RPC 通道真实应答（unknown-endpoint 探针，避免依赖第三方目录下载）。
#    路径、方法、rpcId 与 unknown-endpoint 语义全部来自契约的 rpcProbes[0]。
rpc_probe 0 || exit 1
[ "$RPC_CODE" = "200" ] \
	|| die "RPC 通道 /llm-newapi 非 200（HTTP $RPC_CODE；405 = SPA 回退，说明通道未注册）"
rpc_assert 0
say "RPC 通道应答正确（HTTP 200 + unknown-endpoint 语义）"

# 4) 组合格：两个客户端 bundle 必须同时进入 boot 图，两个 RPC 通道都必须应答。
if [ -n "${COMPANION:-}" ]; then
	# 先做契约一致性自检：环境里的 COMPANION 与契约 JSON 对不上时立刻报出来，
	# 而不是等到后面以"路由未注册"的形式间接暴露。
	companion_contract="$(expect_required 'E.companion' "组合契约缺少 companion 字段：$EXPECT")" || exit 1
	[ "$companion_contract" = "$COMPANION" ] \
		|| die "契约不一致：COMPANION=$COMPANION 但 $EXPECT 的 companion=$companion_contract"

	# 覆盖校验（防静默退化）：契约必须**真的把两个名字都列进 clientBundles**。
	# 否则 `clientBundles` 少写一项时下面的循环会少跑一轮甚至 0 轮——对端 bundle
	# 根本没被 grep 过，脚本却照样报成功，断言静默退化成假绿。
	node -e '
		const E = JSON.parse(require("node:fs").readFileSync(process.env.EXPECT, "utf8"))
		const required = [E.self + "/client.js", E.companion + "/client.js"]
		const missing = required.filter((b) => !E.clientBundles.includes(b))
		if (missing.length) throw new Error("契约不完整：clientBundles 未覆盖 " + missing.join("、") + "（实际 " + JSON.stringify(E.clientBundles) + "）")
	' || die "契约不完整：clientBundles 未同时覆盖 ${self_name}/client.js 与 ${companion_contract}/client.js（契约 $EXPECT）"
	bundle_count="$(expect_required 'E.clientBundles.length')" || exit 1
	[ "$bundle_count" -ge 1 ] || die "契约不完整：clientBundles 为空（$EXPECT）"

	while IFS= read -r bundle; do
		[ -n "$bundle" ] || continue
		grep -q "$bundle" /work/index.html \
			|| die "组合格缺少客户端 bundle 引用：$bundle（未出现在 /work/index.html；契约 $EXPECT，self=${self_name} companion=${companion_contract}）"
	done < <(expect 'E.clientBundles.join("\n")')
	# 文案按**实际消费的条目**生成：循环跑了 N 次就报 N 条，不再硬说"两个"。
	say "组合格：客户端 bundle 断言覆盖 ${bundle_count} 项且全部命中（${self_name}/client.js + ${companion_contract}/client.js，契约驱动）"

	# 两条通道都按契约发一次；契约的 rpcProbes[0] 是自身、[1] 是对端，
	# 任一条被另一条覆盖都会在 rpc_assert 的 rpcId 回显检查上红。
	rpc_probe 1 || exit 1
	[ "$RPC_CODE" = "200" ] \
		|| die "组合格：$(expect "E.rpcProbes[1].path") 非 200（HTTP $RPC_CODE；405 = SPA 回退，说明该通道路由未注册，检查契约 $EXPECT）"

	rpc_codes=()
	for i in 0 1; do
		rpc_codes+=("$(expect "E.rpcProbes[$i].expectOk")")
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
