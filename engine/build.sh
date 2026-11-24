#!/bin/sh
# Baut build/dbe$VERSION.stub (Bank 0, $0D00) und build/dbe$VERSION.lib (Bank 1, $C000) mit ca65/ld65.
set -e
cd "$(dirname "$0")"
VERSION=$(cat ../VERSION)   # einzige Stelle für die Versionsnummer
mkdir -p ../build
ca65 -t none -o ../build/stub.o stub.s
ld65 -C stub.cfg -m ../build/stub.map -o ../build/dbe$VERSION.stub ../build/stub.o
ca65 -t none -o ../build/lib.o lib.s
ld65 -C lib.cfg -m ../build/lib.map -Ln ../build/lib.lbl -o ../build/dbe$VERSION.lib ../build/lib.o
ls -l ../build/dbe$VERSION.stub ../build/dbe$VERSION.lib
