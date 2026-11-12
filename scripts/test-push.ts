/**
 * 百度推送客户端的单元测试（用 mock 替换 fetch，不产生真实推送）
 * 运行：npm test
 */
import { pushUrls, normalizeSite, explainBaiduError } from '../lib/baidu';

type Responder = (urls: string[]) => { status: number; body: unknown };

const originalFetch = globalThis.fetch;

function mock(responder: Responder) {
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = String(init?.body ?? '');
    const urls = body.split('\n').filter(Boolean);
    const { status, body: payload } = responder(urls);
    return new Response(JSON.stringify(payload), {
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

/** 模拟百度：非 other.com 的、且不是 bad 的链接都算成功，并按成功条数扣减剩余额度 */
function makeQuotaMock(initialRemain: number) {
  let remain = initialRemain;
  return (urls: string[]) => {
    const notSame = urls.filter((url) => url.includes('other.com'));
    const notValid = urls.filter((url) => url.includes('/bad'));
    const success = urls.length - notSame.length - notValid.length;
    remain = Math.max(0, remain - success);
    return {
      status: 200,
      body: { success, remain, not_same_site: notSame, not_valid: notValid },
    };
  };
}

(async () => {
  // 1. site 规范化
  assert(normalizeSite('https://www.zorezoro.com') === 'www.zorezoro.com', 'site 去掉协议头');
  assert(normalizeSite('http://www.zorezoro.com/') === 'www.zorezoro.com', 'site 去掉尾部斜杠');
  assert(normalizeSite('WWW.Example.com') === 'www.example.com', 'site 转小写');

  // 2. 配额为 0：探测即被拒
  mock(() => ({ status: 400, body: { error: 400, message: 'over quota' } }));
  const exhausted = await pushUrls('www.example.com', 'token', ['https://www.example.com/a']);
  assert(exhausted.success === 0 && exhausted.quotaExhausted, '配额为 0 时标记 quotaExhausted');
  assert(exhausted.unsent === 1 && exhausted.sent === 0, '配额为 0 时全部未提交');
  assert(
    exhausted.items[0]?.status === 'quota',
    '配额为 0 时逐条结果标记为 quota（未提交）',
  );

  // 3. 配额不足：已提交部分成功，其余标记为未提交
  mock(makeQuotaMock(3));
  const partial = await pushUrls(
    'www.example.com',
    'token',
    Array.from({ length: 10 }, (_, i) => `https://www.example.com/${i}`),
  );
  assert(partial.sent === 3, '只提交了配额允许的 3 条');
  assert(partial.unsent === 7 && partial.quotaExhausted, '剩余条数标记为未提交并标记配额耗尽');
  assert(
    partial.items.filter((item) => item.status === 'quota').length === 7,
    '逐条结果中未提交的条数为 7',
  );

  // 4. 正常推送：逐条成功 / 失败都能落到具体 URL
  mock(makeQuotaMock(100));
  const attributed = await pushUrls(
    'www.example.com',
    'token',
    [
      'https://www.example.com/ok',
      'https://other.com/x',
      'https://www.example.com/bad',
      'https://www.example.com/ok2',
    ],
  );
  assert(attributed.items.length === 4, '逐条结果条数与提交条数一致');
  assert(
    attributed.items.find((item) => item.url === 'https://other.com/x')?.status === 'not_same_site',
    '非本站链接被标记为 not_same_site',
  );
  assert(
    attributed.items.find((item) => item.url === 'https://www.example.com/bad')?.status === 'not_valid',
    '不合法链接被标记为 not_valid',
  );
  assert(
    attributed.items.filter((item) => item.status === 'success').length === attributed.success,
    '逐条成功数与百度返回的 success 一致',
  );
  assert(attributed.items.every((item) => item.message.length > 0), '每条结果都带中文说明');

  // 5. 中途配额被抢空：保留已成功的结果
  let call = 0;
  mock((urls) => {
    call += 1;
    if (call === 1) {
      return { status: 200, body: { success: urls.length, remain: 5, not_same_site: [], not_valid: [] } };
    }
    return { status: 400, body: { error: 400, message: 'over quota' } };
  });
  const interrupted = await pushUrls(
    'www.example.com',
    'token',
    Array.from({ length: 20 }, (_, i) => `https://www.example.com/${i}`),
  );
  assert(interrupted.success === 1, '中途失败时保留已成功的条数');
  assert(interrupted.quotaExhausted && interrupted.unsent === 19, '中途失败时未提交条数正确');

  // 6. 错误文案可读
  assert(explainBaiduError('over quota').includes('配额'), 'over quota 有中文解释');
  assert(explainBaiduError('site init fail').includes('裸域名'), 'site init fail 有中文解释');
  assert(explainBaiduError('site error').includes('不匹配'), 'site error 有中文解释');
  assert(explainBaiduError('token is not valid').includes('密钥'), 'token 错误有中文解释');

  globalThis.fetch = originalFetch;
})();
