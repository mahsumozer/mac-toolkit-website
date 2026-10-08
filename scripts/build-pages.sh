#!/bin/sh
set -eu

rm -rf public
mkdir -p public/assets

cp CNAME public/
cp favicon.ico public/
cp _headers public/
cp _redirects public/
cp accessibility.html public/
cp app.js public/
cp cleanshot-x-alternative.html public/
cp istat-menus-alternative.html public/
cp paste-app-alternative.html public/
cp permute-alternative.html public/
cp brow-alternative.html public/
cp index.html public/
cp pricing.html public/
cp privacy.html public/
cp robots.txt public/
cp sitemap.xml public/
cp styles.css public/
cp success.html public/
cp terms.html public/
if [ -f mac-kit-launch-promo-3.mp4 ]; then
  cp mac-kit-launch-promo-3.mp4 public/
fi
cp -R assets/. public/assets/
# Blog pages ship as flat files (blog.html, blog/<slug>.html) so the canonical
# URLs without a trailing slash (/blog, /blog/<slug>) answer 200 directly
# instead of redirecting to a trailing-slash directory index.
mkdir -p public/blog
cp blog/index.html public/blog.html
for page in blog/*/index.html; do
  slug=$(basename "$(dirname "$page")")
  cp "$page" "public/blog/$slug.html"
done
