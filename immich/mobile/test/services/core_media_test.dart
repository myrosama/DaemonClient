import 'package:dc_core_flutter/dc_core_flutter.dart' as core;
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/services/core_media.service.dart';
import 'package:immich_mobile/utils/image_url_builder.dart';
import 'package:openapi/api.dart';

void main() {
  const grid = 'http://127.0.0.1:5001/g5';
  const viewer = 'http://127.0.0.1:5002/v7';

  setUp(() async {
    await CoreMedia.refresh(
      fetch: () async => const core.MediaAddresses(gridBase: grid, viewerBase: viewer),
      onChanged: () {},
    );
  });

  test('grid thumbnails come from the grid listener', () {
    expect(getThumbnailUrlForRemoteId('a1'), startsWith('$grid/api/assets/a1/thumbnail?size=thumbnail'));
  });

  test('previews, full size, originals and playback come from the viewer listener (D17)', () {
    expect(
      getThumbnailUrlForRemoteId('a1', type: AssetMediaSize.preview),
      startsWith('$viewer/api/assets/a1/thumbnail?size=preview'),
    );
    expect(
      getThumbnailUrlForRemoteId('a1', type: AssetMediaSize.fullsize),
      startsWith('$viewer/api/assets/a1/thumbnail?size=fullsize'),
    );
    expect(getOriginalUrlForRemoteId('a1'), startsWith('$viewer/api/assets/a1/original'));
    expect(getPlaybackUrlForRemoteId('a1'), startsWith('$viewer/api/assets/a1/video/playback'));
  });

  test('saves and Share come from the grid listener: not opened, so rate-limited (D17)', () {
    expect(getDownloadUrlForRemoteId('a1'), startsWith('$grid/api/assets/a1/original'));
  });

  test("the viewer's neighbour preloads ask for the core's Next class (§4.9)", () {
    expect(getThumbnailUrlForRemoteId('a1', type: AssetMediaSize.preview, next: true), endsWith('&next=1'));
    expect(getOriginalUrlForRemoteId('a1', next: true), endsWith('&next=1'));
    expect(getOriginalUrlForRemoteId('a1'), isNot(contains('next')));
  });

  test('new addresses clear what was loaded from the old ones', () async {
    var cleared = 0;
    Future<bool> refresh(String g) => CoreMedia.refresh(
      fetch: () async => core.MediaAddresses(gridBase: g, viewerBase: viewer),
      onChanged: () => cleared++,
    );
    expect(await refresh(grid), isFalse, reason: 'the same addresses');
    expect(cleared, 0);
    expect(await refresh('http://127.0.0.1:6001/g9'), isTrue);
    expect(cleared, 1);
    expect(getThumbnailUrlForRemoteId('a1'), startsWith('http://127.0.0.1:6001/g9/'));
  });
}
