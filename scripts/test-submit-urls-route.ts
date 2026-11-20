/**
 * 批量提交 URL 接口的接口级测试（mock fetch，不产生真实推送）
 * 运行：npx tsx scripts/test-submit-urls-route.ts
 */
import { POST } from '../app/api/submit-urls/route';

// 固定使用百度官方地址，避免本机环境变量（BAIDU_ENDPOINT）影响测试
process.env.BAIDU_ENDPOINT = 'http://data.zz.baidu.com/urls';

const originalFetch = globalThis.fetch;
const BAIDU_PREFIX = 'http://data.zz.baidu.com/urls';

interface BaiduCall {
  site: string;
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
  onBaidu: (urls: string[], site: string) => { status: number; body: unknown };
}) {
  const baiduCalls: BaiduCall[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);

    if (url.startsWith(BAIDU_PREFIX)) {
      const urls = String(init?.body ?? '')
        .split('\n')
        .filter(Boolean);
      const site = new URL(url).searchParams.get('site') ?? '';
      baiduCalls.push({ site, urls });
      const { status, body } = options.onBaidu(urls, site);
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('not found', { status: 404, statusText: 'Not Found' });
  }) as typeof fetch;

  return baiduCalls;
}

async function callApi(body: Record<string, unknown>) {
  const request = new Request('http://localhost/api/submit-urls', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const response = await POST(request);
  return (await response.json()) as Record<string, any>;
}

(async () => {
  // 场景一：正常提交，站点留空时自动取出现次数最多的域名
  let baiduCalls = mockFetch({
    onBaidu: (urls) => ({
      status: 200,
      body: { success: urls.length, remain: 900, not_same_site: [], not_valid: [] },
    }),
  });

  const resultA = await callApi({
    urls: [
      'https://www.example.com/a',
      'https://www.example.com/b',
      'https://www.example.com/c',
      'https://www.other.com/x',
    ],
    token: 'test-token',
  });

  assert(resultA.ok === true, '提交成功时返回 ok');
  assert(resultA.site === 'www.example.com', '站点留空时自动取出现次数最多的域名');
  assert(resultA.siteSource === 'derived', '自动推断的站点来源标记为 derived');
  assert(resultA.total === 4, '去重后条数正确');
  assert(resultA.kept === 3, '不同域名的链接被过滤掉 1 条');
  assert(resultA.removed === 1, '被过滤条数正确');
  assert(baiduCalls[0]?.site === 'www.example.com', '按推断出的站点提交');
  assert(
    baiduCalls[0]?.urls.every((url) => url.includes('www.example.com')),
    '只有同站链接被推送给百度',
  );
  assert(resultA.successCount === 3, '成功条数正确');

  // 场景二：页面填写了 site 时以填写的为准
  baiduCalls = mockFetch({
    onBaidu: (urls) => ({
      status: 200,
      body: { success: urls.length, remain: 800, not_same_site: [], not_valid: [] },
    }),
  });

  const resultB = await callApi({
    urls: ['https://www.example.com/a', 'https://www.other.com/x'],
    site: 'https://www.other.com/',
    token: 'test-token',
  });

  assert(resultB.site === 'www.other.com', '填写的 site 被规范化为裸域名');
  assert(resultB.siteSource === 'input', '填写的站点来源标记为 input');
  assert(resultB.kept === 1, '只提交与填写站点同域的链接');
  assert(baiduCalls[0]?.site === 'www.other.com', '按填写的站点提交');

  // 场景三：非法 URL 在本地被拦下，不发给百度
  baiduCalls = mockFetch({
    onBaidu: (urls) => ({
      status: 200,
      body: { success: urls.length, remain: 700, not_same_site: [], not_valid: [] },
    }),
  });

  const resultC = await callApi({
    urls: [
      'https://www.example.com/ok',
      'not-a-url',
      'ftp://www.example.com/bad-protocol',
      'https://www.example.com/ok',
    ],
    token: 'test-token',
  });

  assert(resultC.invalid === 2, '非法 URL 被本地识别');
  assert(resultC.duplicate === 1, '重复 URL 被识别');
  assert(resultC.total === 1, '去重后的有效链接只有 1 条');
  assert(baiduCalls.every((call) => call.urls.every((url) => url === 'https://www.example.com/ok')),
    '非法与重复链接都没有发给百度');
  assert(
    resultC.items?.some((item: { url: string; status: string }) => item.url === 'not-a-url' && item.status === 'not_valid'),
    '非法 URL 在结果中标为 not_valid',
  );
  assert(
    resultC.items?.some((item: { url: string; status: string }) => item.status === 'duplicate'),
    '重复 URL 在结果中标为 duplicate',
  );

  // 场景四：预览模式不调用百度接口
  baiduCalls = mockFetch({
    onBaidu: (urls) => ({
      status: 200,
      body: { success: urls.length, remain: 600, not_same_site: [], not_valid: [] },
    }),
  });

  const resultD = await callApi({
    urls: ['https://www.example.com/a', 'https://www.example.com/b'],
    token: 'test-token',
    dryRun: true,
  });

  assert(resultD.dryRun === true, '预览模式返回 dryRun');
  assert(resultD.ok === true, '预览模式返回 ok');
  assert(baiduCalls.length === 0, '预览模式没有调用百度接口');
  assert(resultD.kept === 2, '预览模式统计待提交条数');
  assert(Array.isArray(resultD.preview) && resultD.preview.length === 2, '预览模式返回将要提交的链接');
  assert(resultD.hosts?.[0]?.host === 'www.example.com', '预览模式返回域名分布');

  // 场景五：配额用尽时保留已成功的结果，其余标记为未提交
  let remain = 3;
  baiduCalls = mockFetch({
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

  const many = Array.from({ length: 10 }, (_, i) => `https://www.example.com/${i}`);
  const resultE = await callApi({
    urls: many,
    token: 'test-token',
  });

  assert(resultE.quotaExhausted === true, '配额用尽时标记 quotaExhausted');
  assert(resultE.successCount === 3, '配额内的链接提交成功');
  assert(
    resultE.items?.filter((item: { status: string }) => item.status === 'quota').length === 7,
    '配额外的链接标记为未提交',
  );
  assert(typeof resultE.warning === 'string' && resultE.warning.includes('配额'), '给出配额用尽的中文提示');

  // 场景六：token 无效时返回中文错误
  baiduCalls = mockFetch({
    onBaidu: () => ({ status: 401, body: { error: 401, message: 'token is not valid' } }),
  });

  const resultF = await callApi({
    urls: ['https://www.example.com/a'],
    token: 'bad-token',
  });

  assert(resultF.ok === false, 'token 无效时返回 ok=false');
  assert(resultF.error?.includes('密钥'), 'token 无效时给出中文说明');
  assert(resultF.status === 401, '透传百度返回的状态码');

  // 场景七：没有 token 时直接拒绝，不调用百度
  baiduCalls = mockFetch({
    onBaidu: (urls) => ({
      status: 200,
      body: { success: urls.length, remain: 500, not_same_site: [], not_valid: [] },
    }),
  });

  const resultG = await callApi({
    urls: ['https://www.example.com/a'],
    token: '',
  });

  assert(resultG.ok === false, '缺少 token 时返回 ok=false');
  assert(resultG.error?.includes('推送密钥'), '缺少 token 时提示填写密钥');
  assert(baiduCalls.length === 0, '缺少 token 时没有调用百度接口');

  // 场景八：没有 URL 时直接拒绝
  const resultH = await callApi({ urls: [], token: 'test-token' });
  assert(resultH.ok === false, '没有 URL 时返回 ok=false');
  assert(resultH.error?.includes('至少填写一个'), '没有 URL 时提示填写');

  globalThis.fetch = originalFetch;
})();
