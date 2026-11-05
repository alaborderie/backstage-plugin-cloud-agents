#!/bin/sh
# Proves the image can build C and Rust and drive Chromium from Node and Python, as the agent user.
set -eu
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
cd "$dir"

printf '#include <stdio.h>\nint main(void){puts("c ok");return 0;}\n' > main.c
cc -o c-hello main.c
./c-hello
printf '#include <iostream>\nint main(){std::cout<<"c++ ok\\n";}\n' > main.cpp
c++ -o cpp-hello main.cpp
./cpp-hello

cargo new --quiet --vcs none rust-hello
cargo run --quiet --offline --manifest-path rust-hello/Cargo.toml
cargo fmt --version >/dev/null
cargo clippy --version >/dev/null
echo "rustfmt, clippy ok"
# Codex runs commands in login shells, where /etc/profile resets PATH.
bash -lc 'rustc --version >/dev/null && cargo --version >/dev/null'
echo "rust in login shell ok"

page='data:text/html,<title>chromium ok</title>'
node -e "
const { chromium } = require('playwright');
(async () => { const b = await chromium.launch(); const p = await b.newPage(); await p.goto('$page');
  console.log('node playwright: ' + await p.title()); await b.close(); })().catch((e) => { console.error(e); process.exit(1); });
"
python3 - "$page" <<'PY'
import sys
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page()
    pg.goto(sys.argv[1])
    print("python playwright: " + pg.title())
    b.close()
PY
python3 -m venv venv
./venv/bin/pip --version >/dev/null
echo "python venv ok"
