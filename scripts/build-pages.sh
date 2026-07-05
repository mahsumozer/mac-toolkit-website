#!/bin/sh
set -eu

mkdir -p public/assets

cp CNAME public/
cp accessibility.html public/
cp app.js public/
cp index.html public/
cp pricing.html public/
cp privacy.html public/
cp styles.css public/
cp success.html public/
cp terms.html public/
cp assets/* public/assets/
