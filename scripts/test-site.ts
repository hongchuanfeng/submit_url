/**
 * 站点推断测试
 * 运行：npx tsx scripts/test-site.ts
 */
import { normalizeSite, deriveSiteFromUrls, resolveSite } from '../lib/site';

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS: ${message}`);
  }
}

(async () => {
  // 1. 规范化
  assert(normalizeSite('https://www.zorezoro.com') === 'www.zorezoro.com', '去掉协议头');
  assert(normalizeSite('http://www.zorezoro.com/') === 'www.zorezoro.com', '去掉尾部斜杠');
  assert(normalizeSite('WWW.Example.com') === 'www.example.com', '转小写');
  assert(normalizeSite('  ') === '', '空字符串保持为空');

  // 2. 从链接推断裸域名
  const derived = deriveSiteFromUrls([
    'https://www.example.com/a',
    'https://www.example.com/b',
    'https://www.example.com/c',
    'https://other.com/d',
  ]);
  assert(derived.site === 'www.example.com', '取出现次数最多的域名');
  assert(derived.source === 'derived', '来源标记为自动推断');

  const mixed = deriveSiteFromUrls(['https://a.com/1', 'https://b.com/1']);
  assert(mixed.site === 'a.com', '数量并列时取字典序靠前的域名，结果稳定');

  assert(deriveSiteFromUrls([]).site === '', '没有链接时返回空');

  // 3. 优先级：页面填写 > 自动推断 > sitemap 地址 > 环境变量
  const byInput = resolveSite('https://manual.com', ['https://auto.com/1'], ['https://s.com/sitemap.xml']);
  assert(byInput.site === 'manual.com' && byInput.source === 'input', '页面填写的 site 优先');

  const byDerived = resolveSite('', ['https://auto.com/1'], ['https://s.com/sitemap.xml']);
  assert(byDerived.site === 'auto.com' && byDerived.source === 'derived', '未填写时自动推断');

  const bySitemap = resolveSite('', [], ['https://s.com/sitemap.xml']);
  assert(bySitemap.site === 's.com' && bySitemap.source === 'fallback', '链接为空时取 sitemap 地址域名');

  const byEnv = resolveSite('', [], [], 'https://env.com');
  assert(byEnv.site === 'env.com' && byEnv.source === 'fallback', '都拿不到时用环境变量');

  assert(resolveSite('', [], []).site === '', '全部为空时返回空站点');
})();
