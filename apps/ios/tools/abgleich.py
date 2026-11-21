"""Ordnet jede Apple-Aktion (PX…ActionPerformer, PhotosUICore iOS 26.3) einer Gruppe zu und belegt „bei uns“ mit
einer Fundstelle im Code (grep). Ausgabe: Markdown-Tabelle für AKTIONEN-ABGLEICH.md."""
import re, subprocess, sys, os
APP = os.path.expanduser("~/homeroll")
acts = [l.strip() for l in open(sys.argv[1]) if l.strip()]
# Muster → (Gruppe, Beleg-Regex im Code oder Begründung)
R = [
 # nur Apple/intern
 (r"FileRadar|TapToRadar|TTR|Debug|Internal|CurationDebug|StoryDemo|PromoteAsMagic|CopyInternalURL", "intern", "Apple-interne Entwickler-/Fehlerbericht-Werkzeuge"),
 # iCloud / CPL
 (r"^CPL|PhotoKitCPL", "icloud", "iCloud-Fotos-Synchronisation (bei uns: eigener Server, Backup-Ansicht)"),
 (r"^CMM|MomentShare|CMMPhotoKit|PhotoKitCMM", "icloud", "iCloud-Links / „Momente teilen“ (bei uns: Link teilen über Immich)"),
 (r"SharedLibrary|SocialGroup|IncludeOthersInSocialGroup|MoveToPersonalLibrary|MoveAssetCollectionToSharedLibrary|SetPersonalLibraryFilter|SetSharedLibraryFilter|SetAllLibrariesFilter|ToggleSharedLibraryBadge", "icloud", "Geteilte iCloud-Mediathek (bei uns: Immich-Partner, „Geteilt mit dir“)"),
 (r"ContentSyndication|Syndication|SharingSuggestion|RemoveSharingSuggestion|Guest|Messages|PromoteToGuest|ShowMessageCompose|MessageCompose|SharedLibraryComposeMessage", "icloud", "„Mit dir geteilt“ aus Nachrichten (iMessage-Inhalte, nur Apple)"),
 (r"FromMyMac|IncludeFromMyMac|ShowOnlyFromMyMac", "icloud", "Inhalte „Von meinem Mac“ (iCloud-Sync)"),
 (r"CreateSharedAlbum|PublishToSharedStream|SharedStream", "icloud", "Geteilte iCloud-Alben (bei uns: Immich-Album teilen + Kommentare/Likes)"),
 (r"SetScreensaver", "nichtmoeglich", "Bildschirmschoner gibt es nur auf tvOS/macOS; iOS-SDK 26.2 hat keine Schnittstelle (geprüft: keine Wallpaper/Screensaver-API)"),
 (r"Spotlight", "da", r"SpotlightIndex"),
]
# Bei uns vorhanden: Aktion → Code-Beleg
HAVE = {
 "AddUnverifiedPeople":"Weitere Fotos prüfen","PhotoKitAssetCollectionConfirmAdditionalPeople":"Weitere Fotos prüfen","PhotoKitAssetCollectionSuggestPeople":"Weitere Fotos prüfen",
 "PhotoKitAssetCollectionImprovePeopleReco":"Weitere Fotos prüfen","MovePerson":"Mit Person zusammenführen","PeopleMerge":"Mit Person zusammenführen",
 "PeopleChangeType":"Haustiere","PeopleCustomizeAlbum":"Als Favorit","PhotoKitAssetCollectionFavoritePerson":"isFavorite\": on",
 "PhotoKitAssetCollectionBlockPerson":"ausblenden\", systemImage","PhotoKitRenamePerson":"Umbenennen","PhotoKitPersonMakeKeyPhoto":"featureFaceAssetId",
 "PhotoKitNotThisPerson":"notThisPerson","PhotoKitAssetCollectionShowPersonInfo":"Geburtstag hinzufügen","PhotoKitAssetCollectionAddPersonToHome":"Anpinnen",
 "PhotoKitAssetCollectionRemovePersonFromHome":"Nicht mehr anpinnen","CustomizeListCell":"PinnedEditor","ReorderListCell":"SectionOrderEditor",
 "CuratedLibrary":"LibraryView","CuratedLibraryAssetCollection":"LibraryScale","CuratedLibraryEllipsisButton":"libraryMenu","PhotosGrid":"PhotoGrid",
 "CuratedLibraryRemoveFilters":"Gefiltert:","PhotosGridRemoveFilters":"Gefiltert:","CuratedLibraryUnfilter":"Gefiltert:","PhotosGridUnfilter":"Gefiltert:",
 "CuratedLibraryShowAll":"case all","CuratedLibraryShowFilters":"Filter\", systemImage","CuratedLibraryShowFiltersMenu":"Filter\", systemImage",
 "PhotosGridShowFilters":"Filter\", systemImage","PhotosGridShowFiltersMenu":"Filter\", systemImage","PhotosGridPickerShowFiltersMenu":"PhotoPicker",
 "CuratedLibraryShare":"ShareService.share","PhotosGridShare":"ShareService.share","PhotoKitAssetCollectionShare":"AlbumActions.share",
 "CuratedLibraryToggleAspectFit":"Seitenverhältnisraster","PhotosGridToggleAspectFit":"Seitenverhältnisraster",
 "CuratedLibraryToggleEditFilter":"case .edited","PhotosGridToggleEditFilter":"case .edited",
 "CuratedLibraryToggleFavoriteFilter":"case .favorites","PhotosGridToggleFavoriteFilter":"case .favorites",
 "CuratedLibraryToggleFilter":"LibraryFilter","PhotosGridToggleFilter":"LibraryFilter",
 "CuratedLibraryToggleImageFilter":"case .photos","PhotosGridToggleImageFilter":"case .photos",
 "CuratedLibraryToggleVideoFilter":"case .videos","PhotosGridToggleVideoFilter":"case .videos",
 "CuratedLibraryToggleLiveFilter":"case .livePhotos","PhotosGridToggleLiveFilter":"case .livePhotos",
 "CuratedLibraryTogglePortraitFilter":"case .portrait","PhotosGridTogglePortraitFilter":"case .portrait",
 "CuratedLibraryToggleInUserAlbumFilter":"notInAlbum","PhotosGridToggleInUserAlbumFilter":"notInAlbum",
 "CuratedLibraryToggleNotInUserAlbumFilter":"notInAlbum","PhotosGridToggleNotInUserAlbumFilter":"notInAlbum",
 "CuratedLibraryToggleIncludeScreenshotFilter":"showScreenshots","PhotosGridToggleIncludeScreenshotFilter":"showScreenshots",
 "CuratedLibraryToggleShowOnlyScreenshotFilter":"case .screenshots","PhotosGridToggleShowOnlyScreenshotFilter":"case .screenshots",
 "CuratedLibraryToggleIncludeSharedWithYouFilter":"showShared","CuratedLibraryToggleShowOnlySharedWithYouFilter":"case .shared",
 "PhotosGridToggleSavedFilter":"recentlySaved","PhotosGridToggleUnsavedFilter":"showShared",
 "PhotosGridToggleFaceMode":"PersonThumb","PhotosGridTogglePreviewHeader":"hero(",
 "PhotosGridZoomIn":"Vergrößern","PhotosGridZoomOut":"Verkleinern","PhotosGridCollectionSort":"newestFirst","PhotoKitAssetCollectionSort":"Sortieren",
 "PhotosGridSearch":"SearchView","PhotosGridSearchCentralizedFeedbackExternalFCSFeedback":"relevant(","PhotosGridSearchCentralizedFeedbackNegativeFeedback":"relevant(",
 "PhotosGridSearchCentralizedFeedbackPositiveFeedback":"relevant(",
 "EditCleanupFeedback":"Bereinigen","FileBackedAsset":"ShareViewController","FileBackedAssetAddToLibrary":"Auf deinem Server sichern","CMMFileBackedSaveToLibrary":"Auf deinem Server sichern",
 "PhotoKitAddToLibraryAsset":"Auf deinem Server sichern","PhotoKitMoveToLibrary":"Einblenden","PhotoKitShowInLibrary":"showInLibrary",
 "LemonadePhotoKitAssetCollectionPlayMovie":"Als Rückblick abspielen","PhotoKitAssetCollectionPlayMovie":"Als Rückblick abspielen","PhotoKitPlayMovieAsset":"slideshow",
 "PhotoKitAlbumMakeKeyPhoto":"Als Schlüsselfoto festlegen","PhotoKitAsset":"AssetMenu","PhotoKitAssetCollection":"AlbumScreen",
 "PhotoKitAssetCollectionAddContent":"Fotos hinzufügen","PhotoKitAssetCollectionBlacklistMemory":"Rückblick löschen","PhotoKitAssetCollectionBlacklistMemoryFeature":"lessPlaces",
 "PhotoKitFeatureLess":"lessDays","PhotoKitAssetCollectionCopyLink":"shareLink","PhotoKitAssetCollectionCreateMemory":"CreateMemorySheet",
 "PhotoKitAssetCollectionDelete":"Album löschen","PhotoKitAssetCollectionDeleteMemory":"Rückblick löschen","PhotoKitAssetCollectionDropAssets":"AlbumDropTarget",
 "PhotoKitAssetCollectionMoveOut":"Aus Album entfernen","PhotoKitAssetCollectionPasteAssets":"Bearbeitungen einsetzen","PhotoKitAssetCollectionPicker":"PhotoPicker",
 "PhotoKitAssetCollectionRename":"Titel bearbeiten","PhotoKitAssetCollectionRevealInMoment":"showInLibrary","PhotoKitAssetCollectionShowDetails":"InfoSheet",
 "PhotoKitAssetCollectionShowInAlbum":"In Album","PhotoKitAssetCollectionShowMap":"Karte einblenden","PhotoKitAssetPickAsset":"PhotoPicker",
 "PhotoKitAssetSelection":"selecting","PhotoKitClearRecentlyShared":"Verlauf löschen","PhotoKitClearRecentlyViewed":"Verlauf löschen",
 "PhotoKitCollectionList":"AlbumFolders","PhotoKitCollectionListCreateCollection":"Neuer Ordner","PhotoKitCollectionListDelete":"Ordner löschen",
 "PhotoKitCollectionListMove":"In Ordner bewegen","PhotoKitCollectionListMoveOut":"folders.move(album.id, to: nil)","PhotoKitCollectionListRearrange":"AlbumSort",
 "PhotoKitCollectionListRename":"folders.rename","PhotoKitCopy":"static func copy","PhotoKitDeleteAsset":"static func delete","PhotoKitDestructive":"role: .destructive",
 "PhotoKitDuplicateAsset":"duplicate(","PhotoKitEditDateTime":"Datum & Uhrzeit anpassen","PhotoKitEditLocation":"Ort anpassen","PhotoKitExpungeAsset":"confirmDeleteForever",
 "PhotoKitHideAssets":"confirmHide","PhotoKitMergeDuplicates":"DuplicatesScreen","PhotoKitMergeDuplicatesNoConfirmation":"DuplicatesScreen","PhotoKitPrintAsset":"UIPrintInteractionController",
 "PhotoKitRecoverAsset":"restore(","PhotoKitRestoreAsset":"restore(","PhotoKitRemoveAsset":"Aus Album entfernen","PhotoKitRemoveNoConfirmAsset":"Aus Album entfernen",
 "PhotoKitRemoveFromFeaturedPhotos":"removeFromFeatured","PhotoKitSelectAutoloopVariationAsset":"LiveMode","PhotoKitSelectLiveVariationAsset":"LiveMode",
 "PhotoKitSelectLongExposureVariationAsset":"LiveMode","PhotoKitSelectMirrorVariationAsset":"LiveMode","PhotoKitSelectVariationAsset":"LiveMode",
 "PhotoKitShowActionsMenuAsset":"AssetMenu","PhotoKitToggleFavorite":"setFavorite","PhotoKitTrashAsset":"static func delete","PhotoKitTrashNoConfirmAsset":"static func delete",
 "PhotoKitUnifiedDestructive":"role: .destructive","StoryAsset":"MemoryPlayer","StoryMakeKeyPhoto":"Titelbild","StoryMemoryFeed":"MemoriesScreen","StoryRemoveAsset":"Aus Rückblick entfernen\"",
 "PhotoKitInternalToggleStacks":"createStack","CMM":"shareLink","CMMPublish":"shareLink","CMMShowPhotosPicker":"PhotoPicker","CMMPhotoKitPhotosPicker":"PhotoPicker",
 "PhotoKitAssetCollectionContentSyndicationSaveToLibrary":"Auf deinem Server sichern",
}
def found(pat):
    r = subprocess.run(["grep","-rlF","--include=*.swift",pat,APP+"/App",APP+"/Share",APP+"/Widget",APP+"/Shared"],capture_output=True,text=True).stdout.split()
    return [os.path.relpath(x, APP) for x in r]
rows=[]; stat={}
for a in acts:
    g=None; why=""
    if a in HAVE:
        f=found(HAVE[a])
        g="da" if f else "FEHLT-BELEG"; why=f"`{HAVE[a]}` → {f[0] if f else '–'}"
    else:
        for pat,grp,txt in R:
            if re.search(pat,a):
                if grp=="da":
                    f=found(txt); g="da" if f else "FEHLT-BELEG"; why=f"`{txt}` → {f[0] if f else '–'}"
                else: g=grp; why=txt
                break
    if g is None: g="OFFEN"; why="?"
    stat[g]=stat.get(g,0)+1; rows.append((a,g,why))
names={"da":"✅ bei uns","icloud":"➖ iCloud/Apple-Dienst","intern":"➖ Apple intern","nichtmoeglich":"➖ nicht möglich","OFFEN":"⏳ offen","FEHLT-BELEG":"⚠️ Beleg fehlt"}
print("| Apple-Aktion | Stand | Beleg / Grund |\n|---|---|---|")
for a,g,w in rows: print(f"| {a} | {names[g]} | {w} |")
print("\nZusammenfassung:", ", ".join(f"{names[k]}: {v}" for k,v in sorted(stat.items())), file=sys.stderr)
for a,g,w in rows:
    if g in ("OFFEN","FEHLT-BELEG"): print("  ",g,a,w,file=sys.stderr)
