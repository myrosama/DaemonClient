import 'dart:convert';

import 'package:dc_core_flutter/dc_core_flutter.dart' as core;
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/repositories/secure_storage.repository.dart';
import 'package:immich_mobile/services/secure_storage.service.dart';

/// Where the core's session is kept: the phone's secure storage (Keychain /
/// Keystore), never Immich's database. No password is kept.
const kCoreSessionKey = 'dc_core_session';

typedef CoreSignIn =
    Future<core.SignedIn> Function({required String address, required String email, required String password});

final coreSessionServiceProvider = Provider((ref) => CoreSessionService(ref.watch(secureStorageServiceProvider)));

/// Signing in through DaemonClient's core (SPEC D8, P2 task 2.2), and
/// resuming that session at the next start.
class CoreSessionService {
  /// Whether the core came up signed in at this start; Immich resumes only
  /// then (the splash screen), so the two never disagree.
  static bool restoredAtStart = false;

  final SecureStorageService _storage;
  final CoreSignIn _signIn;
  final void Function({required core.SignedIn session}) _restore;
  final void Function() _signOut;

  CoreSessionService(
    this._storage, {
    CoreSignIn? signIn,
    void Function({required core.SignedIn session})? restore,
    void Function()? signOut,
  }) : _signIn = signIn ?? core.signIn,
       _restore = restore ?? core.restore,
       _signOut = signOut ?? core.signOut;

  /// The storage outside Riverpod, for app start.
  CoreSessionService.atStart() : this(const SecureStorageService(SecureStorageRepository(FlutterSecureStorage())));

  Future<core.SignedIn> signIn({required String address, required String email, required String password}) async {
    final session = await _signIn(address: address, email: email, password: password);
    try {
      await _storage.write(kCoreSessionKey, jsonEncode(_toJson(session)));
    } catch (_) {
      // A session that cannot be kept is not kept in the core either.
      _signOut();
      rethrow;
    }
    return session;
  }

  /// Restores the core from the kept session; false when there is none.
  Future<bool> restore() async {
    final raw = await _storage.read(kCoreSessionKey);
    if (raw == null) return false;
    final session = _fromJson(raw);
    if (session == null) {
      await _storage.delete(kCoreSessionKey);
      return false;
    }
    try {
      _restore(session: session);
    } catch (_) {
      // The core refuses it (an address that no longer passes, say): drop it
      // rather than try again at every start; the user signs in afresh.
      await _storage.delete(kCoreSessionKey);
      rethrow;
    }
    return true;
  }

  Future<void> signOut() async {
    await _storage.delete(kCoreSessionKey);
    _signOut();
  }

  static Map<String, String> _toJson(core.SignedIn s) => {
    'workerUrl': s.workerUrl,
    'token': s.token,
    'userId': s.userId,
    'email': s.email,
    'name': s.name,
  };

  static core.SignedIn? _fromJson(String raw) {
    try {
      final m = (jsonDecode(raw) as Map).cast<String, String>();
      return core.SignedIn(
        workerUrl: m['workerUrl']!,
        token: m['token']!,
        userId: m['userId']!,
        email: m['email']!,
        name: m['name']!,
      );
    } catch (_) {
      return null;
    }
  }
}
