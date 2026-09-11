#!/usr/bin/env bash
# SQLite 在线备份：用 .backup 而非 cp —— WAL 模式下直接拷文件会得到不一致的快照。
# 累积的 15m K 线是 A3.1「历史新高」判定和未来回测的唯一数据来源，丢了只能重新攒。
set -euo pipefail
DB=/root/Alpha-Reset/data/alpha-reset.sqlite
DIR=/root/Alpha-Reset/backups
KEEP=7
mkdir -p "$DIR"
STAMP=$(date +%Y%m%d-%H%M%S)
sqlite3 "$DB" ".backup '$DIR/alpha-$STAMP.sqlite'"
gzip -f "$DIR/alpha-$STAMP.sqlite"
ls -1t "$DIR"/alpha-*.sqlite.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
echo "备份完成: $DIR/alpha-$STAMP.sqlite.gz"
