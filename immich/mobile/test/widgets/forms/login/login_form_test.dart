import 'package:drift/drift.dart';
import 'package:drift/native.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/models/store.model.dart';
import 'package:immich_mobile/domain/services/store.service.dart';
import 'package:immich_mobile/entities/store.entity.dart';
import 'package:immich_mobile/infrastructure/repositories/db.repository.dart';
import 'package:immich_mobile/infrastructure/repositories/store.repository.dart';
import 'package:immich_mobile/widgets/forms/login/login_form.dart';

import '../../../test_utils.dart';
import '../../../widget_tester_extensions.dart';

void main() {
  late Drift db;

  setUpAll(() async {
    db = Drift(DatabaseConnection(NativeDatabase.memory(), closeStreamsSynchronously: true));
    TestUtils.init();
  });

  setUp(() async {
    await StoreService.init(storeRepository: DriftStoreRepository(db));
    await Store.delete(StoreKey.serverUrl);
  });

  String serverText(WidgetTester tester) =>
      tester.widget<TextField>(find.descendant(of: find.byKey(kLoginServerKey), matching: find.byType(TextField))).controller!.text;

  testWidgets('one form: address, email, password and Create account (D8)', (tester) async {
    await tester.pumpConsumerWidget(LoginForm());
    await tester.pumpAndSettle();
    expect(find.byKey(kLoginServerKey), findsOneWidget);
    expect(find.byKey(kLoginEmailKey), findsOneWidget);
    // ImmichPasswordInput hands its key to the text field inside it.
    expect(find.byKey(kLoginPasswordKey), findsWidgets);
    expect(find.byKey(kCreateAccountKey), findsOneWidget);
    expect(serverText(tester), 'https://api.daemonclient.uz', reason: 'the hosted address, filled in');
  });

  testWidgets('the address typed last time is filled in', (tester) async {
    await Store.put(StoreKey.serverUrl, 'https://photos.example.com');
    await tester.pumpConsumerWidget(LoginForm());
    await tester.pumpAndSettle();
    expect(serverText(tester), 'https://photos.example.com');
  });

  test('Create account goes to the hosted portal\'s sign-up', () {
    expect(kSignUpUrl, Uri.parse('https://accounts.daemonclient.uz/signup'));
  });
}
