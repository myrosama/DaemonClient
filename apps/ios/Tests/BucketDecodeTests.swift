import XCTest
@testable import DCPhotos

/// The timeline's columns from the worker: one odd value must not blank a whole month.
final class BucketDecodeTests: XCTestCase {
    func testDurationAsTextOrNumber() throws {
        let json = #"""
        {"id":["a","b","c","d"],"isImage":[false,false,false,true],"isFavorite":[false,false,false,false],
         "fileCreatedAt":["2026-08-01T10:00:00","2026-08-01T10:00:00","2026-08-01T10:00:00","2026-08-01T10:00:00"],
         "ratio":[1,1,1,1],"duration":[5000,"0:00:05.500","nonsense",null],"livePhotoVideoId":[null,null,null,null]}
        """#
        let cols = try JSONDecoder().decode(BucketColumns.self, from: Data(json.utf8))
        XCTAssertEqual(cols.assets()?.map(\.durationMs), [5000, 5500, nil, nil])
    }

    func testHiddenFlagFromVisibility() throws {
        let json = #"""
        {"id":["a","b"],"isImage":[true,true],"isFavorite":[false,false],
         "fileCreatedAt":["2026-08-01T10:00:00","2026-08-01T10:00:00"],"ratio":[1,1],"livePhotoVideoId":[null,null],
         "visibility":["timeline","archive"]}
        """#
        let cols = try JSONDecoder().decode(BucketColumns.self, from: Data(json.utf8))
        XCTAssertEqual(cols.assets()?.map(\.isHidden), [false, true])
    }

    func testAMonthWithAShortColumnIsRefusedNotIndexedPastItsEnd() {
        let json = #"""
        {"id":["a","b"],"isImage":[true],"isFavorite":[false,false],
         "fileCreatedAt":["2026-08-01T10:00:00","2026-08-01T10:00:00"],"ratio":[1,1],"livePhotoVideoId":[null,null]}
        """#
        XCTAssertNil(ImmichClient.decodeBucket(Data(json.utf8)))
    }

    func testMillisParse() {
        XCTAssertEqual(Millis.parse("1:02:03.250"), 3_723_250)
        XCTAssertEqual(Millis.parse("5000"), 5000)
        XCTAssertNil(Millis.parse("-0:00:01"))
        XCTAssertNil(Millis.parse("::"))
    }
}
