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
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname, resolve, relative, basename } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const composeFile = join(here, 'compose.yaml')
const outDir = join(here, '.out')
const dockerConfig = join(here, '.docker-config')
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
// 逗号分隔参数统一在这里解析并**当场拒绝空集合**：`--combos ,`、`--versions ,` 或纯空白值
// 会被 filter(Boolean) 清空，若放行就成了"0 格全绿、退出 0"的假绿（与 dist-tags 那条防线同类）。
// 这类调用是命令行写错，不是"没有可测的组合"，所以直接退 1，绝不进入矩阵。
// 注意：这里只**定义**函数（无副作用）。所有调用点都在下面的 `if (isMain)` 块内，否则
// `await import('matrix.mjs')` 会因导入者自己的 argv（例如 `--jobs 4`）被 process.exit 杀掉。
const parseList = (flag, raw) => {
	const list = raw.split(',').map((s) => s.trim()).filter(Boolean)
	if (list.length === 0) {
		console.error(`[matrix] ${flag} 解析后为空（收到：${JSON.stringify(raw)}）——拒绝以空集合运行矩阵（0 格全绿是假绿），请给出至少一个值，例如 --combos self`)
		process.exit(1)
	}
	return list
}

// 版本解析：显式给出则原样使用（并打印来源）；否则解析 dist-tags 的 latest + next 去重。
function resolveVersions() {
	// 与 --combos 一致：显式给了 --versions（即便值是空串/逗号）就不去碰网络，空集合当场退 1。
	const explicit = argOf('--versions', '')
	if (argv.includes('--versions')) return { source: `显式 --versions`, versions: parseList('--versions', explicit) }
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

// ── testbed/.env：必须与 compose 读同一份 ────────────────────────────────────
// compose 的插值会自己读 testbed/ 下的 .env（挂载写成 `${DSH_HOME_HOST:-/root/.dsh}`），而 Node 不会。
// 矩阵若不读同一份文件，用户按 README 把 DSH_HOME_HOST 写进 .env 后就会出现假绿：容器挂载确实
// 换到了新路径，宿主快照却仍在看 /root/.dsh，末行照样打印"宿主零改动：是"——那是在一个根本没
// 挂进容器的目录上得出的结论。NPM_REGISTRY 同根因（compose.yaml 把它作为 build arg 插值）。
// 用 Node 内建 process.loadEnvFile：**已存在的环境变量优先、只补缺**（与 compose 的优先级一致）。
// 文件不存在是正常情况（静默跳过）；但"文件存在却读不进来"不能静默——那时 compose 仍会用它插值
// 宿主挂载，而我们的快照目标只能退回默认值，正好又是上面那种假绿，所以主流程里对它硬报错。
// 本步骤本身绝不 process.exit —— import 时同样要零退出、零报错。
const envFilePath = join(here, '.env')
const hostTargetFromEnvVar = process.env.DSH_HOME_HOST // 必须在 loadEnvFile 之前记录，才能报出真实来源
const envFileExists = existsSync(envFilePath)
const envFileError = (() => {
	try {
		process.loadEnvFile(envFilePath)
		return null
	} catch (error) {
		return error
	}
})()
const envFileLoaded = envFileError === null && envFileExists
const envFileNote = envFileLoaded
	? '；已读 testbed/.env'
	: envFileExists
		? `；testbed/.env 读取失败：${envFileError && envFileError.message}`
		: '；未发现 testbed/.env（可 cp .env.example .env）'

// 宿主白名单快照：只看配置类文件，排除会持续变化的 sessions/storages/browser-*/change-ledger。
// 快照目标与容器挂载同源（都来自环境变量/.env），否则"宿主零改动"会报在一个没人挂载的目录上。
const HOST_TARGET = process.env.DSH_HOME_HOST || '/root/.dsh'
const HOST_TARGET_SOURCE = hostTargetFromEnvVar !== undefined
	? '环境变量 DSH_HOME_HOST（优先于 .env）'
	: process.env.DSH_HOME_HOST !== undefined ? 'testbed/.env' : '默认值（环境变量与 .env 都未设置）'
// 镜像构建期的 npm registry 也只由同一份 .env / 环境变量决定（compose.yaml 的 NPM_REGISTRY build arg）。
const NPM_REGISTRY_EFFECTIVE = process.env.NPM_REGISTRY || 'https://registry.npmjs.org（默认值）'
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
	// DOCKER_CONFIG 目录在**真正要跑 docker 时**才建（幂等）：放在模块顶层会让 `import` 也产生
	// 文件系统副作用，而 import 只应提供纯函数。
	mkdirSync(dockerConfig, { recursive: true })
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
// stamp 是镜像里烧入的构建配方指纹。注意 entrypoint.sh 的 source_hash **无条件**打印
// `TESTBED_BUILD_STAMP=<值>`，缺失 /etc/testbed-build-stamp 时值是空串，所以"镜像没带指纹"
// 在自检成功（status 0）时表现为 stamp === ''，而不是 null（只能用来判断空，不足以判断缺失）。
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

// 指纹比对：宿主侧算不出指纹（源码缺失）则跳过比对，此时逐文件核对仍然生效，只是不额外设障。
// 关于"缺失"与"不一致"：entrypoint.sh 的 source_hash 无条件打印 TESTBED_BUILD_STAMP=，
// 镜像里文件缺失时打印的是**空串**，所以走不到 imageStamp === null 这条分支（该分支只在
// --source-hash 本身失败时才有值可谈，而那时调用方已按自检失败提前 FAIL）。空串与不一致
// 都会落到下面同一个判陈旧分支：两者都意味着"当前镜像不能证明它由当前 Dockerfile 构建"。
function diffStamp(imageStamp) {
	const host = hostBuildStamp()
	if (host === null) return { same: true, line: '' }
	if (imageStamp === null || imageStamp === '') return { same: false, line: `  镜像里没有可用的构建配方指纹（TESTBED_BUILD_STAMP ${imageStamp === null ? '缺失' : '为空串'}）：该镜像无法证明由当前 Dockerfile 构建，判为陈旧` }
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

// 只有被当作脚本直接运行时（`node matrix.mjs`）才跑矩阵；被 import 时（例如宿主侧复算指纹、
// 哈希做核对）只提供上面这些纯函数，绝不在 import 期间执行任何 docker 命令，也绝不 process.exit。
// 判据是"直接执行"：入口脚本的真实路径与 import.meta.url 相等。不再用 `__MATRIX_MAIN__`
// 那种默认执行、需要调用方主动设置环境变量才能避免副作用的写法——它默认执行，
// `import('./matrix.mjs')` 会跑完整矩阵并在结尾 process.exit() 掉导入者（Task 8 实测踩过）。
// argv[1] 必须**先 realpath** 再比较：通过软链调用（`node /tmp/link.mjs`）时 argv[1] 保持
// 软链路径，而 import.meta.url 是 realpath，直接比较会让 isMain 为 false → 静默空转、退出 0
// （另一种假绿）。realpath 失败（路径不存在等）按"不是直接执行"处理，同样退化为纯 import。
const realArgv1 = (() => {
	try {
		return realpathSync(process.argv[1])
	} catch {
		return undefined
	}
})()
const isMain = process.argv[1] !== undefined && realArgv1 !== undefined && import.meta.url === pathToFileURL(realArgv1).href
if (isMain) {
	// 参数解析与校验全部在主流程内：解析即校验、校验失败即退 1；一旦提到模块顶层，
	// `await import('matrix.mjs')` 就会被导入者自己的 argv（例如 `--jobs 4`）杀掉、import 永不返回。
	const combos = parseList('--combos', argOf('--combos', 'self'))
	// --jobs 目前**只是保留参数**：矩阵仍是串行外循环（每格自带 build → 自检 → run 的前置，
	// 并行会打乱端口与镜像重建的时序）。为避免"设了 --jobs 其实是静默无效"的误判，非 1 的值
	// 直接报错；真要并行时再实现并删掉这条拒绝。
	const jobs = Number(argOf('--jobs', '1'))
	if (jobs !== 1) {
		console.error(`[matrix] --jobs 当前仅为保留参数，矩阵仍是串行执行，只接受 --jobs 1（收到：${JSON.stringify(argOf('--jobs', '1'))}）`)
		process.exit(1)
	}
	// 默认开启宿主零改动快照；`--no-check-host` 关掉它（用于只想看格结果的场合），
	// `--check-host` 是显式开（与 brief 的接口签名一致，即便默认已是开）。两者同给即报错，
	// 避免"以为关了其实开着"这类静默歧义。
	if (argv.includes('--check-host') && argv.includes('--no-check-host')) {
		console.error('[matrix] --check-host 与 --no-check-host 不能同时给出')
		process.exit(1)
	}
	const checkHost = !argv.includes('--no-check-host')
	// .env 存在却读不进来：compose 仍会读它（宿主挂载会换到别的目录），而快照目标只能退回默认值，
	// 结论就会是错的"宿主零改动：是"。这种不一致必须硬报错，绝不带着它继续跑。
	if (envFileExists && !envFileLoaded) {
		console.error(`[matrix] testbed/.env 存在但无法读取（${envFileError && envFileError.message}）——compose 仍会用它插值宿主挂载，而宿主快照只能退回默认值，会得出错误的"宿主零改动：是"。请修正或删除 .env 后重跑`)
		process.exit(1)
	}

	const { source, versions } = resolveVersions()
	// 兜底（--combos 已在解析处早退）：任何路径都不许带着空集合进入循环——0 格跑完只会打印
	// "0/0 格通过；宿主零改动：是"并退出 0，那正是本脚本最该避免的假绿。
	if (versions.length === 0 || combos.length === 0) {
		console.error(`[matrix] 版本集合或组合集合为空（${versions.length} × ${combos.length}）——拒绝以 0 格运行矩阵（假绿），请显式给出 --versions/--combos`)
		process.exit(1)
	}
	mkdirSync(outDir, { recursive: true })
	console.log(`[matrix] 版本来源：${source}`)
	console.log(`[matrix] 版本集合：${versions.join(', ')}`)
	console.log(`[matrix] 组合：${combos.join(', ')}`)
	console.log(`[matrix] 镜像新鲜度核对：每格前置（build → --source-hash → 逐文件哈希 + 构建配方指纹；不一致则 --no-cache 重建）`)
	// 把"生效值 + 来源"印出来：只印"宿主零改动：是"而不说快照的是哪个目录，正是上面 C1 那类假绿的温床。
	console.log(`[matrix] 宿主快照目标：${HOST_TARGET}（来源：${HOST_TARGET_SOURCE}${envFileNote}）`)
	console.log(`[matrix] 镜像构建 registry：${NPM_REGISTRY_EFFECTIVE}${envFileLoaded ? '（.env 已并入）' : ''}`)

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
