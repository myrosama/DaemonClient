#!/usr/bin/env bash
# Builds the core for the iPhone app: release static libraries for the device
# and the Simulator, the Swift bindings, and DCCore.xcframework, all into
# core/dc-ffi/build/ (git-ignored). apps/ios/project.yml links them.
set -euo pipefail
cd "$(dirname "$0")/.."
out=dc-ffi/build
# The app's minimum iOS (apps/ios/project.yml); without it the C parts (ring) target the newest SDK.
export IPHONEOS_DEPLOYMENT_TARGET=26.0
rm -rf "$out"; mkdir -p "$out/headers" "$out/swift"
for t in aarch64-apple-ios aarch64-apple-ios-sim; do
  cargo build -q --locked --release -p dc-ffi --target "$t"
done
cargo run -q --locked -p uniffi-bindgen -- generate \
  --library target/aarch64-apple-ios/release/libdc_ffi.a --language swift --out-dir "$out/swift"
cp "$out/swift/dc_ffiFFI.h" "$out/headers/"
cp "$out/swift/dc_ffiFFI.modulemap" "$out/headers/module.modulemap"
xcodebuild -create-xcframework \
  -library target/aarch64-apple-ios/release/libdc_ffi.a -headers "$out/headers" \
  -library target/aarch64-apple-ios-sim/release/libdc_ffi.a -headers "$out/headers" \
  -output "$out/DCCore.xcframework" >/dev/null
echo "built $out/DCCore.xcframework and $out/swift/dc_ffi.swift"
