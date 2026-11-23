#!/bin/sh
# Baut build/dbe.stub (Bank 0, $0D00) und build/dbe.lib (Bank 1, $C000) mit ca65/ld65.
set -e
cd "$(dirname "$0")"
mkdir -p ../build
ca65 -t none -o ../build/stub.o stub.s
ld65 -C stub.cfg -m ../build/stub.map -o ../build/dbe.stub ../build/stub.o
ca65 -t none -o ../build/lib.o lib.s
ld65 -C lib.cfg -m ../build/lib.map -Ln ../build/lib.lbl -o ../build/dbe.lib ../build/lib.o
ls -l ../build/dbe.stub ../build/dbe.lib
