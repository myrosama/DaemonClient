import 'dart:io';

import 'package:dc_core_flutter/dc_core_flutter.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() async => RustLib.init());

  test('the app reaches the Rust core and reads its version', () {
    expect(coreVersion(), matches(RegExp(r'^\d+\.\d+\.\d+$')));
  });

  test('file sizes above 2^53 cross the bridge exactly', () {
    // 2 GiB -> 108 parts; 2^54 is beyond what a Dart double holds exactly.
    expect(partCount(fileSize: BigInt.from(2147483648)), BigInt.from(108));
    expect(partCount(fileSize: BigInt.parse('18014398509481984')), BigInt.parse('904203642'));
  });

  test('the core reaches Telegram over HTTPS from this device', () async {
    final base = Directory.systemTemp.createTempSync('dc-core-test').path;
    await startCore(dataDir: '$base/data', cacheDir: '$base/cache');
    expect(await checkTelegram(), inInclusiveRange(200, 399));
  });
}
