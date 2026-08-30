#!/bin/bash
# One-shot setup: vendored three.js + the 8th Wall engine binary.
set -e
cd "$(dirname "$0")"
mkdir -p web/vendor tmp-three
(cd tmp-three && npm pack three@0.183.2 >/dev/null && tar xzf ./*.tgz)
cp tmp-three/package/build/three.module.js tmp-three/package/build/three.core.js web/vendor/
rm -rf tmp-three
./fetch-engine.sh
echo
echo "done. now run:  node serve.mjs"
