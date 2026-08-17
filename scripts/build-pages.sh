#!/bin/sh
set -eu

mkdir -p public/assets

cp CNAME public/
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
