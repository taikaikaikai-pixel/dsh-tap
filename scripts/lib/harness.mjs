/**
 * scripts/lib/harness.mjs — 离线回归套件的公共骨架。
 *
 * 改造前 6 个 verify-*.mjs 各自抄一份 `check()`（连计数变量名都不同），新增
 * 套件就多一份副本、改输出格式要动六处。这里只放**真正通用**的三件：断言器、
 * sleep、临时端口。各套件自己的断言逻辑与 fixture 留在各自文件里——共享的是
 * 记账，不是业务。
 */

/**
 * 断言器：`ok(描述, 条件, 失败时的补充证据)`。
 * @param {string} title 汇总行里的套件名
 */
export function createChecker(title) {
  let pass = 0
  const failures = []
  const ok = (desc, cond, extra = '') => {
    if (cond) {
      pass++
      console.log(`  ok   ${desc}`)
      return true
    }
    const line = `${desc}${extra ? ` — ${extra}` : ''}`
    failures.push(line)
    console.log(`  FAIL ${line}`)
    return false
  }
  const section = (t) => console.log(`\n[${t}]`)
  const finish = () => {
    console.log(`\n=== ${title}: ${pass} 通过 / ${failures.length} 失败 ===`)
    if (failures.length) process.exitCode = 1
    return failures.length === 0
  }
  // `check` = `ok` 的别名：存量套件的调点叫 check(label, cond, extra)。
  return { ok, check: ok, section, finish, failures, passed: () => pass }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 申请一个当前空闲的临时端口（listen(0) 后立刻释放；有小概率被抢占，测试用足够）。 */
export async function freePort() {
  const { createServer } = await import('node:http')
  const probe = createServer()
  await new Promise((r) => probe.listen(0, '127.0.0.1', r))
  const { port } = probe.address()
  await new Promise((r) => probe.close(r))
  return port
}

/** 极简 HTTP 客户端：能覆盖 Host 头（fetch 不允许），返回 {status, headers, text}。 */
export function httpRequest(port, { method = 'GET', path = '/', headers = {}, body = null } = {}) {
  return import('node:http').then(({ request }) => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (d) => { text += d })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }))
    })
    req.on('error', reject)
    if (body != null) req.write(body)
    req.end()
  }))
}
