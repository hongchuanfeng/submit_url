import { NextResponse } from 'next/server';
import { BaiduError, pushUrlGroup } from '@/lib/baidu';
import { filterBySite, parseSitemapBatch, SitemapError } from '@/lib/sitemap';
import { deriveSiteFromUrls, normalizeSite, SiteSource } from '@/lib/site';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface SubmitBody {
  /** 单个 sitemap 地址（兼容旧写法） */
  sitemapUrl?: string;
  /** 多个 sitemap 地址 */
  sitemapUrls?: string[] | string;
  site?: string;
  token?: string;
  /** true = 仅解析预览，不调用百度 */
  dryRun?: boolean;
  /** 是否按站点过滤非本站 URL，默认 true */
  filterSameSite?: boolean;
  /** 已经提交过的链接：本次跳过，避免跨 sitemap 重复推送 */
  excludeUrls?: string[];
}

/** 从请求体中解析出 sitemap 地址列表：支持数组、换行分隔的多行字符串、以及单个地址 */
function collectSitemapUrls(body: SubmitBody): string[] {
  const raw: string[] = [];

  if (Array.isArray(body.sitemapUrls)) {
    raw.push(...body.sitemapUrls);
  } else if (typeof body.sitemapUrls === 'string') {
    raw.push(...body.sitemapUrls.split(/\r?\n/));
  }

  if (body.sitemapUrl) {
    raw.push(...body.sitemapUrl.split(/\r?\n/));
  }

  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of raw) {
    const value = (item ?? '').trim();
    if (!value) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

/** 单个 sitemap 分组的站点信息 */
interface GroupPlan {
  sitemap: string;
  site: string;
  siteSource: SiteSource;
  /** 该 sitemap 中参与提交的链接（已按站点过滤） */
  urls: string[];
  /** 该 sitemap 中被过滤掉的链接 */
  removed: string[];
}

export async function POST(request: Request) {
  let body: SubmitBody;

  try {
    body = (await request.json()) as SubmitBody;
  } catch {
    return NextResponse.json({ ok: false, error: '请求体不是合法的 JSON' }, { status: 400 });
  }

  const sitemapUrls = collectSitemapUrls(body);
  const inputSite = (body.site ?? '').trim();
  const token = (body.token ?? process.env.BAIDU_TOKEN ?? '').trim();
  const dryRun = body.dryRun === true;
  const filterSameSite = body.filterSameSite !== false;

  if (sitemapUrls.length === 0) {
    return NextResponse.json({ ok: false, error: '请至少填写一个 sitemap 地址' }, { status: 400 });
  }

  let parsed: Awaited<ReturnType<typeof parseSitemapBatch>>;
  try {
    parsed = await parseSitemapBatch(sitemapUrls);
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
  const explicitSite = normalizeSite(inputSite);
  // 之前已经提交过的链接（跨 sitemap 去重）
  const excluded = new Set((body.excludeUrls ?? []).map((url) => url.trim()).filter(Boolean));

  // 每个 sitemap 独立确定站点：
  // - 页面填写了 site → 所有 sitemap 都用这个站点；
  // - 留空 → 每个 sitemap 用自己解析出的链接推断站点（多数域名优先），
  //   这样不同域名的 sitemap 可以各自推送给百度，互不影响。
  const plans: GroupPlan[] = parsed.groups.map((group) => {
    const derived = explicitSite
      ? { site: explicitSite, source: 'input' as SiteSource }
      : deriveSiteFromUrls(group.urls);

    let site = derived.site;
    let siteSource: SiteSource = derived.source;

    if (!site) {
      try {
        const host = new URL(group.sitemap).hostname.toLowerCase();
        if (host) {
          site = host;
          siteSource = 'fallback';
        }
      } catch {
        // 忽略非法地址
      }
    }

    if (!site) {
      const envSite = normalizeSite(process.env.BAIDU_SITE ?? '');
      if (envSite) {
        site = envSite;
        siteSource = 'fallback';
      }
    }

    const { kept, removed } = filterSameSite
      ? filterBySite(group.urls, site)
      : { kept: group.urls, removed: [] as string[] };

    return { sitemap: group.sitemap, site, siteSource, urls: kept, removed };
  });

  // 待提交链接：跨 sitemap 去重后（同一个链接只在第一个包含它的 sitemap 中提交一次）
  const keptSet = new Set<string>();
  for (const plan of plans) {
    for (const url of plan.urls) {
      if (excluded.has(url)) continue;
      keptSet.add(url);
    }
  }
  const kept = Array.from(keptSet);
  const removed = plans.flatMap((plan) => plan.removed);
  const hostSummary = summarizeHosts(allUrls);
  const sitemaps = parsed.items;

  // 汇总使用的站点（多站点时给出提示）
  const siteSet = Array.from(new Set(plans.map((plan) => plan.site).filter(Boolean)));
  const site = siteSet.length === 1 ? siteSet[0] : '';
  const siteSource: SiteSource = explicitSite
    ? 'input'
    : siteSet.length === 1
      ? (plans.find((plan) => plan.site === site)?.siteSource ?? 'derived')
      : 'derived';

  if (!dryRun && !token) {
    return NextResponse.json(
      { ok: false, error: '请填写推送密钥（token），或在环境变量中预置' },
      { status: 400 },
    );
  }

  const missingSite = plans.filter((plan) => !plan.site);
  if (!dryRun && missingSite.length > 0) {
    return NextResponse.json(
      {
        ok: false,
        error: `无法确定推送站点：${missingSite
          .map((plan) => plan.sitemap)
          .join('、')}。请手动填写站点（裸域名，如 www.example.com）。`,
        sitemaps,
        sitemapCount: sitemaps.length,
        failedSitemaps: parsed.failed,
      },
      { status: 400 },
    );
  }

  if (dryRun) {
    return NextResponse.json({
      ok: true,
      dryRun: true,
      site: site || undefined,
      siteSource,
      sites: siteSet,
      sitemaps,
      sitemapCount: sitemaps.length,
      failedSitemaps: parsed.failed,
      groups: plans.map((plan) => ({
        sitemap: plan.sitemap,
        site: plan.site,
        siteSource: plan.siteSource,
        total: plan.urls.length,
        removed: plan.removed.length,
        success: 0,
        failed: 0,
        unsent: 0,
        duplicate: 0,
      })),
      total: allUrls.length,
      kept: kept.length,
      removed: removed.length,
      hosts: hostSummary,
      preview: kept.slice(0, 200),
    });
  }

  // kept 已排除「之前提交过」的链接：若剩下的都是重复链接，说明本次无需再推送
  if (kept.length === 0) {
    // 判断是「全部被站点过滤掉」还是「全部此前已提交过」
    const allPlanUrls = plans.flatMap((plan) => plan.urls);
    const onlyDuplicates = allPlanUrls.length > 0 && allPlanUrls.every((url) => excluded.has(url));
    const failedDetail = sitemaps
      .filter((item) => !item.ok)
      .map((item) => `${item.url}（${item.error}）`)
      .join('、');
    return NextResponse.json(
      {
        ok: onlyDuplicates,
        error: onlyDuplicates
          ? undefined
          : failedDetail
            ? `所有 sitemap 都解析失败：${failedDetail}`
            : filterSameSite
              ? `sitemap 中解析出 ${allUrls.length} 条链接，但没有一条与所属站点同域，已全部被过滤。请确认 site 与 sitemap 中的域名是否一致，或关闭「过滤非本站链接」后再提交。`
              : 'sitemap 中没有解析到任何链接。',
        warning: onlyDuplicates
          ? `本次 sitemap 的 ${allUrls.length} 条链接此前都已提交过，无需重复推送。`
          : undefined,
        site: site || undefined,
        siteSource,
        sites: siteSet,
        sitemaps,
        sitemapCount: sitemaps.length,
        failedSitemaps: parsed.failed,
        groups: plans.map((plan) => ({
          sitemap: plan.sitemap,
          site: plan.site,
          total: plan.urls.length,
          success: 0,
          failed: 0,
          unsent: 0,
          duplicate: plan.urls.filter((url) => excluded.has(url)).length,
          error: plan.urls.length
            ? '该 sitemap 的链接与所属站点不同域，已全部被过滤'
            : '该 sitemap 没有可提交的链接',
        })),
        total: allUrls.length,
        kept: 0,
        removed: removed.length,
        hosts: hostSummary,
      },
      { status: onlyDuplicates ? 200 : 400 },
    );
  }

  // 按 sitemap 分组逐个提交：某个 sitemap 因额度用尽或接口报错而失败时，
  // 不影响后面的 sitemap 继续提交。
  const items: Awaited<ReturnType<typeof pushUrlGroup>>['items'] = [];
  const groupStats: Array<{
    sitemap: string;
    site: string;
    total: number;
    success: number;
    failed: number;
    unsent: number;
    duplicate: number;
    remain?: number;
    error?: string;
  }> = [];

  // 跨 sitemap 去重：同一个链接只在第一个包含它的 sitemap 中提交一次
  // （excluded 是之前请求已经提交过的链接，同样不再重复推送）
  const submitted = new Set<string>(excluded);
  // 百度配额按站点计算，因此每个站点单独记录剩余额度
  const remainBySite = new Map<string, number>();

  let success = 0;
  let sent = 0;
  let requests = 0;
  let remain = 0;
  let quotaExhausted = false;
  let firstError: { message: string; status: number } | undefined;

  for (const plan of plans) {
    const groupUrls = plan.urls;
    if (groupUrls.length === 0) {
      groupStats.push({
        sitemap: plan.sitemap,
        site: plan.site,
        total: 0,
        success: 0,
        failed: 0,
        unsent: 0,
        duplicate: 0,
        error: plan.removed.length
          ? `该 sitemap 的 ${plan.removed.length} 条链接与站点 ${plan.site || '未知'} 不同域，已全部过滤`
          : '该 sitemap 没有可提交的链接',
      });
      continue;
    }

    const duplicated = groupUrls.filter((url) => submitted.has(url));
    const toPush = groupUrls.filter((url) => !submitted.has(url));
    for (const url of toPush) submitted.add(url);

    for (const url of duplicated) {
      items.push({
        url,
        status: 'duplicate',
        message: '未重复提交：已在其它 sitemap 中提交',
        sitemap: plan.sitemap,
      });
    }

    if (toPush.length === 0) {
      groupStats.push({
        sitemap: plan.sitemap,
        site: plan.site,
        total: groupUrls.length,
        success: 0,
        failed: 0,
        unsent: 0,
        duplicate: duplicated.length,
        error: undefined,
      });
      continue;
    }

    try {
      const result = await pushUrlGroup(plan.site, token, toPush, {
        sitemap: plan.sitemap,
        initialRemain: remainBySite.get(plan.site) ?? 0,
      });

      items.push(...result.items);
      success += result.success;
      sent += result.sent;
      requests += result.requests;
      remainBySite.set(plan.site, result.remain);
      if (siteSet.length === 1) remain = result.remain;
      if (result.quotaExhausted) quotaExhausted = true;

      groupStats.push({
        sitemap: plan.sitemap,
        site: plan.site,
        total: groupUrls.length,
        success: result.items.filter((item) => item.status === 'success').length,
        failed: result.items.filter((item) => item.status !== 'success' && item.status !== 'quota')
          .length,
        unsent: result.items.filter((item) => item.status === 'quota').length,
        duplicate: duplicated.length,
        remain: result.remain,
        error: result.quotaExhausted ? '当日配额已用尽，本 sitemap 剩余链接未提交' : undefined,
      });
    } catch (error) {
      // 这个 sitemap 提交失败（例如网络异常、token 失效），记录后继续提交下一个
      const message = error instanceof Error ? error.message : '未知错误';
      const status = error instanceof BaiduError ? error.status : 502;
      firstError = firstError ?? { message, status };

      for (const url of toPush) {
        items.push({ url, status: 'error', message: `未提交：${message}`, sitemap: plan.sitemap });
      }
      groupStats.push({
        sitemap: plan.sitemap,
        site: plan.site,
        total: groupUrls.length,
        success: 0,
        failed: toPush.length,
        unsent: toPush.length,
        duplicate: duplicated.length,
        error: message,
      });
    }
  }

  const successCount = items.filter((item) => item.status === 'success').length;
  const failedCount = items.filter(
    (item) => item.status !== 'success' && item.status !== 'quota' && item.status !== 'duplicate',
  ).length;
  const unsentCount = items.filter((item) => item.status === 'quota').length;
  const duplicateCount = items.filter((item) => item.status === 'duplicate').length;

  // 所有 sitemap 都因为同一个错误失败时，才把错误作为整体失败返回
  if (successCount === 0 && firstError) {
    return NextResponse.json(
      {
        ok: false,
        error: firstError.message,
        status: firstError.status,
        site: site || undefined,
        siteSource,
        sites: siteSet,
        sitemaps,
        sitemapCount: sitemaps.length,
        failedSitemaps: parsed.failed,
        groups: groupStats,
        total: allUrls.length,
        kept: kept.length,
        removed: removed.length,
        hosts: hostSummary,
        success: 0,
        remain,
        sent,
        unsent: unsentCount,
        items,
        successCount: 0,
        failedCount,
        duplicateCount,
        quotaExhausted,
        requests,
      },
      { status: firstError.status >= 400 && firstError.status < 600 ? firstError.status : 502 },
    );
  }

  const ok = successCount > 0 || !firstError;
  const quotaGroups = groupStats.filter((group) => group.error?.includes('配额')).length;

  return NextResponse.json({
    ok,
    dryRun: false,
    site: site || undefined,
    siteSource,
    sites: siteSet,
    error: ok ? undefined : '所有 sitemap 都未能提交，请查看下方各 sitemap 的失败原因。',
    warning: quotaExhausted
      ? `当日推送配额已用尽：已提交 ${sent} 条，${unsentCount} 条因配额未提交${quotaGroups ? `（涉及 ${quotaGroups} 个 sitemap）` : ''}；配额按天重置，可次日继续推送。`
      : undefined,
    sitemaps,
    sitemapCount: sitemaps.length,
    failedSitemaps: parsed.failed,
    groups: groupStats,
    total: allUrls.length,
    kept: kept.length,
    removed: removed.length,
    hosts: hostSummary,
    success,
    remain,
    sent,
    unsent: unsentCount,
    quotaExhausted,
    requests,
    items,
    successCount,
    failedCount,
    duplicateCount,
  });
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
