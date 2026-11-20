# App icons — approved by the operator 2026-10-29

- **Drive:** "cloud folder" (glossy blue folder, cloud-shaped tab, white cloud).
- **Photos:** "fanned gallery" (three fanned photos, hills, lake, sun).

| File | Use |
|---|---|
| `<app>-ios-1024.png` | iOS App Store / Xcode AppIcon. Square, opaque (no alpha) — iOS rounds it. |
| `<app>-playstore-512.png` | Google Play listing icon. |
| `<app>-adaptive-foreground-1024.png` | Android adaptive foreground, artwork inside the 66 dp safe zone. |
| `<app>-adaptive-monochrome-1024.png` | Android 13+ themed icon (single colour, the system tints it). |
| background | solid `#FFFFFF` (no file needed). |
| `<app>-rounded-1024.png` | Marketing/website use only (corners already rounded). |
| `src/*.svg` | Sources for all of the above (512 viewBox). |

flutter_launcher_icons (per app, paths as you place them):

```yaml
flutter_launcher_icons:
  android: true
  ios: true
  image_path: "assets/icon/drive-ios-1024.png"
  remove_alpha_ios: true
  adaptive_icon_background: "#FFFFFF"
  adaptive_icon_foreground: "assets/icon/drive-adaptive-foreground-1024.png"
  adaptive_icon_monochrome: "assets/icon/drive-adaptive-monochrome-1024.png"
```
