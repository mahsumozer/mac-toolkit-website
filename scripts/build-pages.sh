#!/bin/sh
set -eu

# public/ is generated output, never a place to keep files: wipe it first so a
# renamed or dropped asset cannot linger here and get re-uploaded on every
# deploy (two unreferenced promo videos, 10.7 MB, shipped this way for weeks).
rm -rf public
mkdir -p public/assets

cp CNAME public/
cp favicon.ico public/
cp _headers public/
cp _redirects public/
cp accessibility.html public/
cp app.js public/
cp index.html public/
cp pricing.html public/
cp privacy.html public/
cp robots.txt public/
cp sitemap.xml public/
cp styles.css public/
cp success.html public/
cp terms.html public/
cp mac-kit-launch-promo-3.mp4 public/
cp -R assets/. public/assets/

# social/ and social-media/ are deliberately not copied: the social hub is a
# local-only tool (npm run hub), never part of the deployed site.
