import 'package:flutter/material.dart';
import 'package:dc_core_flutter/dc_core_flutter.dart';

/// A one-screen app that proves the plugin loads the Rust core on a device.
/// The real checks are in `integration_test/core_test.dart`.
Future<void> main() async {
  await RustLib.init();
  runApp(const CoreCheckApp());
}

class CoreCheckApp extends StatelessWidget {
  const CoreCheckApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      home: Scaffold(
        appBar: AppBar(title: const Text('dc_core_flutter')),
        body: Center(
          child: Text(
            'DaemonClient core ${coreVersion()}\n'
            'A 2 GiB file is ${partCount(fileSize: BigInt.from(2147483648))} parts',
            textAlign: TextAlign.center,
          ),
        ),
      ),
    );
  }
}
