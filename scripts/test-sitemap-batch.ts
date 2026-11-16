/**
 * sitemap 批量解析测试（用 mock 替换 fetch，不产生真实网络请求）
 * 运行：npx tsx scripts/test-sitemap-batch.ts
 */
import { parseSitemapBatch, filterBySite, extractLocValues } from '../lib/sitemap';

const originalFetch = globalThis.fetch;

function mockSitemap(routes: Record<string, string>) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = routes[url];
    if (body === undefined) {
      return new Response('not found', { status: 404, statusText: 'Not Found' });
    }
    return new Response(body, { status: 200, headers: { 'Content-Type': 'application/xml' } });
  }) as typeof fetch;
}

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS: ${message}`);
  }
}

const urlset = (...locs: string[]) => `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${locs.map((loc) => `  <url><loc>${loc}</loc></url>`).join('\n')}
</urlset>`;

const index = (...locs: string[]) => `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${locs.map((loc) => `  <sitemap><loc>${loc}</loc></sitemap>`).join('\n')}
</sitemapindex>`;

(async () => {
  // 1. loc 提取
  assert(
    extractLocValues(urlset('https://a.com/1', 'https://a.com/2')).length === 2,
    '从 urlset 中提取 loc',
  );
  assert(
    extractLocValues(urlset('https://a.com/1&amp;x=1')).includes('https://a.com/1&x=1'),
    'loc 中的 XML 实体被解码',
  );

  // 2. 多个 sitemap 合并去重
  mockSitemap({
    'https://a.com/sitemap.xml': urlset('https://a.com/1', 'https://a.com/2'),
    'https://a.com/sitemap-2.xml': urlset('https://a.com/2', 'https://a.com/3'),
  });
  const batch = await parseSitemapBatch([
    'https://a.com/sitemap.xml',
    'https://a.com/sitemap-2.xml',
  ]);
  assert(batch.items.length === 2, '逐个 sitemap 返回解析结果');
  assert(batch.items.every((item) => item.ok), '两个 sitemap 都解析成功');
  assert(batch.urls.length === 3, '重复链接被合并去重（2 + 3 → 3）');
  assert(batch.failed === 0, '没有失败的 sitemap');

  // 3. 单个 sitemap 失败不影响其它（missing.xml 未注册 → 返回 404）
  mockSitemap({
    'https://a.com/sitemap.xml': urlset('https://a.com/1'),
  });
  const partial = await parseSitemapBatch([
    'https://a.com/sitemap.xml',
    'https://a.com/missing.xml',
  ]);
  assert(partial.items[0].ok === true, '第一个 sitemap 仍然解析成功');
  assert(partial.items[1].ok === false, '第二个 sitemap 标记为失败');
  assert(typeof partial.items[1].error === 'string' && partial.items[1].error!.length > 0, '失败项带错误说明');
  assert(partial.failed === 1 && partial.urls.length === 1, '失败数量与可用链接数正确');

  // 4. sitemap 索引展开
  mockSitemap({
    'https://a.com/sitemap-index.xml': index('https://a.com/sitemap-a.xml'),
    'https://a.com/sitemap-a.xml': urlset('https://a.com/1'),
  });
  const withIndex = await parseSitemapBatch(['https://a.com/sitemap-index.xml']);
  assert(withIndex.items[0].isIndex === true, '识别出 sitemap 索引');
  assert(withIndex.items[0].childSitemaps === 1, '统计了展开的子 sitemap 数量');
  assert(withIndex.urls.length === 1, '索引下的链接被正确解析');

  // 5. 同站过滤
  const filtered = filterBySite(
    ['https://a.com/1', 'https://b.com/2', 'https://sub.a.com/3', 'not-a-url'],
    'a.com',
  );
  assert(filtered.kept.length === 2, '保留同域与子域链接');
  assert(filtered.removed.length === 2, '非本站链接与非法链接被过滤');

  globalThis.fetch = originalFetch;
})();
