import 'package:dc_core_flutter/dc_core_flutter.dart' as core;
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/repositories/secure_storage.repository.dart';
import 'package:immich_mobile/services/core_session.service.dart';
import 'package:immich_mobile/services/secure_storage.service.dart';

class FakeSecureStorageRepository implements SecureStorageRepository {
  final values = <String, String>{};

  @override
  Future<String?> read(String key) async => values[key];

  @override
  Future<void> write(String key, String value) async => values[key] = value;

  @override
  Future<void> delete(String key) async => values.remove(key);
}

class _FailingWrites extends FakeSecureStorageRepository {
  @override
  Future<void> write(String key, String value) async => throw StateError('keychain unavailable');
}

void main() {
  const session = core.SignedIn(
    workerUrl: 'https://dc-x.workers.dev',
    token: 'tok',
    userId: 'u1',
    email: 'a@b.uz',
    name: 'A',
  );
  late FakeSecureStorageRepository storage;
  late List<core.SignedIn> restored;
  late int signedOut;
  late CoreSessionService service;

  setUp(() {
    storage = FakeSecureStorageRepository();
    restored = [];
    signedOut = 0;
    service = CoreSessionService(
      SecureStorageService(storage),
      signIn: ({required address, required email, required password}) async {
        expect((address, email, password), ('https://api.daemonclient.uz', 'a@b.uz', 'pw'));
        return session;
      },
      restore: ({required session}) => restored.add(session),
      signOut: () => signedOut++,
    );
  });

  test('a sign-in is kept in secure storage', () async {
    final signedIn = await service.signIn(address: 'https://api.daemonclient.uz', email: 'a@b.uz', password: 'pw');
    expect(signedIn, session);
    expect(storage.values.keys, [kCoreSessionKey]);
    expect(storage.values[kCoreSessionKey], isNot(contains('pw')));
  });

  test('the kept session restores the core at the next start', () async {
    await service.signIn(address: 'https://api.daemonclient.uz', email: 'a@b.uz', password: 'pw');
    expect(await service.restore(), isTrue);
    expect(restored, [session]);
  });

  test('nothing kept, or something unreadable, restores nothing', () async {
    expect(await service.restore(), isFalse);
    storage.values[kCoreSessionKey] = '{"workerUrl": 3';
    expect(await service.restore(), isFalse);
    expect(storage.values, isEmpty, reason: 'an unreadable session is dropped');
    expect(restored, isEmpty);
  });

  test('a kept session the core refuses is dropped, not retried at every start', () async {
    await service.signIn(address: 'https://api.daemonclient.uz', email: 'a@b.uz', password: 'pw');
    final refusing = CoreSessionService(
      SecureStorageService(storage),
      restore: ({required session}) => throw StateError('not a usable server address'),
    );
    // It still throws, so app start logs why; the session is gone either way.
    await expectLater(refusing.restore(), throwsStateError);
    expect(storage.values, isEmpty);
  });

  test('a sign-in that cannot be kept is undone in the core', () async {
    final failing = CoreSessionService(
      SecureStorageService(_FailingWrites()),
      signIn: ({required address, required email, required password}) async => session,
      signOut: () => signedOut++,
    );
    await expectLater(failing.signIn(address: 'a', email: 'b', password: 'c'), throwsStateError);
    expect(signedOut, 1);
  });

  test('signing out forgets the session and signs the core out', () async {
    await service.signIn(address: 'https://api.daemonclient.uz', email: 'a@b.uz', password: 'pw');
    await service.signOut();
    expect(storage.values, isEmpty);
    expect(signedOut, 1);
  });
}
