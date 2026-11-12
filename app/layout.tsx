import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'sitemap 批量提交到百度',
  description: '输入 sitemap.xml 地址，解析其中的 URL 并批量推送到百度搜索资源平台',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
