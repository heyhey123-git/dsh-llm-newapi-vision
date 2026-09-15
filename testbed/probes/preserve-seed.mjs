// 读出宿主 web profile 的 bundle 行，供 preserve 模式在容器内重建同一组合。
// 用法：node preserve-seed.mjs <宿主的 profiles/web/package.json>
import { readFileSync } from 'node:fs'

const [, , manifestPath] = process.argv
const SELF = 'dsh-llm-newapi'
const BASE = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

const pkg = JSON.parse(readFileSync(manifestPath, 'utf8'))
const rows = pkg?.dsh?.profile?.bundles ?? []
for (const row of rows) {
	if (BASE.includes(row) || row === SELF) continue
	console.log(row)
}
