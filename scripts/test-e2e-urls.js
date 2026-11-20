/**
 * 批量提交 URL 的端到端验证（真实 HTTP 调用开发服务器）
 *
 * 场景：
 *   1. 正常提交：站点自动推断、过滤非本站链接、逐条结果
 *   2. 页面填写 site 时以填写的为准
 *   3. 非法与重复链接在本地被拦下，不发给百度
 *   4. 预览模式不调用百度接口
 *   5. 配额用尽时保留已成功的结果
 *
 * 用法：node scripts/test-e2e-urls.js
 */
const http = require('http');

const BASE = process.env.BASE_URL || 'http://localhost:3111';
const BAIDU_PORT = 8900;

const HOST_A = 'site-a.local';
const HOST_B = 'site-b.local';

let receivedBatches = [];
let remainBySite = {};

function resetState() {
  receivedBatches = [];
  remainBySite = {};
}

function startMockBaidu() {
  return new Promise((resolve) => {
    http
      .createServer(async (req, res) => {
        let data = '';
        for await (const chunk of req) data += chunk;
        const urls = data.split('\n').filter(Boolean);
        const site = new URL(req.url, 'http://x').searchParams.get('site');
        receivedBatches.push({ site, urls });
        res.setHeader('Content-Type', 'application/json');

        const remain = remainBySite[site] ?? 1000;
        if (urls.length > remain) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 400, message: 'over quota' }));
          return;
        }
        const success = Math.min(10, urls.length);
        remainBySite[site] = remain - success;
        res.end(
          JSON.stringify({ success, remain: remainBySite[site], not_same_site: [], not_valid: [] }),
        );
      })
      .listen(BAIDU_PORT, resolve);
  });
}

async function callApi(body) {
  const res = await fetch(`${BASE}/api/submit-urls`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

let failed = 0;
function check(label, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}`);
  if (!cond) failed += 1;
}

async function main() {
  await startMockBaidu();
  console.log(`mock baidu on ${BAIDU_PORT}\n`);

  // ---------- 场景 1：自动推断站点 + 过滤非本站 ----------
  console.log('=== 场景 1：站点自动推断 ===');
  resetState();
  const r1 = await callApi({
    urls: [
      `http://${HOST_A}/1`,
      `http://${HOST_A}/2`,
      `http://${HOST_A}/3`,
      `http://${HOST_B}/x`,
    ],
    token: 'test-token',
  });

  check('返回 ok=true', r1.data.ok === true);
  check(`站点自动推断为多数域名（${r1.data.site}）`, r1.data.site === HOST_A);
  check('站点来源标记为 derived', r1.data.siteSource === 'derived');
  check(`去重后 4 条（实际 ${r1.data.total}）`, r1.data.total === 4);
  check(`过滤掉 1 条非本站链接（实际 ${r1.data.removed}）`, r1.data.removed === 1);
  check(`待提交 3 条（实际 ${r1.data.kept}）`, r1.data.kept === 3);
  check('推送给百度的链接都属于推断出的站点',
    receivedBatches.flatMap((b) => b.urls).every((u) => u.includes(HOST_A)));
  check('按推断出的站点提交', receivedBatches.every((b) => b.site === HOST_A));
  check(`成功 3 条（实际 ${r1.data.successCount}）`, r1.data.successCount === 3);
  check('结果包含域名分布', Array.isArray(r1.data.hosts) && r1.data.hosts.length === 2);
  check('结果包含剩余额度', typeof r1.data.remain === 'number');

  // ---------- 场景 2：页面填写 site 优先 ----------
  console.log('\n=== 场景 2：填写 site 优先 ===');
  resetState();
  const r2 = await callApi({
    urls: [`http://${HOST_A}/1`, `http://${HOST_B}/x`],
    site: `https://${HOST_B}/`,
    token: 'test-token',
  });

  check(`site 被规范化为裸域名（${r2.data.site}）`, r2.data.site === HOST_B);
  check('站点来源标记为 input', r2.data.siteSource === 'input');
  check('只提交与填写站点同域的链接', receivedBatches.flatMap((b) => b.urls).every((u) => u.includes(HOST_B)));
  check('按填写的站点提交', receivedBatches.every((b) => b.site === HOST_B));

  // ---------- 场景 3：非法与重复链接在本地拦下 ----------
  console.log('\n=== 场景 3：非法与重复链接 ===');
  resetState();
  const r3 = await callApi({
    urls: [
      `http://${HOST_A}/1`,
      'not-a-url',
      'ftp://example.com/x',
      `http://${HOST_A}/1`,
    ],
    token: 'test-token',
  });

  check(`识别出 2 条非法链接（实际 ${r3.data.invalid}）`, r3.data.invalid === 2);
  check(`识别出 1 条重复链接（实际 ${r3.data.duplicate}）`, r3.data.duplicate === 1);
  check('去重后只剩 1 条有效链接', r3.data.total === 1);
  check('非法与重复链接都没有发给百度',
    receivedBatches.flatMap((b) => b.urls).every((u) => u === `http://${HOST_A}/1`));
  check('非法链接在结果中标为 not_valid',
    r3.data.items.some((i) => i.url === 'not-a-url' && i.status === 'not_valid'));
  check('重复链接在结果中标为 duplicate',
    r3.data.items.some((i) => i.status === 'duplicate'));

  // ---------- 场景 4：预览模式不调用百度 ----------
  console.log('\n=== 场景 4：仅校验预览 ===');
  resetState();
  const r4 = await callApi({
    urls: [`http://${HOST_A}/1`, `http://${HOST_A}/2`, 'bad'],
    token: 'test-token',
    dryRun: true,
  });

  check('返回 dryRun=true', r4.data.dryRun === true);
  check('返回 ok=true', r4.data.ok === true);
  check('没有调用百度接口', receivedBatches.length === 0);
  check('返回将要提交的链接', Array.isArray(r4.data.preview) && r4.data.preview.length === 2);
  check('返回域名分布', r4.data.hosts?.[0]?.host === HOST_A);
  check('预览模式下也标出非法链接', r4.data.invalid === 1);

  // ---------- 场景 5：配额用尽 ----------
  console.log('\n=== 场景 5：配额用尽 ===');
  resetState();
  remainBySite[HOST_A] = 3;
  const many = Array.from({ length: 10 }, (_, i) => `http://${HOST_A}/${i}`);
  const r5 = await callApi({ urls: many, token: 'test-token' });

  check('标记配额耗尽', r5.data.quotaExhausted === true);
  check(`配额内的链接提交成功（${r5.data.successCount}）`, r5.data.successCount === 3);
  check(`配额外的链接标记为未提交（${
    r5.data.items.filter((i) => i.status === 'quota').length
  }）`, r5.data.items.filter((i) => i.status === 'quota').length === 7);
  check('给出配额用尽的中文提示', typeof r5.data.warning === 'string' && r5.data.warning.includes('配额'));

  console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项未通过`}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
