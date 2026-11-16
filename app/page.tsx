import SubmitForm from '@/components/SubmitForm';

export const dynamic = 'force-dynamic';

export default function HomePage() {
  return (
    <main className="page">
      <header className="header">
        <h1>sitemap 批量提交到百度</h1>
        <p>
          输入 sitemap.xml 的地址（可多行填写多个），自动解析其中的全部链接，并按每行一条的格式提交到百度搜索资源平台的链接推送接口。
        </p>
      </header>

      <SubmitForm
        defaultSite=""
        hasDefaultToken={Boolean(process.env.BAIDU_TOKEN)}
      />

      <p className="footer">
        推送站点（site）默认自动取 sitemap 链接的裸域名，填了则以填写的为准。
        <br />
        单次推送最多 2000 条链接，超出后自动分批提交；提交前可先「仅解析预览」确认链接数量。
        <br />
        推送密钥只保存在服务端环境变量中（<code>BAIDU_TOKEN</code>），不会返回到浏览器。
      </p>
    </main>
  );
}
