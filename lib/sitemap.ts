export interface SitemapParseResult {
  /** 解析出的全部 URL（已去重） */
  urls: string[];
  /** 是否为 sitemap 索引（<sitemapindex>） */
  isIndex: boolean;
  /** 展开的子 sitemap 地址 */
  childSitemaps: string[];
  /** 抓取过程中跳过的子 sitemap（超过层级或数量限制） */
  skipped: string[];
}

const FETCH_TIMEOUT_MS = 15_000;
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_DEPTH = 5;
const MAX_CHILD_SITEMAPS = 50;
const MAX_CONCURRENCY = 5;

export class SitemapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SitemapError';
  }
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&')
    .trim();
}

/** 从 XML 文本中提取所有 <loc> 的内容 */
export function extractLocValues(xml: string): string[] {
  const matches = xml.matchAll(/<loc\b[^>]*>([\s\S]*?)<\/loc>/gi);
  const values: string[] = [];
  for (const match of matches) {
    const value = decodeXmlEntities(match[1] ?? '');
    if (value) values.push(value);
  }
  return values;
}

function isSitemapIndex(xml: string): boolean {
  return /<sitemapindex\b/i.test(xml);
}

async function fetchSitemapText(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'user-agent': 'sitemap-submitter/1.0 (+https://github.com/)',
        accept: 'application/xml, text/xml, */*',
      },
      redirect: 'follow',
    });

    if (!response.ok) {
      throw new SitemapError(`抓取 sitemap 失败：HTTP ${response.status} ${response.statusText}`);
    }

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_BYTES) {
      throw new SitemapError('sitemap 内容过大（超过 10 MB），请拆分后再试');
    }

    const bytes = new Uint8Array(buffer);
    // 兼容 .xml.gz 形式的 sitemap（无 Content-Encoding 头的裸 gzip 文件）
    if (bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
      return await decompressGzip(bytes);
    }

    return new TextDecoder('utf-8').decode(bytes);
  } catch (error) {
    if (error instanceof SitemapError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new SitemapError('抓取 sitemap 超时（15 秒）');
    }
    throw new SitemapError(`抓取 sitemap 失败：${(error as Error).message ?? '网络错误'}`);
  } finally {
    clearTimeout(timer);
  }
}

async function decompressGzip(bytes: Uint8Array): Promise<string> {
  const DecompressionStreamCtor = (globalThis as { DecompressionStream?: typeof DecompressionStream })
    .DecompressionStream;
  if (!DecompressionStreamCtor) {
    throw new SitemapError('当前运行环境不支持解压 .gz 格式的 sitemap');
  }
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStreamCtor('gzip'));
    const text = await new Response(stream).text();
    return text;
  } catch {
    throw new SitemapError('解压 .gz 格式的 sitemap 失败');
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]);
    }
  });

  await Promise.all(runners);
  return results;
}

/**
 * 抓取并解析 sitemap，支持 sitemap 索引（<sitemapindex>）的递归展开。
 */
export async function parseSitemap(inputUrl: string): Promise<SitemapParseResult> {
  let rootUrl: string;
  try {
    rootUrl = new URL(inputUrl).toString();
  } catch {
    throw new SitemapError('sitemap 地址不合法，请填写完整的 http(s) 地址');
  }

  const urls = new Set<string>();
  const childSitemaps = new Set<string>();
  const skipped: string[] = [];
  let isIndex = false;

  const visited = new Set<string>();
  const queue: Array<{ url: string; depth: number }> = [{ url: rootUrl, depth: 0 }];

  while (queue.length > 0) {
    const batch = queue.splice(0, MAX_CHILD_SITEMAPS);
    const fetched = await mapWithConcurrency(batch, MAX_CONCURRENCY, async (item) => {
      if (visited.has(item.url)) return null;
      visited.add(item.url);
      const xml = await fetchSitemapText(item.url);
      return { ...item, xml };
    });

    for (const entry of fetched) {
      if (!entry) continue;
      const { url, depth, xml } = entry;

      if (isSitemapIndex(xml)) {
        isIndex = true;
        if (depth >= MAX_DEPTH) {
          skipped.push(url);
          continue;
        }
        const children = extractLocValues(xml);
        for (const child of children) {
          if (childSitemaps.size >= MAX_CHILD_SITEMAPS) {
            skipped.push(child);
            continue;
          }
          if (childSitemaps.has(child)) continue;
          childSitemaps.add(child);
          queue.push({ url: child, depth: depth + 1 });
        }
      } else {
        for (const value of extractLocValues(xml)) {
          urls.add(value);
        }
      }
    }
  }

  return {
    urls: Array.from(urls),
    isIndex,
    childSitemaps: Array.from(childSitemaps),
    skipped,
  };
}

/**
 * 只保留与目标站点同域的 URL。
 * site 既可以是裸域名（www.example.com），也可以是完整 URL（https://www.example.com）。
 */
export function filterBySite(urls: string[], site: string): { kept: string[]; removed: string[] } {
  let siteHost: string | null = null;
  try {
    siteHost = new URL(site.includes('://') ? site : `https://${site}`).hostname.toLowerCase();
  } catch {
    siteHost = null;
  }

  if (!siteHost) return { kept: urls, removed: [] };

  const kept: string[] = [];
  const removed: string[] = [];

  for (const url of urls) {
    try {
      const host = new URL(url).hostname.toLowerCase();
      if (host === siteHost || host.endsWith(`.${siteHost}`)) {
        kept.push(url);
      } else {
        removed.push(url);
      }
    } catch {
      removed.push(url);
    }
  }

  return { kept, removed };
}
