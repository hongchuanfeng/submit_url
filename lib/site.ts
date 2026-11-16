/** 站点（site）参数的规范化与自动推断 */

export type SiteSource = 'input' | 'derived' | 'fallback';

export interface DerivedSite {
  site: string;
  source: SiteSource;
}

/**
 * 规范化 site 参数。
 * 百度只接受裸域名（www.zorezoro.com），传 https://www.zorezoro.com 会返回 "site init fail"。
 */
export function normalizeSite(site: string): string {
  const value = site.trim();
  if (!value) return value;
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`);
    return url.host.toLowerCase();
  } catch {
    return value.toLowerCase().replace(/^\/+|\/+$/g, '');
  }
}

/**
 * 从 sitemap 中解析出的链接里推断站点裸域名：取出现次数最多的域名。
 * 并列时按字典序取第一个，保证结果稳定可复现。
 */
export function deriveSiteFromUrls(urls: string[]): DerivedSite {
  const counter = new Map<string, number>();

  for (const url of urls) {
    try {
      const host = new URL(url).hostname.toLowerCase();
      if (!host) continue;
      counter.set(host, (counter.get(host) ?? 0) + 1);
    } catch {
      // 非法 URL 直接跳过
    }
  }

  let best = '';
  let bestCount = -1;
  for (const [host, count] of counter.entries()) {
    if (count > bestCount || (count === bestCount && best && host < best)) {
      best = host;
      bestCount = count;
    }
  }

  if (best) return { site: best, source: 'derived' };
  return { site: '', source: 'fallback' };
}

/**
 * 站点推断的优先级：
 * 1. 页面填写的 site；
 * 2. sitemap 链接中出现最多的裸域名；
 * 3. sitemap 地址自身的裸域名（链接解析不出来时的兜底）；
 * 4. 环境变量 BAIDU_SITE。
 */
export function resolveSite(
  inputSite: string,
  urls: string[],
  sitemapUrls: string[],
  envSite = '',
): DerivedSite {
  const fromInput = normalizeSite(inputSite);
  if (fromInput) return { site: fromInput, source: 'input' };

  const derived = deriveSiteFromUrls(urls);
  if (derived.site) return derived;

  for (const url of sitemapUrls) {
    try {
      const host = new URL(url).hostname.toLowerCase();
      if (host) return { site: host, source: 'fallback' };
    } catch {
      // 忽略非法地址
    }
  }

  const fromEnv = normalizeSite(envSite);
  if (fromEnv) return { site: fromEnv, source: 'fallback' };

  return { site: '', source: 'fallback' };
}
