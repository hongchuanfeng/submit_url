/**
 * 「按 sitemap 分组提交」的行为测试（mock fetch，不产生真实推送）
 * 运行：npx tsx scripts/test-push-groups.ts
 */
import { pushUrlGroup } from '../lib/baidu';

// 固定使用百度官方地址，避免本机环境变量（BAIDU_ENDPOINT）影响测试
process.env.BAIDU_ENDPOINT = 'http://data.zz.baidu.com/urls';

const originalFetch = globalThis.fetch;

type Responder = (urls: string[]) => { status: number; body: unknown };

function mock(responder: Responder) {
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const urls = String(init?.body ?? '')
      .split('\n')
      .filter(Boolean);
    const { status, body } = responder(urls);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
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

(async () => {
  // 1. 额度用尽时不抛错，剩余链接标记为未提交，交给调用方继续下一组
  let remain = 3;
  mock((urls) => {
    if (remain <= 0) {
      return { status: 400, body: { error: 400, message: 'over quota' } };
    }
    const used = Math.min(remain, urls.length);
    remain -= used;
    return {
      status: 200,
      body: { success: used, remain, not_same_site: [], not_valid: [] },
    };
  });

  const groupA = await pushUrlGroup('www.example.com', 'token', ['https://www.example.com/1'], {
    sitemap: 'a.xml',
  });
  assert(groupA.quotaExhausted === false, '额度充足时不标记 quotaExhausted');

  // 模拟：第一个 sitemap 有 10 条链接，但额度只够 3 条
  remain = 3;
  const groupB = await pushUrlGroup(
    'www.example.com',
    'token',
    Array.from({ length: 10 }, (_, i) => `https://www.example.com/${i}`),
    { sitemap: 'b.xml', initialRemain: 3 },
  );
  assert(groupB.success === 3, '额度允许的 3 条推送成功');
  assert(groupB.quotaExhausted === true, '额度用尽后标记 quotaExhausted');
  assert(
    groupB.items.filter((item) => item.status === 'quota').length === 7,
    '剩余 7 条标记为未提交',
  );
  assert(groupB.items.every((item) => item.sitemap === 'b.xml'), '每条结果都带上来源 sitemap');

  // 2. 额度耗尽后提交下一组：仍然会发起请求，被拒绝后整组标记未提交
  remain = 0;
  const groupC = await pushUrlGroup(
    'www.example.com',
    'token',
    ['https://www.example.com/x', 'https://www.example.com/y'],
    { sitemap: 'c.xml', initialRemain: 0 },
  );
  assert(groupC.quotaExhausted === true, '额度为 0 的下一组同样标记 quotaExhausted');
  assert(
    groupC.items.every((item) => item.status === 'quota'),
    '下一组的链接全部标记为未提交（而不是被跳过）',
  );
  assert(groupC.items.length === 2, '下一组的链接仍然出现在结果中');

  // 3. 接口报错时抛出，由调用方决定是否继续下一组
  mock(() => ({ status: 401, body: { error: 401, message: 'token is not valid' } }));
  let threw = false;
  try {
    await pushUrlGroup('www.example.com', 'token', ['https://www.example.com/1']);
  } catch {
    threw = true;
  }
  assert(threw, '非配额类错误（如 token 无效）会抛给调用方处理');

  // 4. 正常分组：成功与失败逐条归因
  mock((urls) => ({
    status: 200,
    body: {
      success: Math.max(0, urls.length - 1),
      remain: 100,
      not_same_site: urls.filter((url) => url.includes('other.com')),
      not_valid: urls.filter((url) => url.includes('/bad')),
    },
  }));
  const groupD = await pushUrlGroup(
    'www.example.com',
    'token',
    ['https://www.example.com/ok', 'https://other.com/x', 'https://www.example.com/bad'],
    { sitemap: 'd.xml' },
  );
  assert(groupD.success === 1, '成功条数与百度返回一致');
  assert(
    groupD.items.find((item) => item.url === 'https://other.com/x')?.status === 'not_same_site',
    '非本站链接单独归因',
  );
  assert(
    groupD.items.find((item) => item.url === 'https://www.example.com/bad')?.status === 'not_valid',
    '不合法链接单独归因',
  );

  globalThis.fetch = originalFetch;
})();
