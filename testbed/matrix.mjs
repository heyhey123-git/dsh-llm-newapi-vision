// 矩阵编排：解析宿主版本集合（默认 latest + next 去重）与组合，逐格执行单 service，
// 期间对宿主 $DSH_HOME 做白名单快照，结束时打印汇总表。
// 只用 Node 内建模块。
//
// ── 为什么每格都要先核对镜像新鲜度 ──────────────────────────────────────────
// 矩阵的全部价值建立在"每一格跑的确实是当前源码"之上。而 `docker compose run --build`
// 在 COPY 层判定为缓存命中时会**静默复用陈旧镜像**：Task 7 的实现者因此得到过错误的
// "全绿"（镜像内 boot-probe.sh 137 行 vs 宿主 191 行）。所以每格开跑前有两道防线：
//   1) `docker compose build testbed`（带缓存，通常秒级）；
//   2) `docker compose run --rm testbed --source-hash`，与宿主侧逐项比对 sha256；
//      不一致 → `docker compose build --no-cache testbed` 重建后重新核对；
//      仍不一致 → 该格 FAIL（宁可真红，不要假绿），日志里同时打印两侧哈希。
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname, resolve, relative, basename, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const composeFile = join(here, 'compose.yaml')
const outDir = join(here, '.out')
const dockerConfig = join(here, '.docker-config')
mkdirSync(dockerConfig, { recursive: true })
const DEFAULT_PORT = 13080

// 镜像内路径 ←→ 宿主 testbed/ 下相对路径。两侧路径集合必须逐一对应（见 verifyImageFreshness）。
// 镜像内入口脚本被重命名为 testbed-entrypoint（见 Dockerfile），故映射名与宿主名不同。
const ENTRYPOINT_HOST_REL = 'entrypoint.sh'
const ENTRYPOINT_IMAGE_PATH = '/usr/local/bin/testbed-entrypoint'
// 构建配方指纹：Dockerfile 进不了最终镜像，无法像 probes 那样逐文件比对，于是 Dockerfile
// 在构建时把 (Dockerfile + entrypoint.sh) 的摘要写进镜像内文件 /etc/testbed-build-stamp，
// 由 entrypoint 的 --source-hash 以 `TESTBED_BUILD_STAMP=<值>` 打印出来（见 Dockerfile 的
// build-stamp 步骤），宿主侧用同一算法复算。没有它，只改 Dockerfile
// （例如换 node 基础镜像）而镜像没重建，守卫看不出来。
const BUILD_STAMP_ENV = 'TESTBED_BUILD_STAMP'
const BUILD_STAMP_SOURCES = ['Dockerfile', ENTRYPOINT_HOST_REL]
// 日志里回显子进程输出时只留尾部：失败原因通常在最后几十行。
const tail = (s, n = 2000) => {
	const t = (s || '').trim()
	return t.length > n ? '…' + t.slice(-n) : t
}

const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
	const i = argv.indexOf(name)
	return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const combos = argOf('--combos', 'self').split(',').map((s) => s.trim()).filter(Boolean)
const jobs = Number(argOf('--jobs', '1'))
// 默认开启宿主零改动快照；`--no-check-host` 关掉它（用于只想看格结果的场合），
// `--check-host` 是显式开（与 brief 的接口签名一致，即便默认已是开）。两者同给即报错，
// 避免"以为关了其实开着"这类静默歧义。
if (argv.includes('--check-host') && argv.includes('--no-check-host')) {
	console.error('[matrix] --check-host 与 --no-check-host 不能同时给出')
	process.exit(1)
}
const checkHost = !argv.includes('--no-check-host')

// 版本解析：显式给出则原样使用（并打印来源）；否则解析 dist-tags 的 latest + next 去重。
function resolveVersions() {
	const explicit = argOf('--versions', '')
	if (explicit) return { source: `显式 --versions`, versions: explicit.split(',').map((s) => s.trim()).filter(Boolean) }
	// npm 的缓存目录必须显式指到可写处：本会话下 $HOME（/root）是只读文件系统，
	// 默认的 /root/.npm 会让 npm view 以 EROFS 失败——而它失败时仍可能把 JSON 错误体写到
	// stdout，静默解析成 {}（实测：解析出空版本集合 → 0 格"全绿"退出 0，典型的假绿）。
	const cacheDir = join(outDir, 'npm-cache')
	mkdirSync(cacheDir, { recursive: true })
	const r = spawnSync('npm', ['view', '@deepseek-ai/dsh', 'dist-tags', '--json', '--cache', cacheDir], { encoding: 'utf8' })
	if (r.status !== 0) {
		console.error('[matrix] 无法解析 dist-tags，请显式给出 --versions。stderr:\n' + (r.stderr || ''))
		process.exit(1)
	}
	let tags
	try {
		tags = JSON.parse(r.stdout)
	} catch (error) {
		console.error(`[matrix] dist-tags 不是合法 JSON，请显式给出 --versions。stdout:\n${tail(r.stdout)}\n解析错误：${error.message}`)
		process.exit(1)
	}
	// `npm view <pkg> <field> --json` 对单一匹配结果**返回只有一个元素的数组**（实测），
	// 不是对象；两种形态都要认，否则 tags.latest 是 undefined，版本集合会静默变空。
	if (Array.isArray(tags)) tags = tags[0]
	if (!tags || typeof tags !== 'object' || typeof tags.latest !== 'string' || !tags.latest) {
		console.error(`[matrix] dist-tags 里没有可用的 latest（请显式给出 --versions）。解析结果：${JSON.stringify(tags)}\nstdout:\n${tail(r.stdout)}`)
		process.exit(1)
	}
	const versions = [...new Set([tags.latest, tags.next].filter(Boolean))]
	return { source: `dist-tags（latest=${tags.latest}, next=${tags.next}）`, versions }
}

// 宿主白名单快照：只看配置类文件，排除会持续变化的 sessions/storages/browser-*/change-ledger。
const HOST_TARGET = process.env.DSH_HOME_HOST || '/root/.dsh'
function hostSnapshot() {
	const entries = []
	const walk = (rel) => {
		const abs = join(HOST_TARGET, rel)
		if (!existsSync(abs)) return
		const st = statSync(abs)
		if (st.isDirectory()) {
			for (const name of readdirSync(abs).sort()) {
				if (rel === 'profiles' && name === 'node_modules') continue
				walk(join(rel, name))
			}
			return
		}
		entries.push(`${rel}\t${st.size}\t${st.mtimeMs}`)
	}
	for (const rel of ['settings.yaml', '.credentials.yaml', 'pet.json', 'skills', 'profiles']) walk(rel)
	return entries.join('\n')
}

// ── 镜像新鲜度 ──────────────────────────────────────────────────────────────

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

// 宿主侧同源文件：入口脚本 + probes/ 下全部常规文件（符号链接读其目标内容，与 Docker COPY 一致）。
function hostSources() {
	const files = new Map()
	const ep = join(here, ENTRYPOINT_HOST_REL)
	if (existsSync(ep)) files.set(ENTRYPOINT_IMAGE_PATH, { hostRel: ENTRYPOINT_HOST_REL, hash: sha256(readFileSync(ep)) })
	const probes = join(here, 'probes')
	if (existsSync(probes)) {
		const walk = (dir) => {
			for (const name of readdirSync(dir).sort()) {
				const abs = join(dir, name)
				const st = statSync(abs) // 跟随符号链接：与 COPY 的取舍一致
				if (st.isDirectory()) {
					walk(abs)
					continue
				}
				if (!st.isFile()) continue
				const hostRel = relative(here, abs).split('\\').join('/')
				files.set(`/usr/local/bin/probes/${hostRel.slice('probes/'.length)}`, {
					hostRel,
					hash: sha256(readFileSync(abs)),
				})
			}
		}
		walk(probes)
	}
	return files
}

// 宿主侧路径集合的稳定指纹：用于"同一版本 + 同一份宿主源码"只做一次 --no-cache 重建。
const hostDigest = (files) =>
	sha256([...files.entries()].map(([imagePath, v]) => `${imagePath}\t${v.hash}`).sort().join('\n'))

// 宿主侧复算构建配方指纹。算法以 Dockerfile 里那段 RUN stamp=... 为准：
//   对 BUILD_STAMP_SOURCES 里每个源文件（顺序固定），依次喂入 "<basename>\0<内容>\0"，
//   整体取 sha256。**名字必须用 basename**（Dockerfile 侧写的是 `printf 'Dockerfile\0'`，
//   不是路径）；**顺序也不能排序**（Dockerfile 侧写死了 Dockerfile → entrypoint.sh）。
const buildStamp = (paths) => {
	const h = createHash('sha256')
	for (const p of paths) h.update(Buffer.concat([Buffer.from(`${basename(p)}\0`), readFileSync(p), Buffer.from('\0')]))
	return h.digest('hex')
}
// 只算一次并缓存：hostBuildStamp 会在每格核对与失败重试里被反复调用。
// 源文件不全（例如只有 Dockerfile 的裁剪工作树）时返回 null，由 diffStamp 决定是否跳过比对。
let buildStampCache
const hostBuildStamp = () => {
	if (buildStampCache === undefined) {
		const paths = BUILD_STAMP_SOURCES.map((rel) => join(here, rel))
		buildStampCache = paths.every((p) => existsSync(p)) ? buildStamp(paths) : null
	}
	return buildStampCache
}

const composeEnv = (version, label) => ({
	...process.env,
	DSH_VERSION: version,
	GRID_LABEL: label,
	// 本会话下 /root/.docker 只读：用仓库内可写目录作为 docker CLI 状态目录
	DOCKER_CONFIG: dockerConfig,
})

function compose(args, env) {
	return spawnSync('docker', ['compose', ...args], { cwd: here, env, encoding: 'utf8' })
}

// 让 --build 真的跟着源码走：compose build 的构建参数必须与 compose.yaml 的插值一致
// （DSH_VERSION 参与镜像 tag 与 npm 安装版本，显式传能避免读宿主环境里的 .env 漂移）。
function buildImage(version, label, noCache) {
	return compose(
		['--file', composeFile, '--project-directory', here, 'build', ...(noCache ? ['--no-cache'] : []), 'testbed'],
		composeEnv(version, label),
	)
}

// 运行 --source-hash 自检：只读、不需要 $DSH_HOME、不落任何产物。
// 返回 { ok, status, stdout, stderr, files, stamp }：files 是"镜像内绝对路径 → sha256"，
// stamp 是镜像里烧入的构建配方指纹（镜像没带指纹时为 null，与"指纹为空串"区分开）。
function readImageHash(version, label) {
	const r = compose(
		['--file', composeFile, '--project-directory', here, 'run', '--rm', 'testbed', '--source-hash'],
		composeEnv(version, label),
	)
	const stdout = r.stdout || ''
	const stderr = r.stderr || ''
	const files = new Map()
	let stamp = null
	if (r.status === 0) {
		for (const raw of stdout.split('\n')) {
			const line = raw.trim()
			const line_m = new RegExp(`^${BUILD_STAMP_ENV}=(.*)$`).exec(line)
			if (line_m) {
				stamp = line_m[1]
				continue
			}
			const m = /^([0-9a-f]{64})\s+(\S.*)$/.exec(line)
			if (m) files.set(m[2], m[1])
		}
		return { ok: r.status === 0 && files.size > 0, status: r.status, stdout, stderr, files, stamp }
	}
	return { ok: false, status: r.status, stdout, stderr, files, stamp }
}

const diffSources = (hostFiles, imageFiles) => {
	const hostPaths = [...hostFiles.keys()].sort()
	const imagePaths = [...imageFiles.keys()].sort()
	const lines = []
	// 诊断信息里只回显 basename：完整镜像路径太长，且同名文件在本场景下不会重复。
	const nameOf = (p) => p.slice(p.lastIndexOf('/') + 1)
	for (const p of new Set([...hostPaths, ...imagePaths])) {
		const h = hostFiles.get(p)
		const i = imageFiles.get(p)
		if (h === undefined) lines.push(`  只存在于镜像（宿主没有，宿主侧路径集合已过期）：${p}`)
		else if (i === undefined) lines.push(`  只存在于宿主（镜像里没有）：${p}（宿主 ${h.hostRel}）`)
		else if (h.hash !== i) lines.push(`  内容不一致：${nameOf(p)}\n    宿主 ${h.hostRel}  ${h.hash}\n    镜像            ${i}`)
	}
	return { same: lines.length === 0, lines }
}

// 指纹比对：缺失（镜像早于该机制 / 构建时没跑到那一步）视作陈旧，与"不一致"分行说明，
// 便于区分"镜像没带指纹"和"指纹是另一个值"。host 侧算不出指纹（源码缺失）则跳过比对，
// 此时逐文件核对仍然生效，只是不额外设障。
function diffStamp(imageStamp) {
	const host = hostBuildStamp()
	if (host === null) return { same: true, line: '' }
	if (imageStamp === null) return { same: false, line: '  镜像里没有构建配方指纹（TESTBED_BUILD_STAMP 缺失）：该镜像早于当前 Dockerfile，判为陈旧' }
	if (imageStamp !== host) return { same: false, line: `  构建配方指纹不一致（只改 Dockerfile、没重建镜像时会这样）：\n    宿主 ${host}\n    镜像 ${imageStamp}` }
	return { same: true, line: '' }
}

function record(list, level, msg) {
	list.push({ level, msg })
	const sink = level === 'fail' ? console.error : console.log
	sink(`  [freshness] ${msg}`)
}

// 每格前置：先带缓存构建，再自检比对；不一致才 --no-cache 重建，仍不一致即判 FAIL。
function verifyImageFreshness(version, label, noCacheDone) {
	const notes = []
	record(notes, 'info', `${version}：docker compose build testbed（带缓存）`)
	const hostFiles = hostSources()
	const digest = hostDigest(hostFiles)
	const b1 = buildImage(version, label, false)
	if (b1.status !== 0) {
		record(notes, 'fail', `docker compose build testbed 失败（exit ${b1.status}）：\n${tail(b1.stdout)}\n${tail(b1.stderr)}`)
		return { ok: false, notes, digest }
	}

	const first = readImageHash(version, label)
	if (!first.ok) {
		record(
			notes,
			'fail',
			`镜像内 --source-hash 自检失败（exit ${first.status}，解析到 ${first.files.size} 条哈希）：\n${tail(first.stdout)}\n${tail(first.stderr)}`,
		)
		return { ok: false, notes, digest }
	}

	// 两道核对缺一不可：逐文件哈希覆盖 entrypoint.sh + probes/*，配方指纹覆盖"进不了镜像"的
	// Dockerfile。只看前者时，只改 Dockerfile（例如换基础镜像）而镜像没重建会漏判。
	const d1 = diffSources(hostFiles, first.files)
	const s1 = diffStamp(first.stamp)
	if (d1.same && s1.same) {
		record(notes, 'ok', `镜像与宿主源码一致（${hostFiles.size} 个文件），构建配方指纹一致`)
		return { ok: true, notes, digest }
	}

	record(notes, 'info', `镜像陈旧——${d1.lines.length + (s1.same ? 0 : 1)} 处差异：`)
	for (const line of d1.lines) record(notes, 'info', line)
	if (!s1.same) record(notes, 'info', s1.line)

	if (noCacheDone.has(`${version}@${digest}`)) {
		// 本进程内刚为"同一版本 + 同一份宿主源码"做过 --no-cache 重建，重试只会得到同一结果。
		record(notes, 'fail', `同一版本同一份源码上刚做过 --no-cache 重建仍不一致，不再重复重建；该格判 FAIL`)
		return { ok: false, notes, digest }
	}
	record(notes, 'info', `${version}：docker compose build --no-cache testbed（重建后重新自检）`)
	const b2 = buildImage(version, label, true)
	if (b2.status !== 0) {
		record(notes, 'fail', `docker compose build --no-cache testbed 失败（exit ${b2.status}）：\n${tail(b2.stdout)}\n${tail(b2.stderr)}`)
		return { ok: false, notes, digest }
	}
	noCacheDone.add(`${version}@${digest}`)

	const second = readImageHash(version, label)
	if (!second.ok) {
		record(notes, 'fail', `重建后 --source-hash 自检仍失败（exit ${second.status}）：\n${tail(second.stdout)}\n${tail(second.stderr)}`)
		return { ok: false, notes, digest }
	}
	const d2 = diffSources(hostFiles, second.files)
	const s2 = diffStamp(second.stamp)
	if (d2.same && s2.same) {
		record(notes, 'ok', `--no-cache 重建后镜像与宿主源码一致（${hostFiles.size} 个文件），构建配方指纹一致`)
		return { ok: true, notes, digest }
	}
	record(notes, 'fail', `--no-cache 重建后仍与宿主源码不一致（${d2.lines.length + (s2.same ? 0 : 1)} 处）——该格判 FAIL，拒绝以假绿继续：`)
	for (const line of d2.lines) record(notes, 'fail', line)
	if (!s2.same) record(notes, 'fail', s2.line)
	return { ok: false, notes, digest }
}

function runGrid(version, combo, port, noCacheDone) {
	const label = `${version.replace(/[^0-9A-Za-z._-]/g, '_')}-${combo}`
	const env = {
		...composeEnv(version, label),
		HOST_PORT: String(port),
	}
	if (combo === 'self+companion') {
		env.COMPANION = 'dsh-quota-panel'
		env.COMPANION_HOST_DIR = join(repoRoot, '..', 'dsh-quota-panel')
	}
	const logPath = join(outDir, `${label}.log`)
	const fresh = verifyImageFreshness(version, label, noCacheDone)
	if (!fresh.ok) {
		writeFileSync(
			logPath,
			[
				`# ${label}: 镜像新鲜度核对失败，未运行该格（拒绝以陈旧源码跑出假绿）`,
				'',
				...fresh.notes.map((n) => `[${n.level}] ${n.msg}`),
				'',
			].join('\n'),
		)
		return { grid: label, combo, version, ok: false, logPath, freshness: 'FAIL', stale: true }
	}
	const r = spawnSync('docker', ['compose', 'run', '--rm', '--build', 'testbed'], {
		cwd: here, env, encoding: 'utf8',
	})
	writeFileSync(logPath, (r.stdout || '') + (r.stderr || ''))
	return { grid: label, combo, version, ok: r.status === 0, logPath, freshness: 'ok', stale: false }
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
// 少数纯函数导出仅供诊断/复核（例如宿主侧复算指纹和哈希、对着一份镜像做差异比对）；
// 它们不触发任何副作用。矩阵本身只在被当作脚本直接运行时执行（见下面的守卫）。
export { hostSources, hostDigest, hostBuildStamp, readImageHash, diffSources, diffStamp, hostSnapshot, BUILD_STAMP_ENV, BUILD_STAMP_SOURCES }

// 只有被当作脚本直接运行时才跑矩阵；被 import（例如宿主侧复算指纹做核对）时只提供上面这些
// 纯函数，绝不在 import 期间执行任何 docker 命令。
if (process.env.__MATRIX_MAIN__ !== '0') {
	const { source, versions } = resolveVersions()
	mkdirSync(outDir, { recursive: true })
	console.log(`[matrix] 版本来源：${source}`)
	console.log(`[matrix] 版本集合：${versions.join(', ')}`)
	console.log(`[matrix] 组合：${combos.join(', ')}`)
	console.log(`[matrix] 镜像新鲜度核对：每格前置（build → --source-hash → 逐文件哈希 + 构建配方指纹；不一致则 --no-cache 重建）`)

	const before = checkHost ? hostSnapshot() : ''
	const results = []
	const noCacheDone = new Set()
	let port = DEFAULT_PORT
	for (const version of versions) {
		for (const combo of combos) {
			console.log(`\n[matrix] === ${version} × ${combo}（端口 ${port}）===`)
			results.push(runGrid(version, combo, port, noCacheDone))
			port += 1
		}
	}
	const after = checkHost ? hostSnapshot() : ''

	const summaryRows = results.map((r) => `| ${r.grid} | ${r.freshness} | ${r.ok ? 'PASS' : 'FAIL'} | ${r.ok ? '' : '`' + r.logPath + '`'} |`)
	writeFileSync(
		join(outDir, 'summary.md'),
		[
			'| 格 | 镜像新鲜度 | 结果 | 日志 |',
			'| --- | --- | --- | --- |',
			...summaryRows,
			'',
			`版本来源：${source}`,
			`组合：${combos.join(', ')}`,
			'',
		].join('\n'),
	)

	console.log('\n[matrix] 汇总')
	for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.grid}  ${r.ok ? '' : '→ ' + r.logPath}`)

	let hostOk = true
	if (checkHost && before !== after) {
		hostOk = false
		const beforeSet = new Set(before.split('\n'))
		const changed = after.split('\n').filter((l) => l && !beforeSet.has(l))
		console.error('\n[matrix] 宿主 $DSH_HOME 发生变化（本测试承诺零改动）：')
		for (const line of changed.slice(0, 20)) console.error('  ' + line)
	}

	const failed = results.filter((r) => !r.ok)
	console.log(`\n[matrix] ${results.length - failed.length}/${results.length} 格通过；宿主零改动：${hostOk ? '是' : '否'}`)
	console.log(`[matrix] 汇总表：${join(outDir, 'summary.md')}`)
	process.exit(failed.length === 0 && hostOk ? 0 : 1)
}
