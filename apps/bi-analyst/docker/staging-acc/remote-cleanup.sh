#!/usr/bin/env bash
# 仅清理本验收资源，不动其他容器/项目
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

echo "==> stop & remove project bi-analyst-staging-acc (containers/networks/volumes/local images)"
if [[ -f docker-compose.yml ]]; then
  sudo docker compose -p bi-analyst-staging-acc -f docker-compose.yml down -v --rmi local --remove-orphans || true
fi

echo "==> remove labeled / named leftovers (project only)"
# 按容器名精确删除（若 compose down 已清则 no-op）
for c in bi-acc-app bi-acc-mysql bi-acc-postgres; do
  sudo docker rm -f "$c" 2>/dev/null || true
done

# 仅删本验收镜像标签
sudo docker images 'bi-analyst-staging-acc' -q | sort -u | while read -r id; do
  [[ -n "$id" ]] && sudo docker rmi -f "$id" || true
done

echo "==> remove dangling images created by this build (safe: dangling only)"
sudo docker image prune -f >/tmp/bi-acc-prune.txt || true
cat /tmp/bi-acc-prune.txt || true

echo "==> remove workdir & temp files"
rm -f /tmp/bi-acc-*.json /tmp/bi-acc-prune.txt
# 若脚本位于 ~/bi-analyst-staging-acc，清理整个目录（当前目录的上级由调用方控制）
WORK="${HOME}/bi-analyst-staging-acc"
if [[ -d "$WORK" ]]; then
  # 仅当当前 ROOT 就在该目录或其子目录时删除
  case "$ROOT" in
    "$WORK"|"$WORK"/*)
      cd "$HOME"
      rm -rf "$WORK"
      echo "removed $WORK"
      ;;
    *)
      echo "skip removing $WORK (script not under it: $ROOT)"
      ;;
  esac
fi

echo "==> verify unrelated containers still present (informational)"
sudo docker ps -a --format '{{.Names}}' | head -30

echo
echo "CLEANUP DONE (bi-analyst-staging-acc only)"
