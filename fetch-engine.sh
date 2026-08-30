#!/bin/bash
# Downloads the 8th Wall distributed engine binary (SLAM) into web/external/xr/.
# The binary is NOT redistributed with this sample: it is licensed under the
# XR Engine License Agreement (https://github.com/8thwall/engine/blob/main/LICENSE)
# and must be used in the original form published by Niantic Spatial.
set -e
cd "$(dirname "$0")"
rm -rf web/external/xr tmp-engine
mkdir -p web/external tmp-engine
cd tmp-engine
npm pack @8thwall/engine-binary@1 >/dev/null
tar xzf ./*.tgz
cd ..
mv tmp-engine/package/dist web/external/xr
rm -rf tmp-engine
echo "engine installed:"
ls -la web/external/xr
