// The Gate 2 audit: drives the signed-in app through every area and prints
// one `AUDIT|step|result` line per measurement. At `AUDIT|shot|<name>` it waits
// while the runner (mobile/tools/audit.sh) takes a screenshot from outside, so
// video surfaces are captured too. Never prints a token or the media secret.
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:ui' as ui;

import 'package:auto_route/auto_route.dart';
import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/domain/services/log.service.dart';
import 'package:immich_mobile/main.dart' as app;
import 'package:immich_mobile/pages/common/settings.page.dart';
import 'package:immich_mobile/pages/common/tab_shell.page.dart';
import 'package:immich_mobile/presentation/widgets/asset_viewer/asset_viewer.page.dart';
import 'package:immich_mobile/presentation/widgets/images/thumbnail_tile.widget.dart';
import 'package:immich_mobile/providers/infrastructure/db.provider.dart';
import 'package:immich_mobile/routing/router.dart';
import 'package:immich_mobile/utils/bootstrap.dart';
import 'package:integration_test/integration_test.dart';
import 'package:logging/logging.dart';

final _problems = <String>[];

void _say(String step, Object result) => debugPrint('AUDIT|$step|$result');

Future<void> _wait(WidgetTester t, Duration d) async {
  final end = DateTime.now().add(d);
  while (DateTime.now().isBefore(end)) {
    await t.pump(const Duration(milliseconds: 50));
    await Future<void>.delayed(const Duration(milliseconds: 50));
  }
}

/// Milliseconds until [finder] shows, or null after [timeout].
Future<int?> _until(WidgetTester t, Finder finder, {Duration timeout = const Duration(seconds: 30)}) async {
  final sw = Stopwatch()..start();
  while (sw.elapsed < timeout) {
    await t.pump(const Duration(milliseconds: 50));
    if (t.any(finder)) return sw.elapsedMilliseconds;
    await Future<void>.delayed(const Duration(milliseconds: 50));
  }
  return null;
}

Future<void> _shot(WidgetTester t, String name) async {
  _say('shot', name);
  await _wait(t, const Duration(milliseconds: 1800));
}

/// Warnings and errors logged since the last call, attributed to [step].
void _problemsSince(String step) {
  for (final p in _problems) {
    _say('problem', '$step: $p');
  }
  _problems.clear();
}

/// On-screen grid tiles, and how many show their real thumbnail (the blurred
/// thumbhash is tiny; a real one is at least 100 px wide).
(int, int) _tiles(WidgetTester t) {
  final height = t.view.physicalSize.height / t.view.devicePixelRatio;
  var loaded = 0, total = 0;
  for (final e in find.byWidgetPredicate((w) => w.runtimeType.toString() == '_ThumbnailLeaf').evaluate()) {
    final box = e.renderObject as RenderBox?;
    if (box == null || !box.attached || !box.hasSize) continue;
    final top = box.localToGlobal(Offset.zero).dy;
    if (top >= height - 80 || top + box.size.height <= 80) continue; // under the bars
    total++;
    final image = (e.widget as dynamic).image as ui.Image?;
    if (image != null && image.width >= 100) loaded++;
  }
  return (loaded, total);
}

/// The largest image the viewer is drawing, by width.
int _viewerWidth(WidgetTester t) => find
    .byType(RawImage)
    .evaluate()
    .map((e) => (e.widget as RawImage).image?.width ?? 0)
    .fold(0, max);

StackRouter _router(WidgetTester t) => t.element(find.byType(TabShellPage)).router;

Future<void> _visit(WidgetTester t, String name, PageRouteInfo route) async {
  final sw = Stopwatch()..start();
  unawaited(_router(t).push(route));
  await _wait(t, const Duration(seconds: 4));
  _say('page', '$name|open ${sw.elapsedMilliseconds} ms');
  await _shot(t, name);
  _problemsSince(name);
  await _router(t).maybePop();
  await _wait(t, const Duration(seconds: 1));
}

BaseAsset? _tileAsset(WidgetTester t, bool Function(BaseAsset) want) {
  for (final e in find.byType(ThumbnailTile).evaluate()) {
    final asset = (e.widget as ThumbnailTile).asset;
    final box = e.renderObject as RenderBox?;
    if (asset != null && want(asset) && box != null && box.hasSize && box.localToGlobal(Offset.zero).dy > 150) {
      return asset;
    }
  }
  return null;
}

Finder _tileOf(BaseAsset asset) =>
    find.byWidgetPredicate((w) => w is ThumbnailTile && identical(w.asset, asset));

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  binding.framePolicy = LiveTestWidgetsFlutterBindingFramePolicy.fullyLive;

  testWidgets('audit', (t) async {
    final start = Stopwatch()..start();
    // As main() does, without clearing anything: the session already on the device.
    await EasyLocalization.ensureInitialized();
    final (drift, _) = await Bootstrap.initDomain();
    final testOnError = FlutterError.onError;
    await app.initApp();
    // The app's own handler replaced the test's: record Flutter errors as
    // findings and go on; the test's handler is back at the end.
    FlutterError.onError = (d) => _problems.add('FlutterError: ${scrubLocalSecrets(d.exceptionAsString()).split('\n').first}');
    addTearDown(() => FlutterError.onError = testOnError);
    Logger.root.onRecord.listen((r) {
      if (r.level >= Level.WARNING) {
        _problems.add(scrubLocalSecrets('${r.loggerName}: ${r.message} ${r.error ?? ''}').split('\n').first);
      }
    });
    await t.pumpWidget(
      ProviderScope(overrides: [driftProvider.overrideWith(driftOverride(drift))], child: const app.MainWidget()),
    );
    _say('platform', Platform.operatingSystem);

    // 1. Start: the timeline's first tiles, then their real thumbnails.
    final shell = await _until(t, find.byType(ThumbnailTile), timeout: const Duration(seconds: 60));
    _say('start', shell == null ? 'NO TIMELINE after 60 s' : 'timeline in ${start.elapsedMilliseconds} ms');
    if (shell == null) {
      await _shot(t, '00-no-timeline');
      _problemsSince('start');
      return;
    }
    for (final s in [1, 3, 6]) {
      await _wait(t, Duration(seconds: s == 1 ? 1 : (s == 3 ? 2 : 3)));
      final (l, n) = _tiles(t);
      _say('first screen', '$l/$n thumbnails at ${s}s');
    }
    await _shot(t, '01-timeline');
    _problemsSince('start');

    // 2. Scrolling: frame times through fast flings, then how fast tiles fill.
    final scrollable = find.byType(Scrollable).first;
    final frames = <FrameTiming>[];
    void collect(List<FrameTiming> f) => frames.addAll(f);
    SchedulerBinding.instance.addTimingsCallback(collect);
    for (var i = 0; i < 6; i++) {
      await t.fling(scrollable, const Offset(0, -1600), 6000);
      await _wait(t, const Duration(milliseconds: 700));
    }
    SchedulerBinding.instance.removeTimingsCallback(collect);
    if (frames.isNotEmpty) {
      int ms(Duration d) => d.inMicroseconds ~/ 1000;
      final build = frames.map((f) => ms(f.buildDuration)).toList()..sort();
      final raster = frames.map((f) => ms(f.rasterDuration)).toList()..sort();
      _say('fling frames', jsonEncode({
        'frames': frames.length,
        'build_p50_ms': build[build.length ~/ 2],
        'build_p90_ms': build[build.length * 9 ~/ 10],
        'build_worst_ms': build.last,
        'raster_p50_ms': raster[raster.length ~/ 2],
        'raster_p90_ms': raster[raster.length * 9 ~/ 10],
        'raster_worst_ms': raster.last,
        'over_16ms': frames.where((f) => ms(f.totalSpan) > 16).length,
      }));
    }
    for (final s in [0, 1, 3, 6, 10]) {
      if (s > 0) await _wait(t, Duration(seconds: s == 1 ? 1 : (s == 3 ? 2 : (s == 6 ? 3 : 4))));
      final (l, n) = _tiles(t);
      _say('after fling', '$l/$n thumbnails at ${s}s');
    }
    await _shot(t, '02-after-fling');
    _problemsSince('fling');

    // 3. A photo: the viewer, its preview, then the original.
    final photo = _tileAsset(t, (a) => a.isImage);
    if (photo == null) {
      _say('photo', 'no photo tile on screen');
    } else {
      _say('photo', '${photo.width}x${photo.height}');
      final sw = Stopwatch()..start();
      await t.tap(_tileOf(photo));
      final viewer = await _until(t, find.byType(AssetViewer), timeout: const Duration(seconds: 10));
      _say('photo viewer', viewer == null ? 'did not open' : 'open in ${sw.elapsedMilliseconds} ms');
      int? preview, original;
      while (sw.elapsed < const Duration(seconds: 30)) {
        await _wait(t, const Duration(milliseconds: 200));
        final w = _viewerWidth(t);
        if (preview == null && w >= 1000) preview = sw.elapsedMilliseconds;
        if (photo.width != null && w >= photo.width! && w > 1440) {
          original = sw.elapsedMilliseconds;
          break;
        }
      }
      _say('photo preview', preview == null ? 'NOT within 30 s' : '$preview ms');
      _say('photo original', original == null ? 'not within 30 s (largest ${_viewerWidth(t)} px)' : '$original ms');
      await _shot(t, '03-photo');
      _problemsSince('photo');

      // Neighbours: three swipes, each to its preview.
      for (var i = 1; i <= 3; i++) {
        final sw2 = Stopwatch()..start();
        await t.fling(find.byType(PageView).first, const Offset(-500, 0), 2000);
        int? ready;
        while (sw2.elapsed < const Duration(seconds: 15)) {
          await _wait(t, const Duration(milliseconds: 200));
          if (_viewerWidth(t) >= 1000) {
            ready = sw2.elapsedMilliseconds;
            break;
          }
        }
        _say('swipe $i', ready == null ? 'no preview within 15 s' : 'preview in $ready ms');
      }
      await _shot(t, '04-after-swipes');
      // Details: drag the photo up.
      await t.drag(find.byType(PageView).first, const Offset(0, -500));
      await _wait(t, const Duration(seconds: 3));
      await _shot(t, '05-details');
      _problemsSince('swipes/details');
      await _router(t).maybePop();
      await _wait(t, const Duration(seconds: 2));
      if (t.any(find.byType(AssetViewer))) {
        await _router(t).maybePop();
        await _wait(t, const Duration(seconds: 2));
      }
    }

    // 4. A video with a known length (the 00:00 ones are the old broken uploads).
    BaseAsset? video;
    for (var i = 0; i < 25 && video == null; i++) {
      video = _tileAsset(t, (a) => a.isVideo && a.duration > Duration.zero);
      if (video == null) {
        await t.fling(scrollable, const Offset(0, -1600), 6000);
        await _wait(t, const Duration(milliseconds: 800));
      }
    }
    if (video == null) {
      _say('video', 'no video with a length found');
    } else {
      _say('video', '${video.name} ${video.duration.inSeconds}s ${video.width}x${video.height}');
      await t.tap(_tileOf(video));
      final clock = find.byWidgetPredicate(
        (w) => w is Text && RegExp(r'^\d{1,2}:\d{2}(:\d{2})? / \d{1,2}:\d{2}').hasMatch(w.data ?? ''),
      );
      String? position() => t.any(clock) ? (t.widget(clock.first) as Text).data : null;
      final sw = Stopwatch()..start();
      String? first;
      int? moving;
      while (sw.elapsed < const Duration(seconds: 60)) {
        await _wait(t, const Duration(milliseconds: 500));
        final p = position();
        if (p != null && !p.startsWith('00:00 /') && !p.startsWith('0:00 /')) {
          first ??= p;
          if (p != first) {
            moving = sw.elapsedMilliseconds;
            break;
          }
        }
      }
      _say('video playing', moving == null ? 'NOT within 60 s (position ${position() ?? 'none shown'})' : 'position moving at $moving ms (${position()})');
      await _shot(t, '06-video');
      _problemsSince('video');
      await _router(t).maybePop();
      await _wait(t, const Duration(seconds: 2));
    }

    // 5. The tabs.
    for (final tab in ['Search', 'Albums', 'Library']) {
      final sw = Stopwatch()..start();
      await t.tap(find.descendant(of: find.byType(NavigationBar), matching: find.text(tab)));
      await _wait(t, const Duration(seconds: 3));
      _say('tab', '$tab ${sw.elapsedMilliseconds} ms');
      await _shot(t, '07-tab-${tab.toLowerCase()}');
      _problemsSince('tab $tab');
    }

    // 6. Every page the Library opens, the backup page and every settings page.
    final pages = <String, PageRouteInfo>{
      '08-favorites': const DriftFavoriteRoute(),
      '09-archive': const DriftArchiveRoute(),
      '10-trash': const DriftTrashRoute(),
      '11-locked-folder': const DriftLockedFolderRoute(),
      '12-people': const DriftPeopleCollectionRoute(),
      '13-places': DriftPlaceRoute(currentLocation: null),
      '14-on-device-albums': const DriftLocalAlbumsRoute(),
      '15-folders': FolderRoute(),
      '16-shared-links': const SharedLinkRoute(),
      '17-partners': const DriftPartnerRoute(),
      '18-backup': const DriftBackupRoute(),
      '19-settings': const SettingsRoute(),
      for (final s in SettingSection.values) '20-settings-${s.name}': SettingsSubRoute(section: s),
    };
    for (final MapEntry(key: name, value: route) in pages.entries) {
      try {
        await _visit(t, name, route);
      } catch (e) {
        _say('page', '$name|FAILED $e');
      }
    }

    // 7. Back to the timeline, then a resume: the app leaves and returns.
    await t.tap(find.descendant(of: find.byType(NavigationBar), matching: find.text('Photos')));
    await _wait(t, const Duration(seconds: 2));
    t.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    t.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    await _wait(t, const Duration(seconds: 3));
    t.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    t.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await _wait(t, const Duration(seconds: 5));
    final (l, n) = _tiles(t);
    _say('after resume', '$l/$n thumbnails');
    await _shot(t, '21-after-resume');
    _problemsSince('resume');
    _say('done', '${start.elapsed.inSeconds} s');
  }, timeout: const Timeout(Duration(minutes: 20)), semanticsEnabled: false);
}
