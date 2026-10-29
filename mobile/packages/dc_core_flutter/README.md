# dc_core_flutter

The Flutter plugin through which DaemonClient's phone apps (Photos and Drive)
call the shared Rust core, `mobile/core/dc-core`. The plugin itself is thin:
the logic lives in `dc-core`, which has no binding code.

- `rust/` — the binding crate (flutter_rust_bridge 2.13.0). `src/api/` is what
  Dart can call; `src/frb_generated.rs` is generated.
- `lib/` — the generated Dart API, exported from `lib/dc_core_flutter.dart`.
- `cargokit/` — vendored build tool that compiles the crate for iOS and
  Android during the app build (local patch: `build_pod.sh` no longer prints
  the environment).
- `example/` — a one-screen app; `example/integration_test/` checks the bridge
  on a simulator or device.

Regenerate the bindings after changing `rust/src/api/`:

```sh
flutter_rust_bridge_codegen generate
```

Run the bridge tests (from `example/`):

```sh
flutter test integration_test/core_test.dart -d <device>
```

Design and plan: `docs/mobile/` in the repository root.
