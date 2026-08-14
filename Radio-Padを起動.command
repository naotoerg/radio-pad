#!/bin/zsh

# Finderから起動しても、元の作業フォルダの権限に影響されないようにする。
PROJECT_DIR="${0:A:h}"
cd /tmp || exit 1

echo "Radio Padを起動します"
echo "Mac:  http://localhost:8080"
echo "終了するときは Control + C を押してください"
echo

exec /usr/bin/python3 -m http.server 8080 --bind 0.0.0.0 --directory "$PROJECT_DIR"
