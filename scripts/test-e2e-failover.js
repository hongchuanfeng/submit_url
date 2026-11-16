/**
 * 端到端验证：第一个 sitemap 部分失败（部分成功 / 配额耗尽 / 接口报错）时，
 * 第二个 sitemap 仍然继续提交。
 *
 * 用法：
 *   node scripts/test-e2e-failover.js            # 每批只接受 10 条（部分失败）
 *   node scripts/test-e2e-failover.js --quota    # 第一个 sitemap 配额耗尽
 *
 * 然后在另一个终端运行：
 *   BAIDU_ENDPOINT=http://localhost:8900/urls npm run dev
 * 并在页面上填写：
 *   http://localhost:8899/sitemap.xml
 *   http://localhost:8899/sitemap-2.xml
 */
const http = require('http');

const QUOTA_MODE = process.argv.includes('--quota');

const sitemapA = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${Array.from({ length: 100 }, (_, i) => `  <url><loc>http://localhost:8899/a/${i}</loc></url>`).join('\n')}
</urlset>`;

const sitemapB = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${Array.from({ length: 20 }, (_, i) => `  <url><loc>http://localhost:8899/b/${i}</loc></url>`).join('\n')}
</urlset>`;

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => resolve(data));
  });
}

// ---- 假 sitemap 服务 ----
http
  .createServer((req, res) => {
    res.setHeader('Content-Type', 'application/xml');
    if (req.url === '/sitemap.xml') res.end(sitemapA);
    else if (req.url === '/sitemap-2.xml') res.end(sitemapB);
    else {
      res.statusCode = 404;
      res.end('not found');
    }
  })
  .listen(8899, () => console.log('fake sitemap server on 8899'));

// ---- 假百度接口 ----
const batches = [];
let remain = QUOTA_MODE ? 10 : 1000;

http
  .createServer(async (req, res) => {
    const body = await readBody(req);
    const urls = body.split('\n').filter(Boolean);
    batches.push({ count: urls.length, sample: urls.slice(0, 2) });

    console.log(`[fake baidu] 收到 ${urls.length} 条：${urls.slice(0, 2).join(', ')}...`);

    res.setHeader('Content-Type', 'application/json');

    // 配额不足：整批拒绝（百度在条数超过剩余额度时的真实行为）
    if (urls.length > remain) {
      console.log(`[fake baidu] 拒绝：本次 ${urls.length} 条 > 剩余额度 ${remain}`);
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 400, message: 'over quota' }));
      return;
    }

    // 每批只接受 10 条（模拟用户描述的「提交 10 个，其余失败」）
    const success = Math.min(10, urls.length);
    remain -= success;
    res.end(
      JSON.stringify({
        success,
        remain,
        not_same_site: [],
        not_valid: [],
      }),
    );
  })
  .listen(8900, () => console.log(`fake baidu server on 8900（模式：${QUOTA_MODE ? '配额耗尽' : '部分失败'}）`));

process.on('SIGINT', () => {
  console.log('\n批次统计：');
  batches.forEach((batch, index) => console.log(`  #${index + 1}: ${batch.count} 条`));
  process.exit(0);
});
