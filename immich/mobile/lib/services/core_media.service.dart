import 'package:dc_core_flutter/dc_core_flutter.dart' as core;
import 'package:flutter/painting.dart';

/// The core's local media server (P2 task 2.3): every picture and video the
/// app shows is read through it — straight from the storage, decrypted on the
/// phone — never through the worker (SPEC D23).
class CoreMedia {
  // Until the first fetch: an address that fails quietly rather than throws.
  static const _notReady = 'http://127.0.0.1:9/not-ready';
  static String _grid = _notReady;
  static String _viewer = _notReady;

  /// The grid's thumbnails.
  static String get gridBase => _grid;

  /// What the user opened: previews, originals, video (D17: never queued
  /// behind the grid).
  static String get viewerBase => _viewer;

  /// Fetches the addresses (at start and on every resume: a listener the
  /// phone closed opens again on a new port). When they change, what was
  /// loaded from the old ones is dropped, so it loads again. True if changed.
  static Future<bool> refresh({Future<core.MediaAddresses> Function()? fetch, void Function()? onChanged}) async {
    final addresses = await (fetch ?? core.mediaServer)();
    final changed = addresses.gridBase != _grid || addresses.viewerBase != _viewer;
    _grid = addresses.gridBase;
    _viewer = addresses.viewerBase;
    if (changed) (onChanged ?? _dropLoadedImages)();
    return changed;
  }

  static void _dropLoadedImages() {
    PaintingBinding.instance.imageCache
      ..clear()
      ..clearLiveImages();
  }
}
