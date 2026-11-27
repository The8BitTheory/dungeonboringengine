#!/bin/sh
# Builds build/dbe$VERSION.stub (bank 0, $0D00), build/dbe$VERSION.lib (bank 1, $B000) and
# build/dbe$VERSION-test.lib (like .lib, with test functions 250-252 for the VICE smoke test, lib-test.cfg) using ca65/ld65.
set -e
cd "$(dirname "$0")"
VERSION=$(cat ../VERSION)   # the only place for the version number
mkdir -p ../build
ca65 -t none -o ../build/stub.o stub.s
ld65 -C stub.cfg -m ../build/stub.map -Ln ../build/stub.lbl -o ../build/dbe$VERSION.stub ../build/stub.o
ca65 -t none -o ../build/lib.o lib.s
ld65 -C lib.cfg -m ../build/lib.map -Ln ../build/lib.lbl -o ../build/dbe$VERSION.lib ../build/lib.o
ca65 -t none -DDBE_TEST -o ../build/lib-test.o lib.s
ld65 -C lib-test.cfg -m ../build/lib-test.map -Ln ../build/lib-test.lbl -o ../build/dbe$VERSION-test.lib ../build/lib-test.o
ls -l ../build/dbe$VERSION.stub ../build/dbe$VERSION.lib ../build/dbe$VERSION-test.lib
