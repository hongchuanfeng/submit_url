/**
 * 「某个 sitemap 部分失败不影响后续 sitemap 提交」的接口级测试（mock fetch，不产生真实推送）
 * 运行：npx tsx scripts/test-submit-route.ts
 */
import { POST } from '../app/api/submit/route';

// 固定使用百度官方地址，避免本机环境变量（BAIDU_ENDPOINT）影响测试
process.env.BAIDU_ENDPOINT = 'http://data.zz.baidu.com/urls';

const originalFetch = globalThis.fetch;

const BAIDU_PREFIX = 'http://data.zz.baidu.com/urls';

const urlset = (...locs: string[]) => `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${locs.map((loc) => `  <url><loc>${loc}</loc></url>`).join('\n')}
</urlset>`;

interface BaiduCall {
  urls: string[];
}

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS: ${message}`);
  }
}

function mockFetch(options: {
  sitemaps: Record<string, string>;
  onBaidu: (urls: string[]) => { status: number; body: unknown };
}) {
  const baiduCalls: BaiduCall[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);

    if (url.startsWith(BAIDU_PREFIX)) {
      const urls = String(init?.body ?? '')
        .split('\n')
        .filter(Boolean);
      baiduCalls.push({ urls });
      const { status, body } = options.onBaidu(urls);
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const body = options.sitemaps[url];
    if (body === undefined) {
      return new Response('not found', { status: 404, statusText: 'Not Found' });
    }
    return new Response(body, { status: 200, headers: { 'Content-Type': 'application/xml' } });
  }) as typeof fetch;

  return baiduCalls;
}

async function callApi(body: Record<string, unknown>) {
  const request = new Request('http://localhost/api/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const response = await POST(request);
  return (await response.json()) as Record<string, any>;
}

(async () => {
  // 场景一：第一个 sitemap 100 条链接，只有 10 条被百度接收，
  // 后面的 sitemap 必须继续提交。
  const first = Array.from({ length: 100 }, (_, i) => `https://www.example.com/a/${i}`);
  const second = Array.from({ length: 20 }, (_, i) => `https://www.example.com/b/${i}`);

  let baiduCalls = mockFetch({
    sitemaps: {
      'https://www.example.com/sitemap-a.xml': urlset(...first),
      'https://www.example.com/sitemap-b.xml': urlset(...second),
    },
    // 模拟「部分成功」：每个 sitemap 只接收前 10 条
    onBaidu: (urls) => ({
      status: 200,
      body: {
        success: Math.min(10, urls.length),
        remain: 1000,
        not_same_site: [],
        not_valid: [],
      },
    }),
  });

  const resultA = await callApi({
    sitemapUrls: [
      'https://www.example.com/sitemap-a.xml',
      'https://www.example.com/sitemap-b.xml',
    ],
    site: 'www.example.com',
    token: 'test-token',
  });

  assert(resultA.ok === true, '部分失败时整体仍然返回 ok');
  assert(resultA.groups?.length === 2, '结果包含两个 sitemap 的分组统计');
  assert(resultA.groups?.[0]?.total === 100, '第一个 sitemap 统计了 100 条链接');
  assert(resultA.groups?.[1]?.total === 20, '第二个 sitemap 统计了 20 条链接');
  assert(
    baiduCalls.some((call) => call.urls.some((url) => url.includes('/b/'))),
    '第一个 sitemap 部分失败后，第二个 sitemap 仍然被提交',
  );

  // 场景二：第一个 sitemap 整体报错（接口 500），第二个 sitemap 仍要继续提交
  let callIndex = 0;
  baiduCalls = mockFetch({
    sitemaps: {
      'https://www.example.com/sitemap-a.xml': urlset(...first),
      'https://www.example.com/sitemap-b.xml': urlset(...second),
    },
    onBaidu: (urls) => {
      callIndex += 1;
      if (callIndex === 1) {
        return { status: 500, body: { error: 500, message: 'internal error' } };
      }
      return {
        status: 200,
        body: { success: urls.length, remain: 900, not_same_site: [], not_valid: [] },
      };
    },
  });

  const resultB = await callApi({
    sitemapUrls: [
      'https://www.example.com/sitemap-a.xml',
      'https://www.example.com/sitemap-b.xml',
    ],
    site: 'www.example.com',
    token: 'test-token',
  });

  assert(resultB.ok === true, '第一个 sitemap 报错时整体仍然返回 ok');
  assert(
    baiduCalls.length >= 2 && baiduCalls[1].urls.some((url) => url.includes('/b/')),
    '第一个 sitemap 接口报错后，第二个 sitemap 仍然被提交',
  );
  assert(resultB.groups?.[0]?.error !== undefined, '第一个 sitemap 记录了失败原因');
  assert(resultB.groups?.[1]?.success === 20, '第二个 sitemap 的成功条数正常统计');

  // 场景三：配额用尽时，后面的 sitemap 仍会尝试提交（而不是被整体跳过）
  let remain = 5;
  baiduCalls = mockFetch({
    sitemaps: {
      'https://www.example.com/sitemap-a.xml': urlset(...first),
      'https://www.example.com/sitemap-b.xml': urlset(...second),
    },
    onBaidu: (urls) => {
      if (remain <= 0) {
        return { status: 400, body: { error: 400, message: 'over quota' } };
      }
      const used = Math.min(remain, urls.length);
      remain -= used;
      return {
        status: 200,
        body: { success: used, remain, not_same_site: [], not_valid: [] },
      };
    },
  });

  const resultC = await callApi({
    sitemapUrls: [
      'https://www.example.com/sitemap-a.xml',
      'https://www.example.com/sitemap-b.xml',
    ],
    site: 'www.example.com',
    token: 'test-token',
  });

  assert(
    baiduCalls.some((call) => call.urls.some((url) => url.includes('/b/'))),
    '配额用尽后，后面的 sitemap 仍然会发起提交请求',
  );
  assert(resultC.items.length === 120, '所有链接都在结果中出现（含未提交的）');

  // 场景四：不同域名的 sitemap 各自使用自己的站点提交
  baiduCalls = mockFetch({
    sitemaps: {
      'https://www.example.com/sitemap-a.xml': urlset(...first),
      'https://www.other.com/sitemap-b.xml': urlset(
        ...second.map((url) => url.replace('www.example.com', 'www.other.com')),
      ),
    },
    onBaidu: (urls) => ({
      status: 200,
      body: {
        success: urls.length,
        remain: 500,
        not_same_site: [],
        not_valid: [],
      },
    }),
  });

  const resultD = await callApi({
    sitemapUrls: [
      'https://www.example.com/sitemap-a.xml',
      'https://www.other.com/sitemap-b.xml',
    ],
    token: 'test-token',
  });

  assert(resultD.ok === true, '不同域名的 sitemap 都能提交成功');
  assert(
    baiduCalls[0]?.urls.every((url) => url.includes('www.example.com')),
    '第一个 sitemap 的链接提交到自己的站点',
  );
  assert(
    baiduCalls.some((call) => call.urls.every((url) => url.includes('www.other.com'))),
    '第二个 sitemap 的链接提交到自己的站点（而不是被过滤掉）',
  );
  assert(
    (resultD.groups ?? []).every((group: { site?: string }) => group.site),
    '每个 sitemap 分组都带上了自己的站点',
  );
  assert(resultD.removed === 0, '不同域名的 sitemap 不会被站点过滤掉');

  // 场景五：跨 sitemap 去重：第二个 sitemap 中已提交的链接不再重复推送
  baiduCalls = mockFetch({
    sitemaps: {
      'https://www.example.com/sitemap-a.xml': urlset(
        'https://www.example.com/x',
        'https://www.example.com/y',
      ),
      'https://www.example.com/sitemap-b.xml': urlset(
        'https://www.example.com/y',
        'https://www.example.com/z',
      ),
    },
    onBaidu: (urls) => ({
      status: 200,
      body: { success: urls.length, remain: 100, not_same_site: [], not_valid: [] },
    }),
  });

  const resultE = await callApi({
    sitemapUrls: [
      'https://www.example.com/sitemap-a.xml',
      'https://www.example.com/sitemap-b.xml',
    ],
    site: 'www.example.com',
    token: 'test-token',
    excludeUrls: ['https://www.example.com/y'],
  });

  assert(
    baiduCalls.every((call) => !call.urls.includes('https://www.example.com/y')),
    '已提交过的链接不会再次发给百度',
  );
  assert(
    resultE.items?.some(
      (item: { url: string; status: string }) =>
        item.url === 'https://www.example.com/y' && item.status === 'duplicate',
    ),
    '已提交过的链接标记为「未重复提交」',
  );

  globalThis.fetch = originalFetch;
})();
