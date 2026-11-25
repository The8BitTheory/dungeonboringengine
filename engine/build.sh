#!/bin/sh
# Baut build/dbe$VERSION.stub (Bank 0, $0D00), build/dbe$VERSION.lib (Bank 1, $B000) und
# build/dbe$VERSION-test.lib (wie .lib, mit Testfunktionen 250-252 für den VICE-Rauchtest, lib-test.cfg) mit ca65/ld65.
set -e
cd "$(dirname "$0")"
VERSION=$(cat ../VERSION)   # einzige Stelle für die Versionsnummer
mkdir -p ../build
ca65 -t none -o ../build/stub.o stub.s
ld65 -C stub.cfg -m ../build/stub.map -Ln ../build/stub.lbl -o ../build/dbe$VERSION.stub ../build/stub.o
ca65 -t none -o ../build/lib.o lib.s
ld65 -C lib.cfg -m ../build/lib.map -Ln ../build/lib.lbl -o ../build/dbe$VERSION.lib ../build/lib.o
ca65 -t none -DDBE_TEST -o ../build/lib-test.o lib.s
ld65 -C lib-test.cfg -m ../build/lib-test.map -Ln ../build/lib-test.lbl -o ../build/dbe$VERSION-test.lib ../build/lib-test.o
ls -l ../build/dbe$VERSION.stub ../build/dbe$VERSION.lib ../build/dbe$VERSION-test.lib
