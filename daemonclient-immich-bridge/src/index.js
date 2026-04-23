export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS Headers
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, DELETE, OPTIONS, PATCH",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Expose-Headers": "*",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const respondJson = (data, status = 200) => {
      return new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    };

    try {
      // 1. Auth Endpoint: /api/auth/login
      if (path === "/api/auth/login" && request.method === "POST") {
        // Mock successful login returning a JWT token
        const body = await request.json();
        return respondJson({
          accessToken: "mock_jwt_token_daemonclient",
          userId: "daemonclient_user",
          userEmail: body.email || "user@daemonclient.uz",
          firstName: "Daemon",
          lastName: "Client",
          isAdmin: true
        });
      }

      // 2. Auth Endpoint: /api/auth/logout
      if (path === "/api/auth/logout" && request.method === "POST") {
        return respondJson({ successful: true });
      }

      // 3. User Info: /api/user/me
      if (path === "/api/user/me" && request.method === "GET") {
        return respondJson({
          id: "daemonclient_user",
          email: "user@daemonclient.uz",
          firstName: "Daemon",
          lastName: "Client",
          isAdmin: true,
          status: "active",
          profileImagePath: "",
          shouldChangePassword: false,
          createdAt: new Date().toISOString(),
          deletedAt: null,
          updatedAt: new Date().toISOString()
        });
      }

      // 4. Server Info: /api/server-info
      if (path === "/api/server-info" && request.method === "GET") {
        return respondJson({
          diskAvailable: "999999999999",
          diskSize: "999999999999",
          diskUse: "0",
          diskAvailableRaw: 999999999999,
          diskSizeRaw: 999999999999,
          diskUseRaw: 0,
          diskUsagePercentage: 0
        });
      }
      
      // 5. Server Features: /api/server-info/features
      if (path === "/api/server-info/features" && request.method === "GET") {
        return respondJson({
          facialRecognition: false,
          map: false,
          trash: false,
          smartSearch: false,
          oauth: false,
          oauthAutoLaunch: false,
          passwordLogin: true
        });
      }

      // 6. Assets: /api/asset
      if (path === "/api/asset" && request.method === "GET") {
        // We will fetch from Firebase REST API
        // For simplicity right now, returning the dummy format
        const projectId = "daemonclient-c0625";
        const userId = "Xb9vNZZB89MzYqBIfj3jW40J7oH2"; // Mocked user for now
        
        try {
          const fsResponse = await fetch(`https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/artifacts/default-daemon-client/users/${userId}/photos`);
          if (fsResponse.ok) {
             const fsData = await fsResponse.json();
             const docs = fsData.documents || [];
             
             // Map Firestore documents to Immich AssetResponseDto
             const assets = docs.map(doc => {
                 const fields = doc.fields;
                 return {
                     id: doc.name.split('/').pop(),
                     deviceAssetId: fields.id?.stringValue || doc.name,
                     ownerId: userId,
                     deviceId: "web",
                     type: fields.fileType?.stringValue?.startsWith("video/") ? "VIDEO" : "IMAGE",
                     originalPath: fields.fileName?.stringValue || "unknown.jpg",
                     originalFileName: fields.fileName?.stringValue || "unknown.jpg",
                     resized: false,
                     fileCreatedAt: fields.uploadedAt?.timestampValue || new Date().toISOString(),
                     fileModifiedAt: fields.uploadedAt?.timestampValue || new Date().toISOString(),
                     updatedAt: fields.uploadedAt?.timestampValue || new Date().toISOString(),
                     isFavorite: fields.isFavorite?.booleanValue || false,
                     isArchived: fields.archived?.booleanValue || false,
                     isTrashed: fields.trashed?.booleanValue || false,
                     // We would map other exif details here if needed
                 };
             });
             
             return respondJson(assets);
          }
        } catch (err) {
          console.error("Firestore fetch failed", err);
        }
        
        return respondJson([]);
      }

      if (path === "/api/asset" && request.method === "POST") {
        // Mock successful upload
        return respondJson({
          id: "dummy_asset_id_" + Date.now(),
          status: "created"
        }, 201);
      }

      // 7. System Config: /api/system-config
      if (path === "/api/system-config" && request.method === "GET") {
        return respondJson({
           machineLearning: { enabled: false },
           oauth: { enabled: false },
           passwordLogin: { enabled: true },
           theme: { customCss: "" },
           library: { watch: { enabled: false } },
           trash: { enabled: false }
        });
      }

      // Fallback
      return respondJson({ error: "Endpoint not implemented by DaemonClient Bridge", path }, 404);

    } catch (e) {
      return respondJson({ error: e.message }, 500);
    }
  },
};
