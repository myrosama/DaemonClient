/// DaemonClient's Rust core, for the Photos and Drive apps.
library;

export 'src/rust/api/core.dart';
export 'src/rust/frb_generated.dart' show RustLib;
// The core's errors arrive as this; its message is meant for the user.
export 'package:flutter_rust_bridge/flutter_rust_bridge.dart' show AnyhowException;
