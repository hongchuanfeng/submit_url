'use client';

import { useMemo, useState } from 'react';

interface SubmitFormProps {
  defaultSite: string;
  hasDefaultToken: boolean;
}

type PushItemStatus =
  | 'success'
  | 'not_same_site'
  | 'not_valid'
  | 'rejected'
  | 'quota'
  | 'duplicate'
  | 'error';

interface PushItem {
  url: string;
  status: PushItemStatus;
  message: string;
  sitemap?: string;
}

interface SitemapGroupStat {
  sitemap: string;
  site?: string;
  total: number;
  success: number;
  failed: number;
  unsent: number;
  duplicate: number;
  remain?: number;
  error?: string;
}

interface SitemapItem {
  url: string;
  ok: boolean;
  count: number;
  isIndex: boolean;
  childSitemaps: number;
  skipped: string[];
  error?: string;
}

interface SubmitResult {
  ok: boolean;
  error?: string;
  warning?: string;
  dryRun?: boolean;
  site?: string;
  siteSource?: 'input' | 'derived' | 'fallback';
  sites?: string[];
  sitemaps?: SitemapItem[];
  groups?: SitemapGroupStat[];
  sitemapCount?: number;
  failedSitemaps?: number;
  total?: number;
  kept?: number;
  removed?: number;
  hosts?: Array<{ host: string; count: number }>;
  preview?: string[];
  success?: number;
  remain?: number;
  sent?: number;
  unsent?: number;
  quotaExhausted?: boolean;
  requests?: number;
  items?: PushItem[];
  successCount?: number;
  failedCount?: number;
  duplicateCount?: number;
  notSameSite?: string[];
  notValid?: string[];
  status?: number;
}

const STATUS_LABEL: Record<PushItemStatus, string> = {
  success: '成功',
  not_same_site: '失败',
  not_valid: '失败',
  rejected: '失败',
  quota: '未提交',
  duplicate: '重复',
  error: '未提交',
};

type Filter = 'all' | 'success' | 'failed';

interface Progress {
  current: number;
  total: number;
  sitemap: string;
}

/** 合并多次（每个 sitemap 一次）请求的结果 */
function mergeResults(results: SubmitResult[], errors: string[]): SubmitResult {
  const items = results.flatMap((item) => item.items ?? []);
  const groups = results.flatMap((item) => item.groups ?? []);
  const sitemaps = results.flatMap((item) => item.sitemaps ?? []);
  const sites = Array.from(new Set(results.flatMap((item) => item.sites ?? [])));
  const hostCounter = new Map<string, number>();
  for (const item of results) {
    for (const host of item.hosts ?? []) {
      hostCounter.set(host.host, (hostCounter.get(host.host) ?? 0) + host.count);
    }
  }

  const sum = (pick: (item: SubmitResult) => number | undefined) =>
    results.reduce((acc, item) => acc + (pick(item) ?? 0), 0);

  // 只要有任意一个 sitemap 提交成功，整体就算成功；失败信息单独提示
  const anySuccess = results.some((item) => item.ok);
  const failureNote = errors.length ? `以下 sitemap 提交失败：${errors.join('；')}` : undefined;
  const quotaNote = results.map((item) => item.warning).find(Boolean);

  return {
    ok: anySuccess,
    error: anySuccess ? undefined : (failureNote ?? '所有 sitemap 都未能提交，请查看下方各 sitemap 的失败原因。'),
    warning: [quotaNote, failureNote].filter(Boolean).join('；') || undefined,
    dryRun: results[0]?.dryRun,
    site: sites.length === 1 ? sites[0] : undefined,
    siteSource: results[0]?.siteSource,
    sites,
    sitemaps,
    groups,
    sitemapCount: sitemaps.length,
    failedSitemaps: sum((item) => item.failedSitemaps),
    total: sum((item) => item.total),
    kept: sum((item) => item.kept),
    removed: sum((item) => item.removed),
    hosts: Array.from(hostCounter.entries())
      .map(([host, count]) => ({ host, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10),
    preview: results.flatMap((item) => item.preview ?? []).slice(0, 200),
    success: sum((item) => item.success),
    remain: results[results.length - 1]?.remain ?? 0,
    sent: sum((item) => item.sent),
    unsent: sum((item) => item.unsent),
    quotaExhausted: results.some((item) => item.quotaExhausted),
    requests: sum((item) => item.requests),
    items,
    successCount: items.filter((item) => item.status === 'success').length,
    failedCount: items.filter(
      (item) => item.status !== 'success' && item.status !== 'quota' && item.status !== 'duplicate',
    ).length,
    duplicateCount: items.filter((item) => item.status === 'duplicate').length,
  };
}

export default function SubmitForm({ defaultSite, hasDefaultToken }: SubmitFormProps) {
  const [sitemapText, setSitemapText] = useState('');
  const [site, setSite] = useState(defaultSite);
  const [token, setToken] = useState('');
  const [filterSameSite, setFilterSameSite] = useState(true);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [result, setResult] = useState<SubmitResult | null>(null);
  const [filter, setFilter] = useState<Filter>('all');

  const sitemapUrls = useMemo(
    () =>
      sitemapText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    [sitemapText],
  );

  async function submit(dryRun: boolean) {
    setLoading(true);
    setResult(null);
    setFilter('all');

    const collected: SubmitResult[] = [];
    const errors: string[] = [];
    // 已经推送过的链接：后续 sitemap 跳过，避免重复提交
    const submitted = new Set<string>();

    // 每个 sitemap 单独发起一次请求：
    // 某个 sitemap 失败（额度用尽、接口报错、网络异常）都不会影响后面的 sitemap。
    for (const [index, sitemapUrl] of sitemapUrls.entries()) {
      setProgress({ current: index + 1, total: sitemapUrls.length, sitemap: sitemapUrl });
      try {
        const response = await fetch('/api/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sitemapUrls: [sitemapUrl],
            site,
            token: token || undefined,
            dryRun,
            filterSameSite,
            excludeUrls: Array.from(submitted),
          }),
        });
        const data = (await response.json()) as SubmitResult;
        collected.push(data);
        for (const item of data.items ?? []) {
          // 只有真正发给了百度的链接才计入去重名单（配额用尽 / 接口报错并未提交）
          if (
            item.status === 'success' ||
            item.status === 'rejected' ||
            item.status === 'not_same_site' ||
            item.status === 'not_valid'
          ) {
            submitted.add(item.url);
          }
        }
        if (!data.ok && data.error) {
          errors.push(`${sitemapUrl}：${data.error}`);
        }
      } catch (error) {
        errors.push(`${sitemapUrl}：${(error as Error).message ?? '网络错误'}`);
      }
    }

    setProgress(null);
    setResult(
      collected.length > 0
        ? mergeResults(collected, errors)
        : { ok: false, error: errors.join('；') || '提交失败' },
    );
    setLoading(false);
  }

  const items = result?.items ?? [];
  const visibleItems = useMemo(() => {
    if (filter === 'success') return items.filter((item) => item.status === 'success');
    if (filter === 'failed') return items.filter((item) => item.status !== 'success');
    return items;
  }, [items, filter]);

  const failed = result && result.ok === false;

  return (
    <>
      <section className="card">
        <h2>提交参数</h2>

        <div className="field">
          <label htmlFor="sitemapUrls">
            sitemap 地址
            <span className="hint">
              必填，每行一个，可填写多个；支持 sitemap 索引与 .xml.gz
            </span>
          </label>
          <textarea
            id="sitemapUrls"
            rows={5}
            placeholder={'https://www.example.com/sitemap.xml\nhttps://www.example.com/sitemap-products.xml'}
            value={sitemapText}
            onChange={(event) => setSitemapText(event.target.value)}
          />
          <div className="hint-text">
            已填写 {sitemapUrls.length} 个 sitemap 地址
            {sitemapUrls.length > 1
              ? '（每个 sitemap 逐个提交，某个失败不影响后面的；token 共用）'
              : ''}
          </div>
        </div>

        <div className="row">
          <div className="field">
            <label htmlFor="site">
              站点 site
              <span className="hint">
                可留空，自动取每个 sitemap 链接的裸域名（每个 sitemap 各自推送）
              </span>
            </label>
            <input
              id="site"
              type="text"
              placeholder="留空自动推断，如 www.example.com"
              value={site}
              onChange={(event) => setSite(event.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor="token">
              推送 token
              <span className="hint">
                {hasDefaultToken ? '留空则使用服务端环境变量' : '在搜索资源平台申请（所有 sitemap 共用）'}
              </span>
            </label>
            <input
              id="token"
              type="password"
              placeholder={hasDefaultToken ? '使用环境变量中的 token' : 'xxxxxxxxxxxxxxxx'}
              value={token}
              onChange={(event) => setToken(event.target.value)}
            />
          </div>
        </div>

        <label className="checkbox">
          <input
            type="checkbox"
            checked={filterSameSite}
            onChange={(event) => setFilterSameSite(event.target.checked)}
          />
          过滤掉与 site 不同域名的链接
        </label>

        <div className="actions">
          <button className="ghost" disabled={loading || sitemapUrls.length === 0} onClick={() => submit(true)}>
            仅解析预览
          </button>
          <button
            className="primary"
            disabled={loading || sitemapUrls.length === 0}
            onClick={() => submit(false)}
          >
            {loading ? '处理中…' : '开始提交'}
          </button>
        </div>

        {progress ? (
          <div className="alert info">
            正在处理第 {progress.current}/{progress.total} 个 sitemap：{progress.sitemap}
          </div>
        ) : null}
      </section>

      {result && (
        <section className="card">
          <h2>执行结果</h2>

          {failed ? (
            <div className="alert error">
              {result.error ?? '执行失败'}
              {result.status ? `（HTTP ${result.status}）` : ''}
            </div>
          ) : null}

          {result.warning ? <div className="alert warn">{result.warning}</div> : null}

          {result ? (
            <>
              <div className="stats">
                <div className="stat">
                  <div className="label">推送站点 site</div>
                  <div className="value value-site">
                    {result.sites && result.sites.length > 1
                      ? `${result.sites.length} 个站点（每个 sitemap 各自推送）`
                      : result.site || '—'}
                    {result.siteSource === 'derived' ? (
                      <span className="inline-tag">自动推断</span>
                    ) : result.siteSource === 'fallback' ? (
                      <span className="inline-tag">取自 sitemap 地址</span>
                    ) : null}
                  </div>
                </div>
                <div className="stat">
                  <div className="label">sitemap 数量</div>
                  <div className="value">
                    {result.sitemapCount ?? 0}
                    {result.failedSitemaps ? (
                      <span className="inline-bad">（{result.failedSitemaps} 个失败）</span>
                    ) : null}
                  </div>
                </div>
                <div className="stat">
                  <div className="label">解析链接总数</div>
                  <div className="value">{result.total ?? 0}</div>
                </div>
                <div className="stat">
                  <div className="label">待提交条数</div>
                  <div className="value">{result.kept ?? 0}</div>
                </div>
                {result.dryRun ? (
                  <div className="stat">
                    <div className="label">被过滤（非本站）</div>
                    <div className="value warn">{result.removed ?? 0}</div>
                  </div>
                ) : (
                  <>
                    <div className="stat">
                      <div className="label">推送成功</div>
                      <div className="value ok">{result.successCount ?? result.success ?? 0}</div>
                    </div>
                    <div className="stat">
                      <div className="label">推送失败</div>
                      <div className="value bad">{result.failedCount ?? 0}</div>
                    </div>
                    <div className="stat">
                      <div className="label">当天剩余额度</div>
                      <div className={`value ${result.quotaExhausted ? 'bad' : ''}`}>
                        {result.remain ?? 0}
                      </div>
                    </div>
                  </>
                )}
                {result.removed ? (
                  <div className="stat">
                    <div className="label">被过滤（非本站）</div>
                    <div className="value warn">{result.removed}</div>
                  </div>
                ) : null}
              </div>

              {result.sitemaps && result.sitemaps.length > 0 ? (
                <>
                  <p className="subtitle">各 sitemap 解析情况</p>
                  <ul className="result-list sitemap-list">
                    {result.sitemaps.map((item, index) => (
                      <li key={`${item.url}-${index}`} className={`result-item ${item.ok ? 'success' : 'not_valid'}`}>
                        <span className="badge">{item.ok ? '成功' : '失败'}</span>
                        <span className="result-url">{item.url}</span>
                        <span className="result-message">
                          {item.ok
                            ? `解析 ${item.count} 条${item.isIndex ? `（索引，展开 ${item.childSitemaps} 个子 sitemap）` : ''}`
                            : item.error}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}

              {result.groups && result.groups.length > 0 ? (
                <>
                  <p className="subtitle">各 sitemap 提交情况（逐个提交，某个 sitemap 失败不影响后面的 sitemap）</p>
                  <div className="table-wrap">
                    <table className="group-table">
                      <thead>
                        <tr>
                          <th>sitemap</th>
                          <th>站点</th>
                          <th className="num">链接数</th>
                          <th className="num">成功</th>
                          <th className="num">失败</th>
                          <th className="num">未提交</th>
                          <th className="num">剩余额度</th>
                          <th>说明</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.groups.map((group) => (
                          <tr key={group.sitemap}>
                            <td className="cell-url">{group.sitemap}</td>
                            <td className="cell-url">{group.site || '—'}</td>
                            <td className="num">{group.total}</td>
                            <td className="num ok">{group.success}</td>
                            <td className="num bad">{group.failed}</td>
                            <td className="num warn">{group.unsent}</td>
                            <td className="num">{group.remain ?? '—'}</td>
                            <td className="cell-note">{group.error ?? '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : null}

              {result.hosts && result.hosts.length > 0 ? (
                <>
                  <p className="subtitle">sitemap 链接域名分布</p>
                  <div className="url-list">
                    {result.hosts.map((item) => `${item.host}  ×  ${item.count}`).join('\n')}
                  </div>
                </>
              ) : null}

              {result.dryRun && result.preview && result.preview.length > 0 ? (
                <>
                  <p className="subtitle">链接预览（前 {result.preview.length} 条）</p>
                  <div className="url-list">{result.preview.join('\n')}</div>
                </>
              ) : null}

              {!result.dryRun && items.length > 0 ? (
                <>
                  <p className="subtitle">
                    逐条结果（共 {items.length} 条：成功 {result.successCount ?? 0} 条，失败{' '}
                    {result.failedCount ?? 0} 条，未提交{' '}
                    {items.filter((item) => item.status === 'quota' || item.status === 'error').length}{' '}
                    条，重复 {result.duplicateCount ?? 0} 条）
                  </p>

                  <div className="filter-bar">
                    <button
                      className={filter === 'all' ? 'chip active' : 'chip'}
                      onClick={() => setFilter('all')}
                    >
                      全部 {items.length}
                    </button>
                    <button
                      className={filter === 'success' ? 'chip active' : 'chip'}
                      onClick={() => setFilter('success')}
                    >
                      成功 {items.filter((item) => item.status === 'success').length}
                    </button>
                    <button
                      className={filter === 'failed' ? 'chip active' : 'chip'}
                      onClick={() => setFilter('failed')}
                    >
                      失败 / 未提交{' '}
                      {items.filter((item) => item.status !== 'success' && item.status !== 'duplicate')
                        .length}
                    </button>
                  </div>

                  <ul className="result-list">
                    {visibleItems.map((item, index) => (
                      <li key={`${item.url}-${index}`} className={`result-item ${item.status}`}>
                        <span className="badge">{STATUS_LABEL[item.status]}</span>
                        {item.sitemap ? <span className="result-source">{item.sitemap}</span> : null}
                        <span className="result-url">{item.url}</span>
                        <span className="result-message">{item.message}</span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}

              {!result.dryRun && result.ok && !result.quotaExhausted ? (
                <div className="alert success">推送完成，结果以百度接口返回为准。</div>
              ) : null}
            </>
          ) : null}
        </section>
      )}
    </>
  );
}
