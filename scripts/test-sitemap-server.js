const http = require('http');

const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>http://localhost:8899/page-1</loc></url>
  <url><loc>http://localhost:8899/page-2</loc></url>
  <url><loc>http://localhost:8899/page-3</loc></url>
</urlset>`;

const index = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>http://localhost:8899/sitemap-a.xml</loc></sitemap>
</sitemapindex>`;

http
  .createServer((req, res) => {
    res.setHeader('Content-Type', 'application/xml');
    if (req.url === '/sitemap.xml') res.end(sitemap);
    else if (req.url === '/sitemap-index.xml') res.end(index);
    else if (req.url === '/sitemap-a.xml') {
      res.end(sitemap.replace('page-3', 'page-4'));
    } else {
      res.statusCode = 404;
      res.end('not found');
    }
  })
  .listen(8899, () => console.log('test sitemap server on 8899'));
