import { NextResponse } from 'next/server';
import { BaiduError, normalizeSite, pushUrls } from '@/lib/baidu';
import { filterBySite, parseSitemap, SitemapError } from '@/lib/sitemap';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface SubmitBody {
  sitemapUrl?: string;
  site?: string;
  token?: string;
  /** true = 仅解析预览，不调用百度 */
  dryRun?: boolean;
  /** 是否按站点过滤非本站 URL，默认 true */
  filterSameSite?: boolean;
}

export async function POST(request: Request) {
  let body: SubmitBody;

  try {
    body = (await request.json()) as SubmitBody;
  } catch {
    return NextResponse.json({ ok: false, error: '请求体不是合法的 JSON' }, { status: 400 });
  }

  const sitemapUrl = (body.sitemapUrl ?? '').trim();
  const rawSite = (body.site ?? process.env.BAIDU_SITE ?? '').trim();
  // 百度只接受裸域名，这里统一规范化，避免 "site init fail"
  const site = normalizeSite(rawSite);
  const token = (body.token ?? process.env.BAIDU_TOKEN ?? '').trim();
  const dryRun = body.dryRun === true;
  const filterSameSite = body.filterSameSite !== false;

  if (!sitemapUrl) {
    return NextResponse.json({ ok: false, error: '请填写 sitemap 地址' }, { status: 400 });
  }

  if (!dryRun && (!site || !token)) {
    return NextResponse.json(
      { ok: false, error: '请填写站点（site）和推送密钥（token），或在环境变量中预置' },
      { status: 400 },
    );
  }

  let parsed: Awaited<ReturnType<typeof parseSitemap>>;
  try {
    parsed = await parseSitemap(sitemapUrl);
  } catch (error) {
    if (error instanceof SitemapError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
    }
    return NextResponse.json(
      { ok: false, error: `解析 sitemap 失败：${(error as Error).message ?? '未知错误'}` },
      { status: 500 },
    );
  }

  const allUrls = parsed.urls;
  const { kept, removed } = filterSameSite
    ? filterBySite(allUrls, site)
    : { kept: allUrls, removed: [] as string[] };

  const hostSummary = summarizeHosts(allUrls);

  if (dryRun) {
    return NextResponse.json({
      ok: true,
      dryRun: true,
      site,
      total: allUrls.length,
      kept: kept.length,
      removed: removed.length,
      isIndex: parsed.isIndex,
      childSitemaps: parsed.childSitemaps.length,
      skipped: parsed.skipped,
      hosts: hostSummary,
      preview: kept.slice(0, 200),
    });
  }

  if (kept.length === 0) {
    return NextResponse.json(
      {
        ok: false,
        error: filterSameSite
          ? `sitemap 中解析出 ${allUrls.length} 条链接，但没有一条与站点 ${site} 同域，已全部被过滤。请确认 site 与 sitemap 中的域名是否一致，或关闭「过滤非本站链接」后再提交。`
          : 'sitemap 中没有解析到任何链接。',
        site,
        total: allUrls.length,
        kept: 0,
        removed: removed.length,
        hosts: hostSummary,
      },
      { status: 400 },
    );
  }

  try {
    const result = await pushUrls(site, token, kept);
    const ok = result.success > 0 || !result.quotaExhausted;
    const warning = result.quotaExhausted
      ? `当日推送配额已用尽，本次仅提交 ${result.sent} 条，剩余 ${result.unsent} 条未提交；配额按天重置，可次日继续推送。`
      : undefined;
    return NextResponse.json({
      ok,
      dryRun: false,
      site,
      error: ok
        ? undefined
        : '当日推送配额已用尽（剩余额度为 0），百度已整批拒绝本次提交；配额按天重置，请次日再试。',
      warning,
      total: allUrls.length,
      kept: kept.length,
      removed: removed.length,
      isIndex: parsed.isIndex,
      childSitemaps: parsed.childSitemaps.length,
      skipped: parsed.skipped,
      hosts: hostSummary,
      success: result.success,
      remain: result.remain,
      sent: result.sent,
      unsent: result.unsent,
      quotaExhausted: result.quotaExhausted,
      requests: result.requests,
      items: result.items,
      failedCount: result.items.filter((item) => item.status !== 'success').length,
      successCount: result.items.filter((item) => item.status === 'success').length,
      notSameSite: result.notSameSite,
      notValid: result.notValid,
    });
  } catch (error) {
    if (error instanceof BaiduError) {
      return NextResponse.json(
        {
          ok: false,
          error: error.message,
          status: error.status,
          baidu: error.result,
          site,
          total: allUrls.length,
          kept: kept.length,
          removed: removed.length,
          hosts: hostSummary,
        },
        { status: error.status >= 400 && error.status < 600 ? error.status : 502 },
      );
    }
    return NextResponse.json(
      { ok: false, error: `推送失败：${(error as Error).message ?? '未知错误'}` },
      { status: 500 },
    );
  }
}

/** 统计 sitemap 中链接的域名分布，便于发现「站点与链接域名不一致」的问题 */
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
