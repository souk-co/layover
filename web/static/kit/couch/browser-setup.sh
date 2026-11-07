#!/bin/bash
# Installs headed Chromium (Playwright's build), Xvfb (conda-forge) and ImageMagick plus Chromium's libraries (Debian
# bookworm debs) under /workspace/state, as uid 1000 on the couch's read-only root. Uses only the always-allowed package
# hosts. Writes /workspace/state/env.sh. Measured on zed under the guest's limits: 22-65 s, 690 MB.
set -euo pipefail
S=/workspace/state A=/workspace/state/apt R=/workspace/state/root M=$(uname -m)-linux-gnu
export HOME=$S/home TMPDIR=$S/tmp npm_config_cache=$S/npm npm_config_update_notifier=false PLAYWRIGHT_BROWSERS_PATH=$S/pw
mkdir -p $HOME $TMPDIR $A/lists/partial $A/archives/partial $A/cache $A/parts $R
printf 'deb https://deb.debian.org/debian bookworm main\ndeb https://deb.debian.org/debian bookworm-updates main\ndeb https://deb.debian.org/debian-security bookworm-security main\n' > $A/sources.list
apt=(apt-get -q -o Dir::State::Lists=$A/lists -o Dir::Cache=$A/cache -o Dir::Cache::archives=$A/archives
  -o Dir::Etc::SourceList=$A/sources.list -o Dir::Etc::SourceParts=$A/parts -o Debug::NoLocking=1
  -o Acquire::https::Proxy=$HTTPS_PROXY -o APT::Sandbox::User=$(id -un))
"${apt[@]}" update >/dev/null
"${apt[@]}" install -d -y --no-install-recommends imagemagick fonts-liberation libnss3 libnspr4 libatk1.0-0 \
  libatk-bridge2.0-0 libatspi2.0-0 libcups2 libdbus-1-3 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
  libxrandr2 libgbm1 libasound2 libpango-1.0-0 libcairo2 libglib2.0-0 >/dev/null
for d in $A/archives/*.deb; do dpkg-deb -x $d $R; done
rm -rf $A/archives/*.deb
sed -i "s#<dir>/usr/share/fonts</dir>#<dir>$R/usr/share/fonts</dir>#" $R/etc/fonts/fonts.conf
C=$([ $(uname -m) = x86_64 ] && echo 64 || echo aarch64)
curl -sSL https://conda.anaconda.org/conda-forge/linux-$C/micromamba-2.10.0-0.tar.bz2 | python3 -c 'import sys,tarfile; tarfile.open(fileobj=sys.stdin.buffer,mode="r|bz2").extractall(sys.argv[1])' $S/mamba
MAMBA_ROOT_PREFIX=$S/mamba $S/mamba/bin/micromamba create -y -q -p $S/x -c conda-forge xorg-xvfb-server >/dev/null
rm -rf $S/mamba/pkgs
mkdir -p $S/bin && printf '#!/bin/sh\nexec env -u LD_LIBRARY_PATH %s "$@"\n' $S/x/bin/Xvfb > $S/bin/Xvfb && chmod +x $S/bin/Xvfb
ln -sf $R/usr/bin/import-im6.q16 $S/bin/import
cd $S && npm i --no-audit --no-fund --loglevel=error playwright@1.65.0 >/dev/null && npx playwright install --no-shell chromium >/dev/null
rm -rf $S/npm
cat > $S/env.sh <<ENV
export HOME=$HOME TMPDIR=$TMPDIR PLAYWRIGHT_BROWSERS_PATH=$S/pw FONTCONFIG_FILE=$R/etc/fonts/fonts.conf
export NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost
export PATH=$S/bin:$R/usr/bin:$S/node_modules/.bin:\$PATH LD_LIBRARY_PATH=$R/usr/lib/$M:$R/lib/$M:$R/usr/lib/$M/pulseaudio
export MAGICK_CONFIGURE_PATH=\$(echo $R/etc/ImageMagick-*) MAGICK_CODER_MODULE_PATH=\$(echo $R/usr/lib/$M/ImageMagick-*/modules-Q16/coders) DISPLAY=:99
export CHROME=\$(echo $S/pw/chromium-*/chrome-linux*/chrome)
# The guest caps the container at 128 tasks; multi-process Chromium alone reaches about 115, --single-process about 50.
export CHROME_FLAGS="--no-sandbox --single-process --disable-dev-shm-usage --disable-gpu --disable-background-networking --disable-component-update --no-first-run --proxy-server=\$HTTPS_PROXY --user-data-dir=$S/profile"

ENV
