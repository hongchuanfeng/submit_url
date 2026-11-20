import { NextResponse } from 'next/server';
import { BaiduError, pushUrlGroup } from '@/lib/baidu';
import { filterBySite } from '@/lib/sitemap';
import { deriveSiteFromUrls, normalizeSite, SiteSource } from '@/lib/site';
import { parseUrlList } from '@/lib/urls';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface SubmitUrlsBody {
  /** 待提交的 URL 列表：数组或换行分隔的多行字符串 */
  urls?: string[] | string;
  /** 推送站点（裸域名），留空则自动取出现次数最多的域名 */
  site?: string;
  /** 推送密钥，留空则用服务端环境变量 */
  token?: string;
  /** true = 仅本地校验与预览，不调用百度 */
  dryRun?: boolean;
  /** 是否过滤掉与 site 不同域名的链接，默认 true */
  filterSameSite?: boolean;
}

/** 单条 URL 的推送结果（与 sitemap 模式保持一致的状态集合） */
interface UrlItem {
  url: string;
  status: 'success' | 'not_same_site' | 'not_valid' | 'rejected' | 'quota' | 'duplicate' | 'error';
  message: string;
}

/** 统计 URL 的域名分布，便于核对站点是否填对 */
function summarizeHosts(urls: string[]): Array<{ host: string; count: number }> {
  const counter = new Map<string, number>();
  for (const url of urls) {
    try {
      const host = new URL(url).hostname.toLowerCase();
      counter.set(host, (counter.get(host) ?? 0) + 1);
    } catch {
      counter.set('(非法 URL)', (counter.get('(非法 URL)') ?? 0) + 1);
    }
  }
  return Array.from(counter.entries())
    .map(([host, count]) => ({ host, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
}

export async function POST(request: Request) {
  let body: SubmitUrlsBody;

  try {
    body = (await request.json()) as SubmitUrlsBody;
  } catch {
    return NextResponse.json({ ok: false, error: '请求体不是合法的 JSON' }, { status: 400 });
  }

  const token = (body.token ?? process.env.BAIDU_TOKEN ?? '').trim();
  const dryRun = body.dryRun === true;
  const filterSameSite = body.filterSameSite !== false;

  const parsed = parseUrlList(body.urls);

  if (parsed.inputCount === 0) {
    return NextResponse.json({ ok: false, error: '请至少填写一个要提交的 URL' }, { status: 400 });
  }

  // 站点：页面填写的优先；留空则取出现次数最多的域名
  const explicitSite = normalizeSite(body.site ?? '');
  const derived = explicitSite
    ? { site: explicitSite, source: 'input' as SiteSource }
    : deriveSiteFromUrls(parsed.urls);

  const site = derived.site;
  const siteSource: SiteSource = derived.source;

  if (!site) {
    return NextResponse.json(
      {
        ok: false,
        error: '无法确定推送站点：填写的 URL 中没有可识别的域名。请手动填写站点（裸域名，如 www.example.com）。',
      },
      { status: 400 },
    );
  }

  // 非法 URL 在本地就拦下，不占用百度配额
  const invalidItems: UrlItem[] = parsed.entries
    .filter((entry) => entry.kind === 'invalid')
    .map((entry) => ({
      url: entry.url,
      status: 'not_valid' as const,
      message: `未提交：${entry.reason}`,
    }));

  // 重复 URL 只提交一次
  const duplicateItems: UrlItem[] = parsed.entries
    .filter((entry) => entry.kind === 'duplicate')
    .map((entry) => ({
      url: entry.url,
      status: 'duplicate' as const,
      message: '未重复提交：与前面填写的链接重复',
    }));

  const validUrls = parsed.urls;
  const { kept, removed } = filterSameSite
    ? filterBySite(validUrls, site)
    : { kept: validUrls, removed: [] as string[] };

  const removedItems: UrlItem[] = removed.map((url) => ({
    url,
    status: 'not_same_site' as const,
    message: `未提交：与站点 ${site} 不同域名，已被过滤`,
  }));

  const base = {
    site,
    siteSource,
    sites: [site],
    total: validUrls.length,
    inputCount: parsed.inputCount,
    kept: kept.length,
    removed: removed.length,
    invalid: invalidItems.length,
    duplicate: duplicateItems.length,
    hosts: summarizeHosts(validUrls),
    groups: [
      {
        site,
        siteSource,
        total: validUrls.length,
        kept: kept.length,
        removed: removed.length,
        success: 0,
        failed: 0,
        unsent: 0,
        duplicate: duplicateItems.length,
      },
    ],
  };

  if (dryRun) {
    return NextResponse.json({
      ...base,
      ok: true,
      dryRun: true,
      preview: kept.slice(0, 200),
      items: [...invalidItems, ...duplicateItems, ...removedItems].slice(0, 200),
      successCount: 0,
      failedCount: invalidItems.length + removedItems.length,
      duplicateCount: duplicateItems.length,
    });
  }

  if (!token) {
    return NextResponse.json(
      { ...base, ok: false, error: '请填写推送密钥（token），或在环境变量中预置' },
      { status: 400 },
    );
  }

  if (kept.length === 0) {
    const detail = invalidItems.length
      ? `其中 ${invalidItems.length} 条不是合法 URL`
      : removed.length
        ? `其中 ${removed.length} 条与站点 ${site} 不同域名，已被过滤`
        : '没有可提交的链接';
    return NextResponse.json(
      {
        ...base,
        ok: false,
        error: `没有可提交的链接：${detail}。请检查 URL 格式，或关闭「过滤非本站链接」后再提交。`,
        items: [...invalidItems, ...duplicateItems, ...removedItems],
        successCount: 0,
        failedCount: invalidItems.length + removedItems.length,
        duplicateCount: duplicateItems.length,
      },
      { status: 400 },
    );
  }

  // 提交到百度：额度感知的分批、逐条归因都在 pushUrlGroup 里完成
  let result: Awaited<ReturnType<typeof pushUrlGroup>>;
  try {
    result = await pushUrlGroup(site, token, kept);
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误';
    const status = error instanceof BaiduError ? error.status : 502;
    return NextResponse.json(
      {
        ...base,
        ok: false,
        error: message,
        status,
        items: [
          ...invalidItems,
          ...duplicateItems,
          ...removedItems,
          ...kept.map((url) => ({
            url,
            status: 'error' as const,
            message: `未提交：${message}`,
          })),
        ],
        successCount: 0,
        failedCount: kept.length + invalidItems.length + removedItems.length,
        duplicateCount: duplicateItems.length,
        remain: 0,
        sent: 0,
        unsent: kept.length,
        quotaExhausted: false,
        requests: 0,
      },
      { status: status >= 400 && status < 600 ? status : 502 },
    );
  }

  const items: UrlItem[] = [
    ...invalidItems,
    ...duplicateItems,
    ...removedItems,
    ...result.items.map((item) => ({
      url: item.url,
      status: item.status,
      message: item.message,
    })),
  ];

  const successCount = items.filter((item) => item.status === 'success').length;
  const failedCount = items.filter(
    (item) => item.status !== 'success' && item.status !== 'quota' && item.status !== 'duplicate',
  ).length;
  const unsentCount = items.filter((item) => item.status === 'quota').length;

  const ok = successCount > 0 || !result.quotaExhausted;

  return NextResponse.json({
    ...base,
    ok,
    error: ok ? undefined : '没有链接推送成功，请查看下方失败原因。',
    warning: result.quotaExhausted
      ? `当日推送配额已用尽：已提交 ${result.sent} 条，${unsentCount} 条因配额未提交；配额按天重置，可次日继续推送。`
      : undefined,
    groups: [
      {
        ...base.groups[0],
        success: result.items.filter((item) => item.status === 'success').length,
        failed: result.items.filter(
          (item) => item.status !== 'success' && item.status !== 'quota',
        ).length,
        unsent: unsentCount,
      },
    ],
    items,
    successCount,
    failedCount,
    duplicateCount: duplicateItems.length,
    success: result.success,
    remain: result.remain,
    sent: result.sent,
    unsent: unsentCount,
    quotaExhausted: result.quotaExhausted,
    requests: result.requests,
  });
}
