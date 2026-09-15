#!/usr/bin/env bash
# testbed entrypoint：在容器内构造隔离的 DSH_HOME，依次跑 L1（源码层）与 L2（真实宿主层）。
# 宿主侧只读挂载：/host-dsh-home（整份 $DSH_HOME）、/plugin-src（本仓库源码）、/companion-src（可选对端）。
set -euo pipefail

DSH_VERSION="${DSH_VERSION:?DSH_VERSION is required}"
GRID_LABEL="${GRID_LABEL:-local}"
PROFILE_MODE="${PROFILE_MODE:-minimal}"
COMPANION="${COMPANION:-}"
STEPS="${STEPS:-all}"
TARBALL=""

STATE=/work/dsh-home
PREFIX="[testbed][${DSH_VERSION}][${GRID_LABEL}]"

log() { printf '%s[%s] %s\n' "$PREFIX" "$1" "$2"; }
die() { log fail "$1"; exit 1; }

# want <step>：STEPS 为 all 或显式包含该步时返回 0
want() {
	case ",${STEPS}," in
		*,all,* | *,"$1",*) return 0 ;;
		*) return 1 ;;
	esac
}

check_image() {
	log image "node $(node -v) / npm $(npm -v)"
	log image "pnpm $(pnpm --version)"
	log image "dsh $(dsh --version)"
}

# 只读自检：打印镜像内本脚本与 probes/ 全部文件的 sha256（`<sha256>  <路径>`，按路径排序），
# 以及构建配方指纹（TESTBED_BUILD_STAMP，见 Dockerfile），供宿主侧（matrix.mjs）确认
# "这一格跑的确实是当前源码"，然后以 0 退出。
# 背景：`docker compose run --build` 在 COPY 层判定为缓存命中时会**静默复用陈旧镜像**
# （Task 7 实测：镜像内 boot-probe.sh 137 行 vs 宿主 191 行，矩阵整格假绿）。因此这里
# 必须只读——不碰 $DSH_HOME、不写任何文件、不依赖 DSH_VERSION/GRID_LABEL 等运行期变量。
# 路径打印**镜像内绝对路径**：宿主侧按"镜像路径 ← 宿主 testbed/ 下相对路径"的固定映射比对，
# 两侧路径集合也必须逐一对应（多一个/少一个文件同样算不一致）。
source_hash() {
	local script="${BASH_SOURCE[0]}"
	local probes_dir
	probes_dir="$(cd "$(dirname "$script")/probes" && pwd)"
	{
		sha256sum "$script"
		if [ -d "$probes_dir" ]; then
			find "$probes_dir" -type f | LC_ALL=C sort | xargs -r sha256sum
		fi
	} | LC_ALL=C sort -k2
	# 配方指纹单独一行、不参与上面的路径比对（它不是文件）；缺失时打印空值，
	# 让宿主侧能明确区分"镜像没带指纹"与"指纹不一致"。
	printf 'TESTBED_BUILD_STAMP=%s\n' "$(cat /etc/testbed-build-stamp 2>/dev/null | cut -d= -f2)"
}

assert_readonly() {
	local m
	for m in /host-dsh-home /plugin-src; do
		[ -d "$m" ] || die "缺少只读挂载：$m"
		if touch "$m/.testbed-write-probe" 2>/dev/null; then
			rm -f "$m/.testbed-write-probe"
			die "$m 可写——拒绝运行（会污染宿主）。请确认 compose 使用 :ro 挂载"
		fi
	done
	log assert "宿主挂载确认为只读"
}

# 只复制配置类文件；会话/浏览器/账本数据一律不进容器。
seed_home() {
	rm -rf "$STATE"
	mkdir -p "$STATE"
	local f d
	for f in settings.yaml .credentials.yaml pet.json; do
		[ -e "/host-dsh-home/$f" ] && cp -a "/host-dsh-home/$f" "$STATE/$f"
	done
	for d in skills storages; do
		[ -d "/host-dsh-home/$d" ] && cp -a "/host-dsh-home/$d" "$STATE/$d"
	done
	if [ -e "$STATE/.credentials.yaml" ]; then
		# credentials-local 拒绝 owner 之外可读的文件（默认 umask 给 644），
		# 权限过宽会让整棵插件树加载失败——CI 的 boot job 里记着这个坑。
		chmod 600 "$STATE/.credentials.yaml"
		log seed "凭据已播种（mode 600）"
	fi
	log seed "DSH_HOME 就绪：$STATE"
}

# 复制源码时必须排除 node_modules（122 MB）与 .tmp-*（本仓库的缓存/试验目录）；
# 刻意不复制 .git：因此产物新鲜度检查不能用 git diff，改用内容哈希。
stage_sources() {
	rm -rf /work/plugin
	mkdir -p /work/plugin
	tar -C /plugin-src \
		--exclude=./node_modules --exclude=./.git --exclude='./.tmp-*' \
		-cf - . | tar -C /work/plugin -xf -
	[ -f /work/plugin/package.json ] || die "源码暂存失败：/work/plugin/package.json 不存在"
	log stage "源码已暂存：/work/plugin"
	if [ -n "$COMPANION" ]; then
		[ -f /companion-src/package.json ] || die "COMPANION=$COMPANION 但 /companion-src 不是插件源码（检查 COMPANION_HOST_DIR）"
		[ -f /companion-src/node_modules/.bin/tsc ] \
			|| die "COMPANION=$COMPANION 但没有 node_modules（对端的 prepack 会构建，需要本地 devDependencies）——先在 $COMPANION 里 npm install"
		rm -rf /work/companion
		mkdir -p /work/companion
		# 对端不带 committed 产物约定：它的 prepack 就是 `npm run build`，因此 node_modules
		# 是打包的硬依赖（缺它 npm pack 直接失败）。本仓库刻意排除 node_modules 是因为它自己
		# 的 L1 会 `npm ci` 重建；对端没有 L1，所以这里必须带上（142MB 左右，只是本地拷贝）。
		tar -C /companion-src \
			--exclude=./.git --exclude='./.tmp-*' \
			-cf - . | tar -C /work/companion -xf -
		log stage "对端源码已暂存：/work/companion（$COMPANION）"
	fi
}

lib_digest() {
	find lib -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1
}

run_l1() {
	cd /work/plugin
	log l1 "npm ci"
	npm ci --no-audit --no-fund
	log l1 "typecheck（host + client 两套 tsconfig）"
	npm run typecheck
	local before after
	before="$(lib_digest)"
	log l1 "build"
	npm run build
	after="$(lib_digest)"
	if [ "$before" != "$after" ]; then
		die "lib/ 与全新构建不一致：产物过期，请在本地 npm run build 后提交重建的 lib/（等价于 CI 的 committed artifacts are current）"
	fi
	log l1 "产物新鲜度：lib/ 内容哈希与全新构建一致"
	log l1 "test:client（vitest）"
	npm run test:client
	log l1 "test:host（host-compat，对齐容器内实际安装的 dsh-llm）"
	npm run test:host
	log l1 "smoke（真实 Cordis 组合）"
	node test/smoke.mjs
	log l1 "全部通过"
}

pack_plugin() {
	cd /work/plugin
	rm -rf /work/dist
	mkdir -p /work/dist
	npm pack --pack-destination /work/dist >/dev/null
	TARBALL="$(ls /work/dist/*.tgz | head -1)"
	[ -n "$TARBALL" ] || die "npm pack 未产出 tarball"
	log pack "已打包：$(basename "$TARBALL")"
	export TARBALL
}

# 对端（COMPANION）的 npm pack。对端仓库的 prepack 会自己构建，因此这里不跑它的 L1。
# 打包结果用 `--json` 取，而不是 `ls -t | head -1`：后者只看 mtime，一旦选错文件，
# bundles 行会写成一个并不存在的包名——症状是后面对端 bundle 缺席的假红。
# 注意 `--json` 的报告会被 prepack 的 stdout（tsc / 构建脚本的 console.log）污染，
# 所以按"第一个 [ 到最后一个 ]" 取 JSON 区间，而不是整文件 JSON.parse。
# 再从 tarball 里读出真实包名作为 bundles 行名；与 COMPANION 不一致时直接 die，
# 避免把"契约名"与"实际包名"的差异拖到探针阶段才以别的形态暴露。
pack_companion() {
	[ -n "$COMPANION" ] || return 0
	cd /work/companion
	log pack "打包对端：$COMPANION"
	local report=/work/npm-pack-companion.json
	npm pack --pack-destination /work/dist --json > "$report" 2>/dev/null
	COMPANION_TARBALL="$(node -e '
		const fs = require("node:fs")
		const raw = fs.readFileSync(process.argv[1], "utf8")
		const start = raw.indexOf("[")
		const end = raw.lastIndexOf("]")
		if (start < 0 || end <= start) throw new Error("npm pack --json 输出里找不到 JSON 数组")
		const parsed = JSON.parse(raw.slice(start, end + 1))
		if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error("npm pack --json 应恰好报告 1 个 tarball，实际 " + (parsed && parsed.length))
		const filename = parsed[0]?.filename
		if (!filename) throw new Error("npm pack --json 未报告 filename")
		process.stdout.write(filename)
	' "$report")" || die "解析对端 npm pack 报告失败（见 $report）"
	[ -n "$COMPANION_TARBALL" ] || die "对端 npm pack 未产出 tarball（见 $report）"
	COMPANION_TARBALL="/work/dist/$(basename "$COMPANION_TARBALL")"
	[ -f "$COMPANION_TARBALL" ] || die "对端 npm pack 报告的 tarball 不存在：$COMPANION_TARBALL"
	COMPANION_PKG_NAME="$(tar -xzOf "$COMPANION_TARBALL" package/package.json | node -e '
		let s = ""
		process.stdin.on("data", (d) => { s += d })
		process.stdin.on("end", () => process.stdout.write(JSON.parse(s).name ?? ""))
	')" || die "读取对端 tarball 内 package.json 失败：$COMPANION_TARBALL"
	[ -n "$COMPANION_PKG_NAME" ] || die "无法从 tarball 读出包名：$COMPANION_TARBALL"
	[ "$COMPANION_PKG_NAME" = "$COMPANION" ] \
		|| die "对端契约名与实际包名不一致：COMPANION=$COMPANION 但 tarball 里的 name=$COMPANION_PKG_NAME"
	log pack "已打包对端：$(basename "$COMPANION_TARBALL")（包名 $COMPANION_PKG_NAME）"
	export COMPANION_TARBALL COMPANION_PKG_NAME
}

# bundles 行决定 dsh 启动时装载哪些 bundle 层。CI 里这一步是手工补写的，
# 这里同样显式写入并打印，避免"装了但没注册"的假绿。
# 包名由调用点给出（`register_bundle_rows dsh-llm-newapi`）——`dsh plugin add` 的
# reconcile 只把"本次新增的依赖"计入 bundles，对端包在安装时已是依赖，必须显式补行。
register_bundle_rows() {
	node -e '
		const fs = require("node:fs")
		const path = process.argv[1]
		const rows = process.argv.slice(2)
		const pkg = JSON.parse(fs.readFileSync(path, "utf8"))
		pkg.dsh ??= {}
		pkg.dsh.profile ??= {}
		pkg.dsh.profile.bundles ??= ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]
		for (const row of rows) if (!pkg.dsh.profile.bundles.includes(row)) pkg.dsh.profile.bundles.push(row)
		fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n")
		console.log("bundles: " + pkg.dsh.profile.bundles.join(", "))
	' "$STATE/profiles/web/package.json" "$@"
}

build_profile() {
	case "$PROFILE_MODE" in
		minimal)
			log profile "PROFILE_MODE=minimal：空 profile + 安装本仓库 tarball"
			dsh plugin --profile web add "$TARBALL"
			;;
		preserve)
			log profile "PROFILE_MODE=preserve：先还原宿主 profile 的 bundle 行"
			local host_manifest=/host-dsh-home/profiles/web/package.json
			[ -f "$host_manifest" ] || die "preserve 需要宿主 profile：$host_manifest 不存在"
			local rows
			rows="$(node /usr/local/bin/probes/preserve-seed.mjs "$host_manifest" || true)"
			if [ -n "$rows" ]; then
				while IFS= read -r row; do
					[ -n "$row" ] || continue
					log profile "还原第三方行：$row"
					dsh plugin --profile web add "$row" || log profile "警告：还原 $row 失败（依赖网络或上游包）"
				done <<< "$rows"
			fi
			log profile "安装本仓库 tarball（覆盖发行版行）"
			dsh plugin --profile web add "$TARBALL"
			;;
		*)
			die "未知 PROFILE_MODE：$PROFILE_MODE"
			;;
	esac
	if [ -n "$COMPANION" ]; then
		[ -n "${COMPANION_TARBALL:-}" ] || die "COMPANION=$COMPANION 但缺少对端 tarball——profile 步必须在 pack 步之后（或用 STEPS=all）"
		log profile "安装对端：$COMPANION"
		dsh plugin --profile web add "$COMPANION_TARBALL"
		# bundles 行写实际包名（pack_companion 已校验它与 COMPANION 一致）。
		register_bundle_rows "${COMPANION_PKG_NAME:-$COMPANION}"
	fi
	[ -f "$STATE/profiles/web/package.json" ] || die "dsh plugin add 未生成 $STATE/profiles/web/package.json"
	register_bundle_rows dsh-llm-newapi
}

# 装配断言：组合树里必须出现本插件行。
dump_profile() {
	dsh --profile web --dump-config > /work/dump-config.txt 2>&1 \
		|| die "dsh --dump-config 失败，见 /work/dump-config.txt"
	grep -q "dsh-llm-newapi" /work/dump-config.txt \
		|| die "组合树中没有 dsh-llm-newapi 行（patch 层未生效）"
	log profile "装配断言通过：组合树包含 dsh-llm-newapi"
}

run_l2() {
	log l2 "启动真实 dsh web 并执行探针"
	bash /usr/local/bin/probes/boot-probe.sh || die "L2 探针失败，日志：/work/dsh-web.log"
}

main() {
	if [ "${1:-}" = "--check-image" ]; then
		check_image
		return 0
	fi
	if [ "${1:-}" = "--source-hash" ]; then
		source_hash
		return 0
	fi
	want assert && assert_readonly
	want seed && seed_home
	want stage && stage_sources
	want l1 && run_l1
	want pack && pack_plugin
	want pack && pack_companion
	want profile && build_profile
	want profile && dump_profile
	want l2 && run_l2
	log done "所选步骤完成：STEPS=${STEPS}"
}

main "$@"
