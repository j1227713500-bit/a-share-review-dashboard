#!/bin/zsh
cd "$(dirname "$0")"
if /usr/bin/curl --noproxy '*' --silent --max-time 1 http://127.0.0.1:8765/api/job >/dev/null 2>&1; then
  open http://127.0.0.1:8765
  exit 0
fi
if command -v python3 >/dev/null 2>&1; then
  python3 server.py --open
else
  echo "需要 Python 3.10 或更新版本。安装后再次打开此启动文件。"
  read -k 1
fi
