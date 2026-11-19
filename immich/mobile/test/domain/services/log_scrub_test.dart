import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/services/log.service.dart';

void main() {
  test("the core's local server secret never reaches the log (Gate 3, P2 2.3)", () {
    final secret = 'ab' * 32;
    final error = 'NSErrorFailingURLStringKey=http://127.0.0.1:54321/$secret/api/assets/a1/original timed out';
    final scrubbed = scrubLocalSecrets(error);
    expect(scrubbed, isNot(contains(secret)));
    expect(scrubbed, contains('http://127.0.0.1:54321/[secret]/api/assets/a1/original'));
    expect(scrubLocalSecrets('nothing to hide'), 'nothing to hide');
  });
}
