/**
 * 端到端验证（真实 HTTP 调用开发服务器）：三种关键场景
 *
 * 场景 1：跨 sitemap 重复链接 —— sitemap-b 与 sitemap-a 有 5 条重叠链接（同一站点），
 *         重叠的链接只推送一次，在 sitemap-b 中标记为「未重复提交」。
 *
 * 场景 2：第一个 sitemap 配额耗尽 —— 第二个 sitemap（不同站点）仍然继续提交。
 *
 * 场景 3：第一个 sitemap 接口报错（token 失效）—— 第二个 sitemap 仍然继续提交。
 *
 * 用法：node scripts/test-e2e-overlap.js
 */
const http = require('http');

const BASE = process.env.BASE_URL || 'http://localhost:3111';
const SITEMAP_PORT = 8899;
const BAIDU_PORT = 8900;

const HOST_A = 'site-a.local';
const HOST_B = 'site-b.local';

// 场景 1：两个 sitemap 同站点，链接有 5 条重叠
const A_URLS = Array.from({ length: 20 }, (_, i) => `http://${HOST_A}/a/${i}`);
const B_URLS = Array.from({ length: 10 }, (_, i) => `http://${HOST_A}/b/${i}`);
const OVERLAP = A_URLS.slice(0, 5);

// 场景 2 / 3：两个 sitemap 分属不同站点
const QA_URLS = Array.from({ length: 20 }, (_, i) => `http://${HOST_A}/d/${i}`);
const QB_URLS = Array.from({ length: 10 }, (_, i) => `http://${HOST_B}/c/${i}`);

function toSitemap(urls) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${u}</loc></url>`).join('\n')}
</urlset>`;
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });
}

let receivedBatches = [];
/** 各站点的剩余额度（模拟百度按站点计算配额） */
let remainBySite = {};
/** 让指定站点返回 token 失效错误 */
let errorSite = null;

function resetState() {
  receivedBatches = [];
  remainBySite = {};
  errorSite = null;
}

function startMocks() {
  return new Promise((resolve) => {
    http
      .createServer((req, res) => {
        res.setHeader('Content-Type', 'application/xml');
        if (req.url === '/sitemap-a.xml') res.end(toSitemap(A_URLS));
        else if (req.url === '/sitemap-b.xml') res.end(toSitemap([...B_URLS, ...OVERLAP]));
        else if (req.url === '/sitemap-qa.xml') res.end(toSitemap(QA_URLS));
        else if (req.url === '/sitemap-qb.xml') res.end(toSitemap(QB_URLS));
        else {
          res.statusCode = 404;
          res.end('not found');
        }
      })
      .listen(SITEMAP_PORT, () => {
        http
          .createServer(async (req, res) => {
            const body = await readBody(req);
            const urls = body.split('\n').filter(Boolean);
            const site = new URL(req.url, 'http://x').searchParams.get('site');
            receivedBatches.push({ site, urls });
            res.setHeader('Content-Type', 'application/json');

            if (errorSite && site === errorSite) {
              res.statusCode = 401;
              res.end(JSON.stringify({ error: 401, message: 'token is not valid' }));
              return;
            }

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
  });
}

/** 模拟前端的逐个提交流程 */
async function submitAll(sitemaps) {
  const submitted = new Set();
  const collected = [];
  for (const sitemap of sitemaps) {
    // 记录本次请求之前已发出的批次，以便按请求切分批次
    const batchOffset = receivedBatches.length;
    const res = await fetch(`${BASE}/api/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sitemapUrls: [sitemap],
        token: 'test-token',
        filterSameSite: true,
        excludeUrls: [...submitted],
      }),
    });
    const data = await res.json();
    collected.push({
      sitemap,
      status: res.status,
      data,
      batches: receivedBatches.slice(batchOffset),
    });
    for (const item of data.items ?? []) {
      if (['success', 'rejected', 'not_same_site', 'not_valid'].includes(item.status)) {
        submitted.add(item.url);
      }
    }
  }
  return collected;
}

let failed = 0;
function check(label, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}`);
  if (!cond) failed += 1;
}

async function main() {
  await startMocks();
  console.log(`mock servers on ${SITEMAP_PORT} / ${BAIDU_PORT}\n`);

  // ---------- 场景 1：跨 sitemap 重复 ----------
  console.log('=== 场景 1：跨 sitemap 重复链接 ===');
  resetState();
  const r1 = await submitAll([
    `http://localhost:${SITEMAP_PORT}/sitemap-a.xml`,
    `http://localhost:${SITEMAP_PORT}/sitemap-b.xml`,
  ]);
  const items1 = r1.flatMap((r) => r.data.items ?? []);
  const dupes = items1.filter((i) => i.status === 'duplicate');
  const pushedUrls = receivedBatches.flatMap((b) => b.urls);
  const pushedFirst = r1[0].batches.flatMap((b) => b.urls);
  const pushedSecond = r1[1].batches.flatMap((b) => b.urls);

  check('两个 sitemap 都返回成功', r1.every((r) => r.data.ok === true));
  check(`重复标记 = 5 条（实际 ${dupes.length}）`, dupes.length === 5);
  check('重复标记的 URL 与重叠集合一致', OVERLAP.every((u) => dupes.some((d) => d.url === u)));
  check('重复标记出现在第二个 sitemap 的结果中',
    (r1[1].data.items ?? []).some((i) => i.status === 'duplicate'));
  check('重叠链接总共只被推送给百度 5 次',
    pushedUrls.filter((u) => OVERLAP.includes(u)).length === 5);
  check('重叠链接没有出现在第二个 sitemap 的推送批次中',
    pushedSecond.every((u) => !OVERLAP.includes(u)));
  check(`推送给百度的唯一 URL 数 = 30（实际 ${new Set(pushedUrls).size}）`,
    new Set(pushedUrls).size === 30);
  check('第一个 sitemap 推送了 20 条', pushedFirst.length === 20);
  check('第二个 sitemap 只推送了 10 条', pushedSecond.length === 10);
  check('所有条目都带 sitemap 来源', items1.every((i) => Boolean(i.sitemap)));
  check('两个 sitemap 推断出同一个站点', r1[0].data.site === r1[1].data.site && r1[0].data.site === HOST_A);

  // ---------- 场景 2：第一个 sitemap 配额耗尽 ----------
  console.log('\n=== 场景 2：第一个 sitemap 配额耗尽 ===');
  resetState();
  remainBySite[HOST_A] = 2; // 站点 A 只剩 2 条额度
  const r2 = await submitAll([
    `http://localhost:${SITEMAP_PORT}/sitemap-qa.xml`,
    `http://localhost:${SITEMAP_PORT}/sitemap-qb.xml`,
  ]);
  const a = r2[0].data;
  const b = r2[1].data;
  const itemsA = a.items ?? [];
  const itemsB = b.items ?? [];

  check('第一个 sitemap 标记了配额耗尽', a.quotaExhausted === true);
  check(
    `第一个 sitemap 有未提交条目（${itemsA.filter((i) => i.status === 'quota').length}）`,
    itemsA.filter((i) => i.status === 'quota').length > 0,
  );
  check('第一个 sitemap 仍然有成功条目', itemsA.filter((i) => i.status === 'success').length > 0);
  check('第二个 sitemap 仍然发起了提交', receivedBatches.some((x) => x.site === HOST_B));
  check('第二个 sitemap 返回 ok=true', b.ok === true);
  check(
    `第二个 sitemap 有成功条目（${itemsB.filter((i) => i.status === 'success').length}）`,
    itemsB.filter((i) => i.status === 'success').length > 0,
  );
  check('第二个 sitemap 未标记配额耗尽', b.quotaExhausted === false);
  check('第二个 sitemap 的分组统计存在', Array.isArray(b.groups) && b.groups.length === 1);
  check(
    '两个 sitemap 的分组统计各自带自己的站点',
    r2[0].data.groups[0].site === HOST_A && r2[1].data.groups[0].site === HOST_B,
  );
  check(
    '第一个 sitemap 的配额提示包含未提交条数',
    typeof a.warning === 'string' && a.warning.includes('配额'),
  );
  check(
    '第二个 sitemap 的剩余额度独立统计',
    typeof b.remain === 'number' && b.remain > 0,
  );

  // ---------- 场景 3：第一个 sitemap 接口报错 ----------
  console.log('\n=== 场景 3：第一个 sitemap 接口报错（token 失效）===');
  resetState();
  errorSite = HOST_A;
  const r3 = await submitAll([
    `http://localhost:${SITEMAP_PORT}/sitemap-qa.xml`,
    `http://localhost:${SITEMAP_PORT}/sitemap-qb.xml`,
  ]);
  const c = r3[0].data;
  const d = r3[1].data;

  check('第一个 sitemap 整体返回失败', c.ok === false);
  check('第一个 sitemap 的条目标记为未提交（error）',
    (c.items ?? []).some((i) => i.status === 'error'));
  check('第一个 sitemap 的错误提示为中文',
    typeof c.error === 'string' && c.error.includes('密钥'));
  check('第二个 sitemap 仍然发起了提交', receivedBatches.some((x) => x.site === HOST_B));
  check('第二个 sitemap 返回 ok=true', d.ok === true);
  check(
    `第二个 sitemap 有成功条目（${(d.items ?? []).filter((i) => i.status === 'success').length}）`,
    (d.items ?? []).filter((i) => i.status === 'success').length > 0,
  );
  check('第二个 sitemap 的分组统计记录了独立结果', (d.groups?.[0]?.success ?? 0) > 0);

  console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项未通过`}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
