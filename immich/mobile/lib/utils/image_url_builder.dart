import 'package:immich_mobile/domain/models/store.model.dart';
import 'package:immich_mobile/entities/store.entity.dart';
import 'package:immich_mobile/services/core_media.service.dart';
import 'package:openapi/api.dart';

// Every picture and video is read through the core's local server (P2 task
// 2.3, SPEC D23), never the worker's byte routes: the grid's thumbnails on
// one listener, everything opened on the other (D17). `next`: a neighbour of
// the opened item, preloaded — the core's Next class, never ahead of it (§4.9).

String getOriginalUrlForRemoteId(final String id, {bool edited = true, bool next = false}) {
  return '${CoreMedia.viewerBase}/api/assets/$id/original?edited=$edited${next ? '&next=1' : ''}';
}

// Saves and Share are not opened (D17): the grid's listener — rate-limited,
// yielding to what the user opened.
String getDownloadUrlForRemoteId(final String id) {
  return '${CoreMedia.gridBase}/api/assets/$id/original?edited=true';
}

String getThumbnailUrlForRemoteId(
  final String id, {
  AssetMediaSize type = AssetMediaSize.thumbnail,
  bool edited = true,
  String? thumbhash,
  bool next = false,
}) {
  final base = type == AssetMediaSize.thumbnail ? CoreMedia.gridBase : CoreMedia.viewerBase;
  final url = '$base/api/assets/$id/thumbnail?size=${type.value}&edited=$edited';
  return '${thumbhash != null ? '$url&c=${Uri.encodeComponent(thumbhash)}' : url}${next ? '&next=1' : ''}';
}

String getPlaybackUrlForRemoteId(final String id) {
  return '${CoreMedia.viewerBase}/api/assets/$id/video/playback?';
}

// The worker has no faces; people avatars stay on its address (2.10's list).
String getFaceThumbnailUrl(final String personId) {
  return '${Store.get(StoreKey.serverEndpoint)}/people/$personId/thumbnail';
}
