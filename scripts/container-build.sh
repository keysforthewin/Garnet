#!/bin/sh
set -eu
mkdir -p /tmp/garnet-build
cd /tmp/garnet-build
cp /source/package.json /source/package-lock.json /source/tsconfig.json /source/vite.config.ts /source/index.html .
cp -R /source/src /source/server /source/runner /source/shared /source/scripts /source/tests .
npm ci --no-audit --no-fund
npm run check
npm test
npm run build
cd build
npm ci --omit=dev --no-audit --no-fund
cp -R . /output/
chown -R 1000:1000 /output
